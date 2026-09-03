// ============================================================
// Grants carry a security promise to two parties at once.
//
// The Underwriter tier is sold on a claim made to both sides of a transaction
// that do not trust each other:
//
//   to the operator — "your insurer can read this and cannot touch it"
//   to the verifier — "the operator cannot edit it either, and if they did,
//                      your own verification would catch it"
//
// Each of those collapses on a specific, easily-broken property. These tests
// pin them:
//
//   1. The raw token is never persisted. The archive is PUBLISHED to a public
//      branch, so storing a token would publish working credentials — this is
//      the same class of mistake that once put auth.json in the clear.
//   2. Revocation appends, never deletes. "You never gave me access" and "I
//      revoked that" are the two disputes a grants table must be able to
//      settle, and a deleted row settles neither.
//   3. Grants cannot be open-ended, and one workspace cannot revoke another's.
//   4. Digest verification must actually detect a tampered document. A
//      verifier tool that says "verified" regardless is worse than none.
//   5. The verifier surface exposes no write path. Checked against the source,
//      because the guarantee is the absence of code and absence is exactly
//      what a behavioural test cannot observe.
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "orbitiq-gr-"));
process.env.ORBITIQ_DATA_DIR = tmp;

const ledger = await import("../src/ledger.js");
const decisions = await import("../src/decisions.js");
const grants = await import("../src/grants.js");
const proof = await import("../src/proof.js");

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log(`#   ok    ${name}`); }
  catch (e) { failed++; console.log(`#   FAIL  ${name}\n#         ${e.message}`); throw e; }
}

const iso = ms => new Date(ms).toISOString();
const now = Date.now();
const actor = { id: "u1", email: "ops@acme.test" };

ledger.append("conjunction", [0, 1, 2].map(i => ({
  org: "acme", aOrg: "acme", bOrg: "other", aName: "ACME-" + i, bName: "DEB-" + i,
  aId: 8000 + i, bId: 9000 + i, tca: iso(now + (i + 6) * 3600e3),
  missKm: 0.4 + i, pc: [4e-4, 9e-5, 2e-6][i], pcMethod: "foster-2d", pcModel: "cov-v2-2026-09", risk: "HIGH"
})));
const w = ledger.query({ type: "conjunction", limit: 20 }).events.sort((a, b) => a.seq - b.seq);
decisions.record("ws-1", {
  warningSeq: w[0].seq, decision: "manoeuvre_executed", actor, org: "acme", policyThresholdPc: 1e-4,
  rationale: "Above threshold; burn flown at T-4h.", manoeuvre: { deltaVms: 0.05, propellantKg: 0.02 }
});

console.log("# ── grants ────────────────────────────────────");

test("a grant never persists the token it hands out", () => {
  const g = grants.issue("ws-1", {
    verifierName: "Syndicate 1234", scopes: ["conjunctions", "decisions"], days: 365, org: "acme", actor
  });
  check("the grant issues", () => assert.ok(g.ok, JSON.stringify(g)));

  check("the raw token appears nowhere in the archive", () => {
    const all = JSON.stringify(ledger.allEvents());
    assert.ok(!all.includes(g.token),
      "the token is stored in the archive, and the archive is published to a public branch — "
      + "this is the auth.json incident again, in a new costume");
  });

  check("a hash is stored instead, and it resolves", () => {
    const row = ledger.query({ type: "grant", limit: 10 }).events.find(x => x.grantId === g.grantId);
    assert.ok(row.tokenHash, "no tokenHash stored");
    assert.notEqual(row.tokenHash, g.token, "the 'hash' is the token verbatim");
    assert.equal(grants.resolve(g.token).ok, true, "the stored hash does not resolve the real token");
  });

  check("listing grants to the operator never leaks the hash either", () => {
    const listed = grants.listForWorkspace("ws-1");
    assert.ok(listed.length >= 1);
    for (const l of listed) {
      assert.ok(!("tokenHash" in l),
        "tokenHash is exposed on the operator listing; it is not a credential but it is "
        + "an offline-attackable one, and it has no business leaving the module");
    }
  });
});

test("access rights are bounded and cannot be open-ended", () => {
  check("an absurd duration is clamped, not honoured", () => {
    const g = grants.issue("ws-1", { verifierName: "Forever Ltd", days: 99999, org: "acme" });
    assert.ok(g.ok);
    const yrs = (new Date(g.expiresAt) - Date.now()) / (365 * 86400e3);
    assert.ok(yrs <= 2.01,
      `grant runs ${yrs.toFixed(1)} years; an access right nobody remembers issuing is one `
      + "nobody remembers revoking");
  });

  check("a grant with no scopes is refused", () => {
    const g = grants.issue("ws-1", { verifierName: "Empty Co", scopes: [], org: "acme" });
    assert.equal(g.ok, false);
  });

  check("an unnamed verifier is refused", () => {
    const g = grants.issue("ws-1", { verifierName: "", org: "acme" });
    assert.equal(g.ok, false);
    assert.match(g.error, /verifierName/,
      "a grant to an unnamed party cannot be audited, which defeats the purpose");
  });

  check("an unknown scope is refused rather than silently dropped", () => {
    const g = grants.issue("ws-1", { verifierName: "Typo Ltd", scopes: ["conjunctions", "everythng"], org: "acme" });
    assert.equal(g.ok, false);
    assert.match(g.error, /everythng/,
      "silently ignoring a misspelled scope gives the operator a grant they did not intend");
  });
});

