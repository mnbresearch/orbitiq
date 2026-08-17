// ============================================================
// OrbitIQ NetOps — ground network contact planning + re-entry
// projection. The questions every operator asks daily:
//   "when can I talk to my spacecraft, and for how long?"
//   "when is this thing coming down?"
// ============================================================
import * as satellite from "satellite.js";

const RAD = Math.PI / 180;

// A realistic global commercial ground network (KSAT/SSC/AWS-style sites).
export const GROUND_NETWORK = [
  { id: "svalbard",  name: "Svalbard, Norway",        lat: 78.23,  lon: 15.39 },
  { id: "troll",     name: "Troll, Antarctica",       lat: -72.01, lon: 2.53 },
  { id: "fairbanks", name: "Fairbanks, Alaska",       lat: 64.86,  lon: -147.85 },
  { id: "kiruna",    name: "Kiruna, Sweden",          lat: 67.86,  lon: 20.96 },
  { id: "wallops",   name: "Wallops, Virginia",       lat: 37.94,  lon: -75.46 },
  { id: "santiago",  name: "Santiago, Chile",         lat: -33.15, lon: -70.67 },
  { id: "harteb",    name: "Hartebeesthoek, S.Africa",lat: -25.89, lon: 27.69 },
  { id: "bengaluru", name: "Bengaluru, India",        lat: 13.03,  lon: 77.51 },
  { id: "dongara",   name: "Dongara, Australia",      lat: -29.05, lon: 115.35 },
  { id: "awarua",    name: "Awarua, New Zealand",     lat: -46.53, lon: 168.38 }
];

export const stationsPublic = () => ({
  stations: GROUND_NETWORK,
  note: "Preset global network modeled on commercial ground-segment providers. Mission plans can add custom stations."
});

// ---------- multi-station contact plan ----------
export function contactPlan(sat, hours = 24, minElDeg = 5, stations = GROUND_NETWORK) {
  const rec = sat.rec || satellite.json2satrec(sat.gp);
  const stepS = 30, n = Math.floor((hours * 3600) / stepS);
  const t0 = Date.now();
  const obs = stations.map(st => ({
    st,
    gd: { latitude: st.lat * RAD, longitude: st.lon * RAD, height: 0.05 },
    inPass: false, aos: null, maxEl: 0, passes: []
  }));
  for (let i = 0; i <= n; i++) {
    const t = new Date(t0 + i * stepS * 1000);
    let pv;
    try { pv = satellite.propagate(rec, t); } catch { continue; }
    if (!pv?.position) continue;
    const gmst = satellite.gstime(t);
    const ecf = satellite.eciToEcf(pv.position, gmst);
    for (const o of obs) {
      const la = satellite.ecfToLookAngles(o.gd, ecf);
      const el = la.elevation / RAD;
      if (el >= minElDeg) {
        if (!o.inPass) { o.inPass = true; o.aos = t.getTime(); o.maxEl = el; }
        else o.maxEl = Math.max(o.maxEl, el);
      } else if (o.inPass) {
        o.inPass = false;
        o.passes.push({ station: o.st.id, stationName: o.st.name, aos: new Date(o.aos).toISOString(), los: t.toISOString(), durationMin: +((t.getTime() - o.aos) / 60000).toFixed(1), maxEl: +o.maxEl.toFixed(1) });
        o.aos = null; o.maxEl = 0;
      }
    }
  }
  for (const o of obs) if (o.inPass && o.aos) // pass still open at window end
    o.passes.push({ station: o.st.id, stationName: o.st.name, aos: new Date(o.aos).toISOString(), los: new Date(t0 + hours * 3600000).toISOString(), durationMin: +(((t0 + hours * 3600000) - o.aos) / 60000).toFixed(1), maxEl: +o.maxEl.toFixed(1), truncated: true });

  const all = obs.flatMap(o => o.passes).sort((a, b) => new Date(a.aos) - new Date(b.aos));
  const totalContactMin = +all.reduce((s, p) => s + p.durationMin, 0).toFixed(1);
  // longest gap with zero contact anywhere in the network
  let longestGapMin = 0, cursorMs = t0;
  for (const p of all) {
    const aosMs = new Date(p.aos).getTime();
    if (aosMs > cursorMs) longestGapMin = Math.max(longestGapMin, (aosMs - cursorMs) / 60000);
    cursorMs = Math.max(cursorMs, new Date(p.los).getTime());
  }
  longestGapMin = Math.max(longestGapMin, (t0 + hours * 3600000 - cursorMs) / 60000);
  const perStation = obs.map(o => ({
    station: o.st.id, name: o.st.name, lat: o.st.lat, lon: o.st.lon,
    passes: o.passes.length, contactMin: +o.passes.reduce((s, p) => s + p.durationMin, 0).toFixed(1)
  })).sort((a, b) => b.contactMin - a.contactMin);
  return {
    satId: sat.id, satName: sat.name, windowHours: hours, minElDeg,
    passes: all, perStation,
    summary: {
      totalPasses: all.length,
      totalContactMin,
      contactPct: +((totalContactMin / (hours * 60)) * 100).toFixed(1),
      longestGapMin: +longestGapMin.toFixed(1)
    },
    note: "Contact plan across the preset global network. Screening-grade; verify with your ground provider's scheduler."
  };
}

