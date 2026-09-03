// ============================================================
// OrbitIQ — conjunction geometry and probability of collision.
//
// Three things live here, and the distinction matters:
//
//   1. RIC decomposition of the miss vector. Pure geometry, exact.
//   2. Foster's 2D Pc, integrated over the encounter plane. Exact given
//      a covariance.
//   3. A covariance MODEL, because TLEs do not carry covariance. This is
//      an assumption, it is labelled as one everywhere it surfaces, and
//      the maximum-Pc bound below is reported alongside it so a reader
//      can see the worst case without trusting our model at all.
//
// Reference points:
//   Foster & Estes (1992), NASA JSC-25898 — encounter-plane Pc
//   Alfano (2005) — relative-motion collision analysis
//   Chan (2008), "Spacecraft Collision Probability"
// ============================================================

const MU = 398600.4418;      // km^3/s^2
import { EARTH_R_KM as EARTH_R } from "./constants.js";

// Vector helpers and the RIC basis live in orbitstate.js, so that covcal.js
// can measure residuals in the same frame this file turns into probabilities
// without an import cycle. Re-exported because callers have always imported
// ricBasis from here.
import { sub, dot, cross, norm, unit, ricBasis } from "./orbitstate.js";
import { applyFloor, measuredSigma } from "./covcal.js";
export { ricBasis };

/** Miss vector expressed in the primary's RIC frame. Kilometres. */
export function ricComponents(rA, vA, rB) {
  const { R, I, C } = ricBasis(rA, vA);
  const d = sub(rB, rA);
  return {
    radialKm:     dot(d, R),
    inTrackKm:    dot(d, I),
    crossTrackKm: dot(d, C),
    rangeKm:      norm(d)
  };
}

// ============================================================
// Covariance model
// ============================================================
/**
 * Position uncertainty for a TLE-derived state, 1-sigma, in the RIC frame.
 *
 * TLEs carry no covariance, so this is a model, not a measurement. It is
 * built on the well-documented behaviour of SGP4 error growth: in-track
 * error dominates and grows roughly linearly with the age of the element
 * set, while radial and cross-track stay comparatively small.
 *
 * Debris and small objects are tracked less often and less precisely, so
 * they carry a multiplier.
 *
 * @param ageDays   age of the element set
 * @param kind      "payload" | "debris" | "rocket body" | unknown
 * @returns {sigmaR, sigmaI, sigmaC} in km, 1-sigma
 */
export const PC_MODEL_VERSION = "cov-v2-2026-09";

/**
 * Modelled 1-sigma position uncertainty for a TLE-derived state, in RIC.
 *
 * ── Why v2 exists: v1 was far too confident ─────────────────
 * v1 assumed sigmaR 120 m and sigmaC 150 m at epoch. That is roughly 5x
 * tighter than any published assessment of TLE accuracy, and because Pc goes
 * as exp(-d^2 / 2 sigma^2) the error is not proportional — it is exponential.
 * A real archived conjunction (2.431 km miss) came out at Pc 4.06e-40 under
 * v1. The same geometry with a defensible sigma is ~1e-5. Thirty-five orders
 * of magnitude, all in the direction of saying "safe".
 *
 * ── What v2 is based on ─────────────────────────────────────
 * Published SGP4/TLE error characterisations agree on the shape:
 *   - total position error at epoch is on the order of a few km (~3 km),
 *   - the along-track (I) component dominates and grows fastest, reaching
 *     tens of km within a few days,
 *   - the radial (R) component stays roughly constant over a week,
 *   - the cross-track (C) component grows only slightly.
 * So v2 pins epoch values that sum to ~2.8 km RSS, keeps R nearly flat, lets
 * C drift, and gives I the steep growth (2.5 + 3.0/day, so ~23 km at 7 days).
 *
 * ── Direction of error is deliberate ────────────────────────
 * Where the literature gives a range, v2 takes the pessimistic end. An
 * over-wide covariance produces a Pc that is too HIGH, which costs an
 * operator an unnecessary look. An over-tight one produces a Pc that is too
 * LOW, which costs them the conjunction. Those are not symmetric.
 *
 * Still an assumption, not a measurement: a TLE carries no covariance, and
 * this must never be presented as an operator-supplied one.
 */
