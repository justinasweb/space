/* ============================================================================
   FALLING IN
   You hang far above a black hole, and you are falling. Hold space (or the
   mouse, or a finger) to fall faster. The hole's shadow grows, its disk wraps
   over and under it, the sky crowds into a ring and turns blue. Near the end
   you turn to look back up: the whole universe shrinks to a bright circle
   overhead, and time for you runs ever slower than at home. Then the horizon,
   and a new black hole far below.

   Every pixel's light is traced back along its bent path (Schwarzschild,
   Binet's equation in the plane of the ray), so the shadow, the Einstein ring
   and the disk's secondary images all come out of the physics, not tricks.
   Units: the horizon radius is 1.

   Debug query flags (for testing only):
     ?r=3        start (and stay) at this distance from the centre
     ?seed=42    fix the disk and sky              ?still     no idle drift
     ?reduced    force reduced-motion              ?nowebgl   force the fallback
     ?fps        record frame rate in window.__fallingIn.samples
     ?q=0        lock the quality level (0 = best)
   ============================================================================ */
import * as THREE from 'three';
import { mountUI } from '../ui/ui.js';

const ui = mountUI({ id: 'falling-in' });

/* ----------------------------------------------------------------------------
   CONFIG: every tunable in one place.
   ---------------------------------------------------------------------------- */
const CONFIG = {
  fall: {
    start: 40,             // where each fall begins (horizon radii)
    end: 1.003,            // where the horizon takes you
    drift: 0.055,          // how fast you fall untouched (in ln(r - 1) per second)
    held: 0.6,             // ... and while holding
    ease: 0.8,             // seconds (time constant) between the two
    horizonKm: 29.5,       // horizon radius of a black hole of 10 suns, for the readout
  },
  look: {
    fov: 66,               // vertical, degrees
    turnFrom: 4.0,         // below this distance you begin to turn and look back up...
    turnTo: 1.6,           // ... and by this one you look straight away from the hole
    cursor: [6, 4],        // max cursor look (yaw, pitch), degrees
    inertia: 1.0,          // seconds
    orbit: 0.012,          // slow drift around the hole, radians per second
  },
  disk: { inner: 3.0, outer: 14.0 },
  exposure: 1.6,
  message: { show: 6.0 },
  ending: { fade: 2.2, dark: 3.5 },   // seconds to fade at the horizon, and to stay dark before the next fall
  hintAfter: 2.0,
  quality: {
    steps: { desktop: 420, mobile: 260 },         // max integration steps per pixel
    scale: { desktop: 0.8, mobile: 0.6 },
    maxDpr: { desktop: 2.0, mobile: 1.5 },
    ladder: [1.0, 0.85, 0.72, 0.6, 0.5],
    minFps: 48,
  },
  reducedMotion: { timeScale: 0.4 },
};

