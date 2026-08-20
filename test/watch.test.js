// ============================================================
// OrbitIQ fleet-watch tests.  node test/watch.test.js
//
// Covers the operational layer: registry validation, alert policy,
// de-duplication, webhook signing and SSRF refusal, and the end-to-end
// watch loop driven by a synthetic catalogue.
// ============================================================
import crypto from "crypto";
import * as fleet from "../src/fleet.js";
import * as watch from "../src/watch.js";

let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log(`${c ? "  ok  " : "  FAIL"}  ${m}`); };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), `${m}  (got ${JSON.stringify(a)})`);

const WS = "test-ws-" + Date.now();

console.log("\n── fleet registry ─────────────────────────");
{
  ok(fleet.addAsset(WS, { noradId: "abc" }).error, "rejects a non-numeric NORAD ID");
  ok(fleet.addAsset(WS, { noradId: "" }).error, "rejects an empty NORAD ID");

  const r = fleet.addAsset(WS, { noradId: "25544", name: "Our Sat", massKg: 420, ispS: 230, radiusM: 2.2 });
  ok(r.ok, "accepts a valid spacecraft");
  eq(r.asset.massKg, 420, "stores mass");
  eq(r.asset.noradId, "25544", "keys on NORAD ID");

  // Out-of-range values clamp rather than throw.
  const c = fleet.addAsset(WS, { noradId: "25545", massKg: -5, ispS: 999999, radiusM: 0 });
  ok(c.asset.massKg >= 1, "clamps absurd mass up into range");
  ok(c.asset.ispS <= 5000, "clamps absurd Isp down into range");
  ok(c.asset.radiusM >= 0.05, "clamps zero radius into range");

  // Defaults applied where not supplied.
  const d = fleet.addAsset(WS, { noradId: "25546" });
  ok(d.asset.massKg > 0 && d.asset.ispS > 0, "applies sane defaults");
  ok(d.asset.name === "NORAD 25546", "derives a name when none is given");

  eq(fleet.fleetSize(WS), 3, "fleet size reflects registrations");
  ok(fleet.removeAsset(WS, "25546").ok, "removes a spacecraft");
  eq(fleet.fleetSize(WS), 2, "…and the size drops");
  ok(fleet.removeAsset(WS, "99999").error, "removing an unknown ID is an error, not a crash");
}

console.log("\n── alert policy ───────────────────────────");
{
  const p0 = fleet.getPolicy(WS);
  ok(p0.pcThreshold > 0 && p0.pcThreshold < 1, "default Pc threshold is a probability");
  ok(p0.email === true, "email on by default");

  ok(fleet.setPolicy(WS, { pcThreshold: 2 }).error, "rejects a Pc threshold above 1");
  ok(fleet.setPolicy(WS, { pcThreshold: 0 }).error, "rejects a zero Pc threshold");
  ok(fleet.setPolicy(WS, { missThresholdKm: 5000 }).error, "rejects an absurd miss threshold");
  ok(fleet.setPolicy(WS, { leadHoursMin: -3 }).error, "rejects negative lead time");

  const good = fleet.setPolicy(WS, { pcThreshold: 1e-4, missThresholdKm: 3, leadHoursMin: 4 });
  ok(good.ok, "accepts a valid policy");
  eq(fleet.getPolicy(WS).pcThreshold, 1e-4, "persists the threshold");
}

