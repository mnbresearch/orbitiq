// ============================================================
// Conjunction evolution tracking tests.
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { classify, trackKey, observe, peek, prune, stats } from "../src/trend.js";

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log(`#   ok    ${name}`); }
  catch (e) { failed++; console.log(`#   FAIL  ${name}\n#         ${e.message}`); throw e; }
}

const obsAt = (hoursAgo, missKm, pc = null) => ({
  at: new Date(Date.now() - hoursAgo * 3600000).toISOString(), missKm, pc
});

test("trend", () => {
  console.log("# ── conjunction evolution ──────────────────────");

  check("an encounter seen once has no trend", () => {
    const r = classify([obsAt(0, 5)]);
    assert.equal(r.direction, "new");
    assert.equal(r.observations, 1);
  });

  check("no observations is also 'new', not a crash", () => {
    assert.equal(classify([]).direction, "new");
    assert.equal(classify(undefined).direction, "new");
  });

  check("a tightening encounter reads as converging", () => {
    const r = classify([obsAt(6, 12), obsAt(3, 8), obsAt(0, 4.2)]);
    assert.equal(r.direction, "converging");
    assert.ok(r.deltaKm < 0, `deltaKm ${r.deltaKm} should be negative`);
    assert.match(r.note, /Tightened/);
  });

  check("a widening encounter reads as diverging", () => {
    const r = classify([obsAt(6, 3), obsAt(0, 9)]);
    assert.equal(r.direction, "diverging");
    assert.ok(r.deltaKm > 0);
    assert.match(r.note, /Widened/);
  });

  // The point of the stable band: without it, sub-metre wobble would be
  // reported as a trend, which is exactly the noise-as-physics failure the
  // old screener would have produced.
  check("small changes are stable, not a trend", () => {
    assert.equal(classify([obsAt(6, 5.00), obsAt(0, 5.20)]).direction, "stable");
    assert.equal(classify([obsAt(6, 5.00), obsAt(0, 4.80)]).direction, "stable");
  });

  check("the threshold is relative, so it scales with distance", () => {
    // 1 km of movement: significant at 4 km, negligible at 40 km.
    assert.equal(classify([obsAt(6, 4), obsAt(0, 3)]).direction, "converging");
    assert.equal(classify([obsAt(6, 40), obsAt(0, 39)]).direction, "stable");
  });

  check("reports how far and over what span", () => {
    const r = classify([obsAt(4, 10), obsAt(0, 6)]);
    assert.equal(r.deltaKm, -4);
    assert.equal(r.firstMissKm, 10);
    assert.equal(r.missKm, 6);
    assert.ok(Math.abs(r.spanHours - 4) < 0.01, `spanHours ${r.spanHours}`);
    assert.equal(r.changePct, -40);
  });

  check("tracks probability movement separately from distance", () => {
    // Miss can hold steady while Pc climbs as the element set ages.
    const r = classify([obsAt(6, 5, 1e-6), obsAt(0, 5, 1e-4)]);
    assert.equal(r.direction, "stable");
    assert.ok(Math.abs(r.pcRatio - 100) < 1, `pcRatio ${r.pcRatio}`);
  });

  check("pcRatio is null when probability is missing", () => {
    assert.equal(classify([obsAt(6, 5), obsAt(0, 4)]).pcRatio, null);
  });

  check("encounter identity ignores object order", () => {
    assert.equal(trackKey(25544, 48274, "2026-08-20T14:22:10Z"),
                 trackKey(48274, 25544, "2026-08-20T14:22:10Z"));
  });

  check("encounter identity buckets TCA to the hour", () => {
    // Successive screens refine TCA by seconds; that must not fork the track.
    assert.equal(trackKey(1, 2, "2026-08-20T14:22:10Z"),
                 trackKey(1, 2, "2026-08-20T14:47:59Z"));
    assert.notEqual(trackKey(1, 2, "2026-08-20T14:00:00Z"),
                    trackKey(1, 2, "2026-08-20T15:00:00Z"));
  });

  check("observations accumulate into a trend across sweeps", () => {
    const ws = "ws-test-" + Math.random();
    const tca = new Date(Date.now() + 6 * 3600000).toISOString();
    observe(ws, { idA: 1, idB: 2, tca, missKm: 12, pc: 1e-7, at: obsAt(4, 0).at });
    observe(ws, { idA: 1, idB: 2, tca, missKm: 8,  pc: 1e-6, at: obsAt(2, 0).at });
    const r = observe(ws, { idA: 2, idB: 1, tca, missKm: 3.5, pc: 2e-5, at: obsAt(0, 0).at });
    assert.equal(r.observations, 3, "reversed id order should hit the same track");
    assert.equal(r.direction, "converging");
    assert.equal(r.missKm, 3.5);
  });

  check("peek reads without recording", () => {
    const ws = "ws-peek-" + Math.random();
    const tca = new Date(Date.now() + 3 * 3600000).toISOString();
    observe(ws, { idA: 7, idB: 8, tca, missKm: 4 });
    const before = peek(ws, 7, 8, tca).observations;
    peek(ws, 7, 8, tca);
    assert.equal(peek(ws, 7, 8, tca).observations, before);
  });

  check("one tenant's history is never another's", () => {
    const tca = new Date(Date.now() + 5 * 3600000).toISOString();
    const a = "ws-a-" + Math.random(), b = "ws-b-" + Math.random();
    observe(a, { idA: 11, idB: 12, tca, missKm: 9 });
    assert.equal(peek(b, 11, 12, tca).observations, 0);
  });

  check("history is capped so a long-lived encounter cannot grow forever", () => {
    const ws = "ws-cap-" + Math.random();
    const tca = new Date(Date.now() + 8 * 3600000).toISOString();
    for (let i = 0; i < 60; i++) {
      observe(ws, { idA: 21, idB: 22, tca, missKm: 5 + i * 0.01,
        at: new Date(Date.now() - (60 - i) * 60000).toISOString() });
    }
    assert.ok(peek(ws, 21, 22, tca).observations <= 24,
      `kept ${peek(ws, 21, 22, tca).observations} observations`);
  });

  check("tracks are pruned once the encounter is well past", () => {
    const ws = "ws-prune-" + Math.random();
    const old = new Date(Date.now() - 72 * 3600000).toISOString();
    const soon = new Date(Date.now() + 4 * 3600000).toISOString();
    observe(ws, { idA: 31, idB: 32, tca: old, missKm: 5 });
    observe(ws, { idA: 33, idB: 34, tca: soon, missKm: 5 });
    prune();
    assert.equal(peek(ws, 31, 32, old).observations, 0, "past encounter should be pruned");
    assert.equal(peek(ws, 33, 34, soon).observations, 1, "future encounter must survive");
  });

  check("stats reports what is being tracked", () => {
    const s = stats();
    assert.ok(Number.isFinite(s.tracked) && Number.isFinite(s.observations));
  });

  console.log("# ──────────────────────────────────────────────");
  console.log(`#   ${passed} passed, ${failed} failed`);
  assert.equal(failed, 0);
});
