// ============================================================
// OrbitIQ archive persistence — the intelligence ledger is the
// data moat, and Render's free-tier disk is ephemeral: every
// redeploy would wipe it. With an optional GitHub token, the
// ledger + workspace store are backed up to a flat `data-backup`
// branch after every sweep and restored automatically on boot.
//
// Setup (optional but recommended):
//   1. GitHub → Settings → Developer settings → Fine-grained token
//      with "Contents: read & write" on the orbitiq repo.
//   2. Render → Environment → add ORBITIQ_GH_TOKEN.
// Without a token this module is a silent no-op.
// ============================================================
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "data");

// ---------- encryption for secret-bearing archives ----------
// AES-256-GCM: the tag makes tampering detectable, not just unreadable.
// The key is a 64-char hex string in ORBITIQ_BACKUP_KEY, held only in the
// service environment and never written to the repository.
const BACKUP_KEY = (() => {
  const raw = process.env.ORBITIQ_BACKUP_KEY || "";
  if (!/^[0-9a-fA-F]{64}$/.test(raw)) return null;
  return Buffer.from(raw, "hex");
})();
export const canProtectSecrets = () => !!BACKUP_KEY;

function seal(plaintext) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", BACKUP_KEY, iv);
  const body = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
  // v1|iv|tag|ciphertext, all base64 — self-describing so a future format
  // change cannot be silently mistaken for corruption.
  return ["v1", iv.toString("base64"), c.getAuthTag().toString("base64"), body.toString("base64")].join(".");
}
function unseal(text) {
  const [v, iv, tag, body] = String(text).trim().split(".");
  if (v !== "v1") throw new Error("unknown backup format " + v);
  const d = crypto.createDecipheriv("aes-256-gcm", BACKUP_KEY, Buffer.from(iv, "base64"));
  d.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([d.update(Buffer.from(body, "base64")), d.final()]).toString("utf8");
}

const TOKEN = process.env.ORBITIQ_GH_TOKEN || null;
const REPO = process.env.ORBITIQ_BACKUP_REPO || "mnbresearch/orbitiq";
const BRANCH = process.env.ORBITIQ_BACKUP_BRANCH || "data-backup";
const API = `https://api.github.com/repos/${REPO}`;
const MAX_LEDGER_LINES = 60000; // keep backups well under API blob limits

const FILES = [
  { local: path.join(DATA_DIR, "ledger.jsonl"), remote: "backup/ledger.jsonl", capLines: MAX_LEDGER_LINES },
  // ── SECRET-BEARING. Encrypted before publication. ──────────
  // This branch lives in a PUBLIC repository. store.json carries workspace API
  // keys; auth.json carries scrypt password hashes, the access-request queue,
  // and live session bearer tokens. Publishing either in the clear hands anyone
  // who can read the repo a working set of credentials, which is what happened
  // before this guard existed.
  //
  // These are encrypted with ORBITIQ_BACKUP_KEY and FAIL CLOSED: with no key
  // configured the file is skipped entirely rather than uploaded in the clear.
  // Losing a backup is recoverable; publishing session tokens is not.
  { local: path.join(DATA_DIR, "store.json"), remote: "backup/store.json.enc", secret: true },
  { local: path.join(DATA_DIR, "auth.json"), remote: "backup/auth.json.enc", secret: true },
  // The seals are the point of the whole exercise: publishing the tip hash to
  // a branch whose commits GitHub timestamps is what turns "we did not edit
  // this" from an assertion into something a third party can check. They are
  // tiny, so they go up on every backup rather than on a slower cadence.
  { local: path.join(DATA_DIR, "ledger-seals.json"), remote: "backup/ledger-seals.json" },
  { local: path.join(DATA_DIR, "ledger-anchor.json"), remote: "backup/ledger-anchor.json" },
  { local: path.join(DATA_DIR, "elements-history.json"), remote: "backup/elements-history.json" }
];

let state = { enabled: !!TOKEN, restored: 0, lastBackupAt: null, lastError: null };
export const status = () => ({ ...state });

async function gh(pathname, opts = {}) {
  return fetch(API + pathname, {
    ...opts,
    signal: AbortSignal.timeout(30000),
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "OrbitIQ-backup",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(opts.headers || {})
    }
  });
}
async function ghJson(pathname, opts = {}) {
  const r = await gh(pathname, opts);
  if (!r.ok) throw new Error(`GitHub ${r.status} on ${pathname}`);
  return r.json();
}

