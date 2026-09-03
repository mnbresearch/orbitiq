// ============================================================
// The decision log — what the operator DID about each warning.
//
// ── Why this is the most important module in the product ────
// Until now the archive recorded one half of the story: what OrbitIQ saw.
// That is a feed. Anyone with a TLE parser can produce a feed, and a feed is
// worth roughly what it costs to compute.
//
// The half that has value is the other one: given that you were told, what did
// you do, when, and on what basis? That record is what an underwriter asks for
// after a loss, what a regulator asks for during a licence review, and what a
// counterparty asks for in a liability dispute. Nobody can reconstruct it
// later — not us, not a competitor, not the operator themselves — because it
// is a record of decisions, and decisions leave no trace in the sky.
//
// ── Why decisions cite the warning by hash ──────────────────
// A decision that merely references "conjunction with object 12345" proves
// nothing: the underlying warning could have been edited afterwards to match
// whatever the operator wishes they had been told. So every decision embeds
// the ledger sequence number AND the row hash of the warning it responds to.
// If either the warning or the decision is altered later, the chain breaks and
// verification names the row. The evidence is only as good as that binding.
//
// ── What this deliberately does NOT do ──────────────────────
// It does not judge the decision. "Risk accepted" is a legitimate, common and
// often correct outcome — most conjunctions warrant no manoeuvre, and burning
// propellant on every alert is itself a failure mode. The product's job is to
// record what was decided and on what basis, not to grade it. Anything that
// scored operators would push them toward manoeuvring for the record rather
// than for the spacecraft, which is worse for orbital safety, not better.
// ============================================================
import crypto from "node:crypto";
import * as ledger from "./ledger.js";

/**
 * The outcomes an operator can record.
 *
 * Deliberately small and mutually exclusive. A long taxonomy looks thorough
 * and produces inconsistent data, because two engineers will classify the same
 * event differently. These map to what actually happens on console.
 */
export const DECISIONS = {
  acknowledged:       "Warning seen and triaged; no action decided yet.",
  monitoring:         "Under active watch, awaiting a better element set before deciding.",
  no_action_required: "Assessed as not warranting action against the mission's policy threshold.",
  risk_accepted:      "Above threshold, but manoeuvre judged worse than the risk. Rationale required.",
  manoeuvre_planned:  "Avoidance manoeuvre designed and scheduled.",
  manoeuvre_executed: "Avoidance manoeuvre performed.",
  manoeuvre_cancelled:"Planned manoeuvre stood down, typically after the risk fell.",
  superseded:         "Overtaken by a later assessment of the same conjunction."
};

/** Outcomes that a reviewer will expect to see justified in writing. */
const REQUIRES_RATIONALE = new Set(["risk_accepted", "manoeuvre_cancelled"]);

/** Outcomes that assert a physical action was taken on the spacecraft. */
const ASSERTS_ACTION = new Set(["manoeuvre_planned", "manoeuvre_executed"]);

const nowIso = () => new Date().toISOString();

/**
 * Find the archived conjunction a decision is about.
 *
 * Looked up by ledger sequence rather than by object pair, because a pair can
 * conjunct repeatedly and "the one at seq 18422" is unambiguous where "the
 * Starlink one" is not.
 */
export function findWarning(seq) {
  const n = Number(seq);
  if (!Number.isFinite(n)) return null;
  const all = ledger.allEvents();
  // Reverse scan: decisions are almost always about recent warnings.
  for (let i = all.length - 1; i >= 0; i--) {
    if (all[i].seq === n) return all[i];
  }
  return null;
}

/**
 * Record a decision against an archived warning.
 *
 * Returns { ok: false, error } rather than throwing, because every rejection
 * here is a user-correctable mistake and the caller is an HTTP route.
 */
