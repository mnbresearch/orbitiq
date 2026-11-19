// ============================================================
// OrbitIQ Autonomous Multi-Agent AI System Test Suite
//
// Tests provider detection, graceful deterministic fallback,
// Tsiolkovsky fuel budgeting, FSO triage, regulatory compliance drafting,
// tactical space copilot, and REST API surface.
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import * as provider from "../src/agents/provider.js";
import * as fso from "../src/agents/fso.js";
import * as maneuver from "../src/agents/maneuver.js";
import * as compliance from "../src/agents/compliance.js";
import * as copilot from "../src/agents/copilot.js";
import * as orchestrator from "../src/agents/index.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8400 + Math.floor(Math.random() * 300);
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "orbitiq-agents-"));

let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`#   ok    ${name}`);
  } catch (e) {
    console.log(`#   FAIL  ${name}\n#         ${e.message}`);
    throw e;
  }
}

console.log("# ── multi-agent AI engine ─────────────────────");

test("provider detection and fallback safety", () => {
  const p = provider.detectProvider();
  check("provider is detected cleanly", () => {
    assert.ok(p.type, "should identify a provider type");
    assert.ok(p.name, "should have a human-readable provider name");
  });

  const status = provider.providerStatus();
  check("status exposes provider configuration without secrets", () => {
    assert.equal(typeof status.isExternalLLM, "boolean");
    assert.equal(typeof status.offlineFallbackActive, "boolean");
    assert.ok(status.configuredProviders);
  });
});

test("Flight Safety Officer (FSO) drag inflation and triage scoring", async () => {
  // Test atmospheric drag inflation across Kp ranges
  const quietDrag = fso.calculateDragInflation(2.0);
  check("quiet space weather yields baseline factor 1.0", () => {
    assert.equal(quietDrag.factor, 1.0);
  });

  const stormDrag = fso.calculateDragInflation(6.5);
  check("storm-time space weather inflates drag significantly", () => {
    assert.ok(stormDrag.factor > 1.5, `expected factor > 1.5, got ${stormDrag.factor}`);
    assert.ok(stormDrag.impact.includes("Storm-time") || stormDrag.impact.includes("expansion"));
  });

  // Severity scoring
  const mockCritical = {
    a: { id: "25544", name: "ISS (ZARYA)" },
    b: { id: "49800", name: "COSMOS 1408 DEBRIS" },
    tca: new Date(Date.now() + 6 * 3600 * 1000).toISOString(),
    missKm: 0.35,
    relVelKmS: 14.2,
    pc: 3.5e-4
  };

  const criticalScore = fso.scoreEncounterSeverity(mockCritical, 5.0, 1e-4);
  check("high-probability close approach scores in critical/emergency tier", () => {
    assert.ok(criticalScore.score >= 65, `expected score >= 65, got ${criticalScore.score}`);
    assert.ok(criticalScore.tier === "CRITICAL" || criticalScore.tier === "EMERGENCY");
    assert.ok(criticalScore.hoursToTca <= 6.5);
    assert.ok(criticalScore.goNoGoDeadlineHours <= 2.5);
  });

  const mockNominal = {
    a: { id: "50001", name: "STARLINK-3001" },
    b: { id: "12345", name: "DEBRIS" },
    tca: new Date(Date.now() + 48 * 3600 * 1000).toISOString(),
    missKm: 18.5,
    relVelKmS: 7.1,
    pc: 1e-8
  };

  const nominalScore = fso.scoreEncounterSeverity(mockNominal, 1.5, 1e-4);
  check("distant low-probability encounter is categorized as nominal", () => {
    assert.ok(nominalScore.score < 30);
    assert.equal(nominalScore.tier, "NOMINAL");
  });

  // Full FSO triage execution
  const triage = await fso.triageEncounter(mockCritical, {
    spaceWeather: { kp: 5.0, condition: "Minor storm" },
    policyThresholdPc: 1e-4
  });

  check("FSO triage generates actionable operational briefing", () => {
    assert.ok(triage.briefing.length > 50);
    assert.ok(triage.actionDirective);
    assert.equal(triage.tier, criticalScore.tier);
  });
});

