// ============================================================
// OrbitIQ — Operations console (v14)
//
// Adds a "Fleet" workspace to the existing console: your registered
// spacecraft, the encounters that actually threaten them, a manoeuvre
// planner, and the alert policy that decides when OrbitIQ is allowed to
// interrupt you.
//
// Deliberately self-contained: it mounts its own view and styles rather
// than reaching into app.js, so the two can evolve independently.
// ============================================================
const API = "/api";
const $ = s => document.querySelector(s);
const el = (t, c, h) => { const e = document.createElement(t); if (c) e.className = c; if (h !== undefined) e.innerHTML = h; return e; };
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;" }[c]));
const key = () => localStorage.getItem("orbitiq-apikey") || "";

async function call(path, opts = {}) {
  const r = await fetch(API + path, {
    ...opts,
    headers: { "Content-Type": "application/json", "X-API-Key": key(), ...(opts.headers || {}) }
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error || `HTTP ${r.status}`), { status: r.status, body: j });
  return j;
}

const fmtPc = p => p == null ? "—" : (p >= 0.01 ? (p*100).toFixed(1) + "%" : p.toExponential(2));
const bandColor = b => ({
  CRITICAL: "#ff5d6c", HIGH: "#ff9f45", ELEVATED: "#ffd166",
  LOW: "#5ad2a0", NEGLIGIBLE: "#6c7f9e"
}[b] || "#6c7f9e");

// ─────────────────────────── styles ───────────────────────────
const CSS = `
.ops-wrap{padding:22px 26px;max-width:1400px;margin:0 auto}
.ops-head{display:flex;align-items:flex-end;gap:16px;flex-wrap:wrap;margin-bottom:22px}
.ops-head h2{font-size:22px;font-weight:650;letter-spacing:-.02em;margin:0}
.ops-head p{color:#8496b6;font-size:13.5px;margin:4px 0 0}
.ops-tabs{display:flex;gap:4px;margin-left:auto;background:rgba(255,255,255,.03);
  border:1px solid rgba(96,140,215,.16);border-radius:11px;padding:4px}
.ops-tab{padding:8px 15px;border-radius:8px;font:600 12.5px Inter,sans-serif;cursor:pointer;
  color:#8496b6;border:0;background:transparent;transition:.18s}
.ops-tab:hover{color:#eaf0fc}
.ops-tab.on{background:rgba(62,201,255,.14);color:#3ec9ff}
.ops-grid{display:grid;gap:16px}
.ops-card{background:rgba(12,18,32,.72);border:1px solid rgba(96,140,215,.16);
  border-radius:15px;padding:20px 22px;backdrop-filter:blur(12px)}
.ops-card h3{font-size:14.5px;font-weight:650;margin:0 0 4px;letter-spacing:-.01em}
.ops-card .sub{color:#5b6c8a;font-size:12px;margin-bottom:16px}
.ops-empty{color:#5b6c8a;font-size:13.5px;padding:28px 0;text-align:center;line-height:1.7}
.ops-row{display:flex;align-items:center;gap:14px;padding:13px 0;border-bottom:1px solid rgba(96,140,215,.1)}
.ops-row:last-child{border:0}
.ops-row .main{flex:1;min-width:0}
.ops-row b{font-size:14px;font-weight:600}
.ops-row .meta{color:#5b6c8a;font-size:12px;margin-top:3px;font-family:"IBM Plex Mono",monospace}
.pill{display:inline-block;padding:3px 9px;border-radius:99px;font:700 9.5px "IBM Plex Mono",monospace;
  letter-spacing:1px;text-transform:uppercase}
.ops-btn{padding:8px 15px;border-radius:9px;border:1px solid rgba(96,140,215,.3);
  background:rgba(255,255,255,.03);color:#eaf0fc;font:600 12.5px Inter,sans-serif;cursor:pointer;transition:.18s}
.ops-btn:hover{border-color:#3ec9ff;color:#3ec9ff}
.ops-btn.solid{background:linear-gradient(135deg,#3ec9ff,#2aa6dc);border-color:transparent;color:#04121f}
.ops-btn.danger:hover{border-color:#ff5d6c;color:#ff5d6c}
.ops-form{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:14px}
.ops-form label{display:block;font:500 10px "IBM Plex Mono",monospace;letter-spacing:1.2px;
  text-transform:uppercase;color:#5b6c8a;margin-bottom:5px}
.ops-form input,.ops-form select{width:100%;background:rgba(4,8,18,.8);border:1px solid rgba(96,140,215,.18);
  border-radius:8px;color:#eaf0fc;padding:9px 11px;font:inherit;font-size:13px;outline:none}
.ops-form input:focus,.ops-form select:focus{border-color:#3ec9ff}
.enc{display:grid;grid-template-columns:1fr auto;gap:16px;padding:16px 0;border-bottom:1px solid rgba(96,140,215,.1)}
.enc:last-child{border:0}
.enc .who{font-size:14.5px;font-weight:600}
.enc .who span{color:#5b6c8a;font-weight:400}
.enc .nums{display:flex;gap:22px;margin-top:9px;flex-wrap:wrap}
.enc .n{font-family:"IBM Plex Mono",monospace}
.enc .n i{display:block;font-style:normal;font-size:9.5px;letter-spacing:1px;text-transform:uppercase;color:#5b6c8a;margin-bottom:3px}
.enc .n b{font-size:14.5px;font-weight:500}
.ops-note{font-size:11.5px;color:#5b6c8a;line-height:1.6;margin-top:14px;
  padding-top:12px;border-top:1px solid rgba(96,140,215,.1)}
.ops-toast{position:fixed;right:22px;bottom:22px;z-index:9999;background:rgba(12,18,32,.96);
  border:1px solid rgba(96,140,215,.3);border-radius:12px;padding:13px 17px;font-size:13px;
  max-width:400px;box-shadow:0 20px 50px rgba(0,0,0,.6)}
.mono{font-family:"IBM Plex Mono",monospace}
`;

