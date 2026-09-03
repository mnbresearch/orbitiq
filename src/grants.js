// ============================================================
// Grants — how an operator lets a verifier read their evidence.
//
// ── The transaction this enables ────────────────────────────
// An underwriter at renewal, a regulator at licence review, or a prime
// assessing a supplier needs to check what an operator was told and what they
// did about it. Today that happens by the operator emailing a PDF, which the
// reader has no way to test.
//
// A grant replaces that with something checkable: the operator authorises a
// named verifier to read a specific slice of their archive, for a specific
// window, for a specific period. The verifier can then recompute the report's
// digest from the underlying rows rather than taking the document on trust.
//
// ── Read-only by construction, and why that matters to BOTH ─
// A grant confers read access and nothing else. There is no code path by which
// a verifier can append, amend or delete an operator's rows — the grant is
// consulted only by read routes, and every write route keys off the
// workspace's own identity.
//
// That is a selling point in both directions, which is unusual and worth
// stating plainly to each side:
//   - to the operator: your insurer cannot touch your record, so granting
//     access costs you nothing but visibility;
//   - to the verifier: the operator cannot edit the record either, because the
//     chain would break and your own verification would catch it.
// Neither party has to trust the other, which is the only arrangement that
// actually gets signed.
//
// ── Why grants live in the ledger ───────────────────────────
// A grant is itself evidence. "You never gave me access" and "I revoked that
// months ago" are both disputes that a mutable grants table cannot settle.
// Appending them to the same hash-chained archive means the grant, its scope
// and its revocation all carry timestamps neither side can move afterwards.
//
// Revocation is an append, never a delete. Deleting a grant would erase the
// fact that access once existed, which is exactly the fact most likely to be
// disputed later.
//
// ── What a grant deliberately cannot do ─────────────────────
// It cannot be open-ended. Every grant has an expiry, because an access right
// that never lapses becomes an access right nobody remembers issuing. The
// maximum is bounded here rather than left to the caller.
// ============================================================
import crypto from "node:crypto";
import * as ledger from "./ledger.js";
import * as audit from "./audit.js";

/**
 * Longest a single grant may run before it must be renewed.
 *
 * Two years covers an insurance renewal cycle plus the tail of a claim, which
 * is the longest legitimate need anyone has articulated. Longer than that and
 * the operator has effectively given away perpetual access to a rolling
 * archive, which is not what they think they are agreeing to.
 */
export const MAX_GRANT_DAYS = 730;

/** What a verifier may read. Deliberately short; each entry is a real need. */
export const SCOPES = {
  conjunctions: "Screened conjunctions and their probabilities.",
  decisions:    "Decisions recorded against those warnings, including rationale.",
  compliance:   "Framework coverage: what the archive can and cannot evidence.",
  audit:        "Who generated reports over this evidence, and when."
};

const nowIso = () => new Date().toISOString();
const newToken = () => "vg_" + crypto.randomBytes(24).toString("base64url");

/** Stable id so a grant can be referenced in a contract or an email. */
const grantId = () => "grant_" + crypto.randomBytes(8).toString("hex");

/**
 * Issue a grant. Called by the OPERATOR, never by the verifier — the party
 * whose evidence it is has to be the one who authorises reading it.
 *
 * Returns the bearer token exactly once. It is stored only as a hash, so a
 * later compromise of the archive does not hand out working access; and since
 * the archive is public on the backup branch, storing the raw token would be
 * publishing it.
 */
export function issue(wsId, {
  verifierName,
  verifierEmail = null,
  scopes = ["conjunctions", "decisions", "compliance"],
  windowFrom = null,
  windowTo = null,
  days = 365,
  org = null,
  actor = null
} = {}) {
  if (!wsId) return { ok: false, error: "workspace required" };
  if (!verifierName || String(verifierName).trim().length < 2) {
    return { ok: false, error: "verifierName required — a grant to an unnamed party is not auditable" };
  }

  const bad = scopes.filter(s => !SCOPES[s]);
  if (bad.length) return { ok: false, error: `unknown scope(s): ${bad.join(", ")}` };
  if (!scopes.length) return { ok: false, error: "a grant with no scopes conveys nothing" };

  const d = Math.min(Math.max(Number(days) || 365, 1), MAX_GRANT_DAYS);
  const token = newToken();
  const id = grantId();

  ledger.append("grant", [{
    org,
    ws: wsId,
    grantId: id,
    verifierName: String(verifierName).trim(),
    verifierEmail: verifierEmail ? String(verifierEmail).trim().toLowerCase() : null,
    scopes,
    // The evidence window the verifier may see. Null means "everything in the
    // archive for this operator", which is a legitimate choice for a claim
    // investigation but should be a deliberate one.
    windowFrom: windowFrom || null,
    windowTo: windowTo || null,
    issuedAt: nowIso(),
    expiresAt: new Date(Date.now() + d * 86400000).toISOString(),
    // Hash only. See the note above: the archive is published.
    tokenHash: crypto.createHash("sha256").update(token).digest("hex"),
    issuedBy: actor ? { id: actor.id || null, email: actor.email || null } : null
  }]);

  const tip = ledger.verify();
  return {
    ok: true,
    grantId: id,
    token,
    tokenShownOnce: "Store this now. Only a hash is kept, so it cannot be shown again — "
                  + "the archive is published, and storing the token would publish it too.",
    expiresAt: new Date(Date.now() + d * 86400000).toISOString(),
    scopes,
    ledgerSeq: tip.tipSeq
  };
}

