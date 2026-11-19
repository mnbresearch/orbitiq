// OrbitIQ sky globe — the real catalogue, rendered.
//
// Used twice: as the hero of the landing page and as the full-screen public
// sky view (/sky). Every point is an object in the live public catalogue,
// propagated with SGP4 from its own elements in a worker (skyworker.js). There
// is no decorative particle field here: if a point is on screen, something is
// in orbit there, give or take the kilometre-level error of public elements.
//
// Design constraints:
//   * Main thread stays free. Propagation runs in the worker at a fixed cadence
//     and the main thread interpolates between the last two answers, so motion
//     is smooth at 60 fps without 17,000 SGP4 calls per frame.
//   * It costs nothing when no one is looking: rendering stops when the canvas
//     scrolls out of view or the tab is hidden.
//   * prefers-reduced-motion is honoured: no auto-rotation, real-time clock.
import * as THREE from "/vendor/three/three.module.js";

const EARTH_R = 6371, SCALE = 1 / 1000;
export const TYPE_STYLE = {
  PAYLOAD:       { label: "Payloads",      color: 0x7cf0ff },
  "ROCKET BODY": { label: "Rocket bodies", color: 0xffc565 },
  DEBRIS:        { label: "Debris",        color: 0xff8a8a },
  UNKNOWN:       { label: "Unknown",       color: 0xa4b0c8 }
};
const regimeOf = mm => mm > 11.25 ? "LEO" : mm > 1.5 ? "MEO" : "GEO";

