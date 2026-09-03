// ============================================================
// Covariance calibration — measuring what the model asserts.
//
// ── The problem this exists to fix ──────────────────────────
// Every collision probability this system publishes depends on a covariance,
// and TLEs do not carry one. So `covarianceModel()` in pc.js invents one from
// published descriptions of SGP4 error growth. It is labelled an assumption
// everywhere it surfaces, which is honest, but it is still a formula somebody
// wrote down rather than a number anybody measured.
//
// That matters more here than it would elsewhere, because Pc goes as
// exp(-d^2 / 2 sigma^2). A 20% error in sigma is not a 20% error in Pc; it can
// be orders of magnitude. The first technically competent reviewer an
// underwriter puts on this will ask exactly one question: where does sigma
// come from? "A formula I wrote from the literature" is a survivable answer.
// "Measured from N observed element-set pairs, and here is the method" is a
// much better one.
//
// ── The method ──────────────────────────────────────────────
// For one object, take the element set published at epoch t0 and the set
// published later at epoch t1. Propagate the OLD set forward to t1 and compare
// it with where the NEW set says the object was at t1. The difference,
// decomposed in the RIC frame, is how far the older element set had drifted
// from the newer one over a lag of (t1 - t0).
//
// Do that across thousands of pairs, bin by lag, and the spread of the
// residuals is an empirical picture of how fast a TLE-derived position goes
// stale — which is precisely what the covariance model claims to describe.
//
// ── What this measurement is NOT ────────────────────────────
// This is the part that must never be lost, because it is the part that makes
// the number honest.
//
// It measures element-set CONSISTENCY, not accuracy. Both sets come from the
// same sensor network and the same fitting process, so they share systematic
// biases, and a shared bias cancels in the difference. The true error against
// the actual object is therefore LARGER than this measures — how much larger
// is not knowable from public data at all.
//
// So the measurement is used in one direction only: as a FLOOR. If the model
// is wider than the measurement, the model stands. If the model is TIGHTER
// than the measurement, the model is provably over-confident — no argument
// about shared bias can rescue it, because the sets do not even agree with
// each other that well — and the measurement replaces it.
//
// A calibration can widen sigma. It can never narrow it. That asymmetry is
// enforced in code and pinned by a test, because it is the only thing that
// makes it safe to feed a noisy empirical estimate into an exponential.
//
// ── The other contamination, pointing the other way ─────────
// Manoeuvres. When a payload burns between t0 and t1, the residual is a real
// manoeuvre, not uncertainty, and it can be hundreds of kilometres. That
// inflates the spread rather than shrinking it.
//
// So the two contaminations push in opposite directions: shared bias makes
// this an underestimate, manoeuvres make it an overestimate. Neither is
// correctable from public data. The response is robust statistics — median
// and MAD rather than mean and standard deviation, so a minority of large
// manoeuvre residuals cannot drag the estimate — plus reporting the outlier
// fraction openly so a reader can judge the contamination for themselves.
// ============================================================
import * as satellite from "satellite.js";
import { ricBasis, sub, dot, kindOf } from "./orbitstate.js";

export const CALIBRATION_VERSION = "covcal-v1-2026-09";

/**
 * Lag bins, in days.
 *
 * Bounded at 14 days because beyond that the pair population is dominated by
 * objects nobody is tracking often — which is a statement about tasking
 * priority, not about propagation error. Fine-grained early because that is
 * where operational conjunctions live: a warning at T-6h is screened against
 * element sets hours to a couple of days old.
 */
export const LAG_BINS = [
  [0, 0.5], [0.5, 1], [1, 2], [2, 3], [3, 5], [5, 7], [7, 10], [10, 14]
];


/** Epoch of a GP element set, ms. Null when unparseable. */
export function epochMs(gp) {
  const e = gp?.EPOCH || gp?.epoch;
  if (!e) return null;
  // CelesTrak GP JSON gives epochs without a zone; they are UTC.
  const t = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(String(e)) ? e : e + "Z").getTime();
  return Number.isFinite(t) ? t : null;
}

function stateAtMs(gp, ms) {
  try {
    const rec = satellite.json2satrec(gp);
    const pv = satellite.propagate(rec, new Date(ms));
    if (!pv?.position || Number.isNaN(pv.position.x)) return null;
    if (!pv?.velocity || Number.isNaN(pv.velocity.x)) return null;
    return { r: pv.position, v: pv.velocity };
  } catch { return null; }
}

