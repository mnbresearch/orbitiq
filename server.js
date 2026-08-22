// ============================================================
// OrbitIQ — Space Traffic Intelligence Platform (server v3)
// ============================================================
import express from "express";
import compression from "compression";
import http from "http";
import crypto from "crypto";
import path from "path";
import { fileURLToPath } from "url";
import { WebSocketServer } from "ws";
import * as satellite from "satellite.js";
import * as backup from "./src/backup.js"; // must be first: restores the archive before stores load
import { getSatellites, getLaunches, getEvents, orgList, dataSourceInfo } from "./src/data.js";
import { screenConjunctions } from "./src/conjunctions.js";
import { hohmann, launchPlan, congestion, detectManeuvers, LAUNCH_SITES } from "./src/astro.js";
import * as intel from "./src/intel.js";
import * as ledger from "./src/ledger.js";
import * as store from "./src/store.js";
import * as netops from "./src/netops.js";
import * as fleetintel from "./src/fleetintel.js";
import * as auth from "./src/auth.js";
import * as mailer from "./src/mailer.js";
import * as fleet from "./src/fleet.js";
import * as watch from "./src/watch.js";
import * as pcmod from "./src/pc.js";
import * as trend from "./src/trend.js";
import { getSpaceWeather, environmentForLedger } from "./src/spaceweather.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(compression());
// Render and Cloudflare both front this app, so req.ip is the proxy address
// unless we say how many hops to trust. Without this every per-IP rate limit
// below collapses into a single global bucket: one noisy client 429s all
// anonymous users, and ten bad password attempts lock out every login.
app.set("trust proxy", 1);
app.use(express.json({ limit: "100kb" }));
// v10: the landing page is the front door; the console lives at /app
const PUBLIC_DIR = path.join(__dirname, "public");
app.get("/", (req, res) => res.sendFile(path.join(PUBLIC_DIR, "landing.html")));
app.get(["/app", "/console"], (req, res) => res.sendFile(path.join(PUBLIC_DIR, "index.html")));
app.use(express.static(PUBLIC_DIR, { index: false }));
app.use("/vendor/three", express.static(path.join(__dirname, "node_modules", "three", "build")));

// ---------- SEO: robots + sitemap ----------
// Search engines need to be told this host is indexable and that it belongs to
// the same organisation as www.mnbresearch.com. The landing page carries the
// canonical, Open Graph and JSON-LD publisher markup; these two files make the
// host crawlable in the first place.
app.get("/robots.txt", (_req, res) => {
  res.type("text/plain").send([
    "User-agent: *",
    "Allow: /$",
    "Allow: /landing.html",
    "Allow: /status.html",
    "Allow: /docs.html",
    // The application itself is behind auth and has no public content to index.
    "Disallow: /app",
    "Disallow: /api/",
    "Disallow: /login.html",
    "Disallow: /admin.html",
    "",
    "Sitemap: https://orbit.mnbresearch.com/sitemap.xml",
    ""
  ].join("\n"));
});

app.get("/sitemap.xml", (_req, res) => {
  const base = "https://orbit.mnbresearch.com";
  const today = new Date().toISOString().slice(0, 10);
  const pages = [
    { loc: "/",            pri: "1.0", freq: "weekly"  },
    { loc: "/docs.html",   pri: "0.6", freq: "monthly" },
    { loc: "/status.html", pri: "0.4", freq: "daily"   }
  ];
  res.type("application/xml").send(
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    pages.map(p =>
      `  <url><loc>${base}${p.loc}</loc><lastmod>${today}</lastmod>` +
      `<changefreq>${p.freq}</changefreq><priority>${p.pri}</priority></url>`
    ).join("\n") + `\n</urlset>\n`
  );
});

app.use("/vendor/satellite", express.static(path.join(__dirname, "node_modules", "satellite.js", "dist")));

const PORT = process.env.PORT || 3000;
const api = express.Router();

// ---------- optional API-key auth + anonymous rate limiting ----------
const anonBuckets = new Map();
api.use((req, res, next) => {
  const key = req.headers["x-api-key"] || req.query.apiKey;
  if (key) {
    const ws = store.findByKey(String(key));
    if (!ws) return res.status(401).json({ error: "Invalid API key" });
    req.workspace = ws;
    const plan = store.PLANS[ws.plan] || store.PLANS.free;
    if (ws.role !== "admin" && store.todayCalls(ws.apiKey) >= plan.dailyCalls) {
      return res.status(429).json({ error: "Daily call limit reached", plan: ws.plan, limit: plan.dailyCalls, upgrade: "Higher tiers include larger daily quotas." });
    }
    store.recordUsage(ws.apiKey);
  } else {
    // gentle per-IP limit for anonymous traffic so free users create workspaces
    const ip = req.ip || "?", min = Math.floor(Date.now() / 60000);
    if (anonBuckets.size > 5000) anonBuckets.clear();
    const b = anonBuckets.get(ip);
    if (!b || b.min !== min) anonBuckets.set(ip, { min, n: 1 });
    else if (++b.n > 120) return res.status(429).json({
      error: "Anonymous rate limit (120 req/min). Create a free workspace for metered quotas.",
      plans: "/api/plans"
    });
  }
  next();
});
const requirePlan = min => (req, res, next) => {
  const rank = req.workspace ? (store.PLANS[req.workspace.plan]?.rank ?? 0) : -1;
  const need = store.PLANS[min].rank;
  if (req.workspace?.role === "admin" || rank >= need) return next();
  return res.status(402).json({
    error: `${store.PLANS[min].label} plan required`,
    yourPlan: req.workspace?.plan || "none",
    plans: "/api/plans"
  });
};
const requireWs = (req, res, next) => req.workspace ? next() : res.status(401).json({ error: "X-API-Key header required" });
const requireAdmin = (req, res, next) =>
  req.workspace?.role === "admin" ? next() : res.status(403).json({ error: "Admin key required" });
const requirePro = (req, res, next) =>
  (req.workspace && (req.workspace.plan === "pro" || req.workspace.role === "admin"))
    ? next()
    : res.status(402).json({ error: "Pro plan required", detail: "This intelligence endpoint is part of the OrbitIQ Pro subscription. Create a workspace and contact the operator to upgrade." });

// ---------- caches ----------
const conjCache = new Map();
const CONJ_TTL = 15 * 60 * 1000;
// With the live catalog (~16k objects) an unbounded screen blocks the event
// loop for minutes on a small instance. Cap the screening population,
// prioritizing the lowest-perigee objects — the congested regime where the
// collision risk actually lives. Override with ORBITIQ_SWEEP_CAP.
// parseInt is forgiving in a way that is dangerous here: parseInt("3k") is 3,
// so a typo in this env var silently reduces the screening population to a
// handful of objects and every screen comes back clean. That is the worst
// possible failure — the product reports "no conjunctions" and looks healthy.
// Validate, refuse nonsense, say so loudly, and publish the value in /status.
// Bound for the unscoped all-on-all screen; see the note in runScreening.
const ALL_ON_ALL_CAP = parseInt(process.env.ORBITIQ_ALL_ON_ALL_CAP || "2500", 10) || 2500;
// Screening on the web instance is OFF by default — see the long note in
// runScreening(). This exists so a bigger box (or a local dev run, or the test
// suite) can still exercise the compute path; production must never set it.
const ALLOW_LOCAL_SCREEN = process.env.ORBITIQ_ALLOW_LOCAL_SCREEN === "1";
let SWEEP_CAP_VALID = true;
const SWEEP_CAP = (() => {
  const raw = process.env.ORBITIQ_SWEEP_CAP;
  if (raw === undefined || raw === "") return 6000;
  const n = Number(raw);                       // Number("3k") is NaN, unlike parseInt
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 100) {
    SWEEP_CAP_VALID = false;
    // The value itself is not logged. If a secret has been pasted into this
    // variable by mistake, echoing it into the logs spreads the problem.
    console.error(
      `\n  ORBITIQ_SWEEP_CAP is set to a value that is not a valid object count\n` +
      `  (got ${raw.length} characters; expected a whole number >= 100).\n` +
      "  Ignoring it and using 6000. A too-small cap silently makes every\n" +
      "  conjunction screen come back empty.\n");
    return 6000;
  }
  if (n > 20000) { console.warn(`ORBITIQ_SWEEP_CAP=${n} is large; screening may be slow.`); }
  return n;
})();
const MU_E = 398600.4418, RE_KM = 6371;
function perigeeOf(s) {
  const nRad = (s.meanMotion * 2 * Math.PI) / 86400;
  if (!nRad) return 1e9;
  return Math.cbrt(MU_E / (nRad * nRad)) * (1 - (s.ecc || 0)) - RE_KM;
}
function capForScreening(sats, org) {
  if (sats.length <= SWEEP_CAP) return sats;
  // keep the org's own objects — but the cap applies to them too (a mega-
  // constellation like Starlink would otherwise blow the CPU budget) —
  // then fill the remainder with the lowest-perigee objects
  const mine = org
    ? sats.filter(s => s.org === org).slice(0, Math.floor(SWEEP_CAP * 0.7))
    : [];
  const rest = (org ? sats.filter(s => s.org !== org) : sats)
    .map(s => [perigeeOf(s), s])
    .sort((a, b) => a[0] - b[0])
    .slice(0, Math.max(0, SWEEP_CAP - mine.length))
    .map(p => p[1]);
  return mine.concat(rest);
}
// Screening is the most expensive thing this service does — seconds of
// uninterruptible synchronous work on a single-core instance. Three problems
// had to be solved together, because fixing any one alone leaves the hole open:
//
//   1. The cache key was built from raw parseFloat values, so `hours=2.9999`,
//      `2.9998`, ... missed every time while the cache itself grew forever.
//      Parameters are now snapped to a small grid, which bounds the key space
//      and makes cache hits the normal case.
//   2. Identical concurrent requests each ran their own full screen. They now
//      share one in-flight promise.
//   3. Distinct concurrent requests could still stack up and monopolise the
//      loop. Only one screen runs at a time; a stale result is served in
//      preference to queueing where one exists.
const SCREEN_HOURS = [1, 3, 6, 12, 24, 48, 96];
const SCREEN_THRESH = [1, 5, 10, 25, 50, 100];
const snapTo = (grid, v, fallback) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return grid.reduce((best, g) => (Math.abs(g - n) < Math.abs(best - n) ? g : best), grid[0]);
};
export const snapHours = v => snapTo(SCREEN_HOURS, v, 3);
export const snapThreshold = v => snapTo(SCREEN_THRESH, v, 10);

