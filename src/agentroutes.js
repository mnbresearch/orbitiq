// ============================================================
// OrbitIQ Autonomous Multi-Agent AI API Routes
//
// Exposes the Flight Safety Officer, Maneuver Synthesizer,
// Regulatory Diligence Officer, and Tactical Space Copilot.
// ============================================================
import * as agents from "./agents/index.js";
import { getSpaceWeather } from "./spaceweather.js";

export function mountAgentRoutes(api, { requireWs, requirePlan, fleet, ledger, getSatellites }) {

  /**
   * Status of the multi-agent AI engine.
   * Public: shows active provider (Grok / OpenAI / Gemini / Offline Heuristics)
   * and space environment baseline.
   */
  api.get("/agents/status", async (req, res) => {
    try {
      const weather = await getSpaceWeather().catch(() => ({ kp: 2.33, condition: "Nominal" }));
      const status = agents.providerStatus();
      res.json({
        ok: true,
        aiEngine: status,
        spaceWeather: weather,
        activeAgents: [
          { id: "fso", name: "Flight Safety Officer", role: "Conjunction triage & geomagnetic drag impact analysis" },
          { id: "maneuver", name: "Orbital Maneuver Synthesizer", role: "Tsiolkovsky fuel budgeting & secondary collision screening" },
          { id: "compliance", name: "Regulatory & Underwriter Diligence Agent", role: "Automated FCC 47 CFR § 25.114 & ISO 24113 proof generation" },
          { id: "copilot", name: "Tactical Space Copilot", role: "Natural language mission ops assistant" }
        ],
        timestamp: new Date().toISOString()
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  /**
   * Tactical Flight Safety Officer triage of a conjunction encounter.
   */
  api.post("/agents/triage", async (req, res) => {
    try {
      const { encounter } = req.body || {};
      if (!encounter || !encounter.tca) {
        return res.status(400).json({ error: "encounter object with 'tca' required" });
      }

      const weather = await getSpaceWeather().catch(() => ({ kp: 2.33, condition: "Nominal" }));
      const policyThresholdPc = req.workspace
        ? (fleet.getPolicy(req.workspace.id)?.pcThreshold ?? 1e-4)
        : 1e-4;

      const result = await agents.triageEncounter(encounter, {
        spaceWeather: weather,
        policyThresholdPc
      });

      res.json({ ok: true, triage: result });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  /**
   * Autonomous maneuver synthesis and propellant mass optimization.
   */
  api.post("/agents/plan-maneuver", async (req, res) => {
    try {
      const { encounter, spacecraft, targetPc, leadsHours } = req.body || {};
      if (!encounter || !encounter.tca) {
        return res.status(400).json({ error: "encounter object with 'tca' required" });
      }

      let catalog = [];
      try { catalog = await getSatellites(); } catch { /* offline / sample */ }

      const result = await agents.planAutonomousManeuver(
        encounter,
        {
          spacecraft: spacecraft || {},
          targetPc: targetPc || 1e-4,
          leadsHours: Array.isArray(leadsHours) ? leadsHours : [24, 12, 6, 3],
          screenSecondary: true
        },
        catalog
      );

      res.json({ ok: true, plan: result });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  /**
   * Autonomous regulatory and insurance diligence filing.
   */
  api.post("/agents/compliance", async (req, res) => {
    try {
      const params = req.body || {};
      const result = await agents.draftComplianceStatement(params);
      res.json({ ok: true, compliance: result });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  /**
   * Natural language tactical space copilot.
   */
  api.post("/agents/query", async (req, res) => {
    try {
      const { query } = req.body || {};
      if (!query || typeof query !== "string") {
        return res.status(400).json({ error: "query string required" });
      }

      let catalogCount = 16000;
      try { catalogCount = (await getSatellites()).length; } catch {}
      const weather = await getSpaceWeather().catch(() => ({ kp: 2.33, condition: "Nominal" }));

      const context = {
        catalogCount,
        spaceWeather: weather,
        workspace: req.workspace || null,
        topEncounters: req.body.encounters || []
      };

      const result = await agents.querySpaceCopilot(query, context);
      res.json({ ok: true, answer: result });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  /**
   * Full end-to-end multi-agent resolution of an encounter.
   */
  api.post("/agents/resolve-encounter", async (req, res) => {
    try {
      const { encounter, spacecraft, targetPc, operatorName } = req.body || {};
      if (!encounter || !encounter.tca) {
        return res.status(400).json({ error: "encounter object with 'tca' required" });
      }

      let catalog = [];
      try { catalog = await getSatellites(); } catch {}
      const weather = await getSpaceWeather().catch(() => ({ kp: 2.33, condition: "Nominal" }));

      const result = await agents.runAutonomousEncounterWorkflow(
        encounter,
        {
          spaceWeather: weather,
          spacecraft: spacecraft || {},
          targetPc: targetPc || 1e-4,
          operatorName: operatorName || req.workspace?.name || "Spacecraft Operator"
        },
        catalog
      );

      res.json({ ok: true, resolution: result });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
}
