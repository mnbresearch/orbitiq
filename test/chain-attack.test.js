// ============================================================
// Attacking the chain.
//
// The product is a claim about a record: that nobody can alter it without the
// alteration being apparent. Every other test in this suite checks that the
// system works. These check that it cannot be made to lie.
//
// The adversary here is not a stranger. It is whoever runs the service — the
// party with the strongest motive to edit the record after an incident, and
// the only one with write access to the disk. A tamper-evidence scheme that
// only resists outsiders resists nobody who matters.
//
// ── What this file found ────────────────────────────────────
// Rotation drops the oldest rows and writes an anchor recording what went, so
// that the retained window stays checkable. verify() read that anchor and then
// threw it away, adopting whatever the first surviving row claimed about its
// own position. Deleting the oldest retained rows therefore left the archive
// reporting ok — the exact attack the anchor exists to stop, undetectable, for
// as long as it had existed.
//
// It had never fired in production because rotation is set at 200,000 rows and
// the live archive held 28,341. The first time that code path would have run
// was on real customer evidence, months from now, with no way back.
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "orbitiq-attack-"));
process.env.ORBITIQ_DATA_DIR = tmp;

const ledger = await import("../src/ledger.js");

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log(`#   ok    ${name}`); }
  catch (e) { failed++; console.log(`#   FAIL  ${name}\n#         ${e.message}`); throw e; }
}

const LEDGER = path.join(tmp, "ledger.jsonl");
const ANCHOR = path.join(tmp, "ledger-anchor.json");
const SEALS = path.join(tmp, "ledger-seals.json");

const rows = () => fs.readFileSync(LEDGER, "utf8").split("\n").filter(Boolean).map(JSON.parse);
const writeRows = rs => fs.writeFileSync(LEDGER, rs.map(r => JSON.stringify(r)).join("\n") + "\n");

/** Reset to a fresh chain of n rows, with no anchor and no seals. */
function fresh(n = 60) {
  for (const f of [LEDGER, ANCHOR, SEALS]) { try { fs.rmSync(f); } catch {} }
  ledger.reload();
  ledger.append("conjunction", Array.from({ length: n }, (_, i) => ({ org: "acme", n: i })));
}

/**
 * Put the archive in exactly the state rotation leaves it in: the oldest rows
 * gone, and an anchor naming the last one dropped.
 *
 * Simulated rather than driven through append() because the real threshold is
 * 200,000 rows. Writing 200,000 rows in a test to exercise twenty lines of
 * bookkeeping would make the suite slow enough that somebody would eventually
 * delete it, and an unrun test protects nothing.
 */
function rotate(dropCount) {
  const all = rows();
  const dropped = all[dropCount - 1];
  writeRows(all.slice(dropCount));
  fs.writeFileSync(ANCHOR, JSON.stringify({
    seq: dropped.seq, h: dropped.h, droppedThrough: dropped.t, at: new Date().toISOString()
  }));
  ledger.reload();
  return dropped;
}

console.log("# ── attacking the chain ───────────────────────");

test("an untouched archive verifies, before and after rotation", () => {
  fresh(60);
  check("a fresh chain verifies", () => {
    const v = ledger.verify();
    assert.equal(v.ok, true, JSON.stringify(v));
    assert.equal(v.verified, 60);
  });

  rotate(20);
  check("a rotated chain still verifies, and says it is anchored", () => {
    const v = ledger.verify();
    assert.equal(v.ok, true, JSON.stringify(v));
    assert.equal(v.verified, 40);
    assert.equal(v.anchored, true,
      "rotation wrote an anchor but verification did not report using one");
    assert.equal(v.chainStartsAt, 21);
  });
});

test("rows cannot be removed from the head of a rotated window", () => {
  fresh(60);
  rotate(20);

  // The attack: quietly delete the ten oldest surviving rows. Everything left
  // is internally consistent — each row still links to the one before it —
  // so a check that only walks the file finds nothing wrong.
  writeRows(rows().slice(10));
  ledger.reload();

  check("verification fails", () => {
    const v = ledger.verify();
    assert.equal(v.ok, false,
      "the ten oldest retained warnings were deleted and the archive still reported ok. "
      + "The rows that remain are self-consistent, so walking the file proves nothing; "
      + "only the anchor knows where the window was supposed to begin, and it was being "
      + "read and then discarded");
  });

  check("it names the anchor as the reason", () => {
    const v = ledger.verify();
    assert.match(v.reason, /anchor/i);
    assert.equal(v.anchorSeq, 20);
    assert.equal(v.expectedSeq, 21);
  });

  check("it explains the discrepancy in words a non-engineer can use", () => {
    const v = ledger.verify();
    assert.match(v.means, /removed from the start/i,
      "a dispute is read by lawyers and adjusters; 'sequence gap at index 0' tells them "
      + "nothing they can act on");
  });
});