const CONJ_MAX_ENTRIES = 60;
const inFlight = new Map();
let screensRunning = 0;

// Screening now happens off the request path, on a GitHub Actions runner that
// publishes static JSON (see .github/workflows/screening.yml). The web service
// prefers that file over computing anything itself: it is the same engine over
// a LARGER population than this instance could ever hold, and reading it costs
// a fetch instead of seconds of blocked event loop.
const SCREEN_BASE = process.env.ORBITIQ_SCREEN_BASE ||
  "https://raw.githubusercontent.com/mnbresearch/orbitiq/screening/data/screening";
let screenFeedOk = null;      // null = untried, true/false = last outcome
let screenFeedAt = 0;

async function fetchPublishedScreen(org, hours, thresholdKm) {
  const name = `${org || "all"}-${hours}-${thresholdKm}.json`;
  try {
    const r = await fetch(`${SCREEN_BASE}/${name}`, {
      signal: AbortSignal.timeout(8000),
      headers: { "User-Agent": "OrbitIQ/15" }
    });
    if (!r.ok) { screenFeedOk = false; screenFeedAt = Date.now(); return null; }
    const j = await r.json();
    if (!j || !Array.isArray(j.events)) { screenFeedOk = false; return null; }
    screenFeedOk = true; screenFeedAt = Date.now();
    return j;
  } catch {
    screenFeedOk = false; screenFeedAt = Date.now();
    return null;
  }
}

export const screenFeedStatus = () => ({
  base: SCREEN_BASE,
  reachable: screenFeedOk,
  lastCheck: screenFeedAt ? new Date(screenFeedAt).toISOString() : null
});

function cachePut(key, result) {
  conjCache.set(key, { at: Date.now(), result });
  // Bounded, oldest-first. The map was previously only ever written to.
  while (conjCache.size > CONJ_MAX_ENTRIES) {
    const oldest = conjCache.keys().next().value;
    conjCache.delete(oldest);
  }
}

async function runScreening(org, hours, thresholdKm, opts = {}) {
  const h = snapHours(hours), t = snapThreshold(thresholdKm);
  const key = `${org}|${h}|${t}`;

  const hit = conjCache.get(key);
  const fresh = hit && Date.now() - hit.at < CONJ_TTL;
  if (fresh) return { ...hit.result, cached: true };

  const pending = inFlight.get(key);
  if (pending) return { ...(await pending), cached: true };

  // Prefer the precomputed screen. This is what keeps the free instance alive:
  // a published result costs one HTTP fetch, where computing one costs seconds
  // of blocked event loop and enough memory to get the process recycled.
  const published = await fetchPublishedScreen(org, h, t);
  if (published) {
    cachePut(key, published);
    return { ...published, cached: false };
  }

  // A stale answer always beats making the caller wait.
  if (hit && (screensRunning > 0 || opts.neverQueue)) {
    return { ...hit.result, cached: true, stale: true,
      note: "Served from the last completed screen; a fresh one runs in the background." };
  }
  // Unauthenticated callers may READ the cache but must never START a screen.
  // A cold all-on-all screen is seconds of blocked event loop and hundreds of
  // MB on a 512 MB instance: enough for the platform health check to fail and
  // the instance to be recycled mid-request. The background sweep warms the
  // cache instead, so the public endpoint is always cheap.
  if (opts.neverQueue) {
    return { events: [], screened: 0, catalogSize: 0, warming: true,
      windowHours: h, thresholdKm: t,
      note: "No screen has completed for these parameters yet. The background sweep "
          + "refreshes them periodically; retry shortly, or use an API key to request one." };
  }
  if (screensRunning > 0 && !hit) {
    return { events: [], screened: 0, catalogSize: 0, warming: true,
      note: "Another screen is in progress. Retry shortly." };
  }

  // ── The web instance does not screen. Ever. ──────────────────
  // Screening was moved to the GitHub Actions worker precisely because
  // screenConjunctions() is seconds of SYNCHRONOUS SGP4 over the whole
  // catalogue: on a shared-CPU 512 MB instance it blows straight through
  // Render's 5-second health-check budget and the instance is recycled.
  //
  // Guarding the individual callers was not enough, and the failure was
  // brutal: the background sweep asked for `(org, 3, 10)` while the worker
  // only published `(org, 12, 25)`. One unpublished parameter pair meant the
  // lookup missed, execution fell through to the local compute path below,
  // and the instance died 5 minutes after every boot — which is exactly how
  // long `setTimeout(intelligenceSweep, 5 * 60 * 1000)` waits. Boot, serve
  // for five minutes, sweep, stall, get killed, boot again. Roughly ten
  // restarts an hour, indefinitely.
  //
  // So the rule is enforced here, once, instead of at eight call sites: if
  // there is no published screen and no cache entry, say so. A caller that
  // gets `warming: true` degrades visibly; an instance that gets recycled
  // takes the whole site down invisibly.
  if (!ALLOW_LOCAL_SCREEN) {
    return { events: [], screened: 0, catalogSize: 0, warming: true,
      windowHours: h, thresholdKm: t,
      note: "No published screen for these parameters yet. Screening runs in the "
          + "offline worker; this instance never computes one on the request path." };
  }


  const job = (async () => {
    let sats = capForScreening(await getSatellites(), org);
    // With no primary operator every object is a primary, so the radial sieve
    // cannot reduce anything and cost grows with the square of the population.
    // The public teaser is bounded to the lowest-perigee slice, where the
    // congestion — and the risk — actually is. Operator- and fleet-scoped
    // screens are unaffected and still see the full catalogue.
    if (!org && sats.length > ALL_ON_ALL_CAP) sats = sats.slice(0, ALL_ON_ALL_CAP);
    // Yield once so the response for any already-queued request can flush
    // before we take the loop for several seconds.
    await new Promise(r => setImmediate(r));
    // The unscoped screen cannot use the apogee/perigee sieve, so it is the
    // expensive one. A smaller propagation budget makes it roughly twice as
    // fast WITHOUT weakening the completeness guarantee: the engine simply
    // takes a coarser time step and widens the detection gate to match
    // (gate = threshold + vRelMax * step / 2). Measured 5.6 s -> 2.6 s with
    // identical results. This matters because on a shared-CPU free instance a
    // long synchronous screen trips the platform health check and the whole
    // service gets recycled.
    return screenConjunctions(sats, org, h, t,
      org ? {} : { maxPropagations: 800000 });
  })();

  screensRunning++;
  inFlight.set(key, job);
  try {
    const result = await job;
    cachePut(key, result);
    return result;
  } finally {
    screensRunning--;
    inFlight.delete(key);
  }
}

// ---------- core data ----------
api.get("/health", (req, res) => res.json({
  ok: true, service: "OrbitIQ", version: 8, time: new Date().toISOString(),
  dataSource: dataSourceInfo().catalog,
  archiveBackup: backup.status()
}));

api.get("/satellites", async (req, res) => {
  try {
    const sats = await getSatellites();
    const org = req.query.org, q = (req.query.q || "").toUpperCase();
    let out = sats;
    if (org && org !== "all") out = out.filter(s => s.org === org);
    if (q) out = out.filter(s => s.name.toUpperCase().includes(q) || String(s.id) === q);
    // Defaulted to 20000 — above the catalogue size — so a bare GET serialised
    // the entire catalogue including each object's full GP block, 10-15 MB of
    // JSON built synchronously. Callers that genuinely want everything can
    // still ask, but they have to ask.
    const limit = Math.min(parseInt(req.query.limit) || 500, 20000);
    res.json({ count: out.length, satellites: out.slice(0, limit) });
  } catch (e) { res.status(502).json({ error: "Orbital data source unavailable", detail: e.message }); }
});

api.get("/organizations", async (req, res) => {
  try {
    const sats = await getSatellites();
    res.json({ organizations: orgList(sats), totalObjects: sats.length });
  } catch (e) { res.status(502).json({ error: "Orbital data source unavailable", detail: e.message }); }
});

api.get("/launches", async (req, res) => {
  try { res.json(await getLaunches()); }
  catch (e) { res.status(502).json({ error: "Launch data source unavailable", detail: e.message }); }
});

api.get("/events", async (req, res) => {
  try { res.json({ events: await getEvents() }); }
  catch (e) { res.status(502).json({ error: "Events source unavailable", detail: e.message }); }
});

api.get("/stats", async (req, res) => {
  try {
    const sats = await getSatellites();
    const byType = {}; let leo = 0, meo = 0, geo = 0;
    for (const s of sats) {
      byType[s.noradType] = (byType[s.noradType] || 0) + 1;
      if (s.meanMotion > 11.25) leo++; else if (s.meanMotion > 1.5) meo++; else geo++;
    }
    res.json({ total: sats.length, byType, regimes: { LEO: leo, MEO: meo, "GEO/HEO": geo } });
  } catch (e) { res.status(502).json({ error: "Orbital data source unavailable", detail: e.message }); }
});

api.get("/conjunctions", async (req, res) => {
  try {
    const org = req.query.org && req.query.org !== "all" ? req.query.org : null;
    const hours = Math.min(snapHours(req.query.hours || 3), 12);
    const threshold = Math.min(snapThreshold(req.query.thresholdKm || 10), 50);
    // An unauthenticated caller may read a cached screen but may not start a
    // cold one: this route was a 20+ second event-loop lockup for anyone who
    // asked for the widest window, repeatable at will.
    res.json(await runScreening(org, hours, threshold, { neverQueue: !req.workspace }));
  } catch (e) { res.status(500).json({ error: "Screening failed", detail: e.message }); }
});

