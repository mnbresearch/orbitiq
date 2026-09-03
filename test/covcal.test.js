// ============================================================
// Covariance calibration.
//
// A measurement that feeds an exponential has to be right in a specific way:
// it must never come out too small. Pc goes as exp(-d^2 / 2 sigma^2), so a
// sigma that is too tight does not make the answer slightly wrong, it makes
// the answer "safe" by many orders of magnitude — which is the failure this
// whole system already had once, and fixed, and must not reintroduce through
// a side door labelled "empirical".
//
// So these tests are mostly about direction, not accuracy:
//
//   1. The RIC decomposition puts along-track drift in the along-track
//      component. If that is wrong every downstream number is wrong.
//   2. The robust scale ignores manoeuvres. The standard deviation does not,
//      which is why it is not used.
//   3. A calibration can only WIDEN sigma. Never narrow it. This is the
//      safety property the module is built around.
//   4. A negative fitted slope — "uncertainty shrinks as data ages" — is
//      clamped, because it is noise and it would tighten stale data.
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as cc from "../src/covcal.js";
import { covarianceModel } from "../src/pc.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const CAT = JSON.parse(fs.readFileSync(path.join(ROOT, "data/celestrak-active.sample.json"), "utf8"));

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log(`#   ok    ${name}`); }
  catch (e) { failed++; console.log(`#   FAIL  ${name}\n#         ${e.message}`); throw e; }
}

const iso = ms => new Date(ms).toISOString().replace("Z", "");

/**
 * A synthetic "later element set" for the same object.
 *
 * ── Why the tests below compare two of these rather than one against zero ──
 * The obvious test is "pair an element set with a perfectly consistent later
 * version of itself and expect no residual". That test was written first, and
 * it failed with a 149 km residual and 453 km of cross-track — which looked
 * like a bug in the RIC decomposition and was not.
 *
 * Hand-advancing MEAN_ANOMALY moves the object along its orbit but leaves
 * RA_OF_ASC_NODE and ARG_OF_PERICENTER untouched. Real orbits do not behave
 * that way: J2 regresses the node by several degrees a day in LEO, which at
 * 7000 km is hundreds of kilometres of cross-track. So the fixture was not a
 * consistent pair at all, and the "known answer" was not known.
 *
 * Rather than reimplement secular perturbations in a test — thereby testing
 * the test — the assertions use the DIFFERENCE between two residuals from the
 * same construction. Whatever the fixture gets wrong about J2 appears in both
 * and cancels, leaving only the offset that was deliberately injected. That
 * isolates the code under test, which is the point.
 */
function shifted(gp, { lagDays = 1, extraMeanAnomalyDeg = 0 }) {
  const t0 = cc.epochMs(gp);
  const revsPerDay = gp.MEAN_MOTION;
  const advanced = (gp.MEAN_ANOMALY + revsPerDay * 360 * lagDays + extraMeanAnomalyDeg) % 360;
  return {
    ...gp,
    EPOCH: iso(t0 + lagDays * 86400000),
    MEAN_ANOMALY: advanced < 0 ? advanced + 360 : advanced
  };
}

console.log("# ── covariance calibration ────────────────────");

