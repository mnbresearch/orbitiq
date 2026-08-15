// ============================================================
// OrbitIQ — Space Traffic Intelligence Platform (server v3)
// ============================================================
import express from "express";
import compression from "compression";
import http from "http";
import path from "path";
import { fileURLToPath } from "url";
import { WebSocketServer } from "ws";
import * as satellite from "satellite.js";
import { getSatellites, getLaunches, getEvents, orgList } from "./src/data.js";
import { screenConjunctions } from "./src/conjunctions.js";
import { hohmann, launchPlan, congestion, detectManeuvers, LAUNCH_SITES } from "./src/astro.js";
import * as intel from "./src/intel.js";
import * as ledger from "./src/ledger.js";
import * as store from "./src/store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(compression());
app.use(express.json({ limit: "100kb" }));
app.use(express.static(path.join(__dirname, "public")));
app.use("/vendor/three", express.static(path.join(__dirname, "node_modules", "three", "build")));
app.use("/vendor/satellite", express.static(path.join(__dirname, "node_modules", "satellite.js", "dist")));

const PORT = process.env.PORT || 3000;
const api = express.Router();

// ---------- optional API-key auth ----------
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
async function runScreening(org, hours, thresholdKm) {
  const key = `${org}|${hours}|${thresholdKm}`;
  const hit = conjCache.get(key);
  if (hit && Date.now() - hit.at < CONJ_TTL) return { ...hit.result, cached: true };
  const sats = await getSatellites();
  const result = screenConjunctions(sats, org, hours, thresholdKm);
  conjCache.set(key, { at: Date.now(), result });
  return result;
}

// ---------- core data ----------
api.get("/health", (req, res) => res.json({ ok: true, service: "OrbitIQ", version: 3, time: new Date().toISOString() }));

api.get("/satellites", async (req, res) => {
  try {
    const sats = await getSatellites();
    const org = req.query.org, q = (req.query.q || "").toUpperCase();
    let out = sats;
    if (org && org !== "all") out = out.filter(s => s.org === org);
    if (q) out = out.filter(s => s.name.toUpperCase().includes(q) || String(s.id) === q);
    const limit = Math.min(parseInt(req.query.limit) || 20000, 20000);
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
    const hours = Math.min(parseFloat(req.query.hours) || 3, 12);
    const threshold = Math.min(parseFloat(req.query.thresholdKm) || 10, 50);
    res.json(await runScreening(org, hours, threshold));
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

// ---------- plans (public pricing surface) ----------
api.get("/plans", (req, res) => res.json({
  plans: [
    { id: "free", label: "Observer", price: "$0", dailyCalls: 200, includes: ["Live 3D tracking & catalog", "Launches & events", "Basic conjunction screening", "TLE staleness & Gabbard teasers"] },
    { id: "tracker", label: "Tracker", price: "$9/mo", dailyCalls: 2000, includes: ["Everything in Observer", "Pro pass prediction with Doppler", "Optical visibility forecasting", "Eclipse windows"] },
    { id: "operator", label: "Operator", price: "$99/mo", dailyCalls: 20000, includes: ["Everything in Tracker", "Collision probability (Pc) screening", "Fleet Risk Index + history", "Background alerting + webhooks", "Intelligence archive queries", "Weekly Fleet Intelligence Reports"] },
    { id: "mission", label: "Mission", price: "custom", dailyCalls: null, includes: ["Everything in Operator", "Custom orgs & SLAs", "Data exports & integrations"] }
  ],
  activation: "Payments are handled by the operator today (contact via workspace). Plan is activated on your API key within minutes.",
  note: "Prices are launch pricing and may change."
}));

// ---------- intelligence archive (the data moat) ----------
api.get("/archive/stats", (req, res) => res.json(ledger.stats())); // public: shows the moat growing
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

app.use("/api", api);
app.use("/api/v1", api);

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
    // 3. fleet risk for every significant operator
    const cong = congestion(sats);
    const orgs = orgList(sats).filter(o => o.count >= 20 && o.id !== "other").slice(0, 8);
    for (const o of orgs) {
      const dr = await runScreening(o.id, 3, 10);
      const r = intel.fleetRisk(o.id, sats, dr.events, cong.shells);
      if (!r.error) ledger.append("risk", [{ org: o.id, index: r.index, grade: r.grade, components: r.components, fleetSize: r.fleetSize }]);
    }
    // 4. congestion snapshot
    ledger.append("congestion", [{ org: null, mostCongested: cong.mostCongested, totalLeo: cong.shells.reduce((s, x) => s + x.count, 0) }]);
    console.log(`intelligence sweep archived — ledger now ${ledger.stats().totalEvents} events`);
  } catch (e) { console.error("intelligence sweep failed:", e.message); }
}

setInterval(scanAllWorkspaces, 30 * 60 * 1000);
setInterval(snapshotPopulation, 6 * 60 * 60 * 1000);
setInterval(intelligenceSweep, 6 * 60 * 60 * 1000);
setTimeout(snapshotPopulation, 10 * 1000);
setTimeout(intelligenceSweep, 25 * 1000);

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

server.listen(PORT, () => console.log(`OrbitIQ v3 listening on http://localhost:${PORT}  (API: /api/v1, WS: /ws)`));
