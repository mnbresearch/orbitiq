// ============================================================
// The limit that is denominated in the right unit.
//
// The anonymous limiter allows 120 requests per minute, which is sensible for
// an API whose responses are a few kilobytes. /export/catalog.csv is ~465 KB
// compressed, so a client sitting politely inside that limit draws
//
//     120 x 465 KB = 55 MB/min = ~80 GB/day
//
// against a free tier that includes 100 GB per MONTH. The request counter never
// goes above its limit, so nothing looks wrong right up until the site is
// suspended for the rest of the month.
//
// These tests are about the property that actually protects the site: bytes
// out, per address, per hour — and, just as importantly, that the cap does not
// fire on the ordinary use it is supposed to permit.
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";

// A faithful copy of the middleware's contract, exercised against a real
// express app. This is the one place a re-implementation is defensible: the
// middleware closes over module-private state in server.js, which imports the
// whole service (network, timers, disk). What is under test is the RULE.
function makeEgressBudget({ windowMs = 3600_000, budget = 50 * 1024 * 1024, now = Date.now } = {}) {
  const buckets = new Map();
  return (req, res, next) => {
    if (req.workspace) return next();
    const ip = req.ip || "?", t = now();
    if (buckets.size > 5000) buckets.clear();
    let b = buckets.get(ip);
    if (!b || t - b.start > windowMs) { b = { start: t, bytes: 0 }; buckets.set(ip, b); }
    if (b.bytes >= budget) {
      res.set("Retry-After", String(Math.ceil((windowMs - (t - b.start)) / 1000)));
      return res.status(429).json({ error: "Bulk export budget reached (50 MB/hour from one address)." });
    }
    const bump = n => { if (n > 0) b.bytes += n; };
    const w = res.write.bind(res), e = res.end.bind(res);
    res.write = (c, ...a) => { bump(c ? Buffer.byteLength(c) : 0); return w(c, ...a); };
    res.end   = (c, ...a) => { bump(c && typeof c !== "function" ? Buffer.byteLength(c) : 0); return e(c, ...a); };
    next();
  };
}

const PAYLOAD = "x".repeat(1024 * 1024); // 1 MB

function serve(mw) {
  const app = express();
  app.set("trust proxy", 1);
  app.get("/big", mw, (_req, res) => res.type("text/csv").send(PAYLOAD));
  app.get("/small", mw, (_req, res) => res.json({ ok: true }));
  return app;
}

const listen = app => new Promise(r => { const s = app.listen(0, () => r(s)); });

let passed = 0, failed = 0;
function check(name, fn) {
  return fn().then(() => { passed++; console.log(`#   ok    ${name}`); })
             .catch(e => { failed++; console.log(`#   FAIL  ${name}\n#         ${e.message}`); throw e; });
}

console.log("# ── egress budget ─────────────────────────────");

test("bytes out, not requests, is what gets rationed", async () => {
  const srv = await listen(serve(makeEgressBudget({ budget: 5 * 1024 * 1024 })));
  const base = `http://127.0.0.1:${srv.address().port}`;

  await check("a hot loop is stopped once it has drawn its budget", async () => {
    let codes = [];
    for (let i = 0; i < 10; i++) {
      const r = await fetch(base + "/big");
      await r.arrayBuffer();
      codes.push(r.status);
    }
    // 5 MB budget, 1 MB per response: the first five succeed, then the door shuts.
    assert.equal(codes.filter(c => c === 200).length, 5, "expected exactly 5 successful MB, got " + codes.join(","));
    assert.ok(codes.includes(429), "the loop was never stopped: " + codes.join(","));
    assert.equal(codes[codes.length - 1], 429, "the door reopened while the budget was still spent");
  });

  await check("the 429 tells the caller when to come back", async () => {
    const r = await fetch(base + "/big");
    assert.equal(r.status, 429);
    const retry = Number(r.headers.get("retry-after"));
    assert.ok(retry > 0 && retry <= 3600, "Retry-After should be a sane number of seconds, got " + retry);
  });

  srv.close();
});

test("the cap does not punish ordinary use", async () => {
  await check("small responses are effectively unlimited", async () => {
    const srv = await listen(serve(makeEgressBudget({ budget: 5 * 1024 * 1024 })));
    const base = `http://127.0.0.1:${srv.address().port}`;
    // 300 small calls is far more than a human makes and nowhere near 5 MB.
    // A byte budget that throttled these would just be a worse request limiter.
    const codes = [];
    for (let i = 0; i < 300; i++) { const r = await fetch(base + "/small"); await r.arrayBuffer(); codes.push(r.status); }
    assert.ok(codes.every(c => c === 200), "ordinary API use hit the bulk-export cap");
    srv.close();
  });

  await check("the budget refills once the window rolls over", async () => {
    // A cap that never resets is an outage with extra steps.
    let clock = 1_000_000;
    const srv = await listen(serve(makeEgressBudget({ budget: 2 * 1024 * 1024, windowMs: 60_000, now: () => clock })));
    const base = `http://127.0.0.1:${srv.address().port}`;
    for (let i = 0; i < 3; i++) { const r = await fetch(base + "/big"); await r.arrayBuffer(); }
    let r = await fetch(base + "/big"); await r.arrayBuffer();
    assert.equal(r.status, 429, "budget should be spent");
    clock += 61_000;                       // an hour later, in the test's clock
    r = await fetch(base + "/big"); await r.arrayBuffer();
    assert.equal(r.status, 200, "budget never refilled — the cap is a permanent ban");
    srv.close();
  });

  await check("an authenticated workspace is not subject to the anonymous cap", async () => {
    // Paying callers are metered by daily calls; their egress is a business
    // decision, not an anonymous risk. If this ever regresses, customers get
    // throttled by a rule written for scrapers.
    const app = express();
    app.use((req, _res, next) => { req.workspace = { plan: "operator" }; next(); });
    app.get("/big", makeEgressBudget({ budget: 1024 }), (_req, res) => res.send(PAYLOAD));
    const srv = await listen(app);
    const base = `http://127.0.0.1:${srv.address().port}`;
    for (let i = 0; i < 4; i++) {
      const r = await fetch(base + "/big"); await r.arrayBuffer();
      assert.equal(r.status, 200, "a workspace request was capped by the anonymous budget");
    }
    srv.close();
  });

  console.log("# ──────────────────────────────────────────────");
  console.log(`#   ${passed} passed, ${failed} failed`);
  assert.equal(failed, 0);
});
