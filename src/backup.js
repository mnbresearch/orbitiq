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
import zlib from "zlib";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── This must agree with everyone else, and once it did not ──
// ledger.js, store.js and auth.js all resolve ORBITIQ_DATA_DIR first. This
// module hardcoded the repository's data/ directory, which is the same place
// only for as long as nobody sets the variable.
//
// Setting it is exactly what mounting a persistent disk looks like, and that
// is the recommended next step off the free tier. Had anyone taken it, the
// live archive would have moved while the backup went on faithfully saving
// the old, empty directory — and the failure would have stayed invisible
// until the day the backup was actually needed.
const DATA_DIR = process.env.ORBITIQ_DATA_DIR || path.join(__dirname, "..", "data");

/** Exposed so a test can assert this module and the stores agree. */
export const dataDir = () => DATA_DIR;

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
// Cap on rows published to the backup. Overridable only so the truncation
// path can be exercised in tests without generating 60,000 rows — it has a
// hard floor, because a mistyped value here would silently amputate the
// archive, and the archive is the product.
const MAX_LEDGER_LINES = (() => {
  const raw = Number(process.env.ORBITIQ_MAX_LEDGER_LINES);
  return Number.isFinite(raw) && raw >= 1000 ? Math.floor(raw) : 60000;
})();
const MANIFEST_PATH = "backup/manifest.json";

// Git addresses a blob by the SHA-1 of "blob <bytelength>\0" + content, so
// computing it locally tells us — before spending a single byte on the wire —
// whether the content we are about to upload is already the content that is
// there. Unchanged files are then referenced by that SHA in the new tree
// instead of being uploaded again.
function gitBlobSha(buf) {
  return crypto.createHash("sha1")
    .update(Buffer.concat([Buffer.from(`blob ${buf.length}\0`), buf]))
    .digest("hex");
}

// ── Why the bulk files are gzipped ──────────────────────────
//
// Render's Hobby workspace includes 5 GB of bandwidth a month, and on
// 10 September 2026 this service had spent 2.73 GB of it by the tenth day —
// 2.71 GB of which was traffic the service itself initiated, against just
// 17 MB served to actual visitors. Left alone it would have crossed 5 GB
// around the 18th and taken the site down for the rest of the month.
//
// All of it came from this file moving the archive around uncompressed:
//
//   * every boot, restore() downloaded the whole 17.4 MB ledger — and a free
//     instance that sleeps after 15 minutes boots many times a day
//   * every backup, remoteLedgerLines() downloaded that same 17.4 MB AGAIN,
//     purely to count its lines for the append-only guard
//   * every backup then uploaded it base64-encoded, which is another 33% on
//     top, whether or not a single row had changed
//
// JSONL of this shape compresses about 8:1, so gzip removes roughly 85% of
// all three at once. The blob-reuse check below removes most of what is left.
//
// Restore stays backward compatible: it prefers the .gz and falls back to the
// plain file, so a backup written by the previous version still restores.
// Nothing here is evidence — the data-backup branch is force-pushed flat and
// says so in its own README; the witness branch is the record.
const GZIP = { level: 9 };
const gz = text => zlib.gzipSync(Buffer.from(text, "utf8"), GZIP);
const gunzip = buf => zlib.gunzipSync(buf).toString("utf8");

// ── The ledger goes up in shards, not as one file ──────────
//
// Compressing the archive cut each backup from 21.3 MB to 4.3 MB, which was
// enough to stop the immediate breach. But the cost still scaled with the
// size of the WHOLE archive, and the archive only ever grows: appending one
// row re-uploaded every row that came before it. O(n) per append, about
// twelve times a day. Measured against the real growth rate — 126 KB/day
// compressed — that is 1.6 GB of backup traffic in September, 3.4 GB in
// October and 5.2 GB in November, past the 5 GB allowance with nothing
// having gone wrong. A fix that merely postpones the same breach by six
// weeks is not a fix.
//
// So the ledger is split on `seq` into fixed ranges. Once a range is full
// its shard never changes again, so it compresses to identical bytes,
// hashes to the same blob sha, and is skipped by the reuse check below —
// permanently. Only the newest shard moves. Cost is O(1) per append and
// stays flat however large the archive grows.
//
// Sharding on `seq` rather than on position in the file is the load-bearing
// choice. The cap below drops the OLDEST rows once the ledger passes
// MAX_LEDGER_LINES; with position-based boundaries every surviving row would
// land in a different shard on every append after that, rewriting the entire
// archive each time and turning the cure into the disease.
const SHARD_LINES = 5000;
const SHARD_DIR = "backup/ledger/";
const SHARD_RE = /^backup\/ledger\/(pre|\d{5})\.jsonl\.gz$/;
const LEGACY_LEDGER = ["backup/ledger.jsonl.gz", "backup/ledger.jsonl"];

