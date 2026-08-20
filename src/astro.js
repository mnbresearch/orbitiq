// OrbitIQ astrodynamics toolbox — first-order engineering estimates.
const MU = 398600.4418;   // km^3/s^2
import { EARTH_R_KM as R } from "./constants.js";
const OMEGA_E = 7.2921159e-5; // rad/s earth rotation

// ---------- Hohmann transfer with combined plane change ----------
export function hohmann(alt1Km, alt2Km, planeChangeDeg = 0) {
  const r1 = R + alt1Km, r2 = R + alt2Km;
  const di = Math.abs(planeChangeDeg) * Math.PI / 180;
  const v1 = Math.sqrt(MU / r1), v2 = Math.sqrt(MU / r2);
  const a = (r1 + r2) / 2;
  const vt1 = Math.sqrt(MU * (2 / r1 - 1 / a));  // transfer velocity at r1
  const vt2 = Math.sqrt(MU * (2 / r2 - 1 / a));  // transfer velocity at r2
  const dv1 = Math.abs(vt1 - v1);
  // combined plane change at the second (higher, cheaper) burn
  const dv2 = Math.sqrt(vt2 * vt2 + v2 * v2 - 2 * vt2 * v2 * Math.cos(di));
  const tofMin = Math.PI * Math.sqrt(a * a * a / MU) / 60;
  return {
    dv1KmS: +dv1.toFixed(4), dv2KmS: +dv2.toFixed(4),
    totalKmS: +(dv1 + dv2).toFixed(4), tofMin: +tofMin.toFixed(1),
    transferApogeeKm: +(Math.max(r1, r2) - R).toFixed(0),
    note: "Impulsive two-burn estimate; plane change combined with second burn."
  };
}

// ---------- launch site feasibility & azimuth ----------
export const LAUNCH_SITES = [
  { name: "Kennedy / Cape Canaveral", country: "USA", lat: 28.5, lon: -80.6 },
  { name: "Vandenberg SFB", country: "USA", lat: 34.7, lon: -120.6 },
  { name: "Starbase, TX", country: "USA", lat: 25.99, lon: -97.15 },
  { name: "Baikonur", country: "Kazakhstan", lat: 45.9, lon: 63.3 },
  { name: "Kourou (CSG)", country: "French Guiana", lat: 5.2, lon: -52.8 },
  { name: "Sriharikota (SDSC)", country: "India", lat: 13.7, lon: 80.2 },
  { name: "Jiuquan", country: "China", lat: 40.96, lon: 100.29 },
  { name: "Wenchang", country: "China", lat: 19.6, lon: 110.9 },
  { name: "Tanegashima", country: "Japan", lat: 30.4, lon: 130.97 },
  { name: "Mahia (Rocket Lab)", country: "New Zealand", lat: -39.26, lon: 177.86 },
  { name: "Plesetsk", country: "Russia", lat: 62.9, lon: 40.6 },
  { name: "Esrange (SSC)", country: "Sweden", lat: 67.89, lon: 21.1 }
];

export function launchPlan(targetInclDeg, targetAltKm) {
  const incl = targetInclDeg * Math.PI / 180;
  const r = R + targetAltKm;
  const vOrbit = Math.sqrt(MU / r);
  const results = LAUNCH_SITES.map(site => {
    const lat = site.lat * Math.PI / 180;
    const cosIncl = Math.cos(incl), cosLat = Math.cos(lat);
    const feasible = Math.abs(cosIncl) <= cosLat + 1e-9 || Math.abs(targetInclDeg - Math.abs(site.lat)) < 0.5;
    let azimuths = null, dvEst = null;
    if (feasible) {
      const sinAz = Math.min(1, Math.max(-1, cosIncl / cosLat));
      const az1 = Math.asin(sinAz);                  // NE ascent
      const az2 = Math.PI - az1;                     // SE ascent
      // earth-rotation assist along launch azimuth
      const vRot = OMEGA_E * R * cosLat * Math.sin(az1);
      const losses = 1.55; // gravity + drag (typical LEO, km/s)
      dvEst = +(vOrbit + losses - vRot).toFixed(2);
      azimuths = [+(az1 * 180 / Math.PI).toFixed(1), +(az2 * 180 / Math.PI).toFixed(1)];
    }
    return {
      site: site.name, country: site.country, lat: site.lat,
      feasible,
      azimuthsDeg: azimuths,
      deltaVEstKmS: dvEst,
      reason: feasible ? null : `Site latitude ${Math.abs(site.lat)}° exceeds target inclination ${targetInclDeg}° (direct ascent impossible)`
    };
  });
  const feasibleSites = results.filter(r => r.feasible).sort((a, b) => a.deltaVEstKmS - b.deltaVEstKmS);
  return {
    targetInclDeg, targetAltKm, orbitalVelocityKmS: +vOrbit.toFixed(2),
    bestSite: feasibleSites[0]?.site || null,
    sites: results,
    note: "First-order estimates: v_orbit + 1.55 km/s losses − rotation assist. Dogleg maneuvers not modeled."
  };
}

