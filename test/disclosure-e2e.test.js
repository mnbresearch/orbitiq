// ============================================================
// The disclosure loop, end to end, against a real archive on disk.
//
// disclosure.test.js checks the judgement against hand-built inputs. This
// checks the whole circuit with the REAL ledger: damage an archive the way the
// serialisation defect damaged production, let the real writer observe it and
// append the real record, then ask the real checker whether the record fits.
//
// It exists because every piece of that chain can be individually correct while
// the assembly is wrong — a writer that records the range it INTENDED rather
// than the one that is failing, or a record that itself fails to verify, would
// pass every unit test in the suite and be worthless in production.
//
// This is the acceptance criterion the bug report asked for, run for real: a
// clean chain, a deliberately damaged one, and truthful reporting of both.
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "orbitiq-disclosure-"));
process.env.ORBITIQ_DATA_DIR = tmp;
const L = await import("../src/ledger.js");
const { recordSerialisationErratum, assessDisclosure, SERIALISATION_DEFECT }
  = await import("../src/disclosure.js");

const FILE = path.join(tmp, "ledger.jsonl");
const readRows  = () => fs.readFileSync(FILE, "utf8").split("\n").filter(Boolean).map(JSON.parse);
const writeRows = rows => fs.writeFileSync(FILE, rows.map(r => JSON.stringify(r)).join("\n") + "\n");
const errata = () => L.query({ type: "erratum", limit: 200 }).events || [];
const assess = () => { L.reload(); const v = L.verify(); return { v, d: assessDisclosure(v, errata()) }; };

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log(`#   ok    ${name}`); }
  catch (e) { failed++; console.log(`#   FAIL  ${name}\n#         ${e.message}`); throw e; }
}

console.log("# ── disclosure end-to-end ─────────────────────");