/**
 * Split ledger text into { remotePath -> text }, in file order.
 *
 * Returns null if the rows are not in non-decreasing shard order, in which
 * case the caller writes the single unsharded archive instead. Reassembling
 * shards in the wrong order would silently break the hash chain the whole
 * product rests on, so this refuses to shard at all rather than shard rows
 * it cannot confidently place.
 *
 * The oldest rows predate `seq` entirely (3,314 of them, reported by verify()
 * as unchained). They sit at the head and collect into one sealed "pre"
 * shard that never changes again.
 */
function shardLedger(text) {
  const lines = text.split("\n").filter(Boolean);
  if (!lines.length) return null;
  const runs = [];
  let lastRank = -Infinity;
  for (const line of lines) {
    let rank = -1;                        // -1 = unsequenced legacy row
    try {
      const o = JSON.parse(line);
      if (Number.isInteger(o.seq)) rank = Math.floor(o.seq / SHARD_LINES);
    } catch { /* unparseable: treat as legacy; the order check still applies */ }
    if (rank < lastRank) return null;     // out of order — refuse to shard
    if (!runs.length || rank !== lastRank) runs.push({ rank, lines: [] });
    runs[runs.length - 1].lines.push(line);
    lastRank = rank;
  }
  const out = new Map();
  for (const r of runs) {
    const name = r.rank < 0 ? "pre" : String(r.rank).padStart(5, "0");
    out.set(`${SHARD_DIR}${name}.jsonl.gz`, r.lines.join("\n") + "\n");
  }
  return out;
}

/** Shard paths in reassembly order: the unsequenced head first, then by range. */
const shardOrder = paths => [...paths].sort((a, b) => {
  const k = p => p.includes("/pre.") ? -1 : parseInt(p.match(/(\d{5})\.jsonl\.gz$/)[1], 10);
  return k(a) - k(b);
});

const FILES = [
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
  // 3.85 MB of rebuildable element-set history — the second-largest thing here
  // and not evidence, so it is gzipped for the same reason the ledger is.
  { local: path.join(DATA_DIR, "elements-history.json"), remote: "backup/elements-history.json.gz",
    legacyRemote: "backup/elements-history.json", gzip: true }
];

// `unreadable` holds remote paths this boot could not decrypt. backup() treats
// them as untouchable: reused by sha, never replaced. Losing the ability to
// READ a backup is bad; silently destroying it as a consequence is worse.
let state = { enabled: !!TOKEN, restored: 0, lastBackupAt: null, lastError: null, unreadable: new Set() };

/**
 * Backup health, stated as a verdict rather than left to be inferred.
 *
 * A backup that has quietly stopped working looks exactly like one that is
 * working, right up until it is needed. That is the whole failure mode: the
 * operator believes they are protected, and nobody finds out otherwise until
 * the disk is already gone.
 *
 * So the states below are deliberately blunt, and "refusing" is reported as
 * loudly as "failing". A refusal is the guard doing its job, but it also means
 * the live archive is diverging from the backed-up one and somebody needs to
 * look — silence there would turn a safety mechanism into a slow leak.
 */
