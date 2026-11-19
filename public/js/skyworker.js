// OrbitIQ sky worker — SGP4 for the whole catalogue, off the main thread.
//
// The main thread owns the scene; this owns the maths. It receives the compact
// catalogue once, builds a satrec per object, and answers "where is everything
// at time T" with a Float32Array in scene units (transferred, not copied). It
// also answers the per-object questions the UI asks about one selection: the
// orbit track and the current altitude and speed.
//
// Scene frame matches the console (public/js/app.js): ECI (x, y, z) km maps to
// scene (x, z, -y) / 1000, so the two views agree about where everything is.
import * as satellite from "/vendor/satellite/index.js";

const SCALE = 1 / 1000;
let recs = [];      // satrec or null, index-aligned with the catalogue rows
let meanMotion = [];

function gpFrom(row, f) {
  return {
    OBJECT_NAME: row[f.name], OBJECT_ID: row[f.intl], EPOCH: row[f.epoch],
    MEAN_MOTION: row[f.meanMotion], ECCENTRICITY: row[f.ecc], INCLINATION: row[f.incl],
    RA_OF_ASC_NODE: row[f.raan], ARG_OF_PERICENTER: row[f.argp], MEAN_ANOMALY: row[f.ma],
    NORAD_CAT_ID: row[f.id], BSTAR: row[f.bstar], MEAN_MOTION_DOT: row[f.mmDot],
    MEAN_MOTION_DDOT: row[f.mmDdot], EPHEMERIS_TYPE: 0, CLASSIFICATION_TYPE: "U",
    ELEMENT_SET_NO: 999, REV_AT_EPOCH: row[f.revNum]
  };
}

function positionsAt(ms) {
  const t = new Date(ms);
  const out = new Float32Array(recs.length * 3);
  for (let i = 0; i < recs.length; i++) {
    const r = recs[i];
    if (!r) { out[i * 3] = NaN; continue; }
    try {
      const p = satellite.propagate(r, t)?.position;
      if (p && Number.isFinite(p.x)) {
        out[i * 3] = p.x * SCALE; out[i * 3 + 1] = p.z * SCALE; out[i * 3 + 2] = -p.y * SCALE;
      } else out[i * 3] = NaN;
    } catch { out[i * 3] = NaN; }
  }
  return out;
}

onmessage = ({ data: m }) => {
  if (m.type === "load") {
    const f = Object.fromEntries(m.fields.map((k, i) => [k, i]));
    recs = m.rows.map(row => { try { return satellite.json2satrec(gpFrom(row, f)); } catch { return null; } });
    meanMotion = m.rows.map(row => row[f.meanMotion]);
    postMessage({ type: "loaded", ok: recs.filter(Boolean).length });
  } else if (m.type === "positions") {
    const buf = positionsAt(m.t);
    postMessage({ type: "positions", t: m.t, id: m.id, buf }, [buf.buffer]);
  } else if (m.type === "track") {
    const r = recs[m.index];
    const pts = [];
    if (r) {
      const periodMs = (1440 / (meanMotion[m.index] || 15)) * 60000;
      for (let k = 0; k <= 180; k++) {
        try {
          const p = satellite.propagate(r, new Date(m.t + (k / 180) * periodMs))?.position;
          if (p && Number.isFinite(p.x)) pts.push(p.x * SCALE, p.z * SCALE, -p.y * SCALE);
        } catch {}
      }
    }
    const buf = new Float32Array(pts);
    postMessage({ type: "track", index: m.index, buf }, [buf.buffer]);
  } else if (m.type === "state") {
    const r = recs[m.index];
    let state = null;
    if (r) {
      try {
        const pv = satellite.propagate(r, new Date(m.t));
        const p = pv?.position, v = pv?.velocity;
        if (p && v && Number.isFinite(p.x)) {
          const gd = satellite.eciToGeodetic(p, satellite.gstime(new Date(m.t)));
          state = {
            altKm: gd.height,
            lat: satellite.degreesLat(gd.latitude),
            lon: satellite.degreesLong(gd.longitude),
            speedKmS: Math.hypot(v.x, v.y, v.z)
          };
        }
      } catch {}
    }
    postMessage({ type: "state", index: m.index, state });
  }
};