export function covarianceModel(ageDays = 1, kind = "payload", calibration = null) {
  const age = Math.max(0, Math.min(ageDays, 30));
  // Debris and spent stages are tracked less often and tumble, so their
  // element sets degrade faster than an actively maintained payload's.
  const k = /deb/i.test(kind) ? 2.2 : /r\/b|rocket/i.test(kind) ? 1.5 : 1.0;
  const modelled = {
    sigmaR: +(k * (0.70 + 0.02 * age)).toFixed(4),   // near-flat with age
    sigmaI: +(k * (2.50 + 3.00 * age)).toFixed(4),   // dominant, steep
    sigmaC: +(k * (0.90 + 0.08 * age)).toFixed(4),   // slight growth
    ageDays: +age.toFixed(2),
    kind,
    assumed: true,
    model: PC_MODEL_VERSION,
    note: "TLEs carry no covariance. Modelled 1-sigma from published SGP4 error growth "
        + "(~3 km at epoch, in-track dominant), taken at the pessimistic end. NOT an "
        + "operator-supplied covariance."
  };
  if (!calibration) return applyFloor(modelled, null);

  // ── Applying the measurement ────────────────────────────
  // A calibration measured from real element sets can raise these numbers and
  // cannot lower them. The comparison itself is applyFloor() in covcal.js —
  // deliberately one implementation, not one here and one there, because two
  // copies of a covariance rule is how the archive and the live API ended up
  // publishing different probabilities for the same conjunction.
  const kindFit = calibration.byKind?.[kind]?.fit
    // An unclassified object falls back to the WIDEST available profile
    // rather than the narrowest — the same direction of caution the model
    // itself takes.
    || calibration.byKind?.debris?.fit
    || calibration.byKind?.payload?.fit;

  return applyFloor(modelled, kindFit ? measuredSigma(kindFit, age) : null);
}

/**
 * Below this, a Pc computed from a MODELLED covariance carries no information.
 *
 * Pc is exponential in (miss/sigma). With sigma assumed rather than measured,
 * the difference between 1e-12 and 1e-40 is not a statement about the sky, it
 * is a statement about the assumption — a 20% change in sigma moves it by many
 * orders. Reporting those digits would be false precision, so anything below
 * the floor is published as "< 1e-8" and flagged.
 */
export const PC_FLOOR = 1e-8;

// ============================================================
// Foster 2D probability of collision
// ============================================================
/**
 * Probability that two objects come within a combined hard-body radius,
 * integrated over the encounter plane.
 *
 * Short-encounter assumption: relative motion is a straight line through
 * the conjunction, so the 3D problem collapses onto the plane normal to
 * the relative velocity. Both covariances are summed (they are
 * independent) and projected onto that plane.
 *
 * @param missVec  relative position at TCA, ECI km   {x,y,z}
 * @param relVel   relative velocity at TCA, ECI km/s {x,y,z}
 * @param covA     {sigmaR,sigmaI,sigmaC} km for primary
 * @param covB     {sigmaR,sigmaI,sigmaC} km for secondary
 * @param basisA   RIC basis of the primary (covariances are given in it)
 * @param hbrM     combined hard-body radius, metres
 */
