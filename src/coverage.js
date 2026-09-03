// ============================================================
// Screening coverage — the record of having watched.
//
// ── The hole this fills ─────────────────────────────────────
// The archive holds warnings. An underwriter reading it can see what was
// found. What they cannot see, and what they actually care about, is whether
// anyone was looking during the week nothing was found.
//
// Those two are indistinguishable in a record of warnings alone:
//
//   "no conjunctions above threshold that month"      — a good month
//   "the screening job was broken that month"         — an empty log
//
// Both look like silence. And an operator's own instinct, at claim time, is
// to present the first; the second is exactly what a claims adjuster is
// employed to look for. A record that cannot distinguish them is worth much
// less than it appears, because its weakest reading is the one an adversarial
// reader will take.
//
// So every screening pass writes a row saying it happened: when, over what
// forward window, against how many objects, and how stale the catalogue was.
// Absence of a warning then means something, because the sweep that failed to
// find one is itself in the record.
//
// ── Gaps are reported, not hidden ───────────────────────────
// The temptation is to report uptime as a percentage and move on. This module
// does the opposite: it names every interval where no sweep ran, with its
// duration, and puts them in the report. An operator handing over a document
// that volunteers its own gaps is far more credible than one that presents a
// round 100%, and if a gap coincides with an incident, everyone finds out
// then rather than now. Better it be disclosed by us than discovered by them.
//
// ── What a sweep row deliberately does not claim ────────────
// That the catalogue was complete. Screening runs against public element sets,
// which omit unrepresented objects entirely and are stale by hours or days. A
// coverage row says "a sweep ran and here is what it could see", never "there
// was nothing there".
// ============================================================
import * as ledger from "./ledger.js";

export const COVERAGE_TYPE = "sweep";

/**
 * Expected cadence, hours. The screening workflow runs hourly; anything longer
 * than this between sweeps is a gap worth naming rather than smoothing over.
 * Two and a half hours rather than one gives GitHub's scheduler the latitude
 * it actually takes — it has been observed firing 24 to 55 minutes late — so
 * that ordinary scheduler drift is not reported to an underwriter as an outage.
 */
export const EXPECTED_INTERVAL_HOURS = 2.5;

/**
 * Record that a screening pass ran.
 *
 * Never throws. A failure to record coverage must not fail the screening pass
 * itself: a sweep that ran and went unrecorded is a hole in the evidence, but
 * a sweep that did not run because the bookkeeping threw is a hole in the
 * actual watching, and that is worse.
 */
export function record({
  org = null, objectsScreened = null, pairsConsidered = null, windowHours = null,
  thresholdKm = null, catalogueEpochAgeDays = null, eventsFound = null,
  source = "screening-worker", durationMs = null
} = {}) {
  try {
    ledger.append(COVERAGE_TYPE, [{
      org,
      at: new Date().toISOString(),
      source,
      objectsScreened: num(objectsScreened),
      pairsConsidered: num(pairsConsidered),
      windowHours: num(windowHours),
      thresholdKm: num(thresholdKm),
      // How stale the elements were. A sweep against a four-day-old catalogue
      // is a weaker piece of evidence than one against fresh elements, and the
      // difference should be visible in the record rather than inferred.
      catalogueEpochAgeDays: num(catalogueEpochAgeDays),
      eventsFound: num(eventsFound),
      durationMs: num(durationMs)
    }]);
    return { ok: true };
  } catch (e) {
    console.error("coverage write failed:", e.message);
    return { ok: false, error: e.message };
  }
}

const num = v => (Number.isFinite(Number(v)) ? Number(v) : null);

/**
 * Sweeps in a window, oldest first.
 *
 * Filtered on `at` — when the sweep RAN — rather than on the ledger's own `t`,
 * which is when the row was written. Those differ whenever a row is delayed or
 * backfilled, and attributing a sweep to the moment its paperwork landed would
 * put coverage in the wrong hour. It is also the difference between a gap that
 * is real and a gap that is an artefact of a slow write, and this module exists
 * to tell a reader which gaps are real.
 *
 * The ledger query is left unbounded by time and narrowed here for the same
 * reason: a row whose write time falls outside the window can still describe a
 * sweep inside it.
 */
