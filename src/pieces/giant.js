/* ============================================================================
   GIANT
   A gas giant drifts in front of you, close enough to fill half the sky. Its
   winds run in bands, east and west, and tear into curls where they rub; a
   great storm turns in the south, small white ovals trail behind it. A ring
   cuts across, throwing its shadow on the clouds, and a small moon goes round.
   Hold space (or the mouse, or a finger) to speed up time: the bands slide, the
   storms turn, the moon's shadow crosses the face. Let go to see how long it was.

   Every visit picks one of three giants: warm and banded, pale gold, or ice blue.

   Debug query flags (for testing only):
     ?seed=42    fix the planet          ?t=3000   start at this planet time
     ?still      no idle drift           ?q=0      lock the quality level (0 = best)
     ?reduced    force reduced-motion    ?nowebgl  force the fallback
     ?fps        record frame rate in window.__giant.samples
   ============================================================================ */
import * as THREE from 'three';
import { mountUI } from '../ui/ui.js';

const ui = mountUI({ id: 'giant' });

/* ----------------------------------------------------------------------------
   CONFIG: every tunable in one place.
   ---------------------------------------------------------------------------- */
const CONFIG = {
  time: {
    idle: 1.5,             // planet time per second, untouched (a full turn of the planet is ~630)
    held: 60,              // ... and while holding
    rise: 1.2,             // seconds (time constant) to speed up
    fall: 1.6,             // seconds to slow down again
    hour: 62.8,            // planet time per hour (a day here lasts 10 hours), for the readout
  },
  camera: {
    fov: 42,               // vertical, degrees
    pos: [0.15, 0.16, 3.7],
    target: [-0.55, -0.02, 0],         // looking a little left of the planet puts it right of centre
    look: [5, 3],          // max cursor look (yaw, pitch), degrees
    inertia: 1.1,          // seconds
    drift: [0.8, 0.4],     // idle sway (yaw, pitch), degrees
  },
  planet: {
    tilt: [0.10, 0.36],    // radians: axis tipped towards you (so you see the rings from above), then sideways
    sun: [-1.0, 0.42, 0.55],           // direction towards the sun
    moon: { orbit: 2.75, radius: 0.07, rate: 0.0025, incline: 0.07 },
  },
  exposure: 1.3,
  message: { show: 5.5, minHours: 0.5 },
  hintAfter: 2.0,
  hintAgain: 25,
  quality: {
    scale: { desktop: 1.0, mobile: 0.75 },
    maxDpr: { desktop: 2.0, mobile: 1.5 },
    ladder: [1.0, 0.85, 0.72, 0.6, 0.5],
    minFps: 48,
  },
  reducedMotion: { timeScale: 0.4 },
};

// The three giants. Albedos are linear; the tone curve does the rest.
const PALETTES = [
  { // warm and banded
    zone: [0.80, 0.70, 0.55], belt: [0.42, 0.24, 0.13], accent: [0.72, 0.52, 0.34], storm: [0.72, 0.26, 0.12],
    ring: [0.70, 0.60, 0.48], ringOpacity: 0.55, atm: [0.45, 0.55, 0.85],
  },
  { // pale gold, heavy rings
    zone: [0.82, 0.74, 0.52], belt: [0.56, 0.43, 0.25], accent: [0.74, 0.62, 0.40], storm: [0.90, 0.84, 0.66],
    ring: [0.76, 0.68, 0.52], ringOpacity: 0.95, atm: [0.70, 0.62, 0.45],
  },
  { // ice blue, faint rings
    zone: [0.55, 0.74, 0.86], belt: [0.18, 0.34, 0.62], accent: [0.40, 0.60, 0.80], storm: [0.07, 0.12, 0.32],
    ring: [0.58, 0.64, 0.70], ringOpacity: 0.32, atm: [0.35, 0.60, 1.00],
  },
];

/* ---------------------------------------------------------------------------- */
const params = new URLSearchParams(location.search);
const REDUCED = params.has('reduced') || matchMedia('(prefers-reduced-motion: reduce)').matches;
const MOBILE = matchMedia('(pointer: coarse)').matches || Math.min(screen.width, screen.height) < 600;
const SEED = params.has('seed') ? (parseInt(params.get('seed'), 10) | 0) : (Math.random() * 1000) | 0;
const DEG = Math.PI / 180;
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
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
const VERT = /* glsl */`
  varying vec2 vUv;
  void main(){ vUv = position.xy * .5 + .5; gl_Position = vec4(position.xy, 0., 1.); }`;

