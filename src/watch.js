// ============================================================
// OrbitIQ — the fleet watch.
//
// This is the loop that earns the subscription. For every workspace with
// a registered fleet it screens the live catalogue against that fleet,
// assesses each encounter properly (Foster Pc, RIC geometry), applies
// the workspace's own alert policy, and delivers what clears it — once,
// by email and webhook, with a manoeuvre plan already attached.
//
// Everything it finds is written to the intelligence archive at the
// moment of detection, whether or not anybody is notified.
// ============================================================
import * as satellite from "satellite.js";
import * as fleet from "./fleet.js";
import * as pcmod from "./pc.js";
import * as mailer from "./mailer.js";

const EARTH_R = 6378.137;

// ─────────────────── element-set age ───────────────────
/** Age of a TLE/GP element set in days. Drives the covariance model. */
export function elementAgeDays(gp) {
  const epoch = gp?.EPOCH || gp?.epoch;
  if (!epoch) return 3;                       // unknown: assume stale-ish
  const t = new Date(epoch).getTime();
  if (!Number.isFinite(t)) return 3;
  return Math.max(0, (Date.now() - t) / 86400000);
}

function kindOf(sat) {
  const n = `${sat?.name || ""} ${sat?.objectType || ""}`;
  if (/deb/i.test(n)) return "debris";
  if (/r\/b|rocket/i.test(n)) return "rocket body";
  return "payload";
}

/** State vector at a given time, ECI km and km/s. */
function stateAt(gp, when) {
  try {
    const rec = satellite.json2satrec(gp);
    const pv = satellite.propagate(rec, when);
    if (!pv?.position || Number.isNaN(pv.position.x)) return null;
    return { r: pv.position, v: pv.velocity };
  } catch { return null; }
}

/**
 * Take a screening event and turn it into a full assessment: real
 * geometry at TCA, modelled covariance from each object's element age,
 * Foster probability, and the isotropic reference bound.
 */
export function assessEvent(ev, satsById, hbrM) {
  const A = satsById.get(ev.a?.id);
  const B = satsById.get(ev.b?.id);
  if (!A || !B) return null;
  const tca = new Date(ev.tca);
  const sa = stateAt(A.gp, tca);
  const sb = stateAt(B.gp, tca);
  if (!sa || !sb) return null;

  const ageA = elementAgeDays(A.gp), ageB = elementAgeDays(B.gp);
  const a = pcmod.assess(
    { rA: sa.r, vA: sa.v, rB: sb.r, vB: sb.v },
    { ageDaysA: ageA, ageDaysB: ageB, kindA: kindOf(A), kindB: kindOf(B), hbrM }
  );
  return {
    ...a,
    tca: ev.tca,
    leadHours: +((tca - Date.now()) / 3600000).toFixed(2),
    altKm: +(Math.hypot(sa.r.x, sa.r.y, sa.r.z) - EARTH_R).toFixed(1),
    primary:   { id: A.id, name: A.name, ageDays: +ageA.toFixed(2), kind: kindOf(A) },
    secondary: { id: B.id, name: B.name, ageDays: +ageB.toFixed(2), kind: kindOf(B) },
    state: { rA: sa.r, vA: sa.v, rB: sb.r, vB: sb.v }
  };
}

/**
 * Screen one workspace's registered fleet against the catalogue.
 * Returns assessed encounters sorted by probability, worst first.
 */
