// ============================================================
// Freshness of the served screening result.
//
// These tests are written against a real incident rather than an imagined one.
//
// On 4 September 2026 the Screening workflow began aborting with exit code 134
// — a heap out-of-memory — and did so for five consecutive runs. Throughout,
// the public snapshot went on serving 400 conjunctions and a tightest approach
// of 0.192 km, under a `generatedAt` field that showed the current time,
// because `generatedAt` was the time the RESPONSE was built rather than the
// time the SCREENING ran.
//
// Every check the service had was green. The feed fetch returned 200, because
// the JSON file was still sitting on the branch exactly where the last healthy
// run had left it. `reachable` was true. Nothing was reachable-but-wrong in a
// way any code path examined.
//
// So the tests below care about one property above all others: that an old or
// unknown-age result is never presented as a current one. A product whose
// claim is "we were watching" fails completely, and silently, the moment it
// can no longer tell the difference between a quiet sky and a stopped job.
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fresh from "../src/freshness.js";

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log(`#   ok    ${name}`); }
  catch (e) { failed++; console.log(`#   FAIL  ${name}\n#         ${e.message}`); throw e; }
}

const NOW = Date.parse("2026-09-04T06:30:00.000Z");
const hoursAgo = h => new Date(NOW - h * 3600000).toISOString();

console.log("# ── freshness of the served result ────────────");

test("the incident: a five-hour-old feed is not reported as current", () => {
  // Exactly the shape the screening worker publishes, with the timestamp the
  // last healthy run would have left behind.
  const published = {
    generatedAt: hoursAgo(5),
    events: new Array(400).fill(0).map((_, i) => ({ missKm: 0.192 + i })),
    screened: 400,
    windowHours: 24,
    thresholdKm: 50
  };
  const out = fresh.annotate(published, { now: NOW });

  check("it is flagged stale rather than served silently", () => {
    assert.equal(out.freshness.state, "stale",
      "a screening result five hours old was not flagged. This is the exact condition that "
      + "ran in production for five consecutive cycles while the endpoint reported 400 "
      + "conjunctions as though they were current");
    assert.equal(out.freshness.current, false);
  });

  check("the age is stated, not merely the fact of staleness", () => {
    assert.equal(out.freshness.ageHours, 5);
    assert.equal(out.asOf, hoursAgo(5),
      "asOf must carry the time the SCREENING ran. The bug was that the only timestamp in "
      + "the response was the time the response was built, which is always now");
  });

  check("the events survive annotation untouched", () => {
    assert.equal(out.events.length, 400,
      "annotate() must not disturb the payload; a freshness wrapper that drops data would "
      + "be a worse bug than the one it fixes");
    assert.equal(out.screened, 400);
  });

  check("the original object is not mutated", () => {
    assert.equal(published.freshness, undefined);
    assert.equal(published.asOf, undefined);
  });
});

test("a missing timestamp is unknown, never fresh", () => {
  check("null generatedAt yields unknown", () => {
    const f = fresh.assess({ generatedAt: null, now: NOW });
    assert.equal(f.state, "unknown",
      "data with no timestamp was treated as fresh. An absent timestamp has exactly the "
      + "same shape as a stopped pipeline, and defaulting it to 'current' would look "
      + "correct in every test and every demo while being wrong in the one case that matters");
    assert.equal(f.current, false);
    assert.equal(f.ageHours, null);
  });

  check("a malformed timestamp also yields unknown", () => {
    for (const bad of ["", "not a date", "2026-13-45T99:99:99Z", undefined, 0, NaN]) {
      const f = fresh.assess({ generatedAt: bad, now: NOW });
      assert.equal(f.state, "unknown", `"${String(bad)}" was parsed into a freshness verdict`);
      assert.equal(f.current, false);
    }
  });

  check("it says so in words a non-engineer can act on", () => {
    const f = fresh.assess({ generatedAt: null, now: NOW });
    assert.match(f.means, /stopped pipeline|unverified/i);
    assert.ok(!/current|up to date/i.test(f.summary),
      "the summary for unknown-age data hints that it is current");
  });
});

