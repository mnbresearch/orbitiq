// ============================================================
// The documented API surface must actually exist.
//
// ── The defect this pins down ───────────────────────────────
// The service advertises itself as "API: /api/v1" on boot, the docs page
// documents /api/v1/... paths, and every one of them returned 404. Only the
// unversioned /api/... paths worked.
//
// The cause was mount order:
//
//     api.use(<404 handler>);        // router's own catch-all
//     app.use("/api",    api);       // matches FIRST
//     app.use("/api/v1", api);       // never reached
//
// A request for /api/v1/health matches the "/api" mount, Express strips that
// prefix and hands the router "/v1/health". No such route exists, so the
// router's own 404 answers — and because it ANSWERS, Express never falls
// through to the "/api/v1" mount underneath. The versioned namespace was
// shadowed by the unversioned one.
//
// This is exactly the kind of bug that source review misses: both lines are
// individually correct and the intent is obvious. Only a request finds it. So
// this test spawns the real server and makes real requests, rather than
// asserting on the shape of the source.
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8100 + Math.floor(Math.random() * 300);
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "orbitiq-api-"));

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log(`#   ok    ${name}`); }
  catch (e) { failed++; console.log(`#   FAIL  ${name}\n#         ${e.message}`); throw e; }
}

/** Boot the real server and wait until it is actually answering. */
function boot() {
  const child = spawn(process.execPath, [path.join(ROOT, "server.js")], {
    env: {
      ...process.env,
      PORT: String(PORT),
      ORBITIQ_DATA_DIR: DATA,
      // Keep the boot quiet and deterministic: no local screening compute, no
      // outbound backup attempts from a test run.
      ORBITIQ_ALLOW_LOCAL_SCREEN: "0",
      ORBITIQ_ADMIN_EMAIL: "test@orbitiq.local",
      ORBITIQ_ADMIN_PASSWORD: "test-password-not-a-secret"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout.on("data", () => {});
  child.stderr.on("data", () => {});
  return child;
}

async function waitReady(ms = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/api/health`, { signal: AbortSignal.timeout(1500) });
      if (r.ok) return true;
    } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 300));
  }
  return false;
}

console.log("# ── API surface ───────────────────────────────");

test("both the versioned and unversioned API namespaces work", async () => {
  const child = boot();
  try {
    const ready = await waitReady();
    assert.ok(ready, `server did not become ready on port ${PORT}`);

    const get = async (p) => {
      const r = await fetch(`http://127.0.0.1:${PORT}${p}`, { signal: AbortSignal.timeout(8000) });
      return { status: r.status, body: await r.text() };
    };

    // The paths below are the ones the docs page and the witness workflow use.
    // If any of these 404s, something outside this repo breaks.
    const paths = ["/health", "/plans", "/archive/stats", "/archive/verify", "/snapshot"];

    for (const p of paths) {
      const un = await get(`/api${p}`);
      const ver = await get(`/api/v1${p}`);

      check(`GET /api/v1${p} is not a 404`, () => {
        assert.notEqual(ver.status, 404,
          `/api/v1${p} returned 404 while /api${p} returned ${un.status}; the versioned `
          + "namespace is shadowed — check the order of the app.use mounts");
      });

      check(`GET /api${p} and /api/v1${p} agree`, () => {
        assert.equal(ver.status, un.status,
          `/api${p} -> ${un.status} but /api/v1${p} -> ${ver.status}; the same router is `
          + "mounted at both prefixes, so they must behave identically");
      });
    }

    // Fetch first, then assert synchronously — `check` is sync, so handing it a
    // promise would report a pass before the assertion inside had run.
    const unknownUn = await get("/api/definitely-not-a-route");
    const unknownVer = await get("/api/v1/definitely-not-a-route");

    check("an unknown route still 404s under BOTH prefixes", () => {
      // The fix must not have been to simply delete the catch-all.
      assert.equal(unknownUn.status, 404, "unknown /api route should 404");
      assert.equal(unknownVer.status, 404, "unknown /api/v1 route should 404");
    });

    // ── the public snapshot ──────────────────────────────────
    // Timed, because the whole reason this endpoint exists is latency.
    const snapT0 = Date.now();
    const snap = await get("/api/v1/snapshot");
    const snapMs = Date.now() - snapT0;

    check("the public snapshot returns a usable payload", () => {
      assert.equal(snap.status, 200, `snapshot returned ${snap.status}: ${snap.body.slice(0, 200)}`);
      const j = JSON.parse(snap.body);
      for (const k of ["generatedAt", "catalogue", "archive", "integrity", "conjunctions"]) {
        assert.ok(k in j, `snapshot is missing "${k}"`);
      }
    });

    check("the snapshot never claims an empty sky while the catalogue is loading", () => {
      const j = JSON.parse(snap.body);
      // Reporting total: 0 during warm-up would read as a real measurement.
      if (j.catalogue.status !== "ok") {
        assert.equal(j.catalogue.total, undefined,
          "a warming catalogue must not report a total; zero objects is a claim, not a placeholder");
      }
    });

    check("the snapshot carries its own integrity limits", () => {
      const j = JSON.parse(snap.body);
      assert.match(j.integrity.limits, /Tamper-evident, not tamper-proof/,
        "the honesty caveat must travel with the claim, not sit only on the marketing page");
      assert.ok(j.integrity.checkYourself,
        "a verification claim with no way for the reader to check it is worthless");
    });

    check("the snapshot answers promptly even with a cold catalogue", () => {
      // This endpoint exists so the landing page does not wait on a waking
      // instance. It used to `await getSatellites()` unbounded, which on a cold
      // start can take tens of seconds — CI caught it aborting at 8 s. The
      // catalogue is decorative here; the archive figures are the point.
      assert.ok(snapMs < 6000,
        `/snapshot took ${snapMs} ms on a cold instance. It must not block on the `
        + "catalogue fetch — report a warming catalogue instead");
    });

    const second = await get("/api/v1/snapshot");

    check("the snapshot is cached rather than recomputed per request", () => {
      // verify() walks the whole chain; uncached that is a free CPU-amplifier
      // on an unauthenticated endpoint.
      assert.equal(JSON.parse(second.body).cached, true,
        "the second call was not served from cache — an unauthenticated endpoint "
        + "that re-walks the hash chain on every request is a denial-of-service lever");
    });

  } finally {
    child.kill("SIGKILL");
    try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* best effort */ }
  }

  console.log("# ──────────────────────────────────────────────");
  console.log(`#   ${passed} passed, ${failed} failed`);
  assert.equal(failed, 0);
});
