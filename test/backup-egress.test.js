// ============================================================
// The backup must not cost more bandwidth than the plan includes.
//
// On 10 September 2026 this service had spent 2.73 GB of a 5 GB monthly
// allowance by the tenth day, and 2.71 GB of that was traffic it initiated
// itself — against 17 MB actually served to visitors. Projected forward it
// crossed the cap around the 18th, which on a free plan means the site stops.
//
// Every byte of it came from moving the archive around uncompressed:
// restore() pulled the whole ledger on each boot, remoteLedgerLines() pulled
// it AGAIN on each backup to count lines, and the backup then re-uploaded it
// base64-encoded whether or not a row had changed.
//
// These tests hold the three properties that fixed it. They are written
// against a fake GitHub so they assert what actually goes over the wire —
// a test that only checked "backup() resolves" would have passed happily
// throughout the incident.
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import crypto from "node:crypto";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "orbitiq-backup-"));

// A ledger of realistic shape and size — the thing whose transfer cost is
// the entire subject of this file.
const LEDGER_ROWS = 20000;
const ledgerText = Array.from({ length: LEDGER_ROWS }, (_, i) => JSON.stringify({
  seq: i + 1, prev: "a".repeat(32), h: "b".repeat(32),
  t: "2026-09-10T00:00:00.000Z", type: "conjunction", org: null,
  aName: "SAT-" + i, bName: "DEB-" + i, missKm: 1.5, relVelKmS: 7.4,
  altKm: 550, risk: "low", pc: 1.2e-5
})).join("\n") + "\n";

fs.writeFileSync(path.join(tmp, "ledger.jsonl"), ledgerText);
fs.writeFileSync(path.join(tmp, "ledger-seals.json"), JSON.stringify([{ seq: 1, hash: "x" }]));
fs.writeFileSync(path.join(tmp, "elements-history.json"), JSON.stringify({ a: 1 }));

const gitBlobSha = buf => crypto.createHash("sha1")
  .update(Buffer.concat([Buffer.from(`blob ${buf.length}\0`), buf])).digest("hex");

// ── A fake GitHub that remembers blobs and measures the wire ──
function makeGitHub() {
  const blobs = new Map();          // sha -> Buffer
  const trees = new Map();          // sha -> [{path, sha}]
  const gh = { branchTree: null, headCommit: null, uploadedBytes: 0, blobPosts: 0, contentGets: 0, bytesDown: 0 };

  gh.seed = (files) => {            // files: { path: Buffer }
    const entries = [];
    for (const [p, buf] of Object.entries(files)) {
      const sha = gitBlobSha(buf); blobs.set(sha, buf); entries.push({ path: p, sha, type: "blob", mode: "100644" });
    }
    const treeSha = "tree" + crypto.randomUUID();
    trees.set(treeSha, entries);
    gh.branchTree = treeSha;
    gh.headCommit = "commit" + crypto.randomUUID();
    return gh;
  };
  gh.fileAt = p => {
    const e = (trees.get(gh.branchTree) || []).find(x => x.path === p);
    return e ? blobs.get(e.sha) : null;
  };

  gh.fetch = async (url, opts = {}) => {
    const u = String(url);
    const body = opts.body ? JSON.parse(opts.body) : null;
    const json = (o, code = 200) => ({ ok: code < 300, status: code, json: async () => o,
      text: async () => typeof o === "string" ? o : JSON.stringify(o),
      arrayBuffer: async () => Buffer.from(typeof o === "string" ? o : JSON.stringify(o)) });

    if (u.includes("/contents/")) {
      gh.contentGets++;
      const p = decodeURIComponent(u.split("/contents/")[1].split("?")[0]);
      const buf = gh.fileAt(p);
      if (!buf) return { ok: false, status: 404, text: async () => "", arrayBuffer: async () => Buffer.alloc(0), json: async () => ({}) };
      gh.bytesDown += buf.length;
      return { ok: true, status: 200, text: async () => buf.toString("utf8"),
               arrayBuffer: async () => buf, json: async () => JSON.parse(buf.toString("utf8")) };
    }
    if (u.endsWith(`/git/ref/heads/data-backup`)) {
      if (!gh.headCommit) return { ok: false, status: 404, json: async () => ({}) };
      return json({ object: { sha: gh.headCommit } });
    }
    if (u.includes("/git/commits/")) return json({ tree: { sha: gh.branchTree } });
    if (u.includes("/git/trees/"))   return json({ tree: trees.get(gh.branchTree) || [] });
    if (u.endsWith("/git/blobs") && opts.method === "POST") {
      gh.blobPosts++;
      const raw = Buffer.from(body.content, "base64");
      gh.uploadedBytes += body.content.length;   // base64 chars ARE the bytes sent
      const sha = gitBlobSha(raw); blobs.set(sha, raw);
      return json({ sha });
    }
    if (u.endsWith("/git/trees") && opts.method === "POST") {
      const base = body.base_tree ? [...(trees.get(body.base_tree) || [])] : [];
      const merged = new Map(base.map(e => [e.path, e]));
      for (const e of body.tree) {
        if (e.sha === null) merged.delete(e.path);
        else merged.set(e.path, { path: e.path, sha: e.sha, type: "blob", mode: "100644" });
      }
      const sha = "tree" + crypto.randomUUID();
      trees.set(sha, [...merged.values()]);
      return json({ sha });
    }
    if (u.endsWith("/git/commits") && opts.method === "POST") {
      gh.pendingTree = body.tree;
      return json({ sha: "commit" + crypto.randomUUID() });
    }
    if (u.includes("/git/refs/heads/")) {
      gh.branchTree = gh.pendingTree; gh.headCommit = body.sha;
      return json({ ok: true });
    }
    if (u.endsWith("/git/refs") && opts.method === "POST") return json({ ok: true });
    return json({}, 404);
  };
  return gh;
}

