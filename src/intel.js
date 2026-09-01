// ============================================================
// OrbitIQ Intel Pack — derived space intelligence (premium tier)
// All quantities computed from public GP elements with documented
// assumptions. Screening-grade, not operational CDM replacement.
// ============================================================
import * as satellite from "satellite.js";

import { EARTH_R_KM as RE, MU_KM3_S2 as MU } from "./constants.js";
import * as pcmod from "./pc.js";
import { elementAgeDays, kindOf, stateAt } from "./orbitstate.js";
const C_KM_S = 299792.458;

const rec = s => { try { return satellite.json2satrec(s.gp); } catch { return null; } };
const posVel = (r, t) => { try { const pv = satellite.propagate(r, t); return pv?.position && !Number.isNaN(pv.position.x) ? pv : null; } catch { return null; } };
// An unparseable or missing epoch used to yield NaN, which propagated through
// screeningPc into `pc: null` — and that null would be written into the
// append-only ledger, where it cannot be corrected later. Fall back to a
// deliberately pessimistic 3 days instead: a wide covariance understates
// nothing and is visibly conservative, whereas null is silently useless.
const tleAgeDays = s => {
  const t = new Date(s?.epoch).getTime();
  if (!Number.isFinite(t)) return 3;
  return Math.max(0, (Date.now() - t) / 86400000);
};

// ---------- probability of collision (2D screening Pc) ----------
// Assumed covariance model: per-object 1-sigma position uncertainty grows
// with TLE age (base 1.0 km + 0.75 km/day, capped at 6 km). Combined
// hard-body radius default 20 m. Standard small-HBR 2D approximation.
/**
 * FALLBACK ONLY. Isotropic closed-form Pc from miss distance and element age.
 *
 * ⚠ This is BIASED LOW and must not be presented as equivalent to the Foster
 * result. It models the combined covariance as a circle, but orbital position
 * error is dominated by the along-track component, so the true covariance is a
 * long thin ellipse. Circularising it spreads probability mass over an area
 * much larger than the real one and the answer comes out too small — measured
 * across 135 geometries: lower in 100% of cases, median 5.3x, worst 32x.
 *
 * Kept because it needs only a miss distance, so it still works when SGP4
 * cannot produce a state vector at TCA. Callers MUST label rows produced this
 * way (see `pcMethod` in augmentConjunctions). Prefer pc.assess() always.
 */
export function screeningPc(missKm, a, b, hbrM = 20) {
  const sig = s => Math.min(6, 1.0 + 0.75 * tleAgeDays(s));
  const sA = sig(a), sB = sig(b);
  const sigma = Math.sqrt(sA * sA + sB * sB); // combined, isotropic in encounter plane
  const hbrKm = hbrM / 1000;
  const pc = (hbrKm * hbrKm / (2 * sigma * sigma)) * Math.exp(-(missKm * missKm) / (2 * sigma * sigma));
  return {
    pc: Math.min(1, pc),
    pcText: pc > 0 ? "1e" + Math.ceil(Math.log10(Math.min(1, pc))) : "0",
    combinedSigmaKm: +sigma.toFixed(2),
    hbrM,
    assumption: "Isotropic assumed covariance from TLE age; screening-grade only"
  };
}
/**
 * Attach a collision probability to each screened event.
 *
 * ── Why this is not screeningPc any more ────────────────────
 * It used to be. screeningPc models the combined uncertainty as a single
 * isotropic blob, which is wrong in a specific and consequential direction:
 * orbital position error is overwhelmingly ALONG-TRACK, so the real
 * covariance is a long thin ellipse, not a circle. Forcing it to a circle
 * spreads the probability mass over an area far larger than the true one,
 * and the probability of finding the secondary inside the hard-body disc
 * comes out too low.
 *
 * Measured across 135 representative geometries, the isotropic form was
 * lower than the Foster result in 100% of cases — median 5.3x, worst 32x.
 * These numbers go into the permanent ledger and are what an operator would
 * act on, so understating them is the worst available failure direction.
 *
 * The Foster path needs real state vectors at TCA, which means propagating
 * both objects. That costs ~0.15 ms per event (measured), so screening a
 * full 100-event set adds ~15 ms — affordable, and worth it.
 *
 * Falls back to the isotropic screen ONLY when SGP4 cannot produce a state
 * (missing or unparseable elements). Every row is labelled with the method
 * that produced it, so a fallback row is never mistaken for a rigorous one,
 * and rows already in the archive stay interpretable.
 */
export function augmentConjunctions(events, satsById, hbrM = 20) {
  return events.map(ev => {
    const a = satsById.get(ev.a?.id), b = satsById.get(ev.b?.id);
    if (!a || !b) return ev;

    const tca = new Date(ev.tca);
    const sa = Number.isFinite(tca.getTime()) ? stateAt(a.gp, tca) : null;
    const sb = Number.isFinite(tca.getTime()) ? stateAt(b.gp, tca) : null;

    if (sa && sb) {
      const ageA = elementAgeDays(a.gp), ageB = elementAgeDays(b.gp);
      const f = pcmod.assess(
        { rA: sa.r, vA: sa.v, rB: sb.r, vB: sb.v },
        { ageDaysA: ageA, ageDaysB: ageB, kindA: kindOf(a), kindB: kindOf(b), hbrM }
      );
      return {
        ...ev,
        pc: f.pc,
        pcText: fmtPcText(f.pc),
        pcBand: f.pcBand,
        pcMaxIsotropic: f.pcMaxIsotropic,
        combinedSigmaKm: +Math.hypot(f.encounterPlane.sigmaXKm, f.encounterPlane.sigmaYKm).toFixed(2),
        sigmaMajorKm: f.encounterPlane.sigmaXKm,
        sigmaMinorKm: f.encounterPlane.sigmaYKm,
        ageDaysA: +ageA.toFixed(2),
        ageDaysB: +ageB.toFixed(2),
        hbrM,
        pcMethod: "foster-2d",
        assumption: "Foster 2D encounter-plane integration; anisotropic covariance modelled from element-set age"
      };
    }

    // No state vector — say so rather than silently reporting a weaker number
    // as though it were the same quantity.
    return {
      ...ev,
      ...screeningPc(ev.missKm, a, b, hbrM),
      pcMethod: "isotropic-screen",
      pcDegraded: "No propagated state at TCA; isotropic screening value, biased LOW"
    };
  });
}

function fmtPcText(p) {
  return p > 0 ? "1e" + Math.ceil(Math.log10(Math.min(1, p))) : "0";
}