api.get("/recent-objects", async (req, res) => {
  try {
    const sats = await getSatellites();
    const parsed = sats
      .filter(s => s.intl && /^\d{4}-\d{3}/.test(s.intl) && s.noradType !== "DEBRIS")
      .map(s => ({ id: s.id, name: s.name, intl: s.intl, org: s.org, year: +s.intl.slice(0, 4), seq: +s.intl.slice(5, 8), incl: s.incl, meanMotion: s.meanMotion }))
      .sort((a, b) => b.year - a.year || b.seq - a.seq || b.id - a.id);
    res.json({ objects: parsed.slice(0, 40) });
  } catch (e) { res.status(502).json({ error: "Orbital data source unavailable", detail: e.message }); }
});

api.get("/decay-watch", async (req, res) => {
  try {
    const sats = await getSatellites();
    const MU = 398600.4418, R = 6371, rows = [];
    for (const s of sats) {
      const nRad = (s.meanMotion * 2 * Math.PI) / 86400;
      if (!nRad) continue;
      const a = Math.cbrt(MU / (nRad * nRad));
      const perigee = a * (1 - s.ecc) - R, apogee = a * (1 + s.ecc) - R;
      if (perigee < 300) rows.push({ id: s.id, name: s.name, org: s.org, perigeeKm: +perigee.toFixed(1), apogeeKm: +apogee.toFixed(1), bstar: s.bstar, type: s.noradType });
    }
    rows.sort((a, b) => a.perigeeKm - b.perigeeKm);
    res.json({ count: rows.length, objects: rows.slice(0, 40) });
  } catch (e) { res.status(502).json({ error: "Orbital data source unavailable", detail: e.message }); }
});

api.get("/passes", async (req, res) => {
  try {
    const { satId } = req.query;
    const lat = parseFloat(req.query.lat), lon = parseFloat(req.query.lon);
    if (!satId || Number.isNaN(lat) || Number.isNaN(lon)) return res.status(400).json({ error: "satId, lat, lon required" });
    const sats = await getSatellites();
    const s = sats.find(x => String(x.id) === String(satId));
    if (!s) return res.status(404).json({ error: "Satellite not found" });
    const rec = satellite.json2satrec(s.gp);
    const observer = { latitude: satellite.degreesToRadians(lat), longitude: satellite.degreesToRadians(lon), height: 0.05 };
    const passes = []; let cur = null;
    const start = Date.now(), stepS = 30;
    for (let i = 0; i < (48 * 3600) / stepS; i++) {
      const t = new Date(start + i * stepS * 1000);
      let el = -90, az = 0, rng = 0;
      try {
        const pv = satellite.propagate(rec, t);
        if (pv?.position) {
          const gmst = satellite.gstime(t);
          const la = satellite.ecfToLookAngles(observer, satellite.eciToEcf(pv.position, gmst));
          el = la.elevation * 180 / Math.PI; az = la.azimuth * 180 / Math.PI; rng = la.rangeSat;
        }
      } catch { continue; }
      if (el > 0) {
        if (!cur) cur = { aos: t.toISOString(), maxEl: el, maxElAz: az, minRangeKm: rng };
        if (el > cur.maxEl) { cur.maxEl = el; cur.maxElAz = az; }
        if (rng < cur.minRangeKm) cur.minRangeKm = rng;
        cur.los = t.toISOString();
      } else if (cur) {
        cur.maxEl = +cur.maxEl.toFixed(1); cur.maxElAz = +cur.maxElAz.toFixed(0);
        cur.minRangeKm = +cur.minRangeKm.toFixed(0);
        cur.durationMin = +((new Date(cur.los) - new Date(cur.aos)) / 60000).toFixed(1);
        passes.push(cur); cur = null;
        if (passes.length >= 10) break;
      }
    }
    res.json({ satellite: { id: s.id, name: s.name }, observer: { lat, lon }, passes });
  } catch (e) { res.status(500).json({ error: "Pass prediction failed", detail: e.message }); }
});

api.get("/analytics", async (req, res) => {
  try {
    const sats = await getSatellites();
    const MU = 398600.4418, R = 6371;
    const altBins = new Array(30).fill(0), inclBins = new Array(18).fill(0);
    const byYear = {}, byOrg = {};
    let leo = 0, meo = 0, geo = 0;
    for (const s of sats) {
      const nRad = (s.meanMotion * 2 * Math.PI) / 86400;
      if (nRad > 0) {
        const alt = Math.cbrt(MU / (nRad * nRad)) - R;
        if (alt >= 0 && alt < 3000) altBins[Math.floor(alt / 100)]++;
        if (s.meanMotion > 11.25) leo++; else if (s.meanMotion > 1.5) meo++; else geo++;
      }
      inclBins[Math.min(17, Math.floor((s.incl || 0) / 10))]++;
      if (s.intl && /^\d{4}/.test(s.intl)) { const y = s.intl.slice(0, 4); byYear[y] = (byYear[y] || 0) + 1; }
      byOrg[s.org] = (byOrg[s.org] || 0) + 1;
    }
    const years = Object.entries(byYear).map(([y, c]) => ({ year: +y, count: c })).filter(r => r.year >= 1990).sort((a, b) => a.year - b.year);
    res.json({
      total: sats.length, regimes: { LEO: leo, MEO: meo, "GEO/HEO": geo },
      altitudeHistogram: { binKm: 100, bins: altBins },
      inclinationHistogram: { binDeg: 10, bins: inclBins },
      byLaunchYear: years,
      byOrg: Object.entries(byOrg).map(([org, count]) => ({ org, count })).sort((a, b) => b.count - a.count),
      snapshots: store.listSnapshots()
    });
  } catch (e) { res.status(502).json({ error: "Orbital data source unavailable", detail: e.message }); }
});

// ---------- astrodynamics tools ----------
api.get("/tools/transfer", (req, res) => {
  const a1 = parseFloat(req.query.alt1), a2 = parseFloat(req.query.alt2), di = parseFloat(req.query.planeChange) || 0;
  if (Number.isNaN(a1) || Number.isNaN(a2) || a1 < 100 || a2 < 100 || a1 > 100000 || a2 > 100000)
    return res.status(400).json({ error: "alt1 and alt2 (km, 100–100000) required" });
  res.json({ from: a1, to: a2, planeChangeDeg: di, ...hohmann(a1, a2, di) });
});

api.get("/tools/launch-plan", (req, res) => {
  const incl = parseFloat(req.query.incl), alt = parseFloat(req.query.alt) || 550;
  if (Number.isNaN(incl) || incl < 0 || incl > 180) return res.status(400).json({ error: "incl (0–180°) required" });
  res.json(launchPlan(incl, Math.min(Math.max(alt, 150), 40000)));
});

api.get("/traffic/congestion", async (req, res) => {
  try { res.json(congestion(await getSatellites())); }
  catch (e) { res.status(502).json({ error: "Orbital data source unavailable", detail: e.message }); }
});

api.get("/maneuvers", async (req, res) => {
  try {
    const sats = await getSatellites();
    const events = detectManeuvers(sats, store.loadHistory());
    res.json({ count: events.length, events, note: "Detected from epoch-over-epoch element changes in public GP data." });
  } catch (e) { res.status(502).json({ error: "Orbital data source unavailable", detail: e.message }); }
});

// ---------- workspaces (multi-tenant) ----------
api.post("/workspaces", (req, res) => {
  const { name, org } = req.body || {};
  if (!name || String(name).trim().length < 2) return res.status(400).json({ error: "Workspace name required" });
  const ws = store.createWorkspace(String(name).trim(), org);
  res.status(201).json({ workspace: ws, note: "Store the apiKey — it is shown once and scopes all workspace calls." });
});

api.get("/workspace", requireWs, (req, res) => {
  const { apiKey, ...safe } = req.workspace;
  res.json({ workspace: { ...safe, apiKeyMasked: apiKey.slice(0, 8) + "…" }, usage: store.usageFor(apiKey) });
});

api.put("/workspace", requireWs, (req, res) => {
  const ws = store.updateWorkspace(req.workspace.id, req.body || {});
  if (!ws) return res.status(404).json({ error: "Workspace not found" });
  // updateWorkspace now rejects unsafe webhook targets; surface that as a 400
  // rather than wrapping the error object in a success-shaped response.
  if (ws.error) return res.status(400).json({ error: ws.error });
  const { apiKey, ...safe } = ws;
  res.json({ workspace: safe });
});

api.get("/alerts", requireWs, (req, res) => {
  res.json({ alerts: store.listAlerts(req.workspace.id).slice(0, 50) });
});
api.post("/alerts/read", requireWs, (req, res) => {
  store.markAlertsRead(req.workspace.id);
  res.json({ ok: true });
});

api.post("/workspace/scan", requireWs, async (req, res) => {
  try {
    const fresh = await scanWorkspace(req.workspace);
    res.json({ ok: true, newAlerts: fresh.length, totalAlerts: store.listAlerts(req.workspace.id).length });
  } catch (e) { res.status(500).json({ error: "Scan failed", detail: e.message }); }
});

// ---------- Intel Pack (subscription tier) ----------
const siteLatLookup = loc => {
  const q = (loc || "").toLowerCase();
  for (const s of LAUNCH_SITES) if (q.includes(s.name.split(" ")[0].toLowerCase()) || q.includes((s.country || "").toLowerCase())) return s.lat;
  if (q.includes("canaveral") || q.includes("kennedy")) return 28.5;
  if (q.includes("vandenberg")) return 34.7;
  if (q.includes("wenchang")) return 19.6;
  if (q.includes("taiyuan")) return 38.85;
  if (q.includes("jiuquan")) return 40.96;
  return null;
};

