// ============================================================
// OrbitIQ — outbound URL validation (SSRF guard).
//
// Two separate webhook paths existed with two different levels of care: the
// v14 fleet policy validated its URL, and the older workspace webhook stored
// whatever it was given and POSTed alert JSON to it. The second one was
// reachable without authentication — create a free workspace, set the webhook
// to the cloud metadata endpoint, trigger a scan — so it is worth having
// exactly one validator that both paths use.
//
// A string check on the hostname is not enough. `http://2130706433/` and
// `http://0x7f000001/` are both 127.0.0.1, and IPv4-mapped IPv6 forms reach
// the same place. Anything that parses as an IP is normalised and range-checked
// numerically instead of by pattern.
// ============================================================

/** Parse a hostname into a 32-bit IPv4 integer, covering the legacy forms. */
function toIPv4Int(host) {
  const h = host.trim();

  // Dotted quad, and the short forms inet_aton accepts (a.b.c, a.b, a).
  const parts = h.split(".");
  if (parts.length >= 1 && parts.length <= 4 && parts.every(p => p.length && /^(0x[0-9a-f]+|0[0-7]*|\d+)$/i.test(p))) {
    const nums = parts.map(p => {
      if (/^0x/i.test(p)) return parseInt(p, 16);
      if (/^0[0-7]+$/.test(p)) return parseInt(p, 8);
      return parseInt(p, 10);
    });
    if (nums.some(n => !Number.isFinite(n) || n < 0)) return null;
    if (parts.length === 4) {
      if (nums.some(n => n > 255)) return null;
      return ((nums[0] << 24) >>> 0) + (nums[1] << 16) + (nums[2] << 8) + nums[3];
    }
    // a.b.c -> a.b.(c as 16 bit); a.b -> a.(b as 24 bit); a -> 32 bit
    if (parts.length === 1) return nums[0] > 0xFFFFFFFF ? null : nums[0] >>> 0;
    if (parts.length === 2) {
      if (nums[0] > 255 || nums[1] > 0xFFFFFF) return null;
      return (((nums[0] << 24) >>> 0) + nums[1]) >>> 0;
    }
    if (nums[0] > 255 || nums[1] > 255 || nums[2] > 0xFFFF) return null;
    return (((nums[0] << 24) >>> 0) + (nums[1] << 16) + nums[2]) >>> 0;
  }
  return null;
}

/** True if a 32-bit IPv4 integer falls in a range we must never call out to. */
function isBlockedIPv4(n) {
  const a = (n >>> 24) & 0xFF, b = (n >>> 16) & 0xFF;
  if (a === 0) return true;                          // 0.0.0.0/8 "this network"
  if (a === 10) return true;                         // RFC1918
  if (a === 127) return true;                        // loopback
  if (a === 169 && b === 254) return true;           // link-local, incl. cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;  // RFC1918
  if (a === 192 && b === 168) return true;           // RFC1918
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 192 && b === 0) return true;             // IETF protocol assignments
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a >= 224) return true;                         // multicast + reserved + broadcast
  return false;
}

function isBlockedIPv6(host) {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (h === "::1" || h === "::") return true;
  if (h.startsWith("fe80")) return true;             // link-local
  if (/^f[cd]/.test(h)) return true;                 // unique local
  // IPv4-mapped / -compatible, dotted form: ::ffff:127.0.0.1
  const dotted = h.match(/^::(ffff:)?(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) { const n = toIPv4Int(dotted[2]); return n === null ? true : isBlockedIPv4(n); }

  // The URL parser normalises the dotted form to hex, so ::ffff:127.0.0.1
  // arrives here as ::ffff:7f00:1. Reassemble the embedded 32-bit address.
  const hex = h.match(/^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const n = ((parseInt(hex[1], 16) << 16) >>> 0) + parseInt(hex[2], 16);
    return isBlockedIPv4(n >>> 0);
  }
  return false;
}

/**
 * Validate a user-supplied outbound webhook URL.
 * @returns {{ok:true, url:string} | {error:string}}
 */
export function validateWebhookUrl(raw) {
  const s = String(raw || "").trim();
  if (!s) return { error: "URL is empty" };
  if (s.length > 300) return { error: "URL is too long" };

  let u;
  try { u = new URL(s); } catch { return { error: "Must be a valid absolute URL" }; }

  if (u.protocol !== "https:") return { error: "Must use https" };
  if (u.username || u.password) return { error: "Credentials in the URL are not accepted" };

  const host = u.hostname.toLowerCase();
  if (!host) return { error: "Missing host" };
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")
      || host.endsWith(".internal") || host === "metadata.google.internal") {
    return { error: "May not point at a private or loopback address" };
  }
  if (host.includes(":") || host.startsWith("[")) {
    if (isBlockedIPv6(host)) return { error: "May not point at a private or loopback address" };
  } else {
    const n = toIPv4Int(host);
    if (n !== null && isBlockedIPv4(n)) {
      return { error: "May not point at a private or loopback address" };
    }
  }
  return { ok: true, url: u.toString() };
}

/**
 * fetch() for user-supplied URLs.
 *
 * Redirects are handled manually: validation happens before the request, but a
 * host we allowed can answer 302 to somewhere internal, which would sail past
 * the check. Each hop is re-validated, and the chain is capped.
 */
export async function safeFetch(url, init = {}, maxHops = 3) {
  let current = url;
  for (let hop = 0; hop <= maxHops; hop++) {
    const v = validateWebhookUrl(current);
    if (v.error) return { ok: false, error: `Blocked redirect target: ${v.error}` };
    const res = await fetch(v.url, { ...init, redirect: "manual" });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) return { ok: res.ok, status: res.status, res };
      current = new URL(loc, v.url).toString();
      continue;
    }
    return { ok: res.ok, status: res.status, res };
  }
  return { ok: false, error: "Too many redirects" };
}