test("the full disclosure circuit against a real archive", () => {
  // 30 ordinary rows.
  for (let i = 0; i < 10; i++) {
    L.append("conjunction", [
      { org: "acme", aName: "SAT-" + i, bName: "DEB-" + i, missKm: 1 + i, pc: 1e-5 },
      { org: "acme", aName: "SAT-" + i, bName: "DEB-" + (i + 50), missKm: 2 + i, pc: 1e-6 }
    ]);
    L.append("risk", [{ org: "acme", index: 40 + i, grade: "B" }]);
  }

  check("a clean chain verifies and needs no record", () => {
    const { v, d } = assess();
    assert.equal(v.ok, true, JSON.stringify(v));
    assert.equal(d.present, false);
    assert.match(d.note, /no record needed/);
  });

  check("the writer declines to invent a fault on a clean archive", () => {
    // The most important negative case for the writer. A record that appears
    // on an archive with nothing wrong with it is a false confession, and it
    // would poison every later comparison by fixing a range out of thin air.
    assert.equal(recordSerialisationErratum(L, quiet), false);
    assert.equal(errata().length, 0, "wrote an erratum for a fault that does not exist");
  });

  // ── damage the archive the way the defect did ───────────
  // Not "edit a value": the production rows were never consistent with their
  // own hash, because the hash covered keys the serialiser dropped. Editing a
  // stored body reproduces the same OBSERVABLE state — a body that does not
  // hash to its stored h, with prev linkage untouched — which is what the
  // disclosure logic reads.
  //
  // Deliberately NOT a solid block. A contiguous run leaves no undamaged row
  // inside the window, which makes "damage grew within the documented range"
  // impossible to stage — and an untestable failure mode is one nobody has
  // checked. verify() reports ranges rather than a run for the same reason.
  // Damaging seq 11 and 16 gives a documented window of 11-16 holding only two
  // failures, with room in the middle for a later, undisclosed one.
  const pristine = readRows();
  const damaged = pristine.map(r => ({ ...r }));
  for (const i of [10, 15]) damaged[i].missKm = damaged[i].missKm + 0.001;
  writeRows(damaged);

  check("the damage reads as content-only, with order intact", () => {
    const { v } = assess();
    assert.equal(v.ok, false);
    assert.equal(v.linkageIntact, true, "an edit must not be reported as a restructuring");
    assert.equal(v.unverifiableRows, 2);
    assert.equal(v.firstUnverifiableSeq, 11);
    assert.equal(v.lastUnverifiableSeq, 16);
  });

  check("before any record is written, the state is undocumented", () => {
    const { d } = assess();
    assert.equal(d.present, false);
    assert.equal(d.accountsForObserved, false);
    assert.match(d.note, /undocumented/i);
  });

  check("the writer records the observed range, not an assumed one", () => {
    assert.equal(recordSerialisationErratum(L, quiet), true);
    const e = errata().find(x => x.correctsDefect === SERIALISATION_DEFECT);
    assert.ok(e, "no record was appended");
    assert.equal(e.coversSeqFrom, 11);
    assert.equal(e.coversSeqTo, 16);
    assert.equal(e.rowsAtRecord, 2);
    assert.equal(e.linkageIntactAtRecord, true);
  });

  check("the record itself verifies — it is not born unverifiable too", () => {
    // The defect being disclosed was a row that could never verify. A record
    // written by the same code path, failing the same way, would be a fitting
    // joke and a real problem: the one row a reader most needs to trust.
    const { v } = assess();
    assert.equal(v.unverifiableRows, 2, "the erratum row itself failed to verify");
    assert.equal(v.lastUnverifiableSeq, 16, "the erratum row appeared among the unverifiable");
  });

  check("the record now accounts for the observed state", () => {
    const { d } = assess();
    assert.equal(d.present, true);
    assert.equal(d.accountsForObserved, true, JSON.stringify(d));
    assert.ok(d.seq > 16, "the record must sit after the rows it describes");
  });

  check("writing twice does not append a second record", () => {
    assert.equal(recordSerialisationErratum(L, quiet), false);
    assert.equal(errata().filter(e => e.correctsDefect === SERIALISATION_DEFECT).length, 1);
  });

  // ── the case this whole module exists for ───────────────

  check("NEW damage outside the range is not laundered by the record", () => {
    // A row well below the documented window starts failing. Nothing about the
    // published record covers it, and the archive must say so even though a
    // perfectly genuine disclosure is sitting right there.
    const rows = readRows();
    rows[2].missKm = 99.9;
    writeRows(rows);
    const { v, d } = assess();
    assert.equal(v.unverifiableRows, 3);
    assert.equal(v.firstUnverifiableSeq, 3, "expected the new damage at seq 3");
    assert.equal(d.present, true, "the record still exists and should be shown");
    assert.equal(d.accountsForObserved, false,
      "an old, honest disclosure was stretched to cover unrelated new damage");
    assert.match(d.note, /OUTSIDE/);
  });

  check("and it recovers truthfully once the new damage is gone", () => {
    // Not a formality. A check that latches to "bad" is as useless as one that
    // latches to "fine" — it would stop distinguishing the two states, which
    // is the entire job.
    const rows = readRows();
    rows[2] = { ...rows[2], missKm: pristine[2].missKm };
    writeRows(rows);
    const { v, d } = assess();
    assert.equal(v.unverifiableRows, 2);
    assert.equal(d.accountsForObserved, true, JSON.stringify(d));
  });

  check("MORE damage inside the range is not laundered either", () => {
    const rows = readRows();
    rows[12].missKm = 77.7;   // seq 13: already inside 11-16, but was verifying
    writeRows(rows);
    const { v, d } = assess();
    assert.equal(v.firstUnverifiableSeq, 11, "still inside the documented window");
    assert.equal(v.lastUnverifiableSeq, 16);
    assert.equal(d.accountsForObserved, false,
      "containment alone accepted a growth in damage inside the window");
    assert.match(d.note, /More rows/);
  });

  check("a broken ORDER is never reported as this known defect", () => {
    // Removing a row is a different and more serious failure. Attributing it to
    // the documented serialisation defect would be the single most misleading
    // thing this code could do, so linkage failure must bypass the record
    // entirely rather than being absorbed by it.
    const rows = readRows().filter(r => r.seq !== 5);
    writeRows(rows);
    const { v, d } = assess();
    assert.equal(v.linkageIntact, false);
    assert.equal(d.accountsForObserved, false, "a removed row was covered by a content erratum");
  });

  check("the writer refuses to record while the order is in question", () => {
    // Same reasoning from the writing side: with linkage broken, whatever range
    // it could compute would be misattribution committed permanently to the
    // chain.
    const before = errata().length;
    assert.equal(recordSerialisationErratum(L, quiet), false);
    assert.equal(errata().length, before);
  });

  console.log("# ──────────────────────────────────────────────");
  console.log(`#   ${passed} passed, ${failed} failed`);
  assert.equal(failed, 0);
});

// Keeps the writer's own logging out of the TAP stream.
const quiet = { log() {}, error() {} };
