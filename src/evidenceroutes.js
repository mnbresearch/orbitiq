// ============================================================
// Evidence-layer routes.
//
// ── Why these live outside server.js ────────────────────────
// server.js had grown past 95 kB. That is not a style complaint: a file that
// large is one nobody reads before changing, which is how the /api/v1 mount
// ordering bug survived in it unnoticed. The evidence layer is the part of the
// product with the strongest correctness requirements, so it gets its own file
// where the whole surface can be seen at once.
//
// Dependencies are injected rather than imported here so this module has no
// opinion about how the host wires its stores, and so the routes can be
// mounted against a test router without booting the world.
// ============================================================
import * as decisions from "./decisions.js";
import * as compliance from "./compliance.js";
import * as burnscreen from "./burnscreen.js";
import * as proof from "./proof.js";
import * as audit from "./audit.js";
import { mountVerifierRoutes } from "./verifierroutes.js";
import * as calibration from "./calibration.js";
import * as witness from "./witness.js";
import * as pcmod from "./pc.js";

export function mountEvidenceRoutes(api, { requireWs, requirePlan, fleet, ledger, getSatellites }) {

  // The verifier side — grants an operator issues, and the read-only API an
  // underwriter or regulator uses to check a document against the archive.
  // Mounted here so the whole evidence surface lives behind one call, but kept
  // in its own module because the property being sold is that no write handler
  // exists on that path.
  mountVerifierRoutes(api, { requireWs, requirePlan, ledger, decisions, compliance });
  // Evidence layer: decisions, compliance, manoeuvre screening, proof
  //
  // This is the part of the product that is not a feed. The archive records what
  // we saw; these routes record and export what the operator DID about it, which
  // is the half nobody can reconstruct after the fact and the half an underwriter
  // or regulator actually asks for.

  /**
   * How the covariance behind every probability was arrived at.
   *
   * Public, deliberately. This is the methodology, not the data: it says how
   * sigma is chosen and what was measured to check it. A reviewer at an
   * insurer should be able to read it before signing anything, and putting it
   * behind a login would make the one number this product is judged on the
   * one number nobody can inspect.
   */
  api.get("/calibration", (req, res) => {
    const c = calibration.current();
    res.json({
      status: calibration.status(),
      model: {
        version: pcmod.PC_MODEL_VERSION,
        basis: "Published SGP4/TLE error characterisations: a few km at epoch, in-track "
             + "dominant and growing fastest, radial nearly flat across a week. Taken at the "
             + "pessimistic end of the published range, because an over-wide covariance costs "
             + "an operator an unnecessary look while an over-tight one costs them the "
             + "conjunction.",
        probabilityFloor: pcmod.PC_FLOOR,
        floorMeans: "Below this a probability computed from a modelled covariance describes the "
                  + "assumption rather than the sky, so it is published as '< 1e-8' rather than "
                  + "with digits that would be false precision."
      },
      measurement: c
        ? {
            version: c.version,
            generatedAt: c.generatedAt,
            snapshots: c.snapshots,
            spanDays: c.snapshotSpanDays,
            objectsWithMultipleElementSets: c.objectsWithMultipleElementSets,
            pairsUsable: c.pairsUsable,
            byKind: c.byKind,
            method: c.method,
            limits: c.limits,
            usage: c.usage
          }
        : { applied: false,
            means: "No calibration is currently applied, so probabilities use the modelled "
                 + "covariance alone. This is the documented default." },
      direction:
        "A measurement can only widen the covariance used, never narrow it. Two element sets "
        + "from the same sensor network agree with each other better than either agrees with "
        + "the truth, so a small measured spread is not evidence of a small error — but a large "
        + "one is proof the model was too confident."
    });
  });

  /**
   * Check the archive against the external witness log.
   *
   * Public, and deliberately the one check that is. Everything else this
   * system says about its own integrity is computed over files it holds:
   * the chain is ours, and the seal file is ours too, so a thorough rewrite
   * would take both together. The witness log is written by a process outside
   * the service, against GitHub Actions runs whose logs the repository owner
   * cannot edit afterwards.
   *
   * That makes this the strongest negative signal the platform can produce
   * about itself — which is exactly why it should not require an account to
   * read. A verification anyone can run only if we let them is not much of a
   * verification.
   *
   * It reaches the network, so it is bounded and never throws: an unreachable
   * witness log is an absence of corroboration, not evidence of tampering,
   * and the response says so rather than failing in a way a reader might
   * mistake for an alarm.
   */
  api.get("/archive/witness-check", async (req, res) => {
    try {
      res.json(await witness.check({ timeoutMs: 8000 }));
    } catch (e) {
      res.status(200).json({
        ok: null,
        error: e.message,
        summary: "the witness check could not run",
        means: "This says nothing about the archive either way. The log lives outside this "
             + "service by design, so it can be unavailable while the archive is intact."
      });
    }
  });

  /** The decision vocabulary, so a client can render a picker without hardcoding. */
  api.get("/decisions/catalogue", (req, res) => res.json({ decisions: decisions.catalogue() }));

  /**
   * Record what the operator decided about an archived warning.
   *
   * Deliberately requires only the "tracker" tier: the whole strategy depends on
   * decisions actually being recorded, so gating this behind the top plan would
   * be self-defeating. Reading the evidence back out is where the value is
   * captured, not writing it in.
   */
  api.post("/decisions", requireWs, requirePlan("tracker"), (req, res) => {
    const { warningSeq, decision, rationale, policyThresholdPc, manoeuvre } = req.body || {};
    const actor = req.user ? { id: req.user.id, email: req.user.email, name: req.user.name } : null;
    const out = decisions.record(req.workspace.id, {
      warningSeq, decision, rationale, actor,
      policyThresholdPc: policyThresholdPc ?? fleet.getPolicy(req.workspace.id)?.pcThreshold ?? null,
      manoeuvre, org: req.workspace.org || null
    });
    if (!out.ok) return res.status(400).json(out);
    audit.record("decision.recorded", {
      ws: req.workspace.id, org: req.workspace.org || null, actor,
      detail: { target: String(warningSeq), thresholdPc: out.decision.policyThresholdPc }
    });
    res.status(201).json(out);
  });

  api.get("/decisions", requireWs, requirePlan("tracker"), (req, res) => {
    res.json(decisions.list({
      ws: req.workspace.id, org: req.query.org || null,
      since: req.query.since, until: req.query.until,
      limit: Math.min(Number(req.query.limit) || 200, 1000)
    }));
  });

  api.get("/decisions/summary", requireWs, requirePlan("tracker"), (req, res) => {
    const th = req.query.thresholdPc != null
      ? Number(req.query.thresholdPc)
      : (fleet.getPolicy(req.workspace.id)?.pcThreshold ?? null);
    res.json(decisions.summary({
      ws: req.workspace.id, org: req.workspace.org || null,
      since: req.query.since, until: req.query.until, thresholdPc: th
    }));
  });

  /** The framework catalogue is public: it is reference material, not a feature. */
  api.get("/compliance/frameworks", (req, res) =>
    res.json({ frameworks: compliance.frameworkList(), supportGrades: compliance.SUPPORT }));

  api.get("/compliance/coverage", requireWs, requirePlan("tracker"), (req, res) => {
    const org = req.workspace.org || null;
    const since = req.query.since, until = req.query.until;
    const counts = {};
    for (const t of ["conjunction", "decision", "maneuver", "reentry", "manoeuvre-screen"]) {
      counts[t] = (ledger.query({ type: t, org, since, until, limit: 5000 }).events || []).length;
    }
    res.json(compliance.coverage({
      counts,
      thresholdPc: fleet.getPolicy(req.workspace.id)?.pcThreshold ?? null,
      frameworkIds: req.query.frameworks ? String(req.query.frameworks).split(",") : null
    }));
  });

  /**
   * Screen a candidate avoidance burn.
   *
   * Answers the question that gets skipped: having moved, what did you move
   * towards? ESA screen candidate manoeuvres for exactly this and it is the one
   * piece of astrodynamics here that a public-TLE product can do as well as
   * anyone, because it is a differential question — the same catalogue, before
   * and after.
   */
  api.post("/fleet/manoeuvre/screen", requireWs, requirePlan("operator"), async (req, res) => {
    try {
      const { primaryId, deltaVms, burnAtIso, targetSecondaryId, hours } = req.body || {};
      if (!primaryId) return res.status(400).json({ error: "primaryId required" });
      const sats = await getSatellites();
      const primary = sats.find(s => String(s.id) === String(primaryId));
      if (!primary) return res.status(404).json({ error: "primaryId not in the catalogue" });

      const out = burnscreen.screenBurn(primary, sats, {
        deltaVms: Number(deltaVms),
        burnAtIso,
        targetSecondaryId,
        // Bounded: this propagates two trajectories per candidate and runs on a
        // small instance. 96 h is beyond any avoidance decision horizon anyway.
        hours: Math.min(Math.max(Number(hours) || 72, 1), 96)
      });
      if (out.error) return res.status(400).json(out);

      // Archived, because a screened-and-rejected burn is itself evidence of
      // diligence — arguably better evidence than one that was flown.
      ledger.append("manoeuvre-screen", [{
        org: req.workspace.org || null, ws: req.workspace.id,
        primaryId: String(primaryId), targetSecondaryId: targetSecondaryId ? String(targetSecondaryId) : null,
        deltaVms: out.deltaVms, burnAt: out.burnAt,
        targetImproved: out.target?.improved ?? null,
        introduced: out.introduced.length, worsened: out.worsened.length,
        verdict: out.verdict
      }]);
      audit.record("burn.screened", {
        ws: req.workspace.id, org: req.workspace.org || null,
        actor: req.user ? { id: req.user.id, email: req.user.email } : null,
        detail: { target: String(primaryId) }
      });
      res.json(out);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  /**
   * The Proof of Diligence report.
   *
   * HTML by default because the artefact is meant to be forwarded to someone who
   * will not install anything to read it; JSON when a customer wants to render
   * it themselves.
   */
  api.get("/proof/diligence", requireWs, requirePlan("operator"), (req, res) => {
    try {
      const org = req.query.org || req.workspace.org || null;
      const since = req.query.since || new Date(Date.now() - 90 * 86400000).toISOString();
      const until = req.query.until || new Date().toISOString();
      const thresholdPc = req.query.thresholdPc != null
        ? Number(req.query.thresholdPc)
        : (fleet.getPolicy(req.workspace.id)?.pcThreshold ?? null);

      const data = proof.build({
        org, ws: req.workspace.id, since, until, thresholdPc,
        operatorName: req.query.operatorName || req.workspace.name || org
      });

      audit.record("report.generated", {
        ws: req.workspace.id, org,
        actor: req.user ? { id: req.user.id, email: req.user.email } : null,
        detail: { window: `${since}..${until}`, thresholdPc, rowCount: data.rows.length, digest: data.reportDigest }
      });

      if (String(req.query.format || "html").toLowerCase() === "json") return res.json(data);
      res.set("Content-Type", "text/html; charset=utf-8");
      res.set("Content-Disposition",
        `inline; filename="orbitiq-proof-of-diligence-${(org || "operator").replace(/\W+/g, "-")}.html"`);
      res.send(proof.render(data));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  /** Audit trail — who produced or altered evidence. */
  api.get("/audit", requireWs, requirePlan("operator"), (req, res) => {
    res.json(audit.trail({
      ws: req.workspace.id, org: req.workspace.org || null,
      since: req.query.since, until: req.query.until,
      limit: Math.min(Number(req.query.limit) || 200, 1000)
    }));
  });
}
