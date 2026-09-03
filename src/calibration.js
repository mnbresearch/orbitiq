// ============================================================
// Reading the published covariance calibration.
//
// The calibration is computed in GitHub Actions and published to a branch.
// This module fetches it, caches it, and — most importantly — fails to a
// state where nothing changes.
//
// ── The failure mode that matters ───────────────────────────
// If this fetch fails, or returns something malformed, or the calibration was
// built from too little history, the correct behaviour is for the modelled
// covariance to stand exactly as it did before. Never a partial application,
// never a default "measured" value, never a retry loop that blocks a
// screening pass.
//
// That is not general defensiveness. The calibration widens sigma; a bug that
// dropped it silently would narrow every probability of collision back to the
// modelled value without anything in the output saying so. So the applied
// covariance always carries a `calibration` field naming the version used, or
// the string "none". A reader can always tell which they are looking at.
// ============================================================
import fs from "node:fs";
import path from "node:path";
import { implausible } from "./covcal.js";

const BASE = process.env.ORBITIQ_CALIBRATION_BASE
  || "https://raw.githubusercontent.com/mnbresearch/orbitiq/calibration/data/calibration";

const DATA_DIR = process.env.ORBITIQ_DATA_DIR || "data";
const CACHE_FILE = path.join(DATA_DIR, "calibration.json");

// Twelve hours. The upstream job runs daily, so anything shorter is just
// re-fetching an unchanged file; anything much longer and a corrected
// calibration takes too long to reach production.
const TTL_MS = 12 * 3600 * 1000;

let memo = { at: 0, value: null };
let inflight = null;

function readCache() {
  try {
    const raw = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
    return validate(raw) ? raw : null;
  } catch { return null; }
}

function writeCache(v) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(v));
  } catch { /* cache is an optimisation, not a requirement */ }
}

/**
 * Reject anything that is not a calibration we are willing to apply.
 *
 * `usable` is set by the worker and is false until several days of snapshots
 * have accumulated. Honouring it here means a freshly deployed instance
 * applies no floor rather than a floor built from two days of data — which
 * would be a fit through two points extrapolated out to a fortnight.
 */
export function validate(c) {
  if (!c || typeof c !== "object") return false;
  if (c.usable !== true) return false;
  if (!c.byKind || typeof c.byKind !== "object") return false;
  const kinds = Object.values(c.byKind);
  if (!kinds.length) return false;
  if (!kinds.some(k => k?.fit?.sigmaI && Number.isFinite(k.fit.sigmaI.a))) return false;

  // Re-check the plausibility ceiling here rather than trusting the `usable`
  // flag the worker set. That flag is computed on the other side of a network
  // fetch from a branch anyone with write access can push to, and the failure
  // it guards against — a wildly inflated sigma that puts every conjunction
  // above every threshold — is one the "can only widen" rule does not catch,
  // because inflating sigma IS widening. Cheap to verify, so verify it.
  return implausible(c.byKind).length === 0;
}

/** Cached calibration, or null. Never throws, never blocks. */
export function current() {
  if (memo.value && Date.now() - memo.at < TTL_MS) return memo.value;
  if (!memo.value) {
    const cached = readCache();
    if (cached) memo = { at: Date.now(), value: cached };
  }
  // Refresh in the background. A screening pass must never wait on this.
  if (Date.now() - memo.at >= TTL_MS && !inflight) {
    inflight = refresh().finally(() => { inflight = null; });
  }
  return memo.value;
}

export async function refresh() {
  try {
    const res = await fetch(`${BASE}/index.json`, {
      headers: { "User-Agent": "OrbitIQ/8.0" },
      signal: AbortSignal.timeout(8000)
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    if (!validate(body)) {
      // Not an error: an unusable calibration is the expected state for the
      // first fortnight after this ships, and every time the history is reset.
      memo = { at: Date.now(), value: null };
      return null;
    }
    memo = { at: Date.now(), value: body };
    writeCache(body);
    return body;
  } catch (e) {
    // Keep whatever we had. A stale calibration is a real measurement from a
    // recent day; no calibration is the modelled covariance. Both are safe.
    memo.at = Date.now() - TTL_MS + 60_000;   // retry in a minute, not a loop
    return memo.value;
  }
}

/** Status for the public status page and the evidence report. */
export function status() {
  const c = memo.value;
  return {
    applied: !!c,
    version: c?.version || null,
    generatedAt: c?.generatedAt || null,
    snapshots: c?.snapshots ?? null,
    spanDays: c?.snapshotSpanDays ?? null,
    pairsUsable: c?.pairsUsable ?? null,
    kinds: c ? Object.keys(c.byKind) : [],
    means: c
      ? "Probabilities use a modelled covariance widened wherever published element sets for "
      + "that class of object disagree with each other by more than the model allowed."
      : "No calibration applied. Probabilities use the modelled covariance alone, which is the "
      + "documented default and the state this system is in until enough snapshot history has "
      + "accumulated to measure anything."
  };
}

/** Reset, for tests. */
export function _set(v) { memo = { at: Date.now(), value: v }; }