export function fosterPc(missVec, relVel, covA, covB, basisA, hbrM = 20) {
  const R = hbrM / 1000;                       // km
  const vrel = unit(relVel);

  // Encounter-plane basis: any two orthonormal vectors ⟂ relative velocity.
  let seed = Math.abs(vrel.x) < 0.9 ? { x:1,y:0,z:0 } : { x:0,y:1,z:0 };
  const e1 = unit(cross(vrel, seed));
  const e2 = cross(vrel, e1);                  // unit: vrel ⟂ e1

  // Combined covariance in RIC, as a diagonal matrix (RIC axes assumed
  // to be the principal axes — standard for this class of model).
  const varR = covA.sigmaR**2 + covB.sigmaR**2;
  const varI = covA.sigmaI**2 + covB.sigmaI**2;
  const varC = covA.sigmaC**2 + covB.sigmaC**2;

  // Project: variance along an arbitrary unit vector u is
  //   uᵀ Σ u = varR(u·R̂)² + varI(u·Î)² + varC(u·Ĉ)²
  const projVar = u =>
    varR * dot(u, basisA.R)**2 +
    varI * dot(u, basisA.I)**2 +
    varC * dot(u, basisA.C)**2;
  const projCov = (u, w) =>
    varR * dot(u, basisA.R) * dot(w, basisA.R) +
    varI * dot(u, basisA.I) * dot(w, basisA.I) +
    varC * dot(u, basisA.C) * dot(w, basisA.C);

  let s11 = projVar(e1), s22 = projVar(e2), s12 = projCov(e1, e2);

  // Rotate the 2D covariance to its principal axes.
  const tr = s11 + s22, det = s11*s22 - s12*s12;
  const disc = Math.max(0, tr*tr/4 - det);
  const l1 = tr/2 + Math.sqrt(disc);
  const l2 = Math.max(tr/2 - Math.sqrt(disc), 1e-12);
  const theta = Math.abs(s12) < 1e-14 ? 0 : 0.5 * Math.atan2(2*s12, s11 - s22);

  // Miss vector in the encounter plane, then in principal axes.
  const m1 = dot(missVec, e1), m2 = dot(missVec, e2);
  const ct = Math.cos(theta), st = Math.sin(theta);
  const x0 =  m1*ct + m2*st;
  const y0 = -m1*st + m2*ct;

  const sx = Math.sqrt(l1), sy = Math.sqrt(l2);

  // Integrate the 2D gaussian over the disc of radius R, in polar
  // coordinates centred on the disc. Adaptive resolution: the integrand
  // is smooth, so a modest grid converges well.
  const NR = 64, NT = 128;
  let acc = 0;
  for (let i = 0; i < NR; i++) {
    const r0 = (i / NR) * R, r1 = ((i+1) / NR) * R;
    const rm = 0.5*(r0 + r1), dr = r1 - r0;
    for (let j = 0; j < NT; j++) {
      const th = (j + 0.5) / NT * 2 * Math.PI;
      const px = rm * Math.cos(th) - x0;
      const py = rm * Math.sin(th) - y0;
      const e = -0.5 * ((px*px)/(sx*sx) + (py*py)/(sy*sy));
      acc += Math.exp(e) * rm * dr * (2*Math.PI/NT);
    }
  }
  const pc = acc / (2 * Math.PI * sx * sy);
  return {
    pc: Math.min(Math.max(pc, 0), 1),
    sigmaXKm: +sx.toFixed(4),
    sigmaYKm: +sy.toFixed(4),
    missInPlaneKm: +Math.hypot(x0, y0).toFixed(4),
    hbrM
  };
}

/**
 * Maximum probability over all ISOTROPIC covariance scalings.
 *
 *   Pc_max = R² / (e · d²)
 *
 * Derivation: for a circular covariance σ, Pc ≈ (R²/2σ²)·exp(-d²/2σ²).
 * Setting dPc/dσ = 0 gives σ² = d²/2, and substituting back yields the
 * expression above.
 *
 * Note the scope carefully: this bounds the spherical case, which is the
 * conventional screening reference. It is NOT an upper bound over
 * arbitrary elliptical covariances — a sufficiently flattened covariance
 * can exceed it — so it is reported as a reference value, never used to
 * clamp or override the modelled probability.
 */
export function maxPc(missKm, hbrM = 20) {
  const R = hbrM / 1000;
  const d = Math.max(missKm, 1e-6);
  return Math.min(1, (R*R) / (Math.E * d*d));
}

// ============================================================
// Probability dilution
// ============================================================
/**
 * Which side of the probability maximum an encounter sits on.
 *
 * ── The trap ────────────────────────────────────────────────
 * Pc is not monotonic in uncertainty. For a fixed geometry it rises as sigma
 * grows, peaks, and then falls away again. Differentiating the 2D form gives
 * the peak at
 *
 *     sigma* = d / sqrt(2)
 *
 * and the value there is R^2 / (e d^2) — which is exactly the isotropic bound
 * maxPc() already computes. Past that peak, MORE uncertainty produces a LOWER
 * probability. This is probability dilution, and it is the classic way a
 * conjunction assessment reassures somebody about an encounter nobody
 * actually understands.
 *
 * ── Why it matters here more than most places ───────────────
 * This system screens from public element sets, so sigma is modelled and
 * large — kilometres at epoch, tens of kilometres within days. Miss distances
 * that matter are a few kilometres, so sigma* is on the order of 1-3 km while
 * the actual sigma is often five to twenty times that. In other words this
 * platform sits deep in the dilution region for a large share of what it
 * screens, and a small Pc there is a statement about our ignorance rather
 * than about the sky.
 *
 * That is the same failure direction as the covariance bug this system
 * already shipped once: a number that says "safe" when it means "unknown".
 * The difference is that this one cannot be fixed by a better model, because
 * it is a property of the estimator and not an error in it. So it is measured
 * and declared instead.
 *
 * ── What is deliberately NOT claimed ────────────────────────
 * Not "better tracking would raise this probability". Shrinking sigma raises
 * Pc only until sigma*, after which it falls again — a precisely known 3 km
 * miss is a confident miss, with a genuinely tiny Pc. So the honest statement
 * is bounded: with ideal knowledge FOR THIS GEOMETRY the probability could be
 * as high as the peak value, and the reported figure does not distinguish a
 * clean pass from an unresolved one.
 */