test("revocation appends and is enforced", () => {
  const g = grants.issue("ws-1", { verifierName: "Renewal Broker", scopes: ["conjunctions"], org: "acme", actor });
  assert.ok(grants.resolve(g.token).ok, "grant should resolve before revocation");

  const before = ledger.allEvents().length;
  const rev = grants.revoke("ws-1", g.grantId, { actor, reason: "renewal complete" });

  check("revocation succeeds", () => assert.ok(rev.ok, JSON.stringify(rev)));

  check("the token stops working immediately", () => {
    const r = grants.resolve(g.token);
    assert.equal(r.ok, false);
    assert.match(r.error, /revoked/);
  });

  check("revocation ADDS a row rather than removing one", () => {
    assert.ok(ledger.allEvents().length > before,
      "revocation shrank or preserved the archive; deleting the grant erases the fact that "
      + "access once existed, which is the fact most likely to be disputed");
    assert.ok(ledger.query({ type: "grant", limit: 50 }).events.some(x => x.grantId === g.grantId),
      "the original grant row is gone");
  });

  check("the operator can still see it, marked revoked", () => {
    const l = grants.listForWorkspace("ws-1").find(x => x.grantId === g.grantId);
    assert.equal(l.status, "revoked");
  });

  check("another workspace cannot revoke it", () => {
    const g2 = grants.issue("ws-1", { verifierName: "Someone Else", org: "acme" });
    const bad = grants.revoke("ws-999", g2.grantId, { actor });
    assert.equal(bad.ok, false);
    assert.match(bad.error, /another workspace/);
  });
});

test("digest verification detects a document that does not match the archive", () => {
  const g = grants.issue("ws-1", {
    verifierName: "Checker LLP", scopes: ["conjunctions", "decisions"], org: "acme", actor
  });
  const grant = grants.resolve(g.token).grant;
  const data = proof.build({ org: "acme", ws: "ws-1", thresholdPc: 1e-4, operatorName: "ACME" });

  check("a genuine report reproduces its digest from the archive", () => {
    const v = grants.verifyReport({ grant, claimedDigest: data.reportDigest, thresholdPc: 1e-4 });
    assert.equal(v.matches, true,
      `recomputed ${v.recomputedDigest} but the report claims ${data.reportDigest}; the report `
      + "generator and the verifier disagree about the canonical form, which makes every "
      + "genuine document look forged");
  });

  check("a tampered digest is rejected", () => {
    const v = grants.verifyReport({ grant, claimedDigest: "deadbeef".repeat(4), thresholdPc: 1e-4 });
    assert.equal(v.matches, false,
      "a verifier that confirms any digest is worse than no verifier, because it launders "
      + "a forged document");
  });

  check("a mismatch explains the innocent explanation first", () => {
    const v = grants.verifyReport({ grant, claimedDigest: "deadbeef".repeat(4), thresholdPc: 1e-4 });
    assert.match(v.means, /window and threshold/i,
      "a report over a different period is legitimately a different digest; leading with "
      + "'forgery' would produce false accusations");
  });

  check("verification never claims the operator was correct, only that hashes agree", () => {
    const v = grants.verifyReport({ grant, claimedDigest: data.reportDigest, thresholdPc: 1e-4 });
    assert.match(v.means, /does not establish/i);
    assert.match(v.limits, /tamper-evident, not tamper-proof/i);
  });
});

test("the verifier API has no way to write", () => {
  const src = fs.readFileSync(path.join(ROOT, "src/verifierroutes.js"), "utf8");
  const verifierBlock = src.slice(src.indexOf("Verifier side"));

  check("no mutating HTTP verb is registered on the verifier path", () => {
    for (const verb of ["post", "put", "patch", "delete"]) {
      const re = new RegExp(`api\\.${verb}\\(\\s*"/verify`, "i");
      assert.ok(!re.test(src),
        `api.${verb} is registered on /verify. The tier is sold on a verifier being unable to `
        + "alter an operator's record; that guarantee should be the absence of a handler, not a flag");
    }
  });

  check("no verifier handler touches a write path", () => {
    // Belt and braces: even a GET could call something that appends.
    const i = verifierBlock.indexOf('api.get("/verify');
    assert.ok(i > 0, "no verifier routes found — the block markers moved");
    assert.ok(!/ledger\.append|audit\.record\(|grants\.issue\(|grants\.revoke\(|decisions\.record\(/.test(verifierBlock),
      "a verifier route calls something that writes; the guarantee is that holding a grant "
      + "token cannot change an operator's record by any path");
  });

  check("the grant token is never accepted from a query string", () => {
    assert.ok(!/req\.query\.token/.test(src),
      "a token in the URL ends up in proxy logs, browser history and referrer headers; "
      + "a bearer credential to someone else's evidence belongs in a header");
  });

  check("granting is on the operator path and requires the operator's own key", () => {
    assert.match(src, /api\.post\("\/grants",\s*requireWs/,
      "issuing a grant must authenticate as the operator — a verifier must never be able "
      + "to grant themselves access");
  });

  console.log("# ──────────────────────────────────────────────");
  console.log(`#   ${passed} passed, ${failed} failed`);
  assert.equal(failed, 0);
});