/** Revoke by appending, never by deleting. */
export function revoke(wsId, id, { actor = null, reason = null } = {}) {
  const g = find(id);
  if (!g) return { ok: false, error: `no grant ${id}` };
  if (g.ws !== wsId) return { ok: false, error: "that grant belongs to another workspace" };
  if (isRevoked(id)) return { ok: false, error: "already revoked" };

  ledger.append("grant-revoked", [{
    org: g.org || null, ws: wsId, grantId: id,
    verifierName: g.verifierName,
    revokedAt: nowIso(),
    reason: reason ? String(reason).slice(0, 500) : null,
    revokedBy: actor ? { id: actor.id || null, email: actor.email || null } : null
  }]);
  return { ok: true, grantId: id, revokedAt: nowIso() };
}

const allGrants = () => ledger.query({ type: "grant", limit: 2000 }).events || [];
const allRevocations = () => ledger.query({ type: "grant-revoked", limit: 2000 }).events || [];

export const find = id => allGrants().find(g => g.grantId === id) || null;
export const isRevoked = id => allRevocations().some(r => r.grantId === id);

/**
 * Resolve a bearer token to the grant it represents.
 *
 * Returns a reason on failure rather than a bare null, because "expired" and
 * "revoked" and "never existed" are different conversations and a verifier
 * chasing access deserves to know which one they are having.
 */
export function resolve(token) {
  if (!token) return { ok: false, error: "no token" };
  const h = crypto.createHash("sha256").update(String(token)).digest("hex");
  const g = allGrants().find(x => x.tokenHash === h);
  if (!g) return { ok: false, error: "token does not match any grant" };
  if (isRevoked(g.grantId)) {
    const r = allRevocations().find(x => x.grantId === g.grantId);
    return { ok: false, error: `grant revoked ${r?.revokedAt || ""}`.trim(), grantId: g.grantId };
  }
  if (new Date(g.expiresAt).getTime() < Date.now()) {
    return { ok: false, error: `grant expired ${g.expiresAt}`, grantId: g.grantId };
  }
  return { ok: true, grant: g };
}

/** Grants an operator has issued, with live status. */
export function listForWorkspace(wsId) {
  const revoked = new Set(allRevocations().map(r => r.grantId));
  return allGrants()
    .filter(g => g.ws === wsId)
    .map(({ tokenHash, ...g }) => ({
      ...g,
      status: revoked.has(g.grantId) ? "revoked"
            : new Date(g.expiresAt).getTime() < Date.now() ? "expired" : "active"
    }));
}

/** Everything a given verifier can currently see, across operators. */
export function portfolioFor(verifierName) {
  const key = String(verifierName || "").trim().toLowerCase();
  const revoked = new Set(allRevocations().map(r => r.grantId));
  return allGrants()
    .filter(g => String(g.verifierName).toLowerCase() === key)
    .filter(g => !revoked.has(g.grantId) && new Date(g.expiresAt).getTime() >= Date.now())
    .map(({ tokenHash, ...g }) => g);
}

/**
 * Independently recompute a report's digest from the granted rows.
 *
 * ── Why this is the whole point of the tier ─────────────────
 * A Proof of Diligence quotes a digest. Anyone can put a digest on a document.
 * The question a verifier actually has is: does that digest correspond to rows
 * that really are in the archive, unaltered, and were they there when the
 * document says they were?
 *
 * This recomputes the digest from the operator's actual rows using the same
 * canonical form the report used. If it matches, the document describes the
 * archive. If it does not, the document has been edited, the archive has been
 * edited, or the parameters differ — and all three are things the verifier
 * needs to know.
 *
 * It deliberately does NOT say "the operator is trustworthy". It says whether
 * two hashes agree.
 */
