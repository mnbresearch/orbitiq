// ============================================================
// Screening tests.
//
// These exist because the previous engine had a bug that no test would have
// caught by inspection: it returned a clean, well-formed, plausible-looking
// result while missing roughly four out of five real conjunctions. The tests
// below construct encounters whose true geometry is known independently, then
// assert the screener actually finds them and reports them reproducibly.
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import * as satellite from "satellite.js";
import { screenConjunctions } from "../src/conjunctions.js";
import { V_REL_MAX_KMS } from "../src/constants.js";

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log(`#   ok    ${name}`); }
  catch (e) { failed++; console.log(`#   FAIL  ${name}\n#         ${e.message}`); throw e; }
}

// ── Building a catalogue with a conjunction we control ───────
// Two near-circular 550 km orbits at 53 and 97.5 degrees inclination, phased
// so they arrive at the same place at nearly the same moment. The crossing
// geometry gives a relative velocity around 13 km/s — the case the old 60 s
// sampling missed.

function gpFor({ id, name, incl, raan, meanAnom, argp = 0, ecc = 0.0001, meanMotion = 15.0 }) {
  return {
    OBJECT_NAME: name,
    OBJECT_ID: `2024-${String(id).padStart(3, "0")}A`,
    NORAD_CAT_ID: id,
    EPOCH: "2026-01-01T00:00:00.000Z",
    MEAN_MOTION: meanMotion,
    ECCENTRICITY: ecc,
    INCLINATION: incl,
    RA_OF_ASC_NODE: raan,
    ARG_OF_PERICENTER: argp,
    MEAN_ANOMALY: meanAnom,
    EPHEMERIS_TYPE: 0,
    CLASSIFICATION_TYPE: "U",
    ELEMENT_SET_NO: 999,
    REV_AT_EPOCH: 100,
    BSTAR: 0.0001,
    MEAN_MOTION_DOT: 0,
    MEAN_MOTION_DDOT: 0
  };
}

/** True minimum separation over a window, found by dense independent sampling. */
function bruteForceMin(gpA, gpB, start, windowSec, stepSec = 0.5) {
  const ra = satellite.json2satrec(gpA), rb = satellite.json2satrec(gpB);
  let best = { d: Infinity, t: 0 };
  for (let s = 0; s <= windowSec; s += stepSec) {
    const t = new Date(start.getTime() + s * 1000);
    const pa = satellite.propagate(ra, t)?.position;
    const pb = satellite.propagate(rb, t)?.position;
    if (!pa || !pb) continue;
    const d = Math.hypot(pa.x - pb.x, pa.y - pb.y, pa.z - pb.z);
    if (d < best.d) best = { d, t: s };
  }
  return best;
}

/**
 * Every distinct close approach in the window, by brute force at 1 s.
 *
 * The screener used to keep only the deepest approach per pair, so this
 * fixture's second encounter — a real 14.5 km pass, well inside the reporting
 * threshold — was silently dropped and the test asserted `length === 1`. The
 * expectation was encoding the defect.
 *
 * Counting the true minima here means the assertion is derived from the orbits
 * rather than from a number somebody wrote down, so it stays honest if the
 * fixture ever changes.
 */
function bruteForceAllMinima(gpA, gpB, start, windowSec, thresholdKm) {
  const ra = satellite.json2satrec(gpA), rb = satellite.json2satrec(gpB);
  const d = [];
  for (let s = 0; s <= windowSec; s += 1) {
    const t = new Date(start.getTime() + s * 1000);
    const pa = satellite.propagate(ra, t)?.position;
    const pb = satellite.propagate(rb, t)?.position;
    if (!pa || !pb) continue;
    d.push([s, Math.hypot(pa.x - pb.x, pa.y - pb.y, pa.z - pb.z)]);
  }
  const mins = [];
  for (let i = 1; i < d.length - 1; i++) {
    if (d[i][1] < thresholdKm && d[i][1] <= d[i - 1][1] && d[i][1] <= d[i + 1][1]) {
      // Two minima closer together than a couple of minutes are the same pass
      // sampled twice, not two encounters.
      // Indexed by name, not position: an earlier version wrote
      // mins[mins.length-1][0] on an array of objects, so the comparison was
      // NaN > 120 — false — and every minimum after the first was silently
      // dropped. That made the helper agree with the very defect it was
      // written to expose.
      const last = mins[mins.length - 1];
      if (!last || d[i][0] - last.tSec > 120) mins.push({ tSec: d[i][0], d: d[i][1] });
    }
  }
  return mins;
}

/**
 * Search phasing offsets to find a genuine close approach, so the fixture is
 * a real orbital encounter rather than a hand-waved one.
 */
