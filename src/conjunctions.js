// ============================================================
// OrbitIQ conjunction screening engine.
//
// Coarse-to-fine close-approach screening using SGP4 propagation, an
// apogee/perigee sieve and 3D spatial hashing.
//
// ── Why this was rewritten ──────────────────────────────────
// The previous version sampled every 60 s and flagged a pair as a candidate
// only if it was already within 8 x the reporting threshold at one of those
// samples. Those two numbers were chosen independently, and they are not
// independent. A pair closing at 13 km/s crosses an 80 km gate in about
// 12 seconds, so sampling every 60 seconds found it roughly one time in five.
// Four out of five real conjunctions were never detected, and the response
// looked exactly the same as a clean screen.
//
// The fix is to derive the gate from the step instead of guessing it:
//
//     gate = threshold + vRelMax * step / 2
//
// If a pair's true minimum separation d* <= threshold occurs at time t*, the
// nearest sample t_i is at most step/2 away, so the separation seen at t_i is
// at most d* + vRel * step/2 <= gate. Any qualifying pair is therefore caught
// at the coarse stage, for every pair closing at or below vRelMax. That bound
// is reported in the response as `completeTo`, so the guarantee is stated
// rather than implied.
//
// Refinement used to be a 2-second grid, which at 13 km/s moves the pair 26 km
// per sample. The reported miss distance depended on where the grid phase
// happened to land — the same encounter reported anywhere from 3.1 km to
// 10.7 km depending only on the clock — which crossed three risk bands and
// caused spurious "risk increased 10x" re-alerts on every sweep. It is now a
// bracketed golden-section minimisation, converged to well under a metre, so
// the same encounter returns the same number every time.
// ============================================================
import * as satellite from "satellite.js";
import { EARTH_R_KM, V_REL_MAX_KMS } from "./constants.js";

/** SGP4's own Earth radius, used to convert satrec.a (in Earth radii) to km. */
const SGP4_R_KM = 6378.135;

function makeSatrec(gp) {
  try { return satellite.json2satrec(gp); } catch { return null; }
}

function posAt(satrec, date) {
  try {
    const pv = satellite.propagate(satrec, date);
    const p = pv?.position;
    if (!p || Number.isNaN(p.x)) return null;
    return p; // ECI km
  } catch { return null; }
}

function stateAt(satrec, date) {
  try {
    const pv = satellite.propagate(satrec, date);
    if (!pv?.position || Number.isNaN(pv.position.x)) return null;
    return pv;
  } catch { return null; }
}

/**
 * Radial band an object can occupy: [perigee, apogee] in km from Earth centre.
 * Two objects cannot be within `threshold` of each other unless these bands
 * overlap to within `threshold` — their radii would differ by more than the
 * separation, which is impossible. This is the classic apogee/perigee sieve
 * and it removes the large majority of pairs for the cost of two comparisons,
 * with no propagation at all.
 */
function radialBand(rec) {
  const a = rec.a * SGP4_R_KM;           // semi-major axis, km
  const e = rec.ecco ?? 0;
  if (!Number.isFinite(a) || a <= 0) return null;
  return { rp: a * (1 - e), ra: a * (1 + e) };
}

/**
 * Distance between two objects at a given offset from `start`, in km.
 * Returns Infinity where either propagation fails, so the minimiser simply
 * walks away from unusable regions instead of throwing.
 */
function sepAt(recA, recB, start, tSec) {
  const t = new Date(start.getTime() + tSec * 1000);
  const pa = posAt(recA, t), pb = posAt(recB, t);
  if (!pa || !pb) return Infinity;
  return Math.hypot(pa.x - pb.x, pa.y - pb.y, pa.z - pb.z);
}

const INV_PHI = (Math.sqrt(5) - 1) / 2;   // 0.618...

/**
 * Find the true time of closest approach near `tGuess`.
 *
 * A coarse scan over the bracket locates the sample containing the minimum,
 * which guards against the interval holding more than one approach; golden
 * section then converges on it. Golden section needs no derivative and cannot
 * diverge, which matters because SGP4 separation is smooth but not analytic.
 *
 * @returns {{tSec:number, dKm:number}} converged to `tolSec`
 */