api.get("/intel/staleness", async (req, res) => { // free teaser
  try { res.json(intel.staleness(await getSatellites())); }
  catch (e) { res.status(502).json({ error: "Orbital data source unavailable", detail: e.message }); }
});

api.get("/intel/gabbard", async (req, res) => { // free teaser
  try {
    const group = String(req.query.group || "COSMOS 1408");
    res.json(intel.gabbard(await getSatellites(), group));
  } catch (e) { res.status(502).json({ error: "Orbital data source unavailable", detail: e.message }); }
});

api.get("/intel/conjunctions", requirePlan("operator"), async (req, res) => {
  try {
    const org = req.query.org && req.query.org !== "all" ? req.query.org : null;
    const hours = Math.min(parseFloat(req.query.hours) || 3, 12);
    const threshold = Math.min(parseFloat(req.query.thresholdKm) || 10, 50);
    const d = await runScreening(org, hours, threshold);
    const sats = await getSatellites();
    const byId = new Map(sats.map(s => [s.id, s]));
    res.json({ ...d, events: intel.augmentConjunctions(d.events, byId), tier: "pro" });
  } catch (e) { res.status(500).json({ error: "Screening failed", detail: e.message }); }
});

api.get("/intel/fleet-risk", requirePlan("operator"), async (req, res) => {
  try {
    const org = req.query.org || req.workspace.org;
    if (!org) return res.status(400).json({ error: "org required (query or workspace binding)" });
    const sats = await getSatellites();
    const d = await runScreening(org, 3, 10);
    const cong = congestion(sats);
    res.json(intel.fleetRisk(org, sats, d.events, cong.shells));
  } catch (e) { res.status(500).json({ error: "Risk computation failed", detail: e.message }); }
});

api.get("/intel/eclipse", requirePlan("tracker"), async (req, res) => {
  try {
    const sats = await getSatellites();
    const s = sats.find(x => String(x.id) === String(req.query.satId));
    if (!s) return res.status(404).json({ error: "Satellite not found" });
    res.json(intel.eclipseWindows(s, Math.min(parseFloat(req.query.hours) || 24, 72)));
  } catch (e) { res.status(500).json({ error: "Eclipse computation failed", detail: e.message }); }
});

api.get("/intel/passes-pro", requirePlan("tracker"), async (req, res) => {
  try {
    const lat = parseFloat(req.query.lat), lon = parseFloat(req.query.lon);
    if (Number.isNaN(lat) || Number.isNaN(lon)) return res.status(400).json({ error: "lat, lon required" });
    const sats = await getSatellites();
    const s = sats.find(x => String(x.id) === String(req.query.satId));
    if (!s) return res.status(404).json({ error: "Satellite not found" });
    res.json(intel.passesPro(s, lat, lon, Math.min(parseFloat(req.query.hours) || 24, 72), parseFloat(req.query.freqMhz) || 437.5));
  } catch (e) { res.status(500).json({ error: "Pass computation failed", detail: e.message }); }
});

api.get("/intel/launch-correlation", requirePlan("operator"), async (req, res) => {
  try {
    const [sats, launches] = await Promise.all([getSatellites(), getLaunches()]);
    res.json(intel.launchCorrelation(launches.previous, sats, siteLatLookup));
  } catch (e) { res.status(502).json({ error: "Source unavailable", detail: e.message }); }
});

api.get("/intel/anomalies", requirePlan("operator"), async (req, res) => {
  try { res.json(intel.anomalies(await getSatellites(), store.loadHistory())); }
  catch (e) { res.status(502).json({ error: "Orbital data source unavailable", detail: e.message }); }
});

// ---------- plans (public pricing surface, v10 enterprise catalogue) ----------
api.get("/plans", (req, res) => res.json({
  plans: store.PLAN_CATALOG.map(p => ({
    ...p,
    label: p.name,
    includes: p.features,
    dailyCalls: store.PLANS[p.id]?.dailyCalls ?? null
  })),
  activation: "Access is granted by review. Approved workspaces are provisioned by the MNB Research team and credentials are issued by email.",
  note: "Every tier is invitation-based — there is no self-service checkout."
}));

// ---------- intelligence archive (the data moat) ----------
api.get("/archive/stats", (req, res) => res.json(ledger.stats())); // public: shows the moat growing

// Verification is deliberately PUBLIC and unauthenticated. An integrity claim
// that only the vendor can check is not an integrity claim — the whole value
// is that a counterparty who does not trust us can confirm it themselves.
api.get("/archive/verify", (req, res) => {
  const v = ledger.verify();
  res.json({
    ...v,
    seals: ledger.seals().slice(-5),
    anchor: ledger.anchor(),
    witness: {
      // Pointing at the external record is part of the claim. A verification
      // response that only says "trust me, it verifies" is worth nothing to
      // the party who most needs to check it.
      log: "https://github.com/mnbresearch/orbitiq/blob/witness/witness/log.jsonl",
      runs: "https://github.com/mnbresearch/orbitiq/actions/workflows/witness.yml",
      how: "An hourly GitHub Actions run fetches THIS endpoint over the public internet and records "
         + "the tip hash it saw, together with the run id. Those runs are timestamped by GitHub and "
         + "their logs cannot be edited afterwards by the repository owner, so the observation is "
         + "external to us. Compare any tipHash below against the witness log for the same hour."
    },
    published: "Seals are mirrored to the data-backup branch of github.com/mnbresearch/orbitiq. "
             + "Note that branch is force-pushed flat by design and is NOT evidence — the witness "
             + "branch and the Actions run history are.",

    limits: "Tamper-evident, not tamper-proof, with GitHub as the notary — exactly as strong as "
          + "trusting GitHub's timestamps, no more. It shows a hash was publicly observable at a "
          + "given time. It is not a signature, does not attest who wrote the rows, and is not a "
          + "blockchain."
  });
});
api.get("/archive/seals", (req, res) => res.json({ seals: ledger.seals(), anchor: ledger.anchor() }));

// The paid artefact: a verifiable extract for one operator over one window.
api.get("/archive/proof", requireWs, requirePlan("operator"), (req, res) => {
  const org = req.query.org || req.workspace.org;
  if (!org) return res.status(400).json({ error: "No organisation on this workspace; pass ?org=" });
  res.json(ledger.proof({
    org, since: req.query.since, until: req.query.until,
    limit: Math.min(parseInt(req.query.limit, 10) || 2000, 5000)
  }));
});

api.get("/archive/events", requirePlan("operator"), (req, res) => {
  res.json(ledger.query({
    type: req.query.type, org: req.query.org,
    since: req.query.since, until: req.query.until,
    limit: parseInt(req.query.limit) || 500
  }));
});
api.get("/archive/risk-history", requirePlan("operator"), (req, res) => {
  const org = req.query.org || req.workspace.org;
  if (!org) return res.status(400).json({ error: "org required" });
  res.json(ledger.riskHistory(org));
});
api.get("/archive/report", requirePlan("operator"), async (req, res) => {
  try {
    const org = req.query.org || req.workspace.org;
    if (!org) return res.status(400).json({ error: "org required" });
    const sats = await getSatellites();
    const names = Object.fromEntries(orgList(sats).map(o => [o.id, o.name]));
    res.json(ledger.weeklyReport(org, names[org]));
  } catch (e) { res.status(500).json({ error: "Report generation failed", detail: e.message }); }
});

// ---------- v7: space environment ----------
api.get("/spaceweather", async (req, res) => {
  try { res.json(await getSpaceWeather()); }
  catch (e) { res.status(502).json({ error: "Space weather unavailable", detail: e.message }); }
});

// ---------- v7: ground network operations ----------
api.get("/network/stations", (req, res) => res.json(netops.stationsPublic()));

api.get("/network/contact-plan", requirePlan("tracker"), async (req, res) => {
  try {
    const sats = await getSatellites();
    const s = sats.find(x => String(x.id) === String(req.query.satId));
    if (!s) return res.status(404).json({ error: "Satellite not found" });
    const hours = Math.min(Math.max(parseFloat(req.query.hours) || 24, 1), 48);
    const minEl = Math.min(Math.max(parseFloat(req.query.minEl) || 5, 0), 30);
    res.json(netops.contactPlan(s, hours, minEl));
  } catch (e) { res.status(500).json({ error: "Contact planning failed", detail: e.message }); }
});

// ---------- v7: re-entry board (public teaser, Tracker for full) ----------
api.get("/reentry", async (req, res) => {
  try {
    const rank = req.workspace ? (store.PLANS[req.workspace.plan]?.rank ?? 0) : -1;
    const full = !!req.workspace && (rank >= 1 || req.workspace.role === "admin");
    const d = netops.reentryWatch(await getSatellites(), full ? 100 : 12);
    res.json({ ...d, tier: full ? "full" : "teaser — top 12; Tracker plan unlocks the full board" });
  } catch (e) { res.status(502).json({ error: "Orbital data source unavailable", detail: e.message }); }
});

// ---------- v7: premium exports + shareable reports ----------
const csvq = v => JSON.stringify(String(v ?? ""));
api.get("/export/fleet.csv", requirePlan("operator"), async (req, res) => {
  try {
    const org = req.query.org || req.workspace?.org;
    if (!org) return res.status(400).json({ error: "org required (or bind your workspace to one)" });
    const sats = (await getSatellites()).filter(s => s.org === org);
    const rows = sats.map(s => {
      const r = netops.reentryEstimate(s);
      return [s.id, csvq(s.name), s.noradType, s.incl, s.meanMotion, s.ecc, r?.perigeeKm ?? "", r?.apogeeKm ?? "", r?.lifetimeDays ?? "", s.epoch].join(",");
    });
    res.type("text/csv").attachment(`orbitiq-fleet-${org}.csv`)
      .send("norad_id,name,type,incl_deg,mean_motion_rev_day,ecc,perigee_km,apogee_km,lifetime_days_proj,epoch\n" + rows.join("\n"));
  } catch (e) { res.status(502).json({ error: "Export failed", detail: e.message }); }
});

