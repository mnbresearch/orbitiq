// ============================================================
// The two consoles hold the same promises the API holds.
//
// The grant system's security properties are enforced and tested server-side.
// But a verifier never touches the API directly — they touch verify.html, and
// an operator issues access from evidence.html. A UI can quietly undo a
// server-side guarantee: put the token in a URL "to make sharing easier",
// stash it in localStorage "so they don't have to paste it twice", or round
// the server's careful "the hashes agree" up to a green "VERIFIED".
//
// None of those would fail a server test. They are exactly the changes a
// future edit makes for good usability reasons, which is why they are pinned
// here against the shipped source.
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const verify = fs.readFileSync(path.join(ROOT, "public/verify.html"), "utf8");
const evidence = fs.readFileSync(path.join(ROOT, "public/evidence.html"), "utf8");

// These files argue with themselves in comments — the reasoning for a rule
// necessarily quotes the thing the rule forbids. Scanning raw source therefore
// fails on its own explanation, so the checks below run against two derived
// views: the executable code, and the words a reader actually sees.
const codeOf = src => src
  .replace(/<!--[\s\S]*?-->/g, "")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n").map(l => l.replace(/(^|\s)\/\/.*$/, "$1")).join("\n");

const proseOf = src => src
  .replace(/<!--[\s\S]*?-->/g, "")
  .replace(/<script[\s\S]*?<\/script>/gi, "")
  .replace(/<style[\s\S]*?<\/style>/gi, "")
  .replace(/<[^>]+>/g, " ")
  .replace(/\s+/g, " ");

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log(`#   ok    ${name}`); }
  catch (e) { failed++; console.log(`#   FAIL  ${name}\n#         ${e.message}`); throw e; }
}

console.log("# ── verifier console ──────────────────────────");

test("the verifier console never puts a grant token where it can be logged", () => {
  check("the token is sent as a header, not a query parameter", () => {
    assert.match(verify, /"X-Grant-Token"/,
      "the console does not send the grant header at all");
    assert.ok(!/[?&]token=/.test(codeOf(verify)),
      "the console builds a token into a URL. The server refuses ?token= precisely so this "
      + "credential stays out of proxy logs, browser history and referrer headers — a UI that "
      + "did it anyway would teach verifiers the habit on some other system that accepts it");
  });

  check("the token is not written to durable browser storage", () => {
    assert.ok(!/localStorage\.(setItem|getItem)\(\s*["'`]orbitiq-grant/.test(verify),
      "the grant is kept in localStorage. This is a bearer credential to ANOTHER organisation's "
      + "record, and underwriters work on shared and managed machines: access should end with "
      + "the tab, not outlive the review by months");
    assert.match(verify, /sessionStorage/,
      "expected the token to be held in sessionStorage for the tab only");
  });

  check("the page is not indexable", () => {
    assert.match(verify, /name="robots"\s+content="noindex"/,
      "a page that renders another operator's conjunction record should not be in a search index");
  });
});

test("the verifier console states no conclusion the server did not state", () => {
  check("the verdict renders the server's own wording", () => {
    // v.means and v.limits are the API's carefully hedged sentences. The UI is
    // allowed to display them; it is not allowed to write its own.
    assert.match(verify, /esc\(v\.means\)/, "the verdict does not render the server's `means`");
    assert.match(verify, /esc\(v\.limits\)/, "the verdict does not render the server's `limits`");
  });

  check("a match is never described as certifying anything", () => {
    // Only what a reader sees, and only words that assert a conclusion the
    // archive cannot reach. "guarantee" is fine and wanted — the footer is
    // headed "Scope of the guarantee" — so it is not on this list; the words
    // here are the ones that would turn "the hashes agree" into a verdict.
    const prose = proseOf(verify).replace(/tamper-evident, not tamper-proof/gi, "");
    const banned = ["certified", "certifies", "compliant", "proves", "proven", "tamper-proof",
                    "audited", "attests", "validated"];
    const hits = banned.filter(w => new RegExp("\\b" + w + "\\b", "i").test(prose));
    assert.deepEqual(hits, [],
      "the console tells the reader more than the archive supports. A hash match is evidence "
      + "that rows are unaltered; it is not certification, compliance, audit or proof, and the "
      + "one place this product must not overstate itself is the page where it is checked");
  });

  check("the limits of the guarantee are on the page, not only in the API response", () => {
    assert.match(verify, /tamper-evident, not tamper-proof/i,
      "the standing wording is missing; it has never been allowed to be upgraded");
    assert.match(verify, /does not establish/i,
      "the page does not say what a match fails to establish, which is the half a verifier "
      + "most needs and the half most easily left out");
  });
});

console.log("# ── operator grants panel ─────────────────────");

test("issuing a grant does not leak the token past the moment it is shown", () => {
  check("the one-time token is never persisted by the browser", () => {
    const stores = /(localStorage|sessionStorage)\.setItem\([^)]*token/i;
    assert.ok(!stores.test(evidence),
      "the issued token is written to browser storage. Only a hash exists server-side "
      + "specifically so the token cannot be recovered; caching it in the browser rebuilds "
      + "the exposure the hashing removed");
  });

  check("the operator is told plainly that it is shown once", () => {
    assert.match(evidence, /shown once/i,
      "an operator who assumes they can look the token up again will close this dialog and "
      + "then need a reissue — the reason for a hash-only store has to be visible at the "
      + "moment it bites");
  });

  check("revoking is offered for active grants", () => {
    assert.match(evidence, /data-revoke/,
      "no revoke control; an access right that can only be created is not time-boxed in practice");
    assert.match(evidence, /method:\s*"DELETE"/,
      "revocation should use the operator DELETE route rather than some new path");
  });

  check("the operator panel still authenticates as the operator", () => {
    assert.ok(!/X-Grant-Token/.test(evidence),
      "the operator console sends a grant token. Operators authenticate with their workspace "
      + "key; a grant must never be usable to reach an operator write route");
  });

  console.log("# ──────────────────────────────────────────────");
  console.log(`#   ${passed} passed, ${failed} failed`);
  assert.equal(failed, 0);
});
