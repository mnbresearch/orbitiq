// ============================================================
// OrbitIQ Intelligence Ledger — the data moat.
// Append-only archive of every derived event the platform
// detects: conjunctions, maneuvers, anomalies, risk indices,
// congestion snapshots. Past detections cannot be re-derived
// from public data by a later entrant; every day the platform
// runs, this asset compounds.
// ============================================================
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.ORBITIQ_DATA_DIR || path.join(__dirname, "..", "data");
const FILE = path.join(DATA_DIR, "ledger.jsonl");
const ANCHOR_FILE = path.join(DATA_DIR, "ledger-anchor.json");
const SEALS_FILE = path.join(DATA_DIR, "ledger-seals.json");
const MAX_LINES = 200000; // rotate: keep the most recent events

// ── Tamper-evidence ──────────────────────────────────────────
// Every row carries its sequence number, the hash of the row before it, and
// its own hash. Altering or removing any row changes that row's hash, which
// breaks `prev` on every row after it — so tampering cannot be local, it has
// to be a rewrite of the entire tail, and verify() finds the exact seam.
//
// This is tamper-EVIDENT, not tamper-proof. Anyone with write access to the
// file can rewrite the whole chain. What makes that expensive is seal(): the
// tip hash is periodically published to a public branch whose commits are
// timestamped by GitHub, so a rewrite has to disagree with an anchor that was
// published before the rewrite happened. The strength of the claim comes from
// the public commit history, not from a signature we hold — we deliberately
// do not claim cryptographic non-repudiation we cannot back.
const GENESIS = "genesis";
const HASH_LEN = 32;               // 128 bits of hex: ample for tamper-evidence

/**
 * The row hash, exported deliberately.
 *
 * The entire proposition is that a third party can check this archive without
 * trusting us, and they cannot do that without knowing exactly how a row hash
 * is formed. Keeping the construction private would mean every independent
 * verifier had to reverse-engineer it from the output — so it is public API,
 * along with the canonical form and the body projection it depends on.
 */
export const hashRow = (seq, prev, body) =>
  crypto.createHash("sha256")
    .update(String(seq) + "|" + prev + "|" + canonical(body))
    .digest("hex").slice(0, HASH_LEN);

/**
 * Key-sorted JSON so the hash cannot change just because key order did.
 *
 * Undefined-valued keys are omitted, and undefined array entries become null,
 * because that is what JSON.stringify does when the row is written to disk.
 * This function decides what gets hashed and JSON.stringify decides what gets
 * stored, so any disagreement between them produces a row whose body cannot be
 * reconstructed from the file — a permanent, unfixable verification failure
 * with no edit behind it. That is not hypothetical; it is what happened to 600
 * rows on 7 September 2026. See forStorage() near append().
 *
 * Note this changes no historical hash. A row read back from the file has
 * already been through JSON.stringify, so it never carries undefined; only
 * in-memory rows on the write path ever could.
 */
export function canonical(o) {
  if (o === null || typeof o !== "object") return JSON.stringify(o);
  if (Array.isArray(o)) {
    return "[" + o.map(v => (v === undefined || typeof v === "function" ? "null" : canonical(v))).join(",") + "]";
  }
  return "{" + Object.keys(o).sort()
    .filter(k => o[k] !== undefined && typeof o[k] !== "function")
    .map(k => JSON.stringify(k) + ":" + canonical(o[k])).join(",") + "}";
}

/** The chain fields are metadata, not payload — excluded from the body hash. */
export const bodyOf = ({ seq, prev, h, ...rest }) => rest;

function readJson(f, fallback) {
  try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return fallback; }
}
function writeJson(f, v) {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(f, JSON.stringify(v, null, 2)); }
  catch (e) { console.error("ledger: write failed", f, e.message); }
}

let cache = null; // in-memory mirror

