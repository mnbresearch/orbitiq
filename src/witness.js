// ============================================================
// Checking the archive against the external witness log.
//
// ── The gap this closes ─────────────────────────────────────
// verify() does two things: it walks the hash chain, and it cross-checks the
// published seals. Both are strong against carelessness and neither is strong
// against determination, for the same reason:
//
//   the chain is a file we hold,
//   and ledger-seals.json is ALSO a file we hold.
//
// Someone rewriting the archive would rewrite the seals in the same motion. So
// the seal check catches a tampered row, but not a tampered system.
//
// The witness log is different. An hourly GitHub Actions run fetches the
// PUBLIC verification endpoint exactly as a stranger would and appends what it
// saw to a branch with real commit parents, alongside the id of the run that
// observed it. Those runs are timestamped by GitHub, and the repository owner
// cannot edit the log of a run that already happened.
//
// That is the only record in this system that the operator of this system
// cannot revise. Checking against it is therefore the strongest statement the
// archive can make about itself, and it is the one an underwriter should
// actually rely on.
//
// ── What it still does not prove ────────────────────────────
// Repository write access allows rewriting the witness BRANCH. What it does
// not allow is forging the Actions runs those records cite: rewriting the
// branch leaves a discontinuous commit graph, and the run logs still say what
// they said. So the honest framing is that this raises the cost of a
// convincing rewrite from "edit two files" to "edit two files, rewrite a
// public append-only branch, and hope nobody compares it with the run logs
// GitHub is holding".
//
// Not proof. Evidence, with a named and checkable weakness — which is the most
// this architecture can honestly offer, and considerably more than a chain
// that only checks itself.
// ============================================================
import * as ledger from "./ledger.js";

const WITNESS_URL = process.env.ORBITIQ_WITNESS_URL
  || "https://raw.githubusercontent.com/mnbresearch/orbitiq/witness/witness/log.jsonl";

/** Parse the append-only log. Malformed lines are counted, never guessed at. */
export function parseLog(text) {
  const records = [];
  let malformed = 0;
  for (const line of String(text).split("\n")) {
    const s = line.trim();
    if (!s) continue;
    try {
      const r = JSON.parse(s);
      if (r && typeof r === "object") records.push(r); else malformed++;
    } catch { malformed++; }
  }
  return { records, malformed };
}

/**
 * Compare witness observations against what the archive holds now.
 *
 * Only records that name a tip sequence still inside the retained window can
 * be checked here. Older ones are not failures — rotation legitimately drops
 * rows — so they are counted separately rather than folded into a pass rate
 * that would quietly improve as the archive forgets.
 */
export function compare(records, rowsBySeq) {
  // The archive tip, computed ONCE.
  //
  // An earlier version called ledger.verify() inside the loop to decide why a
  // row was missing. verify() walks the whole archive, so with 28,000 rows and
  // an hourly witness log that is a full chain walk per unmatched observation
  // — quadratic work on the public endpoint, and a gift to anyone who wanted
  // to stall the instance by asking for it repeatedly.
  let tipSeq = null;
  for (const r of rowsBySeq.values()) {
    if (typeof r.seq === "number" && (tipSeq == null || r.seq > tipSeq)) tipSeq = r.seq;
  }

  const out = {
    observations: records.length,
    reachable: 0, unreachable: 0,
    checkable: 0, matched: 0,
    beyondRetention: 0, aheadOfArchive: 0,
    mismatches: []
  };

  for (const r of records) {
    if (r.http !== "200" || !r.tipHash || typeof r.tipSeq !== "number") {
      out.unreachable++;
      continue;
    }
    out.reachable++;
    const row = rowsBySeq.get(r.tipSeq);
    if (!row) {
      // Two very different reasons a row can be absent, and conflating them
      // would hide the interesting one: a sequence beyond our tip is an
      // observation of a state this instance has not reached, while one below
      // the window was simply rotated away.
      if (tipSeq != null && r.tipSeq > tipSeq) out.aheadOfArchive++;
      else out.beyondRetention++;
      continue;
    }
    out.checkable++;
    if (row.h === r.tipHash) out.matched++;
    else out.mismatches.push({
      tipSeq: r.tipSeq,
      witnessedHash: r.tipHash,
      archiveHash: row.h,
      observedAt: r.observed,
      runUrl: r.runUrl || null
    });
  }
  return out;
}

