// ============================================================
// The external witness check.
//
// verify() walks a chain we hold and cross-checks a seal file we also hold.
// Both fall to the same adversary: whoever can rewrite the archive can rewrite
// the seals in the same motion. This check compares the archive against a log
// written by a process outside the service, so it is the one statement the
// operator of the service cannot simply arrange to be true.
//
// The tests below care about three things in particular, all of them about
// what the check says when it CANNOT prove anything — because an evidence
// system that overstates its silence is worse than one that stays quiet.
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "orbitiq-witness-"));
process.env.ORBITIQ_DATA_DIR = tmp;

const ledger = await import("../src/ledger.js");
const witness = await import("../src/witness.js");

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log(`#   ok    ${name}`); }
  catch (e) { failed++; console.log(`#   FAIL  ${name}\n#         ${e.message}`); throw e; }
}

ledger.append("conjunction", Array.from({ length: 25 }, (_, i) => ({ org: "acme", n: i })));
const rows = ledger.allEvents();
const rowsBySeq = new Map(rows.map(r => [r.seq, r]));
const obs = (seq, hash, extra = {}) => ({
  observed: "2026-09-01T12:00:00Z", http: "200",
  tipSeq: seq, tipHash: hash, runId: "123",
  runUrl: "https://github.com/mnbresearch/orbitiq/actions/runs/123", ...extra
});

console.log("# ── external witness ──────────────────────────");

test("agreement is reported as agreement, and nothing more", () => {
  const c = witness.compare([obs(10, rowsBySeq.get(10).h), obs(20, rowsBySeq.get(20).h)], rowsBySeq);
  const v = witness.verdict(c);

  check("matching observations pass", () => {
    assert.equal(v.ok, true, JSON.stringify(c));
    assert.equal(c.matched, 2);
    assert.equal(c.checkable, 2);
  });

  check("the wording credits the external observer, not us", () => {
    assert.match(v.means, /outside this service|stranger/i,
      "the value of this check is entirely that somebody else made the observation; "
      + "wording that reads like a self-attestation throws that away");
  });
});

test("a contradiction is stated plainly and cites the run that observed it", () => {
  const c = witness.compare([obs(10, "deadbeefdeadbeefdeadbeefdeadbeef")], rowsBySeq);
  const v = witness.verdict(c);

  check("it fails", () => {
    assert.equal(v.ok, false);
    assert.equal(c.mismatches.length, 1);
  });

  check("the mismatch names both hashes and the Actions run", () => {
    const m = c.mismatches[0];
    assert.equal(m.tipSeq, 10);
    assert.ok(m.witnessedHash && m.archiveHash && m.witnessedHash !== m.archiveHash);
    assert.match(m.runUrl, /actions\/runs/,
      "without the run reference a reader cannot go and check the observation for "
      + "themselves, which is the only reason this record carries any weight");
  });

  check("it explains why this signal is the strong one", () => {
    assert.match(v.means, /cannot be edited after/i);
  });
});

test("absence of corroboration is never reported as corroboration", () => {
  check("an empty log is inconclusive, not a pass", () => {
    const v = witness.verdict(witness.compare([], rowsBySeq));
    assert.equal(v.ok, null,
      "an empty witness log came back ok. Nothing was contradicted, but nothing was "
      + "confirmed either, and reporting that as success is the exact overstatement "
      + "this whole module exists to avoid");
    assert.match(v.means, /self-attested|nothing is corroborated/i);
  });

  check("observations of rotated-out rows are counted, not treated as failures", () => {
    const c = witness.compare([obs(999999, "whatever")], rowsBySeq);
    assert.equal(c.mismatches.length, 0,
      "a witness record naming a row this instance has not reached was reported as a "
      + "contradiction; rotation and a fresh instance both produce that legitimately");
    assert.equal(c.aheadOfArchive, 1);
    assert.equal(witness.verdict(c).ok, null);
  });

  check("unreachable observations are separated from disagreeing ones", () => {
    const c = witness.compare([
      { observed: "x", http: "502", note: "endpoint unreachable" },
      obs(10, rowsBySeq.get(10).h)
    ], rowsBySeq);
    assert.equal(c.unreachable, 1);
    assert.equal(c.matched, 1);
    assert.equal(witness.verdict(c).ok, true,
      "a period when the free-tier service was asleep must not read as tampering");
  });
});

test("the log is parsed strictly", () => {
  check("malformed lines are counted rather than guessed at", () => {
    const { records, malformed } = witness.parseLog(
      '{"http":"200","tipSeq":1,"tipHash":"a"}\nnot json\n\n{"http":"200","tipSeq":2,"tipHash":"b"}\n');
    assert.equal(records.length, 2);
    assert.equal(malformed, 1,
      "a line that does not parse was silently skipped; a witness log quietly losing "
      + "records is indistinguishable from one being edited");
  });
});

test("the stated limits name the weakness rather than hiding it", () => {
  const c = witness.compare([obs(10, rowsBySeq.get(10).h)], rowsBySeq);
  const v = witness.verdict(c);

  check("it admits the branch is rewritable", () => {
    // The module's LIMITS text is attached by check(); verdict() carries the
    // reasoning. Both must concede the attack rather than imply proof.
    assert.ok(!/proof|proves|cannot be tampered/i.test(v.means),
      "the verdict claims proof. Repository write access permits rewriting the witness "
      + "branch, so the honest claim is raised cost and a discontinuous commit graph, "
      + "not impossibility");
  });

  console.log("# ──────────────────────────────────────────────");
  console.log(`#   ${passed} passed, ${failed} failed`);
  assert.equal(failed, 0);
});