function loadAll() {
  if (cache) return cache;
  try {
    cache = fs.readFileSync(FILE, "utf8").split("\n").filter(Boolean).map(l => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
  } catch { cache = []; }
  return cache;
}

/** Tip of the chain: the last row that actually carries chain fields. */
function tip() {
  const all = loadAll();
  for (let i = all.length - 1; i >= 0; i--) {
    if (all[i] && typeof all[i].seq === "number" && all[i].h) return all[i];
  }
  // Nothing chained yet. If we have rotated before, resume from the anchor so
  // the sequence keeps climbing and old seals still line up.
  const a = readJson(ANCHOR_FILE, null);
  return a ? { seq: a.seq, h: a.h } : null;
}

/**
 * Reduce a row to exactly what a reader will parse back out of the file.
 *
 * ── Why this exists ─────────────────────────────────────────
 * A row is hashed in memory and stored with JSON.stringify. Those two did not
 * agree about `undefined`. canonical() walks Object.keys(), which includes keys
 * whose value is undefined, and JSON.stringify(undefined) returns the JS value
 * undefined, which string concatenation turns into the literal text
 * "undefined". JSON.stringify, writing the row out, drops those keys entirely.
 *
 * So a row carrying `pc: undefined` was hashed over
 *
 *     {..., "pc":undefined, ...}
 *
 * and written to disk as
 *
 *     {...}
 *
 * The body that produced the hash no longer existed anywhere. Every future
 * verification of that row had to fail, permanently, and there was no edit and
 * no attacker — just two serialisers disagreeing about a missing value.
 *
 * On 7 September 2026 a sweep ran on a freshly woken instance before the
 * catalogue had loaded, so augmentation left pc, pcText, sigmaMajorKm,
 * sigmaMinorKm, ageDaysA and ageDaysB undefined on 600 conjunction rows. From
 * the first of them the whole archive read as "chain broken — row altered",
 * and because seal() refuses to seal a broken chain, external sealing stopped
 * for 25 hours as well.
 *
 * ── The rule now ────────────────────────────────────────────
 * Hash what you store; store what you hash. Normalising through a JSON round
 * trip BEFORE the hash is taken makes that true by construction, and not only
 * for undefined: NaN and Infinity become null, Date becomes a string, and
 * anything else JSON cannot carry is resolved while the value is still being
 * decided rather than silently afterwards. Fixing canonical() alone would have
 * closed this instance of the bug and left the class of it open.
 */
const forStorage = r => JSON.parse(JSON.stringify(r));

export function append(type, payload) {
  const rows = (Array.isArray(payload) ? payload : [payload]).map(p => forStorage({
    t: new Date().toISOString(), type, ...p
  }));
  if (!rows.length) return 0;

  // Chain them. Rows written before this feature existed have no seq/h; they
  // stay as they are and verify() reports them as unchained rather than
  // pretending they were covered.
  const last = tip();
  let seq = last ? last.seq : 0;
  let prev = last ? last.h : GENESIS;
  for (const r of rows) {
    seq += 1;
    const h = hashRow(seq, prev, bodyOf(r));
    r.seq = seq; r.prev = prev; r.h = h;

    // ── Prove the row survives its own round trip, before writing it ──
    //
    // The whole chain rests on one invariant: the hash stored beside a row is
    // the hash of the row a reader will parse back. Nothing checked that, so
    // when it stopped being true the archive did not find out at the moment of
    // writing — it found out afterwards, from the public verification endpoint,
    // and by then the rows were on disk in an append-only file.
    //
    // This is the cheapest possible statement of that invariant, at the one
    // point where it is still fixable. Re-hashing a row we just built is
    // microseconds; a row that fails here is repaired by adopting the parsed
    // form, so what goes to disk always matches its hash rather than being
    // written poisoned and discovered later.
    const readBack = JSON.parse(JSON.stringify(r));
    if (hashRow(readBack.seq, readBack.prev, bodyOf(readBack)) !== h) {
      console.error("ledger: row " + seq + " did not survive serialisation; storing the parsed form");
      for (const k of Object.keys(r)) if (!(k in readBack)) delete r[k];
      Object.assign(r, readBack);
      r.h = hashRow(r.seq, r.prev, bodyOf(r));
    }
    prev = r.h;
  }

  loadAll().push(...rows);
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.appendFileSync(FILE, rows.map(r => JSON.stringify(r)).join("\n") + "\n");
    if (cache.length > MAX_LINES) {
      // Rotation drops the head of the file, which would otherwise orphan the
      // retained rows: their `prev` would point at something no longer present
      // and verification could not tell truncation from tampering. Record what
      // was dropped so the retained window stays checkable.
      const dropped = cache[cache.length - MAX_LINES - 1];
      cache = cache.slice(-MAX_LINES);
      if (dropped && dropped.h) {
        writeJson(ANCHOR_FILE, {
          seq: dropped.seq, h: dropped.h, droppedThrough: dropped.t,
          at: new Date().toISOString(),
          note: "Rows at or before this sequence were rotated out of the retained window. "
              + "Seals published before this point still cover them."
        });
      }
      fs.writeFileSync(FILE, cache.map(r => JSON.stringify(r)).join("\n") + "\n");
    }
  } catch (e) { console.error("ledger write failed:", e.message); }
  return rows.length;
}