export function record(wsId, {
  warningSeq,
  decision,
  rationale = "",
  actor = null,
  policyThresholdPc = null,
  manoeuvre = null,        // { deltaVms, burnAtIso, propellantKg } when applicable
  org = null
} = {}) {

  if (!wsId) return { ok: false, error: "workspace required" };
  if (!DECISIONS[decision]) {
    return { ok: false, error: `decision must be one of: ${Object.keys(DECISIONS).join(", ")}` };
  }

  const w = findWarning(warningSeq);
  if (!w) {
    return { ok: false, error: `no archived row at sequence ${warningSeq}` };
  }
  if (w.type !== "conjunction") {
    return { ok: false, error: `row ${warningSeq} is a ${w.type}, not a conjunction` };
  }
  if (!w.h) {
    // Pre-chain rows exist (the archive predates hashing). A decision against
    // one cannot be bound to anything immutable, so it would be evidence in
    // appearance only. Refuse rather than issue something misleading.
    return {
      ok: false,
      error: `row ${warningSeq} predates the hash chain and cannot be cited as evidence`
    };
  }

  const text = String(rationale || "").trim();
  if (REQUIRES_RATIONALE.has(decision) && text.length < 20) {
    return {
      ok: false,
      error: `"${decision}" requires a written rationale of at least 20 characters — `
           + "this is the field a reviewer will read first"
    };
  }
  if (ASSERTS_ACTION.has(decision) && (!manoeuvre || !Number.isFinite(Number(manoeuvre.deltaVms)))) {
    return {
      ok: false,
      error: `"${decision}" asserts a burn was planned or performed, so it requires `
           + "manoeuvre.deltaVms; recording an action with no parameters is not evidence"
    };
  }

  // ── Timing, which is most of what a reviewer cares about ──
  // Not "did you act" but "how long did it take you". Latency from the moment
  // the warning entered the archive, and the remaining lead time to closest
  // approach at the moment of decision.
  const decidedAt = nowIso();
  const warnedAtMs = new Date(w.t).getTime();
  const decidedMs = new Date(decidedAt).getTime();
  const tcaMs = w.tca ? new Date(w.tca).getTime() : NaN;

  const row = {
    org: org || w.aOrg || null,
    ws: wsId,
    decision,
    rationale: text || null,
    actor: actor ? { id: actor.id || null, email: actor.email || null, name: actor.name || null } : null,

    // ── The binding. This is the load-bearing part. ──
    // Citing both the sequence and the hash means the decision is only valid
    // against that exact warning content. Edit the warning and the chain
    // breaks; edit the decision and the chain breaks.
    warningSeq: w.seq,
    warningHash: w.h,
    warningArchivedAt: w.t,

    // Denormalised for readability in an exported report, so a reviewer does
    // not have to join two files to understand a row. The authoritative values
    // remain in the cited warning.
    subject: { a: w.aName || null, b: w.bName || null, aId: w.aId ?? null, bId: w.bId ?? null },
    tca: w.tca || null,
    missKmAtWarning: w.missKm ?? null,
    pcAtWarning: w.pc ?? null,
    pcModelAtWarning: w.pcModel || null,

    // The threshold in force AT THE TIME. Thresholds are mission-specific and
    // change; a decision judged against today's policy would be judged against
    // the wrong one. ESA's own practice is a per-mission tolerable probability,
    // not an industry constant, so it is recorded per decision.
    policyThresholdPc: Number.isFinite(Number(policyThresholdPc)) ? Number(policyThresholdPc) : null,

    manoeuvre: manoeuvre ? {
      deltaVms: Number(manoeuvre.deltaVms),
      burnAt: manoeuvre.burnAtIso || null,
      propellantKg: Number.isFinite(Number(manoeuvre.propellantKg)) ? Number(manoeuvre.propellantKg) : null
    } : null,

    decidedAt,
    responseMinutes: Number.isFinite(warnedAtMs)
      ? +(((decidedMs - warnedAtMs) / 60000)).toFixed(1) : null,
    leadHoursAtDecision: Number.isFinite(tcaMs)
      ? +(((tcaMs - decidedMs) / 3600000)).toFixed(2) : null
  };

  ledger.append("decision", [row]);

  // Re-read the tip so the caller gets the sequence and hash of the decision
  // itself — which is what a report cites, and what the operator can quote.
  const tip = ledger.verify();
  return { ok: true, decision: row, seq: tip.tipSeq, hash: tip.tipHash };
}