function sunDirScene(date) {
  const jd = date.getTime() / 86400000 + 2440587.5, n = jd - 2451545.0;
  const L = (280.46 + 0.9856474 * n) * Math.PI / 180;
  const g = (357.528 + 0.9856003 * n) * Math.PI / 180;
  const lam = L + (1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * Math.PI / 180;
  const eps = 23.439 * Math.PI / 180;
  const x = Math.cos(lam), y = Math.cos(eps) * Math.sin(lam), z = Math.sin(eps) * Math.sin(lam);
  return new THREE.Vector3(x, z, -y).normalize();
}
function gmst(date) {
  const jd = date.getTime() / 86400000 + 2440587.5, T = (jd - 2451545.0) / 36525;
  let g = 280.46061837 + 360.98564736629 * (jd - 2451545.0) + 0.000387933 * T * T - T * T * T / 38710000;
  g = ((g % 360) + 360) % 360;
  return g * Math.PI / 180;
}

export async function createSkyGlobe(canvas, opts = {}) {
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const o = {
    timeScale: reduced ? 1 : (opts.timeScale ?? 1),
    autoRotate: reduced ? 0 : (opts.autoRotate ?? 0.04),
    distance: opts.distance ?? 24,
    minDistance: opts.minDistance ?? 8,
    maxDistance: opts.maxDistance ?? 90,
    wheelZoom: opts.wheelZoom ?? false,
    pointScale: opts.pointScale ?? 1,
    tilt: opts.tilt ?? 0.32,
    offsetX: opts.offsetX ?? 0,            // shift the globe within the frame (fraction of width)
    catalogUrl: opts.catalogUrl ?? "/api/v1/catalog/compact",
    onReady: opts.onReady, onHover: opts.onHover, onSelect: opts.onSelect, onTick: opts.onTick
  };

  // ---------- renderer ----------
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: "high-performance" });
  } catch (e) { throw new Error("WebGL unavailable"); }
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(36, 1, 0.1, 2000);

  // ---------- earth ----------
  const earthGroup = new THREE.Group(); scene.add(earthGroup);
  const uniforms = {
    dayMap: { value: null }, nightMap: { value: null }, hasMaps: { value: 0 },
    sunDir: { value: new THREE.Vector3(1, 0, 0) }
  };
  const earth = new THREE.Mesh(
    new THREE.SphereGeometry(EARTH_R * SCALE, 128, 96),
    new THREE.ShaderMaterial({
      uniforms,
      vertexShader: `
        varying vec2 vUv; varying vec3 vN; varying vec3 vP;
        void main() {
          vUv = uv; vN = normalize(mat3(modelMatrix) * normal);
          vP = (modelMatrix * vec4(position, 1.0)).xyz;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: `
        uniform sampler2D dayMap; uniform sampler2D nightMap; uniform float hasMaps; uniform vec3 sunDir;
        varying vec2 vUv; varying vec3 vN; varying vec3 vP;
        void main() {
          vec3 n = normalize(vN);
          float l = dot(n, normalize(sunDir));
          float k = smoothstep(-0.18, 0.22, l);
          vec3 day = mix(vec3(0.05, 0.13, 0.24), texture2D(dayMap, vUv).rgb, hasMaps);
          vec3 night = mix(vec3(0.01, 0.02, 0.05), texture2D(nightMap, vUv).rgb, hasMaps);
          vec3 lit = day * (0.22 + 0.9 * max(l, 0.0));
          vec3 dark = night * vec3(1.05, 0.9, 0.7) * 1.25 + vec3(0.004, 0.01, 0.025);
          vec3 col = mix(dark, lit, k);
          vec3 v = normalize(cameraPosition - vP);
          float rim = pow(1.0 - max(dot(v, n), 0.0), 2.6);
          col += vec3(0.20, 0.45, 0.85) * rim * (0.25 + 0.55 * k);
          gl_FragColor = vec4(col, 1.0);
        }`
    })
  );
  earthGroup.add(earth);
  const loader = new THREE.TextureLoader();
  Promise.all(["/img/earth-day.jpg", "/img/earth-night.jpg"].map(u => loader.loadAsync(u)))
    .then(([d, n]) => {
      // Left in their stored (sRGB) encoding on purpose: these ShaderMaterials write
      // gl_FragColor straight to the sRGB canvas, so decoding to linear here would
      // darken the whole planet.
      for (const t of [d, n]) t.anisotropy = renderer.capabilities.getMaxAnisotropy();
      uniforms.dayMap.value = d; uniforms.nightMap.value = n; uniforms.hasMaps.value = 1;
    }).catch(() => {});

  const atmo = new THREE.Mesh(
    new THREE.SphereGeometry(EARTH_R * SCALE * 1.06, 96, 64),
    new THREE.ShaderMaterial({
      transparent: true, side: THREE.BackSide, depthWrite: false, blending: THREE.AdditiveBlending,
      uniforms: { sunDir: uniforms.sunDir },
      vertexShader: `varying vec3 vN; varying vec3 vP;
        void main(){ vN = normalize(mat3(modelMatrix)*normal); vP=(modelMatrix*vec4(position,1.)).xyz;
        gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.);}`,
      fragmentShader: `uniform vec3 sunDir; varying vec3 vN; varying vec3 vP;
        void main(){ vec3 v = normalize(cameraPosition - vP);
        float a = pow(clamp(1.0 - abs(dot(v, normalize(vN))), 0.0, 1.0), 4.0);
        float lit = 0.35 + 0.65 * smoothstep(-0.4, 0.5, dot(normalize(vN), normalize(sunDir)));
        gl_FragColor = vec4(vec3(0.30, 0.62, 1.0) * a * lit * 1.4, a * lit); }`
    })
  );
  scene.add(atmo);

  // ---------- stars ----------
  {
    const n = 2600, pos = new Float32Array(n * 3), v = new THREE.Vector3();
    for (let i = 0; i < n; i++) { v.randomDirection().multiplyScalar(500 + Math.random() * 300); pos.set([v.x, v.y, v.z], i * 3); }
    const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    scene.add(new THREE.Points(g, new THREE.PointsMaterial({ color: 0x8796b8, size: 0.9, sizeAttenuation: false, transparent: true, opacity: 0.55 })));
  }

  // ---------- catalogue points ----------
  const res = await fetch(o.catalogUrl);
  if (!res.ok) throw new Error("catalogue unavailable (" + res.status + ")");
  const cat = await res.json();
  const F = Object.fromEntries(cat.fields.map((k, i) => [k, i]));
  const rows = cat.rows;
  const N = rows.length;
  const objects = rows.map(r => ({
    id: r[F.id], name: r[F.name], intl: r[F.intl], type: TYPE_STYLE[r[F.type]] ? r[F.type] : "UNKNOWN",
    org: r[F.org], meanMotion: r[F.meanMotion], incl: r[F.incl], ecc: r[F.ecc], epoch: r[F.epoch],
    regime: regimeOf(r[F.meanMotion])
  }));

  const geo = new THREE.BufferGeometry();
  const posA = new THREE.BufferAttribute(new Float32Array(N * 3), 3);
  const colA = new THREE.BufferAttribute(new Float32Array(N * 3), 3);
  const visA = new THREE.BufferAttribute(new Float32Array(N).fill(1), 1);
  posA.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute("position", posA); geo.setAttribute("color", colA); geo.setAttribute("vis", visA);
  const c = new THREE.Color();
  objects.forEach((ob, i) => { c.setHex(TYPE_STYLE[ob.type].color); colA.setXYZ(i, c.r, c.g, c.b); });
  const pointMat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: { size: { value: 2.2 * o.pointScale * renderer.getPixelRatio() }, scale: { value: 1 } },
    vertexShader: `
      attribute vec3 color; attribute float vis; uniform float size; uniform float scale;
      varying vec3 vC; varying float vV;
      void main() {
        vC = color; vV = vis;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = size * (0.55 + 0.45 * vis) * clamp(22.0 / -mv.z, 0.6, 2.4) * scale;
        gl_Position = projectionMatrix * mv;
        if (vis < 0.01) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      }`,
    fragmentShader: `
      varying vec3 vC; varying float vV;
      void main() {
        vec2 d = gl_PointCoord - 0.5; float r = length(d);
        if (r > 0.5) discard;
        float core = smoothstep(0.5, 0.0, r);
        gl_FragColor = vec4(vC * (0.35 + 0.65 * vV), core * (0.25 + 0.75 * vV));
      }`
  });
  const points = new THREE.Points(geo, pointMat);
  points.frustumCulled = false;
  scene.add(points);

  // selection marker + track
  const marker = new THREE.Mesh(new THREE.RingGeometry(0.16, 0.2, 40),
    new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.95, side: THREE.DoubleSide, depthTest: false }));
  marker.visible = false; marker.renderOrder = 10; scene.add(marker);
  let trackLine = null;

  // ---------- worker ----------
  // Frames are snapshots of every position at a known simulation time. The
  // renderer interpolates between the two frames that bracket "now" and keeps
  // one or two frames of lead time requested from the worker.
  const worker = new Worker(new URL("./skyworker.js", import.meta.url), { type: "module" });
  let simMs = Date.now(), lastWall = performance.now();
  const STEP_WALL_MS = 1000;
  let frames = [], pendingT = null, started = false, gen = 0;
  const waiters = {};
  worker.onmessage = ({ data: m }) => {
    if (m.type === "positions") {
      if (m.id !== gen) return;          // answer to a request made before a time reset
      if (m.t === pendingT) pendingT = null;
      frames.push({ t: m.t, buf: m.buf });
      frames.sort((a, b) => a.t - b.t);
      if (!started) { started = true; queueMicrotask(() => o.onReady?.(api)); }
    } else {
      const w = waiters[m.type]; delete waiters[m.type]; w?.(m);
    }
  };
  const ask = (type, payload) => new Promise(r => { waiters[type] = r; worker.postMessage({ type, ...payload }); });
  worker.postMessage({ type: "load", fields: cat.fields, rows });
  function requestFrame(t) { pendingT = t; worker.postMessage({ type: "positions", t, id: gen }); }
  requestFrame(simMs);
  function pump() {
    const step = STEP_WALL_MS * Math.max(1, Math.abs(o.timeScale));
    const latest = frames.length ? frames[frames.length - 1].t : null;
    if (pendingT == null && (latest == null || latest - simMs < step * 1.5)) {
      requestFrame(latest == null || latest < simMs ? simMs + step * 0.25 : latest + step);
    }
    while (frames.length > 2 && frames[1].t <= simMs) frames.shift();
  }

  // ---------- camera / interaction ----------
  let rotY = opts.startRotY ?? -1.2, rotX = o.tilt, dist = o.distance, vY = 0, vX = 0;
  let dragging = false, px = 0, py = 0, lastInteract = -1e9, downAt = 0, downX = 0, downY = 0;
  let target = null;
  canvas.style.touchAction = opts.wheelZoom ? "none" : "pan-y";
  canvas.addEventListener("pointerdown", e => {
    dragging = true; px = downX = e.clientX; py = downY = e.clientY; downAt = performance.now(); target = null;
    canvas.setPointerCapture?.(e.pointerId);
  });
  canvas.addEventListener("pointerup", e => {
    dragging = false; lastInteract = performance.now();
    const moved = Math.hypot(e.clientX - downX, e.clientY - downY);
    if (moved < 5 && performance.now() - downAt < 400 && o.onSelect) select(pickAt(e.clientX, e.clientY));
  });
  canvas.addEventListener("pointermove", e => {
    if (dragging) {
      vY = (e.clientX - px) * 0.0045; vX = (e.clientY - py) * 0.0045;
      rotY += vY; rotX = Math.max(-1.4, Math.min(1.4, rotX + vX));
      px = e.clientX; py = e.clientY; lastInteract = performance.now();
    } else if (o.onHover) { hoverX = e.clientX; hoverY = e.clientY; hoverDirty = true; }
  });
  canvas.addEventListener("pointerleave", () => { if (o.onHover) { hoverIdx = -1; o.onHover(null); } });
  if (o.wheelZoom) canvas.addEventListener("wheel", e => {
    e.preventDefault(); target = null;
    dist = Math.max(o.minDistance, Math.min(o.maxDistance, dist * Math.exp(e.deltaY * 0.0012)));
    lastInteract = performance.now();
  }, { passive: false });

  // ---------- picking (screen space, visible objects only) ----------
  const tmp = new THREE.Vector3();
  let hoverX = 0, hoverY = 0, hoverDirty = false, hoverIdx = -1;
  const camDir = new THREE.Vector3();
  function pickAt(cx, cy, radiusPx = 10) {
    const r = canvas.getBoundingClientRect();
    const x = cx - r.left, y = cy - r.top;
    const arr = posA.array, vis = visA.array;
    camera.getWorldDirection(camDir);
    let best = -1, bestD = radiusPx * radiusPx;
    for (let i = 0; i < N; i++) {
      if (vis[i] < 0.5 || !Number.isFinite(arr[i * 3])) continue;
      tmp.set(arr[i * 3], arr[i * 3 + 1], arr[i * 3 + 2]);
      // skip objects hidden behind the Earth
      const toP = tmp.clone().sub(camera.position);
      const tca = -camera.position.dot(toP.clone().normalize());
      if (tca > 0) {
        const d2 = camera.position.lengthSq() - tca * tca;
        if (d2 < (EARTH_R * SCALE) ** 2 && toP.length() > tca) continue;
      }
      tmp.project(camera);
      if (tmp.z > 1) continue;
      const sx = (tmp.x + 1) / 2 * r.width, sy = (1 - tmp.y) / 2 * r.height;
      const d = (sx - x) ** 2 + (sy - y) ** 2;
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  }
  setInterval(() => {
    if (!hoverDirty || dragging || !o.onHover) return;
    hoverDirty = false;
    const i = pickAt(hoverX, hoverY);
    if (i !== hoverIdx) { hoverIdx = i; o.onHover(i >= 0 ? { ...objects[i], index: i } : null, hoverX, hoverY); }
    else if (i >= 0) o.onHover({ ...objects[i], index: i }, hoverX, hoverY);
  }, 70);

  let selected = -1;
  async function select(i) {
    selected = i;
    if (trackLine) { scene.remove(trackLine); trackLine.geometry.dispose(); trackLine = null; }
    marker.visible = i >= 0;
    if (i < 0) { o.onSelect?.(null); return; }
    const t = await ask("track", { index: i, t: simMs });
    if (selected !== i) return;
    if (t.buf.length > 6) {
      const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.BufferAttribute(t.buf, 3));
      trackLine = new THREE.Line(g, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.55 }));
      scene.add(trackLine);
    }
    const st = await ask("state", { index: i, t: simMs });
    o.onSelect?.({ ...objects[i], index: i, state: st.state });
  }
  async function stateOf(i) { return (await ask("state", { index: i, t: simMs })).state; }
  function flyTo(i, d = 14) {
    const a = posA.array;
    if (!Number.isFinite(a[i * 3])) return;
    tmp.set(a[i * 3], a[i * 3 + 1], a[i * 3 + 2]);
    target = { rotX: Math.asin(Math.max(-1, Math.min(1, tmp.y / tmp.length()))), rotY: Math.atan2(tmp.x, tmp.z), dist: d };
  }

  // ---------- filtering ----------
  function setFilter(fn) {
    const vis = visA.array; let shown = 0;
    for (let i = 0; i < N; i++) { const v = !fn || fn(objects[i]) ? 1 : 0.06; vis[i] = v; if (v === 1) shown++; }
    visA.needsUpdate = true;
    return shown;
  }

  // ---------- loop ----------
  let visible = true, raf = 0, running = true;
  const io = new IntersectionObserver(es => { visible = es[0].isIntersecting; if (visible) kick(); }, { threshold: 0.01 });
  io.observe(canvas);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) { lastWall = performance.now(); kick(); } });
  function kick() { if (!raf && running) raf = requestAnimationFrame(frame); }
  function resize() {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return;
    if (canvas.width !== Math.round(w * renderer.getPixelRatio()) || canvas.height !== Math.round(h * renderer.getPixelRatio())) {
      renderer.setSize(w, h, false);
    }
    camera.aspect = w / h;
    camera.setViewOffset(w, h, -o.offsetX * w, 0, w, h);
    camera.updateProjectionMatrix();
  }
  new ResizeObserver(resize).observe(canvas); resize();

  function frame(now) {
    raf = 0;
    if (!visible || document.hidden || !running) return;
    const dt = Math.min(0.1, (now - lastWall) / 1000); lastWall = now;
    simMs += dt * 1000 * o.timeScale;

    // interpolate catalogue positions between the bracketing frames
    pump();
    if (frames.length) {
      const A = frames[0], B = frames[1] || frames[0];
      const k = B.t > A.t ? Math.max(0, Math.min(1, (simMs - A.t) / (B.t - A.t))) : 0;
      const a = posA.array, p = A.buf, q = B.buf;
      for (let i = 0; i < a.length; i += 3) {
        if (Number.isFinite(p[i]) && Number.isFinite(q[i])) {
          a[i] = p[i] + (q[i] - p[i]) * k; a[i + 1] = p[i + 1] + (q[i + 1] - p[i + 1]) * k; a[i + 2] = p[i + 2] + (q[i + 2] - p[i + 2]) * k;
        } else { a[i] = a[i + 1] = a[i + 2] = 0; } // decayed or unpropagatable: parked inside the Earth
      }
      posA.needsUpdate = true;
    }

    // earth orientation + sun
    const d = new Date(simMs);
    earthGroup.rotation.y = gmst(d);
    uniforms.sunDir.value.copy(sunDirScene(d));

    // camera
    if (target) {
      rotY += (target.rotY - rotY) * 0.06; rotX += (target.rotX - rotX) * 0.06; dist += (target.dist - dist) * 0.06;
      if (Math.abs(target.rotY - rotY) + Math.abs(target.rotX - rotX) + Math.abs(target.dist - dist) < 0.002) target = null;
    } else if (!dragging) {
      vY *= 0.94; vX *= 0.94; rotY += vY; rotX = Math.max(-1.4, Math.min(1.4, rotX + vX));
      if (now - lastInteract > 2500) rotY += o.autoRotate * dt;
    }
    camera.position.set(dist * Math.cos(rotX) * Math.sin(rotY), dist * Math.sin(rotX), dist * Math.cos(rotX) * Math.cos(rotY));
    camera.lookAt(0, 0, 0);

    if (selected >= 0) {
      const a = posA.array;
      marker.position.set(a[selected * 3], a[selected * 3 + 1], a[selected * 3 + 2]);
      marker.quaternion.copy(camera.quaternion);
      marker.scale.setScalar(dist / 22);
    }
    renderer.render(scene, camera);
    o.onTick?.(d);
    kick();
  }

  // ---------- stats ----------
  const stats = { total: N, byType: {}, byRegime: { LEO: 0, MEO: 0, GEO: 0 }, source: cat.source };
  for (const ob of objects) { stats.byType[ob.type] = (stats.byType[ob.type] || 0) + 1; stats.byRegime[ob.regime]++; }

  const api = {
    objects, stats,
    setFilter, select, flyTo, stateOf,
    get simTime() { return new Date(simMs); },
    setTimeScale(s) { o.timeScale = s; },
    resetTime() { simMs = Date.now(); frames = []; gen++; requestFrame(simMs); },
    zoom(f) { target = null; dist = Math.max(o.minDistance, Math.min(o.maxDistance, dist * f)); lastInteract = performance.now(); },
    pause() { running = false; }, resume() { running = true; lastWall = performance.now(); kick(); }
  };
  kick();
  return api;
}
