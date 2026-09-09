// ============================================================
// Does a record we published actually account for what is failing today?
//
// ── Why this is its own module ──────────────────────────────
// The same reason freshness.js is: this decides what a public surface tells a
// reader about our own failures, and a decision like that should be testable
// without booting a web server. Logic that only runs inside a route handler
// gets exercised by hand a few times and then trusted forever.
//
// ── The thing this exists to prevent ────────────────────────
// On 7 September 2026 six hundred rows stopped verifying because of a defect in
// our serialisation, not an edit. The right response to that is a dated entry
// in the archive saying so — and the archive already had a mechanism for it,
// used once before for a bad covariance model.
//
// But an erratum is a liability as much as an asset. Once "600 rows are known
// bad, here is why" is published, the tempting failure mode is to leave it
// sitting beside the verification verdict forever. A reader glances at the
// disclosure, sees a confident explanation, and stops looking — and any LATER
// damage, of any kind, is silently absorbed into the same reassuring sentence.
// The confession becomes camouflage. That is a worse outcome than never having
// disclosed anything, because it converts our own admission into a shield.
//
// So the published fact is not the erratum. It is the COMPARISON between what
// the erratum admitted to and what verification is finding right now:
//
//   * every failing row lies inside the range that was admitted to, AND
//   * there are no more failing rows than were admitted to.
//
// Both conditions are load-bearing. Containment alone passes if the damage
// deepens inside the range; the count alone passes if it moves outside it.
//
// When they disagree the answer is emphatically not "documented". It is a
// statement that the record does not cover this, phrased so that no one can
// read it as covered.
// ============================================================

// The identifier for the serialisation defect. Kept here rather than spelled
// out at each call site so the writer of the record and the checker of it
// cannot drift apart — the same reason the staleness workflow imports its
// thresholds instead of restating them.
export const SERIALISATION_DEFECT = "ser-v1";

// ── Writing the record ──────────────────────────────────────
//
// Takes the ledger module rather than importing it, so a test can run this
// against a purpose-built archive — including one deliberately damaged in ways
// the record must NOT end up describing. A writer that can only be exercised in
// production is a writer whose output nobody has ever checked.
//
// Deliberately driven by the observed state instead of a hardcoded range: an
// instance whose archive never carried an affected row must not publish an
// admission of a fault it never had. Idempotent — appended at most once, and
// never rewritten afterwards, because its position in the chain is what fixes
// its date.
export function recordSerialisationErratum(ledger, log = console) {
  try {
    const existing = ledger.query({ type: "erratum", limit: 200 }).events || [];
    if (existing.some(e => e && e.correctsDefect === SERIALISATION_DEFECT)) return false;

    const v = ledger.verify();
    if (!(v.unverifiableRows > 0) || v.firstUnverifiableSeq == null) return false;

    // If the ORDER of the archive is in question, this is not the defect being
    // described and writing this record would misattribute a serious failure to
    // a benign one. Say nothing rather than the wrong thing.
    if (v.linkageIntact !== true) return false;

    const from = v.firstUnverifiableSeq, to = v.lastUnverifiableSeq, n = v.unverifiableRows;

    ledger.append("erratum", [{
      org: null,
      correctsDefect: SERIALISATION_DEFECT,
      field: "h",
      severity: "high",
      direction: "unverifiable",
      coversSeqFrom: from,
      coversSeqTo: to,
      rowsAtRecord: n,
      linkageIntactAtRecord: true,
      summary:
        n + " row(s), sequence " + from + " to " + to + ", do not match their own stored "
        + "content hash and never will. Their ordering is intact — each still links to the row "
        + "before it, so nothing was removed, inserted or reordered — but their contents carry "
        + "no cryptographic attestation and must not be relied on as evidence.",
      cause:
        "A defect in this software, not an alteration. The hash was computed over an object "
        + "including keys whose value was undefined; the serialiser that wrote the file omitted "
        + "them. The body that was hashed was never the body that was stored, so these rows "
        + "failed verification from the moment they were written.",
      remedy:
        "The rows are retained unchanged. Rewriting them so that verification reads green is "
        + "precisely the act this archive exists to make detectable, and doing it for a benign "
        + "fault builds the same capability that a self-serving one would need. The write path "
        + "now re-checks every row against its own parsed form before committing it, so this "
        + "class of defect cannot recur silently.",
      whatWouldFalsifyThis:
        "If any row outside sequence " + from + "-" + to + ", or more than " + n + " rows in "
        + "total, ever fails content verification, this record does not account for it and must "
        + "not be read as though it does. /api/v1/archive/verify publishes that comparison "
        + "directly as integrity.documented.accountsForObserved."
    }]);

    log.log("ledger: appended " + SERIALISATION_DEFECT + " erratum ("
      + n + " rows, seq " + from + "-" + to + ")");
    return true;
  } catch (e) {
    log.error("serialisation erratum append failed:", e.message);
    return false;
  }
}