// ---------- TLE staleness / data quality ----------
export function staleness(sats) {
  const ages = sats.map(s => ({ id: s.id, name: s.name, org: s.org, ageDays: +tleAgeDays(s).toFixed(2) }));
  ages.sort((x, y) => y.ageDays - x.ageDays);
  const buckets = { "<1d": 0, "1-3d": 0, "3-7d": 0, "7-30d": 0, ">30d": 0 };
  let sum = 0;
  for (const a of ages) {
    sum += a.ageDays;
    if (a.ageDays < 1) buckets["<1d"]++;
    else if (a.ageDays < 3) buckets["1-3d"]++;
    else if (a.ageDays < 7) buckets["3-7d"]++;
    else if (a.ageDays < 30) buckets["7-30d"]++;
    else buckets[">30d"]++;
  }
  return {
    total: sats.length,
    meanAgeDays: +(sum / Math.max(1, sats.length)).toFixed(2),
    buckets,
    stalest: ages.slice(0, 25),
    note: "Position uncertainty grows with element age; stale objects degrade screening confidence."
  };
}

// ---------- eclipse (Earth shadow) windows ----------
function sunEci(date) {
  const jd = date.getTime() / 86400000 + 2440587.5, n = jd - 2451545.0;
  const L = (280.46 + 0.9856474 * n) * Math.PI / 180;
  const g = (357.528 + 0.9856003 * n) * Math.PI / 180;
  const lam = L + (1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * Math.PI / 180;
  const eps = 23.439 * Math.PI / 180;
  return { x: Math.cos(lam), y: Math.cos(eps) * Math.sin(lam), z: Math.sin(eps) * Math.sin(lam) };
}
function inShadow(p, sun) {
  const d = p.x * sun.x + p.y * sun.y + p.z * sun.z; // along-sun component
  if (d > 0) return false; // sunlit side
  const px = p.x - d * sun.x, py = p.y - d * sun.y, pz = p.z - d * sun.z;
  return Math.hypot(px, py, pz) < RE; // inside cylindrical umbra
}
export function eclipseWindows(s, hours = 24) {
  const r = rec(s); if (!r) return { windows: [] };
  const stepS = 20, windows = [];
  let cur = null, sunlitS = 0, shadowS = 0;
  const start = Date.now();
  for (let i = 0; i <= (hours * 3600) / stepS; i++) {
    const t = new Date(start + i * stepS * 1000);
    const pv = posVel(r, t); if (!pv) continue;
    const sh = inShadow(pv.position, sunEci(t));
    if (sh) { shadowS += stepS; if (!cur) cur = { enter: t.toISOString() }; cur.exit = t.toISOString(); }
    else { sunlitS += stepS; if (cur) { cur.durationMin = +(((new Date(cur.exit)) - new Date(cur.enter)) / 60000).toFixed(1); windows.push(cur); cur = null; } }
  }
  if (cur) { cur.durationMin = +(((new Date(cur.exit)) - new Date(cur.enter)) / 60000).toFixed(1); windows.push(cur); }
  return {
    satellite: { id: s.id, name: s.name }, horizonH: hours,
    windows: windows.slice(0, 40),
    sunlitPct: +((sunlitS / Math.max(1, sunlitS + shadowS)) * 100).toFixed(1),
    note: "Cylindrical umbra model; penumbra ignored. Power/thermal & optical-observability planning."
  };
}

// ---------- pro pass prediction: Doppler + optical visibility ----------
export function passesPro(s, lat, lon, hours = 24, freqMhz = 437.5) {
  const r = rec(s); if (!r) return { passes: [] };
  const obs = { latitude: satellite.degreesToRadians(lat), longitude: satellite.degreesToRadians(lon), height: 0.05 };
  const stepS = 10, passes = [];
  let cur = null, prevRange = null;
  const start = Date.now();
  for (let i = 0; i < (hours * 3600) / stepS; i++) {
    const t = new Date(start + i * stepS * 1000);
    const pv = posVel(r, t); if (!pv) { prevRange = null; continue; }
    const gmst = satellite.gstime(t);
    const la = satellite.ecfToLookAngles(obs, satellite.eciToEcf(pv.position, gmst));
    const el = la.elevation * 180 / Math.PI;
    if (el > 0) {
      const rangeRate = prevRange === null ? 0 : (la.rangeSat - prevRange) / stepS; // km/s
      const doppler = -rangeRate / C_KM_S * freqMhz * 1e6; // Hz
      const sun = sunEci(t);
      const satSunlit = !inShadow(pv.position, sun);
      // observer darkness: sun elevation at site < -6 deg (civil twilight)
      const obsEcf = satellite.geodeticToEcf(obs);
      const sEcf = satellite.eciToEcf({ x: sun.x * 1e6, y: sun.y * 1e6, z: sun.z * 1e6 }, gmst);
      const sunLook = satellite.ecfToLookAngles(obs, sEcf);
      const obsDark = (sunLook.elevation * 180 / Math.PI) < -6;
      if (!cur) cur = { aos: t.toISOString(), maxEl: el, maxElAz: +(la.azimuth * 180 / Math.PI).toFixed(0), minRangeKm: la.rangeSat, dopplerMaxHz: 0, visibleS: 0 };
      if (el > cur.maxEl) { cur.maxEl = el; cur.maxElAz = +(la.azimuth * 180 / Math.PI).toFixed(0); }
      if (la.rangeSat < cur.minRangeKm) cur.minRangeKm = la.rangeSat;
      cur.dopplerMaxHz = Math.max(cur.dopplerMaxHz, Math.abs(doppler));
      if (satSunlit && obsDark && el > 10) cur.visibleS += stepS;
      cur.los = t.toISOString();
      prevRange = la.rangeSat;
    } else {
      prevRange = null;
      if (cur) {
        cur.maxEl = +cur.maxEl.toFixed(1);
        cur.minRangeKm = +cur.minRangeKm.toFixed(0);
        cur.dopplerMaxHz = +cur.dopplerMaxHz.toFixed(0);
        cur.durationMin = +((new Date(cur.los) - new Date(cur.aos)) / 60000).toFixed(1);
        cur.opticallyVisible = cur.visibleS >= 30;
        cur.visibleMin = +(cur.visibleS / 60).toFixed(1);
        delete cur.visibleS;
        passes.push(cur); cur = null;
        if (passes.length >= 12) break;
      }
    }
  }
  return {
    satellite: { id: s.id, name: s.name }, observer: { lat, lon }, freqMhz, passes,
    note: "Doppler from range-rate at given downlink frequency; optical visibility = sunlit satellite over dark site (civil twilight), el>10°."
  };
}

// ---------- fleet risk index (0-100, higher = riskier) ----------
export function fleetRisk(org, sats, conjEvents, congestionShells) {
  const fleet = sats.filter(s => s.org === org);
  if (!fleet.length) return { org, error: "No objects for this organization" };
  const n = fleet.length;
  // component: conjunction pressure (events involving fleet, weighted by closeness)
  let conjScore = 0;
  for (const ev of conjEvents) {
    if (ev.a.org === org || ev.b.org === org) conjScore += Math.max(0, 10 - ev.missKm);
  }
  const conj = Math.min(100, (conjScore / Math.max(1, n)) * 40);
  // component: congestion of occupied shells
  const occ = new Map(congestionShells.map(sh => [sh.altKm, sh.density]));
  let congSum = 0, congN = 0;
  for (const s of fleet) {
    const nRad = (s.meanMotion * 2 * Math.PI) / 86400;
    if (!nRad) continue;
    const alt = Math.cbrt(MU / (nRad * nRad)) - RE;
    const bin = Math.floor((alt - 200) / 25) * 25 + 200;
    if (occ.has(bin)) { congSum += occ.get(bin); congN++; }
  }
  const congestion = Math.min(100, (congN ? congSum / congN : 0) * 100);
  // component: decay exposure (share of fleet with perigee < 300 km)
  let low = 0;
  for (const s of fleet) {
    const nRad = (s.meanMotion * 2 * Math.PI) / 86400;
    if (!nRad) continue;
    const a = Math.cbrt(MU / (nRad * nRad));
    if (a * (1 - s.ecc) - RE < 300) low++;
  }
  const decay = Math.min(100, (low / n) * 200);
  // component: element staleness
  const meanAge = fleet.reduce((t, s) => t + tleAgeDays(s), 0) / n;
  const stale = Math.min(100, meanAge * 12);
  const index = +(0.45 * conj + 0.25 * congestion + 0.15 * decay + 0.15 * stale).toFixed(1);
  const grade = index < 15 ? "A" : index < 30 ? "B" : index < 50 ? "C" : index < 70 ? "D" : "E";
  return {
    org, fleetSize: n, index, grade,
    components: {
      conjunctionPressure: +conj.toFixed(1),
      shellCongestion: +congestion.toFixed(1),
      decayExposure: +decay.toFixed(1),
      elementStaleness: +stale.toFixed(1)
    },
    generatedAt: new Date().toISOString(),
    note: "Composite of screening conjunctions (45%), occupied-shell congestion (25%), decay exposure (15%), element staleness (15%)."
  };
}

// ---------- launch-to-object correlation ----------
export function launchCorrelation(launches, sats, siteLookup) {
  const now = Date.now();
  const recent = launches.filter(l => l.net && now - new Date(l.net).getTime() < 21 * 86400000 && now - new Date(l.net).getTime() > 0);
  const year = new Date().getUTCFullYear();
  const fresh = sats.filter(s => s.intl && s.intl.startsWith(String(year)) && tleAgeDays(s) < 30);
  const out = [];
  for (const l of recent) {
    const siteLat = siteLookup(l.location || "");
    const tL = new Date(l.net).getTime();
    const matches = fresh.filter(s => {
      const dtDays = Math.abs((new Date(s.epoch).getTime() - tL) / 86400000);
      const inclOk = siteLat === null ? true : (s.incl + 0.8 >= Math.abs(siteLat));
      return dtDays < 14 && inclOk;
    }).map(s => ({ id: s.id, name: s.name, intl: s.intl, incl: s.incl, org: s.org }))
      .slice(0, 12);
    if (matches.length) out.push({ launch: l.name, net: l.net, site: l.location, siteLat, candidates: matches });
  }
  return { correlations: out, note: "Candidate objects: fresh catalog entries within 14 days of launch whose inclination is reachable from the site latitude." };
}

// ---------- Gabbard diagram data (debris analysis) ----------
export function gabbard(sats, groupQuery) {
  const q = groupQuery.toUpperCase();
  const members = sats.filter(s => s.name.toUpperCase().includes(q));
  const series = members.map(s => {
    const nRad = (s.meanMotion * 2 * Math.PI) / 86400;
    if (!nRad) return null;
    const a = Math.cbrt(MU / (nRad * nRad));
    return {
      id: s.id, name: s.name,
      periodMin: +(1440 / s.meanMotion).toFixed(2),
      apogeeKm: +(a * (1 + s.ecc) - RE).toFixed(1),
      perigeeKm: +(a * (1 - s.ecc) - RE).toFixed(1)
    };
  }).filter(Boolean);
  return { group: groupQuery, count: series.length, series, note: "Gabbard diagram series: period vs apogee/perigee reveals breakup energy distribution." };
}

// ---------- pattern-of-life anomalies ----------
export function anomalies(sats, history) {
  const deltas = [];
  for (const s of sats) {
    const h = history[s.id];
    if (!h?.prev) continue;
    const days = Math.max(0.02, Math.abs(new Date(s.epoch) - new Date(h.prev.epoch)) / 86400000);
    deltas.push({ s, rate: Math.abs(s.meanMotion - h.prev.meanMotion) / days, dIncl: Math.abs((s.incl ?? 0) - (h.prev.incl ?? 0)) });
  }
  if (!deltas.length) return { flags: [], note: "Insufficient element history yet — history accrues with each catalog refresh." };
  const rates = deltas.map(d => d.rate).sort((a, b) => a - b);
  const med = rates[Math.floor(rates.length / 2)] || 0;
  const mad = rates.map(r => Math.abs(r - med)).sort((a, b) => a - b)[Math.floor(rates.length / 2)] || 1e-6;
  const flags = deltas
    .map(d => ({ ...d, z: (d.rate - med) / (1.4826 * mad) }))
    .filter(d => d.z > 6 || d.dIncl > 0.05)
    .sort((a, b) => b.z - a.z)
    .slice(0, 30)
    .map(d => ({
      id: d.s.id, name: d.s.name, org: d.s.org,
      mmRatePerDay: +d.rate.toFixed(5), zScore: +d.z.toFixed(1), dInclDeg: +d.dIncl.toFixed(3),
      severity: d.z > 15 || d.dIncl > 0.2 ? "HIGH" : "MODERATE"
    }));
  return { flags, population: deltas.length, note: "Robust z-score (median/MAD) on epoch-over-epoch mean-motion rate; flags out-of-family behavior." };
}
// ============================================================
// OrbitIQ Intel Pack — derived space intelligence (premium tier)
// All quantities computed from public GP elements with documented
// assumptions. Screening-grade, not operational CDM replacement.
// ============================================================
import * as satellite from "satellite.js";

import { EARTH_R_KM as RE, MU_KM3_S2 as MU } from "./constants.js";
import * as pcmod from "./pc.js";
import { elementAgeDays, kindOf, stateAt } from "./orbitstate.js";
const C_KM_S = 299792.458;

const rec = s => { try { return satellite.json2satrec(s.gp); } catch { return null; } };
const posVel = (r, t) => { try { const pv = satellite.propagate(r, t); return pv?.position && !Number.isNaN(pv.position.x) ? pv : null; } catch { return null; } };
// An unparseable or missing epoch used to yield NaN, which propagated through
// screeningPc into `pc: null` — and that null would be written into the
// append-only ledger, where it cannot be corrected later. Fall back to a
// deliberately pessimistic 3 days instead: a wide covariance understates
// nothing and is visibly conservative, whereas null is silently useless.
const tleAgeDays = s => {
  const t = new Date(s?.epoch).getTime();
  if (!Number.isFinite(t)) return 3;
  return Math.max(0, (Date.now() - t) / 86400000);
};

// ---------- probability of collision (2D screening Pc) ----------
// Assumed covariance model: per-object 1-sigma position uncertainty grows
// with TLE age (base 1.0 km + 0.75 km/day, capped at 6 km). Combined
// hard-body radius default 20 m. Standard small-HBR 2D approximation.
/**
 * FALLBACK ONLY. Isotropic closed-form Pc from miss distance and element age.
 *
 * ⚠ This is BIASED LOW and must not be presented as equivalent to the Foster
 * result. It models the combined covariance as a circle, but orbital position
 * error is dominated by the along-track component, so the true covariance is a
 * long thin ellipse. Circularising it spreads probability mass over an area
 * much larger than the real one and the answer comes out too small — measured
 * across 135 geometries: lower in 100% of cases, median 5.3x, worst 32x.
 *
 * Kept because it needs only a miss distance, so it still works when SGP4
 * cannot produce a state vector at TCA. Callers MUST label rows produced this
 * way (see `pcMethod` in augmentConjunctions). Prefer pc.assess() always.
 */
export function screeningPc(missKm, a, b, hbrM = 20) {
  const sig = s => Math.min(6, 1.0 + 0.75 * tleAgeDays(s));
  const sA = sig(a), sB = sig(b);
  const sigma = Math.sqrt(sA * sA + sB * sB); // combined, isotropic in encounter plane
  const hbrKm = hbrM / 1000;
  const pc = (hbrKm * hbrKm / (2 * sigma * sigma)) * Math.exp(-(missKm * missKm) / (2 * sigma * sigma));
  return {
    pc: Math.min(1, pc),
    pcText: pc > 0 ? "1e" + Math.ceil(Math.log10(Math.min(1, pc))) : "0",
    combinedSigmaKm: +sigma.toFixed(2),
    hbrM,
    assumption: "Isotropic assumed covariance from TLE age; screening-grade only"
  };
}
/**
 * Attach a collision probability to each screened event.
 *
 * ── Why this is not screeningPc any more ────────────────────
 * It used to be. screeningPc models the combined uncertainty as a single
 * isotropic blob, which is wrong in a specific and consequential direction:
 * orbital position error is overwhelmingly ALONG-TRACK, so the real
 * covariance is a long thin ellipse, not a circle. Forcing it to a circle
 * spreads the probability mass over an area far larger than the true one,
 * and the probability of finding the secondary inside the hard-body disc
 * comes out too low.
 *
 * Measured across 135 representative geometries, the isotropic form was
 * lower than the Foster result in 100% of cases — median 5.3x, worst 32x.
 * These numbers go into the permanent ledger and are what an operator would
 * act on, so understating them is the worst available failure direction.
 *
 * The Foster path needs real state vectors at TCA, which means propagating
 * both objects. That costs ~0.15 ms per event (measured), so screening a
 * full 100-event set adds ~15 ms — affordable, and worth it.
 *
 * Falls back to the isotropic screen ONLY when SGP4 cannot produce a state
 * (missing or unparseable elements). Every row is labelled with the method
 * that produced it, so a fallback row is never mistaken for a rigorous one,
 * and rows already in the archive stay interpretable.
 */
export function augmentConjunctions(events, satsById, hbrM = 20) {
  return events.map(ev => {
    const a = satsById.get(ev.a?.id), b = satsById.get(ev.b?.id);
    if (!a || !b) return ev;

    const tca = new Date(ev.tca);
    const sa = Number.isFinite(tca.getTime()) ? stateAt(a.gp, tca) : null;
    const sb = Number.isFinite(tca.getTime()) ? stateAt(b.gp, tca) : null;

    if (sa && sb) {
      const ageA = elementAgeDays(a.gp), ageB = elementAgeDays(b.gp);
      const f = pcmod.assess(
        { rA: sa.r, vA: sa.v, rB: sb.r, vB: sb.v },
        { ageDaysA: ageA, ageDaysB: ageB, kindA: kindOf(a), kindB: kindOf(b), hbrM }
      );
      return {
        ...ev,
        pc: f.pc,
        pcText: fmtPcText(f.pc),
        pcBand: f.pcBand,
        pcMaxIsotropic: f.pcMaxIsotropic,
        combinedSigmaKm: +Math.hypot(f.encounterPlane.sigmaXKm, f.encounterPlane.sigmaYKm).toFixed(2),
        sigmaMajorKm: f.encounterPlane.sigmaXKm,
        sigmaMinorKm: f.encounterPlane.sigmaYKm,
        ageDaysA: +ageA.toFixed(2),
        ageDaysB: +ageB.toFixed(2),
        hbrM,
        pcMethod: "foster-2d",
        assumption: "Foster 2D encounter-plane integration; anisotropic covariance modelled from element-set age"
      };
    }

    // No state vector — say so rather than silently reporting a weaker number
    // as though it were the same quantity.
    return {
      ...ev,
      ...screeningPc(ev.missKm, a, b, hbrM),
      pcMethod: "isotropic-screen",
      pcDegraded: "No propagated state at TCA; isotropic screening value, biased LOW"
    };
  });
}

function fmtPcText(p) {
  return p > 0 ? "1e" + Math.ceil(Math.log10(Math.min(1, p))) : "0";
}

// ---------- TLE staleness / data quality ----------
export function staleness(sats) {
  const ages = sats.map(s => ({ id: s.id, name: s.name, org: s.org, ageDays: +tleAgeDays(s).toFixed(2) }));
  ages.sort((x, y) => y.ageDays - x.ageDays);
  const buckets = { "<1d": 0, "1-3d": 0, "3-7d": 0, "7-30d": 0, ">30d": 0 };
  let sum = 0;
  for (const a of ages) {
    sum += a.ageDays;
    if (a.ageDays < 1) buckets["<1d"]++;
    else if (a.ageDays < 3) buckets["1-3d"]++;
    else if (a.ageDays < 7) buckets["3-7d"]++;
    else if (a.ageDays < 30) buckets["7-30d"]++;
    else buckets[">30d"]++;
  }
  return {
    total: sats.length,
    meanAgeDays: +(sum / Math.max(1, sats.length)).toFixed(2),
    buckets,
    stalest: ages.slice(0, 25),
    note: "Position uncertainty grows with element age; stale objects degrade screening confidence."
  };
}

// ---------- eclipse (Earth shadow) windows ----------
function sunEci(date) {
  const jd = date.getTime() / 86400000 + 2440587.5, n = jd - 2451545.0;
  const L = (280.46 + 0.9856474 * n) * Math.PI / 180;
  const g = (357.528 + 0.9856003 * n) * Math.PI / 180;
  const lam = L + (1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * Math.PI / 180;
  const eps = 23.439 * Math.PI / 180;
  return { x: Math.cos(lam), y: Math.cos(eps) * Math.sin(lam), z: Math.sin(eps) * Math.sin(lam) };
}
function inShadow(p, sun) {
  const d = p.x * sun.x + p.y * sun.y + p.z * sun.z; // along-sun component
  if (d > 0) return false; // sunlit side
  const px = p.x - d * sun.x, py = p.y - d * sun.y, pz = p.z - d * sun.z;
  return Math.hypot(px, py, pz) < RE; // inside cylindrical umbra
}
export function eclipseWindows(s, hours = 24) {
  const r = rec(s); if (!r) return { windows: [] };
  const stepS = 20, windows = [];
  let cur = null, sunlitS = 0, shadowS = 0;
  const start = Date.now();
  for (let i = 0; i <= (hours * 3600) / stepS; i++) {
    const t = new Date(start + i * stepS * 1000);
    const pv = posVel(r, t); if (!pv) continue;
    const sh = inShadow(pv.position, sunEci(t));
    if (sh) { shadowS += stepS; if (!cur) cur = { enter: t.toISOString() }; cur.exit = t.toISOString(); }
    else { sunlitS += stepS; if (cur) { cur.durationMin = +(((new Date(cur.exit)) - new Date(cur.enter)) / 60000).toFixed(1); windows.push(cur); cur = null; } }
  }
  if (cur) { cur.durationMin = +(((new Date(cur.exit)) - new Date(cur.enter)) / 60000).toFixed(1); windows.push(cur); }
  return {
    satellite: { id: s.id, name: s.name }, horizonH: hours,
    windows: windows.slice(0, 40),
    sunlitPct: +((sunlitS / Math.max(1, sunlitS + shadowS)) * 100).toFixed(1),
    note: "Cylindrical umbra model; penumbra ignored. Power/thermal & optical-observability planning."
  };
}

// ---------- pro pass prediction: Doppler + optical visibility ----------
export function passesPro(s, lat, lon, hours = 24, freqMhz = 437.5) {
  const r = rec(s); if (!r) return { passes: [] };
  const obs = { latitude: satellite.degreesToRadians(lat), longitude: satellite.degreesToRadians(lon), height: 0.05 };
  const stepS = 10, passes = [];
  let cur = null, prevRange = null;
  const start = Date.now();
  for (let i = 0; i < (hours * 3600) / stepS; i++) {
    const t = new Date(start + i * stepS * 1000);
    const pv = posVel(r, t); if (!pv) { prevRange = null; continue; }
    const gmst = satellite.gstime(t);
    const la = satellite.ecfToLookAngles(obs, satellite.eciToEcf(pv.position, gmst));
    const el = la.elevation * 180 / Math.PI;
    if (el > 0) {
      const rangeRate = prevRange === null ? 0 : (la.rangeSat - prevRange) / stepS; // km/s
      const doppler = -rangeRate / C_KM_S * freqMhz * 1e6; // Hz
      const sun = sunEci(t);
      const satSunlit = !inShadow(pv.position, sun);
      // observer darkness: sun elevation at site < -6 deg (civil twilight)
      const obsEcf = satellite.geodeticToEcf(obs);
      const sEcf = satellite.eciToEcf({ x: sun.x * 1e6, y: sun.y * 1e6, z: sun.z * 1e6 }, gmst);
      const sunLook = satellite.ecfToLookAngles(obs, sEcf);
      const obsDark = (sunLook.elevation * 180 / Math.PI) < -6;
      if (!cur) cur = { aos: t.toISOString(), maxEl: el, maxElAz: +(la.azimuth * 180 / Math.PI).toFixed(0), minRangeKm: la.rangeSat, dopplerMaxHz: 0, visibleS: 0 };
      if (el > cur.maxEl) { cur.maxEl = el; cur.maxElAz = +(la.azimuth * 180 / Math.PI).toFixed(0); }
      if (la.rangeSat < cur.minRangeKm) cur.minRangeKm = la.rangeSat;
      cur.dopplerMaxHz = Math.max(cur.dopplerMaxHz, Math.abs(doppler));
      if (satSunlit && obsDark && el > 10) cur.visibleS += stepS;
      cur.los = t.toISOString();
      prevRange = la.rangeSat;
    } else {
      prevRange = null;
      if (cur) {
        cur.maxEl = +cur.maxEl.toFixed(1);
        cur.minRangeKm = +cur.minRangeKm.toFixed(0);
        cur.dopplerMaxHz = +cur.dopplerMaxHz.toFixed(0);
        cur.durationMin = +((new Date(cur.los) - new Date(cur.aos)) / 60000).toFixed(1);
        cur.opticallyVisible = cur.visibleS >= 30;
        cur.visibleMin = +(cur.visibleS / 60).toFixed(1);
        delete cur.visibleS;
        passes.push(cur); cur = null;
        if (passes.length >= 12) break;
      }
    }
  }
  return {
    satellite: { id: s.id, name: s.name }, observer: { lat, lon }, freqMhz, passes,
    note: "Doppler from range-rate at given downlink frequency; optical visibility = sunlit satellite over dark site (civil twilight), el>10°."
  };
}

// ---------- fleet risk index (0-100, higher = riskier) ----------
export function fleetRisk(org, sats, conjEvents, congestionShells) {
  const fleet = sats.filter(s => s.org === org);
  if (!fleet.length) return { org, error: "No objects for this organization" };
  const n = fleet.length;
  // component: conjunction pressure (events involving fleet, weighted by closeness)
  let conjScore = 0;
  for (const ev of conjEvents) {
    if (ev.a.org === org || ev.b.org === org) conjScore += Math.max(0, 10 - ev.missKm);
  }
  const conj = Math.min(100, (conjScore / Math.max(1, n)) * 40);
  // component: congestion of occupied shells
  const occ = new Map(congestionShells.map(sh => [sh.altKm, sh.density]));
  let congSum = 0, congN = 0;
  for (const s of fleet) {
    const nRad = (s.meanMotion * 2 * Math.PI) / 86400;
    if (!nRad) continue;
    const alt = Math.cbrt(MU / (nRad * nRad)) - RE;
    const bin = Math.floor((alt - 200) / 25) * 25 + 200;
    if (occ.has(bin)) { congSum += occ.get(bin); congN++; }
  }
  const congestion = Math.min(100, (congN ? congSum / congN : 0) * 100);
  // component: decay exposure (share of fleet with perigee < 300 km)
  let low = 0;
  for (const s of fleet) {
    const nRad = (s.meanMotion * 2 * Math.PI) / 86400;
    if (!nRad) continue;
    const a = Math.cbrt(MU / (nRad * nRad));
    if (a * (1 - s.ecc) - RE < 300) low++;
  }
  const decay = Math.min(100, (low / n) * 200);
  // component: element staleness
  const meanAge = fleet.reduce((t, s) => t + tleAgeDays(s), 0) / n;
  const stale = Math.min(100, meanAge * 12);
  const index = +(0.45 * conj + 0.25 * congestion + 0.15 * decay + 0.15 * stale).toFixed(1);
  const grade = index < 15 ? "A" : index < 30 ? "B" : index < 50 ? "C" : index < 70 ? "D" : "E";
  return {
    org, fleetSize: n, index, grade,
    components: {
      conjunctionPressure: +conj.toFixed(1),
      shellCongestion: +congestion.toFixed(1),
      decayExposure: +decay.toFixed(1),
      elementStaleness: +stale.toFixed(1)
    },
    generatedAt: new Date().toISOString(),
    note: "Composite of screening conjunctions (45%), occupied-shell congestion (25%), decay exposure (15%), element staleness (15%)."
  };
}

// ---------- launch-to-object correlation ----------
export function launchCorrelation(launches, sats, siteLookup) {
  const now = Date.now();
  const recent = launches.filter(l => l.net && now - new Date(l.net).getTime() < 21 * 86400000 && now - new Date(l.net).getTime() > 0);
  const year = new Date().getUTCFullYear();
  const fresh = sats.filter(s => s.intl && s.intl.startsWith(String(year)) && tleAgeDays(s) < 30);
  const out = [];
  for (const l of recent) {
    const siteLat = siteLookup(l.location || "");
    const tL = new Date(l.net).getTime();
    const matches = fresh.filter(s => {
      const dtDays = Math.abs((new Date(s.epoch).getTime() - tL) / 86400000);
      const inclOk = siteLat === null ? true : (s.incl + 0.8 >= Math.abs(siteLat));
      return dtDays < 14 && inclOk;
    }).map(s => ({ id: s.id, name: s.name, intl: s.intl, incl: s.incl, org: s.org }))
      .slice(0, 12);
    if (matches.length) out.push({ launch: l.name, net: l.net, site: l.location, siteLat, candidates: matches });
  }
  return { correlations: out, note: "Candidate objects: fresh catalog entries within 14 days of launch whose inclination is reachable from the site latitude." };
}

// ---------- Gabbard diagram data (debris analysis) ----------
export function gabbard(sats, groupQuery) {
  const q = groupQuery.toUpperCase();
  const members = sats.filter(s => s.name.toUpperCase().includes(q));
  const series = members.map(s => {
    const nRad = (s.meanMotion * 2 * Math.PI) / 86400;
    if (!nRad) return null;
    const a = Math.cbrt(MU / (nRad * nRad));
    return {
      id: s.id, name: s.name,
      periodMin: +(1440 / s.meanMotion).toFixed(2),
      apogeeKm: +(a * (1 + s.ecc) - RE).toFixed(1),
      perigeeKm: +(a * (1 - s.ecc) - RE).toFixed(1)
    };
  }).filter(Boolean);
  return { group: groupQuery, count: series.length, series, note: "Gabbard diagram series: period vs apogee/perigee reveals breakup energy distribution." };
}

// ---------- pattern-of-life anomalies ----------
export function anomalies(sats, history) {
  const deltas = [];
  for (const s of sats) {
    const h = history[s.id];
    if (!h?.prev) continue;
    const days = Math.max(0.02, Math.abs(new Date(s.epoch) - new Date(h.prev.epoch)) / 86400000);
    deltas.push({ s, rate: Math.abs(s.meanMotion - h.prev.meanMotion) / days, dIncl: Math.abs((s.incl ?? 0) - (h.prev.incl ?? 0)) });
  }
  if (!deltas.length) return { flags: [], note: "Insufficient element history yet — history accrues with each catalog refresh." };
  const rates = deltas.map(d => d.rate).sort((a, b) => a - b);
  const med = rates[Math.floor(rates.length / 2)] || 0;
  const mad = rates.map(r => Math.abs(r - med)).sort((a, b) => a - b)[Math.floor(rates.length / 2)] || 1e-6;
  const flags = deltas
    .map(d => ({ ...d, z: (d.rate - med) / (1.4826 * mad) }))
    .filter(d => d.z > 6 || d.dIncl > 0.05)
    .sort((a, b) => b.z - a.z)
    .slice(0, 30)
    .map(d => ({
      id: d.s.id, name: d.s.name, org: d.s.org,
      mmRatePerDay: +d.rate.toFixed(5), zScore: +d.z.toFixed(1), dInclDeg: +d.dIncl.toFixed(3),
      severity: d.z > 15 || d.dIncl > 0.2 ? "HIGH" : "MODERATE"
    }));
  return { flags, population: deltas.length, note: "Robust z-score (median/MAD) on epoch-over-epoch mean-motion rate; flags out-of-family behavior." };
}
// ============================================================
// OrbitIQ Intel Pack — derived space intelligence (premium tier)
// All quantities computed from public GP elements with documented
// assumptions. Screening-grade, not operational CDM replacement.
// ============================================================
import * as satellite from "satellite.js";

import { EARTH_R_KM as RE, MU_KM3_S2 as MU } from "./constants.js";
const C_KM_S = 299792.458;

const rec = s => { try { return satellite.json2satrec(s.gp); } catch { return null; } };
const posVel = (r, t) => { try { const pv = satellite.propagate(r, t); return pv?.position && !Number.isNaN(pv.position.x) ? pv : null; } catch { return null; } };
const tleAgeDays = s => Math.max(0, (Date.now() - new Date(s.epoch).getTime()) / 86400000);

// ---------- probability of collision (2D screening Pc) ----------
// Assumed covariance model: per-object 1-sigma position uncertainty grows
// with TLE age (base 1.0 km + 0.75 km/day, capped at 6 km). Combined
// hard-body radius default 20 m. Standard small-HBR 2D approximation.
export function screeningPc(missKm, a, b, hbrM = 20) {
  const sig = s => Math.min(6, 1.0 + 0.75 * tleAgeDays(s));
  const sA = sig(a), sB = sig(b);
  const sigma = Math.sqrt(sA * sA + sB * sB); // combined, isotropic in encounter plane
  const hbrKm = hbrM / 1000;
  const pc = (hbrKm * hbrKm / (2 * sigma * sigma)) * Math.exp(-(missKm * missKm) / (2 * sigma * sigma));
  return {
    pc: Math.min(1, pc),
    pcText: pc > 0 ? "1e" + Math.ceil(Math.log10(Math.min(1, pc))) : "0",
    combinedSigmaKm: +sigma.toFixed(2),
    hbrM,
    assumption: "Isotropic assumed covariance from TLE age; screening-grade only"
  };
}
export function augmentConjunctions(events, satsById) {
  return events.map(ev => {
    const a = satsById.get(ev.a.id), b = satsById.get(ev.b.id);
    if (!a || !b) return ev;
    return { ...ev, ...screeningPc(ev.missKm, a, b) };
  });
}

// ---------- TLE staleness / data quality ----------
export function staleness(sats) {
  const ages = sats.map(s => ({ id: s.id, name: s.name, org: s.org, ageDays: +tleAgeDays(s).toFixed(2) }));
  ages.sort((x, y) => y.ageDays - x.ageDays);
  const buckets = { "<1d": 0, "1-3d": 0, "3-7d": 0, "7-30d": 0, ">30d": 0 };
  let sum = 0;
  for (const a of ages) {
    sum += a.ageDays;
    if (a.ageDays < 1) buckets["<1d"]++;
    else if (a.ageDays < 3) buckets["1-3d"]++;
    else if (a.ageDays < 7) buckets["3-7d"]++;
    else if (a.ageDays < 30) buckets["7-30d"]++;
    else buckets[">30d"]++;
  }
  return {
    total: sats.length,
    meanAgeDays: +(sum / Math.max(1, sats.length)).toFixed(2),
    buckets,
    stalest: ages.slice(0, 25),
    note: "Position uncertainty grows with element age; stale objects degrade screening confidence."
  };
}

// ---------- eclipse (Earth shadow) windows ----------
function sunEci(date) {
  const jd = date.getTime() / 86400000 + 2440587.5, n = jd - 2451545.0;
  const L = (280.46 + 0.9856474 * n) * Math.PI / 180;
  const g = (357.528 + 0.9856003 * n) * Math.PI / 180;
  const lam = L + (1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * Math.PI / 180;
  const eps = 23.439 * Math.PI / 180;
  return { x: Math.cos(lam), y: Math.cos(eps) * Math.sin(lam), z: Math.sin(eps) * Math.sin(lam) };
}
function inShadow(p, sun) {
  const d = p.x * sun.x + p.y * sun.y + p.z * sun.z; // along-sun component
  if (d > 0) return false; // sunlit side
  const px = p.x - d * sun.x, py = p.y - d * sun.y, pz = p.z - d * sun.z;
  return Math.hypot(px, py, pz) < RE; // inside cylindrical umbra
}
export function eclipseWindows(s, hours = 24) {
  const r = rec(s); if (!r) return { windows: [] };
  const stepS = 20, windows = [];
  let cur = null, sunlitS = 0, shadowS = 0;
  const start = Date.now();
  for (let i = 0; i <= (hours * 3600) / stepS; i++) {
    const t = new Date(start + i * stepS * 1000);
    const pv = posVel(r, t); if (!pv) continue;
    const sh = inShadow(pv.position, sunEci(t));
    if (sh) { shadowS += stepS; if (!cur) cur = { enter: t.toISOString() }; cur.exit = t.toISOString(); }
    else { sunlitS += stepS; if (cur) { cur.durationMin = +(((new Date(cur.exit)) - new Date(cur.enter)) / 60000).toFixed(1); windows.push(cur); cur = null; } }
  }
  if (cur) { cur.durationMin = +(((new Date(cur.exit)) - new Date(cur.enter)) / 60000).toFixed(1); windows.push(cur); }
  return {
    satellite: { id: s.id, name: s.name }, horizonH: hours,
    windows: windows.slice(0, 40),
    sunlitPct: +((sunlitS / Math.max(1, sunlitS + shadowS)) * 100).toFixed(1),
    note: "Cylindrical umbra model; penumbra ignored. Power/thermal & optical-observability planning."
  };
}

// ---------- pro pass prediction: Doppler + optical visibility ----------
export function passesPro(s, lat, lon, hours = 24, freqMhz = 437.5) {
  const r = rec(s); if (!r) return { passes: [] };
  const obs = { latitude: satellite.degreesToRadians(lat), longitude: satellite.degreesToRadians(lon), height: 0.05 };
  const stepS = 10, passes = [];
  let cur = null, prevRange = null;
  const start = Date.now();
  for (let i = 0; i < (hours * 3600) / stepS; i++) {
    const t = new Date(start + i * stepS * 1000);
    const pv = posVel(r, t); if (!pv) { prevRange = null; continue; }
    const gmst = satellite.gstime(t);
    const la = satellite.ecfToLookAngles(obs, satellite.eciToEcf(pv.position, gmst));
    const el = la.elevation * 180 / Math.PI;
    if (el > 0) {
      const rangeRate = prevRange === null ? 0 : (la.rangeSat - prevRange) / stepS; // km/s
      const doppler = -rangeRate / C_KM_S * freqMhz * 1e6; // Hz
      const sun = sunEci(t);
      const satSunlit = !inShadow(pv.position, sun);
      // observer darkness: sun elevation at site < -6 deg (civil twilight)
      const obsEcf = satellite.geodeticToEcf(obs);
      const sEcf = satellite.eciToEcf({ x: sun.x * 1e6, y: sun.y * 1e6, z: sun.z * 1e6 }, gmst);
      const sunLook = satellite.ecfToLookAngles(obs, sEcf);
      const obsDark = (sunLook.elevation * 180 / Math.PI) < -6;
      if (!cur) cur = { aos: t.toISOString(), maxEl: el, maxElAz: +(la.azimuth * 180 / Math.PI).toFixed(0), minRangeKm: la.rangeSat, dopplerMaxHz: 0, visibleS: 0 };
      if (el > cur.maxEl) { cur.maxEl = el; cur.maxElAz = +(la.azimuth * 180 / Math.PI).toFixed(0); }
      if (la.rangeSat < cur.minRangeKm) cur.minRangeKm = la.rangeSat;
      cur.dopplerMaxHz = Math.max(cur.dopplerMaxHz, Math.abs(doppler));
      if (satSunlit && obsDark && el > 10) cur.visibleS += stepS;
      cur.los = t.toISOString();
      prevRange = la.rangeSat;
    } else {
      prevRange = null;
      if (cur) {
        cur.maxEl = +cur.maxEl.toFixed(1);
        cur.minRangeKm = +cur.minRangeKm.toFixed(0);
        cur.dopplerMaxHz = +cur.dopplerMaxHz.toFixed(0);
        cur.durationMin = +((new Date(cur.los) - new Date(cur.aos)) / 60000).toFixed(1);
        cur.opticallyVisible = cur.visibleS >= 30;
        cur.visibleMin = +(cur.visibleS / 60).toFixed(1);
        delete cur.visibleS;
        passes.push(cur); cur = null;
        if (passes.length >= 12) break;
      }
    }
  }
  return {
    satellite: { id: s.id, name: s.name }, observer: { lat, lon }, freqMhz, passes,
    note: "Doppler from range-rate at given downlink frequency; optical visibility = sunlit satellite over dark site (civil twilight), el>10°."
  };
}

// ---------- fleet risk index (0-100, higher = riskier) ----------
export function fleetRisk(org, sats, conjEvents, congestionShells) {
  const fleet = sats.filter(s => s.org === org);
  if (!fleet.length) return { org, error: "No objects for this organization" };
  const n = fleet.length;
  // component: conjunction pressure (events involving fleet, weighted by closeness)
  let conjScore = 0;
  for (const ev of conjEvents) {
    if (ev.a.org === org || ev.b.org === org) conjScore += Math.max(0, 10 - ev.missKm);
  }
  const conj = Math.min(100, (conjScore / Math.max(1, n)) * 40);
  // component: congestion of occupied shells
  const occ = new Map(congestionShells.map(sh => [sh.altKm, sh.density]));
  let congSum = 0, congN = 0;
  for (const s of fleet) {
    const nRad = (s.meanMotion * 2 * Math.PI) / 86400;
    if (!nRad) continue;
    const alt = Math.cbrt(MU / (nRad * nRad)) - RE;
    const bin = Math.floor((alt - 200) / 25) * 25 + 200;
    if (occ.has(bin)) { congSum += occ.get(bin); congN++; }
  }
  const congestion = Math.min(100, (congN ? congSum / congN : 0) * 100);
  // component: decay exposure (share of fleet with perigee < 300 km)
  let low = 0;
  for (const s of fleet) {
    const nRad = (s.meanMotion * 2 * Math.PI) / 86400;
    if (!nRad) continue;
    const a = Math.cbrt(MU / (nRad * nRad));
    if (a * (1 - s.ecc) - RE < 300) low++;
  }
  const decay = Math.min(100, (low / n) * 200);
  // component: element staleness
  const meanAge = fleet.reduce((t, s) => t + tleAgeDays(s), 0) / n;
  const stale = Math.min(100, meanAge * 12);
  const index = +(0.45 * conj + 0.25 * congestion + 0.15 * decay + 0.15 * stale).toFixed(1);
  const grade = index < 15 ? "A" : index < 30 ? "B" : index < 50 ? "C" : index < 70 ? "D" : "E";
  return {
    org, fleetSize: n, index, grade,
    components: {
      conjunctionPressure: +conj.toFixed(1),
      shellCongestion: +congestion.toFixed(1),
      decayExposure: +decay.toFixed(1),
      elementStaleness: +stale.toFixed(1)
    },
    generatedAt: new Date().toISOString(),
    note: "Composite of screening conjunctions (45%), occupied-shell congestion (25%), decay exposure (15%), element staleness (15%)."
  };
}

// ---------- launch-to-object correlation ----------
export function launchCorrelation(launches, sats, siteLookup) {
  const now = Date.now();
  const recent = launches.filter(l => l.net && now - new Date(l.net).getTime() < 21 * 86400000 && now - new Date(l.net).getTime() > 0);
  const year = new Date().getUTCFullYear();
  const fresh = sats.filter(s => s.intl && s.intl.startsWith(String(year)) && tleAgeDays(s) < 30);
  const out = [];
  for (const l of recent) {
    const siteLat = siteLookup(l.location || "");
    const tL = new Date(l.net).getTime();
    const matches = fresh.filter(s => {
      const dtDays = Math.abs((new Date(s.epoch).getTime() - tL) / 86400000);
      const inclOk = siteLat === null ? true : (s.incl + 0.8 >= Math.abs(siteLat));
      return dtDays < 14 && inclOk;
    }).map(s => ({ id: s.id, name: s.name, intl: s.intl, incl: s.incl, org: s.org }))
      .slice(0, 12);
    if (matches.length) out.push({ launch: l.name, net: l.net, site: l.location, siteLat, candidates: matches });
  }
  return { correlations: out, note: "Candidate objects: fresh catalog entries within 14 days of launch whose inclination is reachable from the site latitude." };
}

// ---------- Gabbard diagram data (debris analysis) ----------
export function gabbard(sats, groupQuery) {
  const q = groupQuery.toUpperCase();
  const members = sats.filter(s => s.name.toUpperCase().includes(q));
  const series = members.map(s => {
    const nRad = (s.meanMotion * 2 * Math.PI) / 86400;
    if (!nRad) return null;
    const a = Math.cbrt(MU / (nRad * nRad));
    return {
      id: s.id, name: s.name,
      periodMin: +(1440 / s.meanMotion).toFixed(2),
      apogeeKm: +(a * (1 + s.ecc) - RE).toFixed(1),
      perigeeKm: +(a * (1 - s.ecc) - RE).toFixed(1)
    };
  }).filter(Boolean);
  return { group: groupQuery, count: series.length, series, note: "Gabbard diagram series: period vs apogee/perigee reveals breakup energy distribution." };
}

// ---------- pattern-of-life anomalies ----------
export function anomalies(sats, history) {
  const deltas = [];
  for (const s of sats) {
    const h = history[s.id];
    if (!h?.prev) continue;
    const days = Math.max(0.02, Math.abs(new Date(s.epoch) - new Date(h.prev.epoch)) / 86400000);
    deltas.push({ s, rate: Math.abs(s.meanMotion - h.prev.meanMotion) / days, dIncl: Math.abs((s.incl ?? 0) - (h.prev.incl ?? 0)) });
  }
  if (!deltas.length) return { flags: [], note: "Insufficient element history yet — history accrues with each catalog refresh." };
  const rates = deltas.map(d => d.rate).sort((a, b) => a - b);
  const med = rates[Math.floor(rates.length / 2)] || 0;
  const mad = rates.map(r => Math.abs(r - med)).sort((a, b) => a - b)[Math.floor(rates.length / 2)] || 1e-6;
  const flags = deltas
    .map(d => ({ ...d, z: (d.rate - med) / (1.4826 * mad) }))
    .filter(d => d.z > 6 || d.dIncl > 0.05)
    .sort((a, b) => b.z - a.z)
    .slice(0, 30)
    .map(d => ({
      id: d.s.id, name: d.s.name, org: d.s.org,
      mmRatePerDay: +d.rate.toFixed(5), zScore: +d.z.toFixed(1), dInclDeg: +d.dIncl.toFixed(3),
      severity: d.z > 15 || d.dIncl > 0.2 ? "HIGH" : "MODERATE"
    }));
  return { flags, population: deltas.length, note: "Robust z-score (median/MAD) on epoch-over-epoch mean-motion rate; flags out-of-family behavior." };
}