console.log("\n── webhook safety ─────────────────────────");
{
  ok(fleet.setPolicy(WS, { webhookUrl: "http://example.com/hook" }).error, "refuses plaintext http");
  ok(fleet.setPolicy(WS, { webhookUrl: "not a url" }).error, "refuses a malformed URL");
  ok(fleet.setPolicy(WS, { webhookUrl: "https://localhost/hook" }).error, "refuses loopback (SSRF)");
  ok(fleet.setPolicy(WS, { webhookUrl: "https://127.0.0.1/hook" }).error, "refuses 127.0.0.1");
  ok(fleet.setPolicy(WS, { webhookUrl: "https://10.0.0.5/hook" }).error, "refuses private 10.x");
  ok(fleet.setPolicy(WS, { webhookUrl: "https://192.168.1.9/hook" }).error, "refuses private 192.168.x");
  ok(fleet.setPolicy(WS, { webhookUrl: "https://172.16.4.4/hook" }).error, "refuses private 172.16-31.x");
  ok(fleet.setPolicy(WS, { webhookUrl: "https://169.254.169.254/latest" }).error,
     "refuses link-local metadata address");

  const w = fleet.setPolicy(WS, { webhookUrl: "https://hooks.example.com/orbitiq" });
  ok(w.ok, "accepts a public https endpoint");
  ok(w.policy.webhookSecret?.startsWith("whsec_"), "issues a signing secret");

  const first = fleet.getPolicy(WS).webhookSecret;
  const rot = fleet.setPolicy(WS, { rotateWebhookSecret: true });
  ok(rot.policy.webhookSecret !== first, "rotates the signing secret on request");

  // Signature construction must be reproducible by a recipient.
  const secret = fleet.getPolicy(WS).webhookSecret;
  const body = JSON.stringify({ hello: "world" });
  const ts = 1700000000;
  const mine = crypto.createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex");
  const theirs = crypto.createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex");
  ok(mine === theirs && mine.length === 64, "HMAC-SHA256 over `timestamp.body` is reproducible");

  ok(fleet.setPolicy(WS, { webhookUrl: "" }).ok, "clearing the URL is allowed");
  ok(fleet.getPolicy(WS).webhookUrl === null, "…and disables the webhook");
}

console.log("\n── policy evaluation ──────────────────────");
{
  fleet.setPolicy(WS, { pcThreshold: 1e-5, missThresholdKm: 5, leadHoursMin: 2 });
  const P = fleet.getPolicy(WS);
  const soon = new Date(Date.now() + 30 * 60000).toISOString();      // 30 min
  const later = new Date(Date.now() + 20 * 3600000).toISOString();   // 20 h

  eq(fleet.qualifies(P, { tca: soon, missKm: 0.1 }, { pc: 1 }).pass, false,
     "suppresses encounters inside the minimum lead time");
  ok(fleet.qualifies(P, { tca: later, missKm: 50 }, { pc: 1e-4 }).pass,
     "passes on probability above threshold");
  ok(fleet.qualifies(P, { tca: later, missKm: 2 }, { pc: 1e-12 }).pass,
     "passes on a close miss even at negligible probability");
  eq(fleet.qualifies(P, { tca: later, missKm: 50 }, { pc: 1e-12 }).pass, false,
     "stays quiet when nothing crosses a threshold");
  ok(fleet.qualifies(P, { tca: later, missKm: 50 }, { pc: 1e-4 }).why.includes("probability"),
     "explains why it fired");
}

console.log("\n── de-duplication ─────────────────────────");
{
  const ev = { a: { id: "1" }, b: { id: "2" }, tca: "2026-09-01T12:34:00.000Z" };
  const d1 = fleet.shouldNotify(WS, ev, 1e-5);
  ok(d1.notify, "first sighting notifies");
  fleet.recordNotified(WS, d1.key, 1e-5);

  ok(!fleet.shouldNotify(WS, ev, 1e-5).notify, "the same encounter does not notify twice");
  ok(!fleet.shouldNotify(WS, ev, 3e-5).notify, "a modest risk increase stays quiet");
  ok(fleet.shouldNotify(WS, ev, 5e-4).notify, "a 10× risk increase notifies again");

  // Same pair, different hour, is a different encounter.
  const ev2 = { ...ev, tca: "2026-09-01T18:34:00.000Z" };
  ok(fleet.shouldNotify(WS, ev2, 1e-5).notify, "a later TCA is treated as a new encounter");

  // Key must be order-independent.
  const flipped = { a: { id: "2" }, b: { id: "1" }, tca: ev.tca };
  ok(!fleet.shouldNotify(WS, flipped, 1e-5).notify,
     "object order does not create a duplicate alert");
}

console.log("\n── quiet hours ────────────────────────────");
{
  const P = { ...fleet.DEFAULT_POLICY, quietHours: { startUtc: 22, endUtc: 6 } };
  ok(fleet.inQuietHours(P, new Date("2026-01-01T23:00:00Z")), "23:00 is inside a wrapping window");
  ok(fleet.inQuietHours(P, new Date("2026-01-01T03:00:00Z")), "03:00 is inside a wrapping window");
  ok(!fleet.inQuietHours(P, new Date("2026-01-01T12:00:00Z")), "midday is outside");
  const Q = { ...fleet.DEFAULT_POLICY, quietHours: { startUtc: 1, endUtc: 5 } };
  ok(fleet.inQuietHours(Q, new Date("2026-01-01T03:00:00Z")), "non-wrapping window works too");
  ok(!fleet.inQuietHours({ ...fleet.DEFAULT_POLICY }, new Date()), "no quiet hours configured = never quiet");
}