function buildCrossingPair(start, windowSec) {
  const A = gpFor({ id: 90001, name: "TEST PRIMARY", incl: 53.0, raan: 20, meanAnom: 0 });
  let bestPair = null;
  for (let ma = 0; ma < 360; ma += 0.5) {
    const B = gpFor({ id: 90002, name: "TEST SECONDARY", incl: 97.5, raan: 110, meanAnom: ma });
    const m = bruteForceMin(A, B, start, windowSec, 5);
    if (!bestPair || m.d < bestPair.min.d) bestPair = { B, min: m };
  }
  const refined = bruteForceMin(A, bestPair.B, start, windowSec, 0.25);
  return { A, B: bestPair.B, truth: refined };
}

const START = new Date("2026-01-01T06:00:00.000Z");
const WINDOW_SEC = 3600 * 2;

console.log("# ── conjunction screening ──────────────────────");

const { A, B, truth } = buildCrossingPair(START, WINDOW_SEC);
const sats = [
  { id: 90001, name: "TEST PRIMARY", org: "testco", gp: A },
  { id: 90002, name: "TEST SECONDARY", org: "other", gp: B }
];

test("screening", async () => {
  check("fixture really is a close approach", () => {
    assert.ok(truth.d < 60, `fixture min separation ${truth.d.toFixed(2)} km is not close`);
  });

  // The headline regression: this encounter must be found at all.
  const threshold = Math.max(5, Math.ceil(truth.d) + 2);
  const res = screenConjunctions(sats, "testco", WINDOW_SEC / 3600, threshold, { start: START });

  const trueMinima = bruteForceAllMinima(A, B, START, WINDOW_SEC, threshold);

  check("detects a real crossing conjunction", () => {
    assert.ok(res.events.length >= 1, "the encounter was not found at all");
  });

  check("finds EVERY distinct approach, not just the deepest", () => {
    // This pair passes inside the threshold twice in the window. Reporting one
    // of them is not a rounding difference: each approach has its own time of
    // closest approach and needs its own decision, and the evidence layer binds
    // a decision to a specific warning row — so a dropped approach is an
    // encounter with nothing to attach a decision to.
    assert.equal(res.events.length, trueMinima.length,
      `brute force finds ${trueMinima.length} approach(es) under ${threshold} km at `
      + `${trueMinima.map(m => m.tSec + "s/" + m.d.toFixed(1) + "km").join(", ")}, `
      + `but the screener reported ${res.events.length}`);
  });

  check("every reported approach matches a real one in time and distance", () => {
    for (const ev of res.events) {
      const tSec = Math.round((new Date(ev.tca) - START) / 1000);
      const near = trueMinima.find(m => Math.abs(m.tSec - tSec) < 30);
      assert.ok(near, `reported an approach at t+${tSec}s that brute force does not find`);
      assert.ok(Math.abs(ev.missKm - near.d) < 0.5,
        `reported ${ev.missKm} km at t+${tSec}s, brute force says ${near.d.toFixed(3)} km`);
    }
  });

  check("a recurring pair carries its true approach count", () => {
    assert.equal(res.events[0].approachesInWindow, trueMinima.length);
    assert.equal(res.events[0].recurring, trueMinima.length > 1,
      "a pair that approaches more than once must be flagged as recurring: it is a "
      + "conversation about the orbit, not a series of independent avoidance decisions");
  });

  check("reported miss matches independent brute-force truth", () => {
    const got = res.events[0].missKm;
    assert.ok(Math.abs(got - truth.d) < 0.05,
      `reported ${got} km vs truth ${truth.d.toFixed(3)} km`);
  });

  check("relative velocity is physically plausible", () => {
    const v = res.events[0].relVelKmS;
    assert.ok(v > 0 && v <= V_REL_MAX_KMS, `relVel ${v} outside 0..${V_REL_MAX_KMS}`);
  });

  // Reproducibility: the old 2 s grid returned 3.1-10.7 km for one encounter
  // depending only on where the clock happened to fall.
  check("same encounter reports the same miss regardless of clock phase", () => {
    const seen = [];
    for (const offsetMs of [0, 250, 500, 750, 1000, 1337]) {
      const s = new Date(START.getTime() + offsetMs);
      // Shift the window so the same physical encounter stays inside it.
      const r = screenConjunctions(sats, "testco", WINDOW_SEC / 3600, threshold, { start: s });
      if (r.events.length) seen.push(r.events[0].missKm);
    }
    assert.ok(seen.length >= 5, `only ${seen.length} of 6 phases detected the encounter`);
    const spread = Math.max(...seen) - Math.min(...seen);
    assert.ok(spread < 0.05, `miss distance varied by ${spread.toFixed(3)} km across clock phases: ${seen}`);
  });

  check("TCA is reported at the true time of closest approach", () => {
    const tcaSec = (new Date(res.events[0].tca).getTime() - START.getTime()) / 1000;
    assert.ok(Math.abs(tcaSec - truth.t) < 2,
      `TCA off by ${Math.abs(tcaSec - truth.t).toFixed(2)} s`);
  });

  // The completeness guarantee must hold structurally, not by luck.
  check("coarse gate is wide enough for the coarse step", () => {
    const { coarseStepSec, coarseGateKm } = res.method;
    const required = res.thresholdKm + V_REL_MAX_KMS * (coarseStepSec / 2);
    assert.ok(coarseGateKm >= required - 1e-9,
      `gate ${coarseGateKm} km < required ${required} km for a ${coarseStepSec} s step`);
  });

  check("response states what the screen is complete to", () => {
    assert.equal(res.method.completeToRelVelKmS, V_REL_MAX_KMS);
    assert.match(res.method.note, /Complete for pairs closing/);
  });

  // Detection must not depend on the reporting threshold being generous.
  check("still detected at a tight threshold", () => {
    const tight = Math.max(1, Math.ceil(truth.d));
    const r = screenConjunctions(sats, "testco", WINDOW_SEC / 3600, tight, { start: START });
    assert.equal(r.events.length, 1, `lost the event at threshold ${tight} km`);
  });

  // Docked stacks (ISS + visiting vehicles, the CSS modules) are catalogued as
  // separate objects at zero separation and zero relative velocity. Reporting
  // them as CRITICAL conjunctions is both wrong and the most visible thing on
  // the page, because they sort to the top.
  check("excludes physically attached objects", () => {
    const gp = gpFor({ id: 90010, name: "STATION CORE", incl: 41.5, raan: 30, meanAnom: 12 });
    const docked = { ...gp, NORAD_CAT_ID: 90011, OBJECT_NAME: "STATION MODULE" };
    const r = screenConjunctions([
      { id: 90010, name: "STATION CORE", org: "testco", gp },
      { id: 90011, name: "STATION MODULE", org: "other", gp: docked }
    ], "testco", 1, 10, { start: START });
    assert.equal(r.events.length, 0, "a docked pair must not be reported as a conjunction");
    assert.equal(r.attachedPairsExcluded, 1, "and it must be counted, not silently dropped");
  });

  check("a genuine close approach is still reported", () => {
    // Same fixture as above but a real crossing: low miss, high relative
    // velocity. The attached filter keys on velocity, so this must survive.
    //
    // Counted against brute-force truth rather than a literal, because this
    // pair legitimately approaches twice in the window and the point of the
    // check is that the attached filter does not eat a real encounter — not
    // how many real encounters there happen to be.
    const r = screenConjunctions(sats, "testco", WINDOW_SEC / 3600, threshold, { start: START });
    assert.equal(r.events.length, trueMinima.length);
    assert.ok(r.events[0].relVelKmS > 1, `relVel ${r.events[0].relVelKmS} should be large`);
    assert.equal(r.attachedPairsExcluded, 0);
  });

  check("does not invent events between well-separated objects", () => {
    const far = [
      sats[0],
      { id: 90003, name: "FAR", org: "other",
        gp: gpFor({ id: 90003, name: "FAR", incl: 53.0, raan: 200, meanAnom: 180, meanMotion: 11.5 }) }
    ];
    const r = screenConjunctions(far, "testco", 1, 10, { start: START });
    assert.equal(r.events.length, 0, `expected no events, got ${r.events.length}`);
  });

  check("apogee/perigee sieve keeps objects that share the primary's shell", () => {
    const r = screenConjunctions(sats, "testco", 1, 10, { start: START });
    assert.equal(r.sievedTo, 2, `sieve dropped a co-altitude object: ${r.sievedTo}`);
  });

  check("apogee/perigee sieve removes objects that cannot reach the primary", () => {
    const mixed = [
      sats[0],
      // ~20000 km altitude: radial bands cannot overlap a 550 km orbit.
      { id: 90004, name: "HIGH", org: "other",
        gp: gpFor({ id: 90004, name: "HIGH", incl: 55, raan: 20, meanAnom: 0, meanMotion: 2.0 }) }
    ];
    const r = screenConjunctions(mixed, "testco", 1, 10, { start: START });
    assert.equal(r.sievedTo, 1, `sieve kept an unreachable object: ${r.sievedTo}`);
    assert.equal(r.events.length, 0);
  });

  check("primaryIds screens an explicit fleet rather than a whole operator", () => {
    const r = screenConjunctions(sats, null, WINDOW_SEC / 3600, threshold,
      { start: START, primaryIds: [90001] });
    assert.equal(r.screened, 1, `expected 1 primary, got ${r.screened}`);
    // Same encounters as the org-scoped screen: restricting the primaries
    // changes who is screened, not how many times this pair actually passes.
    assert.equal(r.events.length, trueMinima.length);
  });

  console.log("# ──────────────────────────────────────────────");
  console.log(`#   ${passed} passed, ${failed} failed`);
  assert.equal(failed, 0);
});