/**
 * One residual: how far the older element set had drifted from the newer one
 * by the time the newer one was published.
 *
 * Evaluated at the NEW set's epoch, which is the moment the new set is most
 * trustworthy — it is the fit point. Decomposed in the new state's RIC frame,
 * so the components mean the same thing they mean in the covariance model.
 */
export function residual(gpOld, gpNew) {
  const t0 = epochMs(gpOld), t1 = epochMs(gpNew);
  if (t0 == null || t1 == null) return null;
  const lagDays = (t1 - t0) / 86400000;
  // Same-epoch pairs carry no information, and a negative lag means the
  // arguments are the wrong way round — refuse rather than silently take
  // the absolute value, which would fold two different things together.
  if (!(lagDays > 0)) return null;

  const sNew = stateAtMs(gpNew, t1);
  const sOld = stateAtMs(gpOld, t1);
  if (!sNew || !sOld) return null;

  const { R, I, C } = ricBasis(sNew.r, sNew.v);
  const d = sub(sOld.r, sNew.r);
  const out = {
    lagDays,
    radialKm: dot(d, R),
    inTrackKm: dot(d, I),
    crossTrackKm: dot(d, C)
  };
  // SGP4 diverges for decayed or badly conditioned element sets and returns
  // finite but absurd positions. A residual of thousands of km is not a
  // measurement of anything.
  if (![out.radialKm, out.inTrackKm, out.crossTrackKm].every(Number.isFinite)) return null;
  return out;
}

// ── Robust scale ──────────────────────────────────────────
//
// Not the standard deviation. Residual distributions here have heavy tails —
// manoeuvres, decaying objects, occasional bad element sets — and one 400 km
// manoeuvre residual in a sample of 500 moves the standard deviation more than
// all the other 499 combined. The median absolute deviation, scaled by 1.4826
// to match sigma for a normal distribution, ignores it.

export function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function robustSigma(xs) {
  if (xs.length < 8) return null;              // too few to say anything
  const med = median(xs);
  const mad = median(xs.map(x => Math.abs(x - med)));
  return mad == null ? null : 1.4826 * mad;
}

/** Share of residuals beyond 5 robust sigma — the manoeuvre/junk fraction. */
export function outlierFraction(xs, sigma) {
  if (!sigma || !xs.length) return null;
  const med = median(xs);
  return +(xs.filter(x => Math.abs(x - med) > 5 * sigma).length / xs.length).toFixed(4);
}

/**
 * Aggregate residuals into per-kind, per-lag-bin sigma estimates.
 *
 * Split by kind because the model already claims debris degrades faster than
 * payloads (a 2.2x multiplier). That claim is checkable, and checking it is
 * worth more than assuming it.
 */
export function aggregate(residuals) {
  const kinds = {};
  for (const r of residuals) {
    const k = r.kind || "payload";
    (kinds[k] ||= []).push(r);
  }

  const out = {};
  for (const [kind, rows] of Object.entries(kinds)) {
    const bins = [];
    for (const [lo, hi] of LAG_BINS) {
      const inBin = rows.filter(r => r.lagDays >= lo && r.lagDays < hi);
      if (inBin.length < 8) continue;
      const R = inBin.map(r => r.radialKm);
      const I = inBin.map(r => r.inTrackKm);
      const C = inBin.map(r => r.crossTrackKm);
      const sR = robustSigma(R), sI = robustSigma(I), sC = robustSigma(C);
      if (sR == null || sI == null || sC == null) continue;
      bins.push({
        lagFrom: lo, lagTo: hi,
        midLagDays: +((lo + hi) / 2).toFixed(3),
        n: inBin.length,
        sigmaR: +sR.toFixed(4), sigmaI: +sI.toFixed(4), sigmaC: +sC.toFixed(4),
        outlierFractionInTrack: outlierFraction(I, sI)
      });
    }
    out[kind] = { bins, fit: fitLinear(bins), pairs: rows.length };
  }
  return out;
}

/**
 * Least-squares straight line through the binned sigmas, weighted by bin count.
 *
 * A line, because that is the shape the model already uses (sigma = a + b*age)
 * and the point of this exercise is to check the model's own coefficients
 * against data — not to swap in some other functional form whose parameters
 * nobody can compare. Slope is clamped at zero: a NEGATIVE slope would say
 * position uncertainty shrinks as an element set ages, which is not a physical
 * result, it is small-sample noise, and letting it through would narrow sigma
 * for stale data.
 */