api.get("/export/ledger.csv", requirePlan("operator"), (req, res) => {
  const d = ledger.query({ type: req.query.type, org: req.query.org, limit: 2000 });
  const rows = d.events.map(r => [
    r.t, r.type, r.org ?? r.aOrg ?? "",
    csvq(r.name || (r.aName ? `${r.aName} x ${r.bName}` : r.type)),
    r.missKm ?? "", r.pcText ?? "", r.index ?? "", r.kp ?? ""
  ].join(","));
  res.type("text/csv").attachment("orbitiq-ledger.csv")
    .send("time,type,org,summary,miss_km,pc,risk_index,kp\n" + rows.join("\n"));
});

// ---------- v8: constellation architecture + archive trends ----------
api.get("/intel/constellation", requirePlan("operator"), async (req, res) => {
  try {
    const org = req.query.org || req.workspace.org;
    if (!org) return res.status(400).json({ error: "org required (or bind your workspace to one)" });
    res.json(fleetintel.constellation(org, await getSatellites()));
  } catch (e) { res.status(502).json({ error: "Orbital data source unavailable", detail: e.message }); }
});

api.get("/archive/trends", requirePlan("operator"), (req, res) => {
  const org = req.query.org || req.workspace.org || null;
  const days = Math.min(Math.max(parseInt(req.query.days) || 30, 7), 120);
  res.json(fleetintel.trends(ledger.allEvents(), org, days));
});

// ---------- v8: ephemeris export ----------
api.get("/export/ephemeris.csv", requirePlan("tracker"), async (req, res) => {
  try {
    const sats = await getSatellites();
    const s = sats.find(x => String(x.id) === String(req.query.satId));
    if (!s) return res.status(404).json({ error: "Satellite not found" });
    const hours = Math.min(Math.max(parseFloat(req.query.hours) || 24, 1), 48);
    const stepS = Math.min(Math.max(parseInt(req.query.step) || 60, 30), 600);
    const rec = satellite.json2satrec(s.gp);
    const rows = [];
    const t0 = Date.now();
    for (let i = 0; i <= (hours * 3600) / stepS; i++) {
      const t = new Date(t0 + i * stepS * 1000);
      try {
        const pv = satellite.propagate(rec, t);
        if (!pv?.position) continue;
        const gmst = satellite.gstime(t);
        const gd = satellite.eciToGeodetic(pv.position, gmst);
        rows.push([
          t.toISOString(),
          satellite.degreesLat(gd.latitude).toFixed(4),
          satellite.degreesLong(gd.longitude).toFixed(4),
          gd.height.toFixed(2),
          pv.position.x.toFixed(3), pv.position.y.toFixed(3), pv.position.z.toFixed(3),
          pv.velocity ? Math.hypot(pv.velocity.x, pv.velocity.y, pv.velocity.z).toFixed(4) : ""
        ].join(","));
      } catch { /* skip step */ }
    }
    res.type("text/csv").attachment(`orbitiq-ephemeris-${s.id}.csv`)
      .send("time_utc,lat_deg,lon_deg,alt_km,eci_x_km,eci_y_km,eci_z_km,speed_km_s\n" + rows.join("\n"));
  } catch (e) { res.status(500).json({ error: "Ephemeris generation failed", detail: e.message }); }
});

// ---------- v8: self-serve key rotation ----------
api.post("/workspace/rotate-key", requireWs, (req, res) => {
  const w = store.rotateKey(req.workspace.id);
  if (!w) return res.status(400).json({ error: "This key cannot be rotated here (admin keys are env-managed)" });
  res.json({ workspace: { id: w.id, name: w.name }, apiKey: w.apiKey, note: "Old key is dead immediately. Store the new key — shown once." });
});

// ---------- v9: authentication + access requests ----------
const sessionOf = req => {
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : null;
  return token ? auth.sessionUser(token) : null;
};
const requireSession = (req, res, next) => {
  const u = sessionOf(req);
  if (!u) return res.status(401).json({ error: "Sign in required" });
  req.user = u; next();
};
const loginBuckets = new Map();
// Sign-in mail is per-sign-in, but "sign in" is not always a human act: a
// stored credential in a script, a retried request, or someone bouncing on the
// button produces a burst of perfectly valid logins. Collapse anything from the
// same account inside this window into one notification, so the inbox tracks
// people rather than requests. A normal daily sign-in is far outside it and
// still notifies every time.
const SIGNIN_NOTICE_COOLDOWN_MS = 10 * 60 * 1000;
const signInNotices = new Map();   // userId -> last notified at
function signInNoticeSuppressed(userId) {
  const now = Date.now();
  const last = signInNotices.get(userId);
  if (last && now - last < SIGNIN_NOTICE_COOLDOWN_MS) return true;
  signInNotices.set(userId, now);
  // Bounded: this map must not become a slow memory leak on a 512 MB box.
  if (signInNotices.size > 5000) {
    for (const [k, t] of signInNotices) {
      if (now - t > SIGNIN_NOTICE_COOLDOWN_MS) signInNotices.delete(k);
    }
  }
  return false;
}

api.post("/auth/login", (req, res) => {
  const ip = req.ip || "?", min = Math.floor(Date.now() / 60000);
  const b = loginBuckets.get(ip);
  if (!b || b.min !== min) loginBuckets.set(ip, { min, n: 1 });
  else if (++b.n > 10) return res.status(429).json({ error: "Too many attempts — wait a minute" });
  const { email, password } = req.body || {};
  const result = auth.login(email, password);
  if (!result) return res.status(401).json({ error: "Invalid email or password" });
  const w = result.user.workspaceId ? store.getWorkspace(result.user.workspaceId) : null;

  // ── Sign-in notifications ────────────────────────────────────
  // Fired after the session exists and never awaited: mail is a side effect of
  // signing in, not a precondition for it. If Resend is slow or down the user
  // still gets their token immediately, and a rejected promise cannot take the
  // request down with it.
  //
  // The owner hears about every sign-in. The USER only hears about their first
  // one — a "thanks for signing in" note that arrives on every login is
  // indistinguishable from spam and is the quickest way to get the sending
  // domain filtered, which would cost us the credential mails that actually
  // matter.
  if (mailer.enabled() && !signInNoticeSuppressed(result.user.id)) {
    const meta = {
      email: result.user.email, name: result.user.name,
      org: w ? w.org : null, plan: w ? (store.PLANS[w.plan]?.label || w.plan) : null,
      ip: req.ip || null,
      userAgent: String(req.headers["user-agent"] || "").slice(0, 160) || null,
      firstTime: !!result.firstSignIn, at: Date.now()
    };
    mailer.notifySignIn(meta).catch(() => {});
    if (result.firstSignIn) mailer.welcomeOnFirstSignIn(meta).catch(() => {});
  }

  res.json({
    token: result.token,
    user: { email: result.user.email, name: result.user.name, role: result.user.role, mustChangePassword: !!result.user.mustChangePassword },
    workspace: w ? { apiKey: w.apiKey, name: w.name, org: w.org, plan: w.plan } : null
  });
});
api.post("/auth/logout", (req, res) => {
  const h = req.headers.authorization || "";
  if (h.startsWith("Bearer ")) auth.logout(h.slice(7));
  res.json({ ok: true });
});
api.get("/auth/me", requireSession, (req, res) => {
  const w = req.user.workspaceId ? store.getWorkspace(req.user.workspaceId) : null;
  res.json({
    user: { email: req.user.email, name: req.user.name, role: req.user.role, mustChangePassword: !!req.user.mustChangePassword },
    workspace: w ? { apiKey: w.apiKey, name: w.name, org: w.org, plan: w.plan } : null
  });
});
api.post("/auth/change-password", requireSession, (req, res) => {
  const { current, next } = req.body || {};
  const r = auth.changePassword(req.user.id, current, next);
  r.error ? res.status(400).json(r) : res.json(r);
});
// v10: one intake path for the landing-page contact form and the login page.
// Persist first, then notify — mail failures never lose a lead.
const leadBuckets = new Map();
async function intake(req, res) {
  const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket.remoteAddress || "?";
  const now = Date.now();
  const b = leadBuckets.get(ip) || { n: 0, t: now };
  if (now - b.t > 3600000) { b.n = 0; b.t = now; }
  b.n++; leadBuckets.set(ip, b);
  if (b.n > 5) return res.status(429).json({ error: "Too many requests from this address — please email us directly." });

  const r = auth.requestAccess(req.body || {});
  if (r.error) return res.status(400).json(r);
  const lead = r.request;
  res.status(201).json({
    ok: true,
    note: "Request received — our team reviews every application personally and will be in touch by email.",
    notified: mailer.enabled()
  });
  if (mailer.enabled()) {
    mailer.notifyAccessRequest(lead).catch(() => {});
    mailer.acknowledgeRequest(lead).catch(() => {});
  }
}
api.post("/auth/request-access", intake);
api.post("/contact", intake);