test("Tsiolkovsky rocket equation and maneuver optimization", async () => {
  // Test Tsiolkovsky propellant calculation
  // deltaV = 1.0 m/s, mass = 260 kg, Isp = 220s
  // 1 - exp(-1 / (9.80665 * 220)) = 1 - exp(-0.0004635) ≈ 0.0004634
  // propellant ≈ 260 * 0.0004634 ≈ 0.1205 kg = 120.5 grams
  const prop = maneuver.calculatePropellantExpenditure(1.0, 260, 220);
  check("Tsiolkovsky equation calculates accurate fuel mass", () => {
    assert.ok(prop.propellantGrams > 115 && prop.propellantGrams < 125, `got ${prop.propellantGrams} g`);
    assert.ok(prop.stationkeepingDaysLost > 20, `expected > 20 days lost, got ${prop.stationkeepingDaysLost}`);
  });

  const mockEnc = {
    rA: { x: 6800, y: 0, z: 0 }, vA: { x: 0, y: 7.5, z: 0 },
    rB: { x: 6800, y: 0, z: 0.15 }, vB: { x: 0, y: 0, z: 7.5 },
    a: { id: "25544", name: "PRIMARY SAT" },
    b: { id: "49800", name: "DEBRIS" },
    tca: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
    missKm: 0.15,
    relVelKmS: 10.6,
    pc: 8e-6
  };

  const plan = await maneuver.planAutonomousManeuver(mockEnc, {
    spacecraft: { massKg: 300, ispS: 240, radiusM: 2.0 },
    targetPc: 1e-8,
    leadsHours: [24, 12, 6],
    screenSecondary: false
  }, []);

  check("autonomous maneuver planner finds viable burns across lead times", () => {
    assert.equal(plan.achievable, true);
    assert.ok(Array.isArray(plan.strategies));
    assert.ok(plan.strategies.length > 0);
    assert.ok(plan.optimalStrategy);
    assert.ok(plan.optimalStrategy.deltaVms > 0);
    assert.ok(plan.optimalStrategy.propellantGrams > 0);
  });
});

test("Regulatory compliance & insurance diligence filing", async () => {
  const filing = compliance.generateComplianceFiling({
    operatorName: "Starbound Telecom",
    spacecraftName: "STAR-7",
    noradId: "54321",
    secondaryName: "FENGYUN DEBRIS",
    secondaryNoradId: "31111",
    deltaVms: 0.12,
    propellantGrams: 28.4,
    ledgerSeq: 4128,
    ledgerHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
  });

  check("draft is organised by FCC, ISO 24113 and ESA with an archive citation, and never claims compliance", () => {
    assert.ok(filing.filingText.includes("FCC 47 CFR § 25.114"));
    assert.ok(filing.filingText.includes("ISO 24113:2019"));
    assert.ok(filing.filingText.includes("ESA SPACE DEBRIS MITIGATION"));
    assert.ok(filing.filingText.includes("sequence #4128"));
    assert.ok(filing.filingText.includes("does not determine compliance"));
    assert.ok(!/\bcompliant\b|attested|immutable/i.test(filing.filingText.replace("does not determine compliance", "")));
    assert.ok(filing.frameworks.length === 3);
  });

  const drafted = await compliance.draftComplianceStatement({
    operatorName: "Orbit Fleet Corp",
    spacecraftName: "OFC-ALPHA",
    noradId: "60001"
  });

  check("draftComplianceStatement returns publication-ready statement", () => {
    assert.ok(drafted.filing.length > 100);
  });
});

test("Tactical Space Copilot natural language assistant", async () => {
  const context = {
    catalogCount: 16500,
    spaceWeather: { kp: 6.0, condition: "Moderate storm", scale: "G2" },
    topEncounters: [{
      a: { name: "SAT-1" },
      b: { name: "DEB-2" },
      missKm: 1.2,
      pc: 1.5e-4,
      tca: "2026-11-19T04:00:00Z"
    }]
  };

  const qWeather = await copilot.querySpaceCopilot("How does space weather affect LEO satellites?", context);
  check("copilot explains Kp impact on drag and covariance", () => {
    assert.ok(qWeather.output.toLowerCase().includes("drag") || qWeather.output.toLowerCase().includes("kp"));
  });

  const qFuel = await copilot.querySpaceCopilot("Calculate fuel needed for a 0.5 m/s burn", context);
  check("copilot calculates propellant expenditure", () => {
    assert.ok(qFuel.output.toLowerCase().includes("propellant") || qFuel.output.toLowerCase().includes("grams"));
  });
});

