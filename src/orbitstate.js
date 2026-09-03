// ============================================================
// Shared orbital-state helpers.
//
// ── Why this module exists ──────────────────────────────────
// It exists because the same three helpers were needed in two places, were
// only written in one of them, and the other place quietly grew a cheaper
// substitute instead. The result was two different collision probabilities
// for the same conjunction: watch.js ran the Foster encounter-plane
// integration, while the intelligence sweep — the process that writes the
// permanent, append-only, externally witnessed ledger — used an isotropic
// closed form that needed only a miss distance.
//
// Measured across 135 representative geometries, the isotropic form was
// lower in every single case: median 5.3x, worst 32x. The permanent record
// was systematically understating collision risk, and it is the number a
// customer would actually act on.
//
// So these live here, once, and both callers import them. The point is not
// tidiness. Two copies of an astrodynamics helper is how the archive ended
// up disagreeing with the live API about the same event.
// ============================================================
import * as satellite from "satellite.js";

// ── Vector helpers and the RIC basis ──────────────────────
//
// These were in pc.js, which is where they are mostly used. They moved here
// when covcal.js also needed the RIC basis: covcal measures residuals in RIC,
// pc.js turns covariances in RIC into probabilities, and pc.js consuming
// covcal's result would have made the import cycle pc -> covcal -> pc.
//
// The alternative was a second copy of ricBasis in covcal. That is exactly
// the mistake this file was created to undo — two copies of an astrodynamics
// helper, one of which quietly drifts — so the shared thing moved to the
// shared place instead.
export const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
export const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
export const cross = (a, b) => ({
  x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x
});
export const norm = a => Math.sqrt(dot(a, a));
export const unit = a => { const n = norm(a); return n > 0 ? { x: a.x / n, y: a.y / n, z: a.z / n } : { x: 0, y: 0, z: 0 }; };

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

/**
 * Age of a TLE/GP element set, in days.
 *
 * This drives the covariance model, so an unknown epoch must not be treated
 * as fresh — that would report a confident position for an object we cannot
 * actually locate. Three days is deliberately pessimistic.
 */
export function elementAgeDays(gp) {
  const epoch = gp?.EPOCH || gp?.epoch;
  if (!epoch) return 3;                       // unknown: assume stale-ish
  const t = new Date(epoch).getTime();
  if (!Number.isFinite(t)) return 3;
  return Math.max(0, (Date.now() - t) / 86400000);
}

/**
 * Coarse object class, used to pick a covariance profile.
 *
 * Debris tumbles and has a poorly known ballistic coefficient, so its
 * position uncertainty grows faster than a tracked, manoeuvring payload's.
 * This is a catalogue-name heuristic, not telemetry, and is treated as such.
 */
export function kindOf(sat) {
  const n = `${sat?.name || ""} ${sat?.objectType || ""}`;
  if (/deb/i.test(n)) return "debris";
  if (/r\/b|rocket/i.test(n)) return "rocket body";
  return "payload";
}

/** State vector at a given time, ECI km and km/s. Null if SGP4 cannot solve. */
export function stateAt(gp, when) {
  try {
    const rec = satellite.json2satrec(gp);
    const pv = satellite.propagate(rec, when);
    if (!pv?.position || Number.isNaN(pv.position.x)) return null;
    return { r: pv.position, v: pv.velocity };
  } catch { return null; }
}