// ---------- orbital shell congestion ----------
export function congestion(sats) {
  const BIN = 25, LO = 200, HI = 2000;
  const shells = [];
  for (let a = LO; a < HI; a += BIN) shells.push({ altKm: a, count: 0, orgs: {} });
  for (const s of sats) {
    const nRad = (s.meanMotion * 2 * Math.PI) / 86400;
    if (!nRad) continue;
    const alt = Math.cbrt(MU / (nRad * nRad)) - R;
    if (alt < LO || alt >= HI) continue;
    const sh = shells[Math.floor((alt - LO) / BIN)];
    sh.count++; sh.orgs[s.org] = (sh.orgs[s.org] || 0) + 1;
  }
  const max = Math.max(...shells.map(s => s.count), 1);
  for (const sh of shells) {
    sh.topOrg = Object.entries(sh.orgs).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
    sh.density = +(sh.count / max).toFixed(3);
    sh.tier = sh.count > max * 0.66 ? "SEVERE" : sh.count > max * 0.33 ? "ELEVATED" : sh.count > 0 ? "NOMINAL" : "CLEAR";
    delete sh.orgs;
  }
  const worst = shells.reduce((w, s) => s.count > w.count ? s : w, shells[0]);
  return {
    binKm: BIN, rangeKm: [LO, HI], shells,
    mostCongested: { altKm: worst.altKm, count: worst.count, topOrg: worst.topOrg },
    generatedAt: new Date().toISOString()
  };
}

// ---------- maneuver detection (epoch-over-epoch element deltas) ----------
export function detectManeuvers(sats, history) {
  const out = [];
  for (const s of sats) {
    const h = history[s.id];
    if (!h?.prev) continue;
    const dMM = s.meanMotion - h.prev.meanMotion;
    const dIncl = (s.incl ?? 0) - (h.prev.incl ?? 0);
    const dEcc = (s.ecc ?? 0) - (h.prev.ecc ?? 0);
    const days = Math.max(0.02, Math.abs(new Date(s.epoch) - new Date(h.prev.epoch)) / 86400000);
    // natural drag drift is smooth; flag step changes beyond noise
    const mmSig = Math.abs(dMM) / days > 0.004 && Math.abs(dMM) > 0.0015;
    const inclSig = Math.abs(dIncl) > 0.012;
    if (!mmSig && !inclSig) continue;
    // altitude change implied by mean motion delta
    const n1 = (h.prev.meanMotion * 2 * Math.PI) / 86400, n2 = (s.meanMotion * 2 * Math.PI) / 86400;
    const dAlt = Math.cbrt(MU / (n2 * n2)) - Math.cbrt(MU / (n1 * n1));
    out.push({
      id: s.id, name: s.name, org: s.org,
      epochFrom: h.prev.epoch, epochTo: s.epoch,
      dMeanMotion: +dMM.toFixed(5), dInclDeg: +dIncl.toFixed(4), dEcc: +dEcc.toFixed(6),
      dAltKm: +dAlt.toFixed(2),
      type: inclSig && !mmSig ? "PLANE CHANGE" : dAlt > 0.5 ? "ORBIT RAISE" : dAlt < -0.5 ? "ORBIT LOWER" : "STATIONKEEPING",
      confidence: mmSig && inclSig ? "HIGH" : "MODERATE"
    });
  }
  out.sort((a, b) => Math.abs(b.dAltKm) - Math.abs(a.dAltKm));
  return out.slice(0, 60);
}
