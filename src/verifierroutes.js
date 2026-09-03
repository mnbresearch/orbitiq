// ============================================================
// Verifier-side routes — the Underwriter tier.
//
// ── Two audiences, deliberately separated ───────────────────
// Everything under /grants is the OPERATOR acting on their own evidence:
// issuing access, listing it, revoking it. It authenticates with the
// workspace API key like the rest of the product.
//
// Everything under /verify is the VERIFIER, authenticating with a grant token
// the operator gave them. That path is mounted separately and never shares a
// handler with an operator route, because the security property being sold
// here is that a verifier cannot write. The cheapest way to guarantee that is
// for there to be no write handler on the verifier path at all — not a flag,
// not a role check, no code.
//
// ── Why the verifier path is not behind requirePlan ─────────
// The verifier does not have a workspace or a plan; the OPERATOR is the
// customer whose tier includes granting access. Gating the read path on the
// verifier's own subscription would mean an underwriter needs an account
// before they can check a document, which defeats the entire point.
// ============================================================
import * as grants from "./grants.js";
import * as coverage from "./coverage.js";

/**
 * Pull a grant token from a header. Headers ONLY.
 *
 * A `?token=` query parameter would be far friendlier — a verifier could paste
 * a link and it would just work. It is also how credentials end up in proxy
 * logs, browser history, referrer headers and the access logs of every CDN in
 * between. A grant is a bearer credential to someone else's evidence, so it
 * travels in a header or not at all.
 */
function tokenFrom(req) {
  const auth = req.get("authorization") || "";
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  return (m && m[1]) || req.get("x-grant-token") || null;
}

/**
 * Resolve a grant, or explain precisely why not.
 *
 * The failure reasons are deliberately specific. An underwriter who cannot
 * open a document at renewal needs to know whether to chase the operator for
 * a new grant or check the token they were sent, and a generic 401 forces a
 * phone call that a sentence would have avoided.
 */
function requireGrant(scope) {
  return (req, res, next) => {
    const r = grants.resolve(tokenFrom(req));
    if (!r.ok) {
      return res.status(401).json({
        error: r.error,
        grantId: r.grantId || null,
        remedy: /revoked|expired/.test(r.error || "")
          ? "Ask the operator to issue a new grant; access rights here are always time-boxed."
          : "Check the token. It is shown once at issue and only a hash is stored, so it cannot be re-sent by us."
      });
    }
    if (scope && !r.grant.scopes.includes(scope)) {
      return res.status(403).json({
        error: `this grant does not include the "${scope}" scope`,
        granted: r.grant.scopes,
        remedy: "The operator chose the scopes when issuing. Ask them to reissue with the scope you need."
      });
    }
    req.grant = r.grant;
    next();
  };
}