export function fitLinear(bins) {
  const fitOne = key => {
    const pts = bins.filter(b => Number.isFinite(b[key]));
    if (pts.length < 2) return null;
    const W = pts.reduce((s, b) => s + b.n, 0);
    const mx = pts.reduce((s, b) => s + b.n * b.midLagDays, 0) / W;
    const my = pts.reduce((s, b) => s + b.n * b[key], 0) / W;
    const sxx = pts.reduce((s, b) => s + b.n * (b.midLagDays - mx) ** 2, 0);
    const sxy = pts.reduce((s, b) => s + b.n * (b.midLagDays - mx) * (b[key] - my), 0);
    const slope = sxx > 0 ? Math.max(0, sxy / sxx) : 0;
    const intercept = Math.max(0, my - slope * mx);
    return { a: +intercept.toFixed(4), b: +slope.toFixed(4), bins: pts.length, n: W };
  };
  return { sigmaR: fitOne("sigmaR"), sigmaI: fitOne("sigmaI"), sigmaC: fitOne("sigmaC") };
}

// ── Plausibility bounds ───────────────────────────────────
//
// "A calibration can only widen sigma" makes it safe against the failure that
// already happened once here: a covariance too tight, and a probability of
// collision that says "safe" when it is not.
//
// It does NOT make it safe against garbage. A bad catalogue day, a decayed
// object population, or a bug in this file could fit sigma_I = 5000 km, and
// because that is wider than the model it would sail straight through the
// floor and into production, where it would put every conjunction in the
// catalogue above every sensible threshold.
//
// That is not the conservative direction. An alerting system that fires on
// everything gets switched off, or worse, gets ignored while still switched
// on — and a warning nobody reads is not safer than no warning, it is less
// safe, because everyone believes someone is watching.
//
// So there is a ceiling as well as a floor. The values below are generous
// against published TLE error characterisations (a few km at epoch, tens of
// km across a week); anything beyond them is not a measurement of element-set
// consistency, it is a symptom.
//
// When the ceiling trips the calibration is REJECTED ENTIRELY rather than
// clamped to the bound. A fit that came out five times too large is not
// trustworthy just below the ceiling either; the honest response is to fall
// back to the model and say so.
export const PLAUSIBILITY = {
  sigmaR: { maxIntercept: 10, maxSlope: 5 },
  sigmaI: { maxIntercept: 25, maxSlope: 25 },
  sigmaC: { maxIntercept: 10, maxSlope: 5 }
};

/** Reasons a calibration should not be applied. Empty array means it is fine. */
export function implausible(byKind) {
  const reasons = [];
  for (const [kind, k] of Object.entries(byKind || {})) {
    for (const [comp, lim] of Object.entries(PLAUSIBILITY)) {
      const f = k?.fit?.[comp];
      if (!f) continue;
      if (f.a > lim.maxIntercept) {
        reasons.push(
          `${kind}.${comp} intercept ${f.a} km exceeds ${lim.maxIntercept} km — element sets `
          + "at epoch do not disagree by that much, so this is contamination or a bug");
      }
      if (f.b > lim.maxSlope) {
        reasons.push(
          `${kind}.${comp} slope ${f.b} km/day exceeds ${lim.maxSlope} km/day — faster than `
          + "any published characterisation of TLE degradation");
      }
    }
  }
  return reasons;
}

/** Measured sigma at a given age, from a fit. Null when the fit is missing. */
export function measuredSigma(fit, ageDays) {
  if (!fit) return null;
  const at = f => (f ? Math.max(0, f.a + f.b * Math.max(0, ageDays)) : null);
  const sigmaR = at(fit.sigmaR), sigmaI = at(fit.sigmaI), sigmaC = at(fit.sigmaC);
  if (sigmaR == null || sigmaI == null || sigmaC == null) return null;
  return { sigmaR, sigmaI, sigmaC };
}

/**
 * Build the published calibration payload from a set of dated snapshots.
 *
 * @param snapshots  [{ at, byId: { [noradId]: gpRecord } }] oldest first
 * @param opts.maxPairsPerObject  cap so a frequently-updated object cannot
 *        dominate the sample. Tasking frequency correlates with orbit regime
 *        and object importance, so an uncapped sample would silently become a
 *        sample of "things the sensor network cares about most".
 */