export const dilutionRegime = ratio =>
  ratio >= 1.3 ? "dilution" : ratio <= 0.77 ? "resolved" : "near-peak";

export function dilution({ missInPlaneKm, sigmaXKm, sigmaYKm, hbrM = 20, pc = null }) {
  const d = Math.max(Number(missInPlaneKm) || 0, 1e-6);
  // Equivalent circular sigma: the geometric mean preserves the area of the
  // covariance ellipse, which is what sets the probability density scale.
  const sigmaEff = Math.sqrt(Math.max(sigmaXKm, 1e-9) * Math.max(sigmaYKm, 1e-9));
  const sigmaPeak = d / Math.SQRT2;
  const ratio = sigmaEff / sigmaPeak;
  const regime = dilutionRegime(ratio);
  const peak = maxPc(d, hbrM);

  // How far the reported probability sits below the most this geometry could
  // ever produce. In the dilution region this is the number that matters:
  // it is the size of the gap that uncertainty alone is responsible for.
  const suppression = (pc != null && pc > 0 && peak > 0) ? peak / pc : null;

  return {
    regime,
    sigmaEffectiveKm: +sigmaEff.toFixed(4),
    sigmaAtPeakKm: +sigmaPeak.toFixed(4),
    ratio: +ratio.toFixed(2),
    pcAtPeak: peak,
    suppressionFactor: suppression == null ? null : +suppression.toPrecision(3),
    means: {
      dilution:
        "The position uncertainty is larger than the value that would maximise this "
        + "probability, so the figure is being pushed DOWN by how little is known rather "
        + "than by the encounter being benign. With ideal knowledge of this geometry the "
        + "probability could be as high as the peak value shown. A low number here does "
        + "not distinguish a clean pass from an unresolved one.",
      "near-peak":
        "The uncertainty is close to the value that maximises this probability, so the "
        + "figure is near the most this geometry can produce. This is the regime in which "
        + "the number is most informative.",
      resolved:
        "The uncertainty is small compared with the miss distance, so a low probability "
        + "here reflects the geometry rather than a lack of information."
    }[regime],
    limits:
      "Computed against an equivalent circular covariance, which is the form the peak has "
      + "a closed solution for. The real covariance is elongated along track, so this is an "
      + "indication of regime, not a precise threshold."
  };
}

/** Operational banding used across the platform. */
export function pcBand(pc) {
  if (pc >= 1e-3) return "CRITICAL";
  if (pc >= 1e-4) return "HIGH";
  if (pc >= 1e-5) return "ELEVATED";
  if (pc >= 1e-6) return "LOW";
  return "NEGLIGIBLE";
}

// ============================================================
// Full assessment for one encounter
// ============================================================
/**
 * @param enc  {rA,vA,rB,vB} ECI km / km-s at TCA
 * @param opts {ageDaysA, ageDaysB, kindA, kindB, hbrM}
 */