// ---------- re-entry projection ----------
const MU = 398600.4418, RE = 6371;
export function reentryEstimate(s) {
  const n = s.meanMotion;
  if (!n || n < 10) return null; // LEO drag regime only
  const nRad = (n * 2 * Math.PI) / 86400;
  const a = Math.cbrt(MU / (nRad * nRad));
  const perigee = +(a * (1 - (s.ecc || 0)) - RE).toFixed(0);
  const apogee = +(a * (1 + (s.ecc || 0)) - RE).toFixed(0);
  const mmDot = parseFloat(s.gp?.MEAN_MOTION_DOT) || 0; // TLE ṅ/2 term, rev/day²
  let lifetimeDays = null;
  if (mmDot > 1e-9) lifetimeDays = Math.min(36500, Math.max(0.1, (16.4 - n) / (2 * mmDot)));
  // linear element-rate projection breaks down at very low perigee, where
  // density (and therefore ṅ) grows exponentially — clamp to a perigee scale
  if (perigee < 200) lifetimeDays = Math.min(lifetimeDays ?? 60, Math.max(1, Math.round((perigee - 60) / 3)));
  const cls = perigee < 180 ? "IMMINENT" : perigee < 250 ? "CRITICAL" :
    (lifetimeDays !== null && lifetimeDays < 365) ? "MONTHS" :
    (lifetimeDays !== null && lifetimeDays < 1825) ? "YEARS" : "STABLE";
  return {
    id: s.id, name: s.name, org: s.org, type: s.noradType,
    perigeeKm: perigee, apogeeKm: apogee, inclDeg: s.incl,
    mmDot, lifetimeDays: lifetimeDays !== null ? +lifetimeDays.toFixed(0) : null,
    class: cls,
    // debris footprint band: reentry can occur anywhere under the orbit
    riskBandLat: `±${Math.min(90, Math.ceil(s.incl || 0))}°`
  };
}

export function reentryWatch(sats, limit = 100) {
  const rows = sats.map(reentryEstimate).filter(Boolean)
    .filter(r => r.perigeeKm < 500)
    .sort((x, y) => {
      const lx = x.lifetimeDays ?? 1e9, ly = y.lifetimeDays ?? 1e9;
      return (x.perigeeKm - y.perigeeKm) + (lx - ly) * 0.001;
    })
    .slice(0, limit);
  return {
    count: rows.length, objects: rows,
    note: "Lifetime is a linear projection of current element rates — an upper bound; drag accelerates as altitude drops. Class blends perigee and projection."
  };
}