export const status = () => {
  const ageMin = state.lastBackupAt
    ? (Date.now() - new Date(state.lastBackupAt).getTime()) / 60000 : null;
  const refusing = /^backup REFUSED/.test(state.lastError || "");
  // Ranked above "failing": an unreadable secret archive is not a transient
  // error, it is an account-loss event waiting for the next cold boot, and it
  // needs a different action (find the old key) from a retry.
  const unreadable = [...state.unreadable];

  const health = !TOKEN ? "unprotected"
    : unreadable.length ? "unreadable"
    : refusing ? "refusing"
    : state.lastError ? "failing"
    : !state.lastBackupAt ? "never-run"
    : ageMin > 360 ? "stale"
    : "ok";

  return {
    ...state,
    unreadable,
    health,
    lastBackupAgeMinutes: ageMin == null ? null : Math.round(ageMin),
    means: {
      unprotected: "No backup token is configured. The archive exists only on this instance's "
                 + "disk, which is wiped on every redeploy. Everything this product claims "
                 + "rests on that one file.",
      unreadable: "This instance could not decrypt " + unreadable.join(", ") + ". Those backups "
                + "are being preserved untouched rather than overwritten, so nothing is lost yet — "
                + "but the accounts and workspace keys they hold cannot be restored until the key "
                + "that sealed them is available again. This is what a rotated ORBITIQ_BACKUP_KEY "
                + "looks like: set the previous key, let one boot restore, then rotate with the "
                + "service running so the archive is re-sealed under the new key.",
      refusing: "The backup is refusing to publish because the local archive is smaller than "
              + "the backed-up one. That guard prevents a blank boot from destroying the "
              + "record, but it also means the two have diverged and someone must look.",
      failing: "The last backup attempt failed. The archive is still on disk, but a redeploy "
             + "before this is fixed would lose everything written since the last success.",
      "never-run": "No backup has completed since this instance started.",
      stale: "The last successful backup is more than six hours old.",
      ok: "The archive is being persisted off this instance."
    }[health]
  };
};

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
/**
 * Reassemble the ledger from its shards, falling back to the single-file
 * archives an earlier version wrote.
 *
 * Refuses to write a partial ledger. A shard that 404s would otherwise
 * produce an archive with a hole punched in it, which is strictly worse than
 * having no archive at all: the hash chain breaks, verify() reports the
 * record as damaged, and the append-only guard cannot save it because a
 * ledger missing rows from the MIDDLE is not shorter than the remote one.
 * The gap would then be published over the good copy as if it were fine.
 */
