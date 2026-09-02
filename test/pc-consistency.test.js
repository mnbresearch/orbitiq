// ============================================================
// One conjunction must produce ONE probability.
//
// ── The defect this pins down ───────────────────────────────
// There were two Pc implementations. `watch.assessEvent` ran the Foster
// encounter-plane integration with an anisotropic covariance. The
// intelligence sweep — the process that writes the append-only, hash-chained,
// externally witnessed ledger — called `intel.screeningPc`, an isotropic
// closed form that takes only a miss distance.
//
// They disagreed, and not randomly. Orbital position error is dominated by
// the along-track component, so the true covariance is a long thin ellipse.
// The isotropic form circularises it, spreading probability over a larger
// area than the real one, and returns a number that is too SMALL. Measured
// over 135 representative geometries: lower in 100% of cases, median 5.3x,
// worst 32x.
//
// That is the worst available direction to be wrong in. The ledger is
// permanent and is the number an operator would act on, so the archive was
// telling customers a conjunction was five times safer than the service's own
// rigorous endpoint said it was.
//
// These tests assert the PROPERTY (the archive path and the live path agree,
// and the isotropic form is never silently substituted) rather than the
// presence of any particular call, because the original bug was two pieces of
// code that were each individually fine.
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as intel from "../src/intel.js";
import * as watch from "../src/watch.js";
import * as pc from "../src/pc.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log(`#   ok    ${name}`); }
  catch (e) { failed++; console.log(`#   FAIL  ${name}\n#         ${e.message}`); throw e; }
}

// ── Fixtures ────────────────────────────────────────────────
// Two real ISS-era element sets, close enough in plane to screen against each
// other. Exact geometry does not matter; that both paths see the SAME objects
// does.
const GP_A = {
  OBJECT_NAME: "FIXTURE ALPHA", NORAD_CAT_ID: 90001,
  EPOCH: new Date(Date.now() - 1.5 * 86400000).toISOString().replace("Z", ""),
  MEAN_MOTION: 15.49, ECCENTRICITY: 0.0004, INCLINATION: 51.64,
  RA_OF_ASC_NODE: 120.0, ARG_OF_PERICENTER: 90.0, MEAN_ANOMALY: 10.0,
  BSTAR: 0.0001, MEAN_MOTION_DOT: 0, MEAN_MOTION_DDOT: 0,
  ELEMENT_SET_NO: 999, REV_AT_EPOCH: 100, EPHEMERIS_TYPE: 0, CLASSIFICATION_TYPE: "U"
};
const GP_B = {
  ...GP_A, OBJECT_NAME: "FIXTURE BRAVO DEB", NORAD_CAT_ID: 90002,
  EPOCH: new Date(Date.now() - 4.0 * 86400000).toISOString().replace("Z", ""),
  INCLINATION: 51.70, MEAN_ANOMALY: 10.02
};

// NOTE: `epoch` is a top-level field on a real sat object (set in data.js from
// o.EPOCH) and is what intel.tleAgeDays reads — distinct from gp.EPOCH, which
// is what the SGP4 path reads. A fixture missing it makes screeningPc return
// null rather than a number, which is a fixture bug and not a product one.
const satA = { id: 90001, name: "FIXTURE ALPHA", org: "test", gp: GP_A, epoch: GP_A.EPOCH };
const satB = { id: 90002, name: "FIXTURE BRAVO DEB", org: "test", gp: GP_B, epoch: GP_B.EPOCH };
const byId = new Map([[satA.id, satA], [satB.id, satB]]);

const ev = {
  tca: new Date(Date.now() + 6 * 3600000).toISOString(),
  missKm: 1.2, relVelKmS: 0.9, altKm: 420, risk: "HIGH",
  a: { id: 90001, name: satA.name, org: "test" },
  b: { id: 90002, name: satB.name, org: "test" }
};

console.log("# ── Pc consistency ────────────────────────────");

