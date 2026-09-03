// ============================================================
// Probability dilution.
//
// Pc is not monotonic in uncertainty. It rises as sigma grows, peaks, and
// then falls — so past the peak, knowing LESS produces a smaller number. A
// conjunction assessment that reports only Pc will therefore reassure its
// reader most confidently about exactly the encounters nobody understands.
//
// This platform screens from public element sets, where sigma is kilometres
// and miss distances of interest are kilometres, so it sits past that peak
// for much of what it screens. That is not a bug to be fixed — it is a
// property of screening from TLEs — but reporting a suppressed probability
// without saying so would be the same failure this system already shipped
// once with the covariance model: a number that reads "safe" and means
// "unknown".
//
// The first test is the load-bearing one. It does not take the closed-form
// peak on trust; it sweeps sigma through the actual Foster integrator, finds
// where Pc is largest, and checks the formula against it. A wrong peak would
// put every encounter in the wrong regime and the labels would be confidently
// backwards.
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import * as pc from "../src/pc.js";

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log(`#   ok    ${name}`); }
  catch (e) { failed++; console.log(`#   FAIL  ${name}\n#         ${e.message}`); throw e; }
}

// A head-on encounter with a clean geometry: the miss is purely cross-track,
// so the in-plane miss equals the 3D miss and the closed form is directly
// comparable with the integrator.
const HBR_M = 20;
function pcAtSigma(missKm, sigmaKm) {
  const rA = { x: 6871, y: 0, z: 0 }, vA = { x: 0, y: 7.6, z: 0 };
  const rB = { x: 6871, y: 0, z: missKm }, vB = { x: 0, y: -7.6, z: 0 };
  const cov = { sigmaR: sigmaKm, sigmaI: sigmaKm, sigmaC: sigmaKm };
  // Each object carries half the variance so the summed covariance is sigmaKm.
  const half = { sigmaR: sigmaKm / Math.SQRT2, sigmaI: sigmaKm / Math.SQRT2, sigmaC: sigmaKm / Math.SQRT2 };
  const f = pc.fosterPc(
    { x: rB.x - rA.x, y: rB.y - rA.y, z: rB.z - rA.z },
    { x: vB.x - vA.x, y: vB.y - vA.y, z: vB.z - vA.z },
    half, half, pc.ricBasis(rA, vA), HBR_M
  );
  return f.pc;
}

console.log("# ── probability dilution ──────────────────────");

test("the peak is where the closed form says it is", () => {
  const missKm = 3.0;

  // Sweep sigma across four orders of magnitude and find the maximum of the
  // real integrator — no closed form involved.
  let best = { sigma: null, pc: -1 };
  for (let i = 0; i <= 4000; i++) {
    const sigma = 0.01 * Math.pow(10, (i / 4000) * 3);   // 0.01 km .. 10 km
    const p = pcAtSigma(missKm, sigma);
    if (p > best.pc) best = { sigma, pc: p };
  }

  check("Pc really does have an interior maximum in sigma", () => {
    assert.ok(best.sigma > 0.05 && best.sigma < 9,
      `the maximum landed at the edge of the sweep (${best.sigma}), so this fixture is not `
      + "exercising the non-monotonicity the whole module is about");
  });

  check("the swept maximum matches d/sqrt(2)", () => {
    const predicted = missKm / Math.SQRT2;
    const err = Math.abs(best.sigma - predicted) / predicted;
    assert.ok(err < 0.05,
      `integrator peaks at sigma=${best.sigma.toFixed(3)} km, closed form says `
      + `${predicted.toFixed(3)} km (${(err * 100).toFixed(1)}% out). Every regime label `
      + "depends on this being right, and a wrong peak would classify encounters "
      + "confidently backwards");
  });

  check("the value at the peak matches R^2/(e d^2)", () => {
    const predicted = pc.maxPc(missKm, HBR_M);
    const err = Math.abs(best.pc - predicted) / predicted;
    assert.ok(err < 0.05,
      `integrator peak Pc ${best.pc.toExponential(3)} vs closed form `
      + `${predicted.toExponential(3)} (${(err * 100).toFixed(1)}% out)`);
  });

  check("more uncertainty past the peak really does lower Pc", () => {
    const atPeak = pcAtSigma(missKm, missKm / Math.SQRT2);
    const atTenTimes = pcAtSigma(missKm, 10 * missKm / Math.SQRT2);
    assert.ok(atTenTimes < atPeak / 10,
      `ten times the uncertainty gave ${atTenTimes.toExponential(2)} against `
      + `${atPeak.toExponential(2)} at the peak. If this is not a large drop then dilution `
      + "is not real in this implementation and the warnings would be noise");
  });

  check("and less uncertainty than the peak also lowers Pc", () => {
    // The other side matters just as much: it is why "better tracking would
    // raise this" is NOT a safe thing to tell an operator.
    const atPeak = pcAtSigma(missKm, missKm / Math.SQRT2);
    const atTiny = pcAtSigma(missKm, missKm / 50);
    assert.ok(atTiny < atPeak,
      "a precisely known 3 km miss should be a confident miss with a small probability; "
      + "if shrinking sigma always raised Pc, the advice to improve tracking would be "
      + "unconditionally safe, and it is not");
  });
});