async function restoreLedger() {
  const local = path.join(DATA_DIR, "ledger.jsonl");
  let manifest = null;
  try {
    const r = await gh(`/contents/${MANIFEST_PATH}?ref=${BRANCH}`, {
      headers: { Accept: "application/vnd.github.raw" }
    });
    if (r.ok) manifest = JSON.parse(await r.text());
  } catch { /* no manifest: fall through to the legacy layout */ }

  const paths = Array.isArray(manifest?.shards) ? shardOrder(manifest.shards) : [];
  if (paths.length) {
    const parts = [];
    for (const p of paths) {
      try {
        const r = await gh(`/contents/${p}?ref=${BRANCH}`, {
          headers: { Accept: "application/vnd.github.raw" }
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        parts.push(gunzip(Buffer.from(await r.arrayBuffer())));
      } catch (e) {
        console.error(`backup: ledger shard ${p} could not be read (${e.message}). Refusing to `
          + `assemble a partial ledger — the local copy is left untouched and the shards on `
          + `the branch will not be overwritten.`);
        state.lastError = "restore: unreadable ledger shard " + p;
        for (const q of paths) state.unreadable.add(q);
        return false;
      }
    }
    const text = parts.join("");
    const lines = text.split("\n").filter(Boolean).length;
    // The manifest is written by the backup that produced these shards, so a
    // mismatch means the set is not the set that was published — a shard
    // dropped, or a stale manifest read against newer shards. Either way the
    // reassembled file is not the archive, so it does not get written.
    if (Number.isInteger(manifest.ledgerLines) && lines !== manifest.ledgerLines) {
      console.error(`backup: reassembled ledger has ${lines} rows but the manifest published `
        + `${manifest.ledgerLines}. The shard set is incomplete — refusing to write it.`);
      state.lastError = `restore: shard set incomplete (${lines}/${manifest.ledgerLines})`;
      for (const q of paths) state.unreadable.add(q);
      return false;
    }
    fs.mkdirSync(path.dirname(local), { recursive: true });
    fs.writeFileSync(local, text);
    state.restored++;
    console.log(`backup: restored ledger from ${paths.length} shards (${lines} rows)`);
    return true;
  }

  // No shards on the branch: a backup written before this layout existed.
  // Without this path the first boot after the change finds no ledger, starts
  // empty, and the append-only guard then refuses every later backup.
  for (const remote of LEGACY_LEDGER) {
    try {
      const r = await gh(`/contents/${remote}?ref=${BRANCH}`, {
        headers: { Accept: "application/vnd.github.raw" }
      });
      if (!r.ok) continue;
      const text = remote.endsWith(".gz")
        ? gunzip(Buffer.from(await r.arrayBuffer()))
        : await r.text();
      if (!text || text.length <= 2) continue;
      fs.mkdirSync(path.dirname(local), { recursive: true });
      fs.writeFileSync(local, text);
      state.restored++;
      console.log(`backup: restored ledger from ${remote} (pre-shard layout)`);
      return true;
    } catch { /* try the next candidate */ }
  }
  return false;
}

export async function restore() {
  if (!TOKEN) { console.log("backup: disabled (set ORBITIQ_GH_TOKEN to persist the archive)"); return state; }
  await restoreLedger();
  for (const f of FILES) {
    try {
      // Prefer the compressed copy; fall back to the plain one so a backup
      // written before compression existed still restores. Without the
      // fallback, the first boot after this change would find no ledger,
      // start from empty, and the append-only guard would then refuse every
      // subsequent backup — a recoverable mess, but only by hand.
      let r = await gh(`/contents/${f.remote}?ref=${BRANCH}`, {
        headers: { Accept: "application/vnd.github.raw" }
      });
      let usedLegacy = false;
      if (!r.ok && f.legacyRemote) {
        r = await gh(`/contents/${f.legacyRemote}?ref=${BRANCH}`, {
          headers: { Accept: "application/vnd.github.raw" }
        });
        usedLegacy = true;
      }
      if (!r.ok) continue;
      let text;
      if (f.gzip && !usedLegacy) {
        // Decompress in memory. A corrupt archive must not overwrite a good
        // local file, so a gunzip failure skips this file rather than writing
        // whatever partial bytes came back.
        try { text = gunzip(Buffer.from(await r.arrayBuffer())); }
        catch (e) {
          console.error(`backup: ${f.remote} failed to decompress (${e.message}) — leaving local file untouched.`);
          state.lastError = "restore: gunzip failed for " + f.remote;
          continue;
        }
      } else {
        text = await r.text();
      }
      if (usedLegacy) console.log(`backup: restored ${f.legacyRemote} (uncompressed legacy copy)`);
      if (f.secret) {
        // ── Could not read it? Then never write over it. ──────
        //
        // The ledger has an append-only guard that refuses to publish a
        // shorter archive over a longer one. These two files had no equivalent,
        // and a key rotation is exactly the event that exposes the gap:
        //
        //   1. cold boot with a new ORBITIQ_BACKUP_KEY, so the blobs sealed
        //      with the old one no longer decrypt
        //   2. the disk is ephemeral, so there is no local copy either — the
        //      service comes up with no workspaces and bootstraps a fresh admin
        //   3. the LEDGER restored fine, so it has not shrunk, so the
        //      append-only guard stays quiet
        //   4. the next backup seals those empty files with the NEW key and
        //      force-pushes them over the good ones
        //
        // Every workspace API key and user account, gone, with nothing having
        // looked wrong at any step. Marking the file unreadable here makes
        // backup() reuse the existing remote blob instead of replacing it, so
        // the ciphertext survives until someone restores the right key.
        if (!BACKUP_KEY) {
          console.error(`backup: cannot restore ${f.remote} — ORBITIQ_BACKUP_KEY is not set.`);
          state.lastError = "restore: secret-bearing archive needs ORBITIQ_BACKUP_KEY";
          state.unreadable.add(f.remote);
          continue;
        }
        try { text = unseal(text); }
        catch (e) {
          console.error(`backup: ${f.remote} failed to decrypt (${e.message}). The backup copy will `
            + `NOT be overwritten — if ORBITIQ_BACKUP_KEY was rotated, restore the previous key to `
            + `recover these accounts, then rotate deliberately with the service running.`);
          state.lastError = "restore: decrypt failed for " + f.remote;
          state.unreadable.add(f.remote);
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
  console.log(`backup: restored ${state.restored}/${FILES.length + 1} archive files from ${REPO}@${BRANCH}`);
  return state;
}

// ---------- backup (after every intelligence sweep) ----------
/**
 * Lines in the ledger currently held on the backup branch, or null if there
 * is none. Used for the append-only guard below.
 */
async function remoteLedgerLines() {
  // A tiny sidecar, read instead of the archive itself.
  //
  // This used to download the entire ledger — 17.4 MB — on every backup, to
  // learn one integer. On a free instance that backs up after each sweep and
  // again on every shutdown, that was the single most expensive thing the
  // service did, and it bought a number the previous backup already knew.
  //
  // The count is written by the backup that produced the archive, so it is
  // always in step with it. If the manifest is missing (a backup written
  // before this existed) the guard falls back to reading the archive, which
  // is slow but correct — and self-healing, since this run writes a manifest.
  try {
    const r = await gh(`/contents/${MANIFEST_PATH}?ref=${BRANCH}`, {
      headers: { Accept: "application/vnd.github.raw" }
    });
    if (r.ok) {
      const m = JSON.parse(await r.text());
      if (Number.isInteger(m.ledgerLines)) return m.ledgerLines;
    }
  } catch { /* fall through to the slow path */ }

  for (const remote of ["backup/ledger.jsonl.gz", "backup/ledger.jsonl"]) {
    try {
      const r = await gh(`/contents/${remote}?ref=${BRANCH}`, {
        headers: { Accept: "application/vnd.github.raw" }
      });
      if (!r.ok) continue;
      const text = remote.endsWith(".gz")
        ? gunzip(Buffer.from(await r.arrayBuffer()))
        : await r.text();
      console.log(`backup: no manifest yet — counted ${remote} the slow way`);
      return text.split("\n").filter(Boolean).length;
    } catch { /* try the next candidate */ }
  }
  return null;
}

export async function backup() {
  if (!TOKEN) return state;
  try {
    await ensureBranch();

    // ── The archive is append-only, so it must never shrink ──
    //
    // The scenario this exists for needs nothing unusual to go wrong. GitHub
    // is briefly unreachable at boot, so restore() quietly recovers nothing.
    // The service comes up on an empty disk and starts screening. Three rows
    // later the sweep finishes, calls backup(), and force-pushes a three-line
    // ledger over the real one. The record is gone, there is no parent commit
    // to recover it from, and nothing anywhere said a word.
    //
    // A ledger that is shorter than the one already backed up is therefore
    // never a legitimate update. Refusing the WHOLE backup rather than just
    // that one file matters too: the store and auth files from a blank boot
    // are equally empty, and publishing those would drop every workspace key
    // and user account.
    //
    // Deliberately not overridable by an environment variable. The only
    // legitimate reason to shrink the ledger is a decision someone should
    // make deliberately, with the branch in front of them, not one a
    // half-remembered setting makes for them at three in the morning.
    const localLedger = (() => {
      try {
        return fs.readFileSync(path.join(DATA_DIR, "ledger.jsonl"), "utf8")
          .split("\n").filter(Boolean).length;
      } catch { return null; }
    })();
    const remote = await remoteLedgerLines();
    if (remote !== null && localLedger !== null && localLedger < remote) {
      state.lastError =
        `backup REFUSED: the local ledger has ${localLedger} rows but the backup holds `
        + `${remote}. An append-only archive does not shrink, so this is a boot that failed `
        + `to restore, a wrong data directory, or a truncated file — and publishing it would `
        + `destroy the record permanently. Nothing was written.`;
      console.error(state.lastError);
      return state;
    }
    // What is already on the branch, by path -> blob sha. One small request,
    // and it lets every unchanged file below cost nothing at all.
    let remoteShas = {}, baseTree = null;
    try {
      const ref = await ghJson(`/git/ref/heads/${BRANCH}`);
      const head = await ghJson(`/git/commits/${ref.object.sha}`);
      baseTree = head.tree?.sha || null;
      if (baseTree) {
        const t = await ghJson(`/git/trees/${baseTree}?recursive=1`);
        for (const e of t.tree || []) if (e.type === "blob") remoteShas[e.path] = e.sha;
      }
    } catch { /* first ever backup, or the branch is unreadable: upload everything */ }

    const entries = [];
    let uploadedBytes = 0, skipped = 0;
    let ledgerLines = null, shardPaths = null;

    for (const f of FILES) {
      // Restore could not read this one. Whatever is on the branch is the only
      // surviving copy, so keep it exactly as it is — referenced by its own
      // sha, so the tree still carries it and it is neither dropped nor
      // replaced by whatever this instance happens to hold.
      if (state.unreadable.has(f.remote)) {
        if (remoteShas[f.remote]) {
          entries.push({ path: f.remote, mode: "100644", type: "blob", sha: remoteShas[f.remote] });
          skipped++;
          console.warn(`backup: preserving ${f.remote} unchanged — this instance could not decrypt it`);
        }
        continue;
      }
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
      // gzip is deterministic for a given input and level, so an unchanged
      // file compresses to identical bytes and therefore to an identical blob
      // sha — which is what makes the reuse check below work at all.
      const payload = f.gzip ? gz(text) : Buffer.from(text, "utf8");
      const sha = gitBlobSha(payload);

      if (remoteShas[f.remote] === sha) {
        entries.push({ path: f.remote, mode: "100644", type: "blob", sha });
        skipped++;
        continue;
      }

      const blob = await ghJson(`/git/blobs`, {
        method: "POST",
        body: JSON.stringify({ content: payload.toString("base64"), encoding: "base64" })
      });
      uploadedBytes += Math.ceil(payload.length * 4 / 3); // base64 is what actually goes out
      entries.push({ path: f.remote, mode: "100644", type: "blob", sha: blob.sha });
    }
    // ── the ledger, written as shards ──────────────────────
    // Sealed shards hash to bytes already on the branch and cost nothing;
    // in the steady state only the newest shard is actually uploaded.
    let ledgerText = null;
    try { ledgerText = fs.readFileSync(path.join(DATA_DIR, "ledger.jsonl"), "utf8"); }
    catch { /* nothing local: leave whatever is on the branch alone */ }

    if (ledgerText !== null) {
      const all = ledgerText.split("\n").filter(Boolean);
      const kept = all.length > MAX_LEDGER_LINES ? all.slice(-MAX_LEDGER_LINES) : all;
      const text = kept.join("\n") + "\n";
      ledgerLines = kept.length;
      const shards = shardLedger(text);

      if (shards) {
        shardPaths = [...shards.keys()];
        for (const [p, body] of shards) {
          if (state.unreadable.has(p)) {
            if (remoteShas[p]) {
              entries.push({ path: p, mode: "100644", type: "blob", sha: remoteShas[p] });
              skipped++;
              console.warn(`backup: preserving ${p} unchanged — this instance could not read it`);
            }
            continue;
          }
          const payload = gz(body);
          const sha = gitBlobSha(payload);
          if (remoteShas[p] === sha) {
            entries.push({ path: p, mode: "100644", type: "blob", sha });
            skipped++;
            continue;
          }
          const blob = await ghJson(`/git/blobs`, {
            method: "POST",
            body: JSON.stringify({ content: payload.toString("base64"), encoding: "base64" })
          });
          uploadedBytes += Math.ceil(payload.length * 4 / 3);
          entries.push({ path: p, mode: "100644", type: "blob", sha: blob.sha });
        }
        // Shards the cap has emptied must be dropped, not merely left behind.
        // base_tree preserves anything not mentioned, so an orphaned shard
        // would sit on the branch forever and a later restore would splice
        // rows the cap deliberately discarded back into the middle of the
        // archive — silent corruption that looks like a successful restore.
        for (const p of Object.keys(remoteShas)) {
          if (SHARD_RE.test(p) && !shards.has(p)) {
            entries.push({ path: p, mode: "100644", type: "blob", sha: null });
            console.log(`backup: removing emptied ledger shard ${p}`);
          }
        }
        // Same reasoning for the single-file archives this layout replaces:
        // drop them only once their shards are actually in this tree.
        for (const p of LEGACY_LEDGER) {
          if (!remoteShas[p]) continue;
          entries.push({ path: p, mode: "100644", type: "blob", sha: null });
          console.log(`backup: removing superseded ${p}`);
        }
      } else {
        // Rows are not in non-decreasing seq order, so they cannot be placed
        // into shards without risking a reordered archive. Fall back to the
        // single file: more expensive, but correct, and it says so out loud.
        console.warn("backup: ledger rows are not in seq order — writing the unsharded archive");
        const payload = gz(text);
        const sha = gitBlobSha(payload);
        const legacyPath = LEGACY_LEDGER[0];
        if (remoteShas[legacyPath] === sha) {
          entries.push({ path: legacyPath, mode: "100644", type: "blob", sha });
          skipped++;
        } else {
          const blob = await ghJson(`/git/blobs`, {
            method: "POST",
            body: JSON.stringify({ content: payload.toString("base64"), encoding: "base64" })
          });
          uploadedBytes += Math.ceil(payload.length * 4 / 3);
          entries.push({ path: legacyPath, mode: "100644", type: "blob", sha: blob.sha });
        }
      }
    }

    if (!entries.length) return state;

    // Nothing changed at all — the tree would be byte-identical to the one
    // already on the branch, so writing a new commit for it would spend
    // requests to say nothing. This is the common case on a shutdown that
    // happens minutes after a wake, which is most shutdowns.
    if (skipped === entries.length && Object.keys(remoteShas).length) {
      state.lastBackupAt = new Date().toISOString();
      state.lastError = null;
      console.log(`backup: archive unchanged (${skipped} files) — nothing uploaded`);
      return state;
    }

    // The manifest that spares the next run a multi-megabyte download.
    if (ledgerLines !== null) {
      const manifest = Buffer.from(JSON.stringify({
        ledgerLines, at: new Date().toISOString(), compressed: true,
        ...(shardPaths ? { shards: shardPaths } : {})
      }) + "\n", "utf8");
      const mSha = gitBlobSha(manifest);
      if (remoteShas[MANIFEST_PATH] !== mSha) {
        const mb = await ghJson(`/git/blobs`, {
          method: "POST",
          body: JSON.stringify({ content: manifest.toString("base64"), encoding: "base64" })
        });
        entries.push({ path: MANIFEST_PATH, mode: "100644", type: "blob", sha: mb.sha });
      } else {
        entries.push({ path: MANIFEST_PATH, mode: "100644", type: "blob", sha: mSha });
      }
    }

    // ── Never publish a tree that drops what is already there ──
    //
    // This commit is parentless and force-pushed, so the tree it names IS the
    // whole branch. Building that tree from only the files readable on this
    // run therefore DELETED any file that happened to be unreadable — and the
    // one file this product entirely consists of is in that set.
    //
    // A partial write, a permissions blip, a moment of disk pressure: any of
    // them, on any sweep, and the archive quietly vanished from the backup.
    // Starting from the current tree means a missing local file leaves the
    // remote copy alone, which is the only safe direction for a backup to
    // fail in.
    // (baseTree was read at the top of this function, together with the blob
    // shas used to skip unchanged uploads — one round trip serving both.)
    //
    // Because base_tree preserves everything already on the branch, the old
    // uncompressed copies would otherwise sit there forever beside their .gz
    // replacements: two ledgers, one stale, and a reader with no way to tell
    // which is current. Drop them once — and only once — their compressed
    // replacement is actually in this tree.
    for (const f of FILES) {
      if (!f.legacyRemote) continue;
      if (!remoteShas[f.legacyRemote]) continue;
      if (!entries.some(e => e.path === f.remote)) continue;
      entries.push({ path: f.legacyRemote, mode: "100644", type: "blob", sha: null });
      console.log(`backup: removing superseded ${f.legacyRemote}`);
    }

    const tree = await ghJson(`/git/trees`, {
      method: "POST",
      body: JSON.stringify(baseTree ? { base_tree: baseTree, tree: entries } : { tree: entries })
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
    console.log(`backup: archive persisted (${entries.length} files, ${skipped} unchanged, `
      + `${(uploadedBytes / 1048576).toFixed(2)} MB uploaded) → ${REPO}@${BRANCH}`);
  } catch (e) {
    state.lastError = "backup: " + e.message;
    console.error(state.lastError);
  }
  return state;
}

// Restore runs at module load (top-level await) so it completes BEFORE
// store.js / ledger.js read their files — import this module first.
await restore();
