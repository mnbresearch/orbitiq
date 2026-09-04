// ============================================================
// OrbitIQ conjunction screening engine.
//
// Coarse-to-fine close-approach screening using SGP4 propagation, an
// apogee/perigee sieve and 3D spatial hashing.
//
// ── Why this was rewritten ──────────────────────────────────
// The previous version sampled every 60 s and flagged a pair as a candidate
// only if it was already within 8 x the reporting threshold at one of those
// samples. Those two numbers were chosen independently, and they are not
// independent. A pair closing at 13 km/s crosses an 80 km gate in about
// 12 seconds, so sampling every 60 seconds found it roughly one time in five.
// Four out of five real conjunctions were never detected, and the response
// looked exactly the same as a clean screen.
//
// The fix is to derive the gate from the step instead of guessing it:
//
//     gate = threshold + vRelMax * step / 2
//
// If a pair's true minimum separation d* <= threshold occurs at time t*, the
// nearest sample t_i is at most step/2 away, so the separation seen at t_i is
// at most d* + vRel * step/2 <= gate. Any qualifying pair is therefore caught
// at the coarse stage, for every pair closing at or below vRelMax. That bound
// is reported in the response as `completeTo`, so the guarantee is stated
// rather than implied.
//
// Refinement used to be a 2-second grid, which at 13 km/s moves the pair 26 km
// per sample. The reported miss distance depended on where the grid phase
// happened to land — the same encounter reported anywhere from 3.1 km to
// 10.7 km depending only on the clock — which crossed three risk bands and
// caused spurious "risk increased 10x" re-alerts on every sweep. It is now a
// bracketed golden-section minimisation, converged to well under a metre, so
// the same encounter returns the same number every time.
// ============================================================
import * as satellite from "satellite.js";
import { EARTH_R_KM, V_REL_MAX_KMS } from "./constants.js";

// ── Attached and co-located objects ─────────────────────────
// A real catalogue contains many objects that are physically joined: the ISS
// and its visiting Soyuz/Progress/Dragon vehicles, the Chinese Space Station's
// Tianhe/Wentian/Mengtian modules with their Tianzhou and Shenzhou craft, and
// spacecraft still mated to a spent upper stage. Each is tracked under its own
// NORAD id, and each pair reports a separation of zero at a relative velocity
// of zero — because they are bolted together.
//
// Left alone, these dominate the results: they are the "closest approaches" in
// the entire catalogue, they are flagged CRITICAL, and they are the first
// thing a visitor sees. They are also completely meaningless as collision
// risk. Two objects cannot collide when they are already attached.
//
// The discriminator is relative velocity, not distance. A genuine slow
// conjunction (co-planar constellation drift, say) has a low closing speed but
// a real separation. An attached pair has BOTH a near-zero separation and a
// near-zero closing speed, sustained across the whole encounter.
const ATTACHED_MAX_SEP_KM = 0.5;    // 500 m — larger than any docked stack
const ATTACHED_MAX_REL_V  = 0.01;   // 10 m/s — below any real closing speed

/** True if this pair is physically attached or co-located, not conjuncting. */
function looksAttached(missKm, relVelKmS) {
  return missKm < ATTACHED_MAX_SEP_KM && relVelKmS < ATTACHED_MAX_REL_V;
}

/** SGP4's own Earth radius, used to convert satrec.a (in Earth radii) to km. */
const SGP4_R_KM = 6378.135;

function makeSatrec(gp) {
  try { return satellite.json2satrec(gp); } catch { return null; }
}

function posAt(satrec, date) {
  try {
    const pv = satellite.propagate(satrec, date);
    const p = pv?.position;
    if (!p || Number.isNaN(p.x)) return null;
    return p; // ECI km
  } catch { return null; }
}

function stateAt(satrec, date) {
  try {
    const pv = satellite.propagate(satrec, date);
    if (!pv?.position || Number.isNaN(pv.position.x)) return null;
    return pv;
  } catch { return null; }
}

/**
 * Radial band an object can occupy: [perigee, apogee] in km from Earth centre.
 * Two objects cannot be within `threshold` of each other unless these bands
 * overlap to within `threshold` — their radii would differ by more than the
 * separation, which is impossible. This is the classic apogee/perigee sieve
 * and it removes the large majority of pairs for the cost of two comparisons,
 * with no propagation at all.
 */