// ─────────────────────────── state ───────────────────────────
const S = { tab: "encounters", assets: [], encounters: [], policy: null, loading: false, note: null };

function toast(msg, ms = 4200) {
  const t = el("div", "ops-toast", msg);
  document.body.appendChild(t);
  setTimeout(() => t.remove(), ms);
}

// ─────────────────────────── views ───────────────────────────
function renderEncounters() {
  if (S.loading) return `<div class="ops-empty">Screening your fleet against the live catalogue…</div>`;
  if (!S.assets.length) {
    return `<div class="ops-empty">
      No spacecraft registered yet.<br>
      Add one on the <b>Fleet</b> tab and OrbitIQ will screen it continuously.</div>`;
  }
  if (!S.encounters.length) {
    return `<div class="ops-empty">
      No close approaches for your fleet in the screening window.<br>
      ${S.note ? esc(S.note) : "That is the outcome you want."}</div>`;
  }
  return S.encounters.map(e => `
    <div class="enc">
      <div>
        <div class="who">${esc(e.primary.name)} <span>×</span> ${esc(e.secondary.name)}</div>
        <div class="nums">
          <div class="n"><i>TCA</i><b>${new Date(e.tca).toUTCString().slice(5, 22)}Z</b></div>
          <div class="n"><i>Lead</i><b>${e.leadHours.toFixed(1)} h</b></div>
          <div class="n"><i>Miss</i><b>${e.missKm.toFixed(3)} km</b></div>
          <div class="n"><i>Pc</i><b style="color:${bandColor(e.pcBand)}">${fmtPc(e.pc)}</b></div>
          <div class="n"><i>Rel V</i><b>${e.relVelKmS.toFixed(2)} km/s</b></div>
          <div class="n"><i>R / I / C</i><b>${e.ric.radialKm.toFixed(2)} / ${e.ric.inTrackKm.toFixed(2)} / ${e.ric.crossTrackKm.toFixed(2)}</b></div>
          <div class="n"><i>Elem age</i><b>${e.primary.ageDays} / ${e.secondary.ageDays} d</b></div>
        </div>
      </div>
      <div style="text-align:right;display:flex;flex-direction:column;gap:9px;align-items:flex-end">
        <span class="pill" style="background:${bandColor(e.pcBand)}22;color:${bandColor(e.pcBand)}">${e.pcBand}</span>
        <button class="ops-btn" data-plan="${esc(e.primary.id)}|${esc(e.secondary.id)}">Plan manoeuvre</button>
      </div>
    </div>`).join("") + `
    <div class="ops-note">
      Probability is computed by Foster encounter-plane integration. Covariance is
      <b>modelled</b> from element-set age — TLEs carry none — so treat these as screening
      values and confirm against an operator CDM before acting.
    </div>`;
}