test("the regime is classified from the right side of the peak", () => {
  const at = (miss, sx, sy) => pc.dilution({ missInPlaneKm: miss, sigmaXKm: sx, sigmaYKm: sy, hbrM: HBR_M });

  check("kilometre-scale sigma against a kilometre-scale miss is dilution", () => {
    // The everyday case for TLE screening.
    const d = at(2.4, 6, 12);
    assert.equal(d.regime, "dilution", JSON.stringify(d));
    assert.ok(d.ratio > 3, `ratio ${d.ratio}`);
  });

  check("sigma well below the miss is a resolved encounter", () => {
    const d = at(10, 0.3, 0.3);
    assert.equal(d.regime, "resolved", JSON.stringify(d));
    assert.match(d.means, /reflects the geometry/i);
  });

  check("sigma at the peak is reported as near-peak, not as either extreme", () => {
    const d = at(4, 4 / Math.SQRT2, 4 / Math.SQRT2);
    assert.equal(d.regime, "near-peak", JSON.stringify(d));
    assert.ok(Math.abs(d.ratio - 1) < 0.05);
  });

  check("the suppression factor says how much of the gap is ignorance", () => {
    const d = pc.dilution({ missInPlaneKm: 2.4, sigmaXKm: 6, sigmaYKm: 12, hbrM: HBR_M, pc: 1e-6 });
    assert.ok(d.suppressionFactor > 1,
      "in the dilution region the peak must exceed the reported value; a factor at or "
      + "below one would mean the regime call is wrong");
    assert.ok(d.pcAtPeak > 1e-6);
  });
});

test("the wording never promises something the physics does not", () => {
  const diluted = pc.dilution({ missInPlaneKm: 2.4, sigmaXKm: 8, sigmaYKm: 14, hbrM: HBR_M, pc: 1e-6 });

  check("it says a low number does not mean a safe pass", () => {
    assert.match(diluted.means, /does not distinguish a clean pass from an unresolved one/i);
  });

  check("it does NOT claim better tracking would raise the probability", () => {
    // True only up to the peak, false beyond it. Stating it flatly would be
    // advice that is wrong for precisely the encounters that are well tracked.
    assert.ok(!/better tracking would (raise|increase)/i.test(diluted.means),
      "the copy makes an unconditional claim about improved tracking. Shrinking sigma "
      + "raises Pc only until d/sqrt(2) and lowers it after, so the honest statement is "
      + "bounded by the peak rather than open-ended");
  });

  check("it bounds the claim by the peak instead", () => {
    assert.match(diluted.means, /as high as the peak/i);
  });

  check("it admits the circular approximation", () => {
    assert.match(diluted.limits, /elongated along track|equivalent circular/i,
      "the real covariance is anisotropic; presenting a circular-equivalent regime call "
      + "as exact would be false precision");
  });
});

test("every assessment carries its regime, not just the alarming ones", () => {
  const enc = {
    rA: { x: 6871, y: 0, z: 0 }, vA: { x: 0, y: 7.6, z: 0 },
    rB: { x: 6871, y: 2.4, z: 0.3 }, vB: { x: 0.1, y: -7.5, z: 0.2 }
  };
  const a = pc.assess(enc, { ageDaysA: 1, ageDaysB: 1.5, kindA: "payload", kindB: "debris", hbrM: HBR_M });

  check("assess() reports it", () => {
    assert.ok(a.dilution && a.dilution.regime, JSON.stringify(a.dilution));
  });

  check("a typical TLE-screened encounter lands in the dilution region", () => {
    // Recording the expectation explicitly: this is the normal case for this
    // platform, not an edge case, and if it ever stops being true that is a
    // change worth noticing.
    assert.equal(a.dilution.regime, "dilution",
      `a representative 2.4 km encounter with TLE-scale covariance came out as `
      + `"${a.dilution.regime}". Either the covariance shrank dramatically or the regime `
      + "call broke; both are worth knowing about");
  });

  check("the reported probability is materially below what the geometry allows", () => {
    assert.ok(a.dilution.suppressionFactor > 2,
      `suppression factor ${a.dilution.suppressionFactor}: in the dilution region the peak `
      + "should sit well above the reported value");
  });

  console.log("# ──────────────────────────────────────────────");
  console.log(`#   ${passed} passed, ${failed} failed`);
  assert.equal(failed, 0);
});