test("the boundaries land on the safe side", () => {
  check("inside tolerance is fresh", () => {
    const f = fresh.assess({ generatedAt: hoursAgo(2.4), now: NOW });
    assert.equal(f.state, "fresh");
    assert.equal(f.current, true);
  });

  check("scheduler drift is not reported as an outage", () => {
    // GitHub's scheduler fires 24-55 minutes late on this repo. An hourly job
    // running 55 minutes late is ~1.9 h since the last one; calling that an
    // outage would train everyone to ignore the indicator.
    const f = fresh.assess({ generatedAt: hoursAgo(1.9), now: NOW });
    assert.equal(f.state, "fresh",
      "ordinary scheduler drift was reported as staleness. An indicator that cries wolf on "
      + "normal operation is worse than no indicator, because it gets ignored during a real one");
  });

  check("past the tolerance is stale", () => {
    assert.equal(fresh.assess({ generatedAt: hoursAgo(3.01), now: NOW }).state, "stale");
  });

  check("far past it is down, not merely stale", () => {
    const f = fresh.assess({ generatedAt: hoursAgo(14), now: NOW });
    assert.equal(f.state, "down");
    assert.match(f.means, /revolutions/,
      "the 'down' wording should put the age in physical terms; 14 hours means nothing to a "
      + "reader until it is expressed as the number of orbits that have elapsed");
  });

  check("a future timestamp is not freshness", () => {
    const f = fresh.assess({ generatedAt: new Date(NOW + 4 * 3600000).toISOString(), now: NOW });
    assert.equal(f.state, "ahead",
      "a timestamp four hours in the future was accepted as fresh; that is a broken clock "
      + "on the producer, not evidence of currency");
    assert.equal(f.current, false);
  });

  check("small clock skew is tolerated rather than alarmed on", () => {
    const f = fresh.assess({ generatedAt: new Date(NOW + 60000).toISOString(), now: NOW });
    assert.equal(f.state, "fresh", "a minute of clock skew between two hosts is normal");
  });
});

test("the qualifying sentence never reassures about data it cannot vouch for", () => {
  // A keyword blacklist cannot do this job: the correct caveat for unknown-age
  // data is "not evidence that nothing was there", which contains the phrase
  // "nothing was there" while asserting its opposite. An earlier version of
  // this test failed on the very wording it was written to require.
  //
  // So the check is for asserted CURRENCY — the specific claim the incident
  // made falsely — rather than for words that happen to appear in caveats.
  const assertsCurrency = /\bis current\b|\bare current\b|\bup to date\b|\bas of now\b|\bpresently\b/i;

  check("stale data gets a sentence that limits the claim", () => {
    const q = fresh.qualify(fresh.assess({ generatedAt: hoursAgo(6), now: NOW }));
    assert.match(q, /describes that moment, not the present/i);
    assert.ok(!assertsCurrency.test(q), `stale qualifier asserts currency: "${q}"`);
  });

  check("unknown-age data gets the strongest caveat", () => {
    const q = fresh.qualify(fresh.assess({ generatedAt: null, now: NOW }));
    assert.match(q, /not evidence that nothing was there/i,
      "the whole product rests on distinguishing 'nothing was found' from 'nothing was "
      + "computed'; the caveat for unknown age must say so explicitly");
    assert.ok(!assertsCurrency.test(q));
  });

  check("only the fresh case is allowed to read as unqualified", () => {
    const q = fresh.qualify(fresh.assess({ generatedAt: hoursAgo(0.5), now: NOW }));
    assert.match(q, /Screened 30 minutes ago/,
      "even the fresh qualifier must state the age rather than simply asserting currency");
  });

  check("a null verdict does not throw and does not reassure", () => {
    const q = fresh.qualify(null);
    assert.ok(typeof q === "string" && q.length > 0);
    assert.ok(!assertsCurrency.test(q));
    assert.match(q, /could not be established/i,
      "a missing verdict must degrade to the unknown-age caveat, not to silence");
  });
});

test("ages are described in units that do not overstate precision", () => {
  check("sub-hour ages read as minutes", () => {
    assert.equal(fresh.describeAge(0.5), "30 minutes");
    assert.equal(fresh.describeAge(1 / 60 + 0.001), "1 minute");
  });

  check("multi-day ages read as days, not 73 hours", () => {
    assert.equal(fresh.describeAge(72), "3 days");
  });

  check("singulars are not '1 hours'", () => {
    assert.equal(fresh.describeAge(1), "1 hour");
    assert.equal(fresh.describeAge(24 * 1.4), "34 hours");
  });

  check("negative and nonsense ages do not produce garbage", () => {
    assert.equal(fresh.describeAge(-5), "less than a minute");
    assert.equal(fresh.describeAge(NaN), "less than a minute");
  });

  console.log("# ──────────────────────────────────────────────");
  console.log(`#   ${passed} passed, ${failed} failed`);
  assert.equal(failed, 0);
});
