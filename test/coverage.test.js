// ============================================================
// Screening coverage.
//
// The property under test is a negative one, and negatives are where evidence
// systems quietly fail: can a reader tell "nothing was found" apart from
// "nobody was looking"? Every assertion here is about a gap being visible
// rather than smoothed away, because the incentive at claim time runs the
// other way and the code is the only thing that does not feel it.
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "orbitiq-cov-"));
process.env.ORBITIQ_DATA_DIR = tmp;

const ledger = await import("../src/ledger.js");
const coverage = await import("../src/coverage.js");

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log(`#   ok    ${name}`); }
  catch (e) { failed++; console.log(`#   FAIL  ${name}\n#         ${e.message}`); throw e; }
}

const H = 3600e3;
const now = Date.now();
const iso = ms => new Date(ms).toISOString();

// A week of hourly sweeps with a deliberate 30-hour hole three days in.
const start = now - 7 * 24 * H;
const holeFrom = start + 72 * H;
const holeTo = holeFrom + 30 * H;
for (let t = start; t <= now; t += H) {
  if (t > holeFrom && t < holeTo) continue;
  ledger.append(coverage.COVERAGE_TYPE, [{
    org: "acme", at: iso(t), source: "test",
    objectsScreened: 6000, windowHours: 72, thresholdKm: 10,
    catalogueEpochAgeDays: 1.2, eventsFound: t % (6 * H) === 0 ? 1 : 0
  }]);
}

console.log("# ── screening coverage ────────────────────────");

test("a gap in the watching is visible, not averaged away", () => {
  const s = coverage.summary({ org: "acme", since: iso(start), until: iso(now) });

  check("the sweeps are recorded", () => {
    assert.ok(s.sweepsRecorded > 100, `only ${s.sweepsRecorded} sweeps`);
  });

  check("the period is not reported as continuous", () => {
    assert.equal(s.continuous, false,
      "a 30-hour hole was reported as continuous coverage, which is the single most "
      + "misleading thing this module could say");
  });

  check("the gap is named individually, with its duration", () => {
    assert.equal(s.gaps.length, 1, JSON.stringify(s.gaps));
    assert.ok(Math.abs(s.gaps[0].hours - 30) < 1.5, `gap reported as ${s.gaps[0].hours} h`);
  });

  check("the covered fraction is reported but never alone", () => {
    // 30 hours missing from 168 is about 82% — high enough that a percentage
    // on its own would read as "basically fine".
    assert.ok(s.coveredFraction > 0.8 && s.coveredFraction < 0.85,
      `coveredFraction ${s.coveredFraction}`);
    assert.ok(s.gaps.length > 0,
      "a coveredFraction was produced with an empty gap list; the number would then be the "
      + "only thing a reader sees, and 82% rounds up in the mind to 'covered'");
  });

  check("ordinary scheduler lateness is not reported as an outage", () => {
    // GitHub's cron has been observed firing up to 55 minutes late. Hourly
    // sweeps with that much drift must not produce a page of tiny 'gaps' —
    // a report full of non-events trains the reader to skip the section
    // where the real gap is.
    assert.ok(coverage.EXPECTED_INTERVAL_HOURS >= 2,
      "the gap threshold is tight enough that normal scheduler drift will be reported as "
      + "missing coverage");
  });
});

test("gaps at the edges of the period count too", () => {
  check("a period starting before the first sweep shows the leading gap", () => {
    const s = coverage.summary({
      org: "acme", since: iso(start - 5 * 24 * H), until: iso(now)
    });
    assert.ok(s.gaps.some(g => new Date(g.to).getTime() <= start + H),
      "no leading gap reported. 'We began screening only after the incident' is precisely "
      + "the shape this must not hide, and trimming the analysis to the first sweep would "
      + "hide it perfectly");
  });

  check("a period ending after the last sweep shows the trailing gap", () => {
    const s = coverage.summary({
      org: "acme", since: iso(start), until: iso(now + 4 * 24 * H)
    });
    assert.ok(s.gaps.some(g => new Date(g.from).getTime() >= now - H),
      "screening that stopped days ago was reported as covered up to the present");
  });

  check("an org with no sweeps at all is not reported as continuous", () => {
    const s = coverage.summary({ org: "nobody", since: iso(start), until: iso(now) });
    assert.equal(s.sweepsRecorded, 0);
    assert.equal(s.continuous, false,
      "zero sweeps satisfied 'no gaps found' and came back continuous — an empty record "
      + "must never read as a clean one");
  });
});

test("a coverage row does not overclaim", () => {
  const s = coverage.summary({ org: "acme", since: iso(start), until: iso(now) });

  check("catalogue staleness is carried, not just the fact of a sweep", () => {
    assert.ok(Number.isFinite(s.medianCatalogueAgeDays),
      "a sweep against a four-day-old catalogue is weaker evidence than one against fresh "
      + "elements; without the age a reader cannot tell the two apart");
  });

  check("it never claims the catalogue was complete", () => {
    assert.match(s.limits, /does not say the catalogue was complete/i);
    assert.match(s.limits, /evidence of watching, not of having seen everything/i);
  });

  check("an empty period explains that recording has a start date", () => {
    const s2 = coverage.summary({ org: "nobody", since: iso(start), until: iso(now) });
    assert.match(s2.means, /not evidence that none ran/i,
      "silence before this feature shipped would otherwise read as an outage, which would be "
      + "an accusation the record cannot support");
  });

  check("recording never throws into the screening path", () => {
    // A bookkeeping failure must not take down the sweep it is bookkeeping.
    const out = coverage.record({ org: "acme", objectsScreened: "not a number" });
    assert.equal(out.ok, true);
    const rows = coverage.sweeps({ org: "acme" });
    assert.equal(rows.at(-1).objectsScreened, null, "a bad value was stored rather than nulled");
  });

  console.log("# ──────────────────────────────────────────────");
  console.log(`#   ${passed} passed, ${failed} failed`);
  assert.equal(failed, 0);
});
