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
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "data");

const TOKEN = process.env.ORBITIQ_GH_TOKEN || null;
const REPO = process.env.ORBITIQ_BACKUP_REPO || "mnbresearch/orbitiq";
const BRANCH = process.env.ORBITIQ_BACKUP_BRANCH || "data-backup";
const API = `https://api.github.com/repos/${REPO}`;
const MAX_LEDGER_LINES = 60000; // keep backups well under API blob limits

const FILES = [
  { local: path.join(DATA_DIR, "ledger.jsonl"), remote: "backup/ledger.jsonl", capLines: MAX_LEDGER_LINES },
  { local: path.join(DATA_DIR, "store.json"), remote: "backup/store.json" },
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
      const text = await r.text();
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