function refineTca(recA, recB, start, tGuess, halfWindowSec, tolSec = 0.05) {
  const N = 8;
  let lo = tGuess - halfWindowSec, hi = tGuess + halfWindowSec;
  const step = (hi - lo) / N;
  let bestT = lo, bestD = Infinity;
  for (let i = 0; i <= N; i++) {
    const t = lo + i * step;
    const d = sepAt(recA, recB, start, t);
    if (d < bestD) { bestD = d; bestT = t; }
  }
  if (!Number.isFinite(bestD)) return { tSec: tGuess, dKm: Infinity };

  // Bracket the located minimum by one scan step on each side.
  let a = Math.max(lo, bestT - step), b = Math.min(hi, bestT + step);

  let c = b - INV_PHI * (b - a);
  let d = a + INV_PHI * (b - a);
  let fc = sepAt(recA, recB, start, c);
  let fd = sepAt(recA, recB, start, d);
  let guard = 0;
  while (b - a > tolSec && guard++ < 80) {
    if (fc < fd) { b = d; d = c; fd = fc; c = b - INV_PHI * (b - a); fc = sepAt(recA, recB, start, c); }
    else         { a = c; c = d; fc = fd; d = a + INV_PHI * (b - a); fd = sepAt(recA, recB, start, d); }
  }
  const tSec = (a + b) / 2;
  const dKm = sepAt(recA, recB, start, tSec);
  // The scan minimum is a valid fallback if the polish somehow did worse.
  return dKm <= bestD ? { tSec, dKm } : { tSec: bestT, dKm: bestD };
}

/**
 * Screen for close approaches.
 * @param sats        full catalog [{id,name,org,gp}]
 * @param primaryOrg  org id to screen (its sats vs everything), or null = all-vs-all
 * @param hours       look-ahead window
 * @param thresholdKm report pairs closer than this
 * @param opts        {maxPropagations, primaryIds, coarseStepSec}
 */