export function assess(enc, opts = {}) {
  const { rA, vA, rB, vB } = enc;
  const hbrM = opts.hbrM ?? 20;
  const basis = ricBasis(rA, vA);
  const miss = sub(rB, rA);
  const rel = sub(vB, vA);
  const missKm = norm(miss);

  // The calibration is passed in rather than imported, so that this stays a
  // pure function: the same encounter and the same calibration always give the
  // same Pc, which is what makes an archived probability reproducible years
  // later from the row alone.
  const cal = opts.calibration ?? null;
  const covA = covarianceModel(opts.ageDaysA ?? 1, opts.kindA ?? "payload", cal);
  const covB = covarianceModel(opts.ageDaysB ?? 1, opts.kindB ?? "debris", cal);

  const f = fosterPc(miss, rel, covA, covB, basis, hbrM);
  const bound = maxPc(missKm, hbrM);

  // ── Guard against false precision ────────────────────────────
  // Pc is exponential in (miss/sigma) and sigma here is MODELLED. Below the
  // floor the digits describe the assumption, not the sky, so report the
  // floor and say so rather than publishing something like 4e-40.
  const belowFloor = f.pc > 0 && f.pc < PC_FLOOR;

  // ── Divergence from the isotropic reference ──────────────────
  // maxPc circularises the covariance. When the anisotropic result sits many
  // orders below it, the gap is not physics — it is the thin axis of the
  // assumed ellipse doing all the work. That is exactly the condition under
  // which an over-tight covariance silently buries a real conjunction, so it
  // is surfaced rather than left for someone to notice.
  const ratio = (bound > 0 && f.pc > 0) ? f.pc / bound : null;
  const ordersBelowBound = ratio ? -Math.log10(ratio) : null;
  const covarianceDriven = ordersBelowBound !== null && ordersBelowBound > 3;

  return {
    missKm: +missKm.toFixed(4),
    relVelKmS: +norm(rel).toFixed(4),
    ric: ricComponents(rA, vA, rB),
    pc: belowFloor ? PC_FLOOR : f.pc,
    pcExact: f.pc,
    pcFloored: belowFloor,
    pcText: belowFloor ? "< 1e-8" : null,
    pcBand: pcBand(belowFloor ? PC_FLOOR : f.pc),
    pcMaxIsotropic: bound,
    pcMaxIsotropicBand: pcBand(bound),
    ordersBelowIsotropic: ordersBelowBound === null ? null : +ordersBelowBound.toFixed(1),
    covarianceDriven,
    covarianceDrivenNote: covarianceDriven
      ? "This probability sits more than three orders below the isotropic reference, so it is "
      + "dominated by the assumed thin axis of the covariance rather than by the geometry. "
      + "Treat it as a screening indication only."
      : null,
    encounterPlane: {
      sigmaXKm: f.sigmaXKm, sigmaYKm: f.sigmaYKm, missInPlaneKm: f.missInPlaneKm
    },
    // Which side of the probability peak this sits on. Reported on every
    // assessment rather than only when it looks bad, because a reader who
    // only sees the flag when it fires learns nothing about how often the
    // regime applies — and here it applies most of the time.
    dilution: dilution({
      missInPlaneKm: f.missInPlaneKm,
      sigmaXKm: f.sigmaXKm,
      sigmaYKm: f.sigmaYKm,
      hbrM,
      pc: belowFloor ? PC_FLOOR : f.pc
    }),
    covariance: { primary: covA, secondary: covB },
    hbrM,
    pcModel: PC_MODEL_VERSION,
    // Which covariance actually produced this number. An archived row has to
    // carry it: two rows written a month apart can use different sigmas, and
    // without this a reader comparing them would be comparing two things.
    pcCalibration: covA.calibration || "none",
    pcFloorApplied: !!(covA.floorApplied || covB.floorApplied),
    method: "Foster 2D encounter-plane integration; covariance modelled from element-set age",
    caveat: "Screening product. Not a substitute for an operator CDM with a supplied covariance."
  };
}

// ============================================================
// Manoeuvre solver
// ============================================================
/**
 * Along-track separation produced by a tangential burn.
 *
 * For a near-circular orbit a tangential Δv changes the semi-major axis
 * by δa/a = 2Δv/v, which changes mean motion, which integrates into an
 * along-track drift of
 *
 *      δs ≈ 3 · Δv · T
 *
 * over a lead time T. Linear, well behaved, and the standard first-order
 * result used for collision-avoidance planning.
 */
export function alongTrackDrift(deltaVms, leadSeconds) {
  return 3 * (deltaVms / 1000) * leadSeconds;   // km
}

/** Δv required to open a given along-track distance by TCA. */
export function deltaVForSeparation(targetKm, leadSeconds) {
  if (leadSeconds <= 0) return Infinity;
  return (targetKm / (3 * leadSeconds)) * 1000;  // m/s
}

/**
 * Propellant for a burn, from the rocket equation.
 *   Δm = m (1 - e^(-Δv / (Isp·g0)))
 */
export function propellantKg(deltaVms, massKg, ispS = 220) {
  const g0 = 9.80665;
  return massKg * (1 - Math.exp(-deltaVms / (ispS * g0)));
}

