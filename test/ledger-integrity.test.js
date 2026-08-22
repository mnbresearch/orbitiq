// ============================================================
// Archive integrity.
//
// The product claim is that this archive is evidence: that you can hand a
// range of it to an insurer or a counterparty and they can check nobody edited
// it after the fact. A claim like that is worth exactly as much as the tests
// behind it, so these tests do not merely append rows and assert "ok". They
// tamper — edit a value, delete a row, reorder, re-hash a forgery — and assert
// that verify() catches it AND points at the right seam.
//
// A test that only ever checks the happy path would pass just as happily
// against a verify() that returned {ok:true} unconditionally.
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "orbitiq-ledger-"));
process.env.ORBITIQ_DATA_DIR = tmp;
const L = await import("../src/ledger.js");

const FILE = path.join(tmp, "ledger.jsonl");
const readRows = () => fs.readFileSync(FILE, "utf8").split("\n").filter(Boolean).map(JSON.parse);
const writeRows = rows => fs.writeFileSync(FILE, rows.map(r => JSON.stringify(r)).join("\n") + "\n");

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log(`#   ok    ${name}`); }
  catch (e) { failed++; console.log(`#   FAIL  ${name}\n#         ${e.message}`); throw e; }
}

console.log("# ── archive integrity ─────────────────────────");

test("hash chain detects tampering", () => {
  L.append("conjunction", [
    { org: "acme", aName: "SAT-1", bName: "DEB-9", missKm: 1.2, pc: 3e-4 },
    { org: "acme", aName: "SAT-2", bName: "DEB-3", missKm: 4.8, pc: 1e-6 }
  ]);
  L.append("risk", [{ org: "acme", index: 41.2, grade: "B" }]);
  L.append("maneuver", [{ org: "acme", id: 1, name: "SAT-1", dAltKm: 0.4 }]);

  check("a clean chain verifies", () => {
    const v = L.verify();
    assert.equal(v.ok, true, JSON.stringify(v));
    assert.equal(v.verified, 4);
    assert.equal(v.unchained, 0);
  });

  check("sequence numbers are dense and start at 1", () => {
    const rows = readRows();
    assert.deepEqual(rows.map(r => r.seq), [1, 2, 3, 4]);
  });

  check("each row links to the one before it", () => {
    const rows = readRows();
    for (let i = 1; i < rows.length; i++) assert.equal(rows[i].prev, rows[i - 1].h);
  });

  check("a seal records the tip", () => {
    const s = L.seal();
    assert.equal(s.ok, true, JSON.stringify(s));
    assert.equal(s.seal.seq, 4);
    assert.equal(s.seal.hash, readRows()[3].h);
  });

  check("sealing twice with no new rows does not duplicate", () => {
    const s = L.seal();
    assert.equal(s.unchanged, true);
    assert.equal(L.seals().length, 1);
  });

  // ── now break it, four different ways ──────────────────────

  const pristine = readRows();

  check("editing a value is caught, and at the right row", () => {
    const rows = pristine.map(r => ({ ...r }));
    rows[1].missKm = 99.9;                 // a lie that favours the operator
    writeRows(rows);
    const v = verifyFresh();
    assert.equal(v.ok, false, "an edited miss distance verified clean");
    assert.equal(v.reason, "row altered");
    assert.equal(v.seq, 2, "pointed at the wrong row");
    assert.equal(v.verified, 1, "should have verified exactly the rows before the edit");
  });

  check("deleting a row is caught", () => {
    const rows = pristine.filter(r => r.seq !== 3);
    writeRows(rows);
    const v = verifyFresh();
    assert.equal(v.ok, false, "a deleted row verified clean");
    assert.equal(v.reason, "sequence gap");
    assert.equal(v.expectedSeq, 3);
    assert.equal(v.foundSeq, 4);
  });

  check("reordering rows is caught", () => {
    const rows = [pristine[0], pristine[2], pristine[1], pristine[3]].map(r => ({ ...r }));
    writeRows(rows);
    const v = verifyFresh();
    assert.equal(v.ok, false, "reordered rows verified clean");
  });

  check("a forged row with a recomputed hash still breaks the chain", () => {
    // The interesting attack: someone who understands the scheme edits a row
    // AND recomputes its hash. The row itself now self-verifies — but every
    // later row's `prev` still points at the ORIGINAL hash, so the seam moves
    // one row later instead of disappearing.
    const rows = pristine.map(r => ({ ...r }));
    rows[1].missKm = 0.05;
    const { seq, prev, h, ...body } = rows[1];
    const canonical = o => o === null || typeof o !== "object" ? JSON.stringify(o)
      : Array.isArray(o) ? "[" + o.map(canonical).join(",") + "]"
      : "{" + Object.keys(o).sort().map(k => JSON.stringify(k) + ":" + canonical(o[k])).join(",") + "}";
    rows[1].h = crypto.createHash("sha256")
      .update(String(seq) + "|" + prev + "|" + canonical(body)).digest("hex").slice(0, 32);
    writeRows(rows);
    const v = verifyFresh();
    assert.equal(v.ok, false, "a re-hashed forgery went undetected");
    assert.equal(v.reason, "broken link", "expected the break to surface at the NEXT row");
    assert.equal(v.seq, 3);
  });

  check("restoring the original file verifies again", () => {
    writeRows(pristine);
    const v = verifyFresh();
    assert.equal(v.ok, true, JSON.stringify(v));
    assert.equal(v.verified, 4);
  });

  check("the published seal still matches the restored tip", () => {
    const s = L.seals()[0];
    assert.equal(s.hash, readRows()[3].h,
      "a seal that no longer matches the tip means history moved under it");
  });

  check("seal() refuses to certify a broken chain", () => {
    const rows = pristine.map(r => ({ ...r }));
    rows[2].index = 0.1;
    writeRows(rows);
    const s = sealFresh();
    assert.equal(s.ok, false, "sealed a chain that does not verify");
    writeRows(pristine);
  });

  console.log("# ──────────────────────────────────────────────");
  console.log(`#   ${passed} passed, ${failed} failed`);
  assert.equal(failed, 0);
});

// The module mirrors rows in memory, so tampering on disk is only visible
// after a reload. These call the REAL verify()/seal() — deliberately not a
// re-implementation, which would only prove my copy agrees with my copy.
function verifyFresh() { L.reload(); return L.verify(); }
function sealFresh()   { L.reload(); return L.seal(); }
