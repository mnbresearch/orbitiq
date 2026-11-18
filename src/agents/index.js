// ============================================================
// OrbitIQ Multi-Agent Orchestrator
//
// Unifies the Flight Safety Officer, Maneuver Synthesizer,
// Regulatory Diligence Officer, and Tactical Space Copilot.
// ============================================================
import { detectProvider, providerStatus } from "./provider.js";
import { triageEncounter, calculateDragInflation, scoreEncounterSeverity } from "./fso.js";
import { planAutonomousManeuver, calculatePropellantExpenditure } from "./maneuver.js";
import { draftComplianceStatement, generateComplianceFiling } from "./compliance.js";
import { querySpaceCopilot } from "./copilot.js";

export {
  detectProvider,
  providerStatus,
  triageEncounter,
  calculateDragInflation,
  scoreEncounterSeverity,
  planAutonomousManeuver,
  calculatePropellantExpenditure,
  draftComplianceStatement,
  generateComplianceFiling,
  querySpaceCopilot
};

/**
 * End-to-end autonomous encounter resolution workflow:
 * 1. FSO evaluates conjunction severity and space weather drag factor.
 * 2. If burn is required, Maneuver Agent synthesizes minimum-fuel delta-v and screens secondaries.
 * 3. Compliance Agent prepares draft regulatory filing.
 */
export async function runAutonomousEncounterWorkflow(enc, opts = {}, catalog = []) {
  const { spaceWeather = {}, spacecraft = {}, targetPc = 1e-4, operatorName = "Spacecraft Operator" } = opts;

  // Step 1: FSO Triage
  const triage = await triageEncounter(enc, { spaceWeather, policyThresholdPc: targetPc });

  // Step 2: Maneuver Synthesis
  let maneuver = null;
  if (triage.tier === "CRITICAL" || triage.tier === "EMERGENCY" || triage.tier === "ELEVATED") {
    maneuver = await planAutonomousManeuver(enc, { spacecraft, targetPc, screenSecondary: true }, catalog);
  }

  // Step 3: Compliance Drafting
  const compliance = await draftComplianceStatement({
    operatorName,
    spacecraftName: enc.a?.name || "Primary Satellite",
    noradId: enc.a?.id || "00000",
    secondaryName: enc.b?.name || "Secondary Object",
    secondaryNoradId: enc.b?.id || "00000",
    tca: enc.tca,
    initialPc: enc.pc != null ? String(enc.pc) : "Unknown",
    postBurnPc: maneuver?.optimalStrategy?.pcAfter != null ? String(maneuver.optimalStrategy.pcAfter) : "< 1e-7",
    deltaVms: maneuver?.optimalStrategy?.deltaVms ?? 0.15,
    propellantGrams: maneuver?.optimalStrategy?.propellantGrams ?? 32,
    decision: maneuver?.burnRequired ? "manoeuvre" : "monitor",
    rationale: triage.actionDirective
  });

  return {
    triage,
    maneuver,
    compliance,
    orchestratedAt: new Date().toISOString()
  };
}
