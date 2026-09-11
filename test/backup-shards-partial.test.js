// ============================================================
// A shard set that is not whole must never be assembled.
//
// Split from backup-shards.test.js deliberately: these scenarios mark every
// shard unreadable, and `state.unreadable` is never cleared within a process
// — by design, since a shard this boot could not read is one it must not
// overwrite. Node gives each test FILE its own process, which is the only
// clean way to run both halves.
//
// The danger being guarded is specific. A single archive either restores or it
// does not. A SET of shards can come back partially: one file missing, the
// rest fine, and the ledger reassembles with a hole in the middle. The
// append-only guard cannot catch that, because a ledger missing rows from the
// middle is not SHORTER than the remote one — it would sail past the guard and
// be published over the good copy.
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import crypto from "node:crypto";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "orbitiq-shard-"));
const LEDGER = path.join(tmp, "ledger.jsonl");
const SHARD_LINES = 5000;                 // must match src/backup.js
const SHARD_RE = /^backup\/ledger\/(pre|\d{5})\.jsonl\.gz$/;

const sha1 = b => crypto.createHash("sha1")
  .update(Buffer.concat([Buffer.from(`blob ${b.length}\0`), b])).digest("hex");

const row = (seq, extra = {}) => JSON.stringify({
  seq, prev: "a".repeat(16), h: "b".repeat(16), type: "conjunction", ...extra
});
/** Rows seq=from..to inclusive, plus `pre` unsequenced legacy rows at the head. */
const ledgerOf = (from, to, pre = 0) => {
  const lines = [];
  for (let i = 0; i < pre; i++) lines.push(JSON.stringify({ legacy: true, n: i, type: "sweep" }));
  for (let s = from; s <= to; s++) lines.push(row(s));
  return lines.join("\n") + "\n";
};

// ── a fake GitHub that remembers blobs and counts the wire ──
const blobs = new Map(), trees = new Map();
let branchTree = null, headCommit = null, pendingTree = null;
let blobPosts = 0, uploadedBytes = 0, postedPaths = [];

const seed = files => {
  const entries = [];
  for (const [p, buf] of Object.entries(files)) {
    const s = sha1(buf); blobs.set(s, buf);
    entries.push({ path: p, sha: s, type: "blob", mode: "100644" });
  }
  branchTree = "t" + crypto.randomUUID(); trees.set(branchTree, entries);
  headCommit = "c" + crypto.randomUUID();
};
const paths = () => (trees.get(branchTree) || []).map(e => e.path);
const fileAt = p => {
  const e = (trees.get(branchTree) || []).find(x => x.path === p);
  return e ? blobs.get(e.sha) : null;
};
/** Reassemble the way a human recovering from a real loss would have to. */
const remoteLedger = () => {
  const s = paths().filter(p => SHARD_RE.test(p)).sort((a, b) => {
    const k = q => q.includes("/pre.") ? -1 : parseInt(q.match(/(\d{5})\.jsonl\.gz$/)[1], 10);
    return k(a) - k(b);
  });
  if (s.length) return s.map(p => zlib.gunzipSync(fileAt(p)).toString("utf8")).join("");
  const one = fileAt("backup/ledger.jsonl.gz");
  return one ? zlib.gunzipSync(one).toString("utf8") : null;
};
const gzOf = text => zlib.gzipSync(Buffer.from(text, "utf8"), { level: 9 });

/** Paths the fake GitHub should pretend are gone, to simulate a lost shard. */
let missing = new Set();

