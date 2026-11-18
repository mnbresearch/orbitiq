// ============================================================
// OrbitIQ — Autonomous AI Copilot & Flight Operations Console
//
// Interactive console for the Flight Safety Officer, Maneuver Synthesizer,
// Regulatory Diligence Officer, and Tactical Space Copilot.
// ============================================================
const API = "/api";
const $ = (s, root = document) => root.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;" }[c]));

const CSS = `
.ai-wrap { padding: 22px 26px; max-width: 1400px; margin: 0 auto; font-family: Inter, sans-serif; color: #eaf0fc; }
.ai-head { display: flex; align-items: flex-end; gap: 16px; flex-wrap: wrap; margin-bottom: 22px; }
.ai-head h2 { font-size: 22px; font-weight: 650; letter-spacing: -.02em; margin: 0; }
.ai-head p { color: #8496b6; font-size: 13.5px; margin: 4px 0 0; }
.ai-status-pill { display: inline-flex; align-items: center; gap: 7px; padding: 5px 12px; border-radius: 99px; background: rgba(56,189,248,.12); border: 1px solid rgba(56,189,248,.32); font: 600 12px "IBM Plex Mono", monospace; color: #38bdf8; }
.ai-status-pill .dot { width: 7px; height: 7px; border-radius: 50%; background: #38bdf8; box-shadow: 0 0 8px #38bdf8; }
.ai-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 16px; margin-bottom: 24px; }
.ai-card { background: rgba(12,18,32,.78); border: 1px solid rgba(96,140,215,.18); border-radius: 14px; padding: 18px 20px; backdrop-filter: blur(14px); transition: border-color .18s; }
.ai-card:hover { border-color: rgba(96,140,215,.35); }
.ai-card h3 { font-size: 14.5px; font-weight: 650; margin: 0 0 6px; letter-spacing: -.01em; display: flex; align-items: center; justify-content: space-between; }
.ai-card .sub { color: #8496b6; font-size: 12.5px; line-height: 1.5; margin-bottom: 12px; }
.ai-card-btn { padding: 6px 13px; border-radius: 8px; border: 1px solid rgba(96,140,215,.28); background: rgba(255,255,255,.04); color: #eaf0fc; font: 600 12px Inter, sans-serif; cursor: pointer; transition: .18s; }
.ai-card-btn:hover { background: rgba(56,189,248,.18); border-color: #38bdf8; color: #38bdf8; }
.ai-studio { background: rgba(12,18,32,.85); border: 1px solid rgba(96,140,215,.22); border-radius: 15px; padding: 22px 24px; margin-bottom: 24px; }
.ai-studio h3 { font-size: 16px; font-weight: 650; margin: 0 0 6px; }
.ai-row { display: flex; gap: 12px; flex-wrap: wrap; margin-bottom: 14px; }
.ai-input { background: rgba(6,10,21,.75); border: 1px solid rgba(96,140,215,.2); border-radius: 8px; padding: 8px 12px; color: #eaf0fc; font: 13px Inter, sans-serif; flex: 1; min-width: 140px; }
.ai-input:focus { outline: none; border-color: #38bdf8; }
.ai-btn-primary { padding: 9px 18px; border-radius: 8px; border: 0; background: linear-gradient(135deg, #0ea5e9, #0284c7); color: #fff; font: 600 13px Inter, sans-serif; cursor: pointer; transition: .18s; }
.ai-btn-primary:hover { opacity: .9; transform: translateY(-1px); }
.ai-res-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 12px; margin-top: 16px; }
.ai-stat-box { background: rgba(6,10,21,.6); border: 1px solid rgba(96,140,215,.15); border-radius: 10px; padding: 12px 14px; }
.ai-stat-box .val { font: 700 18px "IBM Plex Mono", monospace; color: #38bdf8; margin-top: 3px; }
.ai-stat-box .lbl { font-size: 11.5px; color: #8496b6; text-transform: uppercase; letter-spacing: .5px; }
.ai-terminal { background: #050811; border: 1px solid rgba(96,140,215,.25); border-radius: 14px; overflow: hidden; }
.ai-terminal-head { background: rgba(255,255,255,.03); padding: 10px 16px; border-bottom: 1px solid rgba(96,140,215,.15); display: flex; align-items: center; justify-content: space-between; font: 600 12px "IBM Plex Mono", monospace; color: #8496b6; }
.ai-terminal-chips { display: flex; gap: 8px; padding: 12px 16px; flex-wrap: wrap; border-bottom: 1px solid rgba(96,140,215,.1); }
.ai-chip { background: rgba(255,255,255,.04); border: 1px solid rgba(96,140,215,.2); border-radius: 99px; padding: 4px 11px; font-size: 12px; color: #8496b6; cursor: pointer; transition: .15s; }
.ai-chip:hover { border-color: #38bdf8; color: #eaf0fc; background: rgba(56,189,248,.1); }
.ai-terminal-log { padding: 16px; font: 12.5px/1.65 "IBM Plex Mono", monospace; color: #a8c2e8; max-height: 280px; overflow-y: auto; white-space: pre-wrap; }
.ai-terminal-input-bar { display: flex; padding: 10px 14px; border-top: 1px solid rgba(96,140,215,.15); background: rgba(6,10,21,.9); }
.ai-terminal-input-bar input { flex: 1; background: transparent; border: 0; color: #fff; font: 13px "IBM Plex Mono", monospace; outline: none; }
`;