test("the residual is decomposed into the frame it claims to use", () => {
  const gp = CAT.find(s => s.MEAN_MOTION > 14 && s.ECCENTRICITY < 0.01);

  check("a residual is produced at all, for a real GP record", () => {
    const r = cc.residual(gp, shifted(gp, { lagDays: 1 }));
    assert.ok(r, "no residual produced from a valid pair");
    assert.ok([r.radialKm, r.inTrackKm, r.crossTrackKm].every(Number.isFinite));
  });

  check("an injected along-track offset appears in the along-track component", () => {
    // 0.05 deg of mean anomaly on a ~6900 km orbit is roughly 6 km of arc.
    const base = cc.residual(gp, shifted(gp, { lagDays: 1 }));
    const off = cc.residual(gp, shifted(gp, { lagDays: 1, extraMeanAnomalyDeg: -0.05 }));
    const d = {
      R: off.radialKm - base.radialKm,
      I: off.inTrackKm - base.inTrackKm,
      C: off.crossTrackKm - base.crossTrackKm
    };
    const along = Math.abs(d.I);
    const offAxis = Math.hypot(d.R, d.C);
    assert.ok(along > 2, `along-track component only ${along.toFixed(3)} km`);
    assert.ok(offAxis < along * 0.2,
      `off-axis leakage ${offAxis.toFixed(3)} km against ${along.toFixed(3)} km along-track — `
      + "the RIC basis is not aligned with the orbit, so in-track and radial sigma are being "
      + "attributed to the wrong axes");
  });

  check("the lag is measured, not assumed", () => {
    const r = cc.residual(gp, shifted(gp, { lagDays: 2.5 }));
    assert.ok(Math.abs(r.lagDays - 2.5) < 1e-6, `lag came out ${r.lagDays}`);
  });
});

test("pairs that carry no information are refused rather than folded in", () => {
  const gp = CAT[0];

  check("a same-epoch pair is refused", () => {
    assert.equal(cc.residual(gp, gp), null,
      "a zero-lag pair would contribute a zero residual at lag zero and pull the fitted "
      + "intercept towards zero — that is, towards claiming certainty at epoch");
  });

  check("a reversed pair is refused, not silently absolute-valued", () => {
    const later = shifted(gp, { lagDays: 3 });
    assert.equal(cc.residual(later, gp), null,
      "propagating the NEWER set backwards is a different measurement from propagating the "
      + "older set forwards; folding them together would mix two populations");
  });
});

test("the scale estimate survives manoeuvres", () => {
  // 60 quiet residuals around 2 km, then three burns of a few hundred km.
  const quiet = Array.from({ length: 60 }, (_, i) => 2 + ((i % 7) - 3) * 0.25);
  const withBurns = [...quiet, 380, -420, 512];

  check("a handful of manoeuvres barely move the robust estimate", () => {
    const clean = cc.robustSigma(quiet);
    const dirty = cc.robustSigma(withBurns);
    assert.ok(Math.abs(dirty - clean) / clean < 0.25,
      `robust sigma moved from ${clean.toFixed(3)} to ${dirty.toFixed(3)} — the estimator is `
      + "not resistant, so a constellation doing station-keeping would set the covariance "
      + "for everyone");
  });

  check("the standard deviation would have been wrecked, which is why it is not used", () => {
    const sd = xs => {
      const m = xs.reduce((a, b) => a + b, 0) / xs.length;
      return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length);
    };
    assert.ok(sd(withBurns) > 8 * sd(quiet),
      "if the standard deviation were not badly distorted here, this fixture is not "
      + "exercising the property the estimator was chosen for");
  });

  check("the outlier fraction reports the contamination instead of hiding it", () => {
    const f = cc.outlierFraction(withBurns, cc.robustSigma(withBurns));
    assert.ok(f > 0 && f < 0.1, `outlier fraction ${f}`);
  });

  check("too small a sample returns null rather than a confident number", () => {
    assert.equal(cc.robustSigma([1, 2, 3]), null,
      "a sigma from three points would be published with the same authority as one from "
      + "three thousand");
  });
});

