/* ============================================================================
   AURORA
   Night on a frozen world. Curtains of aurora hang over far mountains and a
   frozen lake that mirrors them. Hold space (or the mouse, or a finger) to
   strengthen the solar wind: the curtains brighten, climb, spread overhead and
   fringe with red above and violet below. Let go and the storm subsides.

   The whole picture is one fragment shader: the curtains are sheets of light
   marched through altitude layers, each layer reading the same footprint on
   the ground plane, which is what makes them hang vertically.

   Debug query flags (for testing only):
     ?storm=0.8   lock the storm level in [0,1]     ?t=120     start at time t
     ?seed=42     fix the landscape                 ?still     no idle drift
     ?reduced     force reduced-motion              ?nowebgl   force the fallback
     ?fps         record frame rate in window.__aurora.samples
   ============================================================================ */
import * as THREE from 'three';
import { mountUI } from '../ui/ui.js';

const ui = mountUI({ id: 'aurora' });

/* ----------------------------------------------------------------------------
   CONFIG: every tunable in one place.
   ---------------------------------------------------------------------------- */
const CONFIG = {
  storm: {
    quiet: 0.16,          // level with nobody holding: a faint green arc low in the north
    rise: 2.2,            // seconds (time constant) to build while holding
    fall: 6.0,            // seconds (time constant) to settle after letting go
    breathe: 0.06,        // slow natural pulsing of the quiet level
    timeBoost: 0.8,       // the curtains move this much faster at full storm (kept low: fast flicker is hard on the eyes)
  },
  camera: {
    fov: 72,              // vertical, degrees
    pitch: 11,            // degrees above the horizon at rest
    look: [7, 4],         // max cursor look (yaw, pitch), degrees
    lookInertia: 1.1,     // seconds (time constant)
    drift: [1.2, 0.5],    // idle sway (yaw, pitch), degrees
  },
  exposure: 2.0,
  message: { minKp: 5, show: 5.5 },   // after a storm at least this strong, say how strong it was
  hintAfter: 2.0,                     // seconds before "hold space" appears
  hintAgain: 25,                      // seconds without holding before the hint comes back
  quality: {
    steps: { desktop: 64, mobile: 32 },          // altitude layers marched per pixel
    scale: { desktop: 1.0, mobile: 0.8 },        // render resolution vs. the screen
    maxDpr: { desktop: 2.0, mobile: 1.5 },
    field: { desktop: [2048, 1024], mobile: [1024, 512] },   // texture holding the curtains' footprint
    ladder: [1.0, 0.85, 0.72, 0.6, 0.5],         // render scale steps, taken when fps < minFps
    minFps: 48,
  },
  reducedMotion: { timeScale: 0.35 },
};

/* ---------------------------------------------------------------------------- */
const params = new URLSearchParams(location.search);
const REDUCED = params.has('reduced') || matchMedia('(prefers-reduced-motion: reduce)').matches;
const MOBILE = matchMedia('(pointer: coarse)').matches || Math.min(screen.width, screen.height) < 600;
const SEED = params.has('seed') ? (parseInt(params.get('seed'), 10) | 0) : (Math.random() * 1000) | 0;
const DEG = Math.PI / 180;
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const mix = (a, b, t) => a + (b - a) * t;

function fallback() {
  document.body.classList.remove('live');
  document.body.classList.add('fallback');
  ui.showHint(false).message(null);
}

/* ----------------------------------------------------------------------------
   The shader
   ---------------------------------------------------------------------------- */
const STEPS = MOBILE ? CONFIG.quality.steps.mobile : CONFIG.quality.steps.desktop;

const VERT = /* glsl */`
  varying vec2 vUv;
  void main(){ vUv = position.xy * .5 + .5; gl_Position = vec4(position.xy, 0., 1.); }`;

const NOISE = /* glsl */`
  float h11(float p){ p = fract(p * .1031); p *= p + 33.33; p *= p + p; return fract(p); }
  float h21(vec2 p){ vec3 q = fract(vec3(p.xyx) * .1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
  float n1(float x){ float i = floor(x), f = fract(x); f = f * f * (3. - 2. * f); return mix(h11(i), h11(i + 1.), f); }
  float n2(vec2 p){
    vec2 i = floor(p), f = fract(p); f = f * f * (3. - 2. * f);
    return mix(mix(h21(i), h21(i + vec2(1., 0.)), f.x), mix(h21(i + vec2(0., 1.)), h21(i + vec2(1., 1.)), f.x), f.y);
  }
  float fbm1(float x){ float s = 0., a = .5; for (int i = 0; i < 5; i++){ s += a * n1(x); x = x * 2.07 + 1.7; a *= .5; } return s / .96875; }
  float fbm2(vec2 p){ float s = 0., a = .5; for (int i = 0; i < 5; i++){ s += a * n2(p); p = p * 2.03 + vec2(1.7, 9.2); a *= .5; } return s / .96875; }`;

