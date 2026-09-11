// ============================================================
// The ledger is published in shards. These are the ways that breaks.
//
// Compression fixed the immediate bandwidth breach but left the cost O(n) per
// append: one new row re-uploaded every row before it. Measured against real
// growth that crosses the 5 GB allowance in November. Sharding on `seq` makes
// it O(1) — a full range never changes again, so it hashes to bytes already on
// the branch and is skipped forever.
//
// That trade buys cheapness with a new and much worse failure mode. A single
// archive either restores or it doesn't. A SET of shards can come back
// *partially*: one file missing, the rest fine, and the ledger reassembles
// with a hole punched in the middle of it. That is worse than an empty
// restore in a specific way — the append-only guard cannot catch it, because
// a ledger missing rows from the middle is not SHORTER than the remote one.
// It would sail past the guard and be published over the good copy.
//
// So most of this file is about refusing to assemble something wrong, rather
// than about assembling something right.
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

console.log("# ── ledger shards ─────────────────────────────");

test("shards round-trip, and a full range is never rewritten", async () => {

  await check("an archive spanning several ranges round-trips exactly", async () => {
    seed({});
    const text = ledgerOf(1, 11000, 40);        // 11040 rows: under the cap, ranges 0,1,2
    fs.writeFileSync(LEDGER, text);
    await backup.backup();
    assert.equal(remoteLedger(), text,
      "the reassembled archive is not the archive that was backed up");
    const shards = paths().filter(p => SHARD_RE.test(p));
    assert.ok(shards.includes("backup/ledger/pre.jsonl.gz"),
      "the unsequenced legacy rows were not given their own sealed shard");
    assert.equal(shards.length, 4, `expected pre + 3 ranges, got ${shards.join(", ")}`);
  });

  await check("appending within a range rewrites ONLY that range", async () => {
    const sealed = ["backup/ledger/pre.jsonl.gz", "backup/ledger/00000.jsonl.gz",
                    "backup/ledger/00001.jsonl.gz"];
    const before = sealed.map(p => sha1(fileAt(p)));
    reset();
    fs.appendFileSync(LEDGER, row(12001) + "\n");
    await backup.backup();

    assert.deepEqual(sealed.map(p => sha1(fileAt(p))), before,
      "a sealed shard changed — if full ranges are not byte-stable the reuse check "
      + "never fires and the cost stays O(n)");
    // pre + 2 sealed ranges must have cost nothing; only the active range moves.
    assert.ok(blobPosts <= 2,
      `expected the active shard (+manifest) only, got ${blobPosts} blob posts`);
    const whole = Math.ceil(gzOf(remoteLedger()).length * 4 / 3);
    assert.ok(uploadedBytes < whole * 0.35,
      `one appended row cost ${uploadedBytes} B against ${whole} B for a full push — still O(n)`);
  });

  await check("crossing a range boundary seals the old shard and opens a new one", async () => {
    // Start from an empty branch: the previous scenario left a longer archive
    // behind, and the append-only guard would (rightly) refuse a shorter one.
    seed({});
    // Fill range 1 right up to its boundary, then step over it. Kept under the
    // 12,000-row cap on purpose: past it the truncation path also fires and the
    // test would be measuring two things at once.
    fs.writeFileSync(LEDGER, ledgerOf(1, 2 * SHARD_LINES - 1, 40));  // 10,039 rows
    await backup.backup();
    const sealedSha = sha1(fileAt("backup/ledger/00001.jsonl.gz"));
    assert.equal(paths().filter(p => SHARD_RE.test(p)).length, 3, "expected pre + ranges 0,1");

    reset();
    fs.appendFileSync(LEDGER, row(2 * SHARD_LINES) + "\n");   // first row of range 2
    await backup.backup();

    assert.ok(paths().includes("backup/ledger/00002.jsonl.gz"), "the new range was not opened");
    assert.equal(sha1(fileAt("backup/ledger/00001.jsonl.gz")), sealedSha,
      "the range that just filled up was rewritten instead of sealed");
    assert.equal(remoteLedger(), fs.readFileSync(LEDGER, "utf8"),
      "the archive did not survive a boundary crossing");
  });
});