export function sweeps({ org = null, since = null, until = null, limit = 20000 } = {}) {
  const from = since ? new Date(since).getTime() : -Infinity;
  const to = until ? new Date(until).getTime() : Infinity;
  return (ledger.query({ type: COVERAGE_TYPE, org, limit }).events || [])
    .map(r => ({ ...r, _at: new Date(r.at || r.t).getTime() }))
    .filter(r => Number.isFinite(r._at) && r._at >= from && r._at <= to)
    .sort((a, b) => a._at - b._at);
}

/**
 * Intervals in which no sweep is recorded.
 *
 * Both ends of the requested window count. A gap between the start of the
 * period and the first sweep is a real gap — arguably the most important one,
 * because it is where "we only started screening after the incident" would
 * show up — and trimming the analysis to the first and last sweep would hide
 * exactly that.
 */
export function gaps({ org = null, since, until, expectedHours = EXPECTED_INTERVAL_HOURS } = {}) {
  const from = new Date(since).getTime();
  const to = new Date(until).getTime();
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return [];

  const times = sweeps({ org, since, until })
    .map(s => new Date(s.at || s.t).getTime())
    .filter(Number.isFinite);

  const limitMs = expectedHours * 3600e3;
  const out = [];
  let cursor = from;
  for (const t of times) {
    if (t - cursor > limitMs) {
      out.push({ from: new Date(cursor).toISOString(), to: new Date(t).toISOString(),
                 hours: +((t - cursor) / 3600e3).toFixed(2) });
    }
    cursor = Math.max(cursor, t);
  }
  if (to - cursor > limitMs) {
    out.push({ from: new Date(cursor).toISOString(), to: new Date(to).toISOString(),
               hours: +((to - cursor) / 3600e3).toFixed(2) });
  }
  return out;
}

/**
 * Coverage over a period, in the form a reviewer will ask for.
 *
 * `continuous` is deliberately a boolean and not a percentage. "99.4% covered"
 * invites the reader to round up; "not continuous, with a 31-hour gap starting
 * on the 14th" invites them to ask the right question. The percentage is still
 * reported, but it never appears without the gap list beside it.
 */
export function summary({ org = null, since, until, expectedHours = EXPECTED_INTERVAL_HOURS } = {}) {
  const rows = sweeps({ org, since, until });
  const g = gaps({ org, since, until, expectedHours });
  const from = new Date(since).getTime();
  const to = new Date(until).getTime();
  const spanH = Number.isFinite(from) && Number.isFinite(to) && to > from ? (to - from) / 3600e3 : null;
  const gapH = g.reduce((s, x) => s + x.hours, 0);

  const ages = rows.map(r => r.catalogueEpochAgeDays).filter(Number.isFinite).sort((a, b) => a - b);
  const objs = rows.map(r => r.objectsScreened).filter(Number.isFinite);

  return {
    windowFrom: since || null,
    windowTo: until || null,
    expectedIntervalHours: expectedHours,
    sweepsRecorded: rows.length,
    firstSweep: rows[0]?.at || rows[0]?.t || null,
    lastSweep: rows.at(-1)?.at || rows.at(-1)?.t || null,
    continuous: rows.length > 0 && g.length === 0,
    gaps: g,
    gapHours: +gapH.toFixed(2),
    coveredFraction: spanH ? +(Math.max(0, spanH - gapH) / spanH).toFixed(4) : null,
    medianObjectsScreened: objs.length ? objs.sort((a, b) => a - b)[objs.length >> 1] : null,
    medianCatalogueAgeDays: ages.length ? +ages[ages.length >> 1].toFixed(2) : null,
    eventsFound: rows.reduce((s, r) => s + (Number(r.eventsFound) || 0), 0),

    means: rows.length
      ? "Each row is a screening pass that ran, so a period with no warnings can be "
      + "distinguished from a period with no screening. Gaps are listed individually rather "
      + "than folded into a percentage."
      : "No screening passes are recorded for this period. That is not evidence that none ran "
      + "— coverage recording began when this feature shipped, and rows before that date do "
      + "not exist — but for any period after that date it should be read as it appears.",

    limits:
      "A sweep row says a pass ran and what it could see. It does not say the catalogue was "
      + "complete: screening uses public element sets, which omit unrepresented objects "
      + "entirely and are stale by hours or days. Coverage is evidence of watching, not of "
      + "having seen everything there was to see."
  };
}
