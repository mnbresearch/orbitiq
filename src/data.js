// OrbitIQ data layer — free public sources, cached on disk.
// Sources:
//   CelesTrak GP data (orbital elements, updated multiple times daily) — free
//   Launch Library 2 (The Space Devs) — free tier
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.join(__dirname, "..", "cache");
const DATA_DIR = path.join(__dirname, "..", "data");
fs.mkdirSync(CACHE_DIR, { recursive: true });

const CELESTRAK = "https://celestrak.org/NORAD/elements/gp.php";
const LL2 = "https://ll.thespacedevs.com/2.2.0";

// Groups we ingest. "active" alone is ~11k objects; we merge several curated
// groups so the platform covers constellations, stations, debris and more.
export const GROUPS = [
  "active",          // all active satellites
  "cosmos-1408-debris",
  "iridium-33-debris"
];

const SAT_TTL_MS = 6 * 60 * 60 * 1000;      // re-fetch orbital data every 6h
const LAUNCH_TTL_MS = 60 * 60 * 1000;       // launches every 1h

// ---------- generic cached fetch ----------
async function cachedJson(key, url, ttlMs) {
  const file = path.join(CACHE_DIR, key + ".json");
  try {
    const st = fs.statSync(file);
    if (Date.now() - st.mtimeMs < ttlMs) {
      return JSON.parse(fs.readFileSync(file, "utf8"));
    }
  } catch { /* no cache yet */ }

  try {
    const res = await fetch(url, { headers: { "User-Agent": "OrbitIQ/1.0" } });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    const json = await res.json();
    fs.writeFileSync(file, JSON.stringify(json));
    return json;
  } catch (err) {
    // network failed — serve stale cache, then bundled sample data
    try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { /* none */ }
    const sample = path.join(DATA_DIR, key + ".sample.json");
    try { return JSON.parse(fs.readFileSync(sample, "utf8")); } catch { /* none */ }
    throw err;
  }
}

// ---------- organization classification ----------
// Maps object names / intl designators to operators & programs.
const ORG_RULES = [
  { id: "spacex",   name: "SpaceX (Starlink)",        test: n => n.startsWith("STARLINK") },
  { id: "oneweb",   name: "Eutelsat OneWeb",          test: n => n.startsWith("ONEWEB") },
  { id: "kuiper",   name: "Amazon Kuiper",            test: n => n.startsWith("KUIPER") },
  { id: "iridium",  name: "Iridium",                  test: n => n.startsWith("IRIDIUM") },
  { id: "planet",   name: "Planet Labs",              test: n => n.startsWith("FLOCK") || n.startsWith("SKYSAT") || n.startsWith("PELICAN") },
  { id: "spire",    name: "Spire Global",             test: n => n.startsWith("LEMUR") },
  { id: "sda",      name: "US SDA / USSF",            test: n => n.startsWith("USA ") || n.includes("TRANCHE") || n.startsWith("GSSAP") },
  { id: "gps",      name: "GPS (Navstar)",            test: n => n.startsWith("NAVSTAR") || n.startsWith("GPS ") },
  { id: "galileo",  name: "ESA Galileo",              test: n => n.startsWith("GSAT") && /GALILEO|GSAT\d{4}/.test(n) || n.startsWith("GALILEO") },
  { id: "glonass",  name: "GLONASS",                  test: n => n.startsWith("COSMOS") && false },
  { id: "beidou",   name: "BeiDou",                   test: n => n.startsWith("BEIDOU") },
  { id: "isro",     name: "ISRO (India)",             test: n => n.startsWith("CARTOSAT") || n.startsWith("RISAT") || n.startsWith("EOS-") || n.startsWith("INSAT") || n.startsWith("GSAT-") || n.startsWith("IRNSS") || n.startsWith("NVS-") || n.startsWith("RESOURCESAT") || n.startsWith("OCEANSAT") },
  { id: "stations", name: "Crewed Stations",          test: n => n.startsWith("ISS") || n.startsWith("CSS") || n.includes("TIANGONG") || n.startsWith("TIANHE") },
  { id: "eumetsat", name: "Weather (NOAA/EUMETSAT)",  test: n => n.startsWith("NOAA") || n.startsWith("METOP") || n.startsWith("GOES") || n.startsWith("METEOSAT") },
  { id: "debris",   name: "Tracked Debris",           test: (n, obj) => (obj.OBJECT_TYPE === "DEBRIS") || n.includes(" DEB") },
];

export function classify(obj) {
  const n = (obj.OBJECT_NAME || "").toUpperCase();
  for (const r of ORG_RULES) {
    try { if (r.test(n, obj)) return r.id; } catch { /* skip */ }
  }
  return "other";
}