/**
 * Every decision for a workspace (or org) in a window, newest first.
 */
export function list({ ws = null, org = null, since = null, until = null, limit = 500 } = {}) {
  const q = ledger.query({ type: "decision", since, until, limit });
  const rows = (q.events || []).filter(r =>
    (!ws || r.ws === ws) && (!org || r.org === org));
  return { count: rows.length, decisions: rows };
}

/**
 * Decisions indexed by the warning they answer, so a report can show
 * warning → response without an N^2 join.
 */
export function byWarning(opts = {}) {
  const m = new Map();
  for (const d of list({ ...opts, limit: opts.limit || 2000 }).decisions) {
    if (!m.has(d.warningSeq)) m.set(d.warningSeq, []);
    m.get(d.warningSeq).push(d);
  }
  // Newest decision first within each warning; a later one supersedes.
  for (const arr of m.values()) arr.sort((a, b) => (b.decidedAt || "").localeCompare(a.decidedAt || ""));
  return m;
}

/**
 * Operational summary over a window.
 *
 * ── On "unanswered" ─────────────────────────────────────────
 * Warnings above the policy threshold with no recorded decision. This is the
 * number an underwriter will look at first, and it is reported plainly rather
 * than buried, because a product that hides it is not evidence — it is
 * marketing. A high count is not necessarily bad practice; it often means the
 * operator decides outside this system. That distinction belongs to the
 * reader, so the wording avoids implying negligence.
 */
export function summary({ ws = null, org = null, since = null, until = null, thresholdPc = null } = {}) {
  const decisions = list({ ws, org, since, until, limit: 5000 }).decisions;
  const answered = new Set(decisions.map(d => d.warningSeq));

  const conj = (ledger.query({ type: "conjunction", org, since, until, limit: 5000 }).events || []);
  const above = thresholdPc == null
    ? conj
    : conj.filter(c => Number.isFinite(Number(c.pc)) && Number(c.pc) >= Number(thresholdPc));

  const byKind = {};
  for (const d of decisions) byKind[d.decision] = (byKind[d.decision] || 0) + 1;

  const lat = decisions.map(d => d.responseMinutes).filter(Number.isFinite).sort((a, b) => a - b);
  const median = lat.length ? lat[Math.floor(lat.length / 2)] : null;

  const unanswered = above.filter(c => c.h && !answered.has(c.seq));

  return {
    windowFrom: since || null,
    windowTo: until || null,
    thresholdPc: thresholdPc == null ? null : Number(thresholdPc),
    conjunctionsScreened: conj.length,
    conjunctionsAboveThreshold: above.length,
    decisionsRecorded: decisions.length,
    decisionsByKind: byKind,
    medianResponseMinutes: median,
    manoeuvresExecuted: byKind.manoeuvre_executed || 0,
    unansweredAboveThreshold: unanswered.length,
    unansweredNote: unanswered.length
      ? "Warnings above the mission threshold with no decision recorded in this system. "
      + "That may mean the decision was taken elsewhere; it is reported so the reader can ask, "
      + "not as a finding of fault."
      : null,
    caveat: "Counts describe records held in this archive. They are not an audit, and absence "
          + "of a record here is not evidence that no action was taken."
  };
}

/**
 * Stable fingerprint of a decision set, so a report can be quoted and later
 * shown to be the same set. Independent of the ledger's own chain, because a
 * reader may hold only the report.
 */
export function digest(decisions) {
  const canon = decisions
    .map(d => [d.warningSeq, d.warningHash, d.decision, d.decidedAt].join("|"))
    .sort()
    .join("\n");
  return crypto.createHash("sha256").update(canon).digest("hex").slice(0, 32);
}

export const catalogue = () => Object.entries(DECISIONS).map(([k, v]) => ({ decision: k, means: v }));