export function screenFleet(wsId, sats, screenFn, opts = {}) {
  const ids = new Set(fleet.assetIds(wsId));
  if (!ids.size) return { assessed: [], fleetSize: 0 };

  const satsById = new Map(sats.map(s => [String(s.id), s]));
  const mine = sats.filter(s => ids.has(String(s.id)));
  if (!mine.length) {
    return { assessed: [], fleetSize: ids.size,
             note: "Registered spacecraft are not present in the current catalogue." };
  }

  // Screen the registered objects against everything.
  const raw = screenFn(sats, null, opts.hours ?? 48, opts.thresholdKm ?? 25);
  const mineIds = new Set(mine.map(s => String(s.id)));
  const relevant = (raw.events || []).filter(
    e => mineIds.has(String(e.a?.id)) || mineIds.has(String(e.b?.id))
  );

  const assessed = [];
  for (const ev of relevant) {
    // Orient so the registered spacecraft is always the primary.
    const oriented = mineIds.has(String(ev.a?.id)) ? ev : { ...ev, a: ev.b, b: ev.a };
    const asset = fleet.getAsset(wsId, oriented.a.id);
    // Combined hard-body radius: our spacecraft plus a representative
    // 1 m radius for the secondary, which is usually an uncharacterised
    // fragment. Metres.
    const hbrM = (asset?.radiusM ?? 1.5) + 1.0;
    const a = assessEvent(oriented, satsById, hbrM);
    if (!a) continue;
    a.asset = asset ? { noradId: asset.noradId, name: asset.name, massKg: asset.massKg,
                        ispS: asset.ispS, manoeuvrable: asset.manoeuvrable } : null;
    a.missKm = ev.missKm ?? a.missKm;
    assessed.push(a);
  }
  assessed.sort((x, y) => y.pc - x.pc);
  return { assessed, fleetSize: ids.size, screened: mine.length, catalogSize: raw.catalogSize };
}

// ─────────────────── notification ───────────────────
function fmtPc(p) {
  if (p >= 0.01) return (p * 100).toFixed(1) + "%";
  return p.toExponential(2);
}

export function alertEmailHtml(ws, a, plan) {
  const row = (k, v) =>
    `<tr><td style="padding:7px 14px 7px 0;color:#7385a3;font-size:12.5px;white-space:nowrap">${k}</td>
     <td style="padding:7px 0;font-size:13.5px;color:#e6edfa"><b>${v}</b></td></tr>`;
  const best = plan?.options?.find(o => o.feasible) || plan?.options?.[0];
  return `<!doctype html><html><body style="margin:0;background:#04060c;padding:28px 16px;font-family:-apple-system,Segoe UI,Inter,sans-serif">
<div style="max-width:600px;margin:0 auto;background:#0b101c;border:1px solid rgba(90,130,200,.22);border-radius:16px;padding:28px 26px;color:#e6edfa">
  <div style="font-size:19px;font-weight:650;margin-bottom:4px">Orbit<span style="color:#38bdf8">IQ</span></div>
  <div style="font-size:11px;letter-spacing:1.4px;text-transform:uppercase;color:#ff8b93;margin-bottom:20px">Conjunction alert · ${a.pcBand}</div>

  <p style="margin:0 0 18px;font-size:14.5px;line-height:1.55;color:#c3cfe4">
    <b>${esc(a.primary.name)}</b> has a close approach with <b>${esc(a.secondary.name)}</b>
    in ${a.leadHours.toFixed(1)} hours.</p>

  <table style="width:100%;border-collapse:collapse;background:#060a15;border:1px solid rgba(90,130,200,.18);border-radius:10px;padding:6px 14px">
    ${row("Time of closest approach", new Date(a.tca).toUTCString())}
    ${row("Miss distance", a.missKm.toFixed(3) + " km")}
    ${row("Probability of collision", fmtPc(a.pc) + "  (" + a.pcBand + ")")}
    ${row("Relative velocity", a.relVelKmS.toFixed(2) + " km/s")}
    ${row("Radial / In-track / Cross-track", `${a.ric.radialKm.toFixed(2)} / ${a.ric.inTrackKm.toFixed(2)} / ${a.ric.crossTrackKm.toFixed(2)} km`)}
    ${row("Altitude", a.altKm + " km")}
    ${row("Element age (primary / secondary)", `${a.primary.ageDays} / ${a.secondary.ageDays} days`)}
  </table>

  ${best ? `<div style="margin-top:20px;padding:16px 18px;background:rgba(62,201,255,.07);border:1px solid rgba(62,201,255,.28);border-radius:10px">
    <div style="font-size:11px;letter-spacing:1.3px;text-transform:uppercase;color:#38bdf8;margin-bottom:8px">Suggested avoidance</div>
    <div style="font-size:13.5px;line-height:1.6;color:#c3cfe4">
      A <b>${best.deltaVms.toFixed(3)} m/s</b> along-track burn ${best.leadHours} h before TCA
      opens the miss to <b>${best.resultingMissKm} km</b>, taking probability to
      <b>${fmtPc(best.pcAfter)}</b> for about <b>${best.propellantKg.toFixed(3)} kg</b> of propellant.
    </div></div>` : ""}

  <p style="margin:20px 0 0;font-size:13px;line-height:1.55;color:#c3cfe4">
    Open the encounter in the <a href="https://orbit.mnbresearch.com/app" style="color:#38bdf8;text-decoration:none">console</a>
    for the full geometry and manoeuvre options.</p>

  <p style="margin:18px 0 0;font-size:11.5px;line-height:1.5;color:#6c7f9e">
    ${esc(a.covariance.primary.note)} Screening product — confirm against an operator CDM before acting.</p>

  <div style="margin-top:24px;padding-top:16px;border-top:1px solid rgba(90,130,200,.18);font-size:11.5px;color:#7385a3">
    Built by MNB Research · <a href="https://orbit.mnbresearch.com" style="color:#38bdf8;text-decoration:none">orbit.mnbresearch.com</a>
  </div>
</div></body></html>`;
}