// The curtains' footprint on the ground plane (north is -z), drawn once per frame into a texture.
// The sky pass then only looks it up, so it can afford many altitude layers at full resolution.
const FIELD = { min: [-90, -90], max: [90, 24] };
const FIELD_FRAG = /* glsl */`
  precision highp float;
  varying vec2 vUv;
  uniform float uTime, uStorm, uSeed;
  ${NOISE}
  void main(){
    vec2 q = mix(vec2(${FIELD.min[0]}., ${FIELD.min[1]}.), vec2(${FIELD.max[0]}., ${FIELD.max[1]}.), vUv);
    float t = uTime, s = uStorm, acc = 0.;
    for (int k = 0; k < 3; k++){
      float fk = float(k), x = q.x;
      float z0 = -(8. + fk * 4.2) + s * (6.5 - fk * 1.2);           // quiet: low in the north; a storm brings them overhead
      float path = z0 + 1.9 * sin(x * .085 + t * .05 + fk * 2.1) + .8 * sin(x * .21 - t * .085 + fk * 4.)
                 + 3.2 * (fbm1(x * .045 + t * .016 + fk * 13. + uSeed) - .5) * (1. + 1.4 * s)
                 + .25 * sin(x * .9 + t * .25 + fk * 3.) * s;           // small fast kinks when it is active
      float d = q.y - path, w = .12 + .15 * s;
      float band = exp(-d * d / (w * w));
      band += .15 * exp(-d * d / (w * w * 9.));                        // a soft skirt around the bright sheet
      // rays: fine vertical structure at three scales, drifting along the arc and pulsing
      float r1 = n1(x * 1.3 + t * .12 + fk * 31.), r2 = n1(x * 4.1 - t * .22 + fk * 7.), r3 = n1(x * 11. + t * .3 + fk * 3.);
      float rays = .12 + .88 * pow(r1, 2.) * (.4 + .6 * r2) * (.65 + .35 * r3);
      float pulse = .88 + .12 * sin(x * .35 - t * (.45 + .35 * s) + fk * 2.);   // slow: no flashing
      float alive = smoothstep(.2, .65, n1(x * .05 + fk * 7. - t * .028 + uSeed) + s * .55);
      acc += band * rays * pulse * alive * (1. - fk * .25);
    }
    gl_FragColor = vec4(acc, 0., 0., 1.);
  }`;