/**
 * Walk the chain and report the first place it breaks.
 *
 * Returns the seam rather than a bare boolean: "the archive is invalid" is
 * useless to someone holding a dispute, whereas "rows 1..8,412 verify and the
 * break is at 8,413" tells them exactly what is still good.
 */
export function verify() {
  const all = loadAll();
  const anchor = readJson(ANCHOR_FILE, null);
  let checked = 0, unchained = 0, firstChainedIndex = -1;
  const contentMismatches = [];
  // Read once so every exit path can report it. Withholding the tip on failure
  // told the reader nothing and cost them the one identifier they could take
  // away and compare against a seal.
  const tipRow = tip();
  let prev = anchor ? anchor.h : GENESIS;
  let expectSeq = anchor ? anchor.seq + 1 : 1;

  for (let i = 0; i < all.length; i++) {
    const r = all[i];
    if (typeof r.seq !== "number" || !r.h) { unchained++; continue; }
    if (firstChainedIndex < 0) {
      firstChainedIndex = i;
      // ── Only trust a row about its own past when nothing else knows ──
      //
      // This used to adopt the first chained row's claimed linkage
      // unconditionally, with the reasoning that an archive predating
      // hash-chaining legitimately starts mid-file. True — but it also
      // discarded the rotation anchor, and the anchor is the ONLY record of
      // what was dropped.
      //
      // The effect was that after a rotation the oldest retained rows could be
      // deleted and verification still returned ok: it simply re-based on
      // whatever row now happened to be first. Head-truncation — quietly
      // removing the earliest surviving warnings — was undetectable, which is
      // precisely the attack the anchor was written to stop.
      //
      // So the row's own claim is adopted only when there is no anchor. With
      // one, the retained window must continue from it or the archive is
      // reported broken.
      if (!anchor) { prev = r.prev; expectSeq = r.seq; }
      else if (r.seq !== expectSeq || r.prev !== prev) {
        return {
          ok: false,
          reason: "retained window does not continue from the rotation anchor",
          atIndex: i, seq: r.seq, expectedSeq: expectSeq,
          anchorSeq: anchor.seq, verified: checked, unchained, t: r.t,
          linkageIntact: false, tipSeq: tipRow ? tipRow.seq : null, tipHash: tipRow ? tipRow.h : null,
          means: "Rotation recorded that rows up to sequence " + anchor.seq + " were dropped, "
               + "so the first retained row must be " + expectSeq + ". It is " + r.seq + ". "
               + "Rows have been removed from the start of the retained window, or the anchor "
               + "and the archive come from different histories."
        };
      }
    }
    if (r.seq !== expectSeq) {
      return { ok: false, reason: "sequence gap", atIndex: i, expectedSeq: expectSeq,
               foundSeq: r.seq, seq: r.seq, verified: checked, unchained, t: r.t,
               linkageIntact: false, tipSeq: tipRow ? tipRow.seq : null, tipHash: tipRow ? tipRow.h : null,
               means: "A sequence number is missing. Rows have been removed from the middle of the "
                    + "archive, or two histories have been spliced together." };
    }
    if (r.prev !== prev) {
      return { ok: false, reason: "broken link", atIndex: i, seq: r.seq,
               verified: checked, unchained, t: r.t,
               linkageIntact: false, tipSeq: tipRow ? tipRow.seq : null, tipHash: tipRow ? tipRow.h : null,
               means: "This row does not point at the row before it. Unlike a content mismatch, this "
                    + "means the ORDER of the archive is in question, not just one row's contents." };
    }
    // ── A content mismatch is recorded, not fatal to the walk ──────
    //
    // Linkage and content are two different claims and they fail for different
    // reasons, so collapsing them loses the distinction a reader most needs.
    //
    // `prev` chains off the STORED hash, which is intact here, so the walk can
    // continue and describe the whole archive instead of stopping at the first
    // bad row. It matters: 600 unreconstructible rows out of 37,971 used to
    // render the entire record as "chain broken — row altered", with no way to
    // tell from the outside whether that meant six hundred rows or all of them.
    //
    // Continuing is not leniency. Every mismatch is still counted, still named,
    // and still makes ok false. What changes is that the answer is now "these
    // rows, this many, here" rather than "somewhere".
    if (hashRow(r.seq, r.prev, bodyOf(r)) !== r.h) {
      contentMismatches.push({ seq: r.seq, atIndex: i, t: r.t, type: r.type });
      prev = r.h; expectSeq = r.seq + 1;
      continue;
    }
    prev = r.h; expectSeq = r.seq + 1; checked++;
  }
  // ── Cross-check against the published seals ────────────────
  //
  // Everything above proves the retained rows are self-consistent. That is not
  // the same as proving they are the rows that were there before, because a
  // sufficiently determined edit can rewrite a row and every hash after it —
  // the chain would then verify perfectly against itself.
  //
  // The seals are what close that. Each one records the tip sequence and hash
  // at a moment, and is published hourly to a branch whose commit timestamps
  // the repository owner cannot backdate. So any seal whose sequence still
  // falls inside the retained window is an independent assertion about what
  // that row's hash was, made before the edit could have happened.
  //
  // This is the check that makes "tamper-evident" mean something beyond
  // "internally consistent".
  const seals = readJson(SEALS_FILE, []);
  const bySeq = new Map(all.filter(r => typeof r.seq === "number").map(r => [r.seq, r]));
  for (const s of seals) {
    const row = bySeq.get(s.seq);
    if (!row) continue;                      // rotated out; the seal still stands, we just cannot check it here
    if (row.h !== s.hash) {
      return {
        ok: false,
        reason: "row contradicts a published seal",
        seq: s.seq, sealedHash: s.hash, foundHash: row.h, sealedAt: s.at,
        verified: checked, unchained, linkageIntact: true,
        tipSeq: tipRow ? tipRow.seq : null, tipHash: tipRow ? tipRow.h : null,
        unverifiableRows: contentMismatches.length,
        means: "The archive is internally consistent but disagrees with a checkpoint published "
             + "at " + s.at + ". A seal is recorded to an external branch whose commit times "
             + "cannot be backdated, so this row was different at that moment. Rewriting a row "
             + "and every hash after it produces a chain that verifies against itself; this is "
             + "the check that does not."
      };
    }
  }

  const t = tip();
  // Contiguous runs, so a reader sees "35,428–36,147" rather than 600 numbers.
  const ranges = [];
  for (const m of contentMismatches) {
    const last = ranges[ranges.length - 1];
    if (last && m.seq === last.toSeq + 1) { last.toSeq = m.seq; last.count++; last.lastAt = m.t; }
    else ranges.push({ fromSeq: m.seq, toSeq: m.seq, count: 1, firstAt: m.t, lastAt: m.t, type: m.type });
  }

  return {
    // Linkage held all the way through, so nothing was removed or reordered;
    // but rows whose content no longer matches their own hash mean the archive
    // does not fully verify, and that is reported as failure rather than
    // softened into a warning.
    ok: contentMismatches.length === 0,
    verified: checked, unchained,
    chainStartsAt: firstChainedIndex >= 0 ? all[firstChainedIndex].seq : null,
    // Always reported, pass or fail. These used to be omitted on failure, so a
    // broken chain showed the reader an em dash where the tip should be and a
    // literal "Break at #?" — the interface losing its nerve at the exact
    // moment it had the most to explain.
    tipSeq: t ? t.seq : null, tipHash: t ? t.h : null,
    anchored: !!anchor,
    linkageIntact: true,
    unverifiableRows: contentMismatches.length,
    unverifiableRanges: ranges.slice(0, 50),
    firstUnverifiableSeq: contentMismatches.length ? contentMismatches[0].seq : null,
    lastUnverifiableSeq: contentMismatches.length ? contentMismatches[contentMismatches.length - 1].seq : null,
    sealsChecked: seals.filter(s => bySeq.has(s.seq)).length,
    sealsOutsideWindow: seals.filter(s => !bySeq.has(s.seq)).length,
    reason: contentMismatches.length ? "content hash mismatch" : null,
    means: contentMismatches.length
      ? contentMismatches.length + " row(s) do not match the hash stored beside them. Every row still "
        + "links to the one before it and no sequence number is missing, so nothing has been removed "
        + "or reordered — what is lost is the cryptographic attestation of those rows' contents. "
        + "A content mismatch is consistent with an edit AND with a fault on the write path, and this "
        + "endpoint does not decide which: check the affected sequences against the errata below, the "
        + "published seals, and the external witness log, and reach your own conclusion."
      : "Every retained row links to the one before it and matches its own hash.",
    note: unchained
      ? unchained + " row(s) predate hash-chaining and are reported as unchained rather than counted as verified."
      : "Every retained row links to the one before it."
  };
}

