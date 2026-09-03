// ============================================================
// The evidence layer must be evidence, not a feed with nicer words.
//
// ── What these tests are actually protecting ────────────────
// The commercial argument for this product is that a third party can rely on
// what it produces. That argument fails completely on a handful of specific
// properties, and each is easy to break with a well-meaning refactor:
//
//   1. A decision must be bound to the exact warning it answers, by hash. A
//      decision that merely names an object proves nothing, because the
//      warning could be edited afterwards to suit.
//   2. Decisions that assert something — "I accepted this risk", "I flew a
//      burn" — must carry the substantiation a reviewer will ask for. An
//      unsubstantiated assertion in an evidence product is worse than a blank.
//   3. The compliance mapping must never claim more than screening can support.
//      The FCC lifetime probability in particular is not evidenceable here and
//      must stay graded that way no matter how much data accumulates.
//   4. A manoeuvre screen must refuse to endorse a burn that makes the target
//      conjunction worse. An early version of the verdict logic did exactly
//      that, which is why this is pinned.
//   5. The report must state its own limits and tell the reader how to check
//      it without trusting us. Strip that and it becomes marketing.
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "orbitiq-ev-"));
process.env.ORBITIQ_DATA_DIR = tmp;

const ledger = await import("../src/ledger.js");
const decisions = await import("../src/decisions.js");
const compliance = await import("../src/compliance.js");
const proof = await import("../src/proof.js");
const audit = await import("../src/audit.js");
const burnscreen = await import("../src/burnscreen.js");

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log(`#   ok    ${name}`); }
  catch (e) { failed++; console.log(`#   FAIL  ${name}\n#         ${e.message}`); throw e; }
}

const iso = ms => new Date(ms).toISOString();
const now = Date.now();

// Seed warnings the decisions will answer.
ledger.append("conjunction", [0, 1, 2].map(i => ({
  org: "acme", aOrg: "acme", bOrg: "other",
  aName: "ACME-" + i, bName: "DEB-" + i, aId: 8000 + i, bId: 9000 + i,
  tca: iso(now + (i + 6) * 3600e3), missKm: 0.5 + i, relVelKmS: 9.1, altKm: 540,
  risk: "HIGH", pc: [3e-4, 8e-5, 2e-6][i], pcMethod: "foster-2d", pcModel: "cov-v2-2026-09"
})));
const warnings = ledger.query({ type: "conjunction", limit: 20 }).events.sort((a, b) => a.seq - b.seq);
const actor = { id: "u1", email: "ops@acme.test", name: "Ops" };

console.log("# ── evidence layer ────────────────────────────");

test("a decision is bound to the warning it answers", () => {
  const r = decisions.record("ws-1", {
    warningSeq: warnings[0].seq, decision: "manoeuvre_executed", actor,
    policyThresholdPc: 1e-4, org: "acme",
    rationale: "Above mission threshold; retrograde burn flown at T-4h.",
    manoeuvre: { deltaVms: 0.06, burnAtIso: iso(now + 2 * 3600e3), propellantKg: 0.02 }
  });

  check("the decision is accepted", () => assert.ok(r.ok, JSON.stringify(r)));

  check("it cites BOTH the sequence and the hash of the warning", () => {
    assert.equal(r.decision.warningSeq, warnings[0].seq);
    assert.equal(r.decision.warningHash, warnings[0].h,
      "without the hash, the warning could be edited afterwards and the decision would "
      + "still appear to match — the binding is the whole point");
    assert.ok(r.decision.warningHash, "warning hash missing");
  });

  check("it records the threshold in force AT THE TIME", () => {
    assert.equal(r.decision.policyThresholdPc, 1e-4,
      "thresholds are per-mission and change; judging an old decision against today's "
      + "threshold judges it against the wrong one");
  });

  check("it records response latency and remaining lead time", () => {
    assert.ok(Number.isFinite(r.decision.responseMinutes), "no responseMinutes");
    assert.ok(Number.isFinite(r.decision.leadHoursAtDecision), "no leadHoursAtDecision");
  });

  check("a decision cannot cite a row that does not exist", () => {
    const bad = decisions.record("ws-1", { warningSeq: 999999, decision: "acknowledged", actor });
    assert.equal(bad.ok, false);
    assert.match(bad.error, /no archived row/);
  });

  check("a decision cannot cite a non-conjunction row", () => {
    ledger.append("maneuver", [{ org: "acme", id: 1, name: "x", kind: "raise" }]);
    const m = ledger.query({ type: "maneuver", limit: 5 }).events[0];
    const bad = decisions.record("ws-1", { warningSeq: m.seq, decision: "acknowledged", actor });
    assert.equal(bad.ok, false);
    assert.match(bad.error, /not a conjunction/);
  });
});