export function mountVerifierRoutes(api, { requireWs, requirePlan, ledger, decisions, compliance }) {

  // ── Operator side: issuing and managing access ────────────

  api.get("/grants/scopes", (req, res) =>
    res.json({ scopes: grants.scopeCatalogue(), maxGrantDays: grants.MAX_GRANT_DAYS }));

  api.post("/grants", requireWs, requirePlan("tracker"), (req, res) => {
    const { verifierName, verifierEmail, scopes, windowFrom, windowTo, days } = req.body || {};
    const out = grants.issue(req.workspace.id, {
      verifierName, verifierEmail, scopes, windowFrom, windowTo, days,
      org: req.workspace.org || null,
      actor: req.user ? { id: req.user.id, email: req.user.email } : null
    });
    if (!out.ok) return res.status(400).json(out);
    res.status(201).json(out);
  });

  api.get("/grants", requireWs, requirePlan("tracker"), (req, res) =>
    res.json({ grants: grants.listForWorkspace(req.workspace.id) }));

  api.delete("/grants/:id", requireWs, requirePlan("tracker"), (req, res) => {
    const out = grants.revoke(req.workspace.id, req.params.id, {
      actor: req.user ? { id: req.user.id, email: req.user.email } : null,
      reason: req.body?.reason || null
    });
    if (!out.ok) return res.status(400).json(out);
    res.json(out);
  });

  // ── Verifier side: read-only, grant-authenticated ─────────
  // Note what is absent: there is no POST, PUT, PATCH or DELETE below.

  /** What this grant lets me see, and until when. */
  api.get("/verify/grant", requireGrant(), (req, res) => {
    const g = req.grant;
    res.json({
      grantId: g.grantId, verifierName: g.verifierName,
      scopes: g.scopes, window: { from: g.windowFrom, to: g.windowTo },
      issuedAt: g.issuedAt, expiresAt: g.expiresAt,
      access: "read-only",
      accessNote: "This grant conveys read access only. There is no write path on the verifier "
                + "API, so an operator's record cannot be altered by anyone holding this token."
    });
  });

  /**
   * The core verifier action: does this document describe the archive?
   *
   * A GET, deliberately. This began as a POST because a digest and a window
   * sit more naturally in a body — but that put one mutating verb on the
   * verifier path, and the tier is sold on a verifier being unable to write.
   * "No POST, PUT, PATCH or DELETE under /verify" is a guarantee anyone can
   * check by reading the file; "there is one POST but it only reads" is a
   * guarantee that requires trusting this comment. The parameters are a hash
   * and two dates, none of them secret, so a query string costs nothing.
   */
  api.get("/verify/report", requireGrant("conjunctions"), (req, res) => {
    res.json(grants.verifyReport({
      grant: req.grant,
      claimedDigest: req.query.digest || null,
      since: req.query.since || null,
      until: req.query.until || null,
      thresholdPc: req.query.thresholdPc == null ? null : Number(req.query.thresholdPc)
    }));
  });

  /** The warnings themselves, so the verifier can look rather than take our word. */
  api.get("/verify/conjunctions", requireGrant("conjunctions"), (req, res) => {
    const g = req.grant;
    const rows = (ledger.query({
      type: "conjunction", org: g.org || null,
      since: req.query.since || g.windowFrom || null,
      until: req.query.until || g.windowTo || null,
      limit: Math.min(Number(req.query.limit) || 200, 1000)
    }).events || []);
    res.json({
      count: rows.length,
      conjunctions: rows.map(c => ({
        seq: c.seq, hash: c.h, archivedAt: c.t, tca: c.tca,
        a: c.aName, b: c.bName, missKm: c.missKm, pc: c.pc,
        pcMethod: c.pcMethod, pcModel: c.pcModel || "pre-v2", risk: c.risk
      })),
      modelNote: "Rows without pcModel predate the cov-v2 correction and their probabilities are "
               + "understated by many orders of magnitude. A dated erratum sits in the archive. "
               + "Do not compare them with current rows."
    });
  });

  api.get("/verify/decisions", requireGrant("decisions"), (req, res) => {
    const g = req.grant;
    res.json(decisions.list({
      ws: g.ws,
      since: req.query.since || g.windowFrom || null,
      until: req.query.until || g.windowTo || null,
      limit: Math.min(Number(req.query.limit) || 200, 1000)
    }));
  });

  api.get("/verify/summary", requireGrant("decisions"), (req, res) => {
    const g = req.grant;
    res.json(decisions.summary({
      ws: g.ws, org: g.org || null,
      since: req.query.since || g.windowFrom || null,
      until: req.query.until || g.windowTo || null,
      thresholdPc: req.query.thresholdPc != null ? Number(req.query.thresholdPc) : null
    }));
  });

  api.get("/verify/compliance", requireGrant("compliance"), (req, res) => {
    const g = req.grant;
    const counts = {};
    for (const t of ["conjunction", "decision", "maneuver", "reentry", "manoeuvre-screen"]) {
      counts[t] = (ledger.query({
        type: t, org: g.org || null, since: g.windowFrom, until: g.windowTo, limit: 5000
      }).events || []).length;
    }
    res.json(compliance.coverage({
      counts,
      thresholdPc: req.query.thresholdPc != null ? Number(req.query.thresholdPc) : null
    }));
  });

  /**
   * What was knowable on a given date.
   *
   * The question after an incident. Answered from contemporaneous rows rather
   * than by re-propagating today's element sets backwards, which would show
   * what was true rather than what was known — and the gap between those two
   * is usually the entire dispute.
   */
  api.get("/verify/knowable", requireGrant("conjunctions"), (req, res) => {
    const g = req.grant;
    const out = grants.knowableOn({
      org: g.org || null, ws: g.ws,
      at: req.query.at || new Date().toISOString(),
      objectId: req.query.objectId || null,
      windowHours: Math.min(Math.max(Number(req.query.windowHours) || 72, 1), 720)
    });
    if (out.error) return res.status(400).json(out);
    res.json(out);
  });

  /**
   * Was anyone watching?
   *
   * The question a warning list cannot answer. Under the conjunctions scope
   * because it is the same evidence seen from the other side: the warnings say
   * what was found, this says when anyone was looking, and a reader given only
   * the first can read a quiet month either way.
   */
  api.get("/verify/coverage", requireGrant("conjunctions"), (req, res) => {
    const g = req.grant;
    res.json(coverage.summary({
      org: g.org || null,
      since: req.query.since || g.windowFrom || new Date(Date.now() - 90 * 86400000).toISOString(),
      until: req.query.until || g.windowTo || new Date().toISOString()
    }));
  });

  /** Everything this verifier currently holds access to, across operators. */
  api.get("/verify/portfolio", requireGrant(), (req, res) => {
    const list = grants.portfolioFor(req.grant.verifierName);
    res.json({
      verifier: req.grant.verifierName,
      operators: list.length,
      grants: list.map(g => ({
        grantId: g.grantId, org: g.org, scopes: g.scopes,
        window: { from: g.windowFrom, to: g.windowTo },
        issuedAt: g.issuedAt, expiresAt: g.expiresAt
      })),
      note: "Only grants that are currently active are listed. Expired and revoked grants remain "
          + "in the archive as a record that access once existed, but convey nothing."
    });
  });
}