export function screenConjunctions(sats, primaryOrg, hours = 6, thresholdKm = 10, opts = {}) {
  const start = opts.start ? new Date(opts.start) : new Date();

  const MAX_OBJECTS = opts.maxObjects ?? 6000;
  const catalog = [];
  for (const s of sats) {
    if (catalog.length >= MAX_OBJECTS) break;
    const rec = makeSatrec(s.gp);
    if (!rec) continue;
    const band = radialBand(rec);
    if (!band) continue;
    catalog.push({ ...s, rec, band });
  }

  // `primaryIds` lets a caller screen an explicit set (a registered fleet)
  // rather than a whole operator, which is what the fleet watch needs.
  const idFilter = opts.primaryIds ? new Set([...opts.primaryIds].map(String)) : null;
  let primaries = catalog;
  if (idFilter) primaries = catalog.filter(s => idFilter.has(String(s.id)));
  else if (primaryOrg) primaries = catalog.filter(s => s.org === primaryOrg);

  if (!primaries.length) {
    return { events: [], screened: 0, catalogSize: catalog.length, windowHours: hours, thresholdKm };
  }

  // ── Apogee/perigee sieve ────────────────────────────────────
  // Only objects whose radial band overlaps some primary's band (widened by
  // the threshold) can possibly produce a qualifying event. For a small fleet
  // this typically removes 80-90% of the catalogue before any propagation,
  // which is what makes a fine time step affordable in the fleet case.
  let loR = Infinity, hiR = -Infinity;
  for (const p of primaries) { loR = Math.min(loR, p.band.rp); hiR = Math.max(hiR, p.band.ra); }
  loR -= thresholdKm; hiR += thresholdKm;
  const screenSet = catalog.filter(s => s.band.ra >= loR && s.band.rp <= hiR);

  // ── Step / gate selection ───────────────────────────────────
  // The step is set by the propagation budget; the gate is then whatever that
  // step requires for completeness. Never the other way round.
  const budget = opts.maxPropagations ?? 2_500_000;
  const windowSec = hours * 3600;
  const autoStep = Math.ceil((windowSec * Math.max(screenSet.length, 1)) / Math.max(budget, 1));
  const coarseStep = Math.min(60, Math.max(2, opts.coarseStepSec ?? autoStep));
  const coarseGate = thresholdKm + V_REL_MAX_KMS * (coarseStep / 2);
  const steps = Math.floor(windowSec / coarseStep);

  const primaryIdSet = new Set(primaries.map(s => s.id));
  const candidates = new Map(); // "idA|idB" -> {a,b,tSec,d2}

  const cell = coarseGate;
  const key = (x, y, z) =>
    `${Math.floor(x / cell)},${Math.floor(y / cell)},${Math.floor(z / cell)}`;

  for (let i = 0; i <= steps; i++) {
    const t = new Date(start.getTime() + i * coarseStep * 1000);

    const grid = new Map();
    const positions = new Map();
    for (const s of screenSet) {
      const p = posAt(s.rec, t);
      if (!p) continue;
      positions.set(s.id, p);
      const k = key(p.x, p.y, p.z);
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k).push(s);
    }

    for (const a of primaries) {
      const pa = positions.get(a.id);
      if (!pa) continue;
      const cx = Math.floor(pa.x / cell), cy = Math.floor(pa.y / cell), cz = Math.floor(pa.z / cell);
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
        const bucket = grid.get(`${cx + dx},${cy + dy},${cz + dz}`);
        if (!bucket) continue;
        for (const b of bucket) {
          if (b.id === a.id) continue;
          if (primaryIdSet.has(b.id) && b.id < a.id) continue;
          const pb = positions.get(b.id);
          const dxk = pa.x - pb.x, dyk = pa.y - pb.y, dzk = pa.z - pb.z;
          const d2 = dxk * dxk + dyk * dyk + dzk * dzk;
          if (d2 < coarseGate * coarseGate) {
            const id = a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`;
            const prev = candidates.get(id);
            if (!prev || d2 < prev.d2) candidates.set(id, { a, b, tSec: i * coarseStep, d2 });
          }
        }
      }
    }
  }

  // ── Refinement ──────────────────────────────────────────────
  const events = [];
  for (const c of candidates.values()) {
    const { tSec, dKm } = refineTca(c.a.rec, c.b.rec, start, c.tSec, coarseStep);
    if (!(dKm <= thresholdKm)) continue;

    const t = new Date(start.getTime() + tSec * 1000);
    const A = stateAt(c.a.rec, t), B = stateAt(c.b.rec, t);
    if (!A || !B) continue;
    const relV = Math.hypot(
      A.velocity.x - B.velocity.x, A.velocity.y - B.velocity.y, A.velocity.z - B.velocity.z);
    const altKm = Math.hypot(A.position.x, A.position.y, A.position.z) - EARTH_R_KM;

    events.push({
      tca: t.toISOString(),
      missKm: +dKm.toFixed(3),
      relVelKmS: +relV.toFixed(2),
      altKm: +altKm.toFixed(0),
      risk: dKm < 1 ? "CRITICAL" : dKm < 3 ? "HIGH" : dKm < 6 ? "MODERATE" : "LOW",
      a: { id: c.a.id, name: c.a.name, org: c.a.org },
      b: { id: c.b.id, name: c.b.name, org: c.b.org }
    });
  }
  events.sort((x, y) => x.missKm - y.missKm);

  return {
    events: events.slice(0, 100),
    screened: primaries.length,
    catalogSize: catalog.length,
    sievedTo: screenSet.length,
    windowHours: hours,
    thresholdKm,
    // Stated honestly so callers can tell how much to trust a clean result.
    method: {
      coarseStepSec: coarseStep,
      coarseGateKm: +coarseGate.toFixed(1),
      completeToRelVelKmS: V_REL_MAX_KMS,
      note: `Complete for pairs closing at up to ${V_REL_MAX_KMS} km/s: the ${coarseGate.toFixed(0)} km gate cannot be crossed between ${coarseStep} s samples below that speed. TCA refined by golden-section minimisation to <0.05 s.`
    },
    generatedAt: new Date().toISOString()
  };
}
