// OrbitIQ conjunction screening engine.
// Coarse-to-fine close-approach screening using SGP4 propagation and
// 3D spatial hashing. This is a screening tool (situational awareness),
// not an operational CDM replacement.
import * as satellite from "satellite.js";

const EARTH_R = 6371; // km

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

/**
 * Screen for close approaches.
 * @param sats        full catalog [{id,name,org,gp}]
 * @param primaryOrg  org id to screen (its sats vs everything), or null = all-vs-all
 * @param hours       look-ahead window
 * @param thresholdKm report pairs closer than this
 */
export function screenConjunctions(sats, primaryOrg, hours = 6, thresholdKm = 10) {
  const start = new Date();
  const coarseStep = 60;                 // seconds
  const coarseGate = Math.max(thresholdKm * 8, 60); // km gate at coarse step
  const steps = Math.floor((hours * 3600) / coarseStep);

  // Build satrecs once; cap catalog for tractability.
  const MAX_OBJECTS = 6000;
  const catalog = [];
  for (const s of sats) {
    if (catalog.length >= MAX_OBJECTS) break;
    const rec = makeSatrec(s.gp);
    if (rec) catalog.push({ ...s, rec });
  }
  const primaries = primaryOrg
    ? catalog.filter(s => s.org === primaryOrg)
    : catalog;
  if (!primaries.length) return { events: [], screened: 0, catalogSize: catalog.length };

  const primaryIds = new Set(primaries.map(s => s.id));
  const candidates = new Map(); // "idA|idB" -> {a, b, tSec}

  const cell = coarseGate; // hash cell size
  const key = (x, y, z) =>
    `${Math.floor(x / cell)},${Math.floor(y / cell)},${Math.floor(z / cell)}`;

  for (let i = 0; i <= steps; i++) {
    const t = new Date(start.getTime() + i * coarseStep * 1000);

    // hash all catalog positions this step
    const grid = new Map();
    const positions = new Map();
    for (const s of catalog) {
      const p = posAt(s.rec, t);
      if (!p) continue;
      positions.set(s.id, p);
      const k = key(p.x, p.y, p.z);
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k).push(s);
    }

    // check each primary against its 27 neighboring cells
    for (const a of primaries) {
      const pa = positions.get(a.id);
      if (!pa) continue;
      const cx = Math.floor(pa.x / cell), cy = Math.floor(pa.y / cell), cz = Math.floor(pa.z / cell);
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
        const bucket = grid.get(`${cx + dx},${cy + dy},${cz + dz}`);
        if (!bucket) continue;
        for (const b of bucket) {
          if (b.id === a.id) continue;
          // avoid double-counting primary-primary pairs
          if (primaryIds.has(b.id) && b.id < a.id) continue;
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

  // refine each candidate: fine 1s sweep ±coarseStep around coarse minimum
  const events = [];
  for (const c of candidates.values()) {
    let best = { dKm: Infinity, t: null, va: null, vb: null };
    for (let dt = -coarseStep; dt <= coarseStep; dt += 2) {
      const t = new Date(start.getTime() + (c.tSec + dt) * 1000);
      let pa, pb, va, vb;
      try {
        const A = satellite.propagate(c.a.rec, t);
        const B = satellite.propagate(c.b.rec, t);
        pa = A?.position; pb = B?.position; va = A?.velocity; vb = B?.velocity;
      } catch { continue; }
      if (!pa || !pb) continue;
      const d = Math.hypot(pa.x - pb.x, pa.y - pb.y, pa.z - pb.z);
      if (d < best.dKm) best = { dKm: d, t, va, vb, pa };
    }
    if (best.dKm <= thresholdKm && best.t) {
      const relV = best.va && best.vb
        ? Math.hypot(best.va.x - best.vb.x, best.va.y - best.vb.y, best.va.z - best.vb.z)
        : null;
      const altKm = best.pa ? Math.hypot(best.pa.x, best.pa.y, best.pa.z) - EARTH_R : null;
      events.push({
        tca: best.t.toISOString(),
        missKm: +best.dKm.toFixed(3),
        relVelKmS: relV ? +relV.toFixed(2) : null,
        altKm: altKm ? +altKm.toFixed(0) : null,
        risk: best.dKm < 1 ? "CRITICAL" : best.dKm < 3 ? "HIGH" : best.dKm < 6 ? "MODERATE" : "LOW",
        a: { id: c.a.id, name: c.a.name, org: c.a.org },
        b: { id: c.b.id, name: c.b.name, org: c.b.org }
      });
    }
  }
  events.sort((x, y) => x.missKm - y.missKm);
  return {
    events: events.slice(0, 100),
    screened: primaries.length,
    catalogSize: catalog.length,
    windowHours: hours,
    thresholdKm,
    generatedAt: new Date().toISOString()
  };
}