// admin portal (guarded by admin API key, which the admin gets on login)
api.get("/admin/access-requests", requireAdmin, (req, res) => res.json({ requests: auth.listRequests() }));
api.post("/admin/access-requests/:id/approve", requireAdmin, async (req, res) => {
  const r0 = auth.listRequests().find(x => x.id === req.params.id && x.status === "pending");
  if (!r0) return res.status(404).json({ error: "Request not found or already decided" });
  const org = req.body?.org ?? r0.org ?? null;
  const w = store.createWorkspace(r0.name || r0.email, org || null);
  if (req.body?.plan) store.setPlan(w.id, req.body.plan);
  const r = auth.decideRequest(req.params.id, true, w.id);
  if (r.error) return res.status(400).json(r);
  const plan = store.getWorkspace(w.id).plan;
  const emailed = mailer.enabled();
  if (emailed) {
    mailer.sendCredentials({
      email: r0.email, name: r0.name, tempPassword: r.tempPassword,
      plan: store.PLANS[plan]?.label || plan, apiKey: w.apiKey
    }).catch(() => {});
  }
  res.json({
    ok: true, email: r0.email, tempPassword: r.tempPassword, emailed,
    workspace: { id: w.id, apiKey: w.apiKey, plan, org: w.org },
    note: emailed
      ? "Credentials emailed to the applicant. The temporary password is shown here as a backup."
      : "Share the temporary password with the user — they must change it on first sign-in."
  });
});
api.post("/admin/access-requests/:id/deny", requireAdmin, (req, res) => {
  const r0 = auth.listRequests().find(x => x.id === req.params.id && x.status === "pending");
  const r = auth.decideRequest(req.params.id, false, null);
  if (r.error) return res.status(400).json(r);
  if (r0 && mailer.enabled() && req.body?.notify !== false) {
    mailer.sendDecline({ email: r0.email, name: r0.name }).catch(() => {});
  }
  res.json({ ...r, emailed: mailer.enabled() });
});
api.get("/admin/users", requireAdmin, (req, res) => {
  const users = auth.listUsers().map(u => {
    const w = u.workspaceId ? store.getWorkspace(u.workspaceId) : null;
    return { ...u, workspace: w ? { id: w.id, name: w.name, org: w.org, plan: w.plan } : null };
  });
  res.json({ users, authStats: auth.stats() });
});
api.post("/admin/users/:id/email", requireAdmin, async (req, res) => {
  // Email is the sign-in identifier, so this is an identity change rather than
  // a profile edit. auth.changeEmail enforces uniqueness and drops every live
  // session for the account; here we make sure the change is never silent.
  const target = auth.getUser(req.params.id);
  if (!target) return res.status(404).json({ error: "User not found" });
  const previous = target.email;
  const r = auth.changeEmail(req.params.id, req.body?.email);
  if (r.error) return res.status(400).json({ error: r.error });
  const emailed = mailer.enabled();
  if (emailed) {
    // Both addresses, always. The old mailbox is the only party that can tell
    // us this was not meant to happen.
    mailer.notifyEmailChanged({
      oldEmail: previous, newEmail: r.email,
      name: target.name, by: req.user?.email || "an administrator"
    }).catch(() => {});
  }
  res.json({
    ok: true, previous, email: r.email, revokedSessions: r.revokedSessions, emailed,
    note: "The user must sign in again with the new address. Both the old and new "
        + (emailed ? "addresses have been notified." : "addresses would be notified if mail were configured.")
  });
});
api.post("/admin/users/:id/reset-password", requireAdmin, (req, res) => {
  const pw = auth.resetPassword(req.params.id);
  pw ? res.json({ ok: true, tempPassword: pw, note: "Shown once — share it with the user." })
     : res.status(404).json({ error: "User not found" });
});

// ═══════════════ v14: fleet registry, watch and manoeuvre ═══════════════
// A workspace's fleet is a list of NORAD IDs carrying the physical
// properties the probability and manoeuvre maths need. Every route below
// is scoped to the calling workspace — there is no cross-tenant read.

api.get("/fleet/assets", requireWs, (req, res) => {
  res.json({ assets: fleet.listAssets(req.workspace.id), fleetSize: fleet.fleetSize(req.workspace.id) });
});

api.post("/fleet/assets", requireWs, requirePlan("tracker"), (req, res) => {
  const limit = (store.PLANS[req.workspace.plan]?.rank ?? 0) >= 2 ? 500 : 25;
  const existing = fleet.getAsset(req.workspace.id, req.body?.noradId);
  if (fleet.fleetSize(req.workspace.id) >= limit && !existing) {
    return res.status(402).json({ error: `Fleet limit of ${limit} reached on the ${req.workspace.plan} plan`, upgrade: true });
  }
  const r = fleet.addAsset(req.workspace.id, req.body || {});
  r.error ? res.status(400).json(r) : res.status(201).json(r);
});

api.delete("/fleet/assets/:noradId", requireWs, requirePlan("tracker"), (req, res) => {
  const r = fleet.removeAsset(req.workspace.id, req.params.noradId);
  r.error ? res.status(404).json(r) : res.json(r);
});

api.get("/fleet/policy", requireWs, (req, res) => {
  const p = fleet.getPolicy(req.workspace.id);
  res.json({
    policy: { ...p, webhookSecret: p.webhookSecret ? p.webhookSecret.slice(0, 12) + "…" : null },
    defaults: fleet.DEFAULT_POLICY
  });
});

api.put("/fleet/policy", requireWs, requirePlan("tracker"), (req, res) => {
  const r = fleet.setPolicy(req.workspace.id, req.body || {});
  if (r.error) return res.status(400).json(r);
  // The signing secret is returned in full only on the write that creates
  // or rotates it, so it can be copied once and never re-read.
  res.json({ ok: true, policy: r.policy });
});

api.get("/fleet/webhook-log", requireWs, requirePlan("tracker"), (req, res) => {
  res.json({ deliveries: fleet.webhookLog(req.workspace.id) });
});