function radialBand(rec) {
  const a = rec.a * SGP4_R_KM;           // semi-major axis, km
  const e = rec.ecco ?? 0;
  if (!Number.isFinite(a) || a <= 0) return null;
  return { rp: a * (1 - e), ra: a * (1 + e) };
}

/**
 * Distance between two objects at a given offset from `start`, in km.
 * Returns Infinity where either propagation fails, so the minimiser simply
 * walks away from unusable regions instead of throwing.
 */
function sepAt(recA, recB, start, tSec) {
  const t = new Date(start.getTime() + tSec * 1000);
  const pa = posAt(recA, t), pb = posAt(recB, t);
  if (!pa || !pb) return Infinity;
  return Math.hypot(pa.x - pb.x, pa.y - pb.y, pa.z - pb.z);
}

const INV_PHI = (Math.sqrt(5) - 1) / 2;   // 0.618...

/**
 * Find the true time of closest approach near `tGuess`.
 *
 * A coarse scan over the bracket locates the sample containing the minimum,
 * which guards against the interval holding more than one approach; golden
 * section then converges on it. Golden section needs no derivative and cannot
 * diverge, which matters because SGP4 separation is smooth but not analytic.
 *
 * @returns {{tSec:number, dKm:number}} converged to `tolSec`
 */
function refineTca(recA, recB, start, tGuess, halfWindowSec, tolSec = 0.05) {
  const N = 8;
  let lo = tGuess - halfWindowSec, hi = tGuess + halfWindowSec;
  const step = (hi - lo) / N;
  let bestT = lo, bestD = Infinity;
  for (let i = 0; i <= N; i++) {
    const t = lo + i * step;
    const d = sepAt(recA, recB, start, t);
    if (d < bestD) { bestD = d; bestT = t; }
  }
  if (!Number.isFinite(bestD)) return { tSec: tGuess, dKm: Infinity };

  // Bracket the located minimum by one scan step on each side.
  let a = Math.max(lo, bestT - step), b = Math.min(hi, bestT + step);

  let c = b - INV_PHI * (b - a);
  let d = a + INV_PHI * (b - a);
  let fc = sepAt(recA, recB, start, c);
  let fd = sepAt(recA, recB, start, d);
  let guard = 0;
  while (b - a > tolSec && guard++ < 80) {
    if (fc < fd) { b = d; d = c; fd = fc; c = b - INV_PHI * (b - a); fc = sepAt(recA, recB, start, c); }
    else         { a = c; c = d; fc = fd; d = a + INV_PHI * (b - a); fd = sepAt(recA, recB, start, d); }
  }
  const tSec = (a + b) / 2;
  const dKm = sepAt(recA, recB, start, tSec);
  // The scan minimum is a valid fallback if the polish somehow did worse.
  return dKm <= bestD ? { tSec, dKm } : { tSec: bestT, dKm: bestD };
}

/**
 * Screen for close approaches.
 * @param sats        full catalog [{id,name,org,gp}]
 * @param primaryOrg  org id to screen (its sats vs everything), or null = all-vs-all
 * @param hours       look-ahead window
 * @param thresholdKm report pairs closer than this
 * @param opts        {maxPropagations, primaryIds, coarseStepSec}
 */