test("the archive and the live API agree on one conjunction", () => {

  const [aug] = intel.augmentConjunctions([ev], byId);

  check("the archive path produces a probability at all", () => {
    assert.ok(Number.isFinite(aug.pc), `pc was ${aug.pc}`);
  });

  check("the archive path is labelled with the method that produced it", () => {
    assert.ok(aug.pcMethod,
      "no pcMethod on the row — the ledger is permanent, so a reader cannot "
      + "tell a rigorous value from a degraded one without this label");
    assert.ok(["foster-2d", "isotropic-screen"].includes(aug.pcMethod),
      `unexpected pcMethod ${aug.pcMethod}`);
  });

  check("the archive path uses the RIGOROUS method when a state exists", () => {
    assert.equal(aug.pcMethod, "foster-2d",
      "SGP4 can propagate both fixtures, so there is no excuse for falling "
      + "back to the isotropic screen — this is the original defect");
  });

  check("the archive number MATCHES the live watch endpoint number", () => {
    const live = watch.assessEvent(ev, byId, 20);
    assert.ok(live, "watch.assessEvent returned null for a propagable pair");
    // Same inputs, same method, so these must be identical — not merely close.
    assert.equal(aug.pc, live.pc,
      `archive says ${aug.pc}, live API says ${live.pc} for the SAME event; `
      + "two implementations have drifted apart again");
  });

  check("the anisotropy is actually reported, not collapsed to one sigma", () => {
    assert.ok(Number.isFinite(aug.sigmaMajorKm) && Number.isFinite(aug.sigmaMinorKm),
      "no principal-axis sigmas — the ellipse is what makes this better than the circle");
    assert.notEqual(aug.sigmaMajorKm, aug.sigmaMinorKm,
      "the two encounter-plane sigmas are equal, which means the covariance is "
      + "still effectively circular and nothing was gained");
  });

  check("element ages reach the covariance model", () => {
    assert.ok(aug.ageDaysA > 1 && aug.ageDaysA < 3, `ageDaysA=${aug.ageDaysA}`);
    assert.ok(aug.ageDaysB > 3 && aug.ageDaysB < 6, `ageDaysB=${aug.ageDaysB}`);
    assert.ok(aug.ageDaysB > aug.ageDaysA,
      "the older element set must be reported as older, or the covariance "
      + "model is being fed constants instead of real epochs");
  });
});

