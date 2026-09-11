// ============================================================
// Rotating the backup key must not destroy the accounts.
//
// ── The sequence this exists to stop ────────────────────────
// The ledger has an append-only guard: a shorter archive is never published
// over a longer one. store.json.enc and auth.json.enc had no equivalent, and
// rotating ORBITIQ_BACKUP_KEY is precisely the event that finds the gap:
//
//   1. cold boot with the new key, so blobs sealed with the old one no longer
//      decrypt — restore skips them
//   2. the disk is ephemeral, so there is no local copy either; the service
//      comes up with no workspaces and bootstraps a fresh admin
//   3. the LEDGER restored fine, so it has not shrunk, so the append-only
//      guard stays quiet and the backup proceeds
//   4. that backup seals the now-EMPTY files with the NEW key and force-pushes
//      them over the good ones
//
// Every workspace API key and user account gone, with nothing looking wrong at
// any step, and no parent commit to recover from because the branch is
// force-pushed flat by design.
//
// The rule under test: a file this boot could not READ is a file this boot may
// not WRITE. Losing the ability to read a backup is bad. Silently destroying
// it as a consequence is unrecoverable.
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import zlib from "node:zlib";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "orbitiq-rotate-"));
const OLD_KEY = crypto.randomBytes(32).toString("hex");
const NEW_KEY = crypto.randomBytes(32).toString("hex");

// Real accounts, so a loss in this test is a recognisable loss.
const REAL_STORE = JSON.stringify({ workspaces: { acme: { apiKey: "oiq_live_key_do_not_lose" } } });
const REAL_AUTH  = JSON.stringify({ users: [{ email: "operator@acme.test", hash: "scrypt$real" }] });
const LEDGER_TEXT = [1, 2, 3].map(i => JSON.stringify({ seq: i, type: "conjunction" })).join("\n") + "\n";

const sha1 = b => crypto.createHash("sha1")
  .update(Buffer.concat([Buffer.from(`blob ${b.length}\0`), b])).digest("hex");

// Seal exactly the way src/backup.js does, so the ciphertext is genuinely
// undecryptable under a different key rather than merely different.
function seal(plaintext, keyHex) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", Buffer.from(keyHex, "hex"), iv);
  const enc = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
  // v1|iv|tag|ciphertext, plain base64 — byte-identical to src/backup.js. A
  // near-miss here (base64url, say) would make the archive undecryptable for
  // the wrong reason and the test would pass while proving nothing.
  return ["v1", iv.toString("base64"), c.getAuthTag().toString("base64"), enc.toString("base64")].join(".");
}

// ── A fake GitHub whose branch we can inspect afterwards ───
const blobs = new Map(), trees = new Map();
let branchTree = null, headCommit = null, pendingTree = null;

const seed = files => {
  const entries = [];
  for (const [p, buf] of Object.entries(files)) {
    const s = sha1(buf); blobs.set(s, buf);
    entries.push({ path: p, sha: s, type: "blob", mode: "100644" });
  }
  branchTree = "t" + crypto.randomUUID(); trees.set(branchTree, entries);
  headCommit = "c" + crypto.randomUUID();
};
const fileAt = p => {
  const e = (trees.get(branchTree) || []).find(x => x.path === p);
  return e ? blobs.get(e.sha) : null;
};

globalThis.fetch = async (url, opts = {}) => {
  const u = String(url), body = opts.body ? JSON.parse(opts.body) : null;
  const J = o => ({ ok: true, status: 200, json: async () => o,
    text: async () => typeof o === "string" ? o : JSON.stringify(o),
    arrayBuffer: async () => Buffer.from(typeof o === "string" ? o : JSON.stringify(o)) });

  if (u.includes("/contents/")) {
    const p = decodeURIComponent(u.split("/contents/")[1].split("?")[0]);
    const buf = fileAt(p);
    if (!buf) return { ok: false, status: 404, text: async () => "",
                       arrayBuffer: async () => Buffer.alloc(0), json: async () => ({}) };
    return { ok: true, status: 200, text: async () => buf.toString("utf8"),
             arrayBuffer: async () => buf, json: async () => JSON.parse(buf.toString("utf8")) };
  }
  if (u.endsWith("/git/ref/heads/data-backup")) return J({ object: { sha: headCommit } });
  if (u.includes("/git/commits/")) return J({ tree: { sha: branchTree } });
  if (u.includes("/git/trees/"))   return J({ tree: trees.get(branchTree) || [] });
  if (u.endsWith("/git/blobs") && opts.method === "POST") {
    const raw = Buffer.from(body.content, "base64"); const s = sha1(raw); blobs.set(s, raw);
    return J({ sha: s });
  }
  if (u.endsWith("/git/trees") && opts.method === "POST") {
    const base = body.base_tree ? [...(trees.get(body.base_tree) || [])] : [];
    const merged = new Map(base.map(e => [e.path, e]));
    for (const e of body.tree) e.sha === null ? merged.delete(e.path)
      : merged.set(e.path, { path: e.path, sha: e.sha, type: "blob", mode: "100644" });
    const s = "t" + crypto.randomUUID(); trees.set(s, [...merged.values()]);
    return J({ sha: s });
  }
  if (u.endsWith("/git/commits") && opts.method === "POST") { pendingTree = body.tree; return J({ sha: "c" + crypto.randomUUID() }); }
  if (u.includes("/git/refs/heads/")) { branchTree = pendingTree; headCommit = body.sha; return J({}); }
  return J({}, 404);
};