const esc = s => String(s ?? "").replace(/[&<>"]/g,
  c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;" }[c]));

/**
 * Run the watch for one workspace: screen, assess, apply policy, deliver.
 * `deps` is injected so this is testable without a live catalogue.
 */
export async function runWatch(wsId, ws, sats, screenFn, deps = {}) {
  const { onEvent } = deps;
  const policy = fleet.getPolicy(wsId);
  const { assessed, fleetSize } = screenFleet(wsId, sats, screenFn);
  if (!assessed.length) return { fleetSize, assessed: 0, notified: 0 };

  let notified = 0;
  const quiet = fleet.inQuietHours(policy);

  for (const a of assessed) {
    const ev = { a: { id: a.primary.id }, b: { id: a.secondary.id }, tca: a.tca, missKm: a.missKm };
    const q = fleet.qualifies(policy, ev, a);
    if (!q.pass) continue;

    // Quiet hours suppress everything except CRITICAL.
    if (quiet && a.pcBand !== "CRITICAL") continue;

    const dedupe = fleet.shouldNotify(wsId, ev, a.pc);
    if (!dedupe.notify) continue;

    // Attach a manoeuvre plan if we know enough about the spacecraft.
    let plan = null;
    if (a.asset?.manoeuvrable && a.state) {
      try {
        plan = pcmod.planManoeuvre(a.state, {
          targetMissKm: Math.max(policy.missThresholdKm, 2),
          massKg: a.asset.massKg, ispS: a.asset.ispS, hbrM: a.hbrM,
          ageDaysA: a.primary.ageDays, ageDaysB: a.secondary.ageDays,
          kindA: a.primary.kind, kindB: a.secondary.kind,
          leadsHours: [Math.max(2, Math.floor(a.leadHours) - 1), 12, 6, 3]
            .filter(h => h < a.leadHours).slice(0, 4)
        });
      } catch { /* planning is best-effort */ }
    }

    const payload = {
      type: "conjunction.alert",
      workspace: { id: wsId, name: ws?.name },
      reason: q.why,
      encounter: {
        tca: a.tca, leadHours: a.leadHours, missKm: a.missKm,
        pc: a.pc, pcBand: a.pcBand, pcMaxIsotropic: a.pcMaxIsotropic,
        relVelKmS: a.relVelKmS, ric: a.ric, altKm: a.altKm,
        primary: a.primary, secondary: a.secondary,
        covariance: a.covariance, method: a.method, caveat: a.caveat
      },
      manoeuvre: plan,
      generatedAt: new Date().toISOString()
    };

    if (policy.email && ws?.email && mailer.enabled()) {
      await mailer.sendRaw({
        to: ws.email,
        subject: `OrbitIQ ${a.pcBand}: ${a.primary.name} × ${a.secondary.name} in ${a.leadHours.toFixed(0)}h`,
        html: alertEmailHtml(ws, a, plan)
      }).catch(() => {});
    }
    if (policy.webhookUrl) await fleet.deliverWebhook(policy, payload, wsId);

    fleet.recordNotified(wsId, dedupe.key, a.pc);
    onEvent?.(payload);
    notified++;
  }

  return { fleetSize, assessed: assessed.length, notified, worst: assessed[0] || null };
}
