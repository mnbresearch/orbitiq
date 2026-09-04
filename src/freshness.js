// ============================================================
// How old is the answer?
//
// ── The failure this exists to make visible ─────────────────
// Screening runs on a GitHub Actions worker and publishes static JSON to a
// branch. The web service fetches that file and serves it. The failure mode
// nobody designed for is the one that actually happened:
//
//   the worker died, and the file stayed exactly where it was.
//
// The fetch still returned 200. `reachable` still went true. The service
// still had 400 conjunctions and a tightest approach of 0.192 km to show.
// The only thing that changed is that none of it was true any more — and
// there was no field anywhere in the response that would have said so.
//
// It ran that way for five consecutive screening cycles before anyone looked
// at the Actions tab.
//
// ── Why this is the worst possible bug for THIS product ─────
// The pitch is "we were watching, and here is the evidence". The whole value
// of the archive rests on being able to distinguish two situations that look
// identical from the outside:
//
//   "nothing came within the threshold"    — a quiet sky
//   "nothing was computed"                 — a dead screener
//
// coverage.js already makes that distinction HISTORICALLY, by writing a row
// every time a sweep runs and naming the gaps afterwards. But that report sits
// behind a paid tier, and it answers "was anyone watching last March?". It
// does not answer the question a reader of the live endpoint is implicitly
// asking every time: "is the number in front of me current?"
//
// The published feed has always carried a `generatedAt`. Nothing read it.
// That is the entire defect, and this module is the thing that reads it.
//
// ── The rule this module enforces ───────────────────────────
// A missing timestamp yields "unknown". Never "fresh".
//
// This is the same discipline witness.js applies to corroboration: silence is
// reported as silence. Data of unknown age is data of unknown age, and the one
// thing it must never be rendered as is data known to be current. Defaulting
// an absent timestamp to "now" would be indistinguishable from working code
// in every test, in every screenshot, and in every demo — and wrong in exactly
// the situation the module was written for.
// ============================================================

/**
 * Cadence the screening workflow actually keeps.
 *
 * The schedule asks for hourly. GitHub's scheduler has been observed firing 24
 * to 55 minutes late on this repository, so the tolerance below is deliberately
 * wider than the schedule: reporting ordinary scheduler drift as an outage
 * would train everyone to ignore the indicator, which costs more than the
 * indicator is worth.
 */
export const CADENCE_HOURS = 1;

/** Beyond this, at least two cycles have been missed. Worth saying out loud. */
export const STALE_AFTER_HOURS = 3;

/**
 * Beyond this, treat the pipeline as down rather than late.
 *
 * Twelve hours is roughly half a day of orbital motion. A LEO object completes
 * about seven and a half revolutions in that time, so a conjunction screened
 * twelve hours ago has no useful bearing on where anything is now — the answer
 * is not merely old, it is about a different sky.
 */
export const DOWN_AFTER_HOURS = 12;

const HOUR_MS = 3600000;

/**
 * Assess the age of a result.
 *
 * @param generatedAt  ISO timestamp the producer stamped on the data, or null
 * @param now          epoch ms, injectable so the tests are not clock-dependent
 * @returns {{state, ageHours, asOf, current, summary, means}}
 *
 * `state` is one of:
 *   "fresh"    — within tolerance; serve it without qualification
 *   "stale"    — cycles have been missed; serve it, but say how old it is
 *   "down"     — old enough that it describes a different sky
 *   "unknown"  — no usable timestamp; age cannot be established
 *   "ahead"    — timestamp is in the future; clock skew or a bad producer
 */
