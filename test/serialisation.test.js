// ============================================================
// The row must survive its own round trip.
//
// ── The incident these tests are written from ───────────────
// On 7 September 2026 the public archive began reporting "chain broken — row
// altered". Nothing had been deployed for two days and nothing had been
// edited. What happened was that two serialisers disagreed about a missing
// value:
//
//   canonical()      walks Object.keys(), which INCLUDES keys whose value is
//                    undefined, and JSON.stringify(undefined) returns the JS
//                    value undefined, which string concatenation renders as
//                    the literal text "undefined".
//
//   JSON.stringify() writing the row to disk, DROPS those keys entirely.
//
// So a row carrying `pc: undefined` was hashed over a body containing
// "pc":undefined and then stored as a body containing no pc at all. The body
// that produced the hash did not exist in the file and never would again, so
// that row could never verify — not because anyone touched it, but because it
// was born unverifiable.
//
// A cold instance ran a sweep before its catalogue had loaded, augmentation
// left six fields undefined, and 600 conjunction rows were written that way.
// From the first of them the entire archive read as broken, and seal() — which
// refused to seal a broken chain — stopped publishing external checkpoints for
// 25 hours.
//
// The tests below fix the invariant that was never stated anywhere: the hash
// stored beside a row is the hash of the row a reader will parse back out.
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "orbitiq-ser-"));
process.env.ORBITIQ_DATA_DIR = tmp;

const ledger = await import("../src/ledger.js");

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log(`#   ok    ${name}`); }
  catch (e) { failed++; console.log(`#   FAIL  ${name}\n#         ${e.message}`); throw e; }
}

const LEDGER = path.join(tmp, "ledger.jsonl");
const SEALS = path.join(tmp, "ledger-seals.json");
const ANCHOR = path.join(tmp, "ledger-anchor.json");
const rows = () => fs.readFileSync(LEDGER, "utf8").split("\n").filter(Boolean).map(JSON.parse);
const writeRows = rs => fs.writeFileSync(LEDGER, rs.map(r => JSON.stringify(r)).join("\n") + "\n");
function fresh() {
  for (const f of [LEDGER, ANCHOR, SEALS]) { try { fs.rmSync(f); } catch {} }
  ledger.reload();
}

console.log("# ── the row must survive its own round trip ───");

test("the exact production failure: an undefined field", () => {
  fresh();
  // Precisely the shape the sweep wrote: a conjunction row whose augmentation
  // fields were never populated because the catalogue had not loaded.
  ledger.append("conjunction", [{
    org: null, aName: "JILIN-1 GAOFEN 03D50", bName: "STARLINK-33762",
    missKm: 0.192, risk: "CRITICAL",
    pc: undefined, pcText: undefined,
    sigmaMajorKm: undefined, sigmaMinorKm: undefined,
    ageDaysA: undefined, ageDaysB: undefined
  }]);

  check("the archive still verifies after a reload from disk", () => {
    ledger.reload();                       // force a read back through the file
    const v = ledger.verify();
    assert.equal(v.ok, true,
      "a row with undefined fields was hashed over a body that JSON.stringify "
      + "then refused to write. The hash covered {\"pc\":undefined,...} and the file "
      + "got {...}, so the row could never verify again. This is the bug that took "
      + "the public archive down for 25 hours: " + JSON.stringify(v).slice(0, 300));
    assert.equal(v.unverifiableRows, 0);
  });

  check("the undefined keys are simply absent, not stored as junk", () => {
    const r = rows()[0];
    for (const k of ["pc", "pcText", "sigmaMajorKm", "sigmaMinorKm", "ageDaysA", "ageDaysB"]) {
      assert.ok(!(k in r), `${k} should be dropped, not persisted as a null or a string`);
    }
    assert.equal(r.missKm, 0.192, "the fields that DID have values must be untouched");
  });
});

test("anything JSON cannot carry is resolved before the hash, not after", () => {
  for (const [name, payload] of [
    ["NaN",           { v: NaN }],
    ["Infinity",      { v: Infinity }],
    ["-Infinity",     { v: -Infinity }],
    ["a Date",        { v: new Date("2026-09-07T15:00:47.552Z") }],
    ["nested undefined", { outer: { inner: undefined, kept: 1 } }],
    ["undefined in an array", { arr: [1, undefined, 3] }],
    ["a function",    { v: 1, fn: function () { return 1; } }]
  ]) {
    check(`${name} survives a reload`, () => {
      fresh();
      ledger.append("conjunction", [payload]);
      ledger.reload();
      const v = ledger.verify();
      assert.equal(v.ok, true,
        `a row containing ${name} was hashed over something the file cannot hold, so it `
        + `verified in memory and failed forever afterwards. Fixing only the undefined case `
        + `would have left this whole class open: ` + JSON.stringify(v).slice(0, 200));
    });
  }
});

