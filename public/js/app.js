// ============================================================
// OrbitIQ — Space Traffic Intelligence Platform (client)
// ============================================================
import * as THREE from "three";
import * as satellite from "satellite.js";

const $ = id => document.getElementById(id);
const EARTH_R = 6371, SCALE = 1 / 1000;

// ---------------- utilities ----------------
async function api(p) {
  const r = await fetch(p);
  if (!r.ok) { let d = {}; try { d = await r.json(); } catch {} throw new Error(d.error || `HTTP ${r.status}`); }
  return r.json();
}
function toast(msg, type = "info", ms = 5000) {
  const el = document.createElement("div");
  el.className = "toast" + (type === "err" ? " err" : "");
  el.innerHTML = `<span class="ico">${type === "err" ? "⚠" : type === "ok" ? "✓" : "◆"}</span><span>${msg}</span>`;
  $("toasts").appendChild(el);
  setTimeout(() => { el.classList.add("out"); setTimeout(() => el.remove(), 450); }, ms);
}
function countUp(el, target, ms = 1200) {
  const t0 = performance.now();
  (function step(t) {
    const k = Math.min(1, (t - t0) / ms), e = 1 - Math.pow(1 - k, 3);
    el.textContent = Math.round(target * e).toLocaleString();
    if (k < 1) requestAnimationFrame(step);
  })(t0);
}
const splashSet = (pct, msg) => { $("splash-bar").style.width = pct + "%"; $("splash-status").textContent = msg; };

// ---------------- renderer & scene ----------------
splashSet(8, "Starting render engine…");
const canvas = $("globe");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 600);
function resize() {
  renderer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
}
addEventListener("resize", resize); resize();

scene.add(new THREE.AmbientLight(0x33415e, 0.55));
const sunLight = new THREE.DirectionalLight(0xfff4e0, 2.2); scene.add(sunLight);

// ----- sun direction (approximate solar ephemeris, ECI) -----
function sunDirECI(date) {
  const jd = date.getTime() / 86400000 + 2440587.5;
  const n = jd - 2451545.0;
  const L = (280.46 + 0.9856474 * n) * Math.PI / 180;
  const g = (357.528 + 0.9856003 * n) * Math.PI / 180;
  const lam = L + (1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * Math.PI / 180;
  const eps = 23.439 * Math.PI / 180;
  // ECI -> scene mapping (x, z, -y)
  return new THREE.Vector3(Math.cos(lam), Math.sin(eps) * Math.sin(lam), -Math.cos(eps) * Math.sin(lam)).normalize();
}

// ----- Earth: day/night shader, real textures with procedural fallback -----
const earthGroup = new THREE.Group(); scene.add(earthGroup);
function proceduralTexture(night = false) {
  const c = document.createElement("canvas"); c.width = 1024; c.height = 512;
  const g = c.getContext("2d");
  const grad = g.createLinearGradient(0, 0, 0, 512);
  if (night) { grad.addColorStop(0, "#02050c"); grad.addColorStop(0.5, "#040a18"); grad.addColorStop(1, "#02050c"); }
  else { grad.addColorStop(0, "#0a2038"); grad.addColorStop(0.5, "#0d2c4e"); grad.addColorStop(1, "#0a2038"); }
  g.fillStyle = grad; g.fillRect(0, 0, 1024, 512);
  // graticule
  g.strokeStyle = night ? "rgba(60,110,190,0.10)" : "rgba(90,150,230,0.14)"; g.lineWidth = 1;
  for (let x = 0; x <= 1024; x += 1024 / 24) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, 512); g.stroke(); }
  for (let y = 0; y <= 512; y += 512 / 12) { g.beginPath(); g.moveTo(0, y); g.lineTo(1024, y); g.stroke(); }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}