function renderFleet() {
  const rows = S.assets.length ? S.assets.map(a => `
    <div class="ops-row">
      <div class="main">
        <b>${esc(a.name)}</b>
        <div class="meta">NORAD ${esc(a.noradId)} · ${a.massKg} kg · Isp ${a.ispS} s · r ${a.radiusM} m ·
          ${a.manoeuvrable ? "manoeuvrable" : "no propulsion"}</div>
      </div>
      <button class="ops-btn danger" data-del="${esc(a.noradId)}">Remove</button>
    </div>`).join("")
    : `<div class="ops-empty">Nothing registered yet. Add your first spacecraft below.</div>`;

  return `${rows}
    <div style="margin-top:20px;padding-top:18px;border-top:1px solid rgba(96,140,215,.14)">
      <div class="ops-form">
        <div><label for="f-norad">NORAD ID *</label><input id="f-norad" placeholder="25544" inputmode="numeric"></div>
        <div><label for="f-name">Name</label><input id="f-name" placeholder="Our spacecraft"></div>
        <div><label for="f-mass">Mass (kg)</label><input id="f-mass" value="260" inputmode="decimal"></div>
        <div><label for="f-isp">Isp (s)</label><input id="f-isp" value="220" inputmode="decimal"></div>
        <div><label for="f-radius">Radius (m)</label><input id="f-radius" value="1.5" inputmode="decimal"></div>
        <div><label for="f-man">Propulsion</label>
          <select id="f-man"><option value="1">Manoeuvrable</option><option value="0">None</option></select></div>
      </div>
      <button class="ops-btn solid" id="f-add">Add to fleet</button>
    </div>
    <div class="ops-note">
      Mass and specific impulse feed the propellant estimate. Radius sets the hard-body
      radius used in the probability integral — it materially changes Pc, so use a real number.
    </div>`;
}

function renderPolicy() {
  const p = S.policy;
  if (!p) return `<div class="ops-empty">Loading policy…</div>`;
  return `
    <div class="ops-form">
      <div><label for="p-pc">Alert at Pc ≥</label><input id="p-pc" value="${p.pcThreshold}"></div>
      <div><label for="p-miss">…or miss ≤ (km)</label><input id="p-miss" value="${p.missThresholdKm}"></div>
      <div><label for="p-lead">Minimum lead (h)</label><input id="p-lead" value="${p.leadHoursMin}"></div>
      <div><label for="p-email">Email alerts</label>
        <select id="p-email"><option value="1" ${p.email?"selected":""}>On</option><option value="0" ${!p.email?"selected":""}>Off</option></select></div>
    </div>
    <div class="ops-form" style="grid-template-columns:1fr">
      <div><label for="p-hook">Webhook URL (https only)</label>
        <input id="p-hook" value="${esc(p.webhookUrl || "")}" placeholder="https://hooks.yourdomain.com/orbitiq"></div>
    </div>
    ${p.webhookSecret ? `<div class="meta mono" style="color:#5b6c8a;font-size:11.5px;margin:-4px 0 14px">
       Signing secret ${esc(p.webhookSecret)} · payloads carry <b>OrbitIQ-Signature: v1=HMAC-SHA256(timestamp.body)</b></div>` : ""}
    <div style="display:flex;gap:10px;flex-wrap:wrap">
      <button class="ops-btn solid" id="p-save">Save policy</button>
      <button class="ops-btn" id="p-run">Run watch now</button>
    </div>
    <div class="ops-note">
      An encounter alerts once. It only alerts again if its probability grows by an order
      of magnitude — the case where you genuinely want telling twice.
    </div>`;
}

function render() {
  const host = $("#ops-body");
  if (!host) return;
  host.innerHTML =
    S.tab === "encounters" ? renderEncounters() :
    S.tab === "fleet" ? renderFleet() : renderPolicy();
  wire();
}