test("canonical() agrees with JSON.stringify about missing values", () => {
  check("undefined keys are omitted from the canonical form", () => {
    assert.equal(ledger.canonical({ a: 1, b: undefined }), '{"a":1}',
      "canonical() emitted an undefined-valued key. JSON.stringify drops it, so the "
      + "hash would cover a body the file can never contain");
  });

  check("undefined inside an array becomes null, as JSON.stringify does", () => {
    assert.equal(ledger.canonical({ a: [1, undefined, 3] }), '{"a":[1,null,3]}');
  });

  check("no historical hash is disturbed", () => {
    // Rows read back from disk have already been through JSON.stringify, so
    // they never carry undefined and this change cannot reach them.
    const body = { t: "2026-09-07T15:00:47.552Z", type: "conjunction", missKm: 0.192 };
    assert.equal(ledger.hashRow(35428, "abc", body), ledger.hashRow(35428, "abc", { ...body }));
    assert.equal(ledger.canonical(body), '{"missKm":0.192,"t":"2026-09-07T15:00:47.552Z","type":"conjunction"}');
  });
});

test("a real alteration is still caught", () => {
  // The whole point of the fix is to stop FALSE alarms. It must not stop true
  // ones: an edited row has to fail exactly as loudly as it did before.
  fresh();
  ledger.append("conjunction", Array.from({ length: 20 }, (_, i) => ({ org: "acme", n: i })));

  check("editing a row's body is reported", () => {
    const all = rows();
    all[10].n = 999;
    writeRows(all);
    ledger.reload();
    const v = ledger.verify();
    assert.equal(v.ok, false, "an edited row passed verification");
    assert.equal(v.unverifiableRows, 1);
    assert.equal(v.firstUnverifiableSeq, 11);
  });

  check("it does not claim to know why", () => {
    const v = ledger.verify();
    assert.match(v.means, /consistent with an edit AND with a fault/i,
      "the verdict asserts a cause. A content mismatch cannot distinguish an edit from a "
      + "write-path fault, and an evidence system that guesses in its own favour is worth "
      + "nothing at exactly the moment it is being relied on");
  });
});

console.log("# ──────────────────────────────────────────────");

test("verification describes the whole archive, not the first bad row", () => {
  fresh();
  ledger.append("conjunction", Array.from({ length: 60 }, (_, i) => ({ org: "acme", n: i })));

  // Damage a contiguous band, exactly as the incident did.
  const all = rows();
  for (let i = 20; i < 26; i++) all[i].n = 10000 + i;
  writeRows(all);
  ledger.reload();
  const v = ledger.verify();

  check("every damaged row is counted, not just the first", () => {
    assert.equal(v.unverifiableRows, 6,
      "verification stopped at the first bad row, so six bad rows and six hundred were "
      + "indistinguishable from the outside");
  });

  check("the damage is reported as a range a reader can act on", () => {
    assert.equal(v.unverifiableRanges.length, 1);
    assert.deepEqual(
      { from: v.unverifiableRanges[0].fromSeq, to: v.unverifiableRanges[0].toSeq },
      { from: 21, to: 26 });
  });

  check("the rows that are still good are still counted as good", () => {
    assert.equal(v.verified, 54, "54 of the 60 rows verify and the reader must be told so");
  });

  check("linkage is reported separately from content", () => {
    assert.equal(v.linkageIntact, true,
      "nothing was removed or reordered, and that is a different and weaker failure than a "
      + "content mismatch; collapsing them denies the reader the distinction that matters");
  });

  check("the tip is reported even on failure", () => {
    assert.equal(v.tipSeq, 60);
    assert.ok(v.tipHash, "the tip hash was withheld on failure, leaving the interface showing "
      + "'Break at #?' — losing its nerve exactly when it had the most to explain");
  });

  console.log("# ──────────────────────────────────────────────");
  console.log(`#   ${passed} passed, ${failed} failed`);
  assert.equal(failed, 0);
});