const earthUniforms = {
  dayMap: { value: proceduralTexture(false) },
  nightMap: { value: proceduralTexture(true) },
  sunDir: { value: new THREE.Vector3(1, 0, 0) }
};
const earthMat = new THREE.ShaderMaterial({
  uniforms: earthUniforms,
  vertexShader: `
    varying vec2 vUv; varying vec3 vNormalW; varying vec3 vPosW;
    void main() {
      vUv = uv;
      vNormalW = normalize(mat3(modelMatrix) * normal);
      vPosW = (modelMatrix * vec4(position, 1.0)).xyz;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: `
    uniform sampler2D dayMap; uniform sampler2D nightMap; uniform vec3 sunDir;
    varying vec2 vUv; varying vec3 vNormalW; varying vec3 vPosW;
    void main() {
      float light = dot(normalize(vNormalW), normalize(sunDir));
      float k = smoothstep(-0.12, 0.25, light);
      vec3 day = texture2D(dayMap, vUv).rgb;
      vec3 night = texture2D(nightMap, vUv).rgb;
      vec3 col = mix(night * 1.15, day * (0.35 + 0.75 * max(light, 0.0)), k);
      // rim
      vec3 viewDir = normalize(cameraPosition - vPosW);
      float rim = pow(1.0 - max(dot(viewDir, normalize(vNormalW)), 0.0), 3.0);
      col += vec3(0.15, 0.35, 0.65) * rim * 0.6;
      gl_FragColor = vec4(col, 1.0);
    }`
});
const earth = new THREE.Mesh(new THREE.SphereGeometry(EARTH_R * SCALE, 96, 96), earthMat);
earthGroup.add(earth);

// try to load real imagery (works when online; falls back silently)
{
  const loader = new THREE.TextureLoader(); loader.crossOrigin = "anonymous";
  const sources = [
    ["https://unpkg.com/three-globe@2.31.0/example/img/earth-blue-marble.jpg",
     "https://unpkg.com/three-globe@2.31.0/example/img/earth-night.jpg"],
    ["https://cdn.jsdelivr.net/npm/three-globe@2.31.0/example/img/earth-blue-marble.jpg",
     "https://cdn.jsdelivr.net/npm/three-globe@2.31.0/example/img/earth-night.jpg"]
  ];
  (function tryLoad(i) {
    if (i >= sources.length) return;
    loader.load(sources[i][0],
      t => { t.colorSpace = THREE.SRGBColorSpace; earthUniforms.dayMap.value = t; },
      undefined, () => tryLoad(i + 1));
    loader.load(sources[i][1],
      t => { t.colorSpace = THREE.SRGBColorSpace; earthUniforms.nightMap.value = t; },
      undefined, () => {});
  })(0);
}

// atmosphere (fresnel glow)
const atmo = new THREE.Mesh(
  new THREE.SphereGeometry(EARTH_R * SCALE * 1.045, 64, 64),
  new THREE.ShaderMaterial({
    transparent: true, side: THREE.BackSide, depthWrite: false,
    vertexShader: `varying vec3 vN; varying vec3 vP;
      void main(){ vN = normalize(mat3(modelMatrix)*normal); vP=(modelMatrix*vec4(position,1.)).xyz;
      gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.);}`,
    fragmentShader: `varying vec3 vN; varying vec3 vP;
      void main(){ vec3 v = normalize(cameraPosition - vP);
      float a = pow(0.72 - dot(v, normalize(vN)) * -1.0, 6.0);
      gl_FragColor = vec4(0.25, 0.55, 1.0, clamp(a, 0.0, 0.55)); }`
  })
);
scene.add(atmo);

// starfield (two depth layers)
for (const [n, size, spread] of [[2200, 0.13, 420], [700, 0.24, 300]]) {
  const pos = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const v = new THREE.Vector3().randomDirection().multiplyScalar(spread * (0.55 + Math.random() * 0.45));
    pos.set([v.x, v.y, v.z], i * 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  scene.add(new THREE.Points(g, new THREE.PointsMaterial({ color: 0x6b7ea3, size, transparent: true, opacity: 0.8 })));
}

// launch sites (children of earthGroup so they rotate with the planet)
const SITES = [
  ["Kennedy / Canaveral", 28.5, -80.6], ["Vandenberg SFB", 34.7, -120.6],
  ["Starbase, TX", 25.99, -97.15], ["Baikonur", 45.9, 63.3],
  ["Kourou (CSG)", 5.2, -52.8], ["Sriharikota (SDSC)", 13.7, 80.2],
  ["Jiuquan", 40.96, 100.29], ["Wenchang", 19.6, 110.9],
  ["Tanegashima", 30.4, 130.97], ["Mahia (Rocket Lab)", -39.26, 177.86],
  ["Plesetsk", 62.9, 40.6], ["Xichang", 28.2, 102.0]
];
function llToScene(lat, lon, rMul = 1.004) {
  const la = lat * Math.PI / 180, lo = lon * Math.PI / 180, r = EARTH_R * SCALE * rMul;
  const x = r * Math.cos(la) * Math.cos(lo), y = r * Math.cos(la) * Math.sin(lo), z = r * Math.sin(la);
  return new THREE.Vector3(x, z, -y);
}
const siteMat = new THREE.MeshBasicMaterial({ color: 0xfbbf24 });
for (const [, lat, lon] of SITES) {
  const m = new THREE.Mesh(new THREE.SphereGeometry(0.038, 8, 8), siteMat);
  m.position.copy(llToScene(lat, lon));
  earthGroup.add(m);
}

// ---------------- camera controls (inertia) ----------------
let rotY = 0.6, rotX = 0.35, dist = 22, velY = 0, velX = 0;
let targetRotY = null, targetRotX = null; // for fly-to
let dragging = false, px = 0, py = 0;
canvas.addEventListener("pointerdown", e => { dragging = true; px = e.clientX; py = e.clientY; targetRotY = targetRotX = null; });
addEventListener("pointerup", () => dragging = false);
addEventListener("pointermove", e => {
  if (dragging) {
    velY = (e.clientX - px) * 0.005; velX = (e.clientY - py) * 0.005;
    rotY += velY; rotX = Math.max(-1.45, Math.min(1.45, rotX + velX));
    px = e.clientX; py = e.clientY;
  }
  hoverX = e.clientX; hoverY = e.clientY; hoverDirty = true;
});
canvas.addEventListener("wheel", e => { dist = Math.max(7.6, Math.min(90, dist + e.deltaY * 0.02)); }, { passive: true });

// ---------------- satellite layer ----------------
function glowTexture(ring = false) {
  const c = document.createElement("canvas"); c.width = c.height = 64;
  const g = c.getContext("2d");
  if (!ring) {
    const gr = g.createRadialGradient(32, 32, 0, 32, 32, 30);
    gr.addColorStop(0, "rgba(255,255,255,1)"); gr.addColorStop(0.25, "rgba(255,255,255,0.85)");
    gr.addColorStop(0.6, "rgba(255,255,255,0.18)"); gr.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
  } else {
    g.strokeStyle = "rgba(120,255,220,0.95)"; g.lineWidth = 4;
    g.beginPath(); g.arc(32, 32, 24, 0, Math.PI * 2); g.stroke();
  }
  return new THREE.CanvasTexture(c);
}
let sats = [], satPoints = null, posAttr = null, colorAttr = null;
let selectedOrg = "all", selectedRegime = "all", selectedType = "all", searchTerm = "";
let selectedSat = null;
const ORG_COLORS = {};
const PALETTE = [0x38bdf8, 0x34d399, 0xfbbf24, 0xfb7185, 0xa78bfa, 0x67e8f9, 0xf0f4ff, 0xa3e635, 0xfb923c, 0x5eead4, 0xe879f9, 0x93c5fd];

function buildPoints() {
  if (satPoints) { scene.remove(satPoints); satPoints.geometry.dispose(); }
  const n = sats.length;
  const g = new THREE.BufferGeometry();
  posAttr = new THREE.BufferAttribute(new Float32Array(n * 3), 3);
  colorAttr = new THREE.BufferAttribute(new Float32Array(n * 3), 3);
  g.setAttribute("position", posAttr); g.setAttribute("color", colorAttr);
  satPoints = new THREE.Points(g, new THREE.PointsMaterial({
    size: 0.13, map: glowTexture(), vertexColors: true, transparent: true,
    blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true
  }));
  scene.add(satPoints);
  recolor();
}
const regimeOf = s => s.meanMotion > 11.25 ? "leo" : s.meanMotion > 1.5 ? "meo" : "geo";
function matches(s) {
  return (selectedOrg === "all" || s.org === selectedOrg) &&
    (selectedRegime === "all" || regimeOf(s) === selectedRegime) &&
    (selectedType === "all" || s.noradType === selectedType) &&
    (!searchTerm || s.name.toUpperCase().includes(searchTerm) || String(s.id) === searchTerm);
}
function recolor() {
  if (!colorAttr) return;
  const c = new THREE.Color(), dimC = new THREE.Color(0x1c2b4a);
  for (let i = 0; i < sats.length; i++) {
    const s = sats[i];
    if (matches(s)) c.setHex(ORG_COLORS[s.org] ?? 0x7d92b8); else c.copy(dimC);
    colorAttr.setXYZ(i, c.r, c.g, c.b);
  }
  colorAttr.needsUpdate = true;
}

// selection marker + orbit trail
const marker = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(true), transparent: true, depthWrite: false }));
marker.scale.set(0.5, 0.5, 1); marker.visible = false; scene.add(marker);
let trailLine = null;
function drawTrail(s) {
  if (trailLine) { scene.remove(trailLine); trailLine.geometry.dispose(); trailLine = null; }
  const periodMin = s.meanMotion ? 1440 / s.meanMotion : 95;
  const pts = [];
  const base = new Date(simTime);
  for (let i = 0; i <= 160; i++) {
    const t = new Date(base.getTime() + (i / 160) * periodMin * 60000);
    try {
      const p = satellite.propagate(s.rec, t)?.position;
      if (p && !Number.isNaN(p.x)) pts.push(new THREE.Vector3(p.x * SCALE, p.z * SCALE, -p.y * SCALE));
    } catch {}
  }
  if (pts.length > 2) {
    trailLine = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts),
      new THREE.LineBasicMaterial({ color: 0x5eead4, transparent: true, opacity: 0.75 }));
    scene.add(trailLine);
  }
}

// chunked propagation
let cursor = 0;
function propagateChunk(now, chunk = 1000) {
  if (!sats.length) return;
  const end = Math.min(cursor + chunk, sats.length);
  for (let i = cursor; i < end; i++) {
    try {
      const p = satellite.propagate(sats[i].rec, now)?.position;
      if (p && !Number.isNaN(p.x)) posAttr.setXYZ(i, p.x * SCALE, p.z * SCALE, -p.y * SCALE);
    } catch {}
  }
  cursor = end >= sats.length ? 0 : end;
  posAttr.needsUpdate = true;
}

// ---------------- hover + click picking ----------------
const ray = new THREE.Raycaster(); ray.params.Points.threshold = 0.14;
let hoverX = 0, hoverY = 0, hoverDirty = false, hoveredIdx = -1;
function pick(cx, cy) {
  if (!satPoints) return -1;
  const m = new THREE.Vector2((cx / innerWidth) * 2 - 1, -(cy / innerHeight) * 2 + 1);
  ray.setFromCamera(m, camera);
  const hits = ray.intersectObject(satPoints);
  return hits.length ? hits[0].index : -1;
}
setInterval(() => {
  if (!hoverDirty || dragging) return;
  hoverDirty = false;
  const idx = pick(hoverX, hoverY);
  if (idx !== hoveredIdx) {
    hoveredIdx = idx;
    const tip = $("tooltip");
    if (idx >= 0) {
      const s = sats[idx];
      tip.innerHTML = `<b>${s.name}</b><div class="sub">${s.orgName || s.org} · NORAD ${s.id}</div>`;
      tip.style.display = "block";
      document.body.style.cursor = "pointer";
    } else { tip.style.display = "none"; document.body.style.cursor = ""; }
  }
  if (idx >= 0) { const tip = $("tooltip"); tip.style.left = hoverX + 14 + "px"; tip.style.top = hoverY + 14 + "px"; }
}, 60);
let downAt = 0;
canvas.addEventListener("pointerdown", () => downAt = Date.now());
canvas.addEventListener("click", e => {
  if (Date.now() - downAt > 250) return; // was a drag
  const idx = pick(e.clientX, e.clientY);
  if (idx >= 0) selectSat(sats[idx]);
});

// ---------------- selection / drawer ----------------
function flyTo(s) {
  try {
    const p = satellite.propagate(s.rec, new Date(simTime))?.position;
    if (!p) return;
    const v = new THREE.Vector3(p.x * SCALE, p.z * SCALE, -p.y * SCALE).normalize();
    targetRotX = Math.asin(v.y);
    targetRotY = Math.atan2(v.x, v.z);
  } catch {}
}
function selectSat(s, fly = false) {
  selectedSat = s;
  drawTrail(s);
  marker.visible = true;
  if (fly) flyTo(s);
  renderDrawer();
  $("drawer").classList.add("open");
}
function renderDrawer() {
  const s = selectedSat; if (!s) return;
  const now = new Date(simTime);
  let alt = "—", vel = "—", lat = "—", lon = "—";
  try {
    const pv = satellite.propagate(s.rec, now);
    if (pv?.position) {
      const gmst = satellite.gstime(now);
      const gd = satellite.eciToGeodetic(pv.position, gmst);
      alt = gd.height.toFixed(0) + " km";
      lat = satellite.degreesLat(gd.latitude).toFixed(2) + "°";
      lon = satellite.degreesLong(gd.longitude).toFixed(2) + "°";
      if (pv.velocity) vel = Math.hypot(pv.velocity.x, pv.velocity.y, pv.velocity.z).toFixed(2) + " km/s";
    }
  } catch {}
  $("drawer-title").textContent = s.name;
  $("drawer-star").classList.toggle("on", watchlist.includes(s.id));
  $("drawer-body").innerHTML = `<table class="kv">
    <tr><td>NORAD ID</td><td>${s.id}</td></tr>
    <tr><td>Intl designator</td><td>${s.intl || "—"}</td></tr>
    <tr><td>Operator</td><td class="hl">${s.orgName || s.org}</td></tr>
    <tr><td>Type</td><td>${s.noradType}</td></tr>
    <tr><td>Altitude</td><td class="hl">${alt}</td></tr>
    <tr><td>Velocity</td><td>${vel}</td></tr>
    <tr><td>Lat / Lon</td><td>${lat} / ${lon}</td></tr>
    <tr><td>Inclination</td><td>${s.incl?.toFixed(2)}°</td></tr>
    <tr><td>Eccentricity</td><td>${s.ecc}</td></tr>
    <tr><td>Period</td><td>${s.meanMotion ? (1440 / s.meanMotion).toFixed(1) + " min" : "—"}</td></tr>
    <tr><td>Regime</td><td>${regimeOf(s).toUpperCase()}</td></tr>
  </table>`;
  drawGroundTrack(s);
  $("passlist").innerHTML = "";
}
$("drawer-close").addEventListener("click", () => {
  $("drawer").classList.remove("open");
  marker.visible = false; selectedSat = null;
  if (trailLine) { scene.remove(trailLine); trailLine.geometry.dispose(); trailLine = null; }
});

// ground track mini-map
function drawGroundTrack(s) {
  const cv = $("groundtrack"), g = cv.getContext("2d");
  const W = cv.width, H = cv.height;
  g.clearRect(0, 0, W, H);
  g.fillStyle = "#060a15"; g.fillRect(0, 0, W, H);
  g.strokeStyle = "rgba(90,130,200,0.18)"; g.lineWidth = 1;
  for (let i = 0; i <= 12; i++) { const x = (i / 12) * W; g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke(); }
  for (let i = 0; i <= 6; i++) { const y = (i / 6) * H; g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke(); }
  g.strokeStyle = "rgba(90,150,255,0.4)";
  g.beginPath(); g.moveTo(0, H / 2); g.lineTo(W, H / 2); g.stroke(); // equator
  const periodMin = s.meanMotion ? 1440 / s.meanMotion : 95;
  const base = new Date(simTime);
  g.strokeStyle = "#5eead4"; g.lineWidth = 1.6; g.shadowColor = "#5eead4"; g.shadowBlur = 5;
  let prev = null;
  g.beginPath();
  for (let i = 0; i <= 240; i++) {
    const t = new Date(base.getTime() + (i / 240) * periodMin * 60000);
    try {
      const pv = satellite.propagate(s.rec, t);
      if (!pv?.position) continue;
      const gd = satellite.eciToGeodetic(pv.position, satellite.gstime(t));
      const lo = satellite.degreesLong(gd.longitude), la = satellite.degreesLat(gd.latitude);
      const x = ((lo + 180) / 360) * W, y = ((90 - la) / 180) * H;
      if (prev !== null && Math.abs(x - prev) > W / 2) g.moveTo(x, y); else (i === 0 ? g.moveTo(x, y) : g.lineTo(x, y));
      prev = x;
    } catch {}
  }
  g.stroke(); g.shadowBlur = 0;
  // current position
  try {
    const pv = satellite.propagate(s.rec, base);
    const gd = satellite.eciToGeodetic(pv.position, satellite.gstime(base));
    const x = ((satellite.degreesLong(gd.longitude) + 180) / 360) * W;
    const y = ((90 - satellite.degreesLat(gd.latitude)) / 180) * H;
    g.fillStyle = "#fff"; g.shadowColor = "#38bdf8"; g.shadowBlur = 10;
    g.beginPath(); g.arc(x, y, 4, 0, Math.PI * 2); g.fill(); g.shadowBlur = 0;
  } catch {}
}

// pass predictor
$("obs-geo").addEventListener("click", () => {
  navigator.geolocation?.getCurrentPosition(
    p => { $("obs-lat").value = p.coords.latitude.toFixed(3); $("obs-lon").value = p.coords.longitude.toFixed(3); },
    () => toast("Location unavailable — enter coordinates manually", "err"));
});
$("run-passes").addEventListener("click", async () => {
  if (!selectedSat) return;
  const lat = parseFloat($("obs-lat").value), lon = parseFloat($("obs-lon").value);
  if (Number.isNaN(lat) || Number.isNaN(lon)) return toast("Enter observer latitude and longitude", "err");
  const btn = $("run-passes"); btn.disabled = true; btn.textContent = "Computing…";
  try {
    const d = await api(`/api/passes?satId=${selectedSat.id}&lat=${lat}&lon=${lon}`);
    $("passlist").innerHTML = d.passes.length ? d.passes.map(p => `
      <div class="item LOW"><b>${new Date(p.aos).toUTCString().slice(0, 22)}</b>
      <div class="sub">max elev ${p.maxEl}° @ az ${p.maxElAz}° · ${p.durationMin} min · range ${p.minRangeKm} km</div></div>`).join("")
      : `<div class="item"><span class="sub">No passes above the horizon in the next 48 h.</span></div>`;
  } catch (e) { toast("Pass prediction failed: " + e.message, "err"); }
  btn.disabled = false; btn.textContent = "Predict passes · 48 h";
});

// watchlist
let watchlist = [];
try { watchlist = JSON.parse(localStorage.getItem("orbitiq-watchlist") || "[]"); } catch {}
function renderWatchlist() {
  const el = $("watchlist");
  const items = watchlist.map(id => sats.find(s => s.id === id)).filter(Boolean);
  el.innerHTML = items.length ? items.map(s => `
    <div class="item clickable LOW" data-id="${s.id}"><b>★ ${s.name}</b>
    <div class="sub">${s.orgName || s.org} · NORAD ${s.id}</div></div>`).join("")
    : `<div class="item"><span class="sub">Click a satellite, then ★ to track it here.</span></div>`;
  el.querySelectorAll("[data-id]").forEach(n => n.addEventListener("click", () => {
    const s = sats.find(x => x.id === +n.dataset.id); if (s) selectSat(s, true);
  }));
}
$("drawer-star").addEventListener("click", () => {
  if (!selectedSat) return;
  const i = watchlist.indexOf(selectedSat.id);
  if (i >= 0) { watchlist.splice(i, 1); toast("Removed from watchlist"); }
  else { watchlist.push(selectedSat.id); toast(`★ ${selectedSat.name} added to watchlist`, "ok"); }
  localStorage.setItem("orbitiq-watchlist", JSON.stringify(watchlist));
  $("drawer-star").classList.toggle("on", watchlist.includes(selectedSat.id));
  renderWatchlist();
});

// ---------------- data loading ----------------
let orgNames = {};
async function loadCatalog() {
  splashSet(24, "Downloading orbital catalog…");
  const [satsRes, orgsRes, statsRes] = await Promise.all([
    api("/api/satellites"), api("/api/organizations"), api("/api/stats")
  ]);
  splashSet(58, "Building SGP4 propagators…");
  orgNames = Object.fromEntries(orgsRes.organizations.map(o => [o.id, o.name]));
  orgsRes.organizations.forEach((o, i) => ORG_COLORS[o.id] = PALETTE[i % PALETTE.length]);
  sats = satsRes.satellites.map(s => {
    try { return { ...s, rec: satellite.json2satrec(s.gp), orgName: orgNames[s.org] }; }
    catch { return null; }
  }).filter(s => s && s.rec);
  buildPoints();
  splashSet(78, "Rendering orbital picture…");
  $("livecount").textContent = sats.length.toLocaleString() + " objects tracked";
  countUp($("s-total"), statsRes.total);
  countUp($("s-leo"), statsRes.regimes.LEO);
  countUp($("s-geo"), statsRes.regimes.MEO + statsRes.regimes["GEO/HEO"]);
  $("org-count").textContent = orgsRes.organizations.length + " orgs";
  const sel = $("orgsel");
  for (const o of orgsRes.organizations) {
    const opt = document.createElement("option");
    opt.value = o.id; opt.textContent = `${o.name}  (${o.count.toLocaleString()})`;
    sel.appendChild(opt);
  }
  renderWatchlist();
}

async function loadLaunches() {
  try {
    const d = await api("/api/launches");
    const fmt = l => `<div class="item ${(l.status || "").toLowerCase().includes("go") || (l.status || "").toLowerCase().includes("success") ? "go" : "tbd"}">
      <b>${l.name}</b>
      <div class="sub">${l.provider || ""} · ${l.location || l.pad || ""}</div>
      <div class="sub">${l.net ? new Date(l.net).toUTCString().slice(0, 25) : ""} · ${l.status || ""}</div></div>`;
    $("launchlist").innerHTML =
      `<div class="feed-label first">Upcoming</div>` + d.upcoming.slice(0, 8).map(fmt).join("") +
      `<div class="feed-label">Recent</div>` + d.previous.slice(0, 5).map(fmt).join("");
    return d;
  } catch (e) {
    $("launchlist").innerHTML = `<div class="item"><span class="sub">Launch feed unavailable: ${e.message}</span></div>`;
    return { upcoming: [], previous: [] };
  }
}

async function loadRecent() {
  try {
    const d = await api("/api/recent-objects");
    $("recentlist").innerHTML = d.objects.slice(0, 12).map(o => `
      <div class="item clickable LOW" data-id="${o.id}">
        <b>${o.name}</b>
        <div class="sub">${o.intl} · ${orgNames[o.org] || o.org} · ${o.incl?.toFixed(1)}°</div>
      </div>`).join("");
    document.querySelectorAll("#recentlist [data-id]").forEach(n => n.addEventListener("click", () => {
      const s = sats.find(x => x.id === +n.dataset.id); if (s) selectSat(s, true);
    }));
    return d.objects;
  } catch { return []; }
}

async function loadDecay() {
  try {
    const d = await api("/api/decay-watch");
    $("decaylist").innerHTML = d.objects.slice(0, 12).map(o => `
      <div class="item ${o.perigeeKm < 180 ? "CRITICAL" : o.perigeeKm < 250 ? "MODERATE" : "LOW"}">
        <b>${o.name}</b><span class="risk">${o.perigeeKm} km</span>
        <div class="sub">NORAD ${o.id} · apogee ${o.apogeeKm} km · ${o.type}</div>
      </div>`).join("") || `<div class="item go"><span class="sub">No low-perigee objects.</span></div>`;
  } catch (e) {
    $("decaylist").innerHTML = `<div class="item"><span class="sub">Decay feed unavailable.</span></div>`;
  }
}

// Status feed: one item at a time with a quiet crossfade (no marquee).
let tickerItems = [], tickerIdx = -1, tickerTimer = null;
function tickerNext() {
  if (!tickerItems.length) return;
  const el = $("ticker-track");
  el.classList.remove("show");
  setTimeout(() => {
    tickerIdx = (tickerIdx + 1) % tickerItems.length;
    el.innerHTML = tickerItems[tickerIdx];
    el.classList.add("show");
  }, 240);
}
async function loadTicker() {
  const parts = [];
  try {
    const l = await api("/api/launches");
    for (const x of l.upcoming.slice(0, 6))
      parts.push(`<span class="tick"><span class="t-go">Launch</span> · <b>${x.name}</b> · ${x.net ? new Date(x.net).toUTCString().slice(0, 22) : "TBD"} · ${x.provider || ""}</span>`);
  } catch {}
  try {
    const e = await api("/api/events");
    for (const x of e.events.slice(0, 5))
      parts.push(`<span class="tick"><span class="t-evt">${x.type || "Event"}</span> · <b>${x.name}</b> · ${x.date ? new Date(x.date).toUTCString().slice(0, 22) : ""}</span>`);
  } catch {}
  try {
    const r = await api("/api/recent-objects");
    for (const x of r.objects.slice(0, 5))
      parts.push(`<span class="tick"><span class="t-new">New on orbit</span> · <b>${x.name}</b> · ${x.intl}</span>`);
  } catch {}
  if (parts.length) {
    tickerItems = parts; tickerIdx = -1;
    clearInterval(tickerTimer);
    tickerNext();
    tickerTimer = setInterval(tickerNext, 6500);
  }
}

// conjunction screening
$("runconj").addEventListener("click", async () => {
  const btn = $("runconj");
  btn.disabled = true; btn.textContent = "Screening…";
  $("conjlist").innerHTML = `<div class="item"><span class="sub"><span class="spin">◐</span> Propagating catalog and screening close approaches…</span></div>`;
  try {
    const org = selectedOrg === "all" ? "" : `org=${selectedOrg}&`;
    const d = await api(`/api/conjunctions?${org}hours=${$("conj-hours").value}&thresholdKm=${$("conj-th").value}`);
    $("conj-meta").textContent = `${d.screened} vs ${d.catalogSize}`;
    const crit = d.events.filter(e => e.risk === "CRITICAL" || e.risk === "HIGH").length;
    if (crit) toast(`${crit} high-risk conjunction${crit > 1 ? "s" : ""} detected in the next ${d.windowHours}h`, "err", 8000);
    if (!d.events.length) {
      $("conjlist").innerHTML = `<div class="item go"><b>No close approaches found</b>
        <div class="sub">${d.screened} primaries vs ${d.catalogSize} objects · ${d.windowHours}h window · &lt;${d.thresholdKm} km</div></div>`;
    } else {
      $("conjlist").innerHTML = d.events.slice(0, 25).map((ev, i) => `
        <div class="item ${ev.risk}" style="animation-delay:${i * 0.04}s">
          <span class="risk">${ev.risk}</span><b>${ev.missKm} km miss</b>
          <div class="sub">${ev.a.name} ⇄ ${ev.b.name}</div>
          <div class="sub">TCA ${new Date(ev.tca).toUTCString().slice(0, 25)} · ${ev.relVelKmS ?? "?"} km/s · alt ${ev.altKm ?? "?"} km</div>
        </div>`).join("");
    }
  } catch (e) {
    $("conjlist").innerHTML = `<div class="item CRITICAL"><b>Screening failed</b><div class="sub">${e.message}</div></div>`;
  }
  btn.disabled = false; btn.textContent = "Run screening";
});

// filters
$("orgsel").addEventListener("change", e => { selectedOrg = e.target.value; recolor(); });
$("search").addEventListener("input", e => { searchTerm = e.target.value.trim().toUpperCase(); recolor(); });
$("regime").addEventListener("change", e => { selectedRegime = e.target.value; recolor(); });
$("typefilter").addEventListener("change", e => { selectedType = e.target.value; recolor(); });
$("speed").addEventListener("change", e => { timeSpeed = parseFloat(e.target.value); });

// ---------------- views ----------------
const VIEWS = ["analytics", "traffic", "tools", "catalog"];
function switchView(v) {
  document.querySelectorAll(".tab").forEach(x => x.classList.toggle("active", x.dataset.view === v));
  for (const name of VIEWS) $("view-" + name)?.classList.toggle("active", v === name);
  $("sidebar").classList.toggle("hidden", v !== "ops");
  $("drawer").classList.remove("open");
  if (v === "analytics") loadAnalytics();
  if (v === "catalog") renderCatalog();
  if (v === "traffic") loadTraffic();
}
document.querySelectorAll(".tab").forEach(t => t.addEventListener("click", () => switchView(t.dataset.view)));

// ----- analytics charts (hand-rolled canvas) -----
function chart(cv, draw) {
  const dpr = Math.min(devicePixelRatio, 2);
  const w = cv.clientWidth || cv.parentElement.clientWidth - 36, h = +cv.getAttribute("height");
  cv.width = w * dpr; cv.height = h * dpr; cv.style.height = h + "px";
  const g = cv.getContext("2d"); g.scale(dpr, dpr);
  draw(g, w, h);
}
function bars(g, w, h, values, labels, color, labelEvery = 1) {
  const max = Math.max(...values, 1), n = values.length;
  const bw = (w - 30) / n;
  g.font = "9px IBM Plex Mono, monospace";
  for (let i = 0; i < n; i++) {
    const bh = (values[i] / max) * (h - 38);
    const x = 24 + i * bw, y = h - 24 - bh;
    const grad = g.createLinearGradient(0, y, 0, h - 24);
    grad.addColorStop(0, color); grad.addColorStop(1, color + "33");
    g.fillStyle = grad;
    g.beginPath(); g.roundRect(x + 1, y, Math.max(2, bw - 3), bh, 2); g.fill();
    if (labels && i % labelEvery === 0) {
      g.fillStyle = "#5a6a8a"; g.textAlign = "center";
      g.fillText(String(labels[i]), x + bw / 2, h - 10);
    }
  }
  g.strokeStyle = "rgba(90,130,200,0.25)";
  g.beginPath(); g.moveTo(20, h - 24); g.lineTo(w - 6, h - 24); g.stroke();
}
let analyticsLoaded = false;
async function loadAnalytics() {
  try {
    const d = await api("/api/analytics");
    $("ana-cards").innerHTML = [
      [d.total.toLocaleString(), "objects tracked"],
      [d.regimes.LEO.toLocaleString(), "in low earth orbit"],
      [(d.byOrg.find(o => o.org === "debris")?.count || 0).toLocaleString(), "tracked debris"],
      [(d.byLaunchYear.at(-1)?.count || 0).toLocaleString(), `launched in ${d.byLaunchYear.at(-1)?.year || "—"}`]
    ].map(([v, l], i) => `<div class="card" style="animation-delay:${i * 0.08}s"><div class="big">${v}</div><div class="lbl">${l}</div></div>`).join("");

    chart($("ch-alt"), (g, w, h) => bars(g, w, h, d.altitudeHistogram.bins,
      d.altitudeHistogram.bins.map((_, i) => i % 5 === 0 ? i * 100 : ""), "#38bdf8", 1));
    chart($("ch-incl"), (g, w, h) => bars(g, w, h, d.inclinationHistogram.bins,
      d.inclinationHistogram.bins.map((_, i) => i % 3 === 0 ? i * 10 + "°" : ""), "#a78bfa", 1));
    const yrs = d.byLaunchYear.slice(-25);
    chart($("ch-year"), (g, w, h) => bars(g, w, h, yrs.map(r => r.count),
      yrs.map(r => String(r.year).slice(2)), "#34d399", 3));
    // horizontal org bars
    chart($("ch-org"), (g, w, h) => {
      const top = d.byOrg.slice(0, 8);
      const max = Math.max(...top.map(o => o.count), 1);
      g.font = "10.5px Inter, sans-serif";
      top.forEach((o, i) => {
        const y = 8 + i * ((h - 16) / 8), bh = (h - 16) / 8 - 8;
        const bw = (o.count / max) * (w - 130);
        g.fillStyle = "#38bdf8" + (i === 0 ? "" : "aa");
        g.beginPath(); g.roundRect(120, y, Math.max(3, bw), bh, 4); g.fill();
        g.fillStyle = "#8fa3c8"; g.textAlign = "right";
        g.fillText((orgNames[o.org] || o.org).slice(0, 16), 112, y + bh / 2 + 3);
        g.fillStyle = "#e6edfa"; g.textAlign = "left";
        g.fillText(o.count.toLocaleString(), 126 + bw, y + bh / 2 + 3);
      });
    });
    analyticsLoaded = true;
  } catch (e) { toast("Analytics unavailable: " + e.message, "err"); }
}

// ----- catalog table -----
let catSort = { k: "name", dir: 1 }, catFilter = "", catShown = 150;
function catRows() {
  const MU = 398600.4418;
  let rows = sats.map(s => {
    const nRad = (s.meanMotion * 2 * Math.PI) / 86400;
    const alt = nRad > 0 ? Math.cbrt(MU / (nRad * nRad)) - EARTH_R : 0;
    return { name: s.name, id: s.id, orgName: s.orgName || s.org, incl: s.incl || 0, alt: Math.round(alt), period: +(1440 / s.meanMotion).toFixed(1), ref: s };
  });
  if (catFilter) {
    const f = catFilter.toUpperCase();
    rows = rows.filter(r => r.name.toUpperCase().includes(f) || String(r.id).includes(f) || r.orgName.toUpperCase().includes(f));
  }
  rows.sort((a, b) => {
    const x = a[catSort.k], y = b[catSort.k];
    return (typeof x === "string" ? x.localeCompare(y) : x - y) * catSort.dir;
  });
  return rows;
}
function renderCatalog() {
  const rows = catRows().slice(0, catShown);
  $("cat-body").innerHTML = rows.map(r => `<tr data-id="${r.id}">
    <td>${r.name}</td><td>${r.id}</td><td><span class="org-pill">${r.orgName}</span></td>
    <td>${r.incl.toFixed(1)}</td><td>${r.alt.toLocaleString()}</td><td>${r.period}</td></tr>`).join("");
  document.querySelectorAll("#cat-body tr").forEach(tr => tr.addEventListener("click", () => {
    const s = sats.find(x => x.id === +tr.dataset.id);
    if (s) {
      document.querySelector('.tab[data-view="ops"]').click();
      selectSat(s, true);
    }
  }));
}
$("cat-search").addEventListener("input", e => { catFilter = e.target.value.trim(); catShown = 150; renderCatalog(); });
$("cat-more").addEventListener("click", () => { catShown += 300; renderCatalog(); });
document.querySelectorAll("#cat-table th").forEach(th => th.addEventListener("click", () => {
  const k = th.dataset.k;
  if (catSort.k === k) catSort.dir *= -1; else catSort = { k, dir: 1 };
  renderCatalog();
}));

// ---------------- main loop ----------------
let simTime = Date.now(), timeSpeed = 1, lastFrame = performance.now();
let drawerTick = 0;
function loop() {
  requestAnimationFrame(loop);
  const nowMs = performance.now();
  simTime += (nowMs - lastFrame) * timeSpeed;
  lastFrame = nowMs;
  const now = new Date(simTime);
  $("clock").firstElementChild.textContent = now.toUTCString().slice(17, 25) + " UTC" + (timeSpeed > 1 ? ` · ${timeSpeed}×` : "");
  $("clock-date").textContent = now.toUTCString().slice(0, 16);

  // earth rotation + sun
  let gmst = 0;
  try { gmst = satellite.gstime(now); } catch {}
  earthGroup.rotation.y = gmst;
  const sd = sunDirECI(now);
  sunLight.position.copy(sd.clone().multiplyScalar(80));
  earthUniforms.sunDir.value.copy(sd);

  if (sats.length) propagateChunk(now);

  // selection marker follows
  if (selectedSat && marker.visible) {
    try {
      const p = satellite.propagate(selectedSat.rec, now)?.position;
      if (p) marker.position.set(p.x * SCALE, p.z * SCALE, -p.y * SCALE);
      const pulse = 0.45 + Math.sin(nowMs / 260) * 0.08;
      marker.scale.set(pulse, pulse, 1);
    } catch {}
    if (++drawerTick % 120 === 0 && $("drawer").classList.contains("open")) renderDrawer();
  }

  // camera: inertia + fly-to easing
  if (!dragging) {
    velY *= 0.94; velX *= 0.94;
    rotY += velY; rotX = Math.max(-1.45, Math.min(1.45, rotX + velX));
    if (targetRotY !== null) {
      rotY += (targetRotY - rotY) * 0.06; rotX += (targetRotX - rotX) * 0.06;
      if (Math.abs(targetRotY - rotY) < 0.002) targetRotY = targetRotX = null;
    }
    if (Math.abs(velY) < 0.00004 && targetRotY === null) rotY += 0.00035; // idle drift
  }
  camera.position.set(
    dist * Math.cos(rotX) * Math.sin(rotY),
    dist * Math.sin(rotX),
    dist * Math.cos(rotX) * Math.cos(rotY)
  );
  camera.lookAt(0, 0, 0);
  renderer.render(scene, camera);
}
loop();

// ---------------- boot ----------------
(async function boot() {
  try {
    await loadCatalog();
    splashSet(92, "Syncing mission feeds…");
    await Promise.allSettled([loadLaunches(), loadRecent(), loadDecay(), loadTicker()]);
    splashSet(100, "Ready");
    setTimeout(() => $("splash").classList.add("done"), 500);
    $("status").textContent = "Data: CelesTrak · Launch Library 2 · " + new Date().toUTCString().slice(0, 25);
    toast(`Tracking ${sats.length.toLocaleString()} objects in real time`, "ok");
  } catch (e) {
    splashSet(100, "Start failed — retrying in 15 s");
    toast("Catalog unavailable: " + e.message + " — retrying", "err", 12000);
    setTimeout(boot, 15000);
  }
})();
setInterval(loadLaunches, 15 * 60 * 1000);
setInterval(loadDecay, 30 * 60 * 1000);
setInterval(loadTicker, 20 * 60 * 1000);

// ============================================================
// v3 — workspaces, alerts, live push, palette, traffic, tools
// ============================================================

// ---------- workspace client ----------
let wsKey = localStorage.getItem("orbitiq-apikey") || null;
const authHeaders = () => wsKey ? { "X-API-Key": wsKey } : {};
async function apiAuth(p, opts = {}) {
  const r = await fetch(p, { ...opts, headers: { "Content-Type": "application/json", ...authHeaders(), ...(opts.headers || {}) } });
  if (!r.ok) { let d = {}; try { d = await r.json(); } catch {} throw new Error(d.error || `HTTP ${r.status}`); }
  return r.json();
}
function populateWsOrgs() {
  const sel = $("ws-org");
  if (sel.options.length > 1) return;
  for (const [id, name] of Object.entries(orgNames)) {
    const o = document.createElement("option"); o.value = id; o.textContent = name; sel.appendChild(o);
  }
}
async function refreshWorkspaceUI() {
  populateWsOrgs();
  if (!wsKey) {
    $("ws-disconnected").style.display = ""; $("ws-connected").style.display = "none";
    $("alerts-panel").style.display = "none"; $("ws-status").textContent = "not connected";
    return;
  }
  try {
    const d = await apiAuth("/api/workspace");
    $("ws-disconnected").style.display = "none"; $("ws-connected").style.display = "";
    $("alerts-panel").style.display = "";
    $("ws-status").textContent = "connected";
    $("ws-title").textContent = d.workspace.name;
    const today = new Date().toISOString().slice(0, 10);
    $("ws-sub").innerHTML = `${d.workspace.org ? (orgNames[d.workspace.org] || d.workspace.org) + " · " : ""}key ${d.workspace.apiKeyMasked} · ${(d.usage[today] || 0)} calls today`;
    $("ws-webhook").value = d.workspace.webhook || "";
    if (d.workspace.org && $("orgsel").value === "all") {
      $("orgsel").value = d.workspace.org; selectedOrg = d.workspace.org; recolor();
    }
    loadAlerts();
    const isAdmin = d.workspace.role === "admin";
    $("admin-panel").style.display = isAdmin ? "" : "none";
    if (isAdmin) loadAdmin();
  } catch (e) {
    toast("Workspace: " + e.message, "err");
    if (/Invalid API key/.test(e.message)) { wsKey = null; localStorage.removeItem("orbitiq-apikey"); refreshWorkspaceUI(); }
  }
}
$("ws-create").addEventListener("click", async () => {
  const name = $("ws-name").value.trim();
  if (name.length < 2) return toast("Enter a workspace name", "err");
  try {
    const d = await apiAuth("/api/workspaces", { method: "POST", body: JSON.stringify({ name, org: $("ws-org").value || null }) });
    wsKey = d.workspace.apiKey;
    localStorage.setItem("orbitiq-apikey", wsKey);
    toast(`Workspace "${name}" created — API key saved in this browser`, "ok", 8000);
    refreshWorkspaceUI();
  } catch (e) { toast("Create failed: " + e.message, "err"); }
});
$("ws-connect").addEventListener("click", () => {
  const k = $("ws-key-input").value.trim();
  if (!k.startsWith("oiq_")) return toast("Keys start with oiq_", "err");
  wsKey = k; localStorage.setItem("orbitiq-apikey", k); refreshWorkspaceUI();
});
$("ws-logout").addEventListener("click", () => {
  wsKey = null; localStorage.removeItem("orbitiq-apikey"); refreshWorkspaceUI();
  toast("Disconnected. Your workspace still exists — reconnect with its key.");
});
$("ws-copy").addEventListener("click", async () => {
  try { await navigator.clipboard.writeText(wsKey); toast("API key copied", "ok"); }
  catch { toast(wsKey, "info", 15000); }
});
$("ws-webhook-save").addEventListener("click", async () => {
  try {
    await apiAuth("/api/workspace", { method: "PUT", body: JSON.stringify({ webhook: $("ws-webhook").value.trim() || null }) });
    toast("Webhook saved — new alerts will POST there", "ok");
  } catch (e) { toast("Save failed: " + e.message, "err"); }
});
$("ws-scan").addEventListener("click", async () => {
  const b = $("ws-scan"); b.disabled = true; b.textContent = "Scanning…";
  try {
    const d = await apiAuth("/api/workspace/scan", { method: "POST" });
    toast(d.newAlerts ? `${d.newAlerts} new alert${d.newAlerts > 1 ? "s" : ""}` : "Scan complete — no new close approaches", d.newAlerts ? "err" : "ok");
    loadAlerts();
  } catch (e) { toast("Scan failed: " + e.message, "err"); }
  b.disabled = false; b.textContent = "Scan now";
});

// ---------- alert inbox ----------
async function loadAlerts() {
  if (!wsKey) return;
  try {
    const d = await apiAuth("/api/alerts");
    const unread = d.alerts.filter(a => !a.read).length;
    const badge = $("alert-badge");
    badge.textContent = unread; badge.classList.toggle("zero", unread === 0);
    $("alertlist").innerHTML = d.alerts.length ? d.alerts.slice(0, 20).map(a => `
      <div class="item ${a.risk}${a.read ? "" : " clickable"}">
        <span class="risk">${a.risk}</span><b>${a.missKm} km miss</b>
        <div class="sub">${a.a.name} ⇄ ${a.b.name}</div>
        <div class="sub">TCA ${new Date(a.tca).toUTCString().slice(0, 25)}</div>
      </div>`).join("")
      : `<div class="item"><span class="sub">No alerts yet — run a scan.</span></div>`;
  } catch { /* transient */ }
}
$("alerts-read").addEventListener("click", async () => {
  try { await apiAuth("/api/alerts/read", { method: "POST" }); loadAlerts(); } catch {}
});
$("alerts-notify").addEventListener("click", async () => {
  if (!("Notification" in window)) return toast("Notifications unsupported in this browser", "err");
  const p = await Notification.requestPermission();
  toast(p === "granted" ? "Browser notifications enabled" : "Notifications not permitted", p === "granted" ? "ok" : "err");
});

// ---------- admin console ----------
async function loadAdmin() {
  try {
    const d = await apiAuth("/api/admin/overview");
    $("admin-meta").textContent = `${d.workspaces.length} workspaces · ${d.system.wsClients} online`;
    $("admin-wslist").innerHTML = d.workspaces.map(w => `
      <div class="item ${w.role === "admin" ? "go" : "LOW"}">
        <b>${w.name}</b>${w.role === "admin" ? `<span class="risk">admin</span>` : `<span class="risk" style="cursor:pointer" data-del="${w.id}" title="Delete workspace">delete</span>`}
        <div class="sub">${w.org ? (orgNames[w.org] || w.org) + " · " : ""}${w.alertCount} alerts (${w.unread} unread) · ${w.callsToday} calls today${w.webhook ? " · webhook" : ""}</div>
      </div>`).join("");
    document.querySelectorAll("#admin-wslist [data-del]").forEach(n => n.addEventListener("click", async () => {
      if (!confirm("Delete this workspace and its alerts?")) return;
      try { await apiAuth("/api/admin/workspaces/" + n.dataset.del, { method: "DELETE" }); toast("Workspace deleted", "ok"); loadAdmin(); }
      catch (e) { toast("Delete failed: " + e.message, "err"); }
    }));
  } catch (e) { $("admin-wslist").innerHTML = `<div class="item"><span class="sub">Admin data unavailable: ${e.message}</span></div>`; }
}
$("admin-send").addEventListener("click", async () => {
  const m = $("admin-msg").value.trim();
  if (!m) return;
  try {
    const d = await apiAuth("/api/admin/broadcast", { method: "POST", body: JSON.stringify({ message: m }) });
    toast(`Notice delivered to ${d.delivered} client${d.delivered === 1 ? "" : "s"}`, "ok");
    $("admin-msg").value = "";
  } catch (e) { toast("Broadcast failed: " + e.message, "err"); }
});
$("admin-scanall").addEventListener("click", async () => {
  const b = $("admin-scanall"); b.disabled = true; b.textContent = "Scanning all workspaces…";
  try { await apiAuth("/api/admin/scan-all", { method: "POST" }); toast("All workspace scans complete", "ok"); loadAdmin(); }
  catch (e) { toast("Scan failed: " + e.message, "err"); }
  b.disabled = false; b.textContent = "Run scans for all workspaces";
});

// ---------- WebSocket live push ----------
let wsRetry = 1000;
function connectWS() {
  try {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const sock = new WebSocket(`${proto}//${location.host}/ws`);
    sock.onopen = () => { wsRetry = 1000; };
    sock.onmessage = ev => {
      try {
        const m = JSON.parse(ev.data);
        if (m.type === "notice") toast(`Notice — ${m.payload.message}`, "info", 10000);
        if (m.type === "alerts") {
          const top = m.payload.top?.[0];
          toast(`⚠ ${m.payload.count} new conjunction alert${m.payload.count > 1 ? "s" : ""}${top ? ` — closest ${top.missKm} km` : ""}`, "err", 9000);
          if (Notification.permission === "granted" && top)
            new Notification("OrbitIQ conjunction alert", { body: `${top.a.name} ⇄ ${top.b.name} · ${top.missKm} km · ${new Date(top.tca).toUTCString()}` });
          loadAlerts();
        }
      } catch {}
    };
    sock.onclose = () => setTimeout(connectWS, Math.min(wsRetry *= 1.6, 30000));
  } catch { setTimeout(connectWS, 10000); }
}
connectWS();

