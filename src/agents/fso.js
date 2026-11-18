// ============================================================
// OrbitIQ Autonomous Flight Safety Officer (FSO) Agent
//
// Synthesizes close-approach geometry, 2D Foster Pc, NOAA space weather,
// and satellite maneuverability into tactical operations briefings.
// ============================================================
import { callAgent } from "./provider.js";

/**
 * Calculate atmospheric drag inflation factor from NOAA Kp index.
 * Geomagnetic storms heat the thermosphere, causing density scale height
 * expansion and widening in-track TLE covariance by 30% to 300%.
 */
export function calculateDragInflation(kp = 2.0) {
  const k = Math.max(0, Math.min(9, Number(kp) || 2.0));
  if (k < 4) return { factor: 1.0, impact: "Nominal baseline drag" };
  if (k < 5) return { factor: 1.25, impact: "Mild drag elevation (+25% in-track dispersion)" };
  if (k < 7) {
    const factor = +(1 + 0.35 * Math.pow(k - 4, 1.8)).toFixed(2);
    return { factor, impact: `Storm-time density enhancement (+${Math.round((factor - 1) * 100)}% along-track error)` };
  }
  const factor = +(1 + 0.6 * Math.pow(k - 4, 1.9)).toFixed(2);
  return { factor, impact: `Severe geomagnetic heating (+${Math.round((factor - 1) * 100)}% along-track expansion)` };
}

/**
 * Assess overall collision severity index (0 - 100) and operational alert tier.
 */
export function scoreEncounterSeverity(enc, kp = 2.0, thresholdPc = 1e-4) {
  const missKm = enc.missKm != null ? Number(enc.missKm) : 10;
  const pc = enc.pc != null ? Number(enc.pc) : (enc.risk === "CRITICAL" ? 2e-4 : 1e-6);
  const relVel = enc.relVelKmS != null ? Number(enc.relVelKmS) : 10;
  const tcaMs = enc.tca ? new Date(enc.tca).getTime() : Date.now() + 12 * 3600 * 1000;
  const hoursToTca = Math.max(0, (tcaMs - Date.now()) / (3600 * 1000));

  let score = 0;

  // 1. Miss distance component (up to 40 pts)
  if (missKm < 0.2) score += 40;
  else if (missKm < 0.5) score += 35;
  else if (missKm < 1.0) score += 30;
  else if (missKm < 3.0) score += 22;
  else if (missKm < 5.0) score += 15;
  else if (missKm < 10.0) score += 8;

  // 2. Probability component (up to 35 pts)
  if (pc >= 1e-3) score += 35;
  else if (pc >= 1e-4) score += 30;
  else if (pc >= 1e-5) score += 20;
  else if (pc >= 1e-6) score += 10;
  else if (pc > 0) score += 5;

  // 3. Kinetic energy / relative velocity component (up to 15 pts)
  if (relVel > 12) score += 15;
  else if (relVel > 8) score += 10;
  else if (relVel > 4) score += 5;

  // 4. Space weather drag multiplier (up to 10 pts)
  const drag = calculateDragInflation(kp);
  if (drag.factor >= 2.0) score += 10;
  else if (drag.factor >= 1.3) score += 5;

  score = Math.min(100, Math.round(score));

  let tier = "NOMINAL";
  let action = "Continue routine orbital screening";

  if (pc >= thresholdPc || missKm < 1.0 || (score >= 65 && hoursToTca <= 24)) {
    if (hoursToTca <= 12) {
      tier = "EMERGENCY";
      action = "Execute immediate avoidance burn planning; crew GO/NO-GO lock in effect";
    } else {
      tier = "CRITICAL";
      action = "Maneuver required — design avoidance burn and screen secondary crossings";
    }
  } else if (pc >= thresholdPc * 0.1 || missKm < 3.0 || score >= 45) {
    tier = "ELEVATED";
    action = "Elevated close-approach watch; prepare thruster telemetry and verify ephemeris updates";
  } else if (missKm < 8.0 || score >= 25) {
    tier = "MONITOR";
    action = "Track subsequent TLE updates and monitor for covariance divergence";
  }

  const goNoGoDeadlineHours = Math.max(0, +(hoursToTca - 4).toFixed(1));

  return {
    score,
    tier,
    action,
    hoursToTca: +hoursToTca.toFixed(1),
    goNoGoDeadlineHours,
    dragInflation: drag
  };
}

