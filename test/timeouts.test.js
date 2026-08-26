// ============================================================
// Outbound calls must be bounded.
//
// Measured in production: a cold /api/launches took 25.5 seconds. The upstream
// launch API had stalled, and the request sat through the ENTIRE fetch timeout
// before falling back to data that had been on disk the whole time. Nobody
// should wait 25 seconds to be handed a fallback.
//
// The webhook case is worse than slow, because the URL is customer-supplied:
// an endpoint that accepts the connection and never replies would pin a socket
// indefinitely, once per alert cycle, on a 512 MB instance.
//
// These are asserted against a server that deliberately never responds, since
// a timeout that is only tested against a fast server is not tested at all.
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log(`#   ok    ${name}`); }
  catch (e) { failed++; console.log(`#   FAIL  ${name}\n#         ${e.message}`); throw e; }
}

/** A server that accepts the connection and then says nothing, forever. */
function blackHole() {
  return new Promise(resolve => {
    const sockets = [];
    const srv = http.createServer((req, res) => { sockets.push(res); /* never respond */ });
    srv.listen(0, "127.0.0.1", () => resolve({
      url: `http://127.0.0.1:${srv.address().port}/`,
      close: () => { sockets.forEach(r => { try { r.destroy(); } catch {} }); srv.close(); }
    }));
  });
}

console.log("# ── outbound timeouts ─────────────────────────");

test("every outbound call is bounded", async () => {
  const src = {
    server: fs.readFileSync(path.join(ROOT, "server.js"), "utf8"),
    data:   fs.readFileSync(path.join(ROOT, "src/data.js"), "utf8"),
    safe:   fs.readFileSync(path.join(ROOT, "src/safeurl.js"), "utf8")
  };

  check("the customer webhook fetch has a timeout", () => {
    const i = src.server.indexOf("fetch(ws.webhook, {");
    assert.ok(i > 0, "webhook fetch not found");
    const call = src.server.slice(i, i + 400);
    assert.match(call, /AbortSignal\.timeout\(/,
      "a customer-supplied URL is fetched with no timeout; an endpoint that never "
      + "responds pins a socket indefinitely");
  });

  check("safeFetch bounds the whole redirect chain, not just each hop", () => {
    assert.match(src.safe, /const deadline = Date\.now\(\) \+ budgetMs/,
      "no whole-chain deadline: a server stalling just under a per-hop limit on "
      + "every hop multiplies the total wait by the hop count");
    assert.match(src.safe, /if \(left <= 0\) return/, "the deadline is never enforced");
  });

  check("the default upstream timeout is seconds, not half a minute", () => {
    const m = src.data.match(/async function fetchJson\(url, ms = (\d+)\)/);
    assert.ok(m, "fetchJson signature not found");
    assert.ok(+m[1] <= 10000,
      `default fetch timeout is ${m[1]}ms; that is a request-path wait for data that is decorative if missing`);
  });

  check("stale data is served immediately rather than after a timeout", () => {
    assert.match(src.data, /Stale-while-revalidate/,
      "no stale-while-revalidate path — an expired cache still means the caller waits for upstream");
    // The return of stale must come BEFORE the blocking primary fetch.
    const staleReturn = src.data.indexOf("return stale;");
    const primary = src.data.indexOf("// 1. primary source");
    assert.ok(staleReturn > 0 && primary > 0, "could not locate both paths");
    assert.ok(staleReturn < primary,
      "the stale return must short-circuit before the blocking fetch, or it changes nothing");
  });

  check("a concurrent-refresh guard exists so a burst is one upstream call", () => {
    assert.match(src.data, /refreshing\.has\(key\)/,
      "without coalescing, N stale requests trigger N upstream fetches");
  });

  // ── behavioural: prove a hanging server is actually escaped ──
  const bh = await blackHole();
  try {
    const t0 = Date.now();
    let threw = false;
    try {
      await fetch(bh.url, { signal: AbortSignal.timeout(900) });
    } catch { threw = true; }
    const elapsed = Date.now() - t0;

    check("a hanging endpoint aborts near its deadline", () => {
      assert.ok(threw, "the request never aborted against a server that never responds");
      assert.ok(elapsed < 4000, `took ${elapsed}ms to give up on a hung endpoint`);
    });

    const { safeFetch } = await import("../src/safeurl.js");
    const t1 = Date.now();
    const r = await safeFetch(bh.url, {}, 3, 1200).catch(e => ({ ok: false, threw: e.message }));
    const elapsed2 = Date.now() - t1;

    check("safeFetch gives up within its budget against a hung endpoint", () => {
      assert.ok(!r.ok, "safeFetch reported success against a server that never responded");
      assert.ok(elapsed2 < 5000,
        `safeFetch took ${elapsed2}ms with a 1200ms budget — the deadline is not being applied`);
    });
  } finally {
    bh.close();
  }

  console.log("# ──────────────────────────────────────────────");
  console.log(`#   ${passed} passed, ${failed} failed`);
  assert.equal(failed, 0);
});
