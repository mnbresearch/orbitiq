// ============================================================
// A published erratum must not become cover for the next failure.
//
// The archive holds a dated record admitting that 600 rows, at a named range of
// sequence numbers, cannot be content-verified. That record is the right thing
// to have written. It is also, from the moment it exists, the most convenient
// place in the entire system to hide a second problem: any new damage that
// happens to land in the same neighbourhood gets read as "oh, that's the known
// issue" — by a customer, by an underwriter, and most easily of all by us.
//
// So the tests that matter here are not "does the disclosure render". They are
// the ones that damage the archive in ways the record does NOT describe, and
// assert that the public surface refuses to call it documented.
//
// Every one of these fails loudly if assessDisclosure() is ever simplified to
// "an erratum exists, therefore this is known about".
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { assessDisclosure, SERIALISATION_DEFECT } from "../src/disclosure.js";

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log(`#   ok    ${name}`); }
  catch (e) { failed++; console.log(`#   FAIL  ${name}\n#         ${e.message}`); throw e; }
}

// The record as production actually holds it.
const RECORD = {
  t: "2026-09-09T10:00:00.000Z",
  seq: 39572,
  type: "erratum",
  correctsDefect: SERIALISATION_DEFECT,
  coversSeqFrom: 35428,
  coversSeqTo: 36147,
  rowsAtRecord: 600
};

// verify() as it reads today: the exact condition the record describes.
const AS_DISCLOSED = {
  ok: false,
  linkageIntact: true,
  unverifiableRows: 600,
  firstUnverifiableSeq: 35428,
  lastUnverifiableSeq: 36147
};

console.log("# ── disclosure: does the record still fit? ────");

