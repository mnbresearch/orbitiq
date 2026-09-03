// ============================================================
// Archive disaster drill.
//
// ── Why this file exists ────────────────────────────────────
// Every claim this product makes rests on one file surviving. The evidence
// layer, the verifier tier, the hash chain, the witness runs — all of it is a
// view onto data/ledger.jsonl. It sits on an ephemeral disk that is wiped on
// every redeploy, and the only thing standing between a redeploy and total
// loss is backup.js.
//
// That module had never been exercised end to end. It was written, it looked
// right, and nobody had ever destroyed a disk and watched the archive come
// back. So this drill does exactly that, against a fake GitHub, and then goes
// looking for the ways it can eat the archive instead of saving it.
//
// It found three, and they are the reason each test below is phrased as a
// disaster rather than a feature:
//
//   1. The published tree was built ONLY from the files readable on that run,
//      with no base_tree, then force-pushed parentless. Any file momentarily
//      unreadable was therefore DELETED from the backup.
//   2. Following from (1): if a boot could not restore (GitHub briefly
//      unreachable), the service started with an empty ledger, ran a sweep,
//      and force-pushed three rows over the real archive. A network blip at
//      the wrong moment destroyed the record permanently.
//   3. backup.js was the only module that ignored ORBITIQ_DATA_DIR. The
//      recommended next infrastructure step is mounting a persistent disk —
//      which is done by setting exactly that variable — at which point the
//      live archive moves and the backup silently keeps saving the old empty
//      directory.
//
// None of these would have shown up in normal operation. They show up the
// first time something goes wrong, which is the only time any of it matters.
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "orbitiq-drill-"));
process.env.ORBITIQ_DATA_DIR = tmp;
process.env.ORBITIQ_GH_TOKEN = "fake-token-for-the-drill";
process.env.ORBITIQ_BACKUP_KEY = crypto.randomBytes(32).toString("hex");
process.env.ORBITIQ_BACKUP_REPO = "drill/repo";
process.env.ORBITIQ_BACKUP_BRANCH = "data-backup";

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log(`#   ok    ${name}`); }
  catch (e) { failed++; console.log(`#   FAIL  ${name}\n#         ${e.message}`); throw e; }
}

// ── A fake GitHub, just complete enough to be honest ───────
//
// Stubbing fetch rather than testing a pure "planner" function is deliberate.
// Defect (1) above lives in the SHAPE of the API call — a tree created without
// base_tree — so a test that checked a planner's return value would have
// passed while the archive was still being deleted. The bug is in the HTTP, so
// the test is against the HTTP.
const git = {
  blobs: new Map(),        // sha -> content
  trees: new Map(),        // sha -> [{path, sha}]
  commits: new Map(),      // sha -> {tree}
  branch: null,            // commit sha
  calls: []
};
const sha1 = s => crypto.createHash("sha1").update(s).digest("hex");

/** Files currently on the backup branch, as { remotePath: content }. */
function branchFiles() {
  if (!git.branch) return {};
  const commit = git.commits.get(git.branch);
  const entries = git.trees.get(commit.tree) || [];
  return Object.fromEntries(entries.map(e => [e.path, git.blobs.get(e.sha)]));
}

function resetGit() {
  git.blobs.clear(); git.trees.clear(); git.commits.clear();
  git.branch = null; git.calls.length = 0;
}

globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const method = (opts.method || "GET").toUpperCase();
  const body = opts.body ? JSON.parse(opts.body) : null;
  git.calls.push({ method, u, body });
  const json = (status, v) => ({
    ok: status < 300, status,
    json: async () => v,
    text: async () => (typeof v === "string" ? v : JSON.stringify(v))
  });

  if (u.includes("/git/ref/heads/data-backup")) {
    return git.branch ? json(200, { object: { sha: git.branch } }) : json(404, {});
  }
  if (u.includes("/git/ref/heads/main")) return json(200, { object: { sha: "mainsha" } });
  if (u.includes("/git/refs") && method === "POST") { git.branch = body.sha; return json(201, {}); }
  if (u.includes("/git/refs/heads/data-backup") && method === "PATCH") {
    git.branch = body.sha; return json(200, {});
  }
  if (u.includes("/git/blobs") && method === "POST") {
    const content = Buffer.from(body.content, "base64").toString("utf8");
    const s = sha1(content); git.blobs.set(s, content); return json(201, { sha: s });
  }
  if (u.includes("/git/trees") && method === "POST") {
    // base_tree semantics: start from the named tree, overlay the new entries.
    const base = body.base_tree ? (git.trees.get(body.base_tree) || []) : [];
    const merged = new Map(base.map(e => [e.path, e]));
    for (const e of body.tree) merged.set(e.path, e);
    const entries = [...merged.values()];
    const s = sha1(JSON.stringify(entries)); git.trees.set(s, entries);
    return json(201, { sha: s });
  }
  if (u.includes("/git/commits") && method === "POST") {
    const s = sha1(JSON.stringify(body)); git.commits.set(s, { tree: body.tree });
    return json(201, { sha: s });
  }
  // Reading a commit back, which is how the current tree is found in order to
  // preserve files this run cannot see. Real GitHub returns the tree nested as
  // { tree: { sha } }, so the fake does too — a flatter shape here would have
  // let the code pass the test while failing in production.
  if (u.includes("/git/commits/") && method === "GET") {
    const s = u.split("/git/commits/")[1].split("?")[0];
    const c = git.commits.get(s);
    return c ? json(200, { sha: s, tree: { sha: c.tree } }) : json(404, {});
  }
  if (u.includes("/contents/")) {
    const remote = decodeURIComponent(u.split("/contents/")[1].split("?")[0]);
    const files = branchFiles();
    return remote in files ? json(200, files[remote]) : json(404, {});
  }
  return json(404, {});
};

const backup = await import("../src/backup.js");

const LEDGER = path.join(tmp, "ledger.jsonl");
const writeLedger = n => fs.writeFileSync(LEDGER,
  Array.from({ length: n }, (_, i) => JSON.stringify({ seq: i + 1, type: "conjunction" })).join("\n") + "\n");
const ledgerLines = () => {
  try { return fs.readFileSync(LEDGER, "utf8").split("\n").filter(Boolean).length; }
  catch { return 0; }
};
const remoteLedgerLines = () => {
  const f = branchFiles()["backup/ledger.jsonl"];
  return f ? f.split("\n").filter(Boolean).length : null;
};

function seedArchive(rows = 500) {
  fs.mkdirSync(tmp, { recursive: true });
  writeLedger(rows);
  fs.writeFileSync(path.join(tmp, "store.json"), JSON.stringify({ workspaces: { a: { apiKey: "oiq_secret" } } }));
  fs.writeFileSync(path.join(tmp, "auth.json"), JSON.stringify({ users: [{ email: "a@b.c", hash: "scrypt$x" }] }));
  fs.writeFileSync(path.join(tmp, "ledger-seals.json"), JSON.stringify([{ seq: rows, hash: "tiphash" }]));
  fs.writeFileSync(path.join(tmp, "ledger-anchor.json"), JSON.stringify({ tipSeq: rows }));
}

console.log("# ── archive disaster drill ────────────────────");

test("the module reads the archive the rest of the system writes", () => {
  check("backup honours ORBITIQ_DATA_DIR like every other module", () => {
    seedArchive(10);
    assert.equal(backup.dataDir(), tmp,
      "backup.js resolves its own data directory instead of honouring ORBITIQ_DATA_DIR. "
      + "Mounting a persistent disk is done by setting that variable, so the first time "
      + "anyone does the recommended thing the live archive moves and the backup keeps "
      + "saving the old, empty directory — silently, until the day it is needed");
  });
});

test("a full loss of the disk is survivable", async () => {
  resetGit();
  seedArchive(500);
  const before = fs.readFileSync(LEDGER, "utf8");

  await backup.backup();

  check("the archive reached the backup branch", () => {
    assert.equal(remoteLedgerLines(), 500, JSON.stringify(Object.keys(branchFiles())));
  });

  check("secret-bearing files went up encrypted, not in the clear", () => {
    const files = branchFiles();
    assert.ok(files["backup/store.json.enc"], "store.json was not backed up at all");
    assert.ok(!files["backup/store.json.enc"].includes("oiq_secret"),
      "a workspace API key is sitting in plaintext on a branch of a PUBLIC repository");
    assert.ok(!files["backup/auth.json.enc"].includes("scrypt$x"),
      "a password hash is in the clear on a public branch");
    assert.match(files["backup/store.json.enc"], /^v1\./, "not the sealed envelope format");
  });

  // The disaster: the container is replaced and the disk goes with it.
  fs.rmSync(tmp, { recursive: true, force: true });
  check("the disk really is gone", () => assert.equal(fs.existsSync(LEDGER), false));

  await backup.restore();

  check("the ledger came back byte for byte", () => {
    assert.equal(fs.readFileSync(LEDGER, "utf8"), before,
      "the restored ledger differs from the one that was backed up");
  });

  check("the secrets came back decrypted and usable", () => {
    const store = JSON.parse(fs.readFileSync(path.join(tmp, "store.json"), "utf8"));
    assert.equal(store.workspaces.a.apiKey, "oiq_secret",
      "the workspace store did not survive; every customer's API key is gone");
  });

  check("the seals came back — they are what makes the chain checkable", () => {
    assert.ok(fs.existsSync(path.join(tmp, "ledger-seals.json")));
  });
});