export function orgList(sats) {
  const counts = {};
  for (const s of sats) counts[s.org] = (counts[s.org] || 0) + 1;
  const meta = Object.fromEntries(ORG_RULES.map(r => [r.id, r.name]));
  meta.other = "Other Operators";
  return Object.entries(counts)
    .map(([id, count]) => ({ id, name: meta[id] || id, count }))
    .sort((a, b) => b.count - a.count);
}

// ---------- satellites ----------
let satCache = { at: 0, sats: null };

export async function getSatellites() {
  if (satCache.sats && Date.now() - satCache.at < 10 * 60 * 1000) return satCache.sats;

  const seen = new Set();
  const sats = [];
  for (const g of GROUPS) {
    let rows;
    try {
      rows = await cachedJson("celestrak-" + g, `${CELESTRAK}?GROUP=${g}&FORMAT=json`, SAT_TTL_MS);
    } catch { continue; }
    if (!Array.isArray(rows)) continue;
    for (const o of rows) {
      if (seen.has(o.NORAD_CAT_ID)) continue;
      seen.add(o.NORAD_CAT_ID);
      sats.push({
        id: o.NORAD_CAT_ID,
        name: o.OBJECT_NAME,
        intl: o.OBJECT_ID,
        epoch: o.EPOCH,
        meanMotion: o.MEAN_MOTION,
        ecc: o.ECCENTRICITY,
        incl: o.INCLINATION,
        raan: o.RA_OF_ASC_NODE,
        argp: o.ARG_OF_PERICENTER,
        ma: o.MEAN_ANOMALY,
        bstar: o.BSTAR,
        revNum: o.REV_AT_EPOCH,
        classification: o.CLASSIFICATION_TYPE,
        noradType: o.OBJECT_TYPE ||
          (/ DEB/.test(o.OBJECT_NAME) ? "DEBRIS" : / R\/B/.test(o.OBJECT_NAME) ? "ROCKET BODY" : "PAYLOAD"),
        org: classify(o),
        // raw GP fields needed by satellite.js on the client
        gp: {
          OBJECT_NAME: o.OBJECT_NAME, OBJECT_ID: o.OBJECT_ID, EPOCH: o.EPOCH,
          MEAN_MOTION: o.MEAN_MOTION, ECCENTRICITY: o.ECCENTRICITY,
          INCLINATION: o.INCLINATION, RA_OF_ASC_NODE: o.RA_OF_ASC_NODE,
          ARG_OF_PERICENTER: o.ARG_OF_PERICENTER, MEAN_ANOMALY: o.MEAN_ANOMALY,
          NORAD_CAT_ID: o.NORAD_CAT_ID, BSTAR: o.BSTAR,
          MEAN_MOTION_DOT: o.MEAN_MOTION_DOT, MEAN_MOTION_DDOT: o.MEAN_MOTION_DDOT,
          EPHEMERIS_TYPE: o.EPHEMERIS_TYPE, CLASSIFICATION_TYPE: o.CLASSIFICATION_TYPE,
          ELEMENT_SET_NO: o.ELEMENT_SET_NO, REV_AT_EPOCH: o.REV_AT_EPOCH
        }
      });
    }
  }
  if (sats.length) satCache = { at: Date.now(), sats };
  return sats;
}

// ---------- launches ----------
export async function getLaunches() {
  const [upcoming, previous] = await Promise.all([
    cachedJson("launches-upcoming", `${LL2}/launch/upcoming/?limit=25&mode=list`, LAUNCH_TTL_MS),
    cachedJson("launches-previous", `${LL2}/launch/previous/?limit=15&mode=list`, LAUNCH_TTL_MS)
  ]);
  const slim = l => ({
    id: l.id,
    name: l.name,
    status: l.status?.abbrev || l.status?.name,
    net: l.net,
    provider: l.launch_service_provider?.name || l.lsp_name,
    pad: l.pad?.name,
    location: l.pad?.location?.name || l.location,
    mission: l.mission?.name,
    orbit: l.mission?.orbit?.abbrev,
    image: l.image
  });
  return {
    upcoming: (upcoming?.results || []).map(slim),
    previous: (previous?.results || []).map(slim)
  };
}

// ---------- space events (dockings, EVAs, flybys, etc.) ----------
export async function getEvents() {
  const data = await cachedJson("events-upcoming", `${LL2}/event/upcoming/?limit=15`, LAUNCH_TTL_MS);
  return (data?.results || []).map(e => ({
    id: e.id,
    name: e.name,
    type: e.type?.name,
    date: e.date,
    location: e.location,
    description: (e.description || "").slice(0, 220),
    news: e.news_url,
    video: e.video_url
  }));
}
