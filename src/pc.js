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

// ---------- vector helpers ----------
const sub = (a, b) => ({ x: a.x-b.x, y: a.y-b.y, z: a.z-b.z });
const dot = (a, b) => a.x*b.x + a.y*b.y + a.z*b.z;
const cross = (a, b) => ({
  x: a.y*b.z - a.z*b.y, y: a.z*b.x - a.x*b.z, z: a.x*b.y - a.y*b.x
});
const norm = a => Math.sqrt(dot(a, a));
const unit = a => { const n = norm(a); return n > 0 ? { x:a.x/n, y:a.y/n, z:a.z/n } : { x:0,y:0,z:0 }; };

/**
 * RIC (radial / in-track / cross-track) basis of the primary object.
 * R̂ along the position vector, Ĉ along orbital angular momentum,
 * Î completes the right-handed set (≈ velocity direction).
 */
export function ricBasis(r, v) {
  const R = unit(r);
  const C = unit(cross(r, v));
  const I = cross(C, R);          // already unit: C ⟂ R
  return { R, I, C };
}

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
export function covarianceModel(ageDays = 1, kind = "payload") {
  const age = Math.max(0, Math.min(ageDays, 30));
  const k = /deb/i.test(kind) ? 2.2 : /r\/b|rocket/i.test(kind) ? 1.5 : 1.0;
  return {
    sigmaR: +(k * (0.12 + 0.055 * age)).toFixed(4),
    sigmaI: +(k * (0.55 + 1.25 * age)).toFixed(4),
    sigmaC: +(k * (0.15 + 0.085 * age)).toFixed(4),
    ageDays: +age.toFixed(2),
    kind,
    assumed: true,
    note: "TLEs carry no covariance. This is a modelled 1-sigma from SGP4 error growth, not an operator-supplied covariance."
  };
}

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

  const covA = covarianceModel(opts.ageDaysA ?? 1, opts.kindA ?? "payload");
  const covB = covarianceModel(opts.ageDaysB ?? 1, opts.kindB ?? "debris");

  const f = fosterPc(miss, rel, covA, covB, basis, hbrM);
  const bound = maxPc(missKm, hbrM);

  return {
    missKm: +missKm.toFixed(4),
    relVelKmS: +norm(rel).toFixed(4),
    ric: ricComponents(rA, vA, rB),
    pc: f.pc,
    pcBand: pcBand(f.pc),
    pcMaxIsotropic: bound,
    pcMaxIsotropicBand: pcBand(bound),
    encounterPlane: {
      sigmaXKm: f.sigmaXKm, sigmaYKm: f.sigmaYKm, missInPlaneKm: f.missInPlaneKm
    },
    covariance: { primary: covA, secondary: covB },
    hbrM,
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

export const constants = { MU, EARTH_R };