test("a calibration can only widen the covariance, never narrow it", () => {
  const modelled = covarianceModel(2, "payload");

  check("a tighter measurement is ignored", () => {
    const tiny = { sigmaR: 0.001, sigmaI: 0.002, sigmaC: 0.001 };
    const out = cc.applyFloor(modelled, tiny);
    assert.equal(out.sigmaR, modelled.sigmaR);
    assert.equal(out.sigmaI, modelled.sigmaI,
      "a measurement narrowed the covariance. Element sets agree with each other better "
      + "than either agrees with the truth, because they share the same systematic bias — "
      + "so a small measured spread is not evidence of a small error, and letting it "
      + "through would reproduce the over-confidence this system already shipped once");
    assert.equal(out.floorApplied, false);
  });

  check("a wider measurement wins, and says so", () => {
    const wide = { sigmaR: 99, sigmaI: 1, sigmaC: 1 };
    const out = cc.applyFloor(modelled, wide);
    assert.equal(out.sigmaR, 99, "the model stayed tighter than objects' own element sets");
    assert.equal(out.sigmaI, modelled.sigmaI, "an unaffected component was disturbed");
    assert.equal(out.floorApplied, true);
    assert.deepEqual(out.flooredComponents, ["sigmaR"]);
  });

  check("with no calibration the model is returned untouched", () => {
    const out = cc.applyFloor(modelled, null);
    assert.equal(out.sigmaI, modelled.sigmaI);
    assert.equal(out.calibration, "none");
  });

  check("the widened result explains itself and keeps the standing caveat", () => {
    const out = cc.applyFloor(modelled, { sigmaR: 99, sigmaI: 1, sigmaC: 1 });
    assert.match(out.note, /can only widen/i);
    assert.match(out.note, /understates true error/i,
      "the note must say the measurement is a lower bound; without that a reader takes "
      + "'measured' to mean 'accurate'");
  });
});

test("the fit refuses to claim uncertainty shrinks with age", () => {
  check("a negative slope is clamped to flat", () => {
    const bins = [
      { midLagDays: 0.25, n: 100, sigmaR: 5, sigmaI: 20, sigmaC: 5 },
      { midLagDays: 1.5, n: 100, sigmaR: 4, sigmaI: 10, sigmaC: 4 },
      { midLagDays: 6, n: 100, sigmaR: 3, sigmaI: 2, sigmaC: 3 }
    ];
    const fit = cc.fitLinear(bins);
    assert.ok(fit.sigmaI.b >= 0,
      `fitted slope ${fit.sigmaI.b}: a negative slope says a week-old element set is more `
      + "certain than a fresh one. It is small-sample noise, and extrapolating it would "
      + "hand the tightest covariance to the stalest data");
    assert.ok(fit.sigmaI.a >= 0, "negative intercept");
  });

  check("a real growing trend is preserved", () => {
    const bins = [
      { midLagDays: 0.25, n: 100, sigmaR: 1, sigmaI: 3, sigmaC: 1 },
      { midLagDays: 3, n: 100, sigmaR: 1.2, sigmaI: 12, sigmaC: 1.5 },
      { midLagDays: 8, n: 100, sigmaR: 1.4, sigmaI: 30, sigmaC: 2 }
    ];
    const fit = cc.fitLinear(bins);
    assert.ok(fit.sigmaI.b > 2, `slope ${fit.sigmaI.b} km/day is too flat for this fixture`);
    const s = cc.measuredSigma(fit, 5);
    assert.ok(s.sigmaI > s.sigmaR, "in-track should dominate");
  });

  check("a single bin cannot produce a fit", () => {
    const fit = cc.fitLinear([{ midLagDays: 1, n: 500, sigmaR: 1, sigmaI: 1, sigmaC: 1 }]);
    assert.equal(fit.sigmaI, null,
      "one point defines no slope; inventing one would extrapolate a line through a single "
      + "measurement out to fourteen days");
  });
});

