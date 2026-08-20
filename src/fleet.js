// ============================================================
// OrbitIQ — fleet registry and alert policy.
//
// Until now a "fleet" was a string match on operator name, which is a
// blunt instrument: it cannot carry spacecraft mass, it cannot hold a
// hard-body radius, and it cannot express "screen this object but not
// that one". This module gives each workspace a real registry of
// spacecraft keyed by NORAD ID, with the physical properties the
// probability and manoeuvre maths actually need.
//
// It also holds the alert policy — the thresholds at which OrbitIQ is
// permitted to interrupt someone's day — and the delivery ledger that
// stops it interrupting them twice for the same encounter.
// ============================================================
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "data");
const FILE = path.join(DATA_DIR, "fleet.json");

let db = { assets: {}, policy: {}, delivered: {}, webhookLog: {} };
try {
  db = { ...db, ...JSON.parse(fs.readFileSync(FILE, "utf8")) };
} catch { /* first run */ }

let dirty = false;
function save() { dirty = true; }
setInterval(() => {
  if (!dirty) return;
  dirty = false;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(db));
  } catch (e) { console.error("fleet: save failed", e.message); }
}, 4000).unref?.();

export function flush() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(db));
    dirty = false;
    return true;
  } catch { return false; }
}

// ────────────────────────────── assets ──────────────────────────────
const DEFAULTS = {
  massKg: 260,      // a smallsat, roughly
  ispS: 220,        // monopropellant hydrazine
  radiusM: 1.5,     // characteristic hard-body radius
  manoeuvrable: true
};

/**
 * Register (or update) a spacecraft in a workspace's fleet.
 * NORAD ID is the key — it is the one identifier every catalogue agrees on.
 */
export function addAsset(wsId, { noradId, name, massKg, ispS, radiusM, manoeuvrable, notes }) {
  const id = String(noradId || "").trim();
  if (!/^\d{1,6}$/.test(id)) return { error: "NORAD ID must be 1-6 digits" };
  if (!db.assets[wsId]) db.assets[wsId] = {};
  const existing = db.assets[wsId][id];
  const a = {
    noradId: id,
    name: (name || existing?.name || `NORAD ${id}`).slice(0, 60),
    massKg: clampNum(massKg, existing?.massKg ?? DEFAULTS.massKg, 1, 1000000),
    ispS: clampNum(ispS, existing?.ispS ?? DEFAULTS.ispS, 50, 5000),
    radiusM: clampNum(radiusM, existing?.radiusM ?? DEFAULTS.radiusM, 0.05, 100),
    manoeuvrable: manoeuvrable === undefined
      ? (existing?.manoeuvrable ?? DEFAULTS.manoeuvrable) : !!manoeuvrable,
    notes: (notes ?? existing?.notes ?? "").slice(0, 240),
    addedAt: existing?.addedAt || new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  db.assets[wsId][id] = a;
  save();
  // Tell the caller if we altered anything they supplied, rather than
  // silently storing a different number than they typed.
  const adjusted = [];
  if (massKg !== undefined && Number(massKg) !== a.massKg) adjusted.push(`massKg clamped to ${a.massKg}`);
  if (ispS !== undefined && Number(ispS) !== a.ispS) adjusted.push(`ispS clamped to ${a.ispS}`);
  if (radiusM !== undefined && Number(radiusM) !== a.radiusM) adjusted.push(`radiusM clamped to ${a.radiusM}`);
  return adjusted.length ? { ok: true, asset: a, adjusted } : { ok: true, asset: a };
}

function clampNum(v, fallback, lo, hi) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(lo, Math.min(hi, n));
}

export function removeAsset(wsId, noradId) {
  const id = String(noradId);
  if (!db.assets[wsId]?.[id]) return { error: "Not in this fleet" };
  delete db.assets[wsId][id];
  save();
  return { ok: true };
}