export function assess({
  generatedAt = null,
  now = Date.now(),
  staleAfterHours = STALE_AFTER_HOURS,
  downAfterHours = DOWN_AFTER_HOURS
} = {}) {
  const t = generatedAt ? Date.parse(generatedAt) : NaN;

  if (!Number.isFinite(t)) {
    return {
      state: "unknown",
      ageHours: null,
      asOf: null,
      current: false,
      summary: "the age of this screening result could not be established",
      means:
        "The data carries no usable timestamp, so there is no way to tell whether it was "
        + "computed minutes or days ago. Treat it as unverified rather than current: an "
        + "absent timestamp is the same shape as a stopped pipeline, and this endpoint "
        + "will not guess in the reassuring direction."
    };
  }

  const ageHours = (now - t) / HOUR_MS;
  const asOf = new Date(t).toISOString();
  const round = n => +n.toFixed(2);

  // A future timestamp is not freshness. It means the producer's clock is
  // wrong or the field was written by something other than the producer, and
  // either way the age is not trustworthy — so it is reported, not smoothed
  // to zero. Small skew is tolerated because clocks genuinely differ.
  if (ageHours < -0.5) {
    return {
      state: "ahead",
      ageHours: round(ageHours),
      asOf,
      current: false,
      summary: `this result is stamped ${Math.abs(round(ageHours))} h in the future`,
      means:
        "The producing job's clock disagrees with this service's, or the timestamp was not "
        + "written by the job that produced the data. Either way the stated age cannot be "
        + "relied on, so it is surfaced rather than clamped to zero."
    };
  }

  if (ageHours <= staleAfterHours) {
    return {
      state: "fresh",
      ageHours: round(Math.max(ageHours, 0)),
      asOf,
      current: true,
      summary: `screened ${describeAge(ageHours)} ago`,
      means:
        `The screening behind this result completed at ${asOf}, within the expected `
        + `${CADENCE_HOURS} h cadence (tolerance ${staleAfterHours} h). The figures describe `
        + "the catalogue as it stood then."
    };
  }

  if (ageHours < downAfterHours) {
    return {
      state: "stale",
      ageHours: round(ageHours),
      asOf,
      current: false,
      summary: `screened ${describeAge(ageHours)} ago — at least one cycle has been missed`,
      means:
        `The screening behind this result completed at ${asOf}, which is longer ago than the `
        + `${staleAfterHours} h tolerance allows. The numbers are still real screening output, `
        + "but they are not current: an encounter that has developed since then does not "
        + "appear here, and an absence of warnings below reflects that moment rather than now."
    };
  }

  return {
    state: "down",
    ageHours: round(ageHours),
    asOf,
    current: false,
    summary: `screened ${describeAge(ageHours)} ago — the screening pipeline appears to be down`,
    means:
      `The most recent screening completed at ${asOf}. In ${describeAge(ageHours)} a low-Earth-orbit `
      + "object travels roughly " + revolutions(ageHours) + " revolutions, so this result does not "
      + "describe the current configuration in any useful sense. Read it as a record of that "
      + "moment, not as a present-tense statement about risk, and do not read an absence of "
      + "warnings in it as an absence of conjunctions now."
  };
}

/**
 * The sentence to attach to any claim of the form "nothing was found".
 *
 * Kept here rather than at each call site so the public endpoint, the status
 * page and the report cannot drift into describing the same condition three
 * different ways — which is how a caveat quietly becomes softer in the one
 * place a reader actually looks.
 */
export function qualify(f) {
  if (!f || f.state === "unknown") {
    return "This result's age could not be established, so an absence of warnings here is not "
         + "evidence that nothing was there.";
  }
  if (f.state === "fresh") {
    return `Screened ${describeAge(f.ageHours)} ago against the public catalogue.`;
  }
  return `Screened ${describeAge(f.ageHours)} ago. An absence of warnings describes that moment, `
       + "not the present.";
}

/** Whole-unit age, because "2.03 hours" reads as precision this does not have. */
export function describeAge(hours) {
  const h = Math.max(Number(hours) || 0, 0);
  if (h < 1 / 60) return "less than a minute";
  if (h < 1) { const m = Math.round(h * 60); return `${m} minute${m === 1 ? "" : "s"}`; }
  if (h < 48) { const n = Math.round(h); return `${n} hour${n === 1 ? "" : "s"}`; }
  const d = Math.round(h / 24);
  return `${d} day${d === 1 ? "" : "s"}`;
}

/** Rough LEO revolutions in a span, for putting an age in physical terms. */
function revolutions(hours) {
  const revs = hours / 1.55;            // ~93 min at 500 km
  return revs >= 10 ? String(Math.round(revs)) : revs.toFixed(1);
}

/**
 * Fold freshness into a payload without inventing fields the caller may
 * already use. Returns a new object; never mutates the input.
 */
export function annotate(payload, { now = Date.now() } = {}) {
  const f = assess({ generatedAt: payload?.generatedAt ?? null, now });
  return {
    ...payload,
    asOf: f.asOf,
    freshness: {
      state: f.state,
      ageHours: f.ageHours,
      current: f.current,
      summary: f.summary,
      means: f.means
    }
  };
}