let gh;
process.env.ORBITIQ_DATA_DIR = tmp;
process.env.ORBITIQ_GH_TOKEN = "fake-token-for-test";
process.env.ORBITIQ_BACKUP_REPO = "mnbresearch/orbitiq";
gh = makeGitHub().seed({});                       // empty branch at import time
globalThis.fetch = (...a) => gh.fetch(...a);
const backup = await import("../src/backup.js");

let passed = 0, failed = 0;
const check = async (name, fn) => {
  try { await fn(); passed++; console.log(`#   ok    ${name}`); }
  catch (e) { failed++; console.log(`#   FAIL  ${name}\n#         ${e.message}`); throw e; }
};

console.log("# ── backup egress ─────────────────────────────");

test("the archive moves compressed, and only when it changed", async () => {

  await check("the first backup uploads a COMPRESSED ledger", async () => {
    gh.uploadedBytes = 0; gh.blobPosts = 0;
    await backup.backup();
    const stored = gh.fileAt("backup/ledger.jsonl.gz");
    assert.ok(stored, "no compressed ledger was written");
    assert.equal(zlib.gunzipSync(stored).toString("utf8"), ledgerText,
      "the compressed archive does not round-trip to the original — this is the product");

    const plainBase64 = Math.ceil(Buffer.byteLength(ledgerText) * 4 / 3);
    assert.ok(gh.uploadedBytes < plainBase64 * 0.25,
      `expected the upload to be a small fraction of the ${(plainBase64/1048576).toFixed(1)} MB `
      + `an uncompressed base64 push costs, got ${(gh.uploadedBytes/1048576).toFixed(2)} MB`);
    console.log(`#         uploaded ${(gh.uploadedBytes/1048576).toFixed(2)} MB `
      + `vs ${(plainBase64/1048576).toFixed(2)} MB uncompressed`);
  });

  await check("an unchanged archive uploads NOTHING at all", async () => {
    // The case that dominated the bill: a shutdown minutes after a wake, with
    // not one new row, re-pushing the entire archive.
    gh.uploadedBytes = 0; gh.blobPosts = 0;
    await backup.backup();
    assert.equal(gh.blobPosts, 0, "re-uploaded blobs for an archive that had not changed");
    assert.equal(gh.uploadedBytes, 0, "spent bandwidth on an unchanged archive");
  });

  await check("appending a row DOES upload again", async () => {
    // The mirror image: a cap that skipped real changes would silently stop
    // backing the archive up, which is worse than the bandwidth it saves.
    fs.appendFileSync(path.join(tmp, "ledger.jsonl"),
      JSON.stringify({ seq: LEDGER_ROWS + 1, prev: "a".repeat(32), h: "c".repeat(32), type: "risk" }) + "\n");
    gh.uploadedBytes = 0; gh.blobPosts = 0;
    await backup.backup();
    assert.ok(gh.blobPosts > 0, "a real change was skipped — the archive would stop being backed up");
    const stored = zlib.gunzipSync(gh.fileAt("backup/ledger.jsonl.gz")).toString("utf8");
    assert.equal(stored.split("\n").filter(Boolean).length, LEDGER_ROWS + 1);
  });

  await check("counting the remote ledger costs a manifest, not a download", async () => {
    // remoteLedgerLines() used to pull the whole archive to learn one integer.
    const manifest = gh.fileAt("backup/manifest.json");
    assert.ok(manifest, "no manifest was written");
    assert.equal(JSON.parse(manifest.toString()).ledgerLines, LEDGER_ROWS + 1);
    assert.ok(manifest.length < 200, "the manifest should be tiny, got " + manifest.length + " bytes");
  });

  await check("the superseded uncompressed copy is removed, not left to rot", async () => {
    assert.equal(gh.fileAt("backup/ledger.jsonl"), null,
      "the old plain ledger is still on the branch beside its .gz replacement");
  });

  await check("restore brings the archive back byte-for-byte", async () => {
    fs.rmSync(path.join(tmp, "ledger.jsonl"));
    await backup.restore();
    const back = fs.readFileSync(path.join(tmp, "ledger.jsonl"), "utf8");
    assert.equal(back.split("\n").filter(Boolean).length, LEDGER_ROWS + 1,
      "the restored ledger is not the ledger that was backed up");
  });

  console.log("# ──────────────────────────────────────────────");
  console.log(`#   ${passed} passed, ${failed} failed`);
  assert.equal(failed, 0);
});

test("a backup written before compression still restores", async () => {
  // The upgrade path. Without the legacy fallback the first boot after this
  // change finds no ledger, starts empty, and the append-only guard then
  // refuses every later backup — recoverable only by hand.
  await check("a plain legacy ledger is found and restored", async () => {
    const legacy = "legacy-" + crypto.randomUUID() + "\n";
    gh.seed({ "backup/ledger.jsonl": Buffer.from(legacy, "utf8") });   // no .gz present
    fs.writeFileSync(path.join(tmp, "ledger.jsonl"), "");
    await backup.restore();
    assert.equal(fs.readFileSync(path.join(tmp, "ledger.jsonl"), "utf8"), legacy,
      "the pre-compression backup did not restore — an upgrade would lose the archive");
  });

  console.log("# ──────────────────────────────────────────────");
  console.log(`#   ${passed} passed, ${failed} failed`);
  assert.equal(failed, 0);
});