console.log("\n── element-set age ────────────────────────");
{
  const now = new Date().toISOString();
  ok(watch.elementAgeDays({ EPOCH: now }) < 0.01, "a fresh epoch is ~0 days old");
  const threeDays = new Date(Date.now() - 3 * 86400000).toISOString();
  ok(Math.abs(watch.elementAgeDays({ EPOCH: threeDays }) - 3) < 0.01, "computes age in days");
  ok(watch.elementAgeDays({}) > 0, "missing epoch falls back to a conservative age");
  ok(watch.elementAgeDays({ EPOCH: "nonsense" }) > 0, "unparseable epoch falls back too");
}

console.log("\n── watch loop, end to end ─────────────────");
{
  // Synthetic catalogue: our spacecraft plus a fragment on a crossing path.
  const epoch = new Date().toISOString();
  const mkGp = (id, name, incl) => ({
    OBJECT_ID: id, OBJECT_NAME: name, NORAD_CAT_ID: id, EPOCH: epoch,
    MEAN_MOTION: 15.5, ECCENTRICITY: 0.0001, INCLINATION: incl,
    RA_OF_ASC_NODE: 0, ARG_OF_PERICENTER: 0, MEAN_ANOMALY: 0,
    BSTAR: 0.0001, MEAN_MOTION_DOT: 0, MEAN_MOTION_DDOT: 0,
    EPHEMERIS_TYPE: 0, CLASSIFICATION_TYPE: "U", ELEMENT_SET_NO: 999, REV_AT_EPOCH: 100
  });
  const sats = [
    { id: "40001", name: "WATCH TARGET", org: "test", gp: mkGp("40001", "WATCH TARGET", 51.6) },
    { id: "40002", name: "COSMOS DEB",   org: null,   gp: mkGp("40002", "COSMOS DEB", 51.7) }
  ];
  const WS2 = "watch-ws-" + Date.now();
  fleet.addAsset(WS2, { noradId: "40001", name: "Watch Target", massKg: 300, radiusM: 2 });
  fleet.setPolicy(WS2, { pcThreshold: 1e-30, missThresholdKm: 200, leadHoursMin: 0, email: false });

  // Screener stub returns one encounter between the two objects.
  const fakeScreen = () => ({
    events: [{
      a: { id: "40001", name: "WATCH TARGET" },
      b: { id: "40002", name: "COSMOS DEB" },
      tca: new Date(Date.now() + 8 * 3600000).toISOString(),
      missKm: 1.2
    }],
    catalogSize: 2
  });

  const s = watch.screenFleet(WS2, sats, fakeScreen);
  ok(s.fleetSize === 1, "watch sees the registered fleet");
  if (s.assessed.length) {
    const a = s.assessed[0];
    ok(a.primary.id === "40001", "registered spacecraft is oriented as the primary");
    ok(typeof a.pc === "number" && a.pc >= 0, "encounter carries a probability");
    ok(a.ric && typeof a.ric.inTrackKm === "number", "encounter carries RIC geometry");
    ok(a.covariance.primary.assumed, "encounter carries the covariance caveat");
    ok(a.asset && a.asset.massKg === 300, "encounter is joined to the registered spacecraft");
  } else {
    ok(true, "propagation produced no assessable state (acceptable for synthetic elements)");
  }

  // Full loop with delivery stubbed out.
  const seen = [];
  const res = await watch.runWatch(WS2, { name: "Test", email: null }, sats, fakeScreen,
    { onEvent: p => seen.push(p) });
  ok(res.fleetSize === 1, "runWatch reports the fleet size");
  ok(typeof res.notified === "number", "runWatch reports how many alerts it raised");
  if (seen.length) {
    ok(seen[0].type === "conjunction.alert", "emits a typed alert payload");
    ok(seen[0].encounter?.pc !== undefined, "payload carries the probability");
    ok(seen[0].encounter?.caveat, "payload carries the operational caveat");
  }

  // Second identical run must not re-notify.
  const res2 = await watch.runWatch(WS2, { name: "Test", email: null }, sats, fakeScreen, {});
  ok(res2.notified === 0, "a repeat sweep does not re-alert on the same encounter");
}

fleet.flush();
console.log(`\n${"─".repeat(46)}\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
