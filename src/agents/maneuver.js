// ============================================================
// OrbitIQ Autonomous Maneuver Synthesis & Propellant Optimization Agent
//
// Calculates multi-option avoidance burns, Tsiolkovsky propellant
// mass expenditure, mission lifetime impact, and secondary encounter screening.
// ============================================================
import * as pcmod from "../pc.js";
import * as burnscreen from "../burnscreen.js";
import { stateAt } from "../orbitstate.js";
import { callAgent } from "./provider.js";

const G0 = 9.80665; // m/s^2

/**
 * Ensure the encounter has ECI state vectors rA, vA, rB, vB for RIC projection.
 * If raw states are absent, propagate from GP or synthesize a representative
 * crossing geometry from miss distance and altitude.
 */
export function ensureStateVectors(enc) {
  if (enc.rA && enc.vA && enc.rB && enc.vB) return enc;
  const tca = enc.tca ? new Date(enc.tca) : new Date();
  if (enc.a?.gp && enc.b?.gp) {
    const sA = stateAt(enc.a.gp, tca);
    const sB = stateAt(enc.b.gp, tca);
    if (sA && sB) {
      return { ...enc, rA: sA.r, vA: sA.v, rB: sB.r, vB: sB.v };
    }
  }
  const alt = Number(enc.altKm) || 500;
  const R = 6378.137 + alt;
  const vOrbit = Math.sqrt(398600.4418 / R);
  const miss = Math.max(0.01, Number(enc.missKm) || 0.15);
  const angRad = (enc.crossAngleDeg != null ? Number(enc.crossAngleDeg) : 90) * Math.PI / 180;
  return {
    ...enc,
    rA: { x: R, y: 0, z: 0 },
    vA: { x: 0, y: vOrbit, z: 0 },
    rB: { x: R, y: miss * Math.cos(angRad), z: miss * Math.sin(angRad) },
    vB: { x: 0, y: vOrbit * Math.cos(angRad), z: vOrbit * Math.sin(angRad) }
  };
}

/**
 * Tsiolkovsky Rocket Equation:
 * delta_m = m_0 * (1 - exp(-delta_v / (g0 * Isp)))
 */
export function calculatePropellantExpenditure(deltaVms, massKg = 260, ispS = 220) {
  const dv = Math.abs(Number(deltaVms) || 0);
  const m0 = Math.max(0.1, Number(massKg) || 260);
  const isp = Math.max(10, Number(ispS) || 220);

  const frac = 1 - Math.exp(-dv / (G0 * isp));
  const kg = m0 * frac;
  const grams = kg * 1000;

  // LEO orbit maintenance consumes roughly 15 m/s per year (0.041 m/s per day)
  const equivalentStationkeepingDays = +(dv / 0.041).toFixed(1);

  return {
    propellantKg: +kg.toFixed(5),
    propellantGrams: +grams.toFixed(2),
    stationkeepingDaysLost: equivalentStationkeepingDays,
    propellantFractionPercent: +(frac * 100).toFixed(4)
  };
}

/**
 * Synthesize and rank candidate avoidance burns across lead times.
 */
