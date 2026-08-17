// ============================================================
// OrbitIQ Space Environment — NOAA SWPC space weather feed.
// Geomagnetic activity drives atmospheric density, which drives
// LEO drag, decay timing and conjunction uncertainty. Every
// sweep archives the environment so risk events can later be
// correlated with the conditions they occurred under.
// ============================================================

const KP_URL = "https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json";
const FLUX_URL = "https://services.swpc.noaa.gov/products/summary/10cm-flux.json";
const TTL_MS = 30 * 60 * 1000;

let cache = null;

// Bundled fallback — used when NOAA is unreachable (offline dev,
// blocked egress). Clearly labelled as sample data.
const SAMPLE = { kp: 2.33, f107: 142, sampled: true };

async function fetchJson(url, ms = 8000) {
  const r = await fetch(url, { signal: AbortSignal.timeout(ms), headers: { "User-Agent": "OrbitIQ/7.0" } });
  if (!r.ok) throw new Error("HTTP " + r.status);
  return r.json();
}

function classify(kp) {
  if (kp >= 9) return { g: "G5", label: "Extreme storm" };
  if (kp >= 8) return { g: "G4", label: "Severe storm" };
  if (kp >= 7) return { g: "G3", label: "Strong storm" };
  if (kp >= 6) return { g: "G2", label: "Moderate storm" };
  if (kp >= 5) return { g: "G1", label: "Minor storm" };
  if (kp >= 4) return { g: "G0", label: "Active" };
  return { g: "G0", label: "Quiet" };
}

function dragAdvisory(kp) {
  if (kp >= 7) return "Severe geomagnetic heating — LEO density may be 2–4× baseline. Decay projections and conjunction miss distances are unreliable; re-screen frequently.";
  if (kp >= 5) return "Storm-time density enhancement in LEO (≈30–100%). Expect faster decay and growing along-track errors in TLE propagation.";
  if (kp >= 4) return "Mildly elevated drag environment. Propagation error grows slightly faster than baseline.";
  return "Quiet drag environment — TLE propagation error near baseline.";
}

export async function getSpaceWeather() {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.data;
  let kp = null, kpTime = null, f107 = null, source = "NOAA SWPC";
  try {
    const rows = await fetchJson(KP_URL);
    // rows[0] is a header row: ["time_tag","Kp","a_running","station_count"]
    const last = rows[rows.length - 1];
    kp = parseFloat(last[1]);
    kpTime = last[0];
  } catch { /* fall back below */ }
  try {
    const f = await fetchJson(FLUX_URL);
    f107 = parseFloat(f.Flux);
  } catch { /* optional */ }
  let sampled = false;
  if (kp === null || Number.isNaN(kp)) { kp = SAMPLE.kp; f107 = f107 ?? SAMPLE.f107; sampled = true; source = "bundled sample (NOAA unreachable)"; }
  const cls = classify(kp);
  const data = {
    kp: +kp.toFixed(2),
    kpTime: kpTime || new Date().toISOString(),
    f107: f107 && !Number.isNaN(f107) ? f107 : null,
    storm: cls.g,
    stormLabel: cls.label,
    advisory: dragAdvisory(kp),
    // equatorward auroral boundary estimate (deg geomagnetic ≈ geographic here)
    auroraLat: +(67 - 2.2 * kp).toFixed(1),
    auroraVisible: kp >= 4,
    sampled, source,
    fetchedAt: new Date().toISOString()
  };
  cache = { at: Date.now(), data };
  return data;
}

export async function environmentForLedger() {
  const w = await getSpaceWeather();
  return { org: null, kp: w.kp, f107: w.f107, storm: w.storm, auroraLat: w.auroraLat, sampled: w.sampled };
}