const FRAG = /* glsl */`
  precision highp float;
  varying vec2 vUv;
  uniform vec2 uRes;
  uniform float uTan, uT, uWall, uSeed, uExposure, uFade, uMoonR, uRingOp, uStormLat, uStormLon;
  uniform vec3 uCam, uFwd, uRight, uUp, uSun, uMoon;
  uniform mat3 uToLocal;                 // world -> planet frame, y = spin axis
  uniform vec3 uZone, uBelt, uAccent, uStorm, uRingCol, uAtm;

  #define PI 3.14159265
  #define RIN 1.24
  #define ROUT 2.30

  float h11(float p){ p = fract(p * .1031); p *= p + 33.33; p *= p + p; return fract(p); }
  float h21(vec2 p){ vec3 q = fract(vec3(p.xyx) * .1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
  float h31(vec3 p){ p = fract(p * .1031); p += dot(p, p.zyx + 31.32); return fract((p.x + p.y) * p.z); }
  float n1(float x){ float i = floor(x), f = fract(x); f = f * f * (3. - 2. * f); return mix(h11(i), h11(i + 1.), f); }
  float n3(vec3 p){
    vec3 i = floor(p), f = fract(p); f = f * f * (3. - 2. * f);
    return mix(mix(mix(h31(i), h31(i + vec3(1,0,0)), f.x), mix(h31(i + vec3(0,1,0)), h31(i + vec3(1,1,0)), f.x), f.y),
               mix(mix(h31(i + vec3(0,0,1)), h31(i + vec3(1,0,1)), f.x), mix(h31(i + vec3(0,1,1)), h31(i + vec3(1,1,1)), f.x), f.y), f.z);
  }
  float fbm3(vec3 p){ float s = 0., a = .5; for (int i = 0; i < 5; i++){ s += a * n3(p); p = p * 2.03 + 1.7; a *= .5; } return s / .96875; }
  vec2 rot(vec2 v, float a){ float c = cos(a), s = sin(a); return vec2(c * v.x - s * v.y, s * v.x + c * v.y); }
  float wrapPi(float a){ return a - 2. * PI * floor((a + PI) / (2. * PI)); }

  float pxAngle;

  // ---- the stars behind ----
  vec3 sky(vec3 d){
    vec3 col = vec3(0.);
    for (int l = 0; l < 2; l++){
      float fl = float(l), dens = fl == 0. ? 120. : 45.;
      vec3 g = d * dens + uSeed * (fl + 1.), id = floor(g), f = fract(g) - .5;
      float r = h31(id);
      if (r > .985){
        vec3 o = (vec3(h31(id + 3.1), h31(id + 7.7), h31(id + 1.9)) - .5) * .4;
        vec3 e = f - o; e -= d * dot(e, d);
        float m = (r - .985) / .015, w = pxAngle * dens * (.8 + .3 * fl);
        vec3 c = mix(vec3(1., .8, .62), vec3(.72, .83, 1.), h31(id + 5.3));
        col += c * exp(-dot(e, e) / (w * w)) * m * m * (fl == 0. ? .14 : .7);
      }
    }
    col += vec3(.004, .003, .006) * pow(fbm3(d * 2. + uSeed), 3.);
    return col;
  }

  // ---- the rings: broad structure, a big gap, and ringlets faded out below the pixel size ----
  float ringDens(float r, float fw){
    if (r < RIN || r > ROUT) return 0.;
    float x = (r - RIN) / (ROUT - RIN);
    float d = smoothstep(0., .03, x) * (1. - smoothstep(.96, 1., x));
    float base = mix(.22, 1., smoothstep(.14, .24, x));                       // faint inner ring
    base *= 1. - .93 * (smoothstep(.60, .615, x) - smoothstep(.66, .675, x));  // the wide gap
    base *= mix(1., .68, smoothstep(.67, .7, x));                             // the outer ring, dimmer
    base *= 1. - .85 * (smoothstep(.885, .89, x) - smoothstep(.898, .903, x)); // a thin gap
    float a1 = 1. - smoothstep(.004, .03, fw), a2 = 1. - smoothstep(.0008, .006, fw);
    float fine = (n1(r * 70. + uSeed) - .5) * .7 * a1 + (n1(r * 380. + uSeed * 3.) - .5) * .45 * a2;
    return clamp(d * base * (.75 + fine), 0., 1.);
  }

  // ---- the clouds ----
  float wind(float lat){ return .55 * sin(lat * 7.5) + .25 * sin(lat * 17. + .6) + .1 * sin(lat * 31.); }

  // a vortex: the bands bend around it, its core turns. Returns how deep in the core we are.
  float vortex(inout float lon, inout float lat, vec2 c, vec2 rad, float spin, out float rr, out float ang){
    vec2 d = vec2(wrapPi(lon - c.x) * cos(c.y), lat - c.y) / rad;
    rr = length(d); ang = atan(d.y, d.x);
    if (rr > 3.) return 0.;
    float core = 1. - smoothstep(.55, 1.05, rr);
    vec2 e = rot(d, core * core * (1.1 + spin));
    e.y += d.y * exp(-rr * rr * .5) * .9 * (1. - core);               // the bands bulge around the oval
    e *= rad;
    lon = c.x + e.x / cos(c.y); lat = c.y + e.y;
    return core;
  }

  // the banded clouds at one moment of the winds
  vec3 bandsAt(float lonR, float lat){
    vec3 q = vec3(cos(lat) * cos(lonR), sin(lat), cos(lat) * sin(lonR));
    // turbulence, strongest where neighbouring bands shear past each other
    float shear = abs(cos(lat * 7.5)) * .7 + .3;
    float wp = fbm3(q * 3.2 + vec3(0., 0., uSeed)) - .5;
    float wp2 = fbm3(q * 9. + vec3(uSeed, 0., 0.) + wp) - .5;
    float lw = lat + (.085 * wp + .035 * wp2) * shear, lo = lonR + .12 * wp2 * shear;
    q = vec3(cos(lw) * cos(lo), sin(lw), cos(lw) * sin(lo));
    float streak = fbm3(vec3(q.x * 2.2, lw * 15., q.z * 2.2) + uSeed * .37);
    float band = .5 + .5 * sin(lw * 11. + 1.4 * sin(lw * 4.3 + uSeed));
    float fineB = n1(lw * 42. + uSeed);
    float v = band * .6 + fineB * .25 + (streak - .5) * .6;
    vec3 col = mix(uBelt, uZone, smoothstep(.3, .7, v));
    col = mix(col, uAccent, smoothstep(.55, .95, fineB) * .35);
    col *= .9 + .2 * fbm3(q * 7. + uSeed);                      // mottling
    col = mix(col, uBelt * .75, smoothstep(.95, 1.4, abs(lat)) * .55);   // poles: duller and darker
    return col;
  }

  vec3 clouds(vec3 n){
    float lat0 = asin(clamp(n.y, -1., 1.)), lon0 = atan(n.z, n.x);
    // The great storm drifts with its own band: work in that band's turning frame, so it never shears.
    float sLon = lon0 + (wind(uStormLat) * .9 + 1.) * uT * .01, lon = sLon, lat = lat0, sr, sa, or_, oa;
    float storm = vortex(lon, lat, vec2(uStormLon, uStormLat), vec2(.26, .14), 0., sr, sa);
    vec3 qs = vec3(cos(lat) * cos(lon), sin(lat), cos(lat) * sin(lon));
    float dLon = lon - sLon;
    // white ovals trailing behind it, each in its own band's frame
    float ovals = 0.;
    for (int i = 0; i < 4; i++){
      float fi = float(i);
      vec2 c = vec2(uStormLon + 1.0 + fi * 1.1 + .3 * h11(fi + uSeed), uStormLat + .21 + .04 * h11(fi * 3.1 + uSeed));
      float oLon = lon0 + dLon + (wind(c.y) * .9 + 1.) * uT * .01, l2 = oLon;
      ovals = max(ovals, vortex(l2, lat, c, vec2(.07, .05), 0., or_, oa));
      dLon += l2 - oLon;
    }
    // The bands: each latitude turns at its own speed. Two phases of that shear, cross-faded,
    // so the texture never winds up into thin threads however long time runs.
    const float PH = 250.;
    float ta = mod(uT, PH), tb = mod(uT + PH * .5, PH), wa = 1. - abs(2. * ta / PH - 1.);
    float base = lon0 + dLon + uT * .01, wl = wind(lat) * .009;
    vec3 col = mix(bandsAt(base + wl * tb, lat), bandsAt(base + wl * ta, lat), wa);
    // the storms
    float arms = .5 + .5 * sin(sr * 9. - sa * 2. - uT * .004 + (fbm3(qs * 12. + uSeed) - .5) * 3.);  // slowly turning spiral arms
    vec3 sc = mix(uStorm, mix(uStorm, uZone, .45), arms * (1. - .6 * smoothstep(.6, 0., sr)));
    col = mix(col, sc, smoothstep(0., .45, storm) * .95);
    col = mix(col, uZone * 1.08, (1. - smoothstep(0., .14, abs(sr - 1.1))) * .45);               // a pale collar
    col = mix(col, mix(uZone, vec3(1.), .3) * (.9 + .1 * arms), smoothstep(.05, .9, ovals) * .7);
    return col;
  }

  void main(){
    pxAngle = 2. * uTan / uRes.y;
    vec2 qv = (vUv * 2. - 1.) * vec2(uTan * uRes.x / uRes.y, uTan);
    vec3 rd = normalize(uFwd + qv.x * uRight + qv.y * uUp);
    vec3 ro = uCam;

    vec3 col = sky(rd);

    // planet
    float b = dot(ro, rd), c = dot(ro, ro) - 1., h = b * b - c;
    float bb = sqrt(max(c - b * b + 1., 0.));                              // closest distance of the ray to the centre
    float cov = b < 0. ? clamp((1. - bb) / (pxAngle * -b * 1.5) + .5, 0., 1.) : 0.;   // soft, pixel-wide limb
    float tp = cov > 0. ? -b - sqrt(max(h, 0.)) : -1.;
    // moon
    vec3 om = ro - uMoon; float bm = dot(om, rd), hm = bm * bm - (dot(om, om) - uMoonR * uMoonR);
    float tm = hm > 0. ? -bm - sqrt(hm) : -1.;
    // ring plane
    vec3 rol = uToLocal * ro, rdl = uToLocal * rd, sunL = uToLocal * uSun;
    float tr = -rol.y / rdl.y;
    vec3 Rl = rol + rdl * tr; float rr = length(Rl.xz);
    float fw = fwidth(rr);

    float tO = 1e9;
    if (tp > 0.){
      tO = tp;
      vec3 P = ro + rd * tp, N = normalize(P), nl = uToLocal * N;
      vec3 alb = clouds(nl);
      float ndl = dot(N, uSun), mu = max(dot(N, -rd), 0.);
      float lit = smoothstep(-.08, .55, ndl);
      // the ring's shadow
      float sh = 1.;
      if (nl.y * sunL.y < 0.){ float t = -nl.y / sunL.y; sh *= 1. - .85 * uRingOp * ringDens(length((nl + sunL * t).xz), .01); }
      // the moon's shadow, with a soft edge
      vec3 v = uMoon - P; float s = dot(v, uSun);
      if (s > 0.) sh *= smoothstep(uMoonR * .55, uMoonR * 1.3, length(v - uSun * s));
      float limb = mix(.4, 1., pow(mu, .4));
      vec3 pc = alb * (lit * sh * limb + .006);
      pc += uAtm * pow(1. - mu, 4.) * smoothstep(-.25, .4, ndl) * .22;     // haze at the edge
      col = mix(col, pc, cov);
    }
    {
      // a thin glow of atmosphere just outside the limb
      if (b < 0. && bb > 1.){
        vec3 cp = normalize(ro - rd * b);
        col += uAtm * exp(-(bb - 1.) * 70.) * smoothstep(-.3, .4, dot(cp, uSun)) * .18;
      }
    }
    if (tm > 0. && tm < tO){
      tO = tm;
      vec3 Pm = ro + rd * tm, Nm = normalize(Pm - uMoon);
      float cr = fbm3(Nm * 5. + uSeed);
      vec3 alb = vec3(.42, .40, .38) * (.7 + .6 * cr) * (1. - .35 * smoothstep(.55, .7, fbm3(Nm * 11. - uSeed)));
      float sm = 1.;
      vec3 v = -Pm; float s = dot(v, uSun);                                  // in the planet's shadow?
      if (s > 0.) sm = smoothstep(.97, 1.03, length(v - uSun * s));
      col = alb * smoothstep(-.05, .5, dot(Nm, uSun)) * sm;
    }
    if (tr > 0. && tr < tO && rr > RIN && rr < ROUT){
      float dn = ringDens(rr, fw) * uRingOp;
      vec3 Rw = ro + rd * tr;
      // the planet's shadow across the ring
      float s = dot(-Rw, uSun), shp = 1.;
      if (s > 0.) shp = smoothstep(.97, 1.04, length(Rw + uSun * s));
      bool sameSide = (rol.y > 0.) == (sunL.y > 0.);
      float lightAmt = abs(sunL.y);
      vec3 rc = uRingCol * (.75 + .5 * n1(rr * 9. + uSeed));
      vec3 lit = sameSide ? rc * (.25 + .8 * lightAmt) : rc * (1. - dn) * .9 * lightAmt;   // seen from the dark side, light comes through the thin parts
      col = col * (1. - dn) + lit * dn * shp;
    }

    col *= uFade;
    col = 1. - exp(-col * uExposure);
    col = pow(col, vec3(1. / 2.2));
    col += (h21(gl_FragCoord.xy + fract(uWall) * 13.) - .5) / 255.;
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

  const P = CONFIG.planet, C = CONFIG.camera, TM = CONFIG.time;
  const rng = mulberry32(SEED * 7919 + 13);
  const pal = PALETTES[params.has('palette') ? clamp(parseInt(params.get('palette'), 10) || 0, 0, 2) : Math.floor(rng() * PALETTES.length) % PALETTES.length];
  const v3 = (a) => new THREE.Vector3(a[0], a[1], a[2]);

  // the planet's frame: spin axis tipped towards the camera, then sideways
  const toWorld = new THREE.Matrix4().makeRotationZ(P.tilt[1]).multiply(new THREE.Matrix4().makeRotationX(P.tilt[0]));
  const toLocal = new THREE.Matrix3().setFromMatrix4(toWorld).transpose();

  const U = {
    uRes: { value: new THREE.Vector2(1, 1) }, uTan: { value: Math.tan(C.fov * DEG / 2) },
    uT: { value: params.has('t') ? parseFloat(params.get('t')) || 0 : rng() * 2000 }, uWall: { value: 0 },
    uSeed: { value: rng() * 100 }, uExposure: { value: CONFIG.exposure }, uFade: { value: 1 },
    uMoonR: { value: P.moon.radius }, uRingOp: { value: pal.ringOpacity },
    uStormLat: { value: 0.30 + 0.12 * rng() }, uStormLon: { value: rng() * Math.PI * 2 },
    uCam: { value: new THREE.Vector3() }, uFwd: { value: new THREE.Vector3() }, uRight: { value: new THREE.Vector3() }, uUp: { value: new THREE.Vector3() },
    uSun: { value: v3(P.sun).normalize() }, uMoon: { value: new THREE.Vector3() }, uToLocal: { value: toLocal },
    uZone: { value: v3(pal.zone) }, uBelt: { value: v3(pal.belt) }, uAccent: { value: v3(pal.accent) }, uStorm: { value: v3(pal.storm) },
    uRingCol: { value: v3(pal.ring) }, uAtm: { value: v3(pal.atm) },
  };
  // put the great storm on the side facing you, a little towards the light, at the start
  {
    const c = v3(C.pos).applyMatrix3(toLocal).normalize(), lat = U.uStormLat.value;
    const wind = (l) => 0.55 * Math.sin(l * 7.5) + 0.25 * Math.sin(l * 17 + 0.6) + 0.1 * Math.sin(l * 31);
    U.uStormLon.value = Math.atan2(c.z, c.x) + 0.35 + (wind(lat) * 0.9 + 1) * U.uT.value * 0.01;
  }
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({ uniforms: U, vertexShader: VERT, fragmentShader: FRAG, depthTest: false, depthWrite: false }));
  quad.frustumCulled = false; scene.add(quad);

  const target = v3(C.target);

  /* ---- size & quality ---- */
  const Q = CONFIG.quality;
  let qualityLevel = params.has('q') ? clamp(parseInt(params.get('q'), 10) || 0, 0, Q.ladder.length - 1) : 0;
  const size = new THREE.Vector2();
  function resize() {
    const cap = MOBILE ? Q.maxDpr.mobile : Q.maxDpr.desktop, base = MOBILE ? Q.scale.mobile : Q.scale.desktop;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, cap) * base * Q.ladder[qualityLevel]);
    renderer.setSize(window.innerWidth, window.innerHeight, false);
    renderer.getDrawingBufferSize(size); U.uRes.value.copy(size);
    // a narrow (portrait) screen: step back so the planet still fits across
    const aspect = window.innerWidth / window.innerHeight;
    U.uTan.value = Math.tan(C.fov * DEG / 2) * (aspect < 1 ? Math.min(1.9, 1.15 / aspect) : 1);
    target.x = C.target[0] * clamp((aspect - 0.6) / 0.7, 0, 1);    // portrait: bring the planet to the middle
  }
  function setQuality(level) { qualityLevel = clamp(level, 0, Q.ladder.length - 1); resize(); }

  /* ---- input: one control, held ---- */
  const held = { key: false, pointers: new Set() };
  const holding = () => held.key || held.pointers.size > 0;
  let everHeld = false, hinted = false, lastHeld = 0;
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

  /* ---- readout: how much time went by while you held ---- */
  function later(hours) {
    if (hours < 1) return `${Math.max(1, Math.round(hours * 60))} minutes later`;
    if (hours < 36) { const h = Math.round(hours); return `${h} hour${h === 1 ? '' : 's'} later`; }
    const d = Math.floor(hours / 24), h = Math.round(hours - d * 24);
    return `${d} days${h ? `, ${h} hour${h === 1 ? '' : 's'}` : ''} later · ${Math.floor(hours / 10)} turns of the giant`;
  }

  /* ---- loop ---- */
  let rate = TM.idle, wasHolding = false, heldFrom = 0, wall = 0, last = 0, raf = 0, running = false;
  const still = REDUCED || params.has('still');
  const cam = v3(C.pos), fwd = new THREE.Vector3(), right = new THREE.Vector3(), up = new THREE.Vector3();
  const Y = new THREE.Vector3(0, 1, 0);
  const moonL = new THREE.Vector3(), toWorld3 = new THREE.Matrix3().setFromMatrix4(toWorld);
  const perf = { frames: 0, since: 0, fps: 60, graceUntil: 0, samples: [] };

  function update(dt) {
    const h = holding();
    const ts = REDUCED ? CONFIG.reducedMotion.timeScale : 1;
    const goal = h ? TM.held : TM.idle;
    rate += (goal - rate) * (1 - Math.exp(-dt / (h ? TM.rise : TM.fall)));
    if (h && !wasHolding) heldFrom = U.uT.value;
    if (!h && wasHolding) {
      const hours = (U.uT.value - heldFrom) / TM.hour;
      if (hours >= CONFIG.message.minHours) ui.message(later(hours), { duration: CONFIG.message.show });
    }
    wasHolding = h;
    U.uT.value += dt * rate * ts;

    // the moon, on a slightly tilted orbit in the planet's frame
    const a = U.uT.value * P.moon.rate;
    moonL.set(Math.cos(a) * P.moon.orbit, Math.sin(a) * P.moon.orbit * P.moon.incline, Math.sin(a) * P.moon.orbit).applyMatrix3(toWorld3);
    U.uMoon.value.copy(moonL);

    // the camera
    const k = 1 - Math.exp(-dt / C.inertia);
    look.x += (look.tx - look.x) * k; look.y += (look.ty - look.y) * k;
    fwd.subVectors(target, cam).normalize();
    const swayYaw = still ? 0 : C.drift[0] * Math.sin(wall * 0.05), swayPitch = still ? 0 : C.drift[1] * Math.sin(wall * 0.071 + 1);
    fwd.applyAxisAngle(Y, (-look.x * C.look[0] + swayYaw) * DEG);
    right.crossVectors(fwd, Y).normalize();
    fwd.applyAxisAngle(right, (-look.y * C.look[1] + swayPitch) * DEG);
    up.crossVectors(right, fwd).normalize();
    U.uCam.value.copy(cam); U.uFwd.value.copy(fwd); U.uRight.value.copy(right); U.uUp.value.copy(up);
    U.uWall.value = wall;
  }
  function render() { renderer.render(scene, camera); }

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
      if (!params.has('q') && now > perf.graceUntil && perf.fps < Q.minFps && qualityLevel < Q.ladder.length - 1) { setQuality(qualityLevel + 1); perf.graceUntil = now + 2000; }
    }
  }
  function play() { if (running) return; running = true; last = performance.now(); perf.since = last; perf.frames = 0; perf.graceUntil = last + 2500; raf = requestAnimationFrame(tick); }
  function stop() { running = false; cancelAnimationFrame(raf); }
  document.addEventListener('visibilitychange', () => { if (document.hidden) { held.key = false; held.pointers.clear(); stop(); } else play(); });
  window.addEventListener('resize', () => { resize(); if (!running) { update(0.016); render(); } });
  canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); stop(); fallback(); });

  window.__giant = { config: CONFIG, samples: perf.samples, get t() { return U.uT.value; }, set t(v) { U.uT.value = v; }, get fps() { return perf.fps; }, get quality() { return qualityLevel; } };

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
  console.warn('[giant] falling back:', err);
  fallback();
}