test("one unreadable file must not delete the rest of the backup", async () => {
  resetGit();
  seedArchive(500);
  await backup.backup();
  assert.equal(remoteLedgerLines(), 500);

  // A sweep where the ledger cannot be read: a partial write, a permissions
  // blip, disk pressure. Everything else is fine.
  fs.rmSync(LEDGER);
  await backup.backup();

  check("the previously backed-up ledger is still there", () => {
    assert.equal(remoteLedgerLines(), 500,
      "a single unreadable file deleted the archive from the backup branch. The tree was "
      + "built only from the files readable on that run and force-pushed with no base_tree, "
      + "so anything missing was dropped — and the ledger is the one file the entire "
      + "product consists of");
  });

  check("the other files are still there too", () => {
    const files = branchFiles();
    assert.ok(files["backup/store.json.enc"] && files["backup/ledger-seals.json"]);
  });
});

test("a boot that could not restore must never overwrite the archive", async () => {
  resetGit();
  seedArchive(500);
  await backup.backup();
  assert.equal(remoteLedgerLines(), 500);

  // GitHub was briefly unreachable at boot, so nothing was restored. The
  // service came up on an empty disk and started screening. A few rows in,
  // the sweep finishes and calls backup().
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  writeLedger(3);

  const out = await backup.backup();

  check("the three-row ledger did NOT replace the five-hundred-row archive", () => {
    assert.equal(remoteLedgerLines(), 500,
      "a transient network failure at boot destroyed the archive. This needs no exotic "
      + "conditions: restore fails, the service starts empty, the first sweep force-pushes "
      + "a nearly-empty ledger over the real one, and the record the whole product is "
      + "built on is gone with no way back");
  });

  check("it refused loudly rather than failing silently", () => {
    assert.match(String(out.lastError || ""), /shrink|shorter|refus/i,
      "the refusal must be reported; a backup that silently declines to run leaves the "
      + "operator believing they are protected when they are not");
  });

  // Awaited before the assertion, not inside check(). An earlier version put
  // the await inside, so the work escaped the test, raced the next test's
  // reset, and reported a failure that was purely an artefact of the race —
  // the most expensive kind of wrong test, because it accuses working code.
  writeLedger(700);
  await backup.backup();
  check("an append-only archive that grew is still allowed through", () => {
    assert.equal(remoteLedgerLines(), 700, "a legitimate larger archive was rejected");
  });
});

test("a backup that has stopped working does not look like one that is working", async () => {
  resetGit();
  seedArchive(500);
  await backup.backup();

  check("a healthy backup says so", () => {
    const s = backup.status();
    assert.equal(s.health, "ok", JSON.stringify(s));
    assert.ok(s.lastBackupAgeMinutes !== null);
  });

  // The refusal path is the one most likely to be mistaken for normal
  // operation: nothing errors, nothing crashes, and the archive silently
  // stops being persisted. Awaited out here rather than inside check(),
  // which is synchronous — a promise handed to it would be counted as a
  // pass before it had settled.
  writeLedger(3);
  await backup.backup();

  check("a refusal is a named state, not just a log line", () => {
    const s = backup.status();
    assert.equal(s.health, "refusing",
      "a backup that is declining to run reported itself as healthy; the operator would "
      + "believe the archive was protected while it quietly diverged");
    assert.match(s.means, /diverged|someone must look/i);
  });

  check("every health state explains itself in words an operator can act on", () => {
    const s = backup.status();
    assert.ok(s.means && s.means.length > 40, "health state has no explanation");
  });

  console.log("# ──────────────────────────────────────────────");
  console.log(`#   ${passed} passed, ${failed} failed`);
  assert.equal(failed, 0);
});