/**
 * Build manoeuvre options for an encounter: for each lead time, the Δv
 * needed to reach a target miss distance, what it costs, and the Pc that
 * results from the new geometry.
 *
 * The burn is applied along-track, so the resulting miss vector is the
 * original plus the drift along Î.
 */
export function planManoeuvre(enc, opts = {}) {
  const {
    targetMissKm = 1.0,
    massKg = 260,
    ispS = 220,
    hbrM = 20,
    leadsHours = [24, 12, 6, 3],
    ageDaysA = 1, ageDaysB = 2, kindA = "payload", kindB = "debris"
  } = opts;

  const { rA, vA, rB, vB } = enc;
  const basis = ricBasis(rA, vA);
  const miss = sub(rB, rA);
  const rel = sub(vB, vA);
  const covA = covarianceModel(ageDaysA, kindA);
  const covB = covarianceModel(ageDaysB, kindB);
  const before = fosterPc(miss, rel, covA, covB, basis, hbrM);

  // The quantity that governs collision risk is the separation measured in
  // the ENCOUNTER PLANE — the plane normal to relative velocity. Moving the
  // spacecraft along its velocity vector changes *when* it arrives; only the
  // component of that shift which lies in the encounter plane changes how
  // far apart the two objects actually pass.
  //
  // For a head-on conjunction the in-track direction is nearly parallel to
  // the relative velocity, so an along-track burn is close to useless. That
  // is a real operational fact, and this planner reports it rather than
  // quoting a Δv that would not help.
  const vrel = unit(rel);
  let seed = Math.abs(vrel.x) < 0.9 ? { x:1,y:0,z:0 } : { x:0,y:1,z:0 };
  const e1 = unit(cross(vrel, seed));
  const e2 = cross(vrel, e1);

  // In-plane miss vector, and the in-plane footprint of an along-track push.
  const m1 = dot(miss, e1), m2 = dot(miss, e2);
  const currentInPlane = Math.hypot(m1, m2);
  const i1 = dot(basis.I, e1), i2 = dot(basis.I, e2);
  const effectiveness = Math.hypot(i1, i2);   // 0 = useless, 1 = fully effective

  /** Along-track drift s (km) that puts the in-plane miss at `target`. */
  function driftForTarget(target) {
    if (effectiveness < 1e-6) return null;    // burn cannot move the geometry
    // |m + s·î|² = target²  →  s²|î|² + 2s(m·î) + |m|² - target² = 0
    const a = i1*i1 + i2*i2;
    const b = 2 * (m1*i1 + m2*i2);
    const c = currentInPlane*currentInPlane - target*target;
    const disc = b*b - 4*a*c;
    if (disc < 0) return null;
    const r1 = (-b + Math.sqrt(disc)) / (2*a);
    const r2 = (-b - Math.sqrt(disc)) / (2*a);
    // cheapest burn that reaches the target
    const cands = [r1, r2].filter(Number.isFinite);
    if (!cands.length) return null;
    return cands.reduce((best, x) => Math.abs(x) < Math.abs(best) ? x : best);
  }

  const needed = driftForTarget(targetMissKm);

  const options = leadsHours.map(h => {
    const T = h * 3600;
    if (needed === null) {
      return {
        leadHours: h, deltaVms: null, propellantKg: null,
        resultingMissKm: +currentInPlane.toFixed(3),
        pcAfter: before.pc, pcAfterBand: pcBand(before.pc),
        feasible: false,
        note: "An along-track burn cannot open this geometry — relative motion is almost entirely along-track. Consider a radial or cross-track manoeuvre."
      };
    }
    const dv = Math.abs(needed) / (3 * T) * 1000;      // m/s
    const prop = propellantKg(dv, massKg, ispS);
    const drift = Math.sign(needed) * alongTrackDrift(dv, T);
    const shifted = {
      x: miss.x + basis.I.x * drift,
      y: miss.y + basis.I.y * drift,
      z: miss.z + basis.I.z * drift
    };
    const after = fosterPc(shifted, rel, covA, covB, basis, hbrM);
    return {
      leadHours: h,
      deltaVms: +dv.toFixed(4),
      propellantKg: +prop.toFixed(4),
      alongTrackShiftKm: +drift.toFixed(3),
      resultingMissKm: +after.missInPlaneKm,
      pcAfter: after.pc,
      pcAfterBand: pcBand(after.pc),
      feasible: dv < 5000
    };
  });

  return {
    currentMissKm: +norm(miss).toFixed(3),
    currentInPlaneMissKm: +currentInPlane.toFixed(3),
    currentPc: before.pc,
    currentBand: pcBand(before.pc),
    targetMissKm,
    alongTrackNeededKm: needed === null ? null : +needed.toFixed(3),
    alongTrackEffectiveness: +effectiveness.toFixed(3),
    geometry: effectiveness < 0.2
      ? "Relative motion is nearly along-track (head-on or overtaking). A tangential burn mostly shifts arrival time rather than separation, so it is a poor lever here."
      : effectiveness > 0.8
        ? "Crossing geometry. The along-track axis lies close to the encounter plane, so a tangential burn converts efficiently into separation."
        : "Oblique encounter. A tangential burn is partially effective; expect to spend more Δv than a crossing geometry would need.",
    spacecraft: { massKg, ispS, hbrM },
    options,
    model: "In-plane separation solved in the encounter plane; tangential burn via δs ≈ 3·Δv·T; propellant from the rocket equation.",
    caveat: "Planning aid. Flight-dynamics validation and operator CDM review remain required before any burn."
  };
}

