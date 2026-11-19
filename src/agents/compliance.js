// ============================================================
// OrbitIQ diligence drafting agent
//
// Drafts a diligence SUMMARY for the operator, organised by FCC 47 CFR
// § 25.114(d)(14), ISO 24113:2019 and ESA ESSB-ST-U-007, from what the operator
// supplied and what the archive holds. It never asserts compliance: anything
// OrbitIQ cannot establish is marked for the operator to confirm.
// ============================================================
import { callAgent } from "./provider.js";

export function generateComplianceFiling(params = {}) {
  const {
    operatorName = "Commercial Satellite Operator",
    spacecraftName = "LEO Spacecraft",
    noradId = "00000",
    secondaryName = "Tracked Object",
    secondaryNoradId = "00000",
    tca = new Date().toISOString(),
    initialPc = "1.5e-4",
    postBurnPc = "2.0e-7",
    deltaVms = 0.15,
    propellantGrams = 32.5,
    decision = "manoeuvre",
    rationale = "Mitigate collision probability below mission tolerable threshold of 1e-4",
    ledgerSeq = null,
    ledgerHash = null
  } = params;

  const dateStr = new Date().toISOString().slice(0, 10);
  const ledgerCite = ledgerSeq != null
    ? `Recorded in the OrbitIQ hash-chained archive at sequence #${ledgerSeq} (row hash ${String(ledgerHash).slice(0, 16)}…). Anyone can check the chain at /api/v1/archive/verify.`
    : "Not yet linked to an archive row. Record the decision in OrbitIQ so it can be cited and verified.";

  // This is a DRAFT for the operator, not a filing. It restates what the
  // operator supplied and what the archive holds, and it marks every statement
  // OrbitIQ cannot establish — see src/compliance.js for why that line matters:
  // OrbitIQ does not determine compliance, and a document that said otherwise
  // would fail under exactly the scrutiny it exists for.
  const CONFIRM = "[operator to confirm]";
  const text = [
    `=== DRAFT — DILIGENCE SUMMARY FOR OPERATOR REVIEW ===`,
    `Prepared: ${dateStr} · Not a regulatory filing. OrbitIQ does not determine compliance.`,
    `Operator: ${operatorName}`,
    `Primary asset: ${spacecraftName} (NORAD ${noradId})`,
    `Conjunction: ${secondaryName} (NORAD ${secondaryNoradId})`,
    `Time of closest approach: ${tca}`,
    ``,
    `1. FCC 47 CFR § 25.114(d)(14) — orbital debris mitigation disclosures`,
    `Screening record: an encounter with assessed collision probability ${initialPc} (Foster 2D, public elements) was identified by continuous screening.`,
    `Recorded response: ${decision}, Δv ${deltaVms} m/s, assessed post-burn probability ${postBurnPc} ${CONFIRM}.`,
    `Note: the FCC lifetime collision-probability figure must be computed with NASA DAS or a higher-fidelity tool; screening records do not substitute for it.`,
    ``,
    `2. ISO 24113:2019 — collision risk management`,
    `Evidence available: the screening history and the decision recorded with rationale: "${rationale}".`,
    `Post-manoeuvre screening against the catalogue ${CONFIRM}.`,
    ``,
    `3. ESA SPACE DEBRIS MITIGATION (ESSB-ST-U-007) — mission tolerable threshold`,
    `The threshold in force is the mission's own ${CONFIRM}. Propellant used: ${propellantGrams} g; effect on disposal reliability ${CONFIRM}.`,
    ``,
    `4. EVIDENCE FOR A THIRD PARTY`,
    `${ledgerCite}`,
    `A Proof of Diligence report (Evidence page) packages the warning, the decision and the hashes for an insurer or regulator to verify independently.`
  ].join("\n");

  return {
    operatorName,
    spacecraftName,
    noradId,
    tca,
    filingText: text,
    frameworks: ["FCC 47 CFR § 25.114(d)(14)", "ISO 24113:2019", "ESA ESSB-ST-U-007"],
    draft: true,
    attestationHash: ledgerHash
  };
}

export async function draftComplianceStatement(params = {}) {
  const fallback = generateComplianceFiling(params);

  const fallbackFn = () => ({
    ...fallback,
    provider: "deterministic",
    filing: fallback.filingText
  });

  const systemPrompt = `You are the OrbitIQ diligence drafting assistant.
Write a DRAFT diligence summary for the operator to review, organised under FCC 47 CFR § 25.114(d)(14), ISO 24113:2019 and ESA ESSB-ST-U-007.
Rules: never state or imply that the operator is compliant; OrbitIQ does not determine compliance. Restate only facts given in the input.
Mark anything not established by the input with "[operator to confirm]". Note that the FCC lifetime collision probability requires NASA DAS or a higher-fidelity tool.
Cite the archive sequence and hash if provided, and say how a third party can verify them.`;

  const userPrompt = JSON.stringify(params, null, 2);

  const res = await callAgent({
    systemPrompt,
    userPrompt,
    temperature: 0.1,
    maxTokens: 800,
    fallbackFn
  });

  return {
    ...fallback,
    filing: res.output || fallback.filingText,
    provider: res.provider || "deterministic",
    model: res.model
  };
}
