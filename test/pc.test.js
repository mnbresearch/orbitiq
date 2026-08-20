// ============================================================
// OrbitIQ physics tests.  node test/pc.test.js
//
// These check the maths against results that can be derived
// independently, not against whatever the code happened to print
// the first time it ran.
// ============================================================
import {
  ricBasis, ricComponents, covarianceModel, fosterPc, maxPc, pcBand,
  assess, alongTrackDrift, deltaVForSeparation, propellantKg, planManoeuvre
} from "../src/pc.js";

let pass = 0, fail = 0;
const approx = (a, b, tol, msg) => {
  const ok = Math.abs(a - b) <= tol;
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok  " : "  FAIL"}  ${msg}   got ${a}  want ${b} ±${tol}`);
};
const ok = (cond, msg) => {
  cond ? pass++ : fail++;
  console.log(`${cond ? "  ok  " : "  FAIL"}  ${msg}`);
};

console.log("\n── RIC frame ──────────────────────────────");
{
  // Circular orbit in the equatorial plane: r along +x, v along +y.
  const r = { x: 7000, y: 0, z: 0 };
  const v = { x: 0, y: 7.5, z: 0 };
  const { R, I, C } = ricBasis(r, v);
  approx(R.x, 1, 1e-9, "R̂ points along position");
  approx(I.y, 1, 1e-9, "Î points along velocity for a circular orbit");
  approx(C.z, 1, 1e-9, "Ĉ points along angular momentum (+z here)");

  // A secondary 1 km further out is purely radial.
  const comp = ricComponents(r, v, { x: 7001, y: 0, z: 0 });
  approx(comp.radialKm, 1, 1e-6, "purely radial offset resolves to radial");
  approx(comp.inTrackKm, 0, 1e-6, "…with no in-track component");
  approx(comp.crossTrackKm, 0, 1e-6, "…and no cross-track component");

  // 2 km ahead is purely in-track.
  const c2 = ricComponents(r, v, { x: 7000, y: 2, z: 0 });
  approx(c2.inTrackKm, 2, 1e-6, "purely along-track offset resolves to in-track");
  approx(c2.radialKm, 0, 1e-6, "…with no radial component");

  // 3 km out of plane is purely cross-track.
  const c3 = ricComponents(r, v, { x: 7000, y: 0, z: 3 });
  approx(c3.crossTrackKm, 3, 1e-6, "out-of-plane offset resolves to cross-track");

  // Range is frame-independent.
  const c4 = ricComponents(r, v, { x: 7001, y: 2, z: 3 });
  approx(c4.rangeKm, Math.sqrt(1 + 4 + 9), 1e-12, "range matches euclidean distance exactly (no rounding in the maths)");
}

console.log("\n── covariance model ───────────────────────");
{
  const fresh = covarianceModel(0, "payload");
  const old = covarianceModel(7, "payload");
  ok(old.sigmaI > fresh.sigmaI, "in-track uncertainty grows with element-set age");
  ok(fresh.sigmaI > fresh.sigmaR, "in-track dominates radial (SGP4 behaviour)");
  ok(fresh.sigmaI > fresh.sigmaC, "in-track dominates cross-track");
  const deb = covarianceModel(1, "DEBRIS");
  const pay = covarianceModel(1, "payload");
  ok(deb.sigmaI > pay.sigmaI, "debris carries larger uncertainty than payloads");
  ok(fresh.assumed === true, "model is flagged as an assumption, not a measurement");
}

console.log("\n── Foster Pc: analytic cross-checks ───────");
{
  // Head-on encounter: relative velocity along x, miss purely in +z.
  // With an isotropic covariance the encounter-plane integral reduces to
  //     Pc ≈ (R²/(2σ²))·exp(-d²/(2σ²))     for R ≪ σ
  const basis = ricBasis({ x: 7000, y: 0, z: 0 }, { x: 0, y: 7.5, z: 0 });
  const iso = { sigmaR: 0.5, sigmaI: 0.5, sigmaC: 0.5 };   // σ² each; combined = 0.5 km
  const zero = { sigmaR: 0, sigmaI: 0, sigmaC: 0 };
  const d = 1.0;                                            // km miss
  const R = 0.02;                                           // km hard-body (20 m)
  const miss = { x: 0, y: 0, z: d };
  const rel  = { x: 1, y: 0, z: 0 };
  const got = fosterPc(miss, rel, iso, zero, basis, R*1000);
  const sig = 0.5;
  const want = (R*R/(2*sig*sig)) * Math.exp(-(d*d)/(2*sig*sig));
  approx(got.pc, want, want*0.02, "matches the small-R analytic form within 2%");

  // Pc must fall as miss distance grows.
  const near = fosterPc({x:0,y:0,z:0.5}, rel, iso, zero, basis, 20).pc;
  const far  = fosterPc({x:0,y:0,z:5.0}, rel, iso, zero, basis, 20).pc;
  ok(near > far, "probability decreases with miss distance");

  // Pc must rise with hard-body radius, ∝ R² for small R.
  const p20 = fosterPc(miss, rel, iso, zero, basis, 20).pc;
  const p40 = fosterPc(miss, rel, iso, zero, basis, 40).pc;
  approx(p40/p20, 4, 0.1, "Pc scales as the square of hard-body radius");

  // Bounded to a probability.
  const huge = fosterPc({x:0,y:0,z:0}, rel, iso, zero, basis, 100000).pc;
  ok(huge >= 0 && huge <= 1, "probability stays within [0,1] even when absurd");
}