// ---------- maneuver feed ----------
async function loadManeuvers() {
  try {
    const d = await api("/api/maneuvers");
    $("maneuverlist").innerHTML = d.events.length ? d.events.slice(0, 12).map(m => `
      <div class="item clickable ${m.confidence === "HIGH" ? "HIGH" : "MODERATE"}" data-id="${m.id}">
        <span class="risk">${m.type}</span><b>${m.name}</b>
        <div class="sub">Δalt ${m.dAltKm > 0 ? "+" : ""}${m.dAltKm} km · Δincl ${m.dInclDeg}° · ${orgNames[m.org] || m.org}</div>
      </div>`).join("")
      : `<div class="item"><span class="sub">No maneuvers detected between recent element epochs.</span></div>`;
    document.querySelectorAll("#maneuverlist [data-id]").forEach(n => n.addEventListener("click", () => {
      const s = sats.find(x => x.id === +n.dataset.id); if (s) selectSat(s, true);
    }));
  } catch {
    $("maneuverlist").innerHTML = `<div class="item"><span class="sub">Maneuver feed unavailable.</span></div>`;
  }
}
loadManeuvers();
setInterval(loadManeuvers, 30 * 60 * 1000);

// ---------- traffic view ----------
async function loadTraffic() {
  try {
    const d = await api("/api/traffic/congestion");
    const totalLeo = d.shells.reduce((s, x) => s + x.count, 0);
    const severe = d.shells.filter(s => s.tier === "SEVERE").length;
    $("traffic-cards").innerHTML = [
      [totalLeo.toLocaleString(), "objects 200–2000 km"],
      [`${d.mostCongested.altKm}–${d.mostCongested.altKm + d.binKm} km`, "most congested shell"],
      [d.mostCongested.count.toLocaleString(), "objects in that shell"],
      [severe, "shells at SEVERE load"]
    ].map(([v, l], i) => `<div class="card" style="animation-delay:${i * 0.08}s"><div class="big">${v}</div><div class="lbl">${l}</div></div>`).join("");
    const max = Math.max(...d.shells.map(s => s.count), 1);
    $("shell-strip").innerHTML = d.shells.map(s =>
      `<div class="sh ${s.tier}" style="height:${Math.max(2, (s.count / max) * 100)}%" title="${s.altKm}–${s.altKm + d.binKm} km · ${s.count} objects · ${s.tier}${s.topOrg ? " · top: " + (orgNames[s.topOrg] || s.topOrg) : ""}"></div>`).join("") +
      `</div><div class="strip-axis"><span>200 km</span><span>650 km</span><span>1100 km</span><span>1550 km</span><span>2000 km</span>`;
    const top = [...d.shells].sort((a, b) => b.count - a.count).slice(0, 10);
    document.querySelector("#shell-table tbody").innerHTML = top.map(s => `
      <tr><td>${s.altKm}–${s.altKm + d.binKm} km</td><td>${s.count.toLocaleString()}</td>
      <td>${s.topOrg ? `<span class="org-pill">${orgNames[s.topOrg] || s.topOrg}</span>` : "—"}</td>
      <td><span class="tier ${s.tier}">${s.tier}</span></td></tr>`).join("");
  } catch (e) { toast("Traffic data unavailable: " + e.message, "err"); }
}

