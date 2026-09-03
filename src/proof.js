// ============================================================
// The Proof of Diligence report.
//
// ── What this is for ────────────────────────────────────────
// This is the artefact that leaves the building. An operator emails it to an
// underwriter during renewal, attaches it to a regulatory filing, or produces
// it in a liability discussion after an on-orbit event. Everything else in
// OrbitIQ exists to make this document true.
//
// ── Why it is a single self-contained file ──────────────────
// A report that requires a login to read is worthless in the situations it
// exists for. The reader is a claims adjuster or a licensing officer with no
// account, months or years later, possibly after this service no longer
// exists. So: one HTML file, no external assets, no scripts required to read
// it, and every number visible as text.
//
// ── Why it tells the reader how to distrust it ──────────────
// The report's value is that a sceptical third party can check it WITHOUT
// trusting the vendor. So it carries the ledger tip, the row hashes, the
// public verification endpoint, and the external witness log, plus plain
// instructions. A document that simply asserted "verified" would be worth
// exactly as much as our word, which is the thing the customer is trying not
// to have to rely on.
//
// ── What it must never do ───────────────────────────────────
// Claim compliance, grade the operator, or imply that an absent decision means
// negligence. It reports what is recorded and is explicit about what that does
// and does not establish. Overclaiming here would be worse than useless: it
// would be a document that fails under exactly the scrutiny it was made for.
// ============================================================
import crypto from "node:crypto";
import * as ledger from "./ledger.js";
import * as decisions from "./decisions.js";
import * as compliance from "./compliance.js";