/** Verdict wording, kept in one place so the API and the report agree. */
export function verdict(c) {
  if (c.mismatches.length) {
    return {
      ok: false,
      summary: `${c.mismatches.length} of ${c.checkable} checkable observations disagree with the archive`,
      means: "An outside observer recorded a different tip hash for a sequence the archive "
           + "still holds. Each mismatch cites the GitHub Actions run that made the "
           + "observation; those runs are timestamped and their logs cannot be edited after "
           + "the fact by the repository owner. This is the strongest negative signal this "
           + "system can produce about itself."
    };
  }
  if (c.checkable === 0) {
    return {
      ok: null,
      summary: "no witness observation falls inside the retained window",
      means: c.observations === 0
        ? "The witness log is empty or unreachable. Nothing is contradicted, but nothing is "
        + "corroborated either — treat the archive as self-attested until observations exist."
        : "Observations exist but all of them name rows that have since rotated out, or rows "
        + "this instance has not reached. That is not a discrepancy; it means the external "
        + "record and the retained window do not currently overlap."
    };
  }
  return {
    ok: true,
    summary: `${c.matched} of ${c.checkable} checkable observations agree with the archive`,
    means: "Every hourly observation that names a row still held matches the hash the archive "
         + "reports for it. Those observations were made by a process outside this service, "
         + "fetching the public endpoint as any stranger would, and recorded against GitHub "
         + "Actions runs the repository owner cannot backdate."
  };
}

/**
 * Fetch and check. Never throws: an unreachable witness log is an absence of
 * corroboration, not evidence of tampering, and must not be reported as one.
 */
export async function check({ timeoutMs = 8000 } = {}) {
  let text = null, fetchError = null;
  try {
    const res = await fetch(WITNESS_URL, {
      headers: { "User-Agent": "OrbitIQ/8.0" },
      signal: AbortSignal.timeout(timeoutMs),
      cache: "no-store"
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    text = await res.text();
  } catch (e) { fetchError = e.message; }

  if (text == null) {
    return {
      ok: null,
      source: WITNESS_URL,
      error: fetchError,
      summary: "the witness log could not be read",
      means: "No corroboration was available at this moment. This says nothing about the "
           + "archive either way; the log lives outside this service by design, so it can be "
           + "unavailable while the archive is perfectly intact.",
      limits: LIMITS
    };
  }

  const { records, malformed } = parseLog(text);
  const rowsBySeq = new Map(
    ledger.allEvents().filter(r => typeof r.seq === "number").map(r => [r.seq, r]));
  const c = compare(records, rowsBySeq);
  const v = verdict(c);

  return {
    ...v,
    source: WITNESS_URL,
    malformedLines: malformed,
    counts: {
      observations: c.observations,
      reachableObservations: c.reachable,
      unreachableObservations: c.unreachable,
      checkedAgainstArchive: c.checkable,
      matched: c.matched,
      beyondRetention: c.beyondRetention,
      aheadOfThisInstance: c.aheadOfArchive
    },
    mismatches: c.mismatches,
    limits: LIMITS
  };
}

const LIMITS =
  "The witness log is held on a branch of this repository, so write access to the repository "
  + "allows rewriting it. What that does not allow is forging the GitHub Actions runs each "
  + "record cites: a rewrite leaves a discontinuous commit graph and the run logs are not "
  + "editable after the fact. This is evidence with a named weakness, not proof — and it is "
  + "still stronger than the hash chain and the seal file, both of which this service holds "
  + "and could rewrite together.";