console.log("\n── maximum Pc bound ───────────────────────");
{
  // Pc_max = R²/(e·d²)
  const d = 1.0, R = 0.02;
  approx(maxPc(d, 20), (R*R)/(Math.E*d*d), 1e-12, "closed form R²/(e·d²)");
  ok(maxPc(0.5, 20) > maxPc(2.0, 20), "bound tightens as miss distance grows");

  // The bound must actually bound the modelled value, for any covariance.
  const basis = ricBasis({ x: 7000, y: 0, z: 0 }, { x: 0, y: 7.5, z: 0 });
  let violations = 0;
  for (const sig of [0.05, 0.1, 0.3, 1.0, 3.0, 10.0]) {
    for (const miss of [0.2, 0.5, 1.0, 3.0]) {
      const p = fosterPc({x:0,y:0,z:miss}, {x:1,y:0,z:0},
        { sigmaR:sig, sigmaI:sig, sigmaC:sig }, { sigmaR:0,sigmaI:0,sigmaC:0 },
        basis, 20).pc;
      if (p > maxPc(miss, 20) * 1.02) violations++;   // isotropic covariance: bound must hold
    }
  }
  ok(violations === 0, "modelled Pc never exceeds the analytic maximum (24 cases)");
}

console.log("\n── banding ────────────────────────────────");
{
  ok(pcBand(2e-3) === "CRITICAL",   "1e-3 and above is CRITICAL");
  ok(pcBand(2e-4) === "HIGH",       "1e-4 band is HIGH");
  ok(pcBand(2e-5) === "ELEVATED",   "1e-5 band is ELEVATED");
  ok(pcBand(2e-6) === "LOW",        "1e-6 band is LOW");
  ok(pcBand(1e-9) === "NEGLIGIBLE", "below 1e-6 is NEGLIGIBLE");
}

console.log("\n── manoeuvre physics ──────────────────────");
{
  // δs = 3·Δv·T   →   0.1 m/s for 24 h should open ~25.9 km
  const drift = alongTrackDrift(0.1, 24*3600);
  approx(drift, 3 * 0.0001 * 86400, 1e-9, "along-track drift follows 3·Δv·T");
  approx(drift, 25.92, 0.01, "0.1 m/s over 24 h opens ~25.9 km");

  // Inverse must round-trip.
  const dv = deltaVForSeparation(25.92, 24*3600);
  approx(dv, 0.1, 1e-6, "Δv solver inverts the drift relation");

  // Longer lead time is always cheaper.
  ok(deltaVForSeparation(5, 24*3600) < deltaVForSeparation(5, 6*3600),
     "more lead time costs less Δv for the same separation");

  // Rocket equation: small Δv on 260 kg at Isp 220 s
  const m = propellantKg(1.0, 260, 220);
  approx(m, 260*(1-Math.exp(-1/(220*9.80665))), 1e-9, "propellant from the rocket equation");
  ok(m > 0 && m < 1, "1 m/s on a 260 kg spacecraft costs well under 1 kg");
  ok(propellantKg(10, 260, 220) > propellantKg(1, 260, 220), "more Δv burns more propellant");
}

console.log("\n── end-to-end assessment ──────────────────");
{
  const rA = { x: 7000, y: 0, z: 0 }, vA = { x: 0, y: 7.5, z: 0 };
  const rB = { x: 7000, y: 0, z: 0.8 }, vB = { x: 0, y: -7.5, z: 0 };  // head-on
  const a = assess({ rA, vA, rB, vB }, { ageDaysA: 1, ageDaysB: 2, hbrM: 20 });
  approx(a.missKm, 0.8, 1e-6, "miss distance");
  approx(a.relVelKmS, 15, 1e-6, "relative velocity for a head-on pass");
  approx(a.ric.crossTrackKm, 0.8, 1e-6, "offset resolves to cross-track");
  ok(a.pc > 0 && a.pc < 1, "probability is a probability");
  ok(a.pcMaxIsotropic > 0, "assessment reports the isotropic reference bound");
  ok(a.pc > a.pcMaxIsotropic * 0.1 && a.pc < a.pcMaxIsotropic * 10,
     "modelled Pc sits within an order of magnitude of the isotropic reference");
  ok(a.covariance.primary.assumed, "assessment carries the covariance caveat");
  ok(typeof a.caveat === "string" && a.caveat.length > 20, "assessment carries an operational caveat");
}

