// ============================================================
// Durability of account state.
//
// This host has an ephemeral disk: anything not written before SIGTERM, and
// not uploaded off-box, is gone for good on the next deploy. Saves are
// debounced by 250 ms, which is invisible in normal use and catastrophic at
// exactly the wrong moment — approve an operator, redeploy, and the account
// never existed.
//
// The shutdown path flushed the workspace store, the fleet registry and the
// trend tracker, and silently skipped accounts. So these tests assert the
// property that was missing rather than the code that was there: after a
// mutation, a flush must make it readable by a completely separate reader.
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "orbitiq-dur-"));
process.env.ORBITIQ_DATA_DIR = tmp;
const auth = await import("../src/auth.js");

const FILE = path.join(tmp, "auth.json");
/** Read the file the way a fresh process would — never via module state. */
const onDisk = () => { try { return JSON.parse(fs.readFileSync(FILE, "utf8")); } catch { return null; } };

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log(`#   ok    ${name}`); }
  catch (e) { failed++; console.log(`#   FAIL  ${name}\n#         ${e.message}`); throw e; }
}

console.log("# ── durability ────────────────────────────────");

test("account state survives an immediate shutdown", () => {

  check("auth exposes a flush", () => {
    assert.equal(typeof auth.flush, "function",
      "no flush export — the shutdown path has nothing to call, which is the original bug");
  });

  check("a brand-new account is on disk after flush", () => {
    const u = auth.createUser("ops@acme.test", "Ops", "pw-123456789", "user", null);
    assert.ok(u, "fixture user not created");
    auth.flush();
    const d = onDisk();
    assert.ok(d, "auth.json was never written");
    assert.ok(d.users.some(x => x.email === "ops@acme.test"),
      "the account is not on disk — a redeploy here loses it permanently");
  });

  check("an approval is on disk after flush", () => {
    const r = auth.requestAccess({
      email: "pilot@acme.test", name: "Pilot", phone: "+1 555 0100", position: "FD"
    });
    assert.ok(r.ok, JSON.stringify(r));
    const d0 = auth.decideRequest(r.request.id, true, "ws-1");
    assert.ok(!d0.error, JSON.stringify(d0));
    auth.flush();
    const d = onDisk();
    assert.ok(d.users.some(x => x.email === "pilot@acme.test"),
      "an approved operator is not on disk");
    assert.ok(d.requests.some(x => x.email === "pilot@acme.test" && x.status !== "pending"),
      "the request decision is not on disk");
  });

  check("a password reset is on disk after flush", () => {
    const u = auth.findUser("ops@acme.test");
    const before = onDisk().users.find(x => x.email === "ops@acme.test").passHash;
    auth.resetPassword(u.id);
    auth.flush();
    const after = onDisk().users.find(x => x.email === "ops@acme.test").passHash;
    assert.notEqual(after, before, "the new password hash never reached disk");
  });

  check("an email change is on disk after flush", () => {
    const u = auth.findUser("pilot@acme.test");
    const r = auth.changeEmail(u.id, "newpilot@acme.test");
    assert.ok(r.ok, JSON.stringify(r));
    auth.flush();
    const d = onDisk();
    assert.ok(d.users.some(x => x.email === "newpilot@acme.test"), "the new address is not on disk");
    assert.ok(!d.users.some(x => x.email === "pilot@acme.test"), "the old address is still on disk");
  });

  check("flush is idempotent and cheap when nothing changed", () => {
    auth.flush();
    const first = fs.statSync(FILE).mtimeMs;
    const wrote = auth.flush();
    assert.equal(wrote, false, "flush rewrote the file with no pending changes");
    assert.equal(fs.statSync(FILE).mtimeMs, first, "an unnecessary write touched the file");
  });

  check("the debounce genuinely delays the write, so flush is load-bearing", () => {
    // If saves were synchronous this test would be pointless — prove they are
    // not, so the flush above is doing real work rather than decorating it.
    const u = auth.createUser("late@acme.test", "Late", "pw-987654321", "user", null);
    assert.ok(u);
    const immediately = onDisk();
    assert.ok(!immediately.users.some(x => x.email === "late@acme.test"),
      "writes appear to be synchronous; if so the debounce was removed and this test needs revisiting");
    auth.flush();
    assert.ok(onDisk().users.some(x => x.email === "late@acme.test"),
      "flush did not persist the pending write");
  });

  console.log("# ──────────────────────────────────────────────");
  console.log(`#   ${passed} passed, ${failed} failed`);
  assert.equal(failed, 0);
});