/**
 * Take a checkpoint of the current tip. Published to the public backup branch,
 * this is what stops history being rewritten quietly after the fact.
 */
export function seal() {
  const v = verify();
  // ── Seal on a linkage failure, not on a content one ────────
  //
  // This used to refuse on any verification failure at all. The reasoning was
  // sound — do not publish a checkpoint for a chain you cannot stand behind —
  // but the consequence was not: when 600 rows stopped matching their hashes,
  // sealing stopped too, and the archive went 25 hours with no new external
  // attestation. Every hour in that state was an hour of NEW, perfectly good
  // rows accumulating with nothing outside the service vouching for them.
  //
  // That is backwards. The seals are the part an operator cannot forge after
  // the fact, so a damaged archive needs them more than a healthy one, not
  // less. A broken linkage is different: if the order is in question then the
  // tip is not meaningfully the tip, and sealing it would assert something
  // untrue. So: refuse on linkage, proceed on content, and record on the seal
  // itself exactly how much of the chain it is willing to speak for.
  if (v.linkageIntact === false) {
    return { ok: false, error: "refusing to seal a chain whose linkage is broken", detail: v };
  }
  const t = tip();
  if (!t) return { ok: false, error: "nothing to seal yet" };
  const seals = readJson(SEALS_FILE, []);
  const last = seals[seals.length - 1];
  if (last && last.seq === t.seq) return { ok: true, unchanged: true, seal: last };
  const s = {
    seq: t.seq, hash: t.h, count: v.verified, at: new Date().toISOString(),
    // Carried so a reader of the seal file alone can see that this checkpoint
    // was taken over an archive with known unverifiable rows, rather than
    // discovering it later and wondering what the seal was worth.
    ...(v.unverifiableRows ? { unverifiableRows: v.unverifiableRows } : {})
  };
  seals.push(s);
  // Keep it small enough to publish comfortably; the oldest seals matter most
  // for old disputes, so drop from the middle rather than the head.
  if (seals.length > 400) seals.splice(200, seals.length - 400);
  writeJson(SEALS_FILE, seals);
  return { ok: true, seal: s, totalSeals: seals.length };
}