/**
 * @param v       the return value of ledger.verify()
 * @param errata  erratum rows from the ledger (newest-first or oldest-first;
 *                order does not matter, the defect id is unique)
 */
export function assessDisclosure(v = {}, errata = []) {
  const observed = v.unverifiableRows ?? 0;
  const e = (Array.isArray(errata) ? errata : [])
    .find(x => x && x.correctsDefect === SERIALISATION_DEFECT) || null;

  // ── The absent-field trap ─────────────────────────────────
  // When linkage breaks, verify() returns EARLY: it stops walking and never
  // populates unverifiableRows at all. Reading that absence as zero — which is
  // what `?? 0` above does, and must, for the ordinary cases — meant an archive
  // with a row DELETED came back as accountsForObserved:true, on the reasoning
  // that nothing failed content verification. Nothing failed it because it
  // never ran.
  //
  // Caught by the end-to-end test and not by any unit test, because every
  // hand-built input had the field present. The lesson generalises: a field
  // that is sometimes absent will eventually be read as its default by code
  // that never considered absence, and defaults are chosen to look calm.
  //
  // A linkage failure is a graver claim than this record describes, and
  // attributing it to a known benign defect would be the most misleading thing
  // this function could do.
  if (v.linkageIntact === false) {
    return {
      present: Boolean(e),
      ...(e ? { at: e.t ?? null, seq: e.seq ?? null,
                coversSeqFrom: e.coversSeqFrom ?? null, coversSeqTo: e.coversSeqTo ?? null,
                rowsAtRecord: e.rowsAtRecord ?? 0 } : {}),
      accountsForObserved: false,
      note: "The ORDER of this archive is in question — rows appear to have been removed, "
          + "inserted or reordered. That is a different and more serious failure than any "
          + "content record describes, and content verification did not complete, so nothing "
          + "here should be read as accounting for it."
    };
  }

  if (!e) {
    return {
      present: false,
      accountsForObserved: false,
      note: observed > 0
        // Deliberately not softened. Rows are failing and nothing dated stands
        // behind an explanation, which is exactly the situation a reader should
        // treat with suspicion — including when the cause turns out to be dull.
        ? "No dated record in this archive accounts for these rows. Until one is written and "
          + "sealed there is nothing chained to check this verdict against, and it should be "
          + "read as an undocumented fault."
        : "No unverifiable rows, and no record needed."
    };
  }

  const from = e.coversSeqFrom ?? null;
  const to = e.coversSeqTo ?? null;
  const atRecord = e.rowsAtRecord ?? 0;
  const first = v.firstUnverifiableSeq ?? null;
  const last = v.lastUnverifiableSeq ?? null;

  // verify() collects mismatches in ascending sequence order, so first and last
  // bound every failing row between them. Containing that interval therefore
  // contains all of them — no need to carry the full list across this boundary.
  const within = observed === 0 || (
    first != null && last != null && from != null && to != null
    && first >= from && last <= to
  );
  const noMore = observed <= atRecord;

  // "No rows failed content verification" only means this record covers the
  // situation if there is no OTHER unresolved failure. verify() can return
  // ok:false with no content mismatches at all — a published seal disagreeing
  // with the chain, for instance — and that is emphatically not something this
  // record describes. Same absent-field trap as linkage, one layer down.
  const otherFailure = observed === 0 && v.ok === false;
  const accountsForObserved = Boolean(within && noMore && !otherFailure);

  let note;
  if (otherFailure) {
    note = "No row failed content verification, so this record is not what is wrong. "
         + "Verification is failing for another reason"
         + (v.reason ? " (" + v.reason + ")" : "") + ", which this record does not describe.";
  } else if (observed === 0) {
    note = "The recorded defect no longer produces failures in this archive.";
  } else if (accountsForObserved) {
    note = "Every row failing content verification today falls inside the range this record "
         + "admitted to (#" + from + "–#" + to + "), and there are no more of them than it "
         + "admitted to (" + atRecord + ").";
  } else if (!within) {
    note = "Rows OUTSIDE the documented range (#" + from + "–#" + to + ") are failing content "
         + "verification. This record does not account for them. Treat this archive as having an "
         + "undocumented fault; do not read the existing record as covering it.";
  } else {
    note = "More rows are failing content verification (" + observed + ") than this record "
         + "admitted to (" + atRecord + "), within the same range. The difference is "
         + "undocumented.";
  }

  return {
    present: true,
    at: e.t ?? null,
    seq: e.seq ?? null,
    coversSeqFrom: from,
    coversSeqTo: to,
    rowsAtRecord: atRecord,
    accountsForObserved,
    note
  };
}