// ============================================================
// Solve to a probability threshold rather than to a distance
// ============================================================
/**
 * Smallest along-track drift (km) that brings Foster Pc at or below `targetPc`.
 *
 * ── Why this exists alongside driftForTarget ────────────────
 * planManoeuvre solves to a target MISS DISTANCE. That is not the quantity
 * operators actually hold themselves to. Flight-safety policy is written as a
 * probability threshold — "manoeuvre if Pc exceeds 1e-4" — and distance is a
 * poor proxy for it: a 1 km miss with tight, fresh covariance can be safer
 * than a 5 km miss between two week-old debris element sets. Solving to
 * distance therefore either over-burns or under-burns depending on how well
 * the two objects happen to be tracked.
 *
 * ── Why a scan-then-bisect rather than a root solver ────────
 * Pc as a function of drift is NOT monotonic. Pushing the primary along-track
 * moves it through the point of closest approach, so Pc rises to a peak and
 * falls away on both sides, and a naive Newton or secant step will happily
 * converge on the wrong side or diverge off the peak. So: scan outward in
 * both directions to bracket the first crossing, then bisect inside that
 * bracket, which cannot skip past it. Each evaluation is ~0.15 ms, and this
 * is bounded to a few dozen, so the whole solve is well under a millisecond.
 *
 * Returns null when no drift within `maxDriftKm` achieves the target — which
 * is a real answer, not a failure: it means an along-track burn is the wrong
 * lever for this geometry and the caller should say so rather than quote a
 * number that would not work.
 */
export function driftForTargetPc(enc, targetPc, opts = {}) {
  const {
    hbrM = 20, maxDriftKm = 500, tolKm = 0.01,
    ageDaysA = 1, ageDaysB = 2, kindA = "payload", kindB = "debris"
  } = opts;

  const { rA, vA, rB, vB } = enc;
  const basis = ricBasis(rA, vA);
  const miss = sub(rB, rA);
  const rel = sub(vB, vA);
  const covA = covarianceModel(ageDaysA, kindA);
  const covB = covarianceModel(ageDaysB, kindB);

  /** Pc after displacing the primary by `s` km along its own velocity axis. */
  const pcAt = (s) => fosterPc(
    { x: miss.x + basis.I.x * s, y: miss.y + basis.I.y * s, z: miss.z + basis.I.z * s },
    rel, covA, covB, basis, hbrM
  ).pc;

  const p0 = pcAt(0);
  if (p0 <= targetPc) {
    return { driftKm: 0, pcAchieved: p0, alreadyBelow: true };
  }

  // Scan outward geometrically in both directions. Geometric rather than
  // linear because the useful answer spans a wide range: a crossing geometry
  // may need 100 m, a shallow one hundreds of km.
  let best = null;
  for (const dir of [1, -1]) {
    let prev = 0, prevPc = p0, found = null;
    for (let s = 0.02; s <= maxDriftKm; s *= 1.6) {
      const p = pcAt(dir * s);
      if (p <= targetPc) { found = { lo: prev, hi: s }; break; }
      prev = s; prevPc = p;
    }
    if (!found) continue;

    // Bisect inside the bracket. lo is above target, hi is at or below it.
    let { lo, hi } = found;
    for (let i = 0; i < 60 && (hi - lo) > tolKm; i++) {
      const mid = (lo + hi) / 2;
      if (pcAt(dir * mid) <= targetPc) hi = mid; else lo = mid;
    }
    const cand = { driftKm: dir * hi, pcAchieved: pcAt(dir * hi), alreadyBelow: false };
    if (!best || Math.abs(cand.driftKm) < Math.abs(best.driftKm)) best = cand;
  }
  return best;   // null when the target is unreachable within maxDriftKm
}