test("assertions must be substantiated", () => {
  check("accepting risk requires a written rationale", () => {
    const bad = decisions.record("ws-1", {
      warningSeq: warnings[1].seq, decision: "risk_accepted", actor, rationale: "fine"
    });
    assert.equal(bad.ok, false);
    assert.match(bad.error, /rationale/,
      "risk_accepted with no explanation is the single least defensible row this system "
      + "could produce, and a reviewer reads that field first");
  });

  check("claiming a burn requires burn parameters", () => {
    const bad = decisions.record("ws-1", {
      warningSeq: warnings[1].seq, decision: "manoeuvre_executed", actor,
      rationale: "We definitely flew something, honestly."
    });
    assert.equal(bad.ok, false);
    assert.match(bad.error, /deltaVms/,
      "recording that a manoeuvre happened without saying what it was is an assertion, "
      + "not evidence");
  });

  check("a valid risk acceptance is allowed through", () => {
    const ok = decisions.record("ws-1", {
      warningSeq: warnings[1].seq, decision: "risk_accepted", actor, org: "acme",
      policyThresholdPc: 1e-4,
      rationale: "Covariance-driven at a 4-day element age; awaiting a fresh set rather than burning."
    });
    assert.ok(ok.ok, JSON.stringify(ok));
  });
});

test("the summary reports what is missing, not just what is present", () => {
  const s = decisions.summary({ ws: "ws-1", org: "acme", thresholdPc: 1e-6 });

  check("unanswered warnings above threshold are surfaced", () => {
    assert.ok("unansweredAboveThreshold" in s,
      "an evidence product that hides the gaps is marketing; the underwriter looks here first");
    assert.ok(s.unansweredAboveThreshold >= 1,
      `expected at least one unanswered warning, got ${s.unansweredAboveThreshold}`);
  });

  check("the gap is described without implying negligence", () => {
    assert.match(s.unansweredNote || "", /taken elsewhere|not as a finding of fault/i,
      "a missing record may simply mean the decision was made outside this system");
  });

  check("counts are caveated as records held, not as an audit", () => {
    assert.match(s.caveat, /not an audit/i);
  });
});