// The branch as it stands the moment before the rotated key is applied:
// a healthy archive, sealed with the OLD key.
seed({
  "backup/ledger.jsonl.gz": zlib.gzipSync(Buffer.from(LEDGER_TEXT, "utf8"), { level: 9 }),
  "backup/store.json.enc": Buffer.from(seal(REAL_STORE, OLD_KEY), "utf8"),
  "backup/auth.json.enc":  Buffer.from(seal(REAL_AUTH,  OLD_KEY), "utf8"),
  "backup/manifest.json":  Buffer.from(JSON.stringify({ ledgerLines: 3 }) + "\n", "utf8")
});
// Boot with the NEW key — the rotation the operator just performed.
process.env.ORBITIQ_DATA_DIR = tmp;
process.env.ORBITIQ_GH_TOKEN = "fake-token";
process.env.ORBITIQ_BACKUP_KEY = NEW_KEY;
process.env.ORBITIQ_BACKUP_REPO = "mnbresearch/orbitiq";
const backup = await import("../src/backup.js");

let passed = 0, failed = 0;
const check = async (name, fn) => {
  try { await fn(); passed++; console.log(`#   ok    ${name}`); }
  catch (e) { failed++; console.log(`#   FAIL  ${name}\n#         ${e.message}`); throw e; }
};

console.log("# ── backup key rotation ───────────────────────");

test("a key this boot cannot read is a file this boot cannot write", async () => {

  await check("the rotated key genuinely cannot decrypt the old archive", async () => {
    // If this ever passes trivially the rest of the file proves nothing.
    assert.equal(fs.existsSync(path.join(tmp, "store.json")), false,
      "store.json was restored despite the key having changed");
    assert.equal(fs.existsSync(path.join(tmp, "auth.json")), false,
      "auth.json was restored despite the key having changed");
  });

  await check("health names it, and names the remedy", async () => {
    const s = backup.status();
    assert.equal(s.health, "unreadable",
      `expected health "unreadable", got "${s.health}" — an operator would not know accounts are at risk`);
    assert.ok(s.unreadable.includes("backup/store.json.enc"));
    assert.match(s.means, /ORBITIQ_BACKUP_KEY/,
      "the explanation must say what actually happened, so the fix is obvious");
  });

  await check("the empty local state is NOT published over the real accounts", async () => {
    // This is the whole test. The service is now running with no workspaces —
    // exactly the state that used to get force-pushed over the good copy.
    fs.writeFileSync(path.join(tmp, "store.json"), JSON.stringify({ workspaces: {} }));
    fs.writeFileSync(path.join(tmp, "auth.json"), JSON.stringify({ users: [] }));
    fs.writeFileSync(path.join(tmp, "ledger.jsonl"), LEDGER_TEXT);

    await backup.backup();

    const store = fileAt("backup/store.json.enc");
    assert.ok(store, "store.json.enc was DROPPED from the branch entirely");
    const back = decrypt(store.toString("utf8"), OLD_KEY);
    assert.equal(back, REAL_STORE,
      "the real workspace keys were overwritten — this is the unrecoverable case");

    const auth = decrypt(fileAt("backup/auth.json.enc").toString("utf8"), OLD_KEY);
    assert.equal(auth, REAL_AUTH, "the real user accounts were overwritten");
  });

  await check("everything else still backs up normally", async () => {
    // The guard must be surgical. If it froze the whole backup, the ledger
    // would stop being persisted and the rotation would cost the archive
    // instead of the accounts — a different disaster, not a fix.
    const shardPaths = (trees.get(branchTree) || []).map(e => e.path)
      .filter(p => /^backup\/ledger\/(pre|\d{5})\.jsonl\.gz$/.test(p));
    assert.ok(shardPaths.length, "the ledger stopped being backed up");
    const back = shardPaths.sort().map(p => zlib.gunzipSync(fileAt(p)).toString("utf8")).join("");
    assert.equal(back, LEDGER_TEXT,
      "the ledger came back altered while the secrets were being protected — the guard must be "
      + "surgical, not merely loud");
    assert.ok(fileAt("backup/manifest.json"), "the manifest stopped being written");
  });

  console.log("# ──────────────────────────────────────────────");
  console.log(`#   ${passed} passed, ${failed} failed`);
  assert.equal(failed, 0);
});

function decrypt(text, keyHex) {
  const [, ivB, tagB, dataB] = text.split(".");
  const d = crypto.createDecipheriv("aes-256-gcm", Buffer.from(keyHex, "hex"),
    Buffer.from(ivB, "base64"));
  d.setAuthTag(Buffer.from(tagB, "base64"));
  return Buffer.concat([d.update(Buffer.from(dataB, "base64")), d.final()]).toString("utf8");
}