/**
 * Find the archived record of this system producing a given digest.
 *
 * ── Why this exists ─────────────────────────────────────────
 * A digest is only reproducible over the same window and threshold. Those are
 * printed on the document, but requiring a verifier to retype them exactly
 * before the check works is a trap: the failure mode is a GENUINE document
 * reading as forged, which is the worst possible direction for this product to
 * be wrong in.
 *
 * Every report generation is already audited into the same hash chain, with
 * the window and threshold that produced it — so the parameters can be
 * recovered from the archive instead of from the reader's typing.
 *
 * ── Why this is not circular ────────────────────────────────
 * The operator could generate many reports and hand over a flattering one.
 * That is exactly why the count is returned alongside: every generation is in
 * the chain, so cherry-picking is visible rather than hidden. Recovering the
 * parameters does not ask the verifier to trust the operator — it moves one
 * more thing out of the operator's hands and into the witnessed record.
 */
export function findIssuance({ ws = null, org = null, digest }) {
  if (!digest) return null;
  const history = audit.reportHistory({ ws, org, limit: 1000 });
  const hit = history.find(a => a.detail && a.detail.digest === String(digest));
  if (!hit) return { found: false, issuancesInArchive: history.length };
  const [from, to] = String(hit.detail.window || "..").split("..");
  return {
    found: true,
    issuancesInArchive: history.length,
    ledgerSeq: hit.seq,
    ledgerHash: hit.hash,
    generatedAt: hit.t,
    generatedBy: hit.actor || null,
    window: { from: from || null, to: to || null },
    thresholdPc: hit.detail.thresholdPc ?? null,
    rowCount: hit.detail.rowCount ?? null
  };
}

export function verifyReport({ grant, claimedDigest, since = null, until = null, thresholdPc = null }) {
  const org = grant.org || null;

  // Parameters, in order of authority: what the verifier explicitly asked for,
  // then what the archive says produced this digest, then the grant's own
  // window. The middle step is what makes a genuine document verify on the
  // first click instead of after three attempts at retyping a date range.
  const issuance = findIssuance({ ws: grant.ws, digest: claimedDigest });
  const recovered = issuance && issuance.found && since == null && until == null && thresholdPc == null;

  const from = since || (recovered ? issuance.window.from : null) || grant.windowFrom || null;
  const to = until || (recovered ? issuance.window.to : null) || grant.windowTo || null;
  if (recovered && thresholdPc == null) thresholdPc = issuance.thresholdPc;

  const conj = (ledger.query({ type: "conjunction", org, since: from, until: to, limit: 5000 }).events || []);
  const above = thresholdPc == null
    ? conj
    : conj.filter(c => Number.isFinite(Number(c.pc)) && Number(c.pc) >= Number(thresholdPc));

  const decs = (ledger.query({ type: "decision", since: from, until: to, limit: 5000 }).events || [])
    .filter(d => d.ws === grant.ws);
  const byWarning = new Map();
  for (const d of decs) {
    if (!byWarning.has(d.warningSeq)) byWarning.set(d.warningSeq, []);
    byWarning.get(d.warningSeq).push(d);
  }
  for (const arr of byWarning.values()) {
    arr.sort((a, b) => (b.decidedAt || "").localeCompare(a.decidedAt || ""));
  }

  // Same canonical form proof.build() uses. If that changes, this must change
  // with it, which is why both are pinned by a test.
  const rows = above
    .map(c => ({ warning: c, responses: byWarning.get(c.seq) || [] }))
    .sort((a, b) => (Number(b.warning.pc) || 0) - (Number(a.warning.pc) || 0));

  const recomputed = crypto.createHash("sha256").update(
    rows.map(r => [r.warning.seq, r.warning.h, r.responses.map(d => d.decidedAt).join(",")].join("|")).join("\n")
  ).digest("hex").slice(0, 32);

  const chain = ledger.verify();

  return {
    matches: claimedDigest ? recomputed === String(claimedDigest) : null,
    recomputedDigest: recomputed,
    claimedDigest: claimedDigest || null,
    rowsConsidered: rows.length,
    window: { from, to },
    thresholdPc: thresholdPc == null ? null : Number(thresholdPc),
    chain: { ok: chain.ok, tipSeq: chain.tipSeq, tipHash: chain.tipHash, verified: chain.verified },

    // Where the parameters came from. A verifier should be able to tell the
    // difference between "the archive told me the window" and "I typed the
    // window in myself", because only the first is evidence.
    parameterSource: recovered ? "recovered-from-archive"
                   : (since || until || thresholdPc != null) ? "supplied-by-verifier"
                   : "grant-window",
    issuance: !claimedDigest ? null
      : issuance && issuance.found ? {
          found: true,
          generatedAt: issuance.generatedAt,
          generatedBy: issuance.generatedBy,
          ledgerSeq: issuance.ledgerSeq,
          ledgerHash: issuance.ledgerHash,
          window: issuance.window,
          thresholdPc: issuance.thresholdPc,
          rowCount: issuance.rowCount,
          reportsGeneratedInArchive: issuance.issuancesInArchive,
          means: "The archive contains its own hash-chained record of producing this digest, at "
               + "the stated time and over the stated window. The parameters used below were taken "
               + "from that record rather than from the document, so a genuine document verifies "
               + "without anyone retyping a date range. "
               + `${issuance.issuancesInArchive} report generation(s) are recorded for this operator `
               + "in total — every one is in the chain, so choosing a flattering window is visible "
               + "rather than hidden."
        }
      : {
          found: false,
          reportsGeneratedInArchive: issuance ? issuance.issuancesInArchive : 0,
          means: "No record of this system producing that digest appears in the archive for this "
               + "operator. The ordinary explanation is a document generated before this record "
               + "was kept, or by a different tool. It is also what an invented digest would look "
               + "like. The check below used the window supplied, or the grant's own window."
        },
    means: claimedDigest
      ? (recomputed === String(claimedDigest)
          ? "The document describes exactly these archived rows, and the chain over them verifies. "
          + "That establishes the rows have not been altered since they were written. It does not "
          + "establish that the decisions recorded were correct, or that no action was taken where "
          + "no record appears."
          : "The digest does NOT match what the archive holds for this operator over this window. "
          + "Before concluding anything, check that the window and threshold match the ones printed "
          + "on the document — a report over a different period is legitimately a different digest.")
      : "No digest supplied, so this is a recomputation only. Compare it against the digest printed "
      + "on the document you were given.",
    limits: "Verification is against a public, hash-chained archive externally witnessed by hourly "
          + "GitHub Actions runs. It is tamper-evident, not tamper-proof: it shows a hash was "
          + "publicly observable at a time, with GitHub as the notary. It is not a signature and "
          + "does not attest authorship."
  };
}

