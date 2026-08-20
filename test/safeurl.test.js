// ============================================================
// Outbound URL validation tests.
//
// The previous guard was a regex on the hostname string. It read as if it
// covered the private ranges, and for dotted-quad input it did — but
// http://2130706433/ is 127.0.0.1 written as an integer and sails straight
// through a string match. These cases are the ones a pattern check misses.
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { validateWebhookUrl } from "../src/safeurl.js";

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log(`#   ok    ${name}`); }
  catch (e) { failed++; console.log(`#   FAIL  ${name}\n#         ${e.message}`); throw e; }
}

const blocked = u => {
  const r = validateWebhookUrl(u);
  assert.ok(r.error, `expected ${u} to be rejected, got ${JSON.stringify(r)}`);
};
const allowed = u => {
  const r = validateWebhookUrl(u);
  assert.ok(r.ok, `expected ${u} to be accepted, got ${JSON.stringify(r)}`);
};

test("safeurl", () => {
  console.log("# ── outbound URL validation ────────────────────");

  check("accepts an ordinary https endpoint", () => {
    allowed("https://hooks.example.com/orbitiq");
    allowed("https://example.co.uk:8443/path?x=1");
  });

  check("rejects non-https schemes", () => {
    blocked("http://example.com/hook");
    blocked("ftp://example.com/hook");
    blocked("file:///etc/passwd");
    blocked("gopher://example.com/");
  });

  check("rejects dotted-quad private and loopback ranges", () => {
    ["https://127.0.0.1/", "https://10.1.2.3/", "https://192.168.0.1/",
     "https://172.16.0.1/", "https://172.31.255.255/", "https://169.254.169.254/",
     "https://0.0.0.0/", "https://100.64.0.1/"].forEach(blocked);
  });

  check("still allows public addresses adjacent to blocked ranges", () => {
    allowed("https://172.32.0.1/");   // just outside RFC1918
    allowed("https://172.15.0.1/");   // just below
    allowed("https://11.0.0.1/");
    allowed("https://8.8.8.8/");
  });

  // The whole point of the rewrite.
  check("rejects integer-encoded loopback", () => blocked("https://2130706433/"));
  check("rejects hex-encoded loopback", () => blocked("https://0x7f000001/"));
  check("rejects octal-encoded loopback", () => blocked("https://0177.0.0.1/"));
  check("rejects short-form loopback", () => {
    blocked("https://127.1/");
    blocked("https://127.0.1/");
  });
  check("rejects integer-encoded metadata endpoint", () => {
    // 169.254.169.254 = 2852039166
    blocked("https://2852039166/");
  });

  check("rejects IPv6 loopback and link-local", () => {
    ["https://[::1]/", "https://[::]/", "https://[fe80::1]/",
     "https://[fc00::1]/", "https://[fd12:3456::1]/"].forEach(blocked);
  });

  check("rejects IPv4-mapped IPv6 loopback", () => {
    blocked("https://[::ffff:127.0.0.1]/");
  });

  check("rejects internal-looking hostnames", () => {
    ["https://localhost/", "https://foo.localhost/", "https://printer.local/",
     "https://svc.internal/", "https://metadata.google.internal/"].forEach(blocked);
  });

  check("rejects credentials embedded in the URL", () => {
    blocked("https://user:pass@example.com/hook");
  });

  check("rejects multicast and reserved space", () => {
    blocked("https://224.0.0.1/");
    blocked("https://255.255.255.255/");
  });

  check("rejects empty, over-long and unparseable input", () => {
    blocked("");
    blocked("not a url");
    blocked("https://example.com/" + "a".repeat(400));
  });

  check("normalises the accepted URL rather than echoing raw input", () => {
    const r = validateWebhookUrl("https://Example.COM/Hook");
    assert.ok(r.ok);
    assert.match(r.url, /^https:\/\/example\.com\/Hook$/);
  });

  console.log("# ──────────────────────────────────────────────");
  console.log(`#   ${passed} passed, ${failed} failed`);
  assert.equal(failed, 0);
});
