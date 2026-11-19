// ============================================================
// OrbitIQ Tactical Space Copilot & NL Assistant
//
// Natural language flight dynamics copilot for satellite operators,
// mission controllers, and space insurance analysts.
// ============================================================
import { callAgent } from "./provider.js";
import { calculatePropellantExpenditure } from "./maneuver.js";
import { calculateDragInflation } from "./fso.js";

/**
 * Deterministic aerospace question-answering when offline or without external keys.
 */
function deterministicCopilotAnswer(query, context = {}) {
  const q = String(query || "").toLowerCase();
  const { catalogCount = 16000, spaceWeather = {}, topEncounters = [] } = context;
  const kp = spaceWeather.kp ?? 2.3;

  if (q.includes("space weather") || q.includes("kp") || q.includes("solar") || q.includes("drag")) {
    const drag = calculateDragInflation(kp);
    return `[SPACE ENVIRONMENT REPORT]\nCurrent NOAA Planetary K-Index: ${kp} (${spaceWeather.condition || "Nominal"}, Scale: ${spaceWeather.scale || "G0"}).\nImpact on LEO Operations: ${drag.impact} (Drag multiplier: ${drag.factor}x).\nAdvice: When Kp >= 5, expand in-track covariance windows by ${Math.round((drag.factor - 1) * 100)}% to account for thermospheric density swelling.`;
  }

  if (q.includes("conjunction") || q.includes("encounter") || q.includes("risk") || q.includes("close approach")) {
    if (topEncounters.length === 0) {
      return `[CONJUNCTION INTELLIGENCE]\nOrbitIQ is currently tracking ${catalogCount.toLocaleString()} objects across LEO, MEO, and GEO. No critical close approaches (< 1 km or Pc > 1e-4) are currently active in your fleet. Background screening runs every 30 minutes.`;
    }
    const top = topEncounters[0];
    const miss = Number(top.missKm || 0).toFixed(2);
    const pc = top.pc != null ? (Number(top.pc) > 0 ? Number(top.pc).toExponential(2) : "< 1e-8") : "pending";
    return `[CONJUNCTION INTELLIGENCE]\nTightest active encounter: ${top.a?.name || "Primary"} vs ${top.b?.name || "Secondary"}.\nTime of Closest Approach: ${top.tca || "Within 24h"}.\nMiss Distance: ${miss} km | Collision Probability (Pc): ${pc}.\nRecommendation: Run autonomous maneuver synthesis in the AI Copilot tab to determine optimal burn window.`;
  }

  if (q.includes("fuel") || q.includes("propellant") || q.includes("delta-v") || q.includes("delta v") || q.includes("burn")) {
    const match = q.match(/(\d+(?:\.\d+)?)\s*(?:m\/s|ms)/);
    const dv = match ? parseFloat(match[1]) : 0.2;
    const prop = calculatePropellantExpenditure(dv, 260, 220);
    return `[MANEUVER PROPULSION CALCULATION]\nFor a standard 260 kg smallsat with 220s Isp monopropellant executing a Δv of ${dv} m/s:\n- Propellant Consumed: ${prop.propellantGrams} grams (${prop.propellantKg} kg)\n- Mission Life Impact: Equivalent to ${prop.stationkeepingDaysLost} days of normal stationkeeping budget.\n- Maneuver Advice: Tangential prograde burns placed 1.5 to 2 orbits prior to TCA minimize required Δv by 60% compared to last-minute burns.`;
  }

  if (q.includes("fcc") || q.includes("iso") || q.includes("compliance") || q.includes("underwriter") || q.includes("insurance")) {
    return `[REGULATORY & DILIGENCE ARCHITECTURE]\nOrbitIQ does not determine compliance. It keeps evidence that supports demonstrating parts of:\n1. FCC 47 CFR § 25.114(d)(14) (5-Year Debris Mitigation & Collision Thresholds)\n2. ISO 24113:2019 Clause 6.3 (Active Collision Avoidance Management)\n3. ESA ESSB-ST-U-007 (Mission Tolerable Probability Compliance)\nRecorded decisions are chained into the tamper-evident archive, and a Proof of Diligence report lets an underwriter verify them independently. The FCC lifetime probability figure still needs NASA DAS or a higher-fidelity tool.`;
  }

  return `[ORBITIQ TACTICAL SPACE COPILOT]\nTracking ${catalogCount.toLocaleString()} catalogued orbital assets with SGP4 propagation and Foster 2D Probability of Collision.\nActive space environment: NOAA Kp=${kp} (${spaceWeather.condition || "Quiet"}).\nReady to analyze conjunction telemetry, solve minimum-fuel avoidance burns, verify secondary collision clearance, or draft regulatory compliance records.`;
}

/**
 * Handle a natural language space query.
 */
export async function querySpaceCopilot(prompt, context = {}) {
  const cleanPrompt = String(prompt || "").slice(0, 1000).trim();
  if (!cleanPrompt) {
    return {
      output: "Please provide a query regarding orbital mechanics, fleet safety, conjunction triage, or space weather.",
      provider: "deterministic"
    };
  }

  const fallbackFn = () => ({
    output: deterministicCopilotAnswer(cleanPrompt, context),
    provider: "deterministic",
    model: "orbitiq-sgp4-heuristics-v1"
  });

  const systemPrompt = `You are OrbitIQ's Tactical Space Copilot, an elite AI flight dynamics assistant for satellite mission operations.
You specialize in astrodynamics, SGP4 orbital propagation, Foster 2D Probability of Collision (Pc), Tsiolkovsky propellant budgeting, space weather atmospheric drag (NOAA Kp), and space safety regulations (FCC, ISO 24113, ESA).
Be precise, concise, and professional. Always provide actionable numbers and engineering recommendations.`;

  const userPrompt = `Mission Context:
- Catalog Size: ${context.catalogCount || 16000} objects
- Space Weather: Kp = ${context.spaceWeather?.kp || 2.3} (${context.spaceWeather?.condition || "Nominal"})
- Top Conjunctions: ${JSON.stringify(context.topEncounters?.slice(0, 3) || [])}
- Workspace: ${context.workspace?.name || "Global Operator"}

User Question:
"${cleanPrompt}"`;

  const res = await callAgent({
    systemPrompt,
    userPrompt,
    temperature: 0.2,
    maxTokens: 600,
    fallbackFn
  });

  return {
    output: res.output,
    provider: res.provider || "deterministic",
    model: res.model
  };
}