export const seals = () => readJson(SEALS_FILE, []);
export const anchor = () => readJson(ANCHOR_FILE, null);

/**
 * A verifiable extract for one operator over one window — the artefact an
 * insurer, a regulator or a counterparty actually asks for.
 */
export function proof({ org, since, until, limit = 2000 } = {}) {
  const t0 = since ? new Date(since).getTime() : 0;
  const t1 = until ? new Date(until).getTime() : Infinity;
  const all = loadAll();
  const rows = [];
  for (const r of all) {
    const ts = new Date(r.t).getTime();
    if (ts < t0 || ts > t1) continue;
    if (org && r.org !== org && r.aOrg !== org && r.bOrg !== org) continue;
    rows.push(r);
    if (rows.length >= limit) break;
  }
  const ss = seals();
  const first = rows[0], last = rows[rows.length - 1];
  // The seals that bracket this window are what date it: a seal taken AFTER
  // the last row proves those rows existed by then.
  const covering = first && last
    ? ss.filter(s => s.seq >= (last.seq || 0)).slice(0, 3)
    : [];
  return {
    org: org || null,
    window: { since: since || (first ? first.t : null), until: until || (last ? last.t : null) },
    events: rows.length,
    range: first && last ? { fromSeq: first.seq ?? null, toSeq: last.seq ?? null } : null,
    rows,
    sealsAfterThisWindow: covering,
    verification: verify(),
    howToVerify: [
      "1. For each row, recompute sha256(seq + '|' + prev + '|' + canonicalJSON(row without seq/prev/h)) and take the first 32 hex characters; it must equal the row's h.",
      "2. Each row's prev must equal the previous row's h, and seq must increase by exactly 1.",
      "3. Re-walk the chain to a published seal and confirm the tip hash matches.",
      "4. Seals are published to the public backup branch of github.com/mnbresearch/orbitiq — the commit timestamp is the independent evidence of when that tip existed."
    ],
    caveat: "Tamper-evident, not tamper-proof: this shows history has not been edited since a published seal. It is not a cryptographic signature and does not assert who wrote the rows."
  };
}

