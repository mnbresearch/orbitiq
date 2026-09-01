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
