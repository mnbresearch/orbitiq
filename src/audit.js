// ============================================================
// Audit trail for evidence-affecting actions.
//
// ── Why this is in the hash chain and not a log file ────────
// A Proof of Diligence report is quoted in insurance and licensing contexts.
// Sooner or later someone will ask "who produced this, when, and over what
// window" — and if the answer lives in a rotating application log on an
// ephemeral disk, there is no answer. So the audit record goes into the same
// append-only, externally witnessed ledger as the evidence it concerns, and
// inherits the same tamper-evidence for free.
//
// ── Why only SOME actions are audited ───────────────────────
// Logging every request into a hash chain would bloat the archive by orders of
// magnitude and make verification slower every day, for no benefit: nobody
// disputes who fetched a satellite list. Audited here are only actions that
// create, alter or export evidence:
//
//   - generating a Proof of Diligence report (what window, what threshold)
//   - recording or superseding a decision
//   - changing the mission policy threshold, because every decision is judged
//     against the threshold in force at the time, so a silent change would
//     retroactively reframe past decisions
//   - exporting the archive
//
// That last one is the subtle one and it is the reason this module exists.
//
// ── What is deliberately not recorded ───────────────────────
// No request bodies, no credentials, no IP addresses. An audit trail that
// accumulates personal data becomes a liability of its own, and none of it is
// needed to answer the question this trail exists to answer.
// ============================================================
import * as ledger from "./ledger.js";

export const ACTIONS = {
  "report.generated":   "A Proof of Diligence report was produced.",
  "decision.recorded":  "An operator decision was recorded against a warning.",
  "policy.threshold":   "The mission collision-probability threshold was changed.",
  "archive.exported":   "Archive contents were exported.",
  "burn.screened":      "A candidate avoidance manoeuvre was screened."
};

/**
 * Record an audited action.
 *
 * Never throws: an audit failure must not take down the operation it is
 * auditing. It is reported in the return value so a caller can surface it,
 * but a report still gets delivered even if the trail write fails.
 */
export function record(action, { ws = null, org = null, actor = null, detail = {} } = {}) {
  if (!ACTIONS[action]) return { ok: false, error: `unknown audit action: ${action}` };
  try {
    ledger.append("access", [{
      org,
      ws,
      action,
      // Identity, minimally. Enough to answer "who", not enough to become a
      // personal-data store in its own right.
      actor: actor ? { id: actor.id || null, email: actor.email || null } : null,
      // Parameters that change what the artefact SAYS. A report over a
      // different window or threshold is a different document, so those are
      // part of the record; anything cosmetic is not.
      detail: {
        window: detail.window || null,
        thresholdPc: detail.thresholdPc ?? null,
        rowCount: detail.rowCount ?? null,
        digest: detail.digest || null,
        target: detail.target || null,
        from: detail.from ?? null,
        to: detail.to ?? null
      },
      at: new Date().toISOString()
    }]);
    return { ok: true };
  } catch (e) {
    console.error("audit write failed:", e.message);
    return { ok: false, error: e.message };
  }
}

/** Audit trail for an org or workspace, newest first. */
export function trail({ ws = null, org = null, since = null, until = null, limit = 300 } = {}) {
  const rows = (ledger.query({ type: "access", since, until, limit }).events || [])
    .filter(r => (!ws || r.ws === ws) && (!org || r.org === org));
  return {
    count: rows.length,
    actions: rows.map(r => ({
      seq: r.seq, hash: r.h, t: r.t, action: r.action,
      means: ACTIONS[r.action] || null,
      actor: r.actor?.email || r.actor?.id || null,
      detail: r.detail || null
    })),
    note: "Audit records are written into the same append-only, hash-chained archive as the "
        + "evidence they concern, so an altered trail breaks verification in the same way an "
        + "altered warning does."
  };
}

/** Who produced reports, and how often — the question a reviewer asks first. */
export function reportHistory({ org = null, ws = null, limit = 100 } = {}) {
  return trail({ org, ws, limit: 1000 }).actions
    .filter(a => a.action === "report.generated")
    .slice(0, limit);
}

export const catalogue = () => Object.entries(ACTIONS).map(([action, means]) => ({ action, means }));