test("compliance mapping never overclaims", () => {
  const cov = compliance.coverage({ counts: { conjunction: 999, decision: 999, maneuver: 999, reentry: 999 } });

  check("the FCC lifetime probability stays not-evidenceable regardless of data volume", () => {
    const fcc = cov.frameworks.find(f => f.id === "fcc-odm");
    const lifetime = fcc.obligations.find(o => /collision risk/i.test(o.ref));
    assert.equal(lifetime.support, "none",
      "this requires NASA DAS or a higher-fidelity lifetime analysis; no quantity of live "
      + "screening records can substitute, and claiming otherwise fails exactly when it matters");
    assert.equal(lifetime.status, "not-evidenceable");
  });

  check("every framework carries a citation and a source URL", () => {
    for (const f of cov.frameworks) {
      assert.ok(f.citation, `${f.id} has no citation`);
      assert.match(f.url || "", /^https?:\/\//, `${f.id} has no source URL`);
    }
  });

  check("the top-level limits disclaim certification", () => {
    assert.match(cov.limits, /does not determine compliance/i);
    assert.match(cov.limits, /does not issue certification/i);
  });

  check("a missing mission threshold is called out rather than defaulted", () => {
    assert.match(cov.thresholdNote, /No mission threshold recorded/i,
      "silently substituting an industry-standard threshold would misrepresent the "
      + "operator's own policy");
  });
});

test("a manoeuvre screen refuses to endorse a harmful burn", () => {
  const ep = d => new Date(Date.now() - d * 864e5).toISOString().replace("Z", "");
  const gp = (id, name, ma) => ({
    OBJECT_NAME: name, NORAD_CAT_ID: id, EPOCH: ep(0.3), MEAN_MOTION: 15.2,
    ECCENTRICITY: 0.0003, INCLINATION: 53, RA_OF_ASC_NODE: 100, ARG_OF_PERICENTER: 90,
    MEAN_ANOMALY: ma, BSTAR: 1e-4, MEAN_MOTION_DOT: 0, MEAN_MOTION_DDOT: 0,
    ELEMENT_SET_NO: 999, REV_AT_EPOCH: 100, EPHEMERIS_TYPE: 0, CLASSIFICATION_TYPE: "U"
  });
  const primary = { id: 70001, name: "PRIMARY", gp: gp(70001, "PRIMARY", 10) };
  const catalog = [];
  for (let i = 0; i < 12; i++) {
    catalog.push({ id: 71000 + i, name: "N-" + i, gp: gp(71000 + i, "N-" + i, 10 + (i - 6) * 0.02) });
  }
  const burnAt = new Date(Date.now() + 3 * 3600e3).toISOString();

  // Try both signs; at least one should be rejected as harmful for some target,
  // and whenever the verdict rejects, `improved` must be false.
  let sawReject = false;
  for (const dv of [0.12, -0.12]) {
    for (const target of [71004, 71006, 71008]) {
      const r = burnscreen.screenBurn(primary, catalog, {
        deltaVms: dv, burnAtIso: burnAt, targetSecondaryId: target, hours: 36, thresholdKm: 10
      });
      if (r.error || !r.target) continue;
      if (/^REJECT/.test(r.verdict)) {
        sawReject = true;
        check(`a rejected burn is flagged as not improving (dv ${dv}, target ${target})`, () => {
          assert.equal(r.target.improved, false);
          assert.ok(r.target.warning, "a rejected burn must explain why");
        });
      } else {
        check(`an endorsed burn actually improved the target (dv ${dv}, target ${target})`, () => {
          assert.equal(r.target.improved, true,
            "the verdict endorsed a burn whose target probability did not improve — this is "
            + "the exact defect that shipped in the first draft");
        });
      }
    }
  }
  check("at least one harmful burn was detected across the sweep", () => {
    assert.ok(sawReject,
      "no harmful burn found in the sweep; the rejection path is then untested, which is "
      + "worse than a failing test because it looks green");
  });
});

test("the report carries its own limits and a way to check it", () => {
  const html = proof.report({
    org: "acme", ws: "ws-1", thresholdPc: 1e-6, operatorName: "ACME Space Ltd",
    since: iso(now - 7 * 86400e3), until: iso(now + 86400e3)
  });

  check("it is a standalone document", () => {
    assert.match(html, /^<!doctype html>/i);
    assert.ok(!/<script/i.test(html),
      "the reader may be a claims adjuster opening this years later; it must render with "
      + "no scripts and no network");
  });

  check("it tells the reader how to verify without trusting us", () => {
    assert.match(html, /Verify this document without trusting us/i);
    assert.match(html, /archive\/verify/, "no public verification endpoint given");
    assert.match(html, /witness/i, "no external witness pointer given");
  });

  check("it states what it does NOT establish", () => {
    assert.match(html, /does not establish/i);
    assert.match(html, /tamper-<b>evident<\/b>, not tamper-proof/i,
      "the strength of the claim must travel with the document");
  });

  check("it does not claim compliance anywhere", () => {
    assert.ok(!/\bis compliant\b/i.test(html), "the report must never assert compliance");
    assert.ok(!/\bcertif(y|ied|ication)\b/i.test(html.replace(/does not issue certification/gi, "")),
      "no certification language");
  });

  check("unanswered warnings appear in the document, not just the API", () => {
    assert.match(html, /no decision recorded/i,
      "the gap has to be visible to the reader of the artefact, otherwise the artefact is "
      + "selectively reporting");
  });
});

test("evidence-affecting actions are audited into the same chain", () => {
  audit.record("report.generated", {
    ws: "ws-1", org: "acme", actor,
    detail: { window: "w", thresholdPc: 1e-4, rowCount: 3, digest: "abc" }
  });
  const t = audit.trail({ ws: "ws-1", org: "acme" });

  check("the action is recorded", () => {
    assert.ok(t.count >= 1, "no audit rows");
    assert.ok(t.actions.some(a => a.action === "report.generated"));
  });

  check("audit rows are hash-chained like everything else", () => {
    const row = t.actions.find(a => a.action === "report.generated");
    assert.ok(row.hash, "audit row has no hash — an editable audit trail is not a trail");
    assert.ok(Number.isFinite(row.seq));
  });

  check("the chain still verifies after all of this", () => {
    const v = ledger.verify();
    assert.equal(v.ok, true, `chain broken: ${v.reason} at ${v.seq}`);
  });

  console.log("# ──────────────────────────────────────────────");
  console.log(`#   ${passed} passed, ${failed} failed`);
  assert.equal(failed, 0);
});