test("end to end on real element sets", () => {
  // Two snapshots built from the shipped catalogue: the second is every object
  // moved along its own orbit by a day plus a small extra offset, so the
  // machinery runs over hundreds of genuine GP records with a known answer.
  const sample = CAT.filter(s => s.MEAN_MOTION > 11).slice(0, 300);
  const snapA = { at: "2026-08-14T00:00:00Z", byId: {} };
  const snapB = { at: "2026-08-15T00:00:00Z", byId: {} };
  for (const gp of sample) {
    snapA.byId[gp.NORAD_CAT_ID] = gp;
    snapB.byId[gp.NORAD_CAT_ID] = shifted(gp, { lagDays: 1, extraMeanAnomalyDeg: 0.02 });
  }
  const cal = cc.build([snapA, snapB]);

  check("it produces a calibration from real GP records", () => {
    assert.ok(cal.pairsUsable > 200, `only ${cal.pairsUsable} usable pairs of ${cal.pairsAttempted}`);
    assert.ok(cal.byKind.payload?.bins?.length, "no payload bins");
  });

  check("every reported bin is a real sample, not an extrapolation", () => {
    for (const [kind, k] of Object.entries(cal.byKind)) {
      for (const b of k.bins) {
        assert.ok(b.n >= 8, `${kind} bin ${b.lagFrom}-${b.lagTo} published on n=${b.n}`);
        assert.ok(b.sigmaR >= 0 && b.sigmaI >= 0 && b.sigmaC >= 0, "negative sigma");
        assert.ok(b.midLagDays >= b.lagFrom && b.midLagDays <= b.lagTo, "bin midpoint outside bin");
      }
    }
  });

  check("the fitted sigma never decreases with age", () => {
    const fit = cal.byKind.payload.fit;
    for (const comp of ["sigmaR", "sigmaI", "sigmaC"]) {
      if (!fit[comp]) continue;
      const near = cc.measuredSigma(fit, 0.5)[comp];
      const far = cc.measuredSigma(fit, 10)[comp];
      assert.ok(far >= near,
        `${comp} falls from ${near.toFixed(3)} at half a day to ${far.toFixed(3)} at ten days`);
    }
  });

  check("the published payload carries its own limits, unprompted", () => {
    assert.match(cal.limits, /not accuracy against the true orbit/i);
    assert.match(cal.limits, /LARGER than shown/,
      "the payload must state that true error exceeds this; it is the sentence that stops "
      + "'measured covariance' being read as 'known covariance'");
    assert.match(cal.usage, /floor/i);
  });
});

test("an implausible calibration is refused, in both places that can refuse it", async () => {
  const calibration = await import("../src/calibration.js");

  const sane = {
    version: "covcal-test", usable: true,
    byKind: { payload: { fit: { sigmaR: { a: 0.8, b: 0.05 }, sigmaI: { a: 3, b: 4 }, sigmaC: { a: 1, b: 0.1 } } } }
  };
  const inflated = JSON.parse(JSON.stringify(sane));
  inflated.byKind.payload.fit.sigmaI = { a: 5051, b: 135 };

  check("a sane calibration passes both checks", () => {
    assert.deepEqual(cc.implausible(sane.byKind), []);
    assert.equal(calibration.validate(sane), true);
  });

  check("an inflated one is named as implausible, with the reason", () => {
    const why = cc.implausible(inflated.byKind);
    assert.ok(why.length >= 2, JSON.stringify(why));
    assert.match(why.join(" "), /intercept 5051 km exceeds/);
  });

  check("the server refuses it even though the worker flagged it usable", () => {
    assert.equal(inflated.usable, true, "fixture should claim to be usable");
    assert.equal(calibration.validate(inflated), false,
      "the server trusted a `usable` flag fetched over the network. Inflating sigma is not "
      + "caught by the can-only-widen rule, because inflating IS widening — it would put "
      + "every conjunction above every threshold, and an alert that fires on everything is "
      + "ignored while everyone still believes someone is watching");
  });

  check("with no calibration applied the status says so in plain words", () => {
    calibration._set(null);
    const st = calibration.status();
    assert.equal(st.applied, false);
    assert.match(st.means, /modelled covariance alone/i);
  });

  check("a refused calibration never reaches the covariance", () => {
    const modelled = covarianceModel(3, "payload");
    const withBad = covarianceModel(3, "payload", calibration.validate(inflated) ? inflated : null);
    assert.equal(withBad.sigmaI, modelled.sigmaI);
    assert.equal(withBad.calibration, "none");
  });

  console.log("# ──────────────────────────────────────────────");
  console.log(`#   ${passed} passed, ${failed} failed`);
  assert.equal(failed, 0);
});