console.log("\n── manoeuvre planning ─────────────────────");
{
  const rA = { x: 7000, y: 0, z: 0 }, vA = { x: 0, y: 7.5, z: 0 };
  const rB = { x: 7000.2, y: 0.3, z: 0.1 }, vB = { x: 0.1, y: -7.4, z: 0.05 };
  const p = planManoeuvre({ rA, vA, rB, vB }, { targetMissKm: 2, massKg: 260, ispS: 220 });
  ok(p.options.length === 4, "returns an option per lead time");
  ok(p.options.every(o => o.deltaVms >= 0), "no negative Δv");
  ok(p.options[0].deltaVms < p.options[3].deltaVms, "24 h lead is cheaper than 3 h");
  ok(p.options[0].propellantKg < p.options[3].propellantKg, "…and burns less propellant");
  ok(p.options.every(o => o.resultingMissKm >= p.currentInPlaneMissKm - 1e-6),
     "every option increases the in-plane miss distance");
  ok(p.options.every(o => o.pcAfter < p.currentPc),
     "every option strictly REDUCES probability of collision");
  ok(p.alongTrackEffectiveness >= 0 && p.alongTrackEffectiveness <= 1,
     "along-track effectiveness is a fraction");
  ok(typeof p.geometry === "string", "plan describes the encounter geometry");
  ok(typeof p.caveat === "string", "plan carries an operational caveat");
}

console.log("\n── manoeuvre: degenerate geometry ──────────");
{
  // Exactly head-on: relative velocity anti-parallel to the in-track axis,
  // so an along-track burn only changes arrival time, never separation.
  // The planner must say so rather than quote a Δv that would not help.
  const rA = { x: 7000, y: 0, z: 0 }, vA = { x: 0, y: 7.5, z: 0 };
  const rB = { x: 7000, y: 0, z: 0.5 }, vB = { x: 0, y: -7.5, z: 0 };
  const p = planManoeuvre({ rA, vA, rB, vB }, { targetMissKm: 5 });
  ok(p.alongTrackEffectiveness < 0.05, "recognises a head-on encounter as along-track-ineffective");
  ok(/head-on/i.test(p.geometry), "labels the geometry in plain language");
  ok(p.options.every(o => o.feasible === false), "marks every along-track option infeasible");
  ok(p.options.every(o => /radial or cross-track/i.test(o.note || "")),
     "recommends an out-of-plane alternative instead of a useless burn");
  ok(p.options.every(o => o.deltaVms === null), "quotes no Δv it cannot justify");

  // Overtaking is ALSO along-track dominated — relative velocity lies along
  // the track — so it must be recognised as ineffective too.
  const rC = { x: 7000, y: 0, z: 0 }, vC = { x: 0, y: 7.5, z: 0 };
  const rD = { x: 7002, y: 0, z: 0 }, vD = { x: 0, y: 7.6, z: 0 };
  const over = planManoeuvre({ rA: rC, vA: vC, rB: rD, vB: vD }, { targetMissKm: 5 });
  ok(over.alongTrackEffectiveness < 0.2,
     "overtaking is along-track dominated too, so also ineffective");

  // CROSSING geometry is where a tangential burn actually pays: an
  // equatorial primary meeting a polar secondary.
  const rE = { x: 7000, y: 0, z: 0 }, vE = { x: 0, y: 7.5, z: 0 };
  const rF = { x: 7000, y: 1.5, z: 0 }, vF = { x: 0, y: 0, z: 7.5 };
  const q = planManoeuvre({ rA: rE, vA: vE, rB: rF, vB: vF }, { targetMissKm: 5 });
  ok(q.alongTrackEffectiveness > 0.5, "recognises a crossing encounter as effective");
  ok(/crossing/i.test(q.geometry), "labels crossing geometry correctly");
  ok(q.options[0]?.deltaVms !== null && q.options[0].deltaVms < 50,
     "an effective geometry needs a modest burn");
  ok(q.options[0].pcAfter < q.currentPc, "and it reduces the probability");
}

console.log(`\n${"─".repeat(46)}\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