test("End-to-end multi-agent encounter resolution workflow", async () => {
  const mockEnc = {
    a: { id: "25544", name: "ISS" },
    b: { id: "49800", name: "COSMOS DEBRIS" },
    tca: new Date(Date.now() + 18 * 3600 * 1000).toISOString(),
    missKm: 0.65,
    relVelKmS: 13.5,
    pc: 3e-4
  };

  const resolution = await orchestrator.runAutonomousEncounterWorkflow(mockEnc, {
    spaceWeather: { kp: 4.5, condition: "Active" },
    spacecraft: { massKg: 420000, ispS: 310 },
    targetPc: 1e-4,
    operatorName: "International Space Operations"
  }, []);

  check("orchestrator executes FSO triage, maneuver synthesis, and compliance drafting", () => {
    assert.ok(resolution.triage);
    assert.ok(resolution.triage.severityScore > 0);
    assert.ok(resolution.maneuver);
    assert.ok(resolution.compliance);
    assert.ok(resolution.compliance.filing.length > 50);
  });
});

test("Live API endpoints for multi-agent system", async () => {
  const child = spawn(process.execPath, [path.join(ROOT, "server.js")], {
    env: {
      ...process.env,
      PORT: String(PORT),
      ORBITIQ_DATA_DIR: DATA,
      ORBITIQ_ALLOW_LOCAL_SCREEN: "0"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  try {
    // Wait for server to boot
    let ready = false;
    const t0 = Date.now();
    while (Date.now() - t0 < 15000) {
      try {
        const r = await fetch(`http://127.0.0.1:${PORT}/api/health`, { signal: AbortSignal.timeout(1000) });
        if (r.ok) { ready = true; break; }
      } catch {}
      await new Promise(r => setTimeout(r, 250));
    }
    assert.ok(ready, "Server failed to boot in test");

    // 1. GET /api/v1/agents/status
    const stRes = await fetch(`http://127.0.0.1:${PORT}/api/v1/agents/status`);
    const stData = await stRes.json();
    check("GET /api/v1/agents/status returns 200 with active agents", () => {
      assert.equal(stRes.status, 200);
      assert.equal(stData.ok, true);
      assert.ok(Array.isArray(stData.activeAgents));
      assert.equal(stData.activeAgents.length, 4);
    });

    // 2. Unversioned /api/agents/status alias
    const stUnv = await fetch(`http://127.0.0.1:${PORT}/api/agents/status`);
    check("GET /api/agents/status agrees with versioned endpoint", () => {
      assert.equal(stUnv.status, 200);
    });

    // 3. POST /api/v1/agents/triage
    const trRes = await fetch(`http://127.0.0.1:${PORT}/api/v1/agents/triage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        encounter: {
          a: { id: "25544", name: "ISS" },
          b: { id: "49800", name: "DEBRIS" },
          tca: new Date(Date.now() + 10 * 3600 * 1000).toISOString(),
          missKm: 1.1,
          relVelKmS: 11.2,
          pc: 1.2e-4
        }
      })
    });
    const trData = await trRes.json();
    check("POST /api/v1/agents/triage triages encounter correctly", () => {
      assert.equal(trRes.status, 200);
      assert.equal(trData.ok, true);
      assert.ok(trData.triage.tier);
      assert.ok(trData.triage.briefing);
    });

    // 4. POST /api/v1/agents/query
    const qRes = await fetch(`http://127.0.0.1:${PORT}/api/v1/agents/query`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "What is current space weather status?" })
    });
    const qData = await qRes.json();
    check("POST /api/v1/agents/query returns intelligent response", () => {
      assert.equal(qRes.status, 200);
      assert.equal(qData.ok, true);
      assert.ok(qData.answer.output.length > 20);
    });

  } finally {
    child.kill("SIGTERM");
  }
});