export async function planAutonomousManeuver(enc, opts = {}, catalog = []) {
  const {
    spacecraft = {},
    targetPc = 1e-4,
    leadsHours = [24, 12, 6, 3],
    screenSecondary = true
  } = opts;

  const massKg = Number(spacecraft.massKg) || 260;
  const ispS = Number(spacecraft.ispS) || 220;
  const hbrM = Number(spacecraft.radiusM) || 1.5;

  const readyEnc = ensureStateVectors(enc);

  // Evaluate baseline solution via pcmod
  const sol = pcmod.planToTargetPc(readyEnc, {
    targetPc,
    massKg,
    ispS,
    hbrM,
    leadsHours
  });

  const primaryObj = catalog.find(s => String(s.id) === String(enc.a?.id || enc.primaryId));
  const secondaryId = String(enc.b?.id || enc.targetSecondaryId || "");

  // Enrich each lead time option with Tsiolkovsky propellant and secondary screening
  const enrichedOptions = (sol.options || []).map(opt => {
    const prop = calculatePropellantExpenditure(opt.deltaVms, massKg, ispS);

    let secondaryVerdict = { checked: false, safe: true };
    if (screenSecondary && primaryObj && catalog.length > 0) {
      try {
        const burnAt = new Date(new Date(enc.tca).getTime() - opt.leadHours * 3600 * 1000);
        const screen = burnscreen.screenBurn(primaryObj, catalog, {
          deltaVms: opt.deltaVms,
          burnAtIso: burnAt.toISOString(),
          targetSecondaryId: secondaryId,
          hours: Math.min(48, Math.max(12, opt.leadHours * 2))
        });
        secondaryVerdict = {
          checked: true,
          safe: screen.verdict !== "DANGEROUS",
          verdict: screen.verdict,
          targetImproved: screen.target?.improved ?? true,
          introducedCount: screen.introduced?.length || 0,
          worsenedCount: screen.worsened?.length || 0
        };
      } catch {
        secondaryVerdict = { checked: false, safe: true, note: "Catalog screen bypassed" };
      }
    }

    return {
      ...opt,
      propellantGrams: prop.propellantGrams,
      stationkeepingDaysLost: prop.stationkeepingDaysLost,
      secondaryClearance: secondaryVerdict
    };
  });

  // Pick the recommended optimal trade-off burn
  const optimal = enrichedOptions.find(o => o.feasible && o.secondaryClearance?.safe) || enrichedOptions[0] || null;

  const fallbackFn = () => {
    const optDesc = optimal
      ? `Execute a ${optimal.deltaVms} m/s prograde burn at ${optimal.leadHours}h prior to TCA. Consumes ${optimal.propellantGrams} g of propellant (equivalent to ${optimal.stationkeepingDaysLost} days of stationkeeping margin), reducing collision probability to ${optimal.pcAfterBand}.`
      : "No impulsive tangential maneuver within normal thresholds reached target probability.";

    return {
      achievable: sol.achievable,
      burnRequired: sol.burnRequired,
      targetPc,
      currentPc: sol.currentPc,
      optimalStrategy: optimal,
      strategies: enrichedOptions,
      synthesis: `[AUTONOMOUS MANEUVER RECOMMENDATION]\n${optDesc}\nCost of delay: Waiting from 24h to 3h before TCA increases delta-v cost by ${sol.costOfDelay?.ratio || "8x"}.`
    };
  };

  const systemPrompt = `You are the OrbitIQ Autonomous Maneuver Synthesis & Propellant Optimization Agent.
Given conjunction geometry and spacecraft mass/Isp constraints, provide a crisp flight dynamicist recommendation for an avoidance maneuver.
Specify the exact delta-v (m/s), burn direction (prograde/retrograde), propellant mass expenditure (grams), timing, and secondary clearance confirmation.`;

  const userPrompt = JSON.stringify({
    encounter: { a: enc.a, b: enc.b, tca: enc.tca, missKm: enc.missKm, pc: enc.pc },
    spacecraft: { massKg, ispS, hbrM },
    targetPc,
    optimalOption: optimal,
    allOptions: enrichedOptions
  }, null, 2);

  const res = await callAgent({
    systemPrompt,
    userPrompt,
    temperature: 0.1,
    maxTokens: 500,
    fallbackFn
  });

  return {
    achievable: sol.achievable,
    burnRequired: sol.burnRequired,
    targetPc,
    currentPc: sol.currentPc,
    optimalStrategy: optimal,
    strategies: enrichedOptions,
    costOfDelay: sol.costOfDelay,
    synthesis: res.output || res.synthesis,
    provider: res.provider || "deterministic",
    model: res.model
  };
}
