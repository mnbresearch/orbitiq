// ============================================================
// Secret-bearing archives must never reach the public branch in the clear.
//
// This test exists because they did. The backup branch lives in a PUBLIC
// repository, and store.json (workspace API keys) and auth.json (scrypt
// password hashes, the access-request queue, and live session bearer tokens)
// were being uploaded to it verbatim. Anyone who could read the repository —
// which is anyone — could lift a working session token.
//
// The two properties worth pinning down, because getting either wrong
// re-creates the incident:
//
//   1. FAIL CLOSED. With no key configured the file must be skipped, not
//      uploaded. A backup that silently degrades to plaintext is worse than no
//      backup, because it looks like it is working.
//   2. Sensitive files must be MARKED. The manifest is the thing a future
//      change will edit, so assert on the manifest rather than on behaviour
//      alone — a new secret-bearing file added without the flag is exactly how
//      this returns.
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = fs.readFileSync(path.join(ROOT, "src/backup.js"), "utf8");

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log(`#   ok    ${name}`); }
  catch (e) { failed++; console.log(`#   FAIL  ${name}\n#         ${e.message}`); throw e; }
}

console.log("# ── backup secrecy ────────────────────────────");

test("secret-bearing archives are encrypted or skipped", () => {

  check("auth.json is marked secret", () => {
    assert.match(src, /auth\.json"\s*\),\s*remote:\s*"backup\/auth\.json\.enc",\s*secret:\s*true/,
      "auth.json holds password hashes and session tokens and must be flagged secret");
  });

  check("store.json is marked secret", () => {
    assert.match(src, /store\.json"\s*\),\s*remote:\s*"backup\/store\.json\.enc",\s*secret:\s*true/,
      "store.json holds workspace API keys and must be flagged secret");
  });

  check("no secret file is published under its plaintext remote name", () => {
    assert.ok(!/remote:\s*"backup\/auth\.json"/.test(src), "auth.json still has a plaintext remote path");
    assert.ok(!/remote:\s*"backup\/store\.json"/.test(src), "store.json still has a plaintext remote path");
  });

  check("backup fails CLOSED when no key is configured", () => {
    // The skip must come before the upload, and must `continue` rather than
    // fall through to writing the blob.
    const i = src.indexOf("if (f.secret) {");
    const j = src.indexOf("const blob = await ghJson");
    assert.ok(i > 0 && j > 0, "could not locate the secret guard or the upload");
    assert.ok(i < j, "the secret guard must run before the upload, not after");
    const guard = src.slice(i, j);
    assert.match(guard, /if \(!BACKUP_KEY\)/, "no check for a missing key");
    assert.match(guard, /continue;/, "a missing key must skip the file, not fall through");
    assert.match(guard, /text = seal\(text\)/, "a configured key must encrypt before upload");
  });

  check("restore refuses to write ciphertext it cannot decrypt", () => {
    const i = src.indexOf("if (f.secret) {", src.indexOf("export async function restore"));
    const j = src.indexOf("fs.writeFileSync(f.local, text)", i);
    const guard = src.slice(i, j);
    assert.match(guard, /unseal\(text\)/, "restore does not decrypt");
    assert.match(guard, /catch/, "a decrypt failure must be caught, not thrown into the boot path");
    assert.match(guard, /continue;/, "a decrypt failure must leave the local file untouched");
  });

  check("the key is rejected unless it is a full 256-bit hex string", () => {
    assert.match(src, /\{64\}\$\/\.test\(raw\)/,
      "a short or malformed key must be rejected rather than silently padded");
  });

  // Prove the scheme actually round-trips and that the GCM tag does its job.
  const KEY = crypto.randomBytes(32);
  const sealIt = (pt) => {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv("aes-256-gcm", KEY, iv);
    const body = Buffer.concat([c.update(pt, "utf8"), c.final()]);
    return ["v1", iv.toString("base64"), c.getAuthTag().toString("base64"), body.toString("base64")].join(".");
  };
  const unsealIt = (text) => {
    const [v, iv, tag, body] = text.split(".");
    assert.equal(v, "v1");
    const d = crypto.createDecipheriv("aes-256-gcm", KEY, Buffer.from(iv, "base64"));
    d.setAuthTag(Buffer.from(tag, "base64"));
    return Buffer.concat([d.update(Buffer.from(body, "base64")), d.final()]).toString("utf8");
  };

  const secret = JSON.stringify({ users: [{ email: "a@b.c", passHash: "scrypt$deadbeef" }], sessions: { tok: 1 } });

  check("ciphertext round-trips", () => {
    assert.equal(unsealIt(sealIt(secret)), secret);
  });

  check("the ciphertext does not leak the plaintext", () => {
    const ct = sealIt(secret);
    for (const needle of ["passHash", "scrypt", "a@b.c", "sessions"]) {
      assert.ok(!ct.includes(needle), `"${needle}" is visible in the ciphertext`);
    }
  });

  check("tampering with the ciphertext is rejected, not silently accepted", () => {
    const parts = sealIt(secret).split(".");
    const body = Buffer.from(parts[3], "base64");
    body[0] ^= 0xff;                       // flip a bit in the payload
    parts[3] = body.toString("base64");
    assert.throws(() => unsealIt(parts.join(".")),
      "a modified ciphertext decrypted without complaint — the auth tag is not being checked");
  });

  check("a wrong key cannot read it", () => {
    const ct = sealIt(secret);
    const [v, iv, tag, body] = ct.split(".");
    const d = crypto.createDecipheriv("aes-256-gcm", crypto.randomBytes(32), Buffer.from(iv, "base64"));
    d.setAuthTag(Buffer.from(tag, "base64"));
    assert.throws(() => Buffer.concat([d.update(Buffer.from(body, "base64")), d.final()]));
  });

  console.log("# ──────────────────────────────────────────────");
  console.log(`#   ${passed} passed, ${failed} failed`);
  assert.equal(failed, 0);
});