/**
 * What was knowable about an object on a given date.
 *
 * ── Why only this archive can answer it ─────────────────────
 * After an on-orbit event the question is never "what do we know now" — it is
 * "what could the operator reasonably have known at the time". Today that is
 * answered by re-propagating current element sets backwards, which tells you
 * what was TRUE, not what was KNOWN. Those differ, and the difference is
 * usually the whole argument.
 *
 * A contemporaneous archive answers the second question directly, and cannot
 * be reconstructed after the fact by anyone, including us.
 */
export function knowableOn({ org = null, ws = null, at, objectId = null, windowHours = 72 }) {
  const t = new Date(at).getTime();
  if (!Number.isFinite(t)) return { error: "`at` must be a valid date" };

  const from = new Date(t - windowHours * 3600e3).toISOString();
  const to = new Date(t).toISOString();

  let conj = (ledger.query({ type: "conjunction", org, since: from, until: to, limit: 5000 }).events || []);
  if (objectId != null) {
    const k = String(objectId);
    conj = conj.filter(c => String(c.aId) === k || String(c.bId) === k);
  }

  const decs = (ledger.query({ type: "decision", since: from, until: to, limit: 5000 }).events || [])
    .filter(d => !ws || d.ws === ws);

  return {
    asOf: to,
    lookbackHours: windowHours,
    objectId: objectId == null ? null : String(objectId),
    warningsHeld: conj.length,
    warnings: conj.slice(0, 200).map(c => ({
      seq: c.seq, hash: c.h, archivedAt: c.t, tca: c.tca,
      a: c.aName, b: c.bName, missKm: c.missKm, pc: c.pc,
      pcModel: c.pcModel || "pre-v2", risk: c.risk
    })),
    decisionsTaken: decs.length,
    decisions: decs.slice(0, 200).map(d => ({
      seq: d.seq, decidedAt: d.decidedAt, decision: d.decision,
      warningSeq: d.warningSeq, rationale: d.rationale
    })),
    means: "Rows archived at or before the stated moment, with the archive's own timestamps. "
         + "This is what the record held at that time — not a reconstruction from today's "
         + "element sets, which would show what was true rather than what was known.",
    limits: "Absence of a row means the archive held nothing, not that nothing was knowable. "
          + "Screening coverage, catalogue freshness and the mission threshold in force all "
          + "bound what appears here."
  };
}

export const scopeCatalogue = () => Object.entries(SCOPES).map(([scope, means]) => ({ scope, means }));