globalThis.fetch = async (url, opts = {}) => {
  const u = String(url), body = opts.body ? JSON.parse(opts.body) : null;
  const J = o => ({ ok: true, status: 200, json: async () => o,
    text: async () => typeof o === "string" ? o : JSON.stringify(o),
    arrayBuffer: async () => Buffer.from(typeof o === "string" ? o : JSON.stringify(o)) });
  const NOT_FOUND = { ok: false, status: 404, text: async () => "",
    arrayBuffer: async () => Buffer.alloc(0), json: async () => ({}) };

  if (u.includes("/contents/")) {
    const p = decodeURIComponent(u.split("/contents/")[1].split("?")[0]);
    if (missing.has(p)) return NOT_FOUND;
    const buf = fileAt(p);
    if (!buf) return NOT_FOUND;
    return { ok: true, status: 200, text: async () => buf.toString("utf8"),
             arrayBuffer: async () => buf, json: async () => JSON.parse(buf.toString("utf8")) };
  }
  if (u.endsWith("/git/ref/heads/data-backup")) {
    if (!headCommit) return NOT_FOUND;
    return J({ object: { sha: headCommit } });
  }
  if (u.includes("/git/commits/")) return J({ tree: { sha: branchTree } });
  if (u.includes("/git/trees/"))   return J({ tree: trees.get(branchTree) || [] });
  if (u.endsWith("/git/blobs") && opts.method === "POST") {
    blobPosts++;
    const raw = Buffer.from(body.content, "base64");
    uploadedBytes += body.content.length;        // base64 chars ARE what goes out
    const s = sha1(raw); blobs.set(s, raw);
    return J({ sha: s });
  }
  if (u.endsWith("/git/trees") && opts.method === "POST") {
    const base = body.base_tree ? [...(trees.get(body.base_tree) || [])] : [];
    const merged = new Map(base.map(e => [e.path, e]));
    for (const e of body.tree) {
      if (e.sha === null) merged.delete(e.path);
      else merged.set(e.path, { path: e.path, sha: e.sha, type: "blob", mode: "100644" });
    }
    const s = "t" + crypto.randomUUID(); trees.set(s, [...merged.values()]);
    return J({ sha: s });
  }
  if (u.endsWith("/git/commits") && opts.method === "POST") { pendingTree = body.tree; return J({ sha: "c" + crypto.randomUUID() }); }
  if (u.includes("/git/refs/heads/")) { branchTree = pendingTree; headCommit = body.sha; return J({}); }
  if (u.endsWith("/git/refs") && opts.method === "POST") return J({});
  return NOT_FOUND;
};

process.env.ORBITIQ_DATA_DIR = tmp;
process.env.ORBITIQ_GH_TOKEN = "fake-token";
process.env.ORBITIQ_MAX_LEDGER_LINES = "12000";   // exercise the cap without 60,000 rows
process.env.ORBITIQ_BACKUP_REPO = "mnbresearch/orbitiq";
fs.writeFileSync(LEDGER, ledgerOf(1, 100));
seed({});
const backup = await import("../src/backup.js");

let passed = 0, failed = 0;
const check = async (name, fn) => {
  try { await fn(); passed++; console.log(`#   ok    ${name}`); }
  catch (e) { failed++; console.log(`#   FAIL  ${name}\n#         ${e.message}`); throw e; }
};
const reset = () => { blobPosts = 0; uploadedBytes = 0; postedPaths = []; };

console.log("# ── ledger shards: partial sets ───────────────");

test("a shard set that is not whole is never assembled", async () => {

  // Publish a real multi-shard archive first. Without this there is nothing to
  // lose a shard FROM, and the test would pass by never reaching the guard.
  fs.writeFileSync(LEDGER, ledgerOf(1, 11000, 40));
  await backup.backup();
  assert.equal(paths().filter(p => SHARD_RE.test(p)).length, 4, "setup did not publish shards");

  await check("a missing shard refuses the restore and leaves the local file alone", async () => {
    // This is the case the append-only guard cannot see: rows gone from the
    // MIDDLE, so the result is not shorter than the remote and would be
    // published straight over the good copy as though nothing were wrong.
    const good = fs.readFileSync(LEDGER, "utf8");
    fs.writeFileSync(LEDGER, good);
    missing = new Set(["backup/ledger/00001.jsonl.gz"]);
    const before = fs.readFileSync(LEDGER, "utf8");

    await backup.restore();

    assert.equal(fs.readFileSync(LEDGER, "utf8"), before,
      "a partial ledger was written over the local copy");
    const s = backup.status();
    assert.match(String(s.lastError), /shard/i,
      "the failure was not reported — an operator would not know the archive is unreadable");
    missing = new Set();
  });

  await check("a shard set that disagrees with the manifest is refused", async () => {
    // Same danger reached the other way: the files are all readable, but they
    // are not the set the manifest published. Trusting them would silently
    // swap one archive for another.
    const manifest = JSON.parse(fileAt("backup/manifest.json").toString());
    const doctored = Buffer.from(JSON.stringify({ ...manifest, ledgerLines: manifest.ledgerLines + 7 }) + "\n", "utf8");
    const s2 = sha1(doctored); blobs.set(s2, doctored);
    const entries = (trees.get(branchTree) || []).map(e =>
      e.path === "backup/manifest.json" ? { ...e, sha: s2 } : e);
    branchTree = "t" + crypto.randomUUID(); trees.set(branchTree, entries);

    const before = fs.readFileSync(LEDGER, "utf8");
    await backup.restore();
    assert.equal(fs.readFileSync(LEDGER, "utf8"), before,
      "a ledger whose row count contradicts the published manifest was written anyway");
    assert.match(String(backup.status().lastError), /incomplete|shard/i);
  });
});


test("the refusals were reported, not merely survived", async () => {
  console.log("# ──────────────────────────────────────────────");
  console.log(`#   ${passed} passed, ${failed} failed`);
  assert.equal(failed, 0);
});