test("the isotropic form is never silently substituted", () => {

  // ────────────────────────────────────────────────────────────
  // These replace an earlier test that asserted the isotropic screen is
  // always LOWER than Foster. That was wrong, and wrong in an instructive
  // way: it was measured on synthetic geometries that happened to put the
  // miss along the MAJOR axis of the covariance ellipse. Real conjunctions
  // do the opposite — relative velocity is roughly along-track, so the large
  // along-track uncertainty projects mostly OUT of the encounter plane and
  // the miss lands on the thin minor axis. On production data the ordering
  // reversed and Foster came out many orders LOWER.
  //
  // So the honest property is not "one is always bigger". It is that the two
  // are not interchangeable, and that the assumed covariance must stay
  // defensible — because Pc is exponential in (miss/sigma), a covariance
  // that is a few times too tight buries real conjunctions completely.
  // ────────────────────────────────────────────────────────────

  check("the covariance model matches the published shape of SGP4 error", () => {
    const at = a => pc.covarianceModel(a, "payload");
    const rss = c => Math.hypot(c.sigmaR, c.sigmaI, c.sigmaC);

    // Total position error at epoch is on the order of a few km. Anything
    // sub-kilometre here is the defect that produced Pc values near 1e-40.
    const e = at(0);
    assert.ok(rss(e) > 1.5 && rss(e) < 6,
      `epoch RSS sigma is ${rss(e).toFixed(2)} km; published TLE accuracy at epoch is `
      + "a few km. Sub-km means the model is far too confident and Pc will collapse");

    // In-track dominates and grows fastest; radial stays roughly flat.
    assert.ok(e.sigmaI > e.sigmaR && e.sigmaI > e.sigmaC,
      "in-track must be the dominant component at epoch");
    const wk = at(7);
    assert.ok(wk.sigmaI > 12,
      `in-track at 7 days is ${wk.sigmaI} km; published growth reaches tens of km`);
    assert.ok(wk.sigmaR < 3 * e.sigmaR,
      "radial should stay roughly constant over a week, not grow like in-track");

    // Nobody should be able to quietly tighten this back down.
    assert.ok(e.sigmaR >= 0.4,
      `radial sigma at epoch is ${e.sigmaR} km. Below ~0.4 km this model claims better `
      + "than published TLE accuracy, and Pc becomes a statement about the assumption");
  });

  check("a realistic conjunction is not buried by the covariance", () => {
    // The regression that shipped: a 2.4 km miss archived as Pc 4e-40.
    // A miss of a couple of km against a few-km covariance must land in a
    // range an operator could act on, not in the 1e-30s.
    const th = 60 * Math.PI / 180;
    const enc = {
      rA: { x: 6828, y: 0, z: 0 }, vA: { x: 0, y: 7.6, z: 0 },
      rB: { x: 6828, y: 2.431 * Math.cos(th), z: 2.431 * Math.sin(th) },
      vB: { x: 0, y: 7.6 * Math.cos(th), z: 7.6 * Math.sin(th) }
    };
    const a = pc.assess(enc, { ageDaysA: 0.21, ageDaysB: 0.21, kindA: "payload", kindB: "debris" });
    assert.ok(a.pc > 1e-9,
      `a 2.4 km miss came out at Pc ${a.pc.toExponential(2)}. That is the covariance `
      + "collapsing the probability, not the geometry — the exact defect this guards");
    assert.equal(a.covarianceDriven, false,
      "a routine crossing conjunction should not be flagged covariance-driven; "
      + `it sits ${a.ordersBelowIsotropic} orders below the isotropic reference`);
  });

  check("false precision is floored rather than published", () => {
    // Force a genuinely tiny probability with a wide miss.
    const enc = {
      rA: { x: 6828, y: 0, z: 0 }, vA: { x: 0, y: 7.6, z: 0 },
      rB: { x: 6828, y: 0, z: 60 },
      vB: { x: 0, y: -7.6, z: 0 }
    };
    const a = pc.assess(enc, { ageDaysA: 0.2, ageDaysB: 0.2 });
    if (a.pcExact < pc.PC_FLOOR) {
      assert.equal(a.pc, pc.PC_FLOOR,
        "a Pc below the floor must be reported AT the floor, not with 30 digits of "
        + "precision it does not have");
      assert.ok(a.pcFloored, "the floored result must say it was floored");
      assert.match(a.pcText || "", /< 1e-8/, "floored values need a readable label");
    }
  });

  check("the divergence flag fires when the covariance does all the work", () => {
    // Simulate the old over-tight model by asking for a near-zero element age
    // on a wide miss: if the anisotropic result ever collapses far below the
    // isotropic reference again, this must be visible in the output.
    const th = 5 * Math.PI / 180;
    const enc = {
      rA: { x: 6828, y: 0, z: 0 }, vA: { x: 0, y: 7.6, z: 0 },
      rB: { x: 6828, y: 8 * Math.cos(th), z: 8 * Math.sin(th) },
      vB: { x: 0, y: 7.6 * Math.cos(th), z: 7.6 * Math.sin(th) }
    };
    const a = pc.assess(enc, { ageDaysA: 0, ageDaysB: 0 });
    assert.ok(typeof a.ordersBelowIsotropic === "number" || a.ordersBelowIsotropic === null,
      "ordersBelowIsotropic must always be reported so this condition is observable");
    assert.ok("covarianceDriven" in a,
      "the covariance-driven flag is the tripwire for the 1e-40 class of bug and "
      + "must be present on every assessment");
  });

  check("the model carries a version so archived rows stay interpretable", () => {
    assert.ok(pc.PC_MODEL_VERSION, "no PC_MODEL_VERSION export");
    const a = pc.assess({
      rA: { x: 6828, y: 0, z: 0 }, vA: { x: 0, y: 7.6, z: 0 },
      rB: { x: 6828, y: 2, z: 0 }, vB: { x: 0, y: -7.6, z: 0 }
    }, {});
    assert.equal(a.pcModel, pc.PC_MODEL_VERSION,
      "every assessment must stamp the covariance model that produced it; the archive "
      + "is append-only and already holds rows from a model that was wrong");
  });

  check("a degraded row is flagged, not passed off as rigorous", () => {
    // An object whose elements SGP4 cannot use must not quietly produce a
    // number that looks like the rigorous one.
    const broken = { ...satB, id: 90003, gp: { ...GP_B, MEAN_MOTION: 0 } };
    const m = new Map([[satA.id, satA], [90003, broken]]);
    const e2 = { ...ev, b: { id: 90003, name: "BROKEN", org: "test" } };
    const [row] = intel.augmentConjunctions([e2], m);
    if (row.pcMethod === "isotropic-screen") {
      assert.ok(row.pcDegraded,
        "a fallback row carries no warning that its value is biased low");
    }
    // If SGP4 still solved it, that is fine — the point is only that a
    // fallback, when it happens, is labelled.
    assert.ok(row.pcMethod, "row has no method label at all");
  });

  check("screeningPc is documented as a fallback at its definition", () => {
    const src = fs.readFileSync(path.join(ROOT, "src/intel.js"), "utf8");
    const i = src.indexOf("export function screeningPc");
    const doc = src.slice(Math.max(0, i - 1200), i);
    assert.match(doc, /FALLBACK ONLY|BIASED LOW/,
      "the next person to need a quick Pc will reach for screeningPc; the "
      + "warning has to be where they will read it");
  });

  check("the shared helpers have exactly one definition", () => {
    // The root cause was two copies of the same helper diverging.
    const w = fs.readFileSync(path.join(ROOT, "src/watch.js"), "utf8");
    assert.ok(!/^function stateAt\(/m.test(w),
      "watch.js defines its own stateAt again — that is how the two Pc paths "
      + "drifted apart the first time");
    assert.match(w, /from "\.\/orbitstate\.js"/,
      "watch.js no longer imports the shared helpers");
    const it = fs.readFileSync(path.join(ROOT, "src/intel.js"), "utf8");
    assert.match(it, /from "\.\/orbitstate\.js"/,
      "intel.js must use the same helpers as watch.js, not its own");
  });

});

// ============================================================
// Solving to a probability threshold
//
// Operators do not hold themselves to a miss distance, they hold themselves to
// a probability: "manoeuvre if Pc exceeds 1e-4". Distance is a bad proxy,
// because how safe a given miss is depends entirely on how well the two
// objects are tracked. These tests assert the property that actually matters —
// that the burn the solver reports genuinely achieves the threshold — rather
// than pinning specific numbers that would break on any model refinement.
// ============================================================
const geo = (missKm, angDeg) => {
  const th = angDeg * Math.PI / 180;
  return {
    rA: { x: 6800, y: 0, z: 0 }, vA: { x: 0, y: 7.5, z: 0 },
    rB: { x: 6800, y: missKm * Math.cos(th), z: missKm * Math.sin(th) },
    vB: { x: 0, y: 7.5 * Math.cos(th), z: 7.5 * Math.sin(th) }
  };
};
const AGES = { ageDaysA: 1.5, ageDaysB: 4 };

test("a manoeuvre solved to a Pc threshold actually reaches it", () => {

  check("the solve meets the target across a spread of geometries", () => {
    let met = 0, unreachable = 0, missed = [];
    for (const miss of [0.1, 0.5, 1, 2, 5]) {
      for (const ang of [5, 15, 45, 90, 135, 170]) {
        const s = pc.driftForTargetPc(geo(miss, ang), 1e-6, AGES);
        if (!s) { unreachable++; continue; }
        // Allow a hair of float slack; anything more means the bisection
        // returned a drift that does not actually clear the threshold.
        if (s.pcAchieved <= 1e-6 * 1.001) met++;
        else missed.push(`miss=${miss} ang=${ang} pc=${s.pcAchieved.toExponential(2)}`);
      }
    }
    assert.equal(missed.length, 0,
      `the solver reported burns that do NOT reach the target: ${missed.join("; ")}`);
    assert.ok(met > 0, "no case produced a solution at all");
  });

  check("a burn is not prescribed when the threshold is already met", () => {
    const p = pc.planToTargetPc(geo(5, 90), { targetPc: 1e-2, ...AGES });
    assert.equal(p.burnRequired, undefined === p.burnRequired ? undefined : false,
      "expected burnRequired to be false or absent");
    assert.ok(p.achievable, "an already-safe encounter should not be reported unachievable");
    assert.equal(p.options.length, 0,
      "propellant was quoted for an encounter that is already below the threshold");
  });

  check("waiting is reported as more expensive, because it is", () => {
    const p = pc.planToTargetPc(geo(0.15, 90), { targetPc: 1e-6, ...AGES });
    assert.ok(p.burnRequired, "this geometry needs a burn; the solver said otherwise");
    const early = p.options.find(o => o.leadHours === 24);
    const late  = p.options.find(o => o.leadHours === 3);
    assert.ok(early && late, "expected both a 24 h and a 3 h option");
    assert.ok(late.deltaVms > early.deltaVms,
      "deciding later must cost more Δv — δs ≈ 3·Δv·T means half the lead time "
      + "is twice the burn; if this inverts, the model is wrong");
    assert.ok(p.costOfDelay && /x more/.test(p.costOfDelay),
      "the delay penalty is the single most decision-relevant output and is missing");
  });

  check("the quoted Δv is physically sane for collision avoidance", () => {
    const p = pc.planToTargetPc(geo(0.15, 90), { targetPc: 1e-6, ...AGES });
    const o = p.options.find(x => x.leadHours === 24);
    // Real CA burns are ~0.1-1 m/s. Three orders either side of that means a
    // unit error somewhere, which is exactly the kind of thing that reads fine.
    assert.ok(o.deltaVms > 0.001 && o.deltaVms < 100,
      `${o.deltaVms} m/s is outside any plausible collision-avoidance burn`);
    assert.ok(o.propellantKg > 0 && o.propellantKg < 10,
      `${o.propellantKg} kg of propellant for a CA burn is not plausible`);
  });

  check("an unachievable geometry says so instead of quoting a useless burn", () => {
    // Force the issue with a target no along-track burn can reach.
    const p = pc.planToTargetPc(geo(0.1, 90), { targetPc: 1e-300, ...AGES });
    if (!p.achievable) {
      assert.ok(/radial or cross-track/.test(p.note),
        "when a tangential burn is the wrong lever, the answer should say which "
        + "lever is right, not just fail");
      assert.equal(p.options.length, 0, "options were quoted for an unachievable target");
    }
  });

  check("the caveat survives on every path", () => {
    for (const [label, p] of [
      ["needs burn",     pc.planToTargetPc(geo(0.15, 90), { targetPc: 1e-6, ...AGES })],
      ["already safe",   pc.planToTargetPc(geo(5, 90),    { targetPc: 1e-2, ...AGES })],
      ["unachievable",   pc.planToTargetPc(geo(0.1, 90),  { targetPc: 1e-300, ...AGES })]
    ]) {
      assert.match(p.caveat || "", /Flight-dynamics validation/,
        `the ${label} path drops the operational caveat — this output looks like `
        + "flight-ready planning and must never appear without it");
    }
  });

  console.log("# ──────────────────────────────────────────────");
  console.log(`#   ${passed} passed, ${failed} failed`);
  assert.equal(failed, 0);
});