const FRAG = /* glsl */`
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D tField;
  uniform vec2 uRes;
  uniform float uTime, uStorm, uYaw, uPitch, uTan, uSeed, uExposure;
  uniform vec3 uGlow;
  ${NOISE}

  float pxAngle;   // the angle one pixel spans: keeps stars and edges one pixel sharp at any resolution

  vec3 viewRay(vec2 uv){
    vec2 q = (uv * 2. - 1.) * vec2(uTan * uRes.x / uRes.y, uTan);
    vec3 rd = normalize(vec3(q, -1.));
    float cp = cos(uPitch), sp = sin(uPitch);
    rd = vec3(rd.x, cp * rd.y - sp * rd.z, sp * rd.y + cp * rd.z);      // tilt up
    float cy = cos(uYaw), sy = sin(uYaw);
    return vec3(cy * rd.x - sy * rd.z, rd.y, sy * rd.x + cy * rd.z);
  }

  // ---- the aurora: march up through the curtain, reading the footprint at each altitude ----
  float field(vec2 q){
    vec2 uv = (q - vec2(${FIELD.min[0]}., ${FIELD.min[1]}.)) / vec2(${FIELD.max[0] - FIELD.min[0]}., ${FIELD.max[1] - FIELD.min[1]}.);
    if (uv.x < 0. || uv.y < 0. || uv.x > 1. || uv.y > 1.) return 0.;
    return texture2D(tField, uv).r;
  }
  vec3 aurora(vec3 rd, float t, float s){
    if (rd.y <= .004) return vec3(0.);
    vec3 acc = vec3(0.);
    float jit = h21(gl_FragCoord.xy + fract(t * 7.) * 91.);
    float top = 1.1 + 2.2 * s;                                           // curtains climb higher in a storm
    vec2 base = rd.xz / rd.y * .9;
    float fade = exp(-length(base) * .02);
    if (fade < .002) return vec3(0.);
    for (int i = 0; i < ${STEPS}; i++){
      float a = (float(i) + jit) / ${STEPS}.;                            // 0 = lower edge, 1 = top of the curtain
      float c = field(base * (1. + a * top));
      if (c < .001) continue;
      float prof = smoothstep(0., .03, a) * (exp(-a * 2.6 / (.45 + s)) + .6 * exp(-a * 40.));   // bright lower hem, long soft top
      vec3 col = mix(vec3(.10, 1., .40), vec3(.9, .14, .32), smoothstep(.45, .95, a) * (.25 + .55 * s));
      col = mix(col, vec3(.58, .22, 1.), s * s * (1. - smoothstep(0., .1, a)));      // violet hem in a strong storm
      acc += col * c * prof;
    }
    return acc / ${STEPS}. * (.9 + 2.6 * s) * fade;
  }

  // ---- the sky behind it ----
  vec3 stars(vec3 rd, float t){
    vec3 col = vec3(0.);
    vec2 sp = vec2(atan(rd.x, -rd.z), asin(clamp(rd.y, -1., 1.)));
    for (int l = 0; l < 3; l++){
      float fl = float(l);
      float dens = fl == 0. ? 120. : fl == 1. ? 60. : 26.;
      float thr = .978;
      vec2 g = vec2(sp.x * cos(sp.y), sp.y) * dens, id = floor(g), f = fract(g) - .5;   // cos(lat): even spacing up high
      float r = h21(id + uSeed * 1.3 + fl * 17.);
      if (r > thr){
        vec2 o = (vec2(h21(id + 3.1), h21(id + 7.7)) - .5) * .4;
        float d = length(f - o) / dens;                                // in radians
        float m = (r - thr) / (1. - thr), w = pxAngle * (.75 + .35 * m * fl);
        float tw = .65 + .35 * sin(t * (1.5 + 4. * h21(id + 5.)) + r * 80.);
        vec3 c = mix(vec3(1., .80, .62), vec3(.70, .82, 1.), h21(id + 1.3));
        col += c * exp(-d * d / (w * w)) * m * m * (fl == 0. ? .16 : fl == 1. ? .4 : 1.1) * tw;
      }
    }
    return col;
  }
  vec3 sky(vec3 rd, float t){
    float e = max(rd.y, 0.);
    vec3 col = mix(vec3(.0012, .0018, .0045), vec3(.0002, .0003, .0011), smoothstep(0., .7, e));
    col += vec3(.002, .0045, .003) * exp(-e * 16.);                       // faint airglow on the horizon
    vec3 mwN = normalize(vec3(.55, .62, .56));                            // the Milky Way: dust and starlight
    float b = dot(rd, mwN);
    vec2 sp = vec2(atan(rd.x, -rd.z), asin(clamp(rd.y, -1., 1.)));
    col += vec3(.0035, .0038, .0055) * exp(-b * b * 22.) * (.5 + fbm2(sp * 7. + uSeed)) * (1. - .35 * smoothstep(.55, .75, fbm2(sp * 14. - uSeed)));
    col += stars(rd, t) * smoothstep(-.005, .06, rd.y);
    return col;
  }

  // ---- the land ----
  float ridge(float az){ return .01 + .16 * pow(fbm1(az * 1.9 + uSeed * .37), 2.4) + .018 * fbm1(az * 9. + uSeed) * fbm1(az * 3. + 2.); }
  float shore(float az){ return -.2 - .07 * fbm1(az * 3.1 + 5. + uSeed) - .03 * fbm1(az * 13.); }

  vec3 mountain(float az, float el, float r){
    float depth = clamp((r - el) / max(r, 1e-3), 0., 1.);
    float snow = smoothstep(.45, .7, fbm2(vec2(az * 26., el * 40.) + uSeed)) * (1. - depth);
    return vec3(.0005, .0007, .0014) + uGlow * (.002 + .03 * snow);
  }
  // Everything above the lake: sky, aurora, and the mountains in front of them (edges one pixel soft).
  vec3 above(vec3 rd, float t, float s){
    float az = atan(rd.x, -rd.z), el = asin(clamp(rd.y, -1., 1.)), r = ridge(az);
    float m = smoothstep(-pxAngle, pxAngle, r - el);
    vec3 col = m < 1. ? sky(rd, t) + aurora(rd, t, s) : vec3(0.);
    return mix(col, mountain(az, el, r), m);
  }
  vec3 lake(vec3 rd, float az, float t, float s){
    // a dark mirror, crazed with frost; the further away, the more it reflects
    float frost = fbm2(vec2(az * 30., -1. / min(rd.y, -.002) * .8) + uSeed);
    vec3 rr = vec3(rd.x, -rd.y + (frost - .5) * .01, rd.z);
    float fres = .3 + .5 * pow(1. - clamp(-rd.y * 3., 0., 1.), 3.);
    return above(normalize(rr), t, s) * fres * (.8 + .35 * frost) + uGlow * .004 * frost + vec3(.0006, .0009, .0018) * frost;
  }
  vec3 bank(float az, float el, float t){
    // the snowy bank in front: barely there, catching the aurora's light
    float n = fbm2(vec2(az * 18., el * 26.) + uSeed), fine = n2(vec2(az, el) * 420.);
    float spark = step(.9994, h21(floor(gl_FragCoord.xy) + floor(t * 3.)));
    return vec3(.0012, .0015, .003) * (.6 + .8 * n) + uGlow * (.008 + .014 * n + .004 * fine) + uGlow * spark * .25;
  }

  void main(){
    pxAngle = 2. * uTan / uRes.y;
    vec3 rd = viewRay(vUv);
    float t = uTime, s = uStorm;
    float az = atan(rd.x, -rd.z), el = asin(clamp(rd.y, -1., 1.));
    vec3 col;
    if (el >= pxAngle) col = above(rd, t, s);
    else {
      float sh = shore(az), bk = smoothstep(-pxAngle, pxAngle, sh - el);
      col = bk < 1. ? lake(rd, az, t, s) : vec3(0.);
      if (bk > 0.) col = mix(col, bank(az, el, t), bk);
      if (el > -pxAngle) col = mix(col, above(rd, t, s), smoothstep(-pxAngle, pxAngle, el));     // the waterline
    }
    col = 1. - exp(-col * uExposure);                                     // soft shoulder, never clips
    col = pow(col, vec3(1. / 2.2));
    col += (h21(gl_FragCoord.xy + fract(t) * 13.) - .5) / 255.;           // dither: no banding in the dark gradients
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
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;   // the shader does its own tone curve and gamma
  const scene = new THREE.Scene(), camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const U = {
    uRes: { value: new THREE.Vector2(1, 1) }, uTime: { value: 0 }, uStorm: { value: CONFIG.storm.quiet },
    uYaw: { value: 0 }, uPitch: { value: CONFIG.camera.pitch * DEG }, uTan: { value: Math.tan(CONFIG.camera.fov * DEG / 2) },
    uSeed: { value: (SEED % 1000) * 0.137 }, uExposure: { value: CONFIG.exposure }, uGlow: { value: new THREE.Vector3() },
  };
  const FS = MOBILE ? CONFIG.quality.field.mobile : CONFIG.quality.field.desktop;
  const fieldRT = new THREE.WebGLRenderTarget(FS[0], FS[1], { type: THREE.HalfFloatType, format: THREE.RedFormat, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false, generateMipmaps: false });
  U.tField = { value: fieldRT.texture };
  const geo = new THREE.PlaneGeometry(2, 2);
  const quad = new THREE.Mesh(geo, new THREE.ShaderMaterial({ uniforms: U, vertexShader: VERT, fragmentShader: FRAG, depthTest: false, depthWrite: false }));
  quad.frustumCulled = false; scene.add(quad);
  const fieldScene = new THREE.Scene();
  const fieldQuad = new THREE.Mesh(geo, new THREE.ShaderMaterial({ uniforms: { uTime: U.uTime, uStorm: U.uStorm, uSeed: U.uSeed }, vertexShader: VERT, fragmentShader: FIELD_FRAG, depthTest: false, depthWrite: false }));
  fieldQuad.frustumCulled = false; fieldScene.add(fieldQuad);

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

  /* ---- input: one control, held ---- */
  const held = { key: false, pointers: new Set() };
  const holding = () => held.key || held.pointers.size > 0;
  let everHeld = false;
  let lastHeld = 0;
  const onPress = () => { everHeld = true; hinted = false; ui.showHint(false); ui.message(null); };
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

  /* ---- loop ---- */
  const S = CONFIG.storm, C = CONFIG.camera;
  const lockedStorm = params.has('storm') ? clamp(parseFloat(params.get('storm')) || 0, 0, 1) : null;
  let storm = lockedStorm ?? S.quiet, peak = 0, wasHolding = false;
  let T = params.has('t') ? parseFloat(params.get('t')) || 0 : 40 + Math.random() * 400;   // a different sky each visit
  let wall = 0, last = 0, raf = 0, running = false, hinted = false;
  const still = REDUCED || params.has('still');
  const green = new THREE.Vector3(0.10, 1.0, 0.40), red = new THREE.Vector3(1.0, 0.2, 0.35);
  const perf = { frames: 0, since: 0, fps: 60, graceUntil: 0, samples: [] };

  function update(dt) {
    const h = holding();
    if (lockedStorm === null) {
      const quiet = S.quiet + S.breathe * (0.5 + 0.5 * Math.sin(wall * 0.21) * Math.sin(wall * 0.067 + 1.3));
      const target = h ? 1 : quiet, tc = h ? S.rise : S.fall;
      storm += (target - storm) * (1 - Math.exp(-dt / tc));
    }
    if (h) peak = Math.max(peak, storm);
    if (wasHolding && !h) {
      const kp = Math.min(9, Math.round(1 + 8 * peak));
      if (kp >= CONFIG.message.minKp) ui.message(`kp ${kp} · ${kp >= 8 ? 'severe' : kp >= 7 ? 'strong' : 'moderate'} geomagnetic storm`, { duration: CONFIG.message.show });
      peak = 0;
    }
    wasHolding = h;
    const speed = (REDUCED ? CONFIG.reducedMotion.timeScale : 1) * (1 + S.timeBoost * storm * storm);
    T += dt * speed;

    const k = 1 - Math.exp(-dt / C.lookInertia);
    look.x += (look.tx - look.x) * k; look.y += (look.ty - look.y) * k;
    const swayYaw = still ? 0 : C.drift[0] * Math.sin(wall * 0.05), swayPitch = still ? 0 : C.drift[1] * Math.sin(wall * 0.071 + 1);
    U.uYaw.value = (look.x * C.look[0] + swayYaw) * DEG;
    U.uPitch.value = (C.pitch - look.y * C.look[1] + swayPitch) * DEG;
    U.uTime.value = T; U.uStorm.value = storm;
    U.uGlow.value.copy(green).lerp(red, 0.25 * storm * storm).multiplyScalar(0.06 + 0.6 * storm);
  }
  function render() {
    renderer.setRenderTarget(fieldRT); renderer.render(fieldScene, camera);
    renderer.setRenderTarget(null); renderer.render(scene, camera);
  }

  function tick(now) {
    raf = requestAnimationFrame(tick);
    const dt = Math.min((now - last) / 1000, 0.05); last = now;
    if (dt <= 0) return;
    wall += dt;
    update(dt); render();
    if (!everHeld && !hinted && wall > CONFIG.hintAfter) { hinted = true; ui.showHint(true); }
    // if nobody has held for a while, remind them how
    if (holding()) lastHeld = wall;
    else if (everHeld && !hinted && wall - lastHeld > CONFIG.hintAgain) { hinted = true; ui.showHint(true); }
    perf.frames++;
    if (now - perf.since >= 1000) {
      perf.fps = (perf.frames * 1000) / (now - perf.since); perf.frames = 0; perf.since = now;
      if (params.has('fps')) perf.samples.push(+perf.fps.toFixed(1));
      if (now > perf.graceUntil && perf.fps < Q.minFps && qualityLevel < Q.ladder.length - 1) { setQuality(qualityLevel + 1); perf.graceUntil = now + 2000; }
    }
  }
  function play() { if (running) return; running = true; last = performance.now(); perf.since = last; perf.frames = 0; perf.graceUntil = last + 2500; raf = requestAnimationFrame(tick); }
  function stop() { running = false; cancelAnimationFrame(raf); }
  document.addEventListener('visibilitychange', () => { if (document.hidden) { held.key = false; held.pointers.clear(); stop(); } else play(); });
  window.addEventListener('resize', () => { resize(); if (!running) { update(0.016); render(); } });
  canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); stop(); fallback(); });

  window.__aurora = { config: CONFIG, seed: SEED, samples: perf.samples, get storm() { return storm; }, set storm(v) { storm = v; }, get fps() { return perf.fps; }, get quality() { return qualityLevel; } };

  resize();
  update(0.016); render();
  document.body.classList.add('live');
  if (!document.hidden) play();
}

/* ---- go ---- */
try {
  if (params.has('nowebgl')) throw new Error('WebGL disabled by flag');
  start();
} catch (err) {
  console.warn('[aurora] falling back:', err);
  fallback();
}
