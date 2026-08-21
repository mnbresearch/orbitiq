// ============================================================
// Sign-in history and email-address changes.
//
// Two things here are security-relevant rather than cosmetic:
//
//   1. `firstSignIn` decides whether a stranger gets a welcome email. It must
//      be true exactly once per account, ever. If it flickers back to true the
//      user is mailed "welcome" repeatedly, which is spam, and the fastest way
//      to get the sending domain filtered — costing us the credential mail that
//      actually matters.
//
//   2. Email IS the sign-in identifier. Changing it is an identity change, so
//      it has to stay unique across accounts and must not leave old sessions
//      alive: otherwise whoever held the previous address keeps a working
//      session on an account that is no longer theirs.
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// auth.js persists to DATA_DIR; point it somewhere disposable before import.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "orbitiq-auth-"));
process.env.ORBITIQ_DATA_DIR = tmp;

const auth = await import("../src/auth.js");

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log(`#   ok    ${name}`); }
  catch (e) { failed++; console.log(`#   FAIL  ${name}\n#         ${e.message}`); throw e; }
}

console.log("# ── sign-in history ───────────────────────────");

test("sign-in history and email changes", () => {
  const u = auth.createUser("pilot@example.com", "Test Pilot", "correct-horse-1", "user", null);
  assert.ok(u, "fixture user was not created");

  check("a wrong password does not count as a sign-in", () => {
    assert.equal(auth.login("pilot@example.com", "wrong"), null);
    assert.ok(!auth.getUser(u.id).signInCount, "a failed login incremented the counter");
  });

  check("the first successful sign-in reports firstSignIn", () => {
    const r = auth.login("pilot@example.com", "correct-horse-1");
    assert.ok(r, "login failed");
    assert.equal(r.firstSignIn, true);
  });

  check("the second sign-in does NOT report firstSignIn", () => {
    const r = auth.login("pilot@example.com", "correct-horse-1");
    assert.equal(r.firstSignIn, false, "welcome mail would be sent twice");
  });

  check("repeated sign-ins never flip firstSignIn back on", () => {
    for (let i = 0; i < 5; i++) {
      assert.equal(auth.login("pilot@example.com", "correct-horse-1").firstSignIn, false);
    }
    assert.equal(auth.getUser(u.id).signInCount, 7);
  });

  check("first and last sign-in timestamps are recorded", () => {
    const rec = auth.getUser(u.id);
    assert.ok(rec.firstSignInAt, "firstSignInAt missing");
    assert.ok(rec.lastSignInAt, "lastSignInAt missing");
    assert.ok(new Date(rec.lastSignInAt) >= new Date(rec.firstSignInAt));
  });

  console.log("# ── email changes ─────────────────────────────");

  check("rejects a malformed address", () => {
    for (const bad of ["", "nope", "a@b", "two @spaces.com", "x@y.", "@example.com"]) {
      assert.ok(auth.changeEmail(u.id, bad).error, `accepted ${JSON.stringify(bad)}`);
    }
  });

  check("rejects an address already in use by another account", () => {
    const other = auth.createUser("taken@example.com", "Other", "pw-12345678", "user", null);
    assert.ok(other);
    const r = auth.changeEmail(u.id, "TAKEN@example.com");
    assert.ok(r.error, "duplicate address was allowed — two accounts could share a login");
  });

  check("a live session exists before the change", () => {
    const r = auth.login("pilot@example.com", "correct-horse-1");
    assert.ok(auth.sessionUser(r.token), "session should be valid");
    globalThis.__tok = r.token;
  });

  check("the change succeeds and reports the previous address", () => {
    const r = auth.changeEmail(u.id, "  NewPilot@Example.COM  ");
    assert.ok(r.ok, r.error);
    assert.equal(r.previous, "pilot@example.com");
    assert.equal(r.email, "newpilot@example.com", "address should be normalised");
  });

  check("old sessions are revoked, so the previous holder loses access", () => {
    assert.equal(auth.sessionUser(globalThis.__tok), null,
      "a session survived the identity change");
  });

  check("the old address can no longer sign in", () => {
    assert.equal(auth.login("pilot@example.com", "correct-horse-1"), null);
  });

  check("the new address signs in with the unchanged password", () => {
    const r = auth.login("newpilot@example.com", "correct-horse-1");
    assert.ok(r, "new address could not sign in");
  });

  check("changing the address does not resurrect the welcome mail", () => {
    const r = auth.login("newpilot@example.com", "correct-horse-1");
    assert.equal(r.firstSignIn, false,
      "an email change made the account look new again — user would be re-welcomed");
  });

  check("the freed-up old address can be taken by someone else", () => {
    const reuse = auth.createUser("pilot@example.com", "Someone Else", "pw-87654321", "user", null);
    assert.ok(reuse, "the released address stayed blocked");
  });

  console.log("# ──────────────────────────────────────────────");
  console.log(`#   ${passed} passed, ${failed} failed`);
  assert.equal(failed, 0);
});