/**
 * Flight Safety Officer tactical triage.
 */
export async function triageEncounter(enc, context = {}) {
  const { spaceWeather = {}, policyThresholdPc = 1e-4 } = context;
  const kp = spaceWeather.kp ?? 2.0;
  const severity = scoreEncounterSeverity(enc, kp, policyThresholdPc);

  const fallbackFn = () => {
    const aName = enc.a?.name || (enc.a?.id ? `NORAD ${enc.a.id}` : "Primary Spacecraft");
    const bName = enc.b?.name || (enc.b?.id ? `NORAD ${enc.b.id}` : "Secondary Object");
    const missKm = Number(enc.missKm ?? 0).toFixed(2);
    const relVel = enc.relVelKmS != null ? `${Number(enc.relVelKmS).toFixed(1)} km/s` : "high relative velocity";
    const pcStr = enc.pc != null ? (Number(enc.pc) >= 0.01 ? `${(Number(enc.pc) * 100).toFixed(1)}%` : Number(enc.pc).toExponential(2)) : "Pending calculation";

    const brief = [
      `[TACTICAL FSO REPORT - ${severity.tier}]`,
      `Encounter between ${aName} and ${bName}.`,
      `Closest Approach: TCA in ${severity.hoursToTca}h (Miss Distance: ${missKm} km at ${relVel}).`,
      `Assessed Probability of Collision (Pc): ${pcStr} (Policy Threshold: ${policyThresholdPc}).`,
      `Space Weather Context: NOAA Kp=${kp} (${spaceWeather.condition || "Nominal"}) -> ${severity.dragInflation.impact}.`,
      `Action Directive: ${severity.action}. Go/No-Go maneuver execution deadline is in ${severity.goNoGoDeadlineHours} hours.`
    ].join("\n");

    return {
      tier: severity.tier,
      severityScore: severity.score,
      hoursToTca: severity.hoursToTca,
      deadlineHours: severity.goNoGoDeadlineHours,
      dragFactor: severity.dragInflation.factor,
      actionDirective: severity.action,
      briefing: brief
    };
  };

  const systemPrompt = `You are the OrbitIQ Flight Safety Officer (FSO) AI Agent for autonomous space traffic management.
Analyze conjunction telemetry and output a concise, authoritative operational briefing for satellite operations leads.
Always specify:
1. Threat evaluation (Miss distance, Relative velocity, Collision Probability Pc vs policy threshold).
2. Space weather atmospheric drag risk (Kp impact on TLE covariance).
3. Clear Go/No-Go operational action directive and timeline.`;

  const userPrompt = JSON.stringify({
    primary: enc.a,
    secondary: enc.b,
    tca: enc.tca,
    missKm: enc.missKm,
    relVelKmS: enc.relVelKmS,
    altKm: enc.altKm,
    pc: enc.pc,
    policyThresholdPc,
    hoursToTca: severity.hoursToTca,
    goNoGoDeadlineHours: severity.goNoGoDeadlineHours,
    spaceWeather: { kp, condition: spaceWeather.condition, f107: spaceWeather.f107 },
    preliminarySeverity: severity
  }, null, 2);

  const res = await callAgent({
    systemPrompt,
    userPrompt,
    temperature: 0.1,
    maxTokens: 500,
    fallbackFn
  });

  return {
    tier: severity.tier,
    severityScore: severity.score,
    hoursToTca: severity.hoursToTca,
    deadlineHours: severity.goNoGoDeadlineHours,
    dragFactor: severity.dragInflation.factor,
    actionDirective: severity.action,
    briefing: res.output || res.briefing,
    provider: res.provider || "deterministic",
    model: res.model
  };
}
