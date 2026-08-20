// ============================================================
// OrbitIQ — conjunction evolution tracking.
//
// The single most useful thing an operator wants to know about a close
// approach is not its current miss distance. It is whether that distance is
// tightening. A 5 km encounter that has converged from 12 km over three
// sweeps deserves attention; a stable 3 km encounter that has sat at 3 km all
// week usually does not.
//
// This could not be built before now. The screener's reported miss distance
// varied by a factor of three between sweeps purely because of where the
// 2-second refinement grid happened to land, so any "trend" computed from it
// would have been reporting sampling noise as physics — and, worse, would
// have looked plausible. With TCA now converged by golden-section
// minimisation to well under a second, successive observations of the same
// encounter are comparable, and a real trend can be measured.
//
// Each observation is keyed to the encounter (both objects plus the hour of
// closest approach), not to the sweep, so the same physical event accumulates
// history as it is re-screened.
// ============================================================
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "data");
const FILE = path.join(DATA_DIR, "trend.json");

const nullMap = o => Object.assign(Object.create(null), o || {});
let db = { tracks: {} };
try { db = { ...db, ...JSON.parse(fs.readFileSync(FILE, "utf8")) }; } catch { /* first run */ }
db.tracks = nullMap(db.tracks);

let dirty = false;
const save = () => { dirty = true; };
const timer = setInterval(() => {
  if (!dirty) return;
  dirty = false;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(db));
    fs.renameSync(tmp, FILE);
  } catch (e) { console.error("trend: save failed", e.message); }
}, 10000);
timer.unref?.();

export function flush() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(db));
    dirty = false;
    return true;
  } catch { return false; }
}

/** Observations kept per encounter. A week of 30-minute sweeps is ~336. */
const MAX_OBS = 24;
/** Tracks are dropped this long after their TCA has passed. */
const RETAIN_AFTER_TCA_MS = 48 * 60 * 60 * 1000;
/** Below this relative change, an encounter is considered unchanged. */
const STABLE_BAND = 0.08;   // 8%

/**
 * Identify an encounter independently of when it was observed.
 * TCA is bucketed to the hour so that small refinements of the predicted time
 * across sweeps still map to the same track.
 */
export function trackKey(idA, idB, tcaIso) {
  const ids = [String(idA), String(idB)].sort();
  return `${ids[0]}~${ids[1]}@${String(tcaIso || "").slice(0, 13)}`;
}

/**
 * Record one observation of an encounter and return its trend.
 * @param wsId  workspace scope, so one tenant's history is never another's
 */
export function observe(wsId, { idA, idB, tca, missKm, pc, at = new Date().toISOString() }) {
  if (!Number.isFinite(missKm)) return classify([]);
  const key = `${wsId}|${trackKey(idA, idB, tca)}`;
  const t = db.tracks[key] || (db.tracks[key] = { tca, obs: [] });
  t.tca = tca;

  const last = t.obs[t.obs.length - 1];
  // Re-screening within the same sweep shouldn't inflate the history; treat an
  // observation that is numerically identical to the previous one as a repeat.
  if (!last || Math.abs(last.missKm - missKm) > 1e-6 || last.at !== at) {
    t.obs.push({ at, missKm: +missKm.toFixed(3), pc: Number.isFinite(pc) ? pc : null });
    if (t.obs.length > MAX_OBS) t.obs = t.obs.slice(-MAX_OBS);
    save();
  }
  return classify(t.obs);
}

/** Read the trend without recording anything. */
export function peek(wsId, idA, idB, tca) {
  const t = db.tracks[`${wsId}|${trackKey(idA, idB, tca)}`];
  return classify(t ? t.obs : []);
}

/**
 * Turn a series of observations into a direction.
 *
 * Uses the first and last observation rather than a least-squares fit: an
 * operator cares about net movement since the encounter was first seen, and a
 * fit over 3-4 points is not more trustworthy than the endpoints. The relative
 * change is what matters — 1 km of tightening means something very different
 * at 2 km than at 40 km.
 */
export function classify(obs) {
  if (!obs || obs.length === 0) {
    return { direction: "new", observations: 0, note: "First time this encounter has been seen." };
  }
  if (obs.length === 1) {
    return { direction: "new", observations: 1, firstSeen: obs[0].at, missKm: obs[0].missKm,
      note: "First time this encounter has been seen; no trend yet." };
  }
  const first = obs[0], last = obs[obs.length - 1];
  const deltaKm = last.missKm - first.missKm;
  const rel = first.missKm > 0 ? deltaKm / first.missKm : 0;

  let direction;
  if (Math.abs(rel) < STABLE_BAND) direction = "stable";
  else direction = deltaKm < 0 ? "converging" : "diverging";

  // Probability movement is reported separately: miss distance and Pc do not
  // always move together, because covariance grows as the element set ages.
  const pcFirst = first.pc, pcLast = last.pc;
  const pcRatio = (Number.isFinite(pcFirst) && Number.isFinite(pcLast) && pcFirst > 0)
    ? pcLast / pcFirst : null;

  const spanH = (new Date(last.at) - new Date(first.at)) / 3600000;
  const noteBits = [];
  if (direction === "converging") noteBits.push(`Tightened ${Math.abs(deltaKm).toFixed(2)} km`);
  else if (direction === "diverging") noteBits.push(`Widened ${Math.abs(deltaKm).toFixed(2)} km`);
  else noteBits.push("Essentially unchanged");
  if (spanH >= 0.5) noteBits.push(`over ${spanH.toFixed(1)} h`);
  noteBits.push(`across ${obs.length} screens`);

  return {
    direction,
    observations: obs.length,
    firstSeen: first.at,
    lastSeen: last.at,
    firstMissKm: first.missKm,
    missKm: last.missKm,
    deltaKm: +deltaKm.toFixed(3),
    changePct: +(rel * 100).toFixed(1),
    pcRatio: pcRatio === null ? null : +pcRatio.toPrecision(3),
    spanHours: +spanH.toFixed(2),
    note: noteBits.join(" ") + "."
  };
}

/**
 * Drop tracks whose encounter is well past. Without this the file grows
 * forever — the same mistake the ledger and the rate-limit maps made.
 */
export function prune(now = Date.now()) {
  let removed = 0;
  for (const key of Object.keys(db.tracks)) {
    const t = db.tracks[key];
    const tca = Date.parse(t?.tca);
    if (!Number.isFinite(tca) || now - tca > RETAIN_AFTER_TCA_MS) {
      delete db.tracks[key]; removed++;
    }
  }
  if (removed) save();
  return removed;
}

export const stats = () => ({
  tracked: Object.keys(db.tracks).length,
  observations: Object.values(db.tracks).reduce((n, t) => n + (t.obs?.length || 0), 0)
});