// ─────────────────────────── actions ───────────────────────────
function wire() {
  $("#f-add")?.addEventListener("click", async () => {
    const body = {
      noradId: $("#f-norad").value.trim(),
      name: $("#f-name").value.trim(),
      massKg: $("#f-mass").value, ispS: $("#f-isp").value,
      radiusM: $("#f-radius").value, manoeuvrable: $("#f-man").value === "1"
    };
    try {
      await call("/fleet/assets", { method: "POST", body: JSON.stringify(body) });
      toast("Added to fleet. It will be screened on the next sweep.");
      await loadFleet(); render();
    } catch (e) { toast(e.status === 402 ? `${e.message}` : `Could not add: ${e.message}`); }
  });

  document.querySelectorAll("[data-del]").forEach(b => b.addEventListener("click", async () => {
    if (!confirm("Remove this spacecraft from the fleet?")) return;
    try {
      await call("/fleet/assets/" + b.dataset.del, { method: "DELETE" });
      await loadFleet(); render();
    } catch (e) { toast(e.message); }
  }));

  document.querySelectorAll("[data-plan]").forEach(b => b.addEventListener("click", async () => {
    const [primaryId, secondaryId] = b.dataset.plan.split("|");
    b.textContent = "Planning…"; b.disabled = true;
    try {
      const r = await call("/fleet/manoeuvre", {
        method: "POST", body: JSON.stringify({ primaryId, secondaryId, targetMissKm: 5 })
      });
      showPlan(r);
    } catch (e) {
      toast(e.status === 402 ? "Manoeuvre planning is part of the Constellation tier." : e.message);
    }
    b.textContent = "Plan manoeuvre"; b.disabled = false;
  }));

  $("#p-save")?.addEventListener("click", async () => {
    try {
      const r = await call("/fleet/policy", { method: "PUT", body: JSON.stringify({
        pcThreshold: parseFloat($("#p-pc").value),
        missThresholdKm: parseFloat($("#p-miss").value),
        leadHoursMin: parseFloat($("#p-lead").value),
        email: $("#p-email").value === "1",
        webhookUrl: $("#p-hook").value.trim()
      })});
      S.policy = r.policy;
      toast(r.policy.webhookSecret
        ? "Policy saved. Copy the signing secret now — it is shown in full only once."
        : "Policy saved.");
      render();
    } catch (e) { toast("Could not save: " + e.message); }
  });

  $("#p-run")?.addEventListener("click", async () => {
    toast("Running the watch against the live catalogue…");
    try {
      const r = await call("/fleet/watch/run", { method: "POST" });
      toast(`Watch complete — ${r.assessed} encounter(s) assessed, ${r.notified} alert(s) raised.`);
      await loadEncounters(); if (S.tab === "encounters") render();
    } catch (e) { toast(e.message); }
  });
}

