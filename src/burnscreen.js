// ============================================================
// Screening a manoeuvre before you fly it.
//
// ── The question nobody answers by default ──────────────────
// An operator gets a conjunction warning, designs an avoidance burn, and
// checks that it opens the miss distance against the object they were warned
// about. That check is the easy half. The half that gets skipped is: having
// moved, what have you moved TOWARDS?
//
// A burn does not remove you from traffic, it relocates you within it. In a
// shell as populated as the 500-600 km band, an along-track shift of a few
// kilometres reshuffles which objects you pass close to for days afterwards.
// ESA's own practice makes this explicit — they screen orbit files covering
// candidate manoeuvres to confirm the intended risk reduction AND that other
// conjunction risks stay acceptable. This module does that second screen.
//
// ── The physical model, and its honest limits ───────────────
// A tangential burn changes semi-major axis, which changes mean motion, which
// integrates into an along-track displacement growing linearly with time:
//
//     delta_s(t) ~= 3 * delta_v * (t - t_burn)
//
// That is the standard first-order result, the same one the manoeuvre planner
// uses. So the post-burn trajectory is modelled as the original SGP4
// trajectory displaced along-track by delta_s(t). This is accurate for the
// small burns and short horizons that collision avoidance actually involves
// (centimetres per second, days), and it degrades for large burns or long
// horizons because it ignores the changed orbital period's second-order
// effects, drag on the new orbit, and any out-of-plane component.
//
// It is emphatically NOT a replacement for propagating a real post-burn
// ephemeris in flight dynamics software. It is a fast screen that tells an
// operator whether a candidate burn is obviously a bad idea before they spend
// an afternoon on it. That framing is carried through to every output.
// ============================================================
import * as satellite from "satellite.js";
import * as pcmod from "./pc.js";
import { elementAgeDays, kindOf, stateAt } from "./orbitstate.js";
import { EARTH_R_KM as EARTH_R } from "./constants.js";

const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const norm = v => Math.hypot(v.x, v.y, v.z);
const unit = v => { const n = norm(v) || 1; return { x: v.x / n, y: v.y / n, z: v.z / n }; };

/** Along-track displacement (km) from a tangential burn, t seconds after it. */
export const alongTrackShiftKm = (deltaVms, secondsSinceBurn) =>
  secondsSinceBurn <= 0 ? 0 : 3 * (deltaVms / 1000) * secondsSinceBurn;

/**
 * Post-burn state: original SGP4 state, displaced along its own velocity
 * direction by the accumulated drift.
 */
function displacedState(gp, when, burnAt, deltaVms) {
  const s = stateAt(gp, when);
  if (!s) return null;
  const dt = (when.getTime() - burnAt.getTime()) / 1000;
  const shift = alongTrackShiftKm(deltaVms, dt);
  if (!shift) return s;
  const along = unit(s.v);
  return {
    r: { x: s.r.x + along.x * shift, y: s.r.y + along.y * shift, z: s.r.z + along.z * shift },
    v: s.v,
    shiftKm: shift
  };
}

/**
 * Closest approach between the (optionally displaced) primary and one
 * secondary, over a window.
 *
 * Coarse scan then golden-section refinement. The coarse step is chosen from
 * the same completeness argument the main screener uses: an encounter cannot
 * be missed if the step is short enough that relative motion cannot cross the
 * gate between samples.
 */
function closestApproach(primaryGp, secondaryGp, from, to, { burnAt = null, deltaVms = 0, stepSec = 30 } = {}) {
  const at = (ms) => {
    const when = new Date(ms);
    const p = burnAt ? displacedState(primaryGp, when, burnAt, deltaVms) : stateAt(primaryGp, when);
    const s = stateAt(secondaryGp, when);
    if (!p || !s) return null;
    return { p, s, d: norm(sub(s.r, p.r)) };
  };

  let best = null;
  for (let ms = from.getTime(); ms <= to.getTime(); ms += stepSec * 1000) {
    const e = at(ms);
    if (!e) continue;
    if (!best || e.d < best.d) best = { ...e, ms };
  }
  if (!best) return null;

  // Refine around the coarse minimum.
  let lo = best.ms - stepSec * 1000, hi = best.ms + stepSec * 1000;
  const phi = (Math.sqrt(5) - 1) / 2;
  let c = hi - (hi - lo) * phi, d = lo + (hi - lo) * phi;
  let fc = at(c)?.d ?? Infinity, fd = at(d)?.d ?? Infinity;
  for (let i = 0; i < 40 && (hi - lo) > 100; i++) {
    if (fc < fd) { hi = d; d = c; fd = fc; c = hi - (hi - lo) * phi; fc = at(c)?.d ?? Infinity; }
    else { lo = c; c = d; fc = fd; d = lo + (hi - lo) * phi; fd = at(d)?.d ?? Infinity; }
  }
  const tca = new Date((lo + hi) / 2);
  const e = at(tca.getTime());
  if (!e) return null;
  return {
    tca: tca.toISOString(),
    missKm: +e.d.toFixed(4),
    relVelKmS: +norm(sub(e.s.v, e.p.v)).toFixed(3),
    altKm: +(norm(e.p.r) - EARTH_R).toFixed(1),
    state: { rA: e.p.r, vA: e.p.v, rB: e.s.r, vB: e.s.v },
    shiftKm: e.p.shiftKm ? +e.p.shiftKm.toFixed(3) : 0
  };
}

