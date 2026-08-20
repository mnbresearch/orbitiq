// OrbitIQ persistent store — workspaces, alerts, snapshots, element history.
// Single-process JSON persistence (swap for Postgres/SQLite when scaling).
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { validateWebhookUrl } from "./safeurl.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(__dirname, "..", "data", "store.json");
const HISTORY_FILE = path.join(__dirname, "..", "data", "elements-history.json");

let db = { workspaces: {}, alerts: {}, snapshots: [], usage: {}, shares: {} };
try { db = { ...db, ...JSON.parse(fs.readFileSync(FILE, "utf8")) }; } catch { /* fresh */ }

// These tables are indexed by values that arrive straight from the URL and the
// request body: /r/:token, /admin/workspaces/:id/plan, workspace ids. On a
// normal object the key "__proto__" resolves to Object.prototype — truthy, so
// existence guards pass — and the subsequent write pollutes every object in
// the process. Null-prototype maps make those keys ordinary, absent entries.
// Rebuilt rather than mutated because JSON.parse produces normal objects.
const nullMap = o => Object.assign(Object.create(null), o || {});
db.workspaces = nullMap(db.workspaces);
db.alerts     = nullMap(db.alerts);
db.usage      = nullMap(db.usage);
db.shares     = nullMap(db.shares);

let saveTimer = null;
let firstDirtyAt = 0;
const SAVE_DEBOUNCE_MS = 300;
const SAVE_MAX_DELAY_MS = 5000;

function writeNow() {
  clearTimeout(saveTimer); saveTimer = null; firstDirtyAt = 0;
  try {
    // Write to a sibling then rename, so a crash mid-write cannot leave a
    // truncated store.json that fails to parse on the next boot.
    const tmp = FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(db));
    fs.renameSync(tmp, FILE);
  } catch (e) { console.error("store save failed:", e.message); }
}

function save() {
  // The debounce used to be unconditional, which meant a steady stream of
  // writes (recordUsage runs on every authenticated request) reset the timer
  // forever and nothing was ever persisted — workspaces, alerts and shares
  // were silently lost on restart. The max-delay floor guarantees a write.
  const now = Date.now();
  if (!firstDirtyAt) firstDirtyAt = now;
  if (now - firstDirtyAt >= SAVE_MAX_DELAY_MS) return writeNow();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(writeNow, SAVE_DEBOUNCE_MS);
  saveTimer.unref?.();
}

/** Flush synchronously — used on shutdown so nothing in flight is lost. */
export function flushStore() { if (firstDirtyAt || saveTimer) writeNow(); }

// ---------- workspaces ----------
export function createWorkspace(name, org, role = "member", fixedKey = null) {
  const id = crypto.randomUUID();
  const apiKey = fixedKey || "oiq_" + crypto.randomBytes(21).toString("base64url");
  const ws = {
    id, name: String(name).slice(0, 60), org: org || null, apiKey, role,
    plan: role === "admin" ? "pro" : "free",
    webhook: null,
    screening: { hours: 3, thresholdKm: 10 },
    createdAt: new Date().toISOString()
  };
  db.workspaces[id] = ws;
  db.alerts[id] = [];
  save();
  return ws;
}

// Ensure a single admin workspace exists. A stable key can be supplied via
// the ORBITIQ_ADMIN_KEY env var (recommended in production so the admin
// login survives restarts on ephemeral disks).
export function ensureAdmin(envKey) {
  let admin = Object.values(db.workspaces).find(w => w.role === "admin");
  if (admin) {
    if (envKey && admin.apiKey !== envKey) { admin.apiKey = envKey; save(); }
    return { admin, created: false };
  }
  admin = createWorkspace("MNB Research — Admin", null, "admin", envKey || null);
  return { admin, created: true };
}
export function deleteWorkspace(id) {
  const w = db.workspaces[id];
  if (!w || w.role === "admin") return false;
  delete db.workspaces[id];
  delete db.alerts[id];
  save();
  return true;
}
export function adminOverview() {
  const day = new Date().toISOString().slice(0, 10);
  return Object.values(db.workspaces).map(w => ({
    id: w.id, name: w.name, org: w.org, role: w.role || "member",
    createdAt: w.createdAt, webhook: !!w.webhook,
    screening: w.screening,
    alertCount: (db.alerts[w.id] || []).length,
    unread: (db.alerts[w.id] || []).filter(a => !a.read).length,
    callsToday: (db.usage[w.apiKey] || {})[day] || 0
  }));
}
export const findByKey = key => Object.values(db.workspaces).find(w => w.apiKey === key) || null;
export const getWorkspace = id => db.workspaces[id] || null;
export const allWorkspaces = () => Object.values(db.workspaces);
export const PLANS = {
  free:     { rank: 0, dailyCalls: 200,   label: "Observer",      price: 0,    period: "invitation only" },
  tracker:  { rank: 1, dailyCalls: 2000,  label: "Operator",      price: 2500, period: "per month" },
  operator: { rank: 2, dailyCalls: 20000, label: "Constellation", price: 9000, period: "per month" },
  pro:      { rank: 2, dailyCalls: 20000, label: "Constellation", price: 9000, period: "per month" } // legacy alias
};