const esc = s => String(s ?? "").replace(/[&<>"']/g, c =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const fmtPc = p => {
  if (p == null || !Number.isFinite(Number(p))) return "—";
  const n = Number(p);
  if (n <= 0) return "0";
  return n < 1e-8 ? "&lt; 1e-8" : n.toExponential(1);
};
const fmtT = t => t ? String(t).replace("T", " ").replace(/\.\d+Z$/, "Z") : "—";

/**
 * Assemble the underlying data. Kept separate from rendering so the same
 * material can be served as JSON to a customer's own tooling.
 */
export function build({ org = null, ws = null, since, until, thresholdPc = null, operatorName = null } = {}) {
  const chain = ledger.verify();
  const seals = ledger.seals();
  const anchor = ledger.anchor();

  const conj = (ledger.query({ type: "conjunction", org, since, until, limit: 5000 }).events || []);
  const above = thresholdPc == null
    ? conj
    : conj.filter(c => Number.isFinite(Number(c.pc)) && Number(c.pc) >= Number(thresholdPc));

  const decIndex = decisions.byWarning({ ws, org, since, until, limit: 5000 });

  // Pair each qualifying warning with the decision that answers it. Sorted by
  // probability descending: the reader's first question is "what was the worst
  // thing you were told about, and what did you do".
  const rows = above
    .map(c => ({ warning: c, responses: decIndex.get(c.seq) || [] }))
    .sort((a, b) => (Number(b.warning.pc) || 0) - (Number(a.warning.pc) || 0));

  const counts = {};
  for (const t of ["conjunction", "decision", "maneuver", "reentry", "manoeuvre-screen"]) {
    counts[t] = (ledger.query({ type: t, org, since, until, limit: 5000 }).events || []).length;
  }

  const summary = decisions.summary({ ws, org, since, until, thresholdPc });
  const cov = compliance.coverage({ counts, thresholdPc });

  // A digest over the exact material presented, so this document can be
  // referred to later and shown to be the same one.
  const digest = crypto.createHash("sha256").update(
    rows.map(r => [r.warning.seq, r.warning.h, r.responses.map(d => d.decidedAt).join(",")].join("|")).join("\n")
  ).digest("hex").slice(0, 32);

  return {
    operator: operatorName || org || ws || "Unnamed operator",
    org, ws,
    window: { since: since || null, until: until || null },
    thresholdPc: thresholdPc == null ? null : Number(thresholdPc),
    generatedAt: new Date().toISOString(),
    chain: {
      ok: chain.ok, tipSeq: chain.tipSeq, tipHash: chain.tipHash,
      verified: chain.verified, unchained: chain.unchained, reason: chain.reason || null
    },
    seals: seals.slice(-3),
    anchor,
    counts, summary, rows,
    compliance: cov,
    reportDigest: digest
  };
}

/** Render the report as a standalone HTML document. */
export function render(d) {
  const t = d.thresholdPc;
  const chainBad = !d.chain.ok;

  const rowsHtml = d.rows.length ? d.rows.map(({ warning: w, responses }) => {
    const top = responses[0];
    const superseded = responses.length > 1
      ? `<div class="sup">${responses.length - 1} earlier decision${responses.length > 2 ? "s" : ""} superseded</div>` : "";
    return `<tr>
      <td class="mono">#${esc(w.seq)}</td>
      <td>${esc(w.aName || w.aId)} <span class="dim">vs</span> ${esc(w.bName || w.bId)}</td>
      <td class="num">${esc(w.missKm ?? "—")}</td>
      <td class="num">${fmtPc(w.pc)}</td>
      <td class="mono dim">${esc((w.pcModel || "pre-v2").slice(0, 16))}</td>
      <td>${fmtT(w.tca)}</td>
      <td>${top
        ? `<span class="d d-${esc(top.decision)}">${esc(top.decision.replace(/_/g, " "))}</span>${superseded}`
        : `<span class="d d-none">no decision recorded</span>`}</td>
      <td class="num">${top && top.responseMinutes != null ? esc(top.responseMinutes) + " min" : "—"}</td>
      <td class="mono dim">${esc((w.h || "").slice(0, 12))}</td>
    </tr>${top && top.rationale ? `<tr class="why"><td></td><td colspan="8"><b>Rationale:</b> ${esc(top.rationale)}${
      top.manoeuvre ? ` <span class="dim">· Δv ${esc(top.manoeuvre.deltaVms)} m/s${
        top.manoeuvre.propellantKg != null ? `, ${esc(top.manoeuvre.propellantKg)} kg` : ""}</span>` : ""}</td></tr>` : ""}`;
  }).join("") : `<tr><td colspan="9" class="empty">No conjunctions above the stated threshold in this window.</td></tr>`;

  const covHtml = d.compliance.frameworks.map(f => `
    <div class="fw">
      <h3>${esc(f.name)} <span class="cite">${esc(f.citation)}</span></h3>
      <div class="dim jur">${esc(f.jurisdiction)}</div>
      <table class="ob">
        <thead><tr><th>Obligation</th><th>What this archive can support</th><th>Status</th></tr></thead>
        <tbody>${f.obligations.map(o => `
          <tr>
            <td><b>${esc(o.ref)}</b><div class="dim">${esc(o.text)}</div></td>
            <td class="dim">${esc(o.why)}</td>
            <td><span class="st st-${esc(o.status)}">${esc(o.status.replace(/-/g, " "))}</span></td>
          </tr>`).join("")}
        </tbody>
      </table>
    </div>`).join("");

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>Proof of Diligence — ${esc(d.operator)}</title>
<meta name="robots" content="noindex">
<style>
  :root{--ink:#12181f;--dim:#5b6b7d;--line:#dde4ec;--bg:#fff;--accent:#0b5fa5}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink);
       font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif}
  .wrap{max-width:1080px;margin:0 auto;padding:40px 28px 80px}
  h1{font-size:24px;margin:0 0 4px;letter-spacing:-.01em}
  h2{font-size:16px;margin:34px 0 10px;padding-bottom:6px;border-bottom:1px solid var(--line)}
  h3{font-size:14px;margin:18px 0 4px}
  .sub{color:var(--dim);margin:0 0 22px}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:14px;margin:18px 0}
  .kpi{border:1px solid var(--line);border-radius:8px;padding:12px 14px}
  .kpi .v{font-size:21px;font-weight:600;font-variant-numeric:tabular-nums}
  .kpi .k{color:var(--dim);font-size:11.5px;text-transform:uppercase;letter-spacing:.05em}
  table{width:100%;border-collapse:collapse;font-size:13px}
  th{text-align:left;color:var(--dim);font-weight:600;font-size:11.5px;text-transform:uppercase;
     letter-spacing:.04em;padding:8px 8px;border-bottom:1px solid var(--line)}
  td{padding:8px;border-bottom:1px solid #f0f4f8;vertical-align:top}
  td.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
  .mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}
  .dim{color:var(--dim)}
  tr.why td{border-bottom:1px solid #f0f4f8;background:#fafcfe;font-size:12.5px}
  .sup{font-size:11px;color:var(--dim);margin-top:2px}
  .empty{text-align:center;color:var(--dim);padding:22px}
  .d{display:inline-block;padding:2px 8px;border-radius:99px;font-size:11.5px;font-weight:600;white-space:nowrap}
  .d-manoeuvre_executed{background:#e6f4ea;color:#186a3b}
  .d-manoeuvre_planned{background:#e8f0fe;color:#174ea6}
  .d-risk_accepted{background:#fef7e0;color:#8a6116}
  .d-no_action_required{background:#f1f3f4;color:#3c4043}
  .d-monitoring,.d-acknowledged{background:#f1f3f4;color:#3c4043}
  .d-none{background:#fce8e6;color:#a50e0e}
  .st{display:inline-block;padding:2px 8px;border-radius:99px;font-size:11px;font-weight:600;white-space:nowrap}
  .st-evidence-held{background:#e6f4ea;color:#186a3b}
  .st-evidence-partial{background:#fef7e0;color:#8a6116}
  .st-evidence-absent{background:#fce8e6;color:#a50e0e}
  .st-not-evidenceable{background:#f1f3f4;color:#5f6368}
  .note{border-left:3px solid var(--accent);background:#f5f9fd;padding:12px 14px;margin:16px 0;font-size:13px}
  .warn{border-left-color:#c5221f;background:#fdf3f2}
  .fw{margin:18px 0 26px}
  .cite{font-weight:400;color:var(--dim);font-size:12px}
  .jur{font-size:12px;margin-bottom:6px}
  .verify{background:#f7f9fb;border:1px solid var(--line);border-radius:8px;padding:16px 18px;margin:16px 0}
  .verify ol{margin:8px 0 0 18px;padding:0}
  .verify li{margin:6px 0}
  code{background:#eef2f6;padding:1px 5px;border-radius:4px;font-size:12px}
  footer{margin-top:44px;padding-top:16px;border-top:1px solid var(--line);color:var(--dim);font-size:12px}
  @media print{.wrap{padding:0}body{font-size:11.5px}}
</style></head><body><div class="wrap">

<h1>Proof of Diligence</h1>
<p class="sub">${esc(d.operator)} · ${fmtT(d.window.since)} to ${fmtT(d.window.until)}
 · generated ${fmtT(d.generatedAt)}</p>

${chainBad ? `<div class="note warn"><b>Archive integrity check FAILED at generation time.</b>
  ${esc(d.chain.reason || "The hash chain did not reconcile.")} This document is being shown with the
  failure stated rather than withheld. Do not rely on the rows below until the archive verifies.</div>` : ""}

<div class="grid">
  <div class="kpi"><div class="k">Conjunctions screened</div><div class="v">${esc(d.summary.conjunctionsScreened)}</div></div>
  <div class="kpi"><div class="k">Above threshold</div><div class="v">${esc(d.summary.conjunctionsAboveThreshold)}</div></div>
  <div class="kpi"><div class="k">Decisions recorded</div><div class="v">${esc(d.summary.decisionsRecorded)}</div></div>
  <div class="kpi"><div class="k">Manoeuvres executed</div><div class="v">${esc(d.summary.manoeuvresExecuted)}</div></div>
  <div class="kpi"><div class="k">Median response</div><div class="v">${d.summary.medianResponseMinutes ?? "—"}<span style="font-size:13px"> min</span></div></div>
  <div class="kpi"><div class="k">Archive rows verified</div><div class="v">${esc(d.chain.verified)}</div></div>
</div>

<div class="note">
  <b>Threshold in force:</b> ${t == null
    ? "none recorded. Debris-mitigation regimes generally set a per-mission tolerable probability rather than an industry constant, so this report cannot rank events against a policy without one."
    : `probability of collision ≥ ${esc(t)}. This is the operator&rsquo;s own recorded mission threshold, not an industry standard.`}
</div>

<h2>Warnings and responses</h2>
<table>
  <thead><tr>
    <th>Row</th><th>Conjunction</th><th>Miss (km)</th><th>P<sub>c</sub></th><th>Model</th>
    <th>Closest approach</th><th>Recorded decision</th><th>Response</th><th>Row hash</th>
  </tr></thead>
  <tbody>${rowsHtml}</tbody>
</table>

${d.summary.unansweredAboveThreshold ? `<div class="note">
  <b>${esc(d.summary.unansweredAboveThreshold)} warning(s) above threshold have no decision recorded in this system.</b>
  ${esc(d.summary.unansweredNote || "")}</div>` : ""}

<h2>What this archive can and cannot evidence</h2>
${covHtml}
<div class="note warn">${esc(d.compliance.limits)}</div>

<h2>Verify this document without trusting us</h2>
<div class="verify">
  <div>Archive state at generation: chain tip <code>#${esc(d.chain.tipSeq)}</code>,
       hash <code class="mono">${esc(d.chain.tipHash)}</code>.
       Report digest <code class="mono">${esc(d.reportDigest)}</code>.</div>
  <ol>
    <li><b>If the operator gave you a grant token</b>, open
        <code>https://orbit.mnbresearch.com/verify.html</code>, paste the token, and enter the digest above.
        It recomputes the digest from the operator&rsquo;s own archived rows and tells you whether this
        document describes them. Nothing on that page can alter what the operator recorded, and no account
        is created for you.</li>
    <li>Fetch <code>https://orbit.mnbresearch.com/api/v1/archive/verify</code>. It is public and needs no account.
        It walks the whole chain and names the first row that does not reconcile.</li>
    <li>Compare the tip hash above against the external witness log at
        <code>github.com/mnbresearch/orbitiq</code>, branch <code>witness</code>. An hourly GitHub Actions run
        records what the public endpoint said, and the repository owner cannot edit the log of a run that
        already happened.</li>
    <li>Each row above carries its own hash. Editing any warning or decision after the fact breaks the chain
        from that row onward, and step 1 will name it.</li>
    <li>A seal published before a disputed date is independent evidence of what the archive held on that date.
        Most recent seals: ${d.seals.length
          ? d.seals.map(s => `<code class="mono">#${esc(s.seq)} ${esc(String(s.hash).slice(0, 10))} ${fmtT(s.at)}</code>`).join(", ")
          : "none yet"}.</li>
  </ol>
  <div class="dim" style="margin-top:10px">
    Scope of the guarantee: this is tamper-<b>evident</b>, not tamper-proof, with GitHub acting as the notary.
    It shows a given hash was publicly observable at a given time. It is not a cryptographic signature, does
    not attest who wrote a row, and is exactly as strong as trusting GitHub&rsquo;s timestamps.
  </div>
</div>

<footer>
  <b>What this document establishes.</b> That the conjunctions listed were screened and archived at the stated
  times, and that the decisions shown were recorded against them and have not been altered since.<br>
  <b>What it does not establish.</b> Compliance with any regulation, the correctness of any decision, or that
  no action was taken where no record appears — a decision taken outside this system leaves no trace in it.
  Probabilities are computed from public element sets, which carry no covariance; the covariance is modelled
  and every row states which model produced it.<br><br>
  OrbitIQ · MNB Research · generated ${fmtT(d.generatedAt)} · digest ${esc(d.reportDigest)}
</footer>
</div></body></html>`;
}

export const report = (opts) => render(build(opts));
