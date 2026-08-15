// ============================================================
// OrbitIQ Intelligence Ledger — the data moat.
// Append-only archive of every derived event the platform
// detects: conjunctions, maneuvers, anomalies, risk indices,
// congestion snapshots. Past detections cannot be re-derived
// from public data by a later entrant; every day the platform
// runs, this asset compounds.
// ============================================================
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(__dirname, "..", "data", "ledger.jsonl");
const MAX_LINES = 200000; // rotate: keep the most recent events

let cache = null; // in-memory mirror

function loadAll() {
  if (cache) return cache;
  try {
    cache = fs.readFileSync(FILE, "utf8").split("\n").filter(Boolean).map(l => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
  } catch { cache = []; }
  return cache;
}

export function append(type, payload) {
  const rows = (Array.isArray(payload) ? payload : [payload]).map(p => ({
    t: new Date().toISOString(), type, ...p
  }));
  if (!rows.length) return 0;
  loadAll().push(...rows);
  try {
    fs.appendFileSync(FILE, rows.map(r => JSON.stringify(r)).join("\n") + "\n");
    if (cache.length > MAX_LINES) {
      cache = cache.slice(-MAX_LINES);
      fs.writeFileSync(FILE, cache.map(r => JSON.stringify(r)).join("\n") + "\n");
    }
  } catch (e) { console.error("ledger write failed:", e.message); }
  return rows.length;
}

export function query({ type, org, since, until, limit = 500 } = {}) {
  const t0 = since ? new Date(since).getTime() : 0;
  const t1 = until ? new Date(until).getTime() : Infinity;
  const out = [];
  const all = loadAll();
  for (let i = all.length - 1; i >= 0 && out.length < Math.min(limit, 2000); i--) {
    const r = all[i];
    const ts = new Date(r.t).getTime();
    if (ts < t0 || ts > t1) continue;
    if (type && r.type !== type) continue;
    if (org && r.org !== org && r.aOrg !== org && r.bOrg !== org) continue;
    out.push(r);
  }
  return { count: out.length, events: out, ledgerSize: all.length, oldest: all[0]?.t || null };
}

export function riskHistory(org) {
  const rows = loadAll().filter(r => r.type === "risk" && r.org === org);
  return {
    org,
    series: rows.map(r => ({ t: r.t, index: r.index, grade: r.grade, components: r.components })),
    note: "Daily Fleet Risk Index history — accumulates automatically while the platform runs."
  };
}

export function stats() {
  const all = loadAll();
  const byType = {};
  for (const r of all) byType[r.type] = (byType[r.type] || 0) + 1;
  return {
    totalEvents: all.length,
    byType,
    oldest: all[0]?.t || null,
    newest: all[all.length - 1]?.t || null,
    note: "Every event here was detected live and archived at detection time; this history is not reconstructable from public sources."
  };
}

// ---------- weekly fleet intelligence report ----------
export function weeklyReport(org, orgName) {
  const weekAgo = Date.now() - 7 * 86400000;
  const all = loadAll().filter(r => new Date(r.t).getTime() >= weekAgo);
  const mine = r => r.org === org || r.aOrg === org || r.bOrg === org;

  const conj = all.filter(r => r.type === "conjunction" && mine(r));
  const closest = conj.reduce((m, r) => (!m || r.missKm < m.missKm) ? r : m, null);
  const man = all.filter(r => r.type === "maneuver" && r.org === org);
  const anom = all.filter(r => r.type === "anomaly" && r.org === org);
  const risks = all.filter(r => r.type === "risk" && r.org === org)
    .map(r => ({ t: r.t, index: r.index, grade: r.grade }));
  const riskNow = risks[risks.length - 1] || null;
  const riskPrev = risks[0] || null;
  const trend = riskNow && riskPrev ? +(riskNow.index - riskPrev.index).toFixed(1) : null;

  const highlights = [];
  if (closest) highlights.push(`Closest approach: ${closest.missKm} km (${closest.aName} vs ${closest.bName}${closest.pc ? `, Pc ${closest.pcText}` : ""})`);
  if (man.length) highlights.push(`${man.length} maneuver${man.length > 1 ? "s" : ""} detected across the fleet`);
  if (anom.length) highlights.push(`${anom.length} pattern-of-life anomal${anom.length > 1 ? "ies" : "y"} flagged`);
  if (trend !== null) highlights.push(`Fleet Risk Index ${trend >= 0 ? "up" : "down"} ${Math.abs(trend)} points week-over-week`);
  if (!highlights.length) highlights.push("Quiet week — no significant events archived for this fleet.");

  const md = [
    `# Weekly Fleet Intelligence — ${orgName || org}`,
    `Period: ${new Date(weekAgo).toUTCString().slice(0, 16)} → ${new Date().toUTCString().slice(0, 16)}`,
    ``,
    `## Highlights`,
    ...highlights.map(h => `- ${h}`),
    ``,
    `## Numbers`,
    `- Conjunction events archived: ${conj.length}`,
    `- Maneuvers detected: ${man.length}`,
    `- Anomalies flagged: ${anom.length}`,
    riskNow ? `- Current Fleet Risk Index: ${riskNow.index} (grade ${riskNow.grade})` : `- Fleet Risk Index: accruing`,
    ``,
    `*Generated by OrbitIQ from its live detection archive. Screening-grade intelligence on public orbital data.*`
  ].join("\n");

  return {
    org, period: { from: new Date(weekAgo).toISOString(), to: new Date().toISOString() },
    highlights,
    counts: { conjunctions: conj.length, maneuvers: man.length, anomalies: anom.length },
    risk: { current: riskNow, weekAgo: riskPrev, trend },
    closestApproach: closest,
    markdown: md
  };
}
