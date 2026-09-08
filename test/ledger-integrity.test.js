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
    // The verdict used to be "row altered" and stopped at the first bad row, so
    // `verified` meant "rows before the break". It now walks the whole archive
    // and names every mismatch, because six bad rows and six hundred used to be
    // indistinguishable from outside. The claim is unchanged and the reporting
    // is stricter: still caught, still at row 2, and now with a count.
    assert.equal(v.reason, "content hash mismatch");
    assert.equal(v.firstUnverifiableSeq, 2, "pointed at the wrong row");
    assert.equal(v.unverifiableRows, 1, "exactly one row was edited");
    assert.equal(v.verified, 3, "the other three rows are untouched and must still count as verified");
    assert.equal(v.linkageIntact, true, "an edit does not disturb the ordering, and saying so is the "
      + "difference between 'one row's contents are in question' and 'the archive was restructured'");
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

  check("seal() refuses when the ORDER of the archive is in question", () => {
    // Linkage is the one failure that makes sealing meaningless: if rows have
    // been removed or reordered then "the tip" is not reliably the tip, and a
    // checkpoint over it would assert something untrue.
    const rows = pristine.filter(r => r.seq !== 3);
    writeRows(rows);
    const s = sealFresh();
    assert.equal(s.ok, false, "sealed a chain whose linkage is broken");
    assert.match(s.error, /linkage/i);
    writeRows(pristine);
  });

  check("seal() still checkpoints when only a row's CONTENT is in question", () => {
    // Deliberate change of behaviour, and the reasoning matters.
    //
    // This used to refuse on any verification failure. In production that meant
    // 600 unreconstructible rows stopped sealing entirely for 25 hours, while
    // thousands of new and perfectly good rows piled up with nothing outside
    // the service vouching for them.
    //
    // That helps an attacker rather than hindering one. A body edit does not
    // change the tip hash, so the seal is unaffected by it; and the determined
    // attack — rewriting a row AND every hash after it — is caught by the seal
    // cross-check, which still refuses. What refusing to seal actually achieves
    // is freezing external attestation on everything appended afterwards.
    //
    // So the seal proceeds, and carries the count of what it cannot vouch for.
    const rows = pristine.map(r => ({ ...r }));
    rows[2].index = 0.1;
    writeRows(rows);
    // Clear the seal file so a genuinely NEW seal is taken. seal() returns the
    // existing one untouched when the tip has not advanced, which is correct
    // and also means the old seal would be handed back with none of the new
    // fields on it.
    fs.rmSync(path.join(tmp, "ledger-seals.json"), { force: true });
    const s = sealFresh();
    assert.equal(s.ok, true, "a content mismatch stopped external attestation of every later row");
    assert.equal(s.seal.unverifiableRows, 1,
      "the seal must record that it was taken over an archive with known unverifiable rows, "
      + "or a reader of the seal file alone would take it for a clean bill of health");
    assert.equal(s.seal.seq, 4, "the seal still records the real tip");
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