/* ---------------------------------------------------------------------------- */
const params = new URLSearchParams(location.search);
const REDUCED = params.has('reduced') || matchMedia('(prefers-reduced-motion: reduce)').matches;
const MOBILE = matchMedia('(pointer: coarse)').matches || Math.min(screen.width, screen.height) < 600;
const SEED = params.has('seed') ? (parseInt(params.get('seed'), 10) | 0) : (Math.random() * 1000) | 0;
const DEG = Math.PI / 180;
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
function mulberry32(a) {
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

function fallback() {
  document.body.classList.remove('live');
  document.body.classList.add('fallback');
  ui.showHint(false).message(null);
}

/* ----------------------------------------------------------------------------
   The shader
   ---------------------------------------------------------------------------- */
const STEPS = MOBILE ? CONFIG.quality.steps.mobile : CONFIG.quality.steps.desktop;
const D = CONFIG.disk;

const VERT = /* glsl */`
  varying vec2 vUv;
  void main(){ vUv = position.xy * .5 + .5; gl_Position = vec4(position.xy, 0., 1.); }`;

const FRAG = /* glsl */`
  precision highp float;
  varying vec2 vUv;
  uniform vec2 uRes;
  uniform vec3 uPos, uFwd, uRight, uUp;
  uniform float uTan, uTime, uSeed, uExposure, uFade, uDiskT, uDiskGain, uDiskTemp;
  uniform vec3 uTint;

  float h21(vec2 p){ vec3 q = fract(vec3(p.xyx) * .1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
  float h31(vec3 p){ p = fract(p * .1031); p += dot(p, p.zyx + 31.32); return fract((p.x + p.y) * p.z); }
  float n2(vec2 p){
    vec2 i = floor(p), f = fract(p); f = f * f * (3. - 2. * f);
    return mix(mix(h21(i), h21(i + vec2(1., 0.)), f.x), mix(h21(i + vec2(0., 1.)), h21(i + vec2(1., 1.)), f.x), f.y);
  }
  float n3(vec3 p){
    vec3 i = floor(p), f = fract(p); f = f * f * (3. - 2. * f);
    return mix(mix(mix(h31(i), h31(i + vec3(1,0,0)), f.x), mix(h31(i + vec3(0,1,0)), h31(i + vec3(1,1,0)), f.x), f.y),
               mix(mix(h31(i + vec3(0,0,1)), h31(i + vec3(1,0,1)), f.x), mix(h31(i + vec3(0,1,1)), h31(i + vec3(1,1,1)), f.x), f.y), f.z);
  }
  float fbm3(vec3 p){ float s = 0., a = .5; for (int i = 0; i < 4; i++){ s += a * n3(p); p = p * 2.07 + 3.1; a *= .5; } return s / .9375; }
  float fbm2(vec2 p){ float s = 0., a = .5; for (int i = 0; i < 4; i++){ s += a * n2(p); p = p * 2.03 + vec2(1.7, 9.2); a *= .5; } return s / .9375; }

  vec3 blackbody(float k){                          // k: temperature in thousands of kelvin
    float t = clamp(k, 1., 40.) * 10.;
    vec3 c;
    c.r = t <= 66. ? 1. : clamp(1.2929 * pow(t - 60., -.1332), 0., 1.);
    c.g = t <= 66. ? clamp(.3901 * log(t) - .6318, 0., 1.) : clamp(1.1299 * pow(t - 60., -.0755), 0., 1.);
    c.b = t >= 66. ? 1. : t <= 19. ? 0. : clamp(.5432 * log(t - 10.) - 1.1963, 0., 1.);
    return c * c;
  }

  float pxAngle;

  // ---- the sky far away: stars, a band of the galaxy, faint nebulae ----
  vec3 sky(vec3 d, float blue){
    vec3 col = vec3(0.);
    for (int l = 0; l < 3; l++){
      float fl = float(l), dens = fl == 0. ? 140. : fl == 1. ? 70. : 30.;
      vec3 g = d * dens + uSeed * (fl + 1.), id = floor(g), f = fract(g) - .5;
      float r = h31(id);
      if (r > .985){
        vec3 o = (vec3(h31(id + 3.1), h31(id + 7.7), h31(id + 1.9)) - .5) * .4;
        vec3 e = f - o; e -= d * dot(e, d);                         // distance across the line of sight
        float m = (r - .985) / .015, w = pxAngle * dens * (.8 + .4 * m * fl);
        vec3 c = mix(vec3(1., .78, .6), vec3(.7, .82, 1.), h31(id + 5.3));
        col += c * exp(-dot(e, e) / (w * w)) * m * m * (fl == 0. ? .16 : fl == 1. ? .4 : 1.1);
      }
    }
    vec3 N = normalize(vec3(.3, .9, .25));
    float b = dot(d, N);
    float band = exp(-b * b * 18.);
    col += vec3(.014, .013, .018) * band * (.4 + fbm3(d * 4. + uSeed)) * (1. - .5 * smoothstep(.5, .7, fbm3(d * 9. - uSeed)));
    col += vec3(.012, .004, .010) * pow(fbm3(d * 2.2 + 7. + uSeed), 3.) + vec3(.002, .006, .012) * pow(fbm3(d * 1.7 - 3. - uSeed), 3.);
    // seen from deep in the well, incoming light is blueshifted and brighter
    float k = clamp(blue, 1., 40.);
    col *= vec3(pow(k, 1.2), pow(k, 1.7), pow(k, 2.4));
    return col;
  }

  // ---- the accretion disk, where the light crosses the plane y = 0 ----
  vec4 disk(vec3 p, vec3 dir, float rObs){
    float r = length(p.xz);
    if (r < ${D.inner.toFixed(2)} || r > ${D.outer.toFixed(2)}) return vec4(0.);
    float om = .7071 / pow(r, 1.5);                                   // Kepler, in time units of the horizon light-crossing
    // two flow phases cross-faded, so the differential rotation never winds the texture too tight
    float P = 60., a = fract(uDiskT / P), b = fract(uDiskT / P + .5), wa = 1. - abs(a * 2. - 1.);
    vec2 pa = p.xz * mat2(cos(om * a * P * 1.2), -sin(om * a * P * 1.2), sin(om * a * P * 1.2), cos(om * a * P * 1.2));
    vec2 pb = p.xz * mat2(cos(om * b * P * 1.2), -sin(om * b * P * 1.2), sin(om * b * P * 1.2), cos(om * b * P * 1.2));
    float na = fbm2(pa * 1.1 + uSeed) * .75 + .25 * fbm2(vec2(r * 2.2, 0.) + pa * .3);
    float nb = fbm2(pb * 1.1 + uSeed + 11.) * .75 + .25 * fbm2(vec2(r * 2.2, 5.) + pb * .3);
    float n = mix(nb, na, wa);
    float edge = smoothstep(${D.inner.toFixed(2)}, ${(D.inner + 0.6).toFixed(2)}, r) * (1. - smoothstep(${(D.outer * 0.55).toFixed(2)}, ${D.outer.toFixed(2)}, r));
    float dens = edge * smoothstep(.25, .75, n) * (.35 + .65 * smoothstep(.3, .9, n));
    // emission: hotter inside; Doppler-boosted on the side coming towards you, gravitationally reddened deep down
    float x = ${D.inner.toFixed(2)} / r;
    float I = pow(x, 3.) * max(1. - sqrt(x), 0.) * 9.;
    float v = sqrt(.5 / (r - 1.));
    vec3 vdir = normalize(vec3(-p.z, 0., p.x));
    float gam = 1. / sqrt(1. - v * v);
    float dop = 1. / (gam * (1. - v * dot(vdir, -dir)));
    float g = dop * sqrt(1. - 1. / r) / sqrt(1. - 1. / rObs);
    vec3 col = blackbody(uDiskTemp * pow(x, .75) * g) * uTint;
    return vec4(col * I * pow(g, 4.) * uDiskGain * (.5 + n), clamp(dens * 1.4, 0., .96));
  }

  void main(){
    pxAngle = 2. * uTan / uRes.y;
    vec2 q = (vUv * 2. - 1.) * vec2(uTan * uRes.x / uRes.y, uTan);
    vec3 d = normalize(uFwd + q.x * uRight + q.y * uUp);

    float r0 = length(uPos);
    vec3 e1 = uPos / r0;
    float ca = dot(d, e1);
    vec3 e2 = d - ca * e1; float sa = length(e2);
    float blue = 1. / sqrt(max(1. - 1. / r0, 1e-6));
    vec3 col = vec3(0.); float T = 1.;

    if (sa < 1e-5){                                                  // straight out or straight in
      if (ca > 0.) col = sky(e1, blue);
    } else {
      e2 /= sa;
      // Binet: u = 1/r as a function of the angle phi swept in the ray's plane; u'' = -u + 1.5 u^2
      float u = 1. / r0;
      float b2 = (r0 * r0 * sa * sa) / (1. - 1. / r0);                // impact parameter squared
      float w = sqrt(max(1. / b2 - u * u * (1. - u), 0.)) * (ca > 0. ? -1. : 1.);
      float phi = 0.;
      vec3 prev = uPos;
      for (int i = 0; i < ${STEPS}; i++){
        float h = clamp(.3 * u / (abs(w) + u), .0015, .05);
        // RK4
        float k1u = w,               k1w = -u + 1.5 * u * u;
        float u2 = u + .5 * h * k1u, w2 = w + .5 * h * k1w;
        float k2u = w2,              k2w = -u2 + 1.5 * u2 * u2;
        float u3 = u + .5 * h * k2u, w3 = w + .5 * h * k2w;
        float k3u = w3,              k3w = -u3 + 1.5 * u3 * u3;
        float u4 = u + h * k3u,      w4 = w + h * k3w;
        float k4u = w4,              k4w = -u4 + 1.5 * u4 * u4;
        u += h * (k1u + 2. * k2u + 2. * k3u + k4u) / 6.;
        w += h * (k1w + 2. * k2w + 2. * k3w + k4w) / 6.;
        phi += h;
        if (u >= 1.) break;                                          // through the horizon
        float cp = cos(phi), sp = sin(phi);
        vec3 radial = cp * e1 + sp * e2;
        vec3 p = radial / max(u, 1e-4);
        if (prev.y * p.y < 0. && T > .02){                            // crossed the disk's plane
          float t = prev.y / (prev.y - p.y);
          vec3 c = mix(prev, p, t);
          vec3 tang = normalize((-sp * e1 + cp * e2) * u - radial * w);
          vec4 dk = disk(c, tang, r0);
          col += T * dk.rgb * dk.a; T *= 1. - dk.a;
        }
        prev = p;
        if (u < .008){                                                // far enough: the light came from the sky
          vec3 dir = normalize((-sp * e1 + cp * e2) * u - radial * w);
          col += T * sky(dir, blue);
          break;
        }
      }
    }
    col *= uFade;
    col = 1. - exp(-col * uExposure);
    col = pow(col, vec3(1. / 2.2));
    col += (h21(gl_FragCoord.xy + fract(uTime) * 13.) - .5) / 255.;
    gl_FragColor = vec4(col, 1.);
  }`;

/* ----------------------------------------------------------------------------
   Start
   ---------------------------------------------------------------------------- */
function start() {
  const canvas = document.getElementById('stage');
  const probe = document.createElement('canvas').getContext('webgl2');
  if (!probe) throw new Error('WebGL2 unavailable');
  probe.getExtension('WEBGL_lose_context')?.loseContext();

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false, powerPreference: 'high-performance' });
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
  const scene = new THREE.Scene(), camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const U = {
    uRes: { value: new THREE.Vector2(1, 1) }, uPos: { value: new THREE.Vector3() }, uFwd: { value: new THREE.Vector3() },
    uRight: { value: new THREE.Vector3() }, uUp: { value: new THREE.Vector3() }, uTan: { value: Math.tan(CONFIG.look.fov * DEG / 2) },
    uTime: { value: 0 }, uSeed: { value: 0 }, uExposure: { value: CONFIG.exposure }, uFade: { value: 0 },
    uDiskT: { value: 0 }, uDiskTemp: { value: 7 }, uDiskGain: { value: 1 }, uTint: { value: new THREE.Vector3(1, 1, 1) },
  };
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({ uniforms: U, vertexShader: VERT, fragmentShader: FRAG, depthTest: false, depthWrite: false }));
  quad.frustumCulled = false; scene.add(quad);

  /* ---- size & quality ---- */
  const Q = CONFIG.quality;
  let qualityLevel = 0;
  const size = new THREE.Vector2();
  function resize() {
    const cap = MOBILE ? Q.maxDpr.mobile : Q.maxDpr.desktop, base = MOBILE ? Q.scale.mobile : Q.scale.desktop;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, cap) * base * Q.ladder[qualityLevel]);
    renderer.setSize(window.innerWidth, window.innerHeight, false);
    renderer.getDrawingBufferSize(size); U.uRes.value.copy(size);
  }
  function setQuality(level) { qualityLevel = clamp(level, 0, Q.ladder.length - 1); resize(); }

  /* ---- each fall: a new hole, a new disk, a new angle ---- */
  const F = CONFIG.fall, L = CONFIG.look;
  const fixedR = params.has('r') ? Math.max(1.0005, parseFloat(params.get('r')) || 10) : null;
  let x, inc, az, falls = 0;
  function newFall() {
    const rng = mulberry32(SEED + 7919 * falls++);
    x = Math.log((fixedR ?? F.start) - 1);
    inc = (5 + 10 * rng()) * DEG * (rng() < 0.5 ? 1 : -1);
    az = rng() * Math.PI * 2;
    U.uSeed.value = rng() * 100;
    U.uDiskTemp.value = 3.6 + 3 * rng();                            // thousands of kelvin at the inner edge
    const warm = rng() < 0.5;
    U.uTint.value.set(warm ? 1.0 : 0.9, warm ? 0.86 : 0.95, warm ? 0.72 : 1.0);
    U.uDiskGain.value = 0.9 + 0.4 * rng();
  }
  newFall();

  /* ---- input: one control, held ---- */
  const held = { key: false, pointers: new Set() };
  const holding = () => held.key || held.pointers.size > 0;
  let everHeld = false;
  const onPress = () => { if (!everHeld) { everHeld = true; ui.showHint(false); } ui.message(null); };
  window.addEventListener('keydown', (e) => {
    if (e.code !== 'Space' || (e.target && e.target.closest && e.target.closest('a, button'))) return;
    e.preventDefault();
    if (!e.repeat) { held.key = true; onPress(); }
  });
  window.addEventListener('keyup', (e) => { if (e.code === 'Space') { e.preventDefault(); held.key = false; } });
  window.addEventListener('blur', () => { held.key = false; held.pointers.clear(); });
  window.addEventListener('pointerdown', (e) => {
    if (ui.isUiTarget(e) || (e.pointerType === 'mouse' && e.button !== 0)) return;
    if (e.pointerType === 'mouse') e.preventDefault();
    try { e.target.setPointerCapture(e.pointerId); } catch {}
    held.pointers.add(e.pointerId); onPress();
  });
  for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) window.addEventListener(ev, (e) => { held.pointers.delete(e.pointerId); });
  window.addEventListener('contextmenu', (e) => { if (!ui.isUiTarget(e) && held.pointers.size) e.preventDefault(); });
  const look = { x: 0, y: 0, tx: 0, ty: 0 };
  if (!REDUCED) window.addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'mouse') return;
    look.tx = (e.clientX / window.innerWidth) * 2 - 1; look.ty = (e.clientY / window.innerHeight) * 2 - 1;
  });
  ui.hint(MOBILE ? 'press and hold' : 'hold space');

  /* ---- readouts ---- */
  const fmtKm = (km) => km >= 100 ? `${Math.round(km).toLocaleString('en-US')} km` : km >= 1 ? `${km.toFixed(1)} km` : `${Math.max(1, Math.round(km * 1000))} m`;
  const fmtRatio = (k) => k < 10 ? k.toFixed(2) : k < 100 ? k.toFixed(1) : Math.round(k).toString();
  function readout(r) {
    const k = 1 / Math.sqrt(1 - 1 / r);
    return `${fmtKm((r - 1) * F.horizonKm)} above the horizon · your time runs ${fmtRatio(k)}× slower than home`;
  }

  /* ---- loop ---- */
  let speed = F.drift, wasHolding = false, wall = 0, last = 0, raf = 0, running = false, hinted = false;
  let ending = 0;                                                    // seconds since the horizon (0 = still falling)
  const still = REDUCED || params.has('still');
  const pos = new THREE.Vector3(), fwd = new THREE.Vector3(), right = new THREE.Vector3(), up = new THREE.Vector3();
  const Y = new THREE.Vector3(0, 1, 0), axis = new THREE.Vector3(), tmpQ = new THREE.Quaternion();
  const perf = { frames: 0, since: 0, fps: 60, graceUntil: 0, samples: [] };

  function update(dt) {
    const h = holding();
    const ts = REDUCED ? CONFIG.reducedMotion.timeScale : 1;
    // the fall
    if (!ending && fixedR === null) {
      const target = h ? F.held : F.drift;
      speed += (target - speed) * (1 - Math.exp(-dt / F.ease));
      x -= speed * dt * ts;
      if (x <= Math.log(F.end - 1)) { ending = 1e-6; ui.message('past the horizon', { duration: CONFIG.ending.fade + CONFIG.ending.dark }); }
    }
    if (wasHolding && !h && !ending) ui.message(readout(1 + Math.exp(x)), { duration: CONFIG.message.show });
    wasHolding = h;

    // fade in at the start, out at the horizon
    if (ending) {
      ending += dt;
      U.uFade.value = clamp(1 - ending / CONFIG.ending.fade, 0, 1);
      if (ending > CONFIG.ending.fade + CONFIG.ending.dark) { ending = 0; newFall(); }
    } else U.uFade.value = Math.min(1, U.uFade.value + dt / 2.5);

    // where you are, and where you look
    const r = 1 + Math.exp(x);
    if (!still) az += L.orbit * dt * ts * (1 + 6 / r);
    pos.set(Math.sin(az) * Math.cos(inc), Math.sin(inc), Math.cos(az) * Math.cos(inc)).multiplyScalar(r);
    const k = 1 - Math.exp(-dt / L.inertia);
    look.x += (look.tx - look.x) * k; look.y += (look.ty - look.y) * k;
    fwd.copy(pos).normalize().negate();                              // towards the hole...
    axis.crossVectors(fwd, Y).normalize();
    const turn = smooth(L.turnFrom, L.turnTo, r) * Math.PI;          // ...turning up and over to look away from it
    fwd.applyQuaternion(tmpQ.setFromAxisAngle(axis, turn));
    const sway = still ? 0 : 0.6 * Math.sin(wall * 0.07);
    fwd.applyAxisAngle(Y, (-look.x * L.cursor[0] + sway) * DEG);
    right.crossVectors(fwd, Y).normalize();
    if (right.lengthSq() < 1e-6) right.set(1, 0, 0);
    fwd.applyAxisAngle(right, (-look.y * L.cursor[1]) * DEG);
    up.crossVectors(right, fwd).normalize();
    U.uPos.value.copy(pos); U.uFwd.value.copy(fwd); U.uRight.value.copy(right); U.uUp.value.copy(up);
    U.uDiskT.value += dt * ts * 3;
    U.uTime.value = wall;
  }
  function render() { renderer.render(scene, camera); }

  function tick(now) {
    raf = requestAnimationFrame(tick);
    const dt = Math.min((now - last) / 1000, 0.05); last = now;
    if (dt <= 0) return;
    wall += dt;
    update(dt); render();
    if (!everHeld && !hinted && wall > CONFIG.hintAfter) { hinted = true; ui.showHint(true); }
    perf.frames++;
    if (now - perf.since >= 1000) {
      perf.fps = (perf.frames * 1000) / (now - perf.since); perf.frames = 0; perf.since = now;
      if (params.has('fps')) perf.samples.push(+perf.fps.toFixed(1));
      if (!params.has('q') && now > perf.graceUntil && perf.fps < Q.minFps && qualityLevel < Q.ladder.length - 1) { setQuality(qualityLevel + 1); perf.graceUntil = now + 2000; }
    }
  }
  function play() { if (running) return; running = true; last = performance.now(); perf.since = last; perf.frames = 0; perf.graceUntil = last + 2500; raf = requestAnimationFrame(tick); }
  function stop() { running = false; cancelAnimationFrame(raf); }
  document.addEventListener('visibilitychange', () => { if (document.hidden) { held.key = false; held.pointers.clear(); stop(); } else play(); });
  window.addEventListener('resize', () => { resize(); if (!running) { update(0.016); render(); } });
  canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); stop(); fallback(); });

  window.__fallingIn = { config: CONFIG, samples: perf.samples, get r() { return 1 + Math.exp(x); }, set r(v) { x = Math.log(Math.max(v, 1.0001) - 1); }, get fps() { return perf.fps; }, get quality() { return qualityLevel; } };

  if (params.has('q')) qualityLevel = clamp(parseInt(params.get('q'), 10) || 0, 0, Q.ladder.length - 1);
  resize();
  if (params.has('r')) U.uFade.value = 1;
  update(0.016); render();
  document.body.classList.add('live');
  if (!document.hidden) play();
}

/* ---- go ---- */
try {
  if (params.has('nowebgl')) throw new Error('WebGL disabled by flag');
  start();
} catch (err) {
  console.warn('[falling in] falling back:', err);
  fallback();
}