export async function mountAgentOps(root) {
  if (!root) return;
  root.innerHTML = "";

  const style = document.createElement("style");
  style.textContent = CSS;
  root.appendChild(style);

  const wrap = document.createElement("div");
  wrap.className = "ai-wrap";
  wrap.innerHTML = `
    <div class="ai-head">
      <div>
        <h2>Autonomous Multi-Agent AI Flight Operations</h2>
        <p>Flight Safety Officer, Maneuver Synthesizer, Regulatory Diligence &amp; Tactical Space Copilot.</p>
      </div>
      <div style="margin-left:auto">
        <span class="ai-status-pill" id="ai-engine-pill">
          <span class="dot"></span>
          <span id="ai-engine-name">Detecting AI Engine…</span>
        </span>
      </div>
    </div>

    <!-- Agent Situation Deck -->
    <div class="ai-grid">
      <div class="ai-card">
        <h3><span>Flight Safety Officer</span><span style="color:#34d399;font-size:11px">● ACTIVE</span></h3>
        <p class="sub">Triage close approaches with SGP4 kinematics, 2D Foster Pc, and NOAA Kp solar storm drag expansion factors.</p>
        <button class="ai-card-btn" id="ai-btn-triage">Triage Conjunctions</button>
      </div>

      <div class="ai-card">
        <h3><span>Maneuver Synthesizer</span><span style="color:#38bdf8;font-size:11px">● READY</span></h3>
        <p class="sub">Computes Tsiolkovsky fuel budgets, propellant mass (grams), and screens secondary collisions before burning.</p>
        <button class="ai-card-btn" id="ai-btn-maneuver-jump">Optimize Burn</button>
      </div>

      <div class="ai-card">
        <h3><span>Diligence &amp; Compliance</span><span style="color:#a78bfa;font-size:11px">● VERIFIED</span></h3>
        <p class="sub">Drafts immutable FCC 47 CFR § 25.114 &amp; ISO 24113 proof-of-diligence filings cryptographically sealed to the ledger.</p>
        <button class="ai-card-btn" id="ai-btn-compliance">Draft FCC Filing</button>
      </div>

      <div class="ai-card">
        <h3><span>Space Weather Intel</span><span style="color:#fbbf24;font-size:11px" id="ai-kp-status">● MONITORING</span></h3>
        <p class="sub" id="ai-weather-sub">NOAA planetary K-index thermospheric drag expansion modeling for LEO satellites.</p>
        <button class="ai-card-btn" id="ai-btn-weather">Refresh Weather</button>
      </div>
    </div>

    <!-- Autonomous Maneuver Studio -->
    <div class="ai-studio" id="ai-studio">
      <h3>Autonomous Maneuver Synthesis &amp; Propellant Studio</h3>
      <p style="color:#8496b6;font-size:13px;margin:0 0 16px">Calculate minimum-fuel delta-v, Tsiolkovsky propellant expenditure, and screen secondary conjunctions.</p>

      <div class="ai-row">
        <div>
          <label style="display:block;font-size:11px;color:#8496b6;margin-bottom:4px">Primary NORAD ID</label>
          <input class="ai-input" id="ai-m-sat" value="25544" style="width:120px">
        </div>
        <div>
          <label style="display:block;font-size:11px;color:#8496b6;margin-bottom:4px">Spacecraft Mass (kg)</label>
          <input class="ai-input" id="ai-m-mass" value="300" style="width:120px">
        </div>
        <div>
          <label style="display:block;font-size:11px;color:#8496b6;margin-bottom:4px">Specific Impulse Isp (s)</label>
          <input class="ai-input" id="ai-m-isp" value="220" style="width:140px">
        </div>
        <div>
          <label style="display:block;font-size:11px;color:#8496b6;margin-bottom:4px">Miss Distance (km)</label>
          <input class="ai-input" id="ai-m-miss" value="0.75" style="width:120px">
        </div>
        <div>
          <label style="display:block;font-size:11px;color:#8496b6;margin-bottom:4px">Target Pc Threshold</label>
          <select class="ai-input" id="ai-m-targetpc" style="width:140px;height:36px">
            <option value="1e-4">1e-4 (Standard)</option>
            <option value="1e-5">1e-5 (Strict)</option>
            <option value="1e-6">1e-6 (Ultra-Safe)</option>
            <option value="1e-7">1e-7 (Zero Tolerance)</option>
          </select>
        </div>
        <div style="display:flex;align-items:flex-end">
          <button class="ai-btn-primary" id="ai-btn-plan-burn">Synthesize Burn</button>
        </div>
      </div>

      <div id="ai-plan-results" style="display:none">
        <div class="ai-res-grid">
          <div class="ai-stat-box">
            <div class="lbl">Recommended Δv</div>
            <div class="val" id="ai-res-dv">—</div>
          </div>
          <div class="ai-stat-box">
            <div class="lbl">Propellant Consumed</div>
            <div class="val" id="ai-res-prop">—</div>
          </div>
          <div class="ai-stat-box">
            <div class="lbl">Post-Burn Pc</div>
            <div class="val" id="ai-res-pc" style="color:#34d399">—</div>
          </div>
          <div class="ai-stat-box">
            <div class="lbl">Secondary Clearance</div>
            <div class="val" id="ai-res-clear" style="font-size:14px;color:#38bdf8">—</div>
          </div>
        </div>
        <div style="margin-top:14px;padding:12px 14px;background:rgba(6,10,21,.5);border-radius:8px;font:12px/1.6 'IBM Plex Mono',monospace;color:#a8c2e8" id="ai-res-synthesis"></div>
      </div>
    </div>

    <!-- Natural Language Tactical Terminal -->
    <div class="ai-terminal">
      <div class="ai-terminal-head">
        <span>TACTICAL SPACE COPILOT TERMINAL</span>
        <span id="ai-terminal-engine">OrbitIQ SGP4 Heuristics / LLM</span>
      </div>
      <div class="ai-terminal-chips">
        <span class="ai-chip" data-q="Triage our top conjunction risks and recommend Go/No-Go actions">⚡ Triage Conjunctions</span>
        <span class="ai-chip" data-q="How does current space weather and Kp affect LEO orbital decay and TLE accuracy?">☀ Space Weather Drag Impact</span>
        <span class="ai-chip" data-q="Calculate fuel needed for a 0.25 m/s avoidance burn on a 280 kg satellite">⛽ Propellant Calculation</span>
        <span class="ai-chip" data-q="Draft an FCC 47 CFR § 25.114 orbital debris mitigation diligence filing">⚖ Draft FCC 25.114 Filing</span>
      </div>
      <div class="ai-terminal-log" id="ai-log">OrbitIQ Tactical Space Copilot initialized.\nReady for natural language flight operations, maneuver planning, and compliance queries.</div>
      <div class="ai-terminal-input-bar">
        <span style="color:#38bdf8;margin-right:8px;font-family:'IBM Plex Mono',monospace">&gt;</span>
        <input id="ai-query-input" placeholder="Ask AI Copilot about conjunctions, delta-v, fuel budgets, or regulatory compliance…" autocomplete="off">
        <button class="ai-btn-primary" id="ai-query-send" style="padding:6px 14px;font-size:12px">Send</button>
      </div>
    </div>
  `;

  root.appendChild(wrap);

  // Wire up status
  async function refreshStatus() {
    try {
      const r = await fetch(`${API}/v1/agents/status`);
      const d = await r.json();
      if (d.ok) {
        $("#ai-engine-name", wrap).textContent = d.aiEngine.name;
        $("#ai-terminal-engine", wrap).textContent = d.aiEngine.name;
        if (d.spaceWeather) {
          $("#ai-kp-status", wrap).textContent = `Kp ${d.spaceWeather.kp} (${d.spaceWeather.condition})`;
          $("#ai-weather-sub", wrap).textContent = `NOAA Kp ${d.spaceWeather.kp} · ${d.spaceWeather.scale || "G0"} · ${d.spaceWeather.advisory || "Normal LEO drag"}`;
        }
      }
    } catch {}
  }
  refreshStatus();

  // Wire terminal query
  async function sendQuery(text) {
    const q = text.trim();
    if (!q) return;
    const log = $("#ai-log", wrap);
    log.innerHTML += `\n\n<span style="color:#fff">&gt; ${esc(q)}</span>\n<span style="color:#38bdf8">Analyzing orbital telemetry…</span>`;
    log.scrollTop = log.scrollHeight;

    try {
      const res = await fetch(`${API}/v1/agents/query`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: q })
      });
      const d = await res.json();
      if (d.ok && d.answer?.output) {
        log.innerHTML += `\n${esc(d.answer.output)}`;
      } else {
        log.innerHTML += `\n[Error]: ${esc(d.error || "Unable to complete query")}`;
      }
    } catch (e) {
      log.innerHTML += `\n[Network Error]: ${esc(e.message)}`;
    }
    log.scrollTop = log.scrollHeight;
  }

  $("#ai-query-send", wrap).addEventListener("click", () => {
    const input = $("#ai-query-input", wrap);
    sendQuery(input.value);
    input.value = "";
  });

  $("#ai-query-input", wrap).addEventListener("keydown", e => {
    if (e.key === "Enter") {
      sendQuery(e.target.value);
      e.target.value = "";
    }
  });

  wrap.querySelectorAll(".ai-chip").forEach(c => {
    c.addEventListener("click", () => sendQuery(c.dataset.q));
  });

  // Wire Maneuver Studio
  $("#ai-btn-plan-burn", wrap).addEventListener("click", async () => {
    const btn = $("#ai-btn-plan-burn", wrap);
    btn.disabled = true;
    btn.textContent = "Calculating…";

    const satId = $("#ai-m-sat", wrap).value.trim();
    const massKg = parseFloat($("#ai-m-mass", wrap).value) || 300;
    const ispS = parseFloat($("#ai-m-isp", wrap).value) || 220;
    const missKm = parseFloat($("#ai-m-miss", wrap).value) || 0.75;
    const targetPc = parseFloat($("#ai-m-targetpc", wrap).value) || 1e-4;

    try {
      const res = await fetch(`${API}/v1/agents/plan-maneuver`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          encounter: {
            a: { id: satId, name: `NORAD ${satId}` },
            b: { id: "49800", name: "COSMOS 1408 DEBRIS" },
            tca: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
            missKm,
            relVelKmS: 12.2,
            pc: 2.5e-4
          },
          spacecraft: { massKg, ispS, radiusM: 1.8 },
          targetPc,
          leadsHours: [24, 12, 6, 3]
        })
      });
      const d = await res.json();
      if (d.ok && d.plan) {
        const p = d.plan;
        const opt = p.optimalStrategy;
        $("#ai-plan-results", wrap).style.display = "block";
        if (opt) {
          $("#ai-res-dv", wrap).textContent = `${opt.deltaVms} m/s`;
          $("#ai-res-prop", wrap).textContent = `${opt.propellantGrams} g (${opt.propellantKg} kg)`;
          $("#ai-res-pc", wrap).textContent = opt.pcAfterBand || "< 1e-7";
          $("#ai-res-clear", wrap).textContent = opt.secondaryClearance?.safe ? "CLEARED · 0 SECONDARIES" : "WARNING · SECONDARY CONJUNCTION";
        } else {
          $("#ai-res-dv", wrap).textContent = "None needed";
          $("#ai-res-prop", wrap).textContent = "0 g";
          $("#ai-res-pc", wrap).textContent = "Safe";
          $("#ai-res-clear", wrap).textContent = "CLEARED";
        }
        $("#ai-res-synthesis", wrap).textContent = p.synthesis || "Maneuver solution computed successfully.";
      }
    } catch (e) {
      alert("Maneuver plan failed: " + e.message);
    } finally {
      btn.disabled = false;
      btn.textContent = "Synthesize Burn";
    }
  });

  // Action buttons
  $("#ai-btn-triage", wrap).addEventListener("click", () => {
    sendQuery("Execute flight safety officer triage on all high-risk encounters in our fleet.");
  });

  $("#ai-btn-compliance", wrap).addEventListener("click", () => {
    sendQuery("Generate an FCC 47 CFR § 25.114 compliance diligence report for our latest avoidance maneuver.");
  });

  $("#ai-btn-weather", wrap).addEventListener("click", () => {
    refreshStatus();
    sendQuery("What is the current NOAA space weather status and how is it impacting LEO atmospheric drag?");
  });

  $("#ai-btn-maneuver-jump", wrap).addEventListener("click", () => {
    $("#ai-studio", wrap).scrollIntoView({ behavior: "smooth" });
  });
}