const assessFor = (enc, A, B, hbrM) => pcmod.assess(enc, {
  ageDaysA: elementAgeDays(A.gp), ageDaysB: elementAgeDays(B.gp),
  kindA: kindOf(A), kindB: kindOf(B), hbrM
});

/**
 * Screen a candidate avoidance burn.
 *
 * Answers three questions, in the order an operator asks them:
 *   1. Does it fix the conjunction I was warned about?
 *   2. Does it create a worse one?
 *   3. Was it worth the propellant?
 *
 * @param primary      sat object for the manoeuvring spacecraft (needs .gp)
 * @param catalog      candidate secondaries (needs .gp)
 * @param opts.deltaVms          tangential burn magnitude, m/s (signed)
 * @param opts.burnAtIso         when the burn happens
 * @param opts.targetSecondaryId the object the burn is meant to avoid
 * @param opts.hours             screening horizon after the burn
 */
export function screenBurn(primary, catalog, {
  deltaVms, burnAtIso, targetSecondaryId = null,
  hours = 72, thresholdKm = 10, hbrM = 20, maxSecondaries = 1200
} = {}) {

  const dv = Number(deltaVms);
  if (!Number.isFinite(dv) || dv === 0) return { error: "deltaVms must be a non-zero number" };
  const burnAt = new Date(burnAtIso || Date.now());
  if (!Number.isFinite(burnAt.getTime())) return { error: "burnAtIso is not a valid time" };
  if (!primary?.gp) return { error: "primary needs a gp element set" };

  const from = burnAt;
  const to = new Date(burnAt.getTime() + hours * 3600 * 1000);

  // Radial-band sieve: only objects whose altitude band can overlap the
  // primary's are worth propagating. Keeps this affordable on a small host.
  const pState = stateAt(primary.gp, burnAt);
  if (!pState) return { error: "cannot propagate the primary at the burn time" };
  const pAlt = norm(pState.r) - EARTH_R;
  const maxShift = Math.abs(alongTrackShiftKm(dv, hours * 3600));

  const candidates = [];
  for (const s of catalog) {
    if (candidates.length >= maxSecondaries) break;
    if (!s.gp || String(s.id) === String(primary.id)) continue;
    const st = stateAt(s.gp, burnAt);
    if (!st) continue;
    const alt = norm(st.r) - EARTH_R;
    // An along-track shift does not change altitude to first order, so a band
    // filter on altitude stays valid before and after the burn.
    if (Math.abs(alt - pAlt) > 60) continue;
    candidates.push(s);
  }

  const before = [], after = [];
  for (const s of candidates) {
    const b = closestApproach(primary.gp, s.gp, from, to, { stepSec: 30 });
    const a = closestApproach(primary.gp, s.gp, from, to, { burnAt, deltaVms: dv, stepSec: 30 });
    if (b && b.missKm <= thresholdKm) before.push({ s, ...b });
    if (a && a.missKm <= thresholdKm) after.push({ s, ...a });
  }

  const key = e => String(e.s.id);
  const beforeBy = new Map(before.map(e => [key(e), e]));
  const afterBy = new Map(after.map(e => [key(e), e]));

  const row = (e, tag) => {
    const as = assessFor(e.state, primary, e.s, hbrM);
    return {
      id: e.s.id, name: e.s.name || null, tca: e.tca,
      missKm: e.missKm, relVelKmS: e.relVelKmS, altKm: e.altKm,
      pc: as.pc, pcBand: as.pcBand, pcModel: as.pcModel,
      covarianceDriven: as.covarianceDriven, kind: tag
    };
  };

  // ── 1. the conjunction being avoided ──
  let target = null;
  if (targetSecondaryId != null) {
    const k = String(targetSecondaryId);
    const b = beforeBy.get(k), a = afterBy.get(k);
    if (b) {
      const beforeRow = row(b, "target");
      const afterRow = a ? row(a, "target") : null;
      // Whether the burn actually helped. A tangential burn displaces you
      // along-track by a distance that grows with lead time, so it is entirely
      // possible to shift straight INTO the object you meant to avoid — the
      // drift passes through the encounter rather than away from it. An early
      // version of this file reported "relieves the target" without checking,
      // which would have endorsed a burn that made the conjunction ten times
      // closer. The improvement test now gates every downstream statement.
      const improved = !a || (afterRow && afterRow.pc < beforeRow.pc);
      target = {
        id: k,
        name: b.s.name || null,
        before: beforeRow,
        after: afterRow,
        // If the object no longer appears, the burn pushed it outside the
        // screening threshold entirely. Say that rather than reporting null.
        clearedThreshold: !a,
        improved,
        // Expressed as "times safer": above 1 is an improvement, below 1 means
        // the burn increased the probability. Named so the direction cannot be
        // misread, unlike a bare "reduction factor".
        timesSafer: afterRow && afterRow.pc > 0
          ? +(beforeRow.pc / afterRow.pc).toFixed(2)
          : (afterRow ? null : "beyond screening threshold"),
        warning: improved ? null
          : "This burn moves the spacecraft CLOSER to the object it was meant to avoid. "
          + "A tangential burn drifts along-track; at this lead time the drift carries you "
          + "through the encounter rather than away from it. Try the opposite sign, a "
          + "different burn time, or a larger magnitude."
      };
    }
  }

  // ── 2. what the burn moved you towards ──
  // The point of the module. An event that was not there before, or was there
  // and got worse, is the operator's problem and is reported first.
  const introduced = after.filter(e => !beforeBy.has(key(e))).map(e => row(e, "introduced"));
  const worsened = after.filter(e => {
    const b = beforeBy.get(key(e));
    return b && e.missKm < b.missKm - 0.05;
  }).map(e => {
    const b = beforeBy.get(key(e));
    const r = row(e, "worsened");
    r.missKmBefore = b.missKm;
    return r;
  });
  const relieved = before.filter(e => !afterBy.has(key(e))).length;

  introduced.sort((x, y) => (y.pc || 0) - (x.pc || 0));
  worsened.sort((x, y) => (y.pc || 0) - (x.pc || 0));

  const worstNew = introduced[0] || worsened[0] || null;

  return {
    burnAt: burnAt.toISOString(),
    deltaVms: dv,
    horizonHours: hours,
    thresholdKm,
    alongTrackShiftAtHorizonKm: +maxShift.toFixed(2),
    secondariesScreened: candidates.length,

    target,
    introduced,
    worsened,
    conjunctionsRelieved: relieved,

    // A single line an operator can act on. Deliberately conservative: if the
    // burn creates anything at or above the band of what it fixes, say so
    // plainly rather than presenting a net-positive score.
    // Ordered so the disqualifying condition is checked FIRST. Anything that
    // reports on side effects before establishing that the burn does its job
    // can endorse a manoeuvre that makes the target worse.
    verdict: !target
      ? "No baseline conjunction found for the named target in this window."
      : !target.improved
        ? "REJECT: this burn increases the probability against the object it was meant to avoid. "
          + "Do not fly it. Try the opposite sign, a different burn time, or a larger magnitude."
        : introduced.length === 0 && worsened.length === 0
          ? "Burn reduces the target risk and introduces no new conjunction above the screening threshold."
          : worstNew && target.after && worstNew.pc >= (target.after.pc ?? 0)
            ? "Burn relieves the target conjunction but introduces one at comparable or higher probability. Re-plan before flying."
            : "Burn relieves the target conjunction but introduces additional events below it. Review before flying.",

    model: "First-order tangential burn: post-burn trajectory modelled as the SGP4 trajectory "
         + "displaced along-track by 3*dv*t. Valid for small burns over short horizons.",
    caveat: "Screening aid, not a flight-dynamics product. It does not propagate a true post-burn "
          + "ephemeris, ignores out-of-plane components and drag on the new orbit, and uses public "
          + "element sets with a modelled covariance. Validate any burn in your own flight dynamics "
          + "system and against operator CDMs before execution."
  };
}
