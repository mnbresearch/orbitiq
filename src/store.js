// OrbitIQ persistent store — workspaces, alerts, snapshots, element history.
// Single-process JSON persistence (swap for Postgres/SQLite when scaling).
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(__dirname, "..", "data", "store.json");
const HISTORY_FILE = path.join(__dirname, "..", "data", "elements-history.json");

let db = { workspaces: {}, alerts: {}, snapshots: [], usage: {} };
try { db = { ...db, ...JSON.parse(fs.readFileSync(FILE, "utf8")) }; } catch { /* fresh */ }

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { fs.writeFileSync(FILE, JSON.stringify(db)); } catch (e) { console.error("store save failed:", e.message); }
  }, 300);
}

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
  free:     { rank: 0, dailyCalls: 200,   label: "Observer" },
  tracker:  { rank: 1, dailyCalls: 2000,  label: "Tracker" },
  operator: { rank: 2, dailyCalls: 20000, label: "Operator" },
  pro:      { rank: 2, dailyCalls: 20000, label: "Operator" } // legacy alias
};
export function setPlan(id, plan) {
  const w = db.workspaces[id]; if (!w) return null;
  w.plan = PLANS[plan] ? plan : "free";
  save(); return w;
}
export function todayCalls(apiKey) {
  const day = new Date().toISOString().slice(0, 10);
  return (db.usage[apiKey] || {})[day] || 0;
}
export function updateWorkspace(id, patch) {
  const w = db.workspaces[id]; if (!w) return null;
  if (patch.webhook !== undefined) w.webhook = patch.webhook ? String(patch.webhook).slice(0, 300) : null;
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