export function query({ type, org, since, until, limit = 500 } = {}) {
  const t0 = since ? new Date(since).getTime() : 0;
  const t1 = until ? new Date(until).getTime() : Infinity;
  const out = [];
  const all = loadAll();
  for (let i = all.length - 1; i >= 0 && out.length < Math.min(limit, 2000); i--) {
    const r = all[i];
    const ts = new Date(r.t).getTime();
    if (ts < t0 || ts > t1) continue;
    if (type && r.type !== type) continue;
    if (org && r.org !== org && r.aOrg !== org && r.bOrg !== org) continue;
    out.push(r);
  }
  return { count: out.length, events: out, ledgerSize: all.length, oldest: all[0]?.t || null };
}

export function riskHistory(org) {
  const rows = loadAll().filter(r => r.type === "risk" && r.org === org);
  return {
    org,
    series: rows.map(r => ({ t: r.t, index: r.index, grade: r.grade, components: r.components })),
    note: "Daily Fleet Risk Index history — accumulates automatically while the platform runs."
  };
}

export const allEvents = () => loadAll();

/**
 * Drop the in-memory mirror and re-read from disk.
 *
 * Verification has to answer "what does the file say", not "what do we
 * remember writing" — otherwise an auditor checking a file we had already
 * cached would be shown our cache and told it was the archive. Also what makes
 * the integrity tests meaningful: they tamper with the file, then call this.
 */
export function reload() { cache = null; return loadAll().length; }

export function stats() {
  const all = loadAll();
  const byType = {};
  for (const r of all) byType[r.type] = (byType[r.type] || 0) + 1;
  return {
    totalEvents: all.length,
    byType,
    oldest: all[0]?.t || null,
    newest: all[all.length - 1]?.t || null,
    note: "Every event here was detected live and archived at detection time; this history is not reconstructable from public sources."
  };
}

// ---------- weekly fleet intelligence report ----------
export function weeklyReport(org, orgName) {
  const weekAgo = Date.now() - 7 * 86400000;
  const all = loadAll().filter(r => new Date(r.t).getTime() >= weekAgo);
  const mine = r => r.org === org || r.aOrg === org || r.bOrg === org;

  const conj = all.filter(r => r.type === "conjunction" && mine(r));
  const closest = conj.reduce((m, r) => (!m || r.missKm < m.missKm) ? r : m, null);
  const man = all.filter(r => r.type === "maneuver" && r.org === org);
  const anom = all.filter(r => r.type === "anomaly" && r.org === org);
  const risks = all.filter(r => r.type === "risk" && r.org === org)
    .map(r => ({ t: r.t, index: r.index, grade: r.grade }));
  const riskNow = risks[risks.length - 1] || null;
  const riskPrev = risks[0] || null;
  const trend = riskNow && riskPrev ? +(riskNow.index - riskPrev.index).toFixed(1) : null;

  const highlights = [];
  if (closest) highlights.push(`Closest approach: ${closest.missKm} km (${closest.aName} vs ${closest.bName}${closest.pc ? `, Pc ${closest.pcText}` : ""})`);
  if (man.length) highlights.push(`${man.length} maneuver${man.length > 1 ? "s" : ""} detected across the fleet`);
  if (anom.length) highlights.push(`${anom.length} pattern-of-life anomal${anom.length > 1 ? "ies" : "y"} flagged`);
  if (trend !== null) highlights.push(`Fleet Risk Index ${trend >= 0 ? "up" : "down"} ${Math.abs(trend)} points week-over-week`);
  if (!highlights.length) highlights.push("Quiet week — no significant events archived for this fleet.");

  const md = [
    `# Weekly Fleet Intelligence — ${orgName || org}`,
    `Period: ${new Date(weekAgo).toUTCString().slice(0, 16)} → ${new Date().toUTCString().slice(0, 16)}`,
    ``,
    `## Highlights`,
    ...highlights.map(h => `- ${h}`),
    ``,
    `## Numbers`,
    `- Conjunction events archived: ${conj.length}`,
    `- Maneuvers detected: ${man.length}`,
    `- Anomalies flagged: ${anom.length}`,
    riskNow ? `- Current Fleet Risk Index: ${riskNow.index} (grade ${riskNow.grade})` : `- Fleet Risk Index: accruing`,
    ``,
    `*Generated by OrbitIQ from its live detection archive. Screening-grade intelligence on public orbital data.*`
  ].join("\n");

  return {
    org, period: { from: new Date(weekAgo).toISOString(), to: new Date().toISOString() },
    highlights,
    counts: { conjunctions: conj.length, maneuvers: man.length, anomalies: anom.length },
    risk: { current: riskNow, weekAgo: riskPrev, trend },
    closestApproach: closest,
    markdown: md
  };
}