export function build(snapshots, { maxPairsPerObject = 6 } = {}) {
  const residuals = [];
  const seenIds = new Set();
  let attempted = 0, usable = 0;

  // Index every distinct element set per object, by epoch. The same TLE
  // appears in many daily snapshots until it is superseded, so pairing
  // snapshots directly would generate mostly zero-lag duplicates.
  const byObject = new Map();
  for (const snap of snapshots) {
    for (const [id, gp] of Object.entries(snap.byId || {})) {
      const t = epochMs(gp);
      if (t == null) continue;
      const m = byObject.get(id) || new Map();
      if (!m.has(t)) m.set(t, gp);
      byObject.set(id, m);
    }
  }

  for (const [id, byEpoch] of byObject) {
    const sets = [...byEpoch.entries()].sort((a, b) => a[0] - b[0]).map(e => e[1]);
    if (sets.length < 2) continue;
    seenIds.add(id);
    let made = 0;
    for (let i = 0; i + 1 < sets.length && made < maxPairsPerObject; i++) {
      attempted++;
      const r = residual(sets[i], sets[i + 1]);
      if (!r) continue;
      r.kind = kindOf({ name: sets[i + 1].OBJECT_NAME || sets[i + 1].name });
      residuals.push(r);
      usable++;
      made++;
    }
  }

  const byKind = aggregate(residuals);
  const implausibleReasons = implausible(byKind);
  return {
    plausible: implausibleReasons.length === 0,
    implausibleReasons,
    version: CALIBRATION_VERSION,
    generatedAt: new Date().toISOString(),
    snapshots: snapshots.length,
    snapshotSpanDays: snapshots.length > 1
      ? +((new Date(snapshots.at(-1).at) - new Date(snapshots[0].at)) / 86400000).toFixed(2)
      : 0,
    objectsWithMultipleElementSets: seenIds.size,
    pairsAttempted: attempted,
    pairsUsable: usable,
    byKind,
    method:
      "For each object, successive published element sets are paired. The older set is "
      + "propagated to the newer set's epoch and the position difference is decomposed in "
      + "the RIC frame of the newer state. Spread is summarised with the median absolute "
      + "deviation scaled by 1.4826, not the standard deviation, so that manoeuvres and "
      + "bad element sets in the tail cannot dominate. A weighted straight line is fitted "
      + "through the binned values, with the slope clamped at zero.",
    limits:
      "This measures agreement between successive element sets, not accuracy against the "
      + "true orbit. Both sets come from the same sensor network and fitting process, so "
      + "shared systematic error cancels in the difference and the true uncertainty is "
      + "LARGER than shown — by an amount public data cannot reveal. In the other "
      + "direction, manoeuvres between the two epochs appear as residuals and inflate the "
      + "spread. Because of the first effect these figures are used only as a lower bound: "
      + "they can widen the covariance used for probability of collision, never narrow it.",
    usage:
      "Applied as a floor. Where the modelled sigma is already wider, the model stands. "
      + "Where the model is tighter than objects' own element sets agree with each other, "
      + "the model is over-confident and the measured value is used instead."
  };
}

/**
 * Combine the modelled and measured sigmas.
 *
 * The whole safety argument of this module is the one line doing Math.max.
 * Everything else is bookkeeping so a reader can see which side won and why.
 */
export function applyFloor(modelled, measured) {
  if (!measured) return { ...modelled, calibration: "none", floorApplied: false };
  const pick = k => Math.max(modelled[k], measured[k]);
  const floored = ["sigmaR", "sigmaI", "sigmaC"].filter(k => measured[k] > modelled[k]);
  return {
    ...modelled,
    sigmaR: +pick("sigmaR").toFixed(4),
    sigmaI: +pick("sigmaI").toFixed(4),
    sigmaC: +pick("sigmaC").toFixed(4),
    calibration: CALIBRATION_VERSION,
    floorApplied: floored.length > 0,
    flooredComponents: floored,
    measured: {
      sigmaR: +measured.sigmaR.toFixed(4),
      sigmaI: +measured.sigmaI.toFixed(4),
      sigmaC: +measured.sigmaC.toFixed(4)
    },
    note: floored.length
      ? "Modelled 1-sigma, widened where published element sets for this class of object "
      + "disagree with each other by more than the model allowed. A measurement can only "
      + "widen this covariance, never narrow it: element-set agreement understates true "
      + "error because both sets share the same systematic bias."
      : modelled.note
  };
}
