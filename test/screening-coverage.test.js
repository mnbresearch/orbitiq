// ============================================================
// The worker must publish every screen the server can ask for.
//
// This test exists because of a specific outage. The intelligence sweep asked
// runScreening() for `(org, 3, 10)`. The offline worker only published
// `(org, 12, 25)`. The lookup missed, execution fell through to computing the
// screen inside the web process, and the resulting multi-second synchronous
// SGP4 run blew through Render's 5-second health-check budget. The instance
// was killed and restarted — 5 minutes after every boot, because that is the
// sweep's start delay. Roughly ten restarts an hour, and every symptom pointed
// at the platform rather than at a two-number mismatch in a parameter list.
//
// Nothing about that was visible in a code review: both files were correct in
// isolation. The coupling only exists at runtime, through a cache key. So it
// gets asserted here instead.
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const server = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
const worker = fs.readFileSync(path.join(ROOT, "scripts/screen.mjs"), "utf8");

/** Literal `runScreening(<org>, <hours>, <km>)` calls in the server. */
function serverLiteralPairs() {
  const out = [];
  const re = /runScreening\(\s*([A-Za-z0-9_.]+)\s*,\s*(\d+)\s*,\s*(\d+)\s*[,)]/g;
  let m;
  while ((m = re.exec(server))) {
    out.push({ scope: m[1] === "null" ? "all" : "org", hours: +m[2], km: +m[3] });
  }
  return out;
}

/** `{ org: ..., hours: N, km: N }` job entries in the worker. */
function workerPairs() {
  const out = [];
  const re = /\{\s*org:\s*([A-Za-z0-9_.]+)\s*,\s*hours:\s*(\d+)\s*,\s*km:\s*(\d+)\s*\}/g;
  let m;
  while ((m = re.exec(worker))) {
    out.push({ scope: m[1] === "null" ? "all" : "org", hours: +m[2], km: +m[3] });
  }
  return out;
}

const key = p => `${p.scope}|${p.hours}|${p.km}`;

test("every screen the server asks for is published by the worker", () => {
  const asked = serverLiteralPairs();
  const published = new Set(workerPairs().map(key));

  assert.ok(asked.length >= 3, `expected to find runScreening call sites, found ${asked.length}`);
  assert.ok(published.size >= 4, `expected worker jobs, found ${published.size}`);

  const missing = [...new Set(asked.map(key))].filter(k => !published.has(k));
  assert.deepEqual(missing, [],
    `server asks for screens the worker never publishes: ${missing.join(", ")}. `
    + "Add them to the jobs list in scripts/screen.mjs, or the lookup misses at runtime.");
});

test("the web instance refuses to compute a screen unless explicitly allowed", () => {
  // The guard is what turns a missing screen into a visible "warming" response
  // instead of a killed instance. If someone removes it, the boot loop returns.
  assert.match(server, /ALLOW_LOCAL_SCREEN/,
    "the local-screen guard is gone; runScreening can block the event loop again");
  assert.match(server, /if\s*\(\s*!ALLOW_LOCAL_SCREEN\s*\)/,
    "expected runScreening to return early when local screening is disabled");
  // Default must be off. Production must never opt in.
  assert.match(server, /ORBITIQ_ALLOW_LOCAL_SCREEN\s*===\s*"1"/,
    "local screening must be opt-in via an explicit env value, not on by default");
});

test("the guard sits before the compute path, not after it", () => {
  const guard = server.indexOf("if (!ALLOW_LOCAL_SCREEN)");
  const compute = server.indexOf("return screenConjunctions(sats, org, h, t");
  assert.ok(guard > 0 && compute > 0, "could not locate guard or compute path");
  assert.ok(guard < compute,
    "the guard must come before the synchronous screenConjunctions call to protect the event loop");
});