test("a record only covers what it actually described", () => {

  check("the disclosed condition reads as accounted for", () => {
    const d = assessDisclosure(AS_DISCLOSED, [RECORD]);
    assert.equal(d.present, true);
    assert.equal(d.accountsForObserved, true, JSON.stringify(d));
    assert.equal(d.coversSeqFrom, 35428);
    assert.equal(d.rowsAtRecord, 600);
  });

  // ── the laundering attempts ──────────────────────────────
  //
  // Each of these is a real archive state that a lazy implementation would
  // wave through, and each is a different way of being wrong.

  check("damage BELOW the documented range is not covered", () => {
    // A row at #12000 now fails. It has nothing to do with the serialisation
    // defect, and the range in the record says so plainly.
    const d = assessDisclosure(
      { ...AS_DISCLOSED, unverifiableRows: 600, firstUnverifiableSeq: 12000 }, [RECORD]);
    assert.equal(d.accountsForObserved, false, "an old record absorbed damage outside its range");
    assert.match(d.note, /OUTSIDE/);
    assert.match(d.note, /undocumented/i);
  });

  check("damage ABOVE the documented range is not covered", () => {
    // The subtler direction: rows appended AFTER the fix, failing now. Those
    // cannot be the known defect — the write path verifies its own output.
    const d = assessDisclosure(
      { ...AS_DISCLOSED, lastUnverifiableSeq: 41000 }, [RECORD]);
    assert.equal(d.accountsForObserved, false, "rows written after the fix were treated as known");
    assert.match(d.note, /OUTSIDE/);
  });

  check("MORE rows failing inside the same range is not covered", () => {
    // Containment alone would pass this. The affected rows are frozen and the
    // defect is fixed, so their number cannot grow on its own: a larger count
    // in the same window is a new event wearing the old event's clothes.
    const d = assessDisclosure({ ...AS_DISCLOSED, unverifiableRows: 640 }, [RECORD]);
    assert.equal(d.accountsForObserved, false,
      "growth within the documented range was absorbed by the record");
    assert.match(d.note, /More rows/);
    assert.match(d.note, /640/);
    assert.match(d.note, /600/);
  });

  check("fewer rows failing IS covered — a record may overstate its own fault", () => {
    // Asymmetric on purpose. "We admitted to 600 and 590 are failing" is not a
    // discrepancy that should alarm anyone; only growth is evidence of a new
    // event. Being strict in the harmless direction would train readers to
    // ignore the field, which costs more than it buys.
    const d = assessDisclosure({ ...AS_DISCLOSED, unverifiableRows: 590 }, [RECORD]);
    assert.equal(d.accountsForObserved, true, JSON.stringify(d));
  });

  check("a record for a DIFFERENT defect does not count", () => {
    // The archive already holds a cov-v1 erratum about understated Pc. It is a
    // real, dated correction — and it says nothing whatsoever about hashes.
    const covv1 = { t: "2026-08-01T00:00:00Z", seq: 900, correctsModel: "cov-v1",
                    direction: "understated" };
    const d = assessDisclosure(AS_DISCLOSED, [covv1]);
    assert.equal(d.present, false, "an unrelated erratum was accepted as covering this");
    assert.equal(d.accountsForObserved, false);
  });

  check("no errata at all reads as undocumented, not as fine", () => {
    const d = assessDisclosure(AS_DISCLOSED, []);
    assert.equal(d.present, false);
    assert.equal(d.accountsForObserved, false);
    assert.match(d.note, /undocumented/i);
  });

  check("a ledger read failure cannot produce a reassuring answer", () => {
    // server.js passes [] when the query throws. The point is that the failure
    // mode of "we could not check" is indistinguishable from "no record", and
    // both are correctly NOT accountsForObserved.
    for (const bad of [null, undefined, "not an array", {}]) {
      const d = assessDisclosure(AS_DISCLOSED, bad);
      assert.equal(d.accountsForObserved, false, "reassured on input " + JSON.stringify(bad));
    }
  });

  check("a malformed record with no range covers nothing", () => {
    // A record that names a defect but no sequence range makes no checkable
    // claim, so it must not be treated as though it made one.
    const vague = { ...RECORD, coversSeqFrom: null, coversSeqTo: null };
    const d = assessDisclosure(AS_DISCLOSED, [vague]);
    assert.equal(d.present, true, "the record does exist and should be shown");
    assert.equal(d.accountsForObserved, false, "an unfalsifiable record was treated as covering");
  });

  // ── the absent-field trap ────────────────────────────────
  //
  // Both of these were live defects, and neither was caught here. They were
  // caught by disclosure-e2e.test.js, because every input in THIS file was
  // hand-built with unverifiableRows present, and the real verify() does not
  // always populate it. Written down as unit cases now so the regression is
  // cheap to catch, and left with the story attached: a field that is
  // sometimes absent gets read as its default by code that never considered
  // absence, and defaults are chosen to look calm.

  check("a broken ORDER is never absorbed by a content record", () => {
    // verify() returns early on a linkage break and never sets
    // unverifiableRows. Read as zero, that made a DELETED ROW report as
    // accountsForObserved:true — the most misleading output this function
    // could produce.
    const d = assessDisclosure(
      { ok: false, linkageIntact: false, reason: "sequence gap", seq: 5 }, [RECORD]);
    assert.equal(d.accountsForObserved, false, "a linkage break was covered by a content record");
    assert.match(d.note, /ORDER/);
  });

  check("an unrelated failure with no content mismatches is not covered", () => {
    // ok:false with nothing failing content verification — a published seal
    // disagreeing with the chain. Zero unverifiable rows is true and beside
    // the point.
    const d = assessDisclosure(
      { ok: false, linkageIntact: true, unverifiableRows: 0, reason: "seal mismatch" },
      [RECORD]);
    assert.equal(d.accountsForObserved, false, "an unrelated failure read as accounted for");
    assert.match(d.note, /seal mismatch/);
  });

  check("a clean archive is reported as clean, not as covered-up", () => {
    const d = assessDisclosure(
      { ok: true, linkageIntact: true, unverifiableRows: 0,
        firstUnverifiableSeq: null, lastUnverifiableSeq: null }, [RECORD]);
    assert.equal(d.accountsForObserved, true);
    assert.match(d.note, /no longer produces failures/);
  });

  check("no unverifiable rows and no record is not an error state", () => {
    const d = assessDisclosure({ ok: true, unverifiableRows: 0 }, []);
    assert.equal(d.present, false);
    assert.match(d.note, /no record needed/);
  });

  // ── the field a reader is meant to act on ────────────────

  check("accountsForObserved is always a boolean, never undefined", () => {
    // A missing field renders as neither true nor false in the UI, and the
    // landing page's `=== true` check would quietly show the alarming state for
    // an archive that is fine — or, with a looser check, the reassuring one for
    // an archive that is not. Pin it.
    for (const v of [AS_DISCLOSED, { unverifiableRows: 0 }, {}, { unverifiableRows: 5 }]) {
      for (const es of [[RECORD], [], null]) {
        const d = assessDisclosure(v, es);
        assert.equal(typeof d.accountsForObserved, "boolean",
          "not boolean for " + JSON.stringify({ v, es }));
        assert.equal(typeof d.note, "string");
        assert.ok(d.note.length > 0, "an empty note renders as a blank banner");
      }
    }
  });

  console.log("# ──────────────────────────────────────────────");
  console.log(`#   ${passed} passed, ${failed} failed`);
  assert.equal(failed, 0);
});