export const listAssets = wsId => Object.values(db.assets[wsId] || {});
export const assetIds  = wsId => Object.keys(db.assets[wsId] || {});
export const getAsset  = (wsId, noradId) => db.assets[wsId]?.[String(noradId)] || null;
export const fleetSize = wsId => Object.keys(db.assets[wsId] || {}).length;

/** Every workspace that has registered at least one spacecraft. */
export const workspacesWithFleets = () =>
  Object.keys(db.assets).filter(w => Object.keys(db.assets[w] || {}).length);

// ────────────────────────────── policy ──────────────────────────────
export const DEFAULT_POLICY = {
  pcThreshold: 1e-5,        // notify at ELEVATED and above
  missThresholdKm: 5,       // …or anything inside 5 km regardless of Pc
  leadHoursMin: 2,          // ignore encounters we cannot act on
  email: true,
  webhookUrl: null,
  webhookSecret: null,
  quietHours: null,         // e.g. {startUtc: 22, endUtc: 6} — criticals still go
  digestWeekly: true
};

export function getPolicy(wsId) {
  return { ...DEFAULT_POLICY, ...(db.policy[wsId] || {}) };
}

export function setPolicy(wsId, patch = {}) {
  const cur = getPolicy(wsId);
  const next = { ...cur };

  if (patch.pcThreshold !== undefined) {
    const v = Number(patch.pcThreshold);
    if (!Number.isFinite(v) || v <= 0 || v > 1) return { error: "pcThreshold must be between 0 and 1" };
    next.pcThreshold = v;
  }
  if (patch.missThresholdKm !== undefined) {
    const v = Number(patch.missThresholdKm);
    if (!Number.isFinite(v) || v < 0 || v > 200) return { error: "missThresholdKm must be 0-200" };
    next.missThresholdKm = v;
  }
  if (patch.leadHoursMin !== undefined) {
    const v = Number(patch.leadHoursMin);
    if (!Number.isFinite(v) || v < 0 || v > 72) return { error: "leadHoursMin must be 0-72" };
    next.leadHoursMin = v;
  }
  if (patch.email !== undefined) next.email = !!patch.email;
  if (patch.digestWeekly !== undefined) next.digestWeekly = !!patch.digestWeekly;

  if (patch.webhookUrl !== undefined) {
    const u = String(patch.webhookUrl || "").trim();
    if (!u) { next.webhookUrl = null; next.webhookSecret = null; }
    else {
      let parsed;
      try { parsed = new URL(u); } catch { return { error: "webhookUrl must be a valid URL" }; }
      if (parsed.protocol !== "https:") return { error: "webhookUrl must use https" };
      // Refuse to post to anything on the local network.
      if (/^(localhost|127\.|0\.|10\.|192\.168\.|169\.254\.|\[?::1)/i.test(parsed.hostname)
          || /^172\.(1[6-9]|2\d|3[01])\./.test(parsed.hostname)) {
        return { error: "webhookUrl may not point at a private or loopback address" };
      }
      next.webhookUrl = parsed.toString();
      if (!next.webhookSecret) next.webhookSecret = "whsec_" + crypto.randomBytes(20).toString("hex");
    }
  }
  if (patch.rotateWebhookSecret && next.webhookUrl) {
    next.webhookSecret = "whsec_" + crypto.randomBytes(20).toString("hex");
  }

  db.policy[wsId] = next;
  save();
  return { ok: true, policy: next };
}

// ───────────────────────── notification ledger ─────────────────────────
/**
 * Encounters are re-detected on every sweep. A conjunction between the
 * same two objects at the same TCA is the same event, so it gets one
 * notification — unless the risk has materially worsened, which is
 * exactly when someone does want telling again.
 */
function encounterKey(ev) {
  const ids = [ev.a?.id, ev.b?.id].sort().join("-");
  const tcaHour = String(ev.tca || "").slice(0, 13);  // hour resolution
  return `${ids}@${tcaHour}`;
}

export function shouldNotify(wsId, ev, pc) {
  const key = encounterKey(ev);
  if (!db.delivered[wsId]) db.delivered[wsId] = {};
  const prev = db.delivered[wsId][key];
  if (!prev) return { notify: true, key, reason: "new encounter" };
  // Re-notify only if probability has grown by an order of magnitude.
  if (pc > prev.pc * 10) return { notify: true, key, reason: "risk increased 10×" };
  return { notify: false, key, reason: "already notified" };
}

export function recordNotified(wsId, key, pc) {
  if (!db.delivered[wsId]) db.delivered[wsId] = {};
  db.delivered[wsId][key] = { pc, at: new Date().toISOString() };
  // keep the ledger bounded
  const entries = Object.entries(db.delivered[wsId]);
  if (entries.length > 500) {
    entries.sort((a, b) => (a[1].at < b[1].at ? -1 : 1));
    db.delivered[wsId] = Object.fromEntries(entries.slice(-400));
  }
  save();
}

export function inQuietHours(policy, now = new Date()) {
  if (!policy.quietHours) return false;
  const h = now.getUTCHours();
  const { startUtc, endUtc } = policy.quietHours;
  return startUtc <= endUtc ? (h >= startUtc && h < endUtc) : (h >= startUtc || h < endUtc);
}

/**
 * Decide whether an assessed encounter clears the workspace's policy.
 * Returns the reason it qualified, which goes into the notification so
 * the recipient knows why they are being told.
 */
export function qualifies(policy, ev, assessment) {
  const leadH = (new Date(ev.tca) - Date.now()) / 3600000;
  if (leadH < policy.leadHoursMin) return { pass: false, why: "inside minimum lead time" };
  if (assessment.pc >= policy.pcThreshold) {
    return { pass: true, why: `probability ${assessment.pc.toExponential(1)} at or above threshold ${policy.pcThreshold.toExponential(1)}` };
  }
  if (ev.missKm <= policy.missThresholdKm) {
    return { pass: true, why: `miss distance ${ev.missKm} km within ${policy.missThresholdKm} km threshold` };
  }
  return { pass: false, why: "below policy thresholds" };
}

// ───────────────────────── webhook delivery ─────────────────────────
/**
 * POST a signed payload. Signature is HMAC-SHA256 over `${timestamp}.${body}`,
 * the same construction Stripe uses, so recipients can verify without
 * inventing a scheme.
 */
export async function deliverWebhook(policy, payload, wsId) {
  if (!policy.webhookUrl) return { skipped: true };
  const body = JSON.stringify(payload);
  const ts = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac("sha256", policy.webhookSecret || "")
    .update(`${ts}.${body}`).digest("hex");
  try {
    const r = await fetch(policy.webhookUrl, {
      method: "POST",
      signal: AbortSignal.timeout(8000),
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "OrbitIQ-webhook/1",
        "OrbitIQ-Timestamp": String(ts),
        "OrbitIQ-Signature": `v1=${sig}`
      },
      body
    });
    logWebhook(wsId, { at: new Date().toISOString(), status: r.status, ok: r.ok });
    return { ok: r.ok, status: r.status };
  } catch (e) {
    logWebhook(wsId, { at: new Date().toISOString(), status: 0, ok: false, error: e.message });
    return { ok: false, error: e.message };
  }
}

function logWebhook(wsId, entry) {
  if (!db.webhookLog[wsId]) db.webhookLog[wsId] = [];
  db.webhookLog[wsId].unshift(entry);
  db.webhookLog[wsId] = db.webhookLog[wsId].slice(0, 25);
  save();
}
export const webhookLog = wsId => db.webhookLog[wsId] || [];

export const stats = () => ({
  workspacesWithFleets: workspacesWithFleets().length,
  totalAssets: Object.values(db.assets).reduce((n, m) => n + Object.keys(m).length, 0),
  policiesConfigured: Object.keys(db.policy).length
});
