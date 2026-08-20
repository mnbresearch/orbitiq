// ============================================================
// OrbitIQ fleet intelligence extensions
//   constellation() — architecture derived live from GP elements:
//     shells, orbital-plane occupancy, inclination families
//   trends() — daily aggregates from the detection archive:
//     the longitudinal view only the ledger can provide
// ============================================================
import { EARTH_R_KM as RE, MU_KM3_S2 as MU } from "./constants.js";

export function constellation(org, sats) {
  const fleet = sats.filter(s => s.org === org && s.noradType === "PAYLOAD");
  if (fleet.length < 3) return { org, error: "Need at least 3 payloads for architecture analysis" };
  const alts = [], ages = [], inclCount = {};
  const raanBins = new Array(24).fill(0); // 15° RAAN bins ≈ orbital planes
  let low = 0;
  const now = Date.now();
  for (const s of fleet) {
    const nRad = (s.meanMotion * 2 * Math.PI) / 86400;
    if (!nRad) continue;
    const a = Math.cbrt(MU / (nRad * nRad));
    const alt = a - RE, per = a * (1 - (s.ecc || 0)) - RE;
    alts.push(alt);
    if (per < 300) low++;
    const ik = (Math.round((s.incl || 0) * 2) / 2).toFixed(1);
    inclCount[ik] = (inclCount[ik] || 0) + 1;
    raanBins[Math.min(23, Math.floor((((s.raan || 0) % 360) + 360) % 360 / 15))]++;
    const age = (now - new Date(s.epoch).getTime()) / 86400000;
    if (Number.isFinite(age)) ages.push(age);
  }
  alts.sort((a, b) => a - b); ages.sort((a, b) => a - b);
  const q = (arr, p) => arr.length ? +arr[Math.min(arr.length - 1, Math.floor(p * (arr.length - 1)))].toFixed(1) : null;
  const shells = {};
  for (const alt of alts) { const b = Math.round(alt / 25) * 25; shells[b] = (shells[b] || 0) + 1; }
  const topShells = Object.entries(shells)
    .map(([alt, count]) => ({ altKm: +alt, count }))
    .sort((x, y) => y.count - x.count).slice(0, 5);
  const inclinationGroups = Object.entries(inclCount)
    .map(([incl, count]) => ({ inclDeg: +incl, count }))
    .sort((x, y) => y.count - x.count).slice(0, 4);
  return {
    org,
    payloads: fleet.length,
    altitude: { medianKm: q(alts, 0.5), p10Km: q(alts, 0.1), p90Km: q(alts, 0.9), topShells },
    planes: {
      occupiedRaanBins15deg: raanBins.filter(c => c > 0).length,
      raanBins
    },
    inclinationGroups,
    elementAgeDays: { median: q(ages, 0.5), worst: q(ages, 1) },
    lowPerigeeCount: low,
    note: "Constellation architecture derived live from GP elements — altitude shells, RAAN plane occupancy, inclination families."
  };
}

export function trends(all, org = null, days = 30) {
  const cutoff = Date.now() - days * 86400000;
  const byDay = {};
  for (const r of all) {
    const ts = new Date(r.t).getTime();
    if (!(ts >= cutoff)) continue;
    const key = r.t.slice(0, 10);
    const d = byDay[key] = byDay[key] ||
      { conj: 0, minMissKm: null, maneuvers: 0, anomalies: 0, reentries: 0, kp: [], risk: null };
    if (r.type === "conjunction" && (!org || r.aOrg === org || r.bOrg === org)) {
      d.conj++;
      if (r.missKm != null && (d.minMissKm === null || r.missKm < d.minMissKm)) d.minMissKm = r.missKm;
    } else if (r.type === "maneuver" && (!org || r.org === org)) d.maneuvers++;
    else if (r.type === "anomaly" && (!org || r.org === org)) d.anomalies++;
    else if (r.type === "reentry") d.reentries++;
    else if (r.type === "environment" && r.kp != null) d.kp.push(r.kp);
    if (r.type === "risk" && org && r.org === org) d.risk = r.index;
  }
  const series = Object.entries(byDay).sort().map(([date, v]) => ({
    date,
    conjunctions: v.conj,
    minMissKm: v.minMissKm,
    maneuvers: v.maneuvers,
    anomalies: v.anomalies,
    reentries: v.reentries,
    kpMax: v.kp.length ? Math.max(...v.kp) : null,
    riskIndex: v.risk
  }));
  return {
    days, org, series,
    note: "Daily aggregates from the detection archive — accumulates automatically while the platform runs; not reconstructable by later entrants."
  };
}