// ---------- tools view ----------
$("tf-run").addEventListener("click", async () => {
  try {
    const d = await api(`/api/tools/transfer?alt1=${parseFloat($("tf-alt1").value)}&alt2=${parseFloat($("tf-alt2").value)}&planeChange=${parseFloat($("tf-di").value) || 0}`);
    $("tf-result").innerHTML = `<div class="tf-grid">
      <div class="tf-cell"><div class="v">${d.dv1KmS}</div><div class="l">burn 1 · km/s</div></div>
      <div class="tf-cell"><div class="v">${d.dv2KmS}</div><div class="l">burn 2 · km/s</div></div>
      <div class="tf-cell"><div class="v">${d.totalKmS}</div><div class="l">total Δv · km/s</div></div>
      <div class="tf-cell"><div class="v">${(d.tofMin / 60).toFixed(1)} h</div><div class="l">transfer time</div></div>
    </div><div class="sub" style="color:var(--text-faint);font-size:10px;margin-top:8px">${d.note}</div>`;
  } catch (e) { $("tf-result").innerHTML = `<div class="item CRITICAL"><span class="sub">${e.message}</span></div>`; }
});
$("lp-run").addEventListener("click", async () => {
  try {
    const d = await api(`/api/tools/launch-plan?incl=${parseFloat($("lp-incl").value)}&alt=${parseFloat($("lp-alt").value) || 550}`);
    $("lp-result").innerHTML = `<table class="kv-table"><thead><tr><th>Site</th><th>Azimuths</th><th>Δv est</th></tr></thead><tbody>` +
      d.sites.map(s => s.feasible
        ? `<tr${s.site === d.bestSite ? ' style="color:var(--accent-2)"' : ""}><td>${s.site}${s.site === d.bestSite ? " ★" : ""}</td><td>${s.azimuthsDeg.join("° / ")}°</td><td>${s.deltaVEstKmS} km/s</td></tr>`
        : `<tr class="lp-row-bad"><td>${s.site}</td><td colspan="2">infeasible — lat ${Math.abs(s.lat)}° &gt; incl</td></tr>`).join("") +
      `</tbody></table><div class="sub" style="color:var(--text-faint);font-size:10px;margin-top:8px">${d.note}</div>`;
  } catch (e) { $("lp-result").innerHTML = `<div class="item CRITICAL"><span class="sub">${e.message}</span></div>`; }
});
$("dl-conj")?.addEventListener("click", e => {
  e.currentTarget.href = `/api/export/conjunctions.csv?org=${selectedOrg === "all" ? "" : selectedOrg}&hours=${$("conj-hours").value}&thresholdKm=${$("conj-th").value}`;
});