function showPlan(r) {
  const p = r.plan;
  const rows = p.options.map(o => `
    <tr>
      <td style="padding:8px 16px 8px 0">${o.leadHours} h before TCA</td>
      <td class="mono" style="padding:8px 16px 8px 0">${o.deltaVms.toFixed(4)} m/s</td>
      <td class="mono" style="padding:8px 16px 8px 0">${o.propellantKg.toFixed(3)} kg</td>
      <td class="mono" style="padding:8px 16px 8px 0">${o.resultingMissKm} km</td>
      <td class="mono" style="padding:8px 0;color:${bandColor(o.pcAfterBand)}">${fmtPc(o.pcAfter)}</td>
    </tr>`).join("");

  const modal = el("div", "", `
    <div style="position:fixed;inset:0;background:rgba(3,5,11,.8);z-index:9998;display:grid;place-items:center;padding:24px"
         id="plan-back">
      <div style="background:#0c1220;border:1px solid rgba(96,140,215,.3);border-radius:18px;
                  padding:28px 30px;max-width:720px;width:100%;box-shadow:0 40px 90px rgba(0,0,0,.7)">
        <div style="font:700 10px 'IBM Plex Mono',monospace;letter-spacing:1.8px;text-transform:uppercase;color:#3ec9ff">
          Manoeuvre options</div>
        <h3 style="margin:10px 0 6px;font-size:19px;font-weight:650">${esc(r.spacecraft.name)}</h3>
        <div style="color:#8496b6;font-size:13px;margin-bottom:20px">
          Current miss ${p.currentMissKm} km · Pc ${fmtPc(p.currentPc)} (${p.currentBand}) ·
          target ${p.targetMissKm} km · needs ${p.alongTrackNeededKm} km of along-track separation
        </div>
        <table style="width:100%;border-collapse:collapse;font-size:13px">
          <tr style="color:#5b6c8a;font:500 10px 'IBM Plex Mono',monospace;letter-spacing:1px;text-transform:uppercase">
            <td style="padding-bottom:8px">Burn at</td><td>Δv</td><td>Propellant</td><td>New miss</td><td>New Pc</td></tr>
          ${rows}
        </table>
        <div style="margin-top:20px;padding-top:14px;border-top:1px solid rgba(96,140,215,.14);
                    font-size:11.5px;color:#5b6c8a;line-height:1.6">
          ${esc(p.model)}<br>${esc(p.caveat)}
        </div>
        <button class="ops-btn" style="margin-top:18px" id="plan-close">Close</button>
      </div>
    </div>`);
  document.body.appendChild(modal);
  const close = () => modal.remove();
  modal.querySelector("#plan-close").addEventListener("click", close);
  modal.querySelector("#plan-back").addEventListener("click", e => { if (e.target.id === "plan-back") close(); });
}

// ─────────────────────────── loaders ───────────────────────────
async function loadFleet() {
  try { S.assets = (await call("/fleet/assets")).assets || []; }
  catch { S.assets = []; }
}
async function loadPolicy() {
  try { S.policy = (await call("/fleet/policy")).policy; }
  catch { S.policy = null; }
}
async function loadEncounters() {
  if (!S.assets.length) { S.encounters = []; return; }
  S.loading = true; render();
  try {
    const r = await call("/fleet/encounters?hours=48");
    S.encounters = r.encounters || []; S.note = r.note || null;
  } catch (e) {
    S.encounters = [];
    S.note = e.status === 402 ? "Fleet screening is part of the Operator tier." : e.message;
  }
  S.loading = false;
}

// ─────────────────────────── mount ───────────────────────────
export async function mountOps(container) {
  if (!container) return;
  if (!document.getElementById("ops-css")) {
    const st = el("style"); st.id = "ops-css"; st.textContent = CSS;
    document.head.appendChild(st);
  }
  container.innerHTML = `
    <div class="ops-wrap">
      <div class="ops-head">
        <div>
          <h2>Fleet operations</h2>
          <p>Your spacecraft, the encounters that threaten them, and what to do about it.</p>
        </div>
        <div class="ops-tabs">
          <button class="ops-tab on" data-tab="encounters">Encounters</button>
          <button class="ops-tab" data-tab="fleet">Fleet</button>
          <button class="ops-tab" data-tab="policy">Alerts</button>
        </div>
      </div>
      <div class="ops-card"><div id="ops-body"></div></div>
    </div>`;

  container.querySelectorAll(".ops-tab").forEach(b => b.addEventListener("click", async () => {
    container.querySelectorAll(".ops-tab").forEach(x => x.classList.toggle("on", x === b));
    S.tab = b.dataset.tab;
    if (S.tab === "policy" && !S.policy) await loadPolicy();
    if (S.tab === "encounters" && !S.encounters.length) await loadEncounters();
    render();
  }));

  await loadFleet();
  await loadEncounters();
  render();
}

// Live alerts pushed over the existing websocket.
export function onAlert(payload) {
  const e = payload?.encounter;
  if (!e) return;
  toast(`<b style="color:${bandColor(e.pcBand)}">${e.pcBand}</b> — ${esc(e.primary?.name)} × ${esc(e.secondary?.name)}
         in ${e.leadHours?.toFixed?.(1)} h, Pc ${fmtPc(e.pc)}`, 9000);
}

// The host page mounts this lazily when the Fleet tab is first opened, so
// nothing here runs for users who never look at it.
if (typeof window !== "undefined") window.OrbitIQOps = { mountOps, onAlert };