export function screenConjunctions(sats, primaryOrg, hours = 6, thresholdKm = 10, opts = {}) {
  const start = opts.start ? new Date(opts.start) : new Date();

  const MAX_OBJECTS = opts.maxObjects ?? 6000;
  const catalog = [];
  for (const s of sats) {
    if (catalog.length >= MAX_OBJECTS) break;
    const rec = makeSatrec(s.gp);
    if (!rec) continue;
    const band = radialBand(rec);
    if (!band) continue;
    catalog.push({ ...s, rec, band });
  }

  // `primaryIds` lets a caller screen an explicit set (a registered fleet)
  // rather than a whole operator, which is what the fleet watch needs.
  const idFilter = opts.primaryIds ? new Set([...opts.primaryIds].map(String)) : null;
  let primaries = catalog;
  if (idFilter) primaries = catalog.filter(s => idFilter.has(String(s.id)));
  else if (primaryOrg) primaries = catalog.filter(s => s.org === primaryOrg);

  if (!primaries.length) {
    return { events: [], screened: 0, catalogSize: catalog.length, windowHours: hours, thresholdKm };
  }

  // ── Apogee/perigee sieve ────────────────────────────────────
  // Only objects whose radial band overlaps some primary's band (widened by
  // the threshold) can possibly produce a qualifying event. For a small fleet
  // this typically removes 80-90% of the catalogue before any propagation,
  // which is what makes a fine time step affordable in the fleet case.
  let loR = Infinity, hiR = -Infinity;
  for (const p of primaries) { loR = Math.min(loR, p.band.rp); hiR = Math.max(hiR, p.band.ra); }
  loR -= thresholdKm; hiR += thresholdKm;
  const screenSet = catalog.filter(s => s.band.ra >= loR && s.band.rp <= hiR);

  // ── Step / gate selection ───────────────────────────────────
  // The step is set by the propagation budget; the gate is then whatever that
  // step requires for completeness. Never the other way round.
  const budget = opts.maxPropagations ?? 2_500_000;
  const windowSec = hours * 3600;
  const autoStep = Math.ceil((windowSec * Math.max(screenSet.length, 1)) / Math.max(budget, 1));
  const coarseStep = Math.min(60, Math.max(2, opts.coarseStepSec ?? autoStep));
  const coarseGate = thresholdKm + V_REL_MAX_KMS * (coarseStep / 2);
  const steps = Math.floor(windowSec / coarseStep);

  const primaryIdSet = new Set(primaries.map(s => s.id));

  // `open` holds the approach currently in progress for each pair; `kept` holds
  // the deepest finished one per pair, exactly as the previous implementation
  // did; `extras` holds additional approaches within a hard global budget.
  //
  // The shape matters more than it looks. A wrapper object per pair —
  // { n, best: [...] } — costs two extra allocations per Map entry, and on the
  // widest screen (unscoped, 24 h, 50 km) this Map has millions of keys. That
  // version reproduced the production out-of-memory in V8's Map::Grow. Keeping
  // one plain episode per pair, with the recurrence count carried ON it,
  // restores the original memory profile.
  const open = new Map();       // "idA|idB" -> {a,b,tSec,d2,lastStep}
  const kept = new Map();       // "idA|idB" -> ep  (deepest; ep.n = recurrences)
  const extras = [];            // additional approaches, globally bounded

  // A pair in a shared shell can re-approach dozens of times in one window at
  // essentially the same distance. Emitting every one would bury the isolated
  // encounters that actually need a decision under a repeating geometry that
  // needs a single conversation. So the deepest few are kept and the true
  // count is carried on them, which is more useful to an operator than either
  // one row or sixty.
  //
  // Four rather than eight. The output is capped at 100 events sorted by
  // distance, so every slot a recurring pair takes is one an unrelated
  // encounter does not get; and the fifth-deepest pass of a pair that already
  // has four reported adds almost nothing a reader would act on, because
  // `approachesInWindow` already tells them it recurs. Halving it also halves
  // the memory this bookkeeping costs on a 6,000-object catalogue.
  const MAX_EPISODES_PER_PAIR = 4;

  // ── Trim while accumulating, not afterwards ───────────────
  //
  // The first version of this pushed every finished episode into one array and
  // capped per pair at the end. That is bounded only by the total number of
  // approaches in the window, where the code it replaced was bounded by the
  // number of distinct PAIRS — and on a real catalogue, with 6,000 objects and
  // constellation shells whose members drift past each other continuously, the
  // difference is a few hundred thousand entries against a few million.
  //
  // It aborted the production screening worker with a heap out-of-memory after
  // three minutes and fifty seconds. Trimming here restores the old memory
  // order while still counting every approach: `n` is the true total, `best`
  // holds only the ones that will be reported.
  // A hard ceiling on the extra episodes, on top of the one-per-pair that the
  // previous implementation kept.
  //
  // Per-pair capping alone is not enough. The worker runs twelve screens and
  // the widest is unscoped, 24 hours, 50 km — where the coarse gate is several
  // hundred kilometres and a LEO pair crosses it on every orbit, so the same
  // pair legitimately opens and closes fifteen times a day. Multiply that by
  // the pair count of a 6,000-object catalogue and four-per-pair is still a
  // large multiple of what the old code held.
  //
  // So the first (deepest) episode per pair is always kept — exactly the old
  // memory profile — and additional episodes come out of a shared budget.
  // Beyond it, recurrences are still COUNTED, so `approachesInWindow` stays
  // truthful; only the extra rows stop being retained. Since the response is
  // capped at 100 events sorted by distance, the budget is far larger than
  // anything that can reach the output.
  const MAX_EXTRA_EPISODES = 5000;

  function closeEpisode(id, ep) {
    open.delete(id);
    const cur = kept.get(id);
    if (!cur) { ep.n = 1; kept.set(id, ep); return; }
    cur.n++;
    if (ep.d2 < cur.d2) {
      // A closer pass: it becomes the one always kept, and the previous
      // deepest is demoted to the extras budget rather than dropped.
      ep.n = cur.n;
      kept.set(id, ep);
      if (extras.length < MAX_EXTRA_EPISODES) extras.push({ id, ...cur });
    } else if (extras.length < MAX_EXTRA_EPISODES) {
      extras.push({ id, ...ep });
    }
    // Beyond the budget the recurrence is still counted on `cur.n`, so
    // approachesInWindow stays truthful; only the extra row is not retained.
  }

  const cell = coarseGate;
  const key = (x, y, z) =>
    `${Math.floor(x / cell)},${Math.floor(y / cell)},${Math.floor(z / cell)}`;

  for (let i = 0; i <= steps; i++) {
    const t = new Date(start.getTime() + i * coarseStep * 1000);

    const grid = new Map();
    const positions = new Map();
    for (const s of screenSet) {
      const p = posAt(s.rec, t);
      if (!p) continue;
      positions.set(s.id, p);
      const k = key(p.x, p.y, p.z);
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k).push(s);
    }

    for (const a of primaries) {
      const pa = positions.get(a.id);
      if (!pa) continue;
      const cx = Math.floor(pa.x / cell), cy = Math.floor(pa.y / cell), cz = Math.floor(pa.z / cell);
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
        const bucket = grid.get(`${cx + dx},${cy + dy},${cz + dz}`);
        if (!bucket) continue;
        for (const b of bucket) {
          if (b.id === a.id) continue;
          if (primaryIdSet.has(b.id) && b.id < a.id) continue;
          const pb = positions.get(b.id);
          const dxk = pa.x - pb.x, dyk = pa.y - pb.y, dzk = pa.z - pb.z;
          const d2 = dxk * dxk + dyk * dyk + dzk * dzk;
          if (d2 < coarseGate * coarseGate) {
            const id = a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`;

            // ── One entry per APPROACH, not one per pair ──────────
            //
            // This used to keep only the closest sample per pair for the whole
            // window, which quietly discarded every other approach they made.
            // Verified against a 1 s brute-force scan: a test fixture whose
            // pair passes inside the threshold twice reported one encounter,
            // and the second — a real 14.5 km pass — was simply gone.
            //
            // That matters beyond the count. Each approach has its own time of
            // closest approach and needs its own decision, and the evidence
            // layer binds a decision to a specific warning row — so a dropped
            // approach is an encounter with nothing to attach a decision to.
            //
            // A pair is inside the gate over a contiguous run of samples while
            // it closes and opens again. A break in that run ends the episode.
            const prev = open.get(id);
            if (prev && i === prev.lastStep + 1) {
              prev.lastStep = i;
              if (d2 < prev.d2) { prev.d2 = d2; prev.tSec = i * coarseStep; }
            } else {
              if (prev) closeEpisode(id, prev);
              open.set(id, { a, b, tSec: i * coarseStep, d2, lastStep: i });
            }
          }
        }
      }
    }
  }

  // Approaches still inside the gate when the window ended are real; a pair
  // that is closing as the horizon arrives is exactly the one an operator
  // most wants to hear about.
  for (const [id, ep] of open) closeEpisode(id, ep);

  // Flatten: the deepest per pair always, plus up to MAX_EPISODES_PER_PAIR-1
  // extras for pairs that recurred, carrying the true count on every row.
  const candidates = [];
  for (const [id, ep] of kept) candidates.push({ ...ep, id, approachesInWindow: ep.n });

  const extraByPair = new Map();
  for (const ex of extras) {
    const list = extraByPair.get(ex.id) || [];
    list.push(ex);
    extraByPair.set(ex.id, list);
  }
  for (const [id, list] of extraByPair) {
    list.sort((x, y) => x.d2 - y.d2);
    const n = kept.get(id)?.n ?? list.length;
    for (const ex of list.slice(0, MAX_EPISODES_PER_PAIR - 1)) {
      candidates.push({ ...ex, approachesInWindow: n });
    }
  }

  // ── Refinement ──────────────────────────────────────────────
  const events = [];
  let attached = 0;
  for (const c of candidates) {
    const { tSec, dKm } = refineTca(c.a.rec, c.b.rec, start, c.tSec, coarseStep);
    if (!(dKm <= thresholdKm)) continue;

    const t = new Date(start.getTime() + tSec * 1000);
    const A = stateAt(c.a.rec, t), B = stateAt(c.b.rec, t);
    if (!A || !B) continue;
    const relV = Math.hypot(
      A.velocity.x - B.velocity.x, A.velocity.y - B.velocity.y, A.velocity.z - B.velocity.z);
    const altKm = Math.hypot(A.position.x, A.position.y, A.position.z) - EARTH_R_KM;

    // Docked modules, mated stages and duplicate catalogue entries are not
    // conjunctions. Counted and reported, never presented as risk.
    if (looksAttached(dKm, relV)) { attached++; continue; }

    events.push({
      tca: t.toISOString(),
      missKm: +dKm.toFixed(3),
      relVelKmS: +relV.toFixed(2),
      altKm: +altKm.toFixed(0),
      risk: dKm < 1 ? "CRITICAL" : dKm < 3 ? "HIGH" : dKm < 6 ? "MODERATE" : "LOW",
      a: { id: c.a.id, name: c.a.name, org: c.a.org },
      b: { id: c.b.id, name: c.b.name, org: c.b.org },
      // How many times this pair came inside the gate across the window.
      // Greater than one means a recurring geometry rather than an isolated
      // event, which changes the response: a pair that will pass this close
      // every orbit is a conversation about the orbit, not a series of
      // independent avoidance decisions.
      approachesInWindow: c.approachesInWindow,
      recurring: c.approachesInWindow > 1
    });
  }
  // Closest first: the reader's first question is what the worst one was.
  // Ties broken by time so a recurring pair's rows come out in a stable,
  // chronological order rather than however the map happened to iterate.
  events.sort((x, y) => (x.missKm - y.missKm) || (x.tca < y.tca ? -1 : 1));

  return {
    events: events.slice(0, 100),
    screened: primaries.length,
    catalogSize: catalog.length,
    sievedTo: screenSet.length,
    windowHours: hours,
    thresholdKm,
    // Pairs discarded as physically attached (docked stacks, mated stages).
    // Surfaced rather than silently dropped, so the number is auditable.
    attachedPairsExcluded: attached,
    // Stated honestly so callers can tell how much to trust a clean result.
    method: {
      coarseStepSec: coarseStep,
      coarseGateKm: +coarseGate.toFixed(1),
      completeToRelVelKmS: V_REL_MAX_KMS,
      maxApproachesReportedPerPair: MAX_EPISODES_PER_PAIR,
      extraApproachRowsRetained: extras.length,
      extraApproachRowBudget: MAX_EXTRA_EPISODES,
      approachNote: "Each separate close pass is reported, not only the deepest one: a pair "
                  + "may approach several times in a window and each has its own time of "
                  + "closest approach. Where a pair recurs more often than the cap, the "
                  + "closest passes are reported and every row carries the true count.",
      note: `Complete for pairs closing at up to ${V_REL_MAX_KMS} km/s: the ${coarseGate.toFixed(0)} km gate cannot be crossed between ${coarseStep} s samples below that speed. TCA refined by golden-section minimisation to <0.05 s.`
    },
    generatedAt: new Date().toISOString()
  };
}