async function ensureBranch() {
  const r = await gh(`/git/ref/heads/${BRANCH}`);
  if (r.status === 200) return;
  const main = await ghJson(`/git/ref/heads/main`);
  await ghJson(`/git/refs`, {
    method: "POST",
    body: JSON.stringify({ ref: `refs/heads/${BRANCH}`, sha: main.object.sha })
  });
}

// ---------- restore (called once at boot, before the stores load) ----------
export async function restore() {
  if (!TOKEN) { console.log("backup: disabled (set ORBITIQ_GH_TOKEN to persist the archive)"); return state; }
  for (const f of FILES) {
    try {
      const r = await gh(`/contents/${f.remote}?ref=${BRANCH}`, {
        headers: { Accept: "application/vnd.github.raw" }
      });
      if (!r.ok) continue;
      let text = await r.text();
      if (f.secret) {
        if (!BACKUP_KEY) {
          console.error(`backup: cannot restore ${f.remote} — ORBITIQ_BACKUP_KEY is not set.`);
          state.lastError = "restore: secret-bearing archive needs ORBITIQ_BACKUP_KEY";
          continue;
        }
        // Decrypt, and let a failure be loud. Silently writing an undecryptable
        // blob to disk would corrupt the live store with ciphertext.
        try { text = unseal(text); }
        catch (e) {
          console.error(`backup: ${f.remote} failed to decrypt (${e.message}) — leaving local file untouched.`);
          state.lastError = "restore: decrypt failed for " + f.remote;
          continue;
        }
      }
      if (text && text.length > 2) {
        fs.mkdirSync(path.dirname(f.local), { recursive: true });
        fs.writeFileSync(f.local, text);
        state.restored++;
      }
    } catch (e) { state.lastError = "restore: " + e.message; }
  }
  console.log(`backup: restored ${state.restored}/${FILES.length} archive files from ${REPO}@${BRANCH}`);
  return state;
}

// ---------- backup (after every intelligence sweep) ----------
export async function backup() {
  if (!TOKEN) return state;
  try {
    await ensureBranch();
    const entries = [];
    for (const f of FILES) {
      let text;
      try { text = fs.readFileSync(f.local, "utf8"); } catch { continue; }
      if (f.secret) {
        if (!BACKUP_KEY) {
          console.error(`backup: SKIPPING ${f.remote} — ORBITIQ_BACKUP_KEY is not set and this `
            + `branch is public. Set a 64-char hex key to persist it safely.`);
          state.lastError = "secret-bearing archives skipped: no ORBITIQ_BACKUP_KEY";
          continue;
        }
        text = seal(text);
      }
      if (f.capLines) {
        const lines = text.split("\n").filter(Boolean);
        if (lines.length > f.capLines) text = lines.slice(-f.capLines).join("\n") + "\n";
      }
      const blob = await ghJson(`/git/blobs`, {
        method: "POST",
        body: JSON.stringify({ content: Buffer.from(text).toString("base64"), encoding: "base64" })
      });
      entries.push({ path: f.remote, mode: "100644", type: "blob", sha: blob.sha });
    }
    if (!entries.length) return state;
    const tree = await ghJson(`/git/trees`, {
      method: "POST",
      body: JSON.stringify({ tree: entries })
    });
    // parentless commit + force ref update keeps the branch history flat,
    // so the repo never bloats no matter how long the platform runs
    const commit = await ghJson(`/git/commits`, {
      method: "POST",
      body: JSON.stringify({ message: `archive backup ${new Date().toISOString()}`, tree: tree.sha, parents: [] })
    });
    await ghJson(`/git/refs/heads/${BRANCH}`, {
      method: "PATCH",
      body: JSON.stringify({ sha: commit.sha, force: true })
    });
    state.lastBackupAt = new Date().toISOString();
    state.lastError = null;
    console.log(`backup: archive persisted (${entries.length} files) → ${REPO}@${BRANCH}`);
  } catch (e) {
    state.lastError = "backup: " + e.message;
    console.error(state.lastError);
  }
  return state;
}

// Restore runs at module load (top-level await) so it completes BEFORE
// store.js / ledger.js read their files — import this module first.
await restore();