test("an archive that predates the anchor still verifies", () => {
  // The behaviour the discarded-anchor code was originally written for must
  // survive the fix: with no anchor, a chain legitimately starting mid-file is
  // fine, because nothing else knows where it should start.
  fresh(60);
  writeRows(rows().slice(20));
  try { fs.rmSync(ANCHOR); } catch {}
  ledger.reload();

  check("no anchor means the first row's own linkage is adopted", () => {
    const v = ledger.verify();
    assert.equal(v.ok, true,
      "tightening the anchor check broke the case it was loosened for: an archive with no "
      + "anchor at all now fails, which would report every pre-rotation deployment as tampered");
    assert.equal(v.anchored, false);
    assert.equal(v.chainStartsAt, 21);
  });
});

test("a rewritten row is caught even when the chain is rebuilt around it", () => {
  fresh(40);

  // Seal the tip. This is what the hourly witness run publishes, and it is
  // the only record of the archive's state that the service does not control
  // after the fact.
  const sealed = ledger.seal();
  assert.equal(sealed.ok, true, JSON.stringify(sealed));

  check("a naive edit is caught by the hash of the row itself", () => {
    const all = rows();
    all[10].n = 999;                      // body changed, hash left alone
    writeRows(all);
    ledger.reload();
    const v = ledger.verify();
    assert.equal(v.ok, false);
    assert.match(v.reason, /row altered/i);
  });

  check("a thorough edit — rewriting every hash after it — is caught by the seal", () => {
    // The determined version of the attack. Change a row and recompute the
    // whole chain from there, so the archive is perfectly self-consistent.
    // Nothing inside the file can reveal this.
    fresh(40);
    const s = ledger.seal();
    assert.equal(s.ok, true);
    const sealedTipHash = s.seal.hash;

    const all = rows();
    all[10].n = 999;
    // Rebuild the chain from the edited row onward using the module's OWN
    // hashing, so the forgery is indistinguishable from a genuine archive.
    // Using the real hashRow matters: a hand-rolled reimplementation would
    // test my copy of the scheme rather than theirs, and a forgery that the
    // system could spot for the wrong reason would prove nothing.
    let prev = all[0].prev;
    for (const r of all) {
      r.prev = prev;
      r.h = ledger.hashRow(r.seq, r.prev, ledger.bodyOf(r));
      prev = r.h;
    }
    writeRows(all);
    ledger.reload();

    const v = ledger.verify();
    assert.equal(v.ok, false,
      "a row was rewritten and every hash after it recomputed, so the chain verifies "
      + "against itself perfectly. The published seal recorded a different tip hash "
      + `(${sealedTipHash}) before the edit was possible, and that is the only thing here `
      + "the service cannot revise after the fact");
    assert.match(v.reason, /seal/i);
  });
});

test("verification reports how much of it the seals actually covered", () => {
  fresh(30);
  ledger.seal();

  check("it says how many seals fell inside the retained window", () => {
    const v = ledger.verify();
    assert.equal(v.ok, true, JSON.stringify(v));
    assert.ok(v.sealsChecked >= 1,
      "no seal was cross-checked, so the strongest guarantee in the system silently "
      + "contributed nothing to this verdict");
  });

  check("seals rotated out of the window are counted, not silently dropped", () => {
    rotate(20);
    const v = ledger.verify();
    assert.equal(v.ok, true, JSON.stringify(v));
    assert.equal(typeof v.sealsOutsideWindow, "number",
      "a reader needs to know that older seals exist but cover rows no longer held, "
      + "otherwise 'sealsChecked: 0' looks like the seals were never taken");
  });

  console.log("# ──────────────────────────────────────────────");
  console.log(`#   ${passed} passed, ${failed} failed`);
  assert.equal(failed, 0);
});