/**
 * Minimum Δv that brings Pc below a threshold, per lead time.
 *
 * This is the operationally meaningful form of the question: given that policy
 * says "keep Pc under X", what is the cheapest burn that does it, and how much
 * does waiting cost? Because along-track drift scales with lead time, deciding
 * six hours earlier is dramatically cheaper — that trade is the point of
 * reporting several lead times rather than one.
 */
export function planToTargetPc(enc, opts = {}) {
  const {
    targetPc = 1e-4, massKg = 260, ispS = 220, hbrM = 20,
    leadsHours = [24, 12, 6, 3],
    ageDaysA = 1, ageDaysB = 2, kindA = "payload", kindB = "debris"
  } = opts;

  const sub_ = { hbrM, ageDaysA, ageDaysB, kindA, kindB };
  const sol = driftForTargetPc(enc, targetPc, sub_);

  const current = assess(enc, { hbrM, ageDaysA, ageDaysB, kindA, kindB });

  if (!sol) {
    return {
      targetPc,
      currentPc: current.pc,
      currentBand: current.pcBand,
      achievable: false,
      options: [],
      note: "No along-track drift within 500 km brings the probability below the "
          + "threshold. The relative motion is too close to along-track for a "
          + "tangential burn to change the encounter-plane geometry — a radial or "
          + "cross-track manoeuvre is the appropriate lever here.",
      caveat: "Planning aid. Flight-dynamics validation and operator CDM review remain required before any burn."
    };
  }

  if (sol.alreadyBelow) {
    return {
      targetPc,
      currentPc: current.pc,
      currentBand: current.pcBand,
      achievable: true,
      burnRequired: false,
      options: [],
      note: "Probability is already at or below the threshold. No manoeuvre is indicated on this criterion.",
      caveat: "Planning aid. Flight-dynamics validation and operator CDM review remain required before any burn."
    };
  }

  const options = leadsHours.map(h => {
    const T = h * 3600;
    const dv = deltaVForSeparation(Math.abs(sol.driftKm), T);
    return {
      leadHours: h,
      deltaVms: +dv.toFixed(4),
      propellantKg: +propellantKg(dv, massKg, ispS).toFixed(4),
      alongTrackShiftKm: +sol.driftKm.toFixed(3),
      pcAfter: sol.pcAchieved,
      pcAfterBand: pcBand(sol.pcAchieved),
      // 5 km/s is far beyond any collision-avoidance burn; past this the answer
      // is "this is not a manoeuvre problem", not "bring more propellant".
      feasible: dv < 5000
    };
  });

  return {
    targetPc,
    currentPc: current.pc,
    currentBand: current.pcBand,
    achievable: true,
    burnRequired: true,
    requiredDriftKm: +sol.driftKm.toFixed(3),
    pcAfter: sol.pcAchieved,
    pcAfterBand: pcBand(sol.pcAchieved),
    spacecraft: { massKg, ispS, hbrM },
    options,
    costOfDelay: (() => {
      const f = options.find(o => o.feasible), l = options[options.length - 1];
      if (!f || !l || f.leadHours === l.leadHours || !f.deltaVms) return null;
      return `Deciding at T-${f.leadHours} h costs ${f.deltaVms.toFixed(2)} m/s; `
           + `waiting until T-${l.leadHours} h costs ${l.deltaVms.toFixed(2)} m/s `
           + `(${(l.deltaVms / f.deltaVms).toFixed(1)}x more).`;
    })(),
    model: "Along-track drift solved against Foster encounter-plane Pc by bracketed bisection; tangential burn via δs ≈ 3·Δv·T; propellant from the rocket equation.",
    caveat: "Planning aid. Flight-dynamics validation and operator CDM review remain required before any burn."
  };
}

export const constants = { MU, EARTH_R };