// ---------- command palette ----------
const pal = $("palette"), palInput = $("palette-input"), palResults = $("palette-results");
let palSel = 0, palItems = [];
function openPalette() { pal.classList.add("open"); palInput.value = ""; renderPalette(""); palInput.focus(); }
function closePalette() { pal.classList.remove("open"); }
function paletteActions() {
  return [
    { k: "View", label: "Operations", run: () => switchView("ops") },
    { k: "View", label: "Analytics", run: () => switchView("analytics") },
    { k: "View", label: "Traffic & congestion", run: () => switchView("traffic") },
    { k: "View", label: "Mission tools", run: () => switchView("tools") },
    { k: "View", label: "Catalog", run: () => switchView("catalog") },
    { k: "Action", label: "Run conjunction screening", run: () => { switchView("ops"); $("runconj").click(); } },
    { k: "Action", label: "Fly to ISS", run: () => { const s = sats.find(x => x.name.startsWith("ISS")); if (s) { switchView("ops"); selectSat(s, true); } } },
    { k: "Action", label: "Toggle debris visibility", run: () => { const f = $("typefilter"); f.value = f.value === "DEBRIS" ? "all" : "DEBRIS"; f.dispatchEvent(new Event("change")); } },
    { k: "Action", label: "Download catalog CSV", run: () => location.href = "/api/export/catalog.csv" }
  ];
}
function renderPalette(q) {
  const Q = q.trim().toUpperCase();
  const actions = paletteActions().filter(a => !Q || a.label.toUpperCase().includes(Q));
  const satHits = Q.length >= 2
    ? sats.filter(s => s.name.toUpperCase().includes(Q) || String(s.id) === Q).slice(0, 8)
      .map(s => ({ k: "Object", label: s.name, sub: `NORAD ${s.id} · ${s.orgName || s.org}`, run: () => { switchView("ops"); selectSat(s, true); } }))
    : [];
  palItems = [...satHits, ...actions].slice(0, 12);
  palSel = 0;
  palResults.innerHTML = palItems.map((it, i) => `
    <div class="pal-item${i === 0 ? " sel" : ""}" data-i="${i}">
      <span class="k">${it.k}</span><span>${it.label}</span>${it.sub ? `<span class="sub">${it.sub}</span>` : ""}
    </div>`).join("") || `<div class="pal-item"><span class="sub">No matches.</span></div>`;
  palResults.querySelectorAll("[data-i]").forEach(n => n.addEventListener("click", () => { palItems[+n.dataset.i]?.run(); closePalette(); }));
}
palInput.addEventListener("input", e => renderPalette(e.target.value));
palInput.addEventListener("keydown", e => {
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    palSel = (palSel + (e.key === "ArrowDown" ? 1 : palItems.length - 1)) % Math.max(palItems.length, 1);
    palResults.querySelectorAll(".pal-item").forEach((n, i) => n.classList.toggle("sel", i === palSel));
  } else if (e.key === "Enter") { palItems[palSel]?.run(); closePalette(); }
});
$("palette-btn").addEventListener("click", openPalette);
pal.addEventListener("click", e => { if (e.target === pal) closePalette(); });

// ---------- keyboard shortcuts ----------
addEventListener("keydown", e => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); pal.classList.contains("open") ? closePalette() : openPalette(); return; }
  if (e.key === "Escape") { closePalette(); $("drawer").classList.remove("open"); return; }
  if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT" || e.target.tagName === "TEXTAREA") return;
  const map = { 1: "ops", 2: "analytics", 3: "traffic", 4: "tools", 5: "catalog" };
  if (map[e.key]) switchView(map[e.key]);
});

// ---------- v3 boot hooks ----------
(async function bootV3() {
  // wait for catalog so org names exist
  const t0 = Date.now();
  while (!Object.keys(orgNames).length && Date.now() - t0 < 30000) await new Promise(r => setTimeout(r, 500));
  refreshWorkspaceUI();
  setInterval(loadAlerts, 5 * 60 * 1000);
})();