// Assessed encounters for the caller's registered fleet.
api.get("/fleet/encounters", requireWs, requirePlan("tracker"), async (req, res) => {
  try {
    const sats = await getSatellites();
    const out = watch.screenFleet(req.workspace.id, sats, screenConjunctions, {
      hours: Math.min(parseInt(req.query.hours) || 48, 96),
      thresholdKm: Math.min(parseFloat(req.query.thresholdKm) || 25, 100)
    });
    // State vectors are stripped from the list view — large, and only
    // needed when planning a specific manoeuvre.
    // Each screen is an observation of the same physical encounter. Recording
    // them lets us say whether a close approach is tightening — the question
    // operators actually ask, and one that only became answerable once the
    // reported miss distance stopped varying with the sampling grid.
    const encounters = (out.assessed || []).map(({ state, ...rest }) => ({
      ...rest,
      trend: trend.observe(req.workspace.id, {
        idA: rest.primary?.id, idB: rest.secondary?.id,
        tca: rest.tca, missKm: rest.missKm, pc: rest.pc
      })
    }));
    res.json({
      fleetSize: out.fleetSize, screened: out.screened, catalogSize: out.catalogSize,
      note: out.note, encounters, generatedAt: new Date().toISOString()
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Manoeuvre options for one encounter, identified by its two objects.
api.post("/fleet/manoeuvre", requireWs, requirePlan("operator"), async (req, res) => {
  try {
    const { primaryId, secondaryId, targetMissKm } = req.body || {};
    if (!primaryId || !secondaryId) return res.status(400).json({ error: "primaryId and secondaryId required" });
    const asset = fleet.getAsset(req.workspace.id, primaryId);
    if (!asset) return res.status(404).json({ error: "primaryId is not in your fleet" });

    const sats = await getSatellites();
    const out = watch.screenFleet(req.workspace.id, sats, screenConjunctions, { hours: 96, thresholdKm: 50 });
    const enc = (out.assessed || []).find(a =>
      String(a.primary.id) === String(primaryId) && String(a.secondary.id) === String(secondaryId));
    if (!enc || !enc.state) return res.status(404).json({ error: "No current encounter between those objects" });

    const leads = [24, 12, 6, 3].filter(h => h < enc.leadHours);
    const plan = pcmod.planManoeuvre(enc.state, {
      targetMissKm: Math.min(Math.max(Number(targetMissKm) || 5, 0.1), 100),
      massKg: asset.massKg, ispS: asset.ispS, hbrM: enc.hbrM,
      ageDaysA: enc.primary.ageDays, ageDaysB: enc.secondary.ageDays,
      kindA: enc.primary.kind, kindB: enc.secondary.kind,
      leadsHours: leads.length ? leads : [Math.max(0.5, enc.leadHours * 0.5)]
    });
    res.json({
      encounter: { tca: enc.tca, missKm: enc.missKm, pc: enc.pc, pcBand: enc.pcBand,
                   leadHours: enc.leadHours, ric: enc.ric },
      spacecraft: asset, plan
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Run the watch on demand rather than waiting for the next sweep.
api.post("/fleet/watch/run", requireWs, requirePlan("tracker"), async (req, res) => {
  try {
    const sats = await getSatellites();
    const r = await watch.runWatch(req.workspace.id, req.workspace, sats, screenConjunctions, {
      onEvent: p => { try { broadcast("conjunction.alert", p); } catch { /* ws optional */ } }
    });
    res.json({ ok: true, ...r });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Assess an arbitrary pair — for API users checking a CDM by hand.
api.get("/assess", requireWs, requirePlan("operator"), async (req, res) => {
  try {
    const { a, b } = req.query;
    if (!a || !b) return res.status(400).json({ error: "a and b (NORAD IDs) required" });
    const sats = await getSatellites();
    const byId = new Map(sats.map(s => [String(s.id), s]));
    if (!byId.has(String(a)) || !byId.has(String(b))) return res.status(404).json({ error: "Unknown object" });
    const d = await runScreening(null, 24, 50);
    const ev = (d.events || []).find(e =>
      (String(e.a.id) === String(a) && String(e.b.id) === String(b)) ||
      (String(e.a.id) === String(b) && String(e.b.id) === String(a)));
    if (!ev) return res.json({ found: false, note: "No close approach between these objects in the next 24 hours." });
    const assessed = watch.assessEvent(ev, byId, Number(req.query.hbrM) || 20);
    if (!assessed) return res.json({ found: false, note: "Could not propagate both objects to the encounter." });
    const { state, ...safe } = assessed;
    res.json({ found: true, encounter: safe });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- v8: public status ----------
api.get("/status", async (req, res) => {
  let catalog = 0;
  try { catalog = (await getSatellites()).length; } catch { /* source down */ }
  res.json({
    ok: true, version: 8,
    uptimeS: Math.round(process.uptime()),
    dataSource: dataSourceInfo().catalog,
    catalogObjects: catalog,
    archive: ledger.stats(),
    backup: backup.status(),
    mail: mailer.status(),
    fleets: fleet.stats(),
    trends: trend.stats(),
    // Surfaced so a misconfigured cap is visible rather than silently turning
    // every screen into a clean sheet. The raw env value is deliberately NOT
    // echoed: /status is public, and if someone has pasted a secret into the
    // wrong variable, printing it here would publish it. Report only whether
    // the value was usable.
    screening: {
      feed: screenFeedStatus(),
      sweepCap: SWEEP_CAP,
      sweepCapConfigured: process.env.ORBITIQ_SWEEP_CAP !== undefined && process.env.ORBITIQ_SWEEP_CAP !== "",
      sweepCapValid: SWEEP_CAP_VALID
    },
    liveClients: wss.clients.size,
    time: new Date().toISOString()
  });
});

api.post("/reports/share", requirePlan("operator"), async (req, res) => {
  try {
    const org = (req.body?.org && req.workspace.role === "admin") ? req.body.org : req.workspace.org;
    if (!org) return res.status(400).json({ error: "Bind your workspace to an organization first" });
    const orgName = orgList(await getSatellites()).find(o => o.id === org)?.name || org;
    const token = store.createShare(org, orgName, req.workspace.id);
    res.status(201).json({ token, url: `/r/${token}`, note: "Public read-only link to this org's live weekly intelligence report." });
  } catch (e) { res.status(500).json({ error: "Share failed", detail: e.message }); }
});

// ---------- admin ----------
api.get("/admin/overview", requireAdmin, async (req, res) => {
  let catalog = 0;
  try { catalog = (await getSatellites()).length; } catch { /* source down */ }
  res.json({
    workspaces: store.adminOverview(),
    system: { catalogObjects: catalog, wsClients: wss.clients.size, uptimeS: Math.round(process.uptime()), version: 3 }
  });
});
api.delete("/admin/workspaces/:id", requireAdmin, (req, res) => {
  const ok = store.deleteWorkspace(req.params.id);
  ok ? res.json({ ok: true }) : res.status(400).json({ error: "Not found or cannot delete an admin workspace" });
});
api.post("/admin/broadcast", requireAdmin, (req, res) => {
  const message = String(req.body?.message || "").slice(0, 240);
  if (!message.trim()) return res.status(400).json({ error: "message required" });
  broadcast("notice", { message, from: req.workspace.name });
  res.json({ ok: true, delivered: wss.clients.size });
});
api.post("/admin/scan-all", requireAdmin, async (req, res) => {
  await scanAllWorkspaces();
  res.json({ ok: true });
});
api.post("/admin/workspaces/:id/plan", requireAdmin, (req, res) => {
  const w = store.setPlan(req.params.id, req.body?.plan);
  w ? res.json({ ok: true, id: w.id, plan: w.plan }) : res.status(404).json({ error: "Workspace not found" });
});

// ---------- exports ----------
api.get("/export/catalog.csv", async (req, res) => {
  try {
    const sats = await getSatellites();
    const org = req.query.org && req.query.org !== "all" ? req.query.org : null;
    const rows = (org ? sats.filter(s => s.org === org) : sats)
      .map(s => [s.id, JSON.stringify(s.name), s.intl, s.org, s.incl, s.ecc, s.meanMotion, s.epoch].join(","));
    res.type("text/csv").send("norad_id,name,intl_designator,org,inclination_deg,eccentricity,mean_motion_rev_day,epoch\n" + rows.join("\n"));
  } catch (e) { res.status(502).json({ error: "Export failed", detail: e.message }); }
});

api.get("/export/conjunctions.csv", async (req, res) => {
  try {
    const org = req.query.org && req.query.org !== "all" ? req.query.org : null;
    const d = await runScreening(org, Math.min(parseFloat(req.query.hours) || 3, 12), Math.min(parseFloat(req.query.thresholdKm) || 10, 50));
    const rows = d.events.map(ev => [ev.tca, ev.missKm, ev.relVelKmS, ev.altKm, ev.risk, ev.a.id, JSON.stringify(ev.a.name), ev.b.id, JSON.stringify(ev.b.name)].join(","));
    res.type("text/csv").send("tca,miss_km,rel_vel_km_s,alt_km,risk,norad_a,name_a,norad_b,name_b\n" + rows.join("\n"));
  } catch (e) { res.status(502).json({ error: "Export failed", detail: e.message }); }
});

// JSON 404 for unknown API routes + central error handler (robustness)
api.use((req, res) => res.status(404).json({ error: "Unknown endpoint", docs: "/docs.html" }));
app.use("/api", api);
app.use("/api/v1", api);

// ---------- public shareable report page (token is the secret) ----------
app.get("/r/:token", (req, res) => {
  const share = store.getShare(req.params.token);
  if (!share) return res.status(404).type("html").send("<body style='background:#070b14;color:#8fa3c8;font-family:sans-serif;display:grid;place-items:center;height:100vh'><div>Report link not found or revoked.</div></body>");
  const rep = ledger.weeklyReport(share.org, share.orgName);
    // Escapes quotes too: this output is interpolated into href="..." with a
  // value derived from the Host header, so a missing quote escape is a
  // reflected XSS on an unauthenticated page.
  const esc = t => String(t).replace(/[<>&"']/g, c =>
    ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;" }[c]));
  const risk = rep.risk.current;
  res.type("html").send(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Weekly Fleet Intelligence — ${esc(share.orgName)} · OrbitIQ</title>
<style>
  body{margin:0;background:#070b14;color:#e6edfa;font:15px/1.6 Inter,system-ui,sans-serif;padding:48px 20px}
  .wrap{max-width:680px;margin:0 auto}
  .brand{font-weight:650;letter-spacing:.4px;color:#38bdf8;font-size:13px;text-transform:uppercase}
  h1{font-size:26px;margin:10px 0 2px}
  .period{color:#5a6a8a;font-size:13px;margin-bottom:28px}
  .card{background:#0b1322;border:1px solid #1b2a45;border-radius:12px;padding:20px 22px;margin-bottom:14px}
  .card h2{font-size:12px;text-transform:uppercase;letter-spacing:.8px;color:#8fa3c8;margin:0 0 12px}
  li{margin-bottom:6px}
  .nums{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;text-align:center}
  .n .v{font-size:24px;font-weight:650;color:#38bdf8}.n .l{font-size:11px;color:#5a6a8a}
  .grade{display:inline-block;padding:2px 10px;border-radius:99px;background:#123;border:1px solid #1b2a45;font-weight:650}
  .foot{margin-top:30px;color:#5a6a8a;font-size:12.5px;text-align:center}
  .foot a{color:#38bdf8;text-decoration:none;font-weight:600}
</style></head><body><div class="wrap">
  <div class="brand">OrbitIQ · Weekly Fleet Intelligence</div>
  <h1>${esc(share.orgName)}</h1>
  <div class="period">${esc(new Date(rep.period.from).toUTCString().slice(0, 16))} → ${esc(new Date(rep.period.to).toUTCString().slice(0, 16))} · generated live from the detection archive</div>
  <div class="card"><h2>Highlights</h2><ul>${rep.highlights.map(h => `<li>${esc(h)}</li>`).join("")}</ul></div>
  <div class="card"><h2>This week in numbers</h2><div class="nums">
    <div class="n"><div class="v">${rep.counts.conjunctions}</div><div class="l">conjunction events</div></div>
    <div class="n"><div class="v">${rep.counts.maneuvers}</div><div class="l">maneuvers</div></div>
    <div class="n"><div class="v">${rep.counts.anomalies}</div><div class="l">anomalies</div></div>
    <div class="n"><div class="v">${risk ? risk.index : "—"}</div><div class="l">risk index ${risk ? `<span class="grade">${esc(risk.grade)}</span>` : ""}</div></div>
  </div></div>
  ${rep.closestApproach ? `<div class="card"><h2>Closest approach</h2>${esc(rep.closestApproach.aName)} ⇄ ${esc(rep.closestApproach.bName)} — <b>${esc(rep.closestApproach.missKm)} km</b>${rep.closestApproach.pcText ? `, Pc ${esc(rep.closestApproach.pcText)}` : ""}<br><span style="color:#5a6a8a;font-size:13px">TCA ${esc(new Date(rep.closestApproach.tca).toUTCString())}</span></div>` : ""}
  <div class="foot">Screening-grade intelligence computed from public orbital data.<br>Get this for your fleet — <a href="https://${esc(req.get("host") || "orbit.mnbresearch.com")}">OrbitIQ · live space traffic intelligence</a></div>
</div></body></html>`);
});

// central error handler — last middleware so it catches everything above
app.use((err, req, res, next) => {
  console.error("unhandled:", err.message);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: "Internal error", detail: err.message });
});

// ---------- WebSocket live push ----------
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });
function broadcast(type, payload) {
  const msg = JSON.stringify({ type, payload, t: new Date().toISOString() });
  for (const c of wss.clients) if (c.readyState === 1) c.send(msg);
}
wss.on("connection", c => {
  c.send(JSON.stringify({ type: "hello", payload: { service: "OrbitIQ", version: 3 }, t: new Date().toISOString() }));
});

// ---------- background jobs ----------
async function scanWorkspace(ws) {
  const cfg = ws.screening || { hours: 3, thresholdKm: 10 };
  const result = await runScreening(ws.org, Math.min(cfg.hours, 6), cfg.thresholdKm);
  const fresh = store.addAlerts(ws.id, result.events);
  if (fresh.length) {
    broadcast("alerts", { workspaceId: ws.id, count: fresh.length, top: fresh.slice(0, 3) });
    if (ws.webhook) {
      fetch(ws.webhook, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source: "OrbitIQ", workspace: ws.name, newAlerts: fresh.slice(0, 10) })
      }).catch(err => console.error(`webhook ${ws.name} failed:`, err.message));
    }
  }
  return fresh;
}
async function scanAllWorkspaces() {
  for (const ws of store.allWorkspaces()) {
    try { await scanWorkspace(ws); } catch (e) { console.error(`scan ${ws.name} failed:`, e.message); }
  }
}
async function snapshotPopulation() {
  try {
    const sats = await getSatellites();
    let leo = 0, meo = 0, geo = 0;
    const byOrg = {};
    for (const s of sats) {
      if (s.meanMotion > 11.25) leo++; else if (s.meanMotion > 1.5) meo++; else geo++;
      byOrg[s.org] = (byOrg[s.org] || 0) + 1;
    }
    store.addSnapshot({ t: new Date().toISOString(), total: sats.length, regimes: { LEO: leo, MEO: meo, GEO: geo }, byOrg });
    store.saveHistory(sats); // element history for maneuver detection
  } catch (e) { console.error("snapshot failed:", e.message); }
}
// Global intelligence sweep — feeds the append-only ledger regardless of
// whether any customer is watching. This is the compounding data asset.
async function intelligenceSweep() {
  try {
    const sats = await getSatellites();
    if (!sats.length) return;
    const byId = new Map(sats.map(s => [s.id, s]));
    // 1. conjunctions (global screening, with Pc)
    const d = await runScreening(null, 3, 10);
    const events = intel.augmentConjunctions(d.events, byId).map(ev => ({
      org: null, aOrg: ev.a.org, bOrg: ev.b.org, aName: ev.a.name, bName: ev.b.name,
      aId: ev.a.id, bId: ev.b.id, tca: ev.tca, missKm: ev.missKm, relVelKmS: ev.relVelKmS,
      altKm: ev.altKm, risk: ev.risk, pc: ev.pc, pcText: ev.pcText
    }));
    ledger.append("conjunction", events);
    // 2. maneuvers + anomalies
    const hist = store.loadHistory();
    ledger.append("maneuver", detectManeuvers(sats, hist).map(m => ({
      org: m.org, id: m.id, name: m.name, kind: m.type, dAltKm: m.dAltKm, dInclDeg: m.dInclDeg, confidence: m.confidence
    })));
    ledger.append("anomaly", (intel.anomalies(sats, hist).flags || []).map(a => ({
      org: a.org, id: a.id, name: a.name, zScore: a.zScore, severity: a.severity
    })));
    // 3. fleet risk for the most significant operators (bounded + yielding,
    //    so a big live catalog can't starve the event loop)
    const cong = congestion(sats);
    const orgs = orgList(sats).filter(o => o.count >= 20 && o.id !== "other").slice(0, 4);
    for (const o of orgs) {
      const dr = await runScreening(o.id, 3, 10);
      const r = intel.fleetRisk(o.id, sats, dr.events, cong.shells);
      if (!r.error) ledger.append("risk", [{ org: o.id, index: r.index, grade: r.grade, components: r.components, fleetSize: r.fleetSize }]);
      await new Promise(res => setTimeout(res, 1500)); // breathe between screens
    }
    // 3b. fleet watch — screen every registered fleet, alert what clears policy
    for (const wsId of fleet.workspacesWithFleets()) {
      try {
        const ws = store.getWorkspace(wsId);
        if (!ws) continue;
        const r = await watch.runWatch(wsId, ws, sats, screenConjunctions, {
          onEvent: p => { try { broadcast("conjunction.alert", p); } catch {} }
        });
        if (r.notified) console.log(`watch: ${wsId} — ${r.notified} alert(s) from ${r.assessed} encounter(s)`);
      } catch (e) { console.error("watch failed for", wsId, e.message); }
      await new Promise(res => setTimeout(res, 800));
    }

    // 4. congestion snapshot
    ledger.append("congestion", [{ org: null, mostCongested: cong.mostCongested, totalLeo: cong.shells.reduce((s, x) => s + x.count, 0) }]);
    // 5. space environment — enables risk ↔ space-weather correlation later
    try { ledger.append("environment", [await environmentForLedger()]); } catch { /* optional */ }
    // 6. re-entry board snapshot (top movers only)
    try {
      ledger.append("reentry", netops.reentryWatch(sats, 3).objects.map(r => ({
        org: r.org, id: r.id, name: r.name, perigeeKm: r.perigeeKm, lifetimeDays: r.lifetimeDays, class: r.class
      })));
    } catch { /* optional */ }
    console.log(`intelligence sweep archived — ledger now ${ledger.stats().totalEvents} events`);
    // persist the moat: back the archive up to GitHub after every sweep
    backup.backup();
  } catch (e) { console.error("intelligence sweep failed:", e.message); }
}
// best-effort final backup when Render recycles the instance
process.on("SIGTERM", async () => {
  // Flush the store before backing up, otherwise anything written in the last
  // few hundred ms is lost — and with the old unbounded debounce, potentially
  // everything since boot.
  try { store.flushStore?.(); } catch { /* best effort */ }
  try { fleet.flush?.(); } catch { /* best effort */ }
  try { trend.flush?.(); } catch { /* best effort */ }
  try { await backup.backup(); } finally { process.exit(0); }
});

// An unhandled rejection terminates the process by default on Node 20+, and
// several public async routes had code paths outside their try/catch. Log and
// keep serving rather than dropping every in-flight request.
process.on("unhandledRejection", (reason) => {
  console.error("unhandled rejection:", reason?.stack || reason);
});

// setInterval does not await an async callback, so a run that takes longer
// than its period starts overlapping copies of itself — each holding its own
// catalogue and screening state, on a 512 MB instance. Past a dozen or so
// workspaces scanAllWorkspaces genuinely does exceed 30 minutes. This runs
// each job on a self-scheduling timer that only re-arms once the previous
// pass has finished, and logs a skip rather than silently piling up.
function everyNonOverlapping(fn, periodMs, label) {
  let running = false;
  const tick = async () => {
    if (running) { console.warn(`${label}: previous run still in progress, skipping`); return; }
    running = true;
    const t0 = Date.now();
    try { await fn(); }
    catch (e) { console.error(`${label} failed:`, e?.message || e); }
    finally {
      running = false;
      const ms = Date.now() - t0;
      if (ms > periodMs) console.warn(`${label}: took ${Math.round(ms / 1000)}s, longer than its ${Math.round(periodMs / 1000)}s period`);
    }
  };
  const timer = setInterval(tick, periodMs);
  timer.unref?.();
  return timer;
}

async function warmScreeningCache() {
  // Populates the cache the public endpoint reads from. Sequential and
  // awaited, so it never overlaps itself or another screen.
  for (const [hours, thresholdKm] of [[3, 10], [12, 25]]) {
    try { await runScreening(null, hours, thresholdKm); }
    catch (e) { console.error("warm screen failed:", e.message); }
  }
}
// Deliberately NOT run at boot. A cold screen during startup makes the health
// check fail before the instance is marked live, and it gets recycled — a boot
// loop that looks like a crash. Let it come up and serve traffic first.
setTimeout(() => { warmScreeningCache(); }, 3 * 60 * 1000).unref?.();
everyNonOverlapping(warmScreeningCache, 20 * 60 * 1000, "screening cache warm");
everyNonOverlapping(scanAllWorkspaces, 30 * 60 * 1000, "workspace scan");
everyNonOverlapping(async () => { const n = trend.prune(); if (n) console.log(`trend: pruned ${n} past encounters`); }, 6 * 60 * 60 * 1000, "trend prune");
everyNonOverlapping(snapshotPopulation, 6 * 60 * 60 * 1000, "population snapshot");
// Seal hourly. Cheap (one hash walk), and the tighter the seal cadence the
// narrower the window in which history could be rewritten unnoticed.
everyNonOverlapping(async () => {
  const r = ledger.seal();
  if (r.ok && !r.unchanged) console.log(`ledger: sealed at seq ${r.seal.seq} (${r.seal.hash})`);
  if (!r.ok && r.error !== "nothing to seal yet") console.error("ledger seal refused:", r.error);
}, 60 * 60 * 1000, "ledger seal");

everyNonOverlapping(intelligenceSweep, 6 * 60 * 60 * 1000, "intelligence sweep");
// stagger heavy boot work so the instance passes health checks first
setTimeout(snapshotPopulation, 90 * 1000);
setTimeout(intelligenceSweep, 5 * 60 * 1000);

// bootstrap the admin workspace
const { admin, created } = store.ensureAdmin(process.env.ORBITIQ_ADMIN_KEY || null);
if (created && !process.env.ORBITIQ_ADMIN_KEY) {
  console.log("─".repeat(60));
  console.log("ADMIN WORKSPACE CREATED — store this key (shown once):");
  console.log("  " + admin.apiKey);
  console.log("Set ORBITIQ_ADMIN_KEY env var to keep it stable across restarts.");
  console.log("─".repeat(60));
} else {
  console.log(`Admin workspace ready (${admin.name})`);
}
// v9: bootstrap the admin login (email/password → full-access session).
// Override via ORBITIQ_ADMIN_EMAIL / ORBITIQ_ADMIN_PASSWORD; change the
// password from the UI after first sign-in.
// The admin password must come from the environment. It used to fall back to
// a literal in this file, which meant any deployment that forgot to set the
// env var shipped with a publicly-known admin login — and logging in as admin
// returns the admin API key, which is full control of every workspace. If it
// is unset we mint a random one and print it once, so a misconfigured deploy
// is locked rather than wide open.
{
  const adminEmail = process.env.ORBITIQ_ADMIN_EMAIL;
  let adminPass = process.env.ORBITIQ_ADMIN_PASSWORD;
  if (!adminEmail || !adminPass) {
    adminPass = crypto.randomBytes(18).toString("base64url");
    console.warn(
      "\n  ORBITIQ_ADMIN_EMAIL / ORBITIQ_ADMIN_PASSWORD are not both set.\n" +
      "  A random admin password has been generated for this boot only:\n\n" +
      `      email:    ${adminEmail || "admin@orbitiq.local"}\n` +
      `      password: ${adminPass}\n\n` +
      "  It changes on every restart. Set both env vars to make it stable.\n");
  }
  auth.bootstrapAdmin(adminEmail || "admin@orbitiq.local", adminPass, admin.id);
}

server.listen(PORT, () => console.log(`OrbitIQ v8 listening on http://localhost:${PORT}  (API: /api/v1, WS: /ws)`));