// Public catalogue — what the landing page and pricing modal render.
export const PLAN_CATALOG = [
  {
    id: "free", name: "Observer", price: "Invitation only", cadence: "",
    pitch: "For researchers, analysts and prospective operators evaluating the platform.",
    features: [
      "Live catalogue of 16,000+ tracked objects",
      "Global conjunction screening feed",
      "Re-entry watch board and space-weather context",
      "200 API calls per day"
    ]
  },
  {
    id: "tracker", name: "Operator", price: "$2,500", cadence: "per month",
    pitch: "For single-fleet operators who need their own objects screened continuously.",
    highlight: true,
    features: [
      "Everything in Observer",
      "Fleet-scoped conjunction screening and risk ranking",
      "Probability-of-collision analysis per encounter",
      "Ground-station contact planning and pass scheduling",
      "Alert inbox with live push, plus email escalation",
      "2,000 API calls per day"
    ]
  },
  {
    id: "operator", name: "Constellation", price: "$9,000", cadence: "per month",
    pitch: "For multi-plane constellations where screening volume and history both matter.",
    features: [
      "Everything in Operator",
      "Constellation architecture analytics across all planes",
      "Full access to the intelligence archive and trend history",
      "Manoeuvre and anomaly detection across your fleet",
      "Ephemeris export and shareable operator reports",
      "20,000 API calls per day"
    ]
  },
  {
    id: "enterprise", name: "Enterprise", price: "Bespoke", cadence: "",
    pitch: "For agencies, insurers and defence programmes with bespoke requirements.",
    features: [
      "Everything in Constellation",
      "Dedicated instance and custom data retention",
      "Private catalogue ingestion and bespoke integrations",
      "Named analyst support and briefing cadence",
      "Commercial terms and volumes agreed directly"
    ]
  }
];
export function setPlan(id, plan) {
  const w = db.workspaces[id]; if (!w) return null;
  w.plan = PLANS[plan] ? plan : "free";
  save(); return w;
}
// ---------- shareable report links ----------
export function createShare(org, orgName, createdBy) {
  db.shares = db.shares || {};
  const token = crypto.randomBytes(9).toString("base64url");
  db.shares[token] = { org, orgName, createdBy, createdAt: new Date().toISOString(), views: 0 };
  save();
  return token;
}
export function getShare(token) {
  const s = (db.shares || {})[token] || null;
  if (s) { s.views = (s.views || 0) + 1; save(); }
  return s;
}
export function todayCalls(apiKey) {
  const day = new Date().toISOString().slice(0, 10);
  return (db.usage[apiKey] || {})[day] || 0;
}
export function rotateKey(id) {
  const w = db.workspaces[id];
  if (!w || w.role === "admin") return null; // admin key is env-managed
  const old = w.apiKey;
  w.apiKey = "oiq_" + crypto.randomBytes(21).toString("base64url");
  if (db.usage[old]) { db.usage[w.apiKey] = db.usage[old]; delete db.usage[old]; }
  save();
  return w;
}
export function updateWorkspace(id, patch) {
  const w = db.workspaces[id]; if (!w) return null;
  if (patch.webhook !== undefined) {
    // This used to store whatever it was handed and the scanner POSTed alert
    // JSON to it. Creating a workspace needs no credential, so that was an
    // unauthenticated SSRF into the cloud metadata endpoint and any internal
    // service. Same validator the v14 fleet policy uses.
    if (!patch.webhook) w.webhook = null;
    else {
      const v = validateWebhookUrl(patch.webhook);
      if (v.error) return { error: `webhook: ${v.error}` };
      w.webhook = v.url;
    }
  }
  if (patch.org !== undefined) w.org = patch.org || null;
  if (patch.screening) {
    w.screening.hours = Math.min(Math.max(parseFloat(patch.screening.hours) || 3, 1), 6);
    w.screening.thresholdKm = Math.min(Math.max(parseFloat(patch.screening.thresholdKm) || 10, 1), 50);
  }
  save(); return w;
}
export function recordUsage(apiKey) {
  const day = new Date().toISOString().slice(0, 10);
  db.usage[apiKey] = db.usage[apiKey] || {};
  db.usage[apiKey][day] = (db.usage[apiKey][day] || 0) + 1;
  save();
}
export const usageFor = apiKey => db.usage[apiKey] || {};

// ---------- alerts ----------
export function addAlerts(wsId, events) {
  const list = db.alerts[wsId] = db.alerts[wsId] || [];
  const fresh = [];
  for (const ev of events) {
    const key = `${ev.a.id}|${ev.b.id}|${ev.tca.slice(0, 16)}`;
    if (list.some(a => a.key === key)) continue;
    const alert = { key, id: crypto.randomUUID(), createdAt: new Date().toISOString(), read: false, ...ev };
    list.unshift(alert); fresh.push(alert);
  }
  db.alerts[wsId] = list.slice(0, 200);
  if (fresh.length) save();
  return fresh;
}
export const listAlerts = wsId => db.alerts[wsId] || [];
export function markAlertsRead(wsId) {
  for (const a of db.alerts[wsId] || []) a.read = true;
  save();
}

// ---------- daily snapshots (population trend) ----------
export function addSnapshot(snap) {
  const day = snap.t.slice(0, 10);
  if (db.snapshots.some(s => s.t.slice(0, 10) === day)) return;
  db.snapshots.push(snap);
  db.snapshots = db.snapshots.slice(-365);
  save();
}
export const listSnapshots = () => db.snapshots;

// ---------- element history (maneuver detection) ----------
export function loadHistory() {
  try { return JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8")); } catch { return {}; }
}
export function saveHistory(sats) {
  const map = loadHistory();
  for (const s of sats) {
    const prev = map[s.id];
    // keep the previous distinct epoch so we can diff epoch-over-epoch
    if (!prev || prev.epoch !== s.epoch) {
      map[s.id] = {
        epoch: s.epoch, meanMotion: s.meanMotion, incl: s.incl, raan: s.raan, ecc: s.ecc,
        prev: prev ? { epoch: prev.epoch, meanMotion: prev.meanMotion, incl: prev.incl, raan: prev.raan, ecc: prev.ecc } : null
      };
    }
  }
  try { fs.writeFileSync(HISTORY_FILE, JSON.stringify(map)); } catch { /* non-fatal */ }
  return map;
}