test("shards the archive no longer contains are removed, not orphaned", async () => {

  await check("a shard with no surviving rows is deleted from the branch", async () => {
    // base_tree preserves anything not mentioned, so a shard left behind after
    // the cap drops its rows would sit on the branch forever — and the next
    // restore would splice those rows back into the middle of the archive.
    // A successful-looking restore that silently resurrects deleted history.
    seed({});                       // independent of whatever ran before
    fs.writeFileSync(LEDGER, ledgerOf(1, 11000, 40));
    await backup.backup();
    assert.ok(paths().includes("backup/ledger/00000.jsonl.gz"));
    assert.ok(paths().includes("backup/ledger/pre.jsonl.gz"));

    // Grow past the cap. The append-only guard compares the FULL local file
    // against the remote, so it passes; the cap then drops the oldest rows and
    // ranges 0 and "pre" cease to exist. Shrinking the local file instead
    // would (correctly) be refused by the guard and prove nothing.
    // 20040 rows capped to 12000 keeps seq 8001..20000, so the legacy shard
    // AND range 0 lose every row they had; range 1 survives partially.
    const grown = ledgerOf(1, 20000, 40);
    fs.writeFileSync(LEDGER, grown);
    await backup.backup();
    const trimmed = grown.split("\n").filter(Boolean).slice(-12000).join("\n") + "\n";

    assert.ok(!paths().includes("backup/ledger/00000.jsonl.gz"),
      "an emptied shard is still on the branch — a later restore would resurrect its rows");
    assert.ok(!paths().includes("backup/ledger/pre.jsonl.gz"),
      "the legacy shard was orphaned after its rows were dropped");
    assert.equal(remoteLedger(), trimmed,
      "the branch no longer reassembles to the archive that was backed up");
  });
});

test("layouts this replaces still restore, and are cleaned up", async () => {

  await check("a branch holding only the single-file archive still restores", async () => {
    // Without this the first boot after the change finds no ledger, starts
    // empty, and the append-only guard then refuses every later backup.
    const legacy = ledgerOf(1, 300, 5);
    missing = new Set();
    seed({ "backup/ledger.jsonl.gz": gzOf(legacy) });     // no shards, no manifest
    fs.writeFileSync(LEDGER, "");
    await backup.restore();
    assert.equal(fs.readFileSync(LEDGER, "utf8"), legacy,
      "the pre-shard archive did not restore — an upgrade would lose the ledger");
  });

  await check("the next backup converts it to shards and drops the single file", async () => {
    await backup.backup();
    assert.ok(paths().some(p => SHARD_RE.test(p)), "the archive was not converted to shards");
    assert.equal(fileAt("backup/ledger.jsonl.gz"), null,
      "the superseded single-file archive is still on the branch beside its shards — "
      + "two ledgers, one stale, and a reader with no way to tell which is current");
    assert.equal(remoteLedger(), fs.readFileSync(LEDGER, "utf8"));
  });
});

test("rows it cannot place are never silently reordered", async () => {

  await check("an out-of-order ledger falls back to the single file", async () => {
    // Sharding assumes non-decreasing seq. If that ever stops holding, writing
    // shards anyway would reassemble the rows in a different order, break the
    // hash chain, and present the archive as tampered with. Refusing to shard
    // is the cheap, correct answer.
    seed({});
    fs.writeFileSync(LEDGER, [row(9000), row(100), row(9001)].join("\n") + "\n");
    await backup.backup();

    assert.equal(paths().filter(p => SHARD_RE.test(p)).length, 0,
      "out-of-order rows were sharded — reassembly would silently reorder the archive");
    const one = fileAt("backup/ledger.jsonl.gz");
    assert.ok(one, "no archive was written at all");
    assert.equal(zlib.gunzipSync(one).toString("utf8"), fs.readFileSync(LEDGER, "utf8"),
      "the fallback archive does not match the ledger");
  });

  console.log("# ──────────────────────────────────────────────");
  console.log(`#   ${passed} passed, ${failed} failed`);
  assert.equal(failed, 0);
});
