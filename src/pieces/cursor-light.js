/* CURSOR LIGHT
   The sun follows the cursor (or a finger); planets in front of it eclipse it,
   planets behind it catch its light. */
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { mountUI } from '../ui/ui.js';

const ui = mountUI({ id: 'cursor-light' });

/* ═══════════════════════════════════════════════════════════════════════════
   CONFIG — every tunable worth touching lives here.
   World units: the sun moves on the plane z = 0; the camera looks down -z from
   z = camera.distance. Planets with z > 0 are in FRONT of the sun (they eclipse
   it), planets with z < 0 are BEHIND it (the sun lights their face).
   ═══════════════════════════════════════════════════════════════════════════ */
const CONFIG = {
  camera: {
    fov: 35,
    distance: 14,            // minimum distance; grows on narrow windows to keep the composition in frame
    parallaxDeg: 2.2,        // max camera swing tied to the sun position
    parallaxEase: 1.4,       // 1/s — lower = heavier camera
    landscapeHalfWidth: 6.3, // world half-width (at z=0) that must stay visible in landscape
    portraitHalfWidth: 2.7,  // …and in portrait, where the layout is transposed
    portraitHalfHeight: 6.3,
  },

  sun: {
    color: [1.0, 0.95, 0.87],
    power: 40,               // light intensity: irradiance = power / (distance² + falloff)
    falloff: 15,             // softens the inverse-square law close to the sun
    springFreq: 5.0,         // rad/s — stiffness of the cursor→sun spring
    springDamping: 0.92,     // 1 = critically damped
    introSeconds: 1.2,       // fade-in at the center on load
    idleAfter: 6,            // s of stillness before the sun wanders on its own
    touchIdleAfter: 3.5,     // s after a finger lifts
    idleBlend: 2.5,          // s to ease into the idle path
    idleSpeed: 1.0,          // multiplier for the Lissajous drift
    idleSpeedReduced: 0.4,   // …under prefers-reduced-motion
    idleExtent: [0.62, 0.46],// Lissajous amplitude in NDC
    spriteSize: 6.5,         // world half-size of the glow billboard
    core: 90,                // HDR brightness of the point itself
    halo: 1.6,               // tight glow around the point
    corona: 0.5,             // streamer brightness
    glow: 0.07,              // wide soft glow
    zodiacal: 0.018,         // faint elongated dust glow (0 to disable)
    eclipseCoronaBoost: 3.5, // corona brightens as the disc is hidden…
    eclipseExposureBoost: 0.55, // …and the "eye" adapts
  },

  post: {
    exposure: 1.25,
    bloomStrength: 0.62,
    bloomRadius: 0.82,
    bloomThreshold: 1.1,
    grain: 0.022,
    vignette: 0.55,
    flare: 1.0,              // lens ghosts + streak; 0 to disable
  },

  stars: {
    count: 12000,
    coneDeg: 50,             // stars are only generated in the cone the camera can see
    galacticFraction: 0.38,  // share of stars clustered along the Milky Way
    brightness: 1.0,
    twinkle: 0.22,
  },

  milkyWay: {
    intensity: 0.034,
    bakeSize: 2048,              // baked once at startup
    bakeSizeMobile: 1024,
    normal: [-0.5, 0.85, 0.1],   // pole of the galactic plane (band runs lower-left → upper-right)
    core: [0.85, 0.5, -0.6],     // direction of the bright core, just outside the frame
  },

  drift: { amount: 0.05, speed: 0.045 }, // almost imperceptible bobbing of every body

  // Bodies. `axis` is the north pole direction; rings lie in the plane perpendicular to it.
  planets: [
    {
      name: 'giant', type: 'gas',
      radius: 3.4, position: [-7.5, 2.2, -7], axis: [-0.2, 0.95, 0.3], spin: 0.006, spin0: 0.0,
      colors: [[0.74, 0.56, 0.38], [0.93, 0.85, 0.72], [0.50, 0.31, 0.20], [0.40, 0.43, 0.50]],
      bandFreq: 7.0, turbulence: 0.085, flow: 1 / 60, shear: 0.9,
      storm: { lat: -19, lon: 62, size: 0.17, twist: 3.2, color: [0.70, 0.30, 0.17], amount: 0.6 },
      atmosphere: { height: 0.012, density: 0.9, rayleigh: [0.42, 0.58, 1.0], mie: [1.0, 0.85, 0.7] },
    },
    {
      name: 'ringed', type: 'gas',
      radius: 1.0, position: [4.9, -1.5, -3], portraitPosition: [2.0, -4.2, -3], axis: [0.3, 0.9, 0.35], spin: 0.012, spin0: 1.0,
      colors: [[0.78, 0.67, 0.48], [0.93, 0.87, 0.71], [0.63, 0.52, 0.37], [0.47, 0.50, 0.50]],
      bandFreq: 9.0, turbulence: 0.03, flow: 1 / 80, shear: 0.5,
      storm: null,
      atmosphere: { height: 0.014, density: 0.8, rayleigh: [0.5, 0.62, 1.0], mie: [1.0, 0.9, 0.75] },
      ring: { inner: 1.32, outer: 2.35, opacity: 1.5, gain: 1.7, colors: [[0.60, 0.50, 0.40], [0.96, 0.89, 0.76]] },
    },
    {
      name: 'rocky', type: 'rock',
      radius: 0.5, position: [1.3, 2.0, 4], axis: [0.25, 0.95, -0.1], spin: 0.016, spin0: 0.4,
      colors: [[0.52, 0.41, 0.33], [0.30, 0.26, 0.24], [0, 0, 0], [0, 0, 0]],
      craterFreq: 2.6, bump: 0.9, detail: 1.0,
      atmosphere: null,
    },
    {
      name: 'ice', type: 'ice',
      radius: 0.32, position: [-1.2, -1.5, 6], axis: [0.35, 0.9, 0.2], spin: 0.02, spin0: 2.0,
      colors: [[0.84, 0.91, 0.97], [0.50, 0.68, 0.86], [0.40, 0.29, 0.25], [0, 0, 0]],
      atmosphere: { height: 0.034, density: 1.3, rayleigh: [0.32, 0.58, 1.0], mie: [0.9, 0.95, 1.0] },
    },
    {
      name: 'moon', type: 'rock',
      radius: 0.2, position: [-3.6, -0.6, -5.5], axis: [0.1, 1, 0.1], spin: 0.01, spin0: 3.0,
      colors: [[0.46, 0.45, 0.44], [0.27, 0.27, 0.29], [0, 0, 0], [0, 0, 0]],
      craterFreq: 2.0, bump: 0.8, detail: 0.35,
      atmosphere: null,
    },
  ],
};

/* ═══════════════════════════════════════════════════════════════════════════
   Environment
   ═══════════════════════════════════════════════════════════════════════════ */
const coarsePointer = matchMedia('(pointer: coarse)').matches;
const motionQuery = matchMedia('(prefers-reduced-motion: reduce)');
let reducedMotion = motionQuery.matches;
motionQuery.addEventListener?.('change', (e) => { reducedMotion = e.matches; });

let renderer;
try {
  // Probe first so an unsupported browser falls back quietly (no console noise from three.js).
  const probe = document.createElement('canvas').getContext('webgl2');
  if (!probe) throw new Error('WebGL2 unavailable');
  probe.getExtension('WEBGL_lose_context')?.loseContext();
  renderer = new THREE.WebGLRenderer({ antialias: false, alpha: false, powerPreference: 'high-performance' });
  if (!renderer.capabilities.isWebGL2) throw new Error('WebGL2 required');
} catch (err) {
  renderer = null; // the static CSS background + text remain: that is the fallback
}

if (renderer) start(renderer);

function start(renderer) {

/* ═══════════════════════════════════════════════════════════════════════════
   GLSL — shared noise
   ═══════════════════════════════════════════════════════════════════════════ */
const GLSL_NOISE = /* glsl */`
  float hash11(float p){ p = fract(p * .1031); p *= p + 33.33; p *= p + p; return fract(p); }
  float hash13(vec3 p3){ p3 = fract(p3 * .1031); p3 += dot(p3, p3.zyx + 31.32); return fract((p3.x + p3.y) * p3.z); }
  vec3  hash33(vec3 p3){ p3 = fract(p3 * vec3(.1031, .1030, .0973)); p3 += dot(p3, p3.yxz + 33.33); return fract((p3.xxy + p3.yxx) * p3.zyx); }

  // Gradient noise, roughly -0.7 … 0.7, zero mean.
  float gnoise(vec3 p){
    vec3 i = floor(p), f = fract(p);
    vec3 u = f * f * f * (f * (f * 6. - 15.) + 10.);
    #define GRAD(o) dot(hash33(i + o) * 2. - 1., f - o)
    return mix(mix(mix(GRAD(vec3(0,0,0)), GRAD(vec3(1,0,0)), u.x),
                   mix(GRAD(vec3(0,1,0)), GRAD(vec3(1,1,0)), u.x), u.y),
               mix(mix(GRAD(vec3(0,0,1)), GRAD(vec3(1,0,1)), u.x),
                   mix(GRAD(vec3(0,1,1)), GRAD(vec3(1,1,1)), u.x), u.y), u.z);
  }
  float fbm(vec3 p, int octaves){
    float s = 0., a = .5;
    for (int i = 0; i < 6; i++) {
      if (i >= octaves) break;
      s += a * gnoise(p);
      p = p * 2.03 + vec3(17.1, 3.7, 9.2);
      a *= .5;
    }
    return s;
  }
  // 1-D value noise, -1 … 1
  float vn1(float x){ float i = floor(x), f = fract(x); f = f * f * (3. - 2. * f); return mix(hash11(i), hash11(i + 1.), f) * 2. - 1.; }
`;

/* ═══════════════════════════════════════════════════════════════════════════
   GLSL — bodies
   Each body is drawn on a bounding shell; the fragment shader ray-traces the
   sphere (and ring) analytically. That gives perfectly anti-aliased limbs, an
   atmosphere that extends past the surface, and ring/planet interleaving
   without any depth-buffer tricks. Output is premultiplied alpha.
   ═══════════════════════════════════════════════════════════════════════════ */
const BODY_VERT = /* glsl */`
  varying vec3 vWorld;
  void main(){
    vec4 w = modelMatrix * vec4(position, 1.);
    vWorld = w.xyz;
    gl_Position = projectionMatrix * viewMatrix * w;
  }
`;

const BODY_FRAG = /* glsl */`
  precision highp float;
  varying vec3 vWorld;

  uniform vec3  uCenter;
  uniform float uRadius;
  uniform mat3  uRot;        // world → body-local rotation (axis tilt + spin)
  uniform float uSeed;
  uniform float uTime;

  uniform vec3  uSunPos, uSunColor;
  uniform float uSunPower, uFalloff;
  uniform vec4  uBodies[NUM_BODIES];   // xyz = center, w = radius — for analytic shadows
  uniform int   uSelf;

  uniform vec3  uColA, uColB, uColC, uColD;

  uniform float uAtmoH, uAtmoTau;      // scale height (world units), limb optical depth
  uniform vec3  uAtmoRay, uAtmoMie;

  uniform float uBandFreq, uTurb, uFlow, uShear;               // gas
  uniform vec3  uStormDir, uStormCol;
  uniform float uStormSize, uStormTwist, uStormAmt;

  uniform float uCraterFreq, uBump, uDetail;                   // rock

  uniform vec3  uRingN, uRingColA, uRingColB;                  // ring
  uniform float uRingIn, uRingOut, uRingTau, uRingGain;

  ${GLSL_NOISE}

  float hg(float mu, float g){ return (1. - g * g) / pow(1. + g * g - 2. * g * mu, 1.5) * 0.0796; }
  vec3 rotAxis(vec3 p, vec3 ax, float a){ return mix(dot(ax, p) * ax, p, cos(a)) + cross(ax, p) * sin(a); }

  // Soft analytic shadow cast by the other spheres on the segment P → sun.
  float bodyShadow(vec3 P, vec3 L, float dist, int skip){
    float s = 1.;
    for (int i = 0; i < NUM_BODIES; i++) {
      if (i == skip) continue;
      vec4 o = uBodies[i];
      vec3 v = o.xyz - P;
      float tt = dot(v, L);
      if (tt <= 0. || tt >= dist) continue;
      float d = length(v - L * tt);
      float pen = min(o.w * .5, .015 + .035 * tt);   // penumbra widens with distance from the caster
      s *= smoothstep(o.w - pen, o.w + pen, d);
    }
    return s;
  }

  /* ── ring ─────────────────────────────────────────────────────────────── */
  #ifdef RING
  float fadeF(float cyclesPerPixel){ return 1. - smoothstep(.15, .6, cyclesPerPixel); }
  float gapF(float x, float c, float w, float e){ return smoothstep(w, w + e, abs(x - c)); }
  // Radial density profile. fw = pixel footprint in radius, used to band-limit
  // every detail so the ring never shimmers.
  float ringDensity(float r, float fw){
    float span = uRingOut - uRingIn;
    float x = (r - uRingIn) / span, fx = fw / span;
    float e = max(.006, fx * 1.5);
    float d = smoothstep(0., e, x) * (1. - smoothstep(1. - e, 1., x));
    d *= mix(.12, 1., smoothstep(.16, .27, x));         // faint inner ring → dense main ring
    d *= mix(1., .55, smoothstep(.60, .66, x));         // thinner outer ring
    d *= mix(.04, 1., gapF(x, .615, .022, e));          // main division
    d *= mix(.25, 1., gapF(x, .885, .006, e));          // narrow outer gap
    d *= mix(1., .35, smoothstep(.93, 1., x));          // feathered edge
    float n = .55 * vn1(x * 13. + uSeed)       * fadeF(fx * 13.)
            + .40 * vn1(x * 37. + uSeed * 2.)  * fadeF(fx * 37.)
            + .30 * vn1(x * 91. + uSeed * 3.)  * fadeF(fx * 91.);
    return max(d * (1. + .6 * n), 0.);
  }
  // Light lost crossing the ring plane on the way to the sun.
  float ringShadow(vec3 P, vec3 L, float dist){
    float dn = dot(L, uRingN);
    if (abs(dn) < 1e-4) return 1.;
    float t = dot(uCenter - P, uRingN) / dn;
    if (t <= 0. || t >= dist) return 1.;
    float r = length(P + L * t - uCenter);
    return exp(-ringDensity(r, .012) * uRingTau / max(abs(dn), .08));
  }
  #endif

  /* ── surfaces ─────────────────────────────────────────────────────────── */
  #if TYPE == 0
  // Gas: latitude bands warped by turbulence. Each band shears at its own speed;
  // two phase-offset samples are cross-faded so the flow never winds up.
  vec2 gasSample(vec3 p, float wind, float ph){
    float a = wind * (ph - .5) * uShear;
    float ca = cos(a), sa = sin(a);
    vec3 q = vec3(ca * p.x + sa * p.z, p.y, -sa * p.x + ca * p.z);
    float warp = fbm(q * vec3(2.2, 6., 2.2) + uSeed, 4);
    float det  = fbm(q * vec3(5., 17., 5.) + uSeed * 2. + warp * 1.5, 3);
    return vec2(warp, det);
  }
  vec3 gasAlbedo(vec3 p){
    vec3 dv = p - uStormDir;
    float sw = exp(-(dv.x * dv.x + dv.z * dv.z + dv.y * dv.y * 5.) / (uStormSize * uStormSize));
    p = rotAxis(p, uStormDir, sw * uStormTwist * step(.001, uStormAmt));
    float lat = asin(clamp(p.y, -1., 1.));
    float wind = sin(lat * uBandFreq * 1.7 + uSeed) + .5 * sin(lat * uBandFreq * .6);
    float T = uTime * uFlow;
    float ph0 = fract(T), ph1 = fract(T + .5);
    float w0 = 1. - abs(2. * ph0 - 1.), w1 = 1. - w0;
    vec2 s = (gasSample(p, wind, ph0) * w0 + gasSample(p, wind, ph1) * w1) / sqrt(w0 * w0 + w1 * w1);
    float l = lat + s.x * uTurb;
    float b1 = gnoise(vec3(.3, l * uBandFreq, uSeed));
    float b2 = gnoise(vec3(7.1, l * uBandFreq * 3.1, uSeed));
    float band = b1 * 1.5 + b2 * .5 + s.y * .4;
    vec3 col = mix(uColA, uColB, smoothstep(-.45, .45, band));
    col = mix(col, uColC, smoothstep(.05, .8, b2 * 1.6 + s.y * .9) * .6);
    col = mix(col, uColD, smoothstep(.8, 1.35, abs(lat) + s.x * .1));
    col = mix(col, uStormCol, sw * uStormAmt);
    return col;
  }
  #endif

  #if TYPE == 1
  // Rock: three octaves of 3-D cellular craters (bowl + raised rim) over rolling terrain.
  float craterLayer(vec3 p, float seed){
    vec3 i = floor(p), f = fract(p);
    float h = 0.;
    for (int x = -1; x <= 1; x++) for (int y = -1; y <= 1; y++) for (int z = -1; z <= 1; z++) {
      vec3 o = vec3(float(x), float(y), float(z));
      vec3 id = i + o + seed;
      vec3 rnd = hash33(id);
      float keep = step(.42, hash13(id + 3.7));
      float rs = hash13(id + 9.1);
      float rad = mix(.16, .46, rs * rs);
      float d = length(f - (o + .2 + .6 * rnd)) / rad;
      float bowl = d < 1. ? (d * d - 1.) * .55 : 0.;
      float rim = exp(-(d - 1.) * (d - 1.) * 14.) * .28;
      h += keep * rad * (bowl + rim);
    }
    return h;
  }
  float rockHeight(vec3 p){
    float f = uCraterFreq;
    float h = craterLayer(p * f, uSeed) / f
            + craterLayer(p * f * 2.3, uSeed + 5.) / (f * 2.3);
    if (uDetail > .5) h += craterLayer(p * f * 4.6, uSeed + 11.) / (f * 4.6);
    h += fbm(p * 2.4 + uSeed, 4) * .07 + fbm(p * 11. + uSeed, 3) * .012 * uDetail;
    return h;
  }
  #endif

  #if TYPE == 2
  float iceHeight(vec3 p){ return gnoise(p * 5. + uSeed) + .5 * gnoise(p * 11. + uSeed); }
  #endif

  void main(){
    vec3 ro = cameraPosition;
    vec3 rd = normalize(vWorld - ro);

    // Ray / sphere, kept valid slightly outside the limb for AA and atmosphere.
    vec3 oc = ro - uCenter;
    float b = dot(oc, rd);
    float dc2 = max(dot(oc, oc) - b * b, 0.);
    float dc = sqrt(dc2);                              // closest approach of the ray to the center
    float aa = fwidth(dc) * .75 + 1e-5;
    float cov = 1. - smoothstep(uRadius - aa, uRadius + aa, dc);
    float tS = -b - sqrt(max(uRadius * uRadius - dc2, 0.));
    vec3 P = ro + rd * tS;
    vec3 N = normalize(P - uCenter);

    vec3 Lv = uSunPos - P;
    float d2 = dot(Lv, Lv), dist = sqrt(d2);
    vec3 L = Lv / dist;
    float irr = uSunPower / (d2 + uFalloff);           // inverse-square-ish
    float ndl = dot(N, L);
    float ndv = max(dot(N, -rd), 0.);
    float sh = bodyShadow(P, L, dist, uSelf);
    #ifdef RING
      sh *= ringShadow(P, L, dist);
    #endif

    vec3 col = vec3(0.);
    if (cov > 0.) {
      vec3 p = uRot * N;                               // body-local direction
      #if TYPE == 0
        vec3 albedo = gasAlbedo(p);
        float w = .12;                                 // light wraps a little through the haze
        float diff = pow(clamp((ndl + w) / (1. + w), 0., 1.), 1.5);
        diff *= .45 + .55 * pow(ndv, .4);              // limb darkening
        vec3 tint = mix(vec3(1., .5, .28), vec3(1.), smoothstep(0., .4, ndl + w)); // warm terminator
        col = albedo * tint * diff;
      #elif TYPE == 1
        float e = .004;
        float h0 = rockHeight(p);
        vec3 g = vec3(rockHeight(p + vec3(e, 0, 0)), rockHeight(p + vec3(0, e, 0)), rockHeight(p + vec3(0, 0, e))) - h0;
        g /= e; g -= p * dot(g, p);
        vec3 Nb = normalize(p - uBump * g) * uRot;     // back to world space
        vec3 albedo = mix(uColB, uColA, smoothstep(-.25, .3, fbm(p * 1.7 + uSeed + 3., 4)));
        albedo *= 1. + clamp(h0 * 4., -.28, .3);
        float diff = max(dot(Nb, L), 0.) * smoothstep(-.015, .06, ndl);  // crisp terminator
        diff = mix(diff, sqrt(diff), .35);             // dusty regolith: flatter than Lambert
        col = albedo * diff;
      #else
        float e = .01;
        float h0 = iceHeight(p);
        vec3 g = vec3(iceHeight(p + vec3(e, 0, 0)), iceHeight(p + vec3(0, e, 0)), iceHeight(p + vec3(0, 0, e))) - h0;
        g /= e; g -= p * dot(g, p);
        vec3 Nb = normalize(p - .012 * g) * uRot;
        float cracks = 0., ca = 1.; vec3 q = p * 2.6 + uSeed;
        for (int i = 0; i < 4; i++) {
          float r = clamp(1. - abs(gnoise(q)) * 2.4, 0., 1.);
          cracks += ca * pow(r, 9.);
          q = q * 2.07 + 7.3; ca *= .62;
        }
        cracks = clamp(cracks, 0., 1.);
        vec3 albedo = mix(uColB, uColA, smoothstep(-.3, .3, fbm(p * 1.8 + uSeed, 4)));
        albedo = mix(albedo, uColC, cracks * .6);
        float w = .08;
        float diff = pow(clamp((dot(Nb, L) + w) / (1. + w), 0., 1.), 1.25);
        vec3 H = normalize(L - rd);
        float nh = max(dot(Nb, H), 0.);
        float fres = .2 + .8 * pow(1. - ndv, 3.);
        float spec = (pow(nh, 260.) * 20. + pow(nh, 28.) * .4) * fres * smoothstep(-.02, .1, ndl) * (1. - .7 * cracks);
        col = albedo * diff + vec3(spec);
      #endif
      col *= uSunColor * irr * sh;
    }
    col *= cov;

    // Atmosphere: analytic single scattering. Optical depth falls off exponentially
    // above the limb and thins toward the disc center. A strong forward (Mie) lobe
    // makes the limb ignite into a ring when the sun passes behind the planet.
    if (uAtmoTau > 0.) {
      float h = max(dc - uRadius, 0.);
      float tau = uAtmoTau * exp(-h / uAtmoH) * (.15 / (ndv * cov + .15));
      float day = smoothstep(-.3, .25, ndl);
      float mu = dot(L, rd);
      vec3 sc = uAtmoRay * (.0597 * (1. + mu * mu)) * 8. + uAtmoMie * hg(mu, .76);
      col = col * exp(-tau * .4) + sc * uSunColor * irr * day * sh * (1. - exp(-tau));
    }
    vec4 outc = vec4(col, cov);

    #ifdef RING
    {
      float dn = dot(rd, uRingN);
      float tR = dot(uCenter - ro, uRingN) / (abs(dn) < 1e-5 ? 1e-5 : dn);
      vec3 Pr = ro + rd * tR;
      vec3 rel = Pr - uCenter;
      float rr = length(rel);
      float fw = fwidth(rr);
      vec2 gp = (uRot * rel).xz;                       // ring-plane coords, co-rotating
      vec2 gf = fwidth(gp);
      vec4 ring = vec4(0.);
      if (tR > 0. && rr > uRingIn - fw * 2. && rr < uRingOut + fw * 2.) {
        float dens = ringDensity(rr, fw);
        // particulate grain, band-limited to the pixel footprint
        float fg = max(gf.x, gf.y);
        dens *= 1. + .9 * gnoise(vec3(gp * 46., 1.7)) * fadeF(fg * 46.)
                   + .6 * gnoise(vec3(gp * 17., 4.2)) * fadeF(fg * 17.);
        dens = max(dens, 0.);
        vec3 Lr = uSunPos - Pr;
        float rd2 = dot(Lr, Lr), rdist = sqrt(rd2);
        Lr /= rdist;
        float rirr = uSunPower / (rd2 + uFalloff);
        float ln = dot(Lr, uRingN);
        float mu0 = max(abs(ln), .03), muv = max(abs(dn), .06);
        float tau = dens * uRingTau;
        // Thin-layer single scattering: reflection on the lit face,
        // diffuse transmission (thin parts glow, dense parts go dark) on the unlit face.
        float refl = mu0 / (mu0 + muv) * (1. - exp(-tau * (1. / muv + 1. / mu0)));
        float xt = tau * .5 * (1. / muv + 1. / mu0);
        float trans = .9 * xt * exp(-xt);
        float same = smoothstep(-.04, .04, ln * -sign(dn));
        float phase = .5 + 1.6 * hg(dot(Lr, rd), .62);  // dust scatters forward
        float x = (rr - uRingIn) / (uRingOut - uRingIn);
        vec3 rc = mix(uRingColA, uRingColB, clamp(smoothstep(.1, .5, x) * .8 + .25 * vn1(x * 21. + uSeed), 0., 1.));
        float rsh = bodyShadow(Pr, Lr, rdist, -1);     // includes the planet's own shadow on the ring
        ring.rgb = rc * uSunColor * rirr * phase * mix(trans, refl, same) * rsh * uRingGain;
        ring.a = 1. - exp(-tau / muv);
      }
      outc = (tR < tS) ? vec4(ring.rgb + (1. - ring.a) * outc.rgb, ring.a + (1. - ring.a) * outc.a)
                       : vec4(outc.rgb + (1. - outc.a) * ring.rgb, outc.a + (1. - outc.a) * ring.a);
    }
    #endif

    gl_FragColor = outc;
  }
`;

/* ═══════════════════════════════════════════════════════════════════════════
   GLSL — sky, stars, sun, final grade
   ═══════════════════════════════════════════════════════════════════════════ */
// The Milky Way costs dozens of noise octaves per pixel and never changes, so it is
// baked once into an HDR texture (tangent space around -z) and only sampled per frame.
const SKY_BAKE_VERT = /* glsl */`
  uniform float uTan;
  varying vec3 vDir;
  void main(){ vDir = vec3(position.xy * uTan, -1.); gl_Position = vec4(position.xy, 0., 1.); }
`;
const SKY_BAKE_FRAG = /* glsl */`
  precision highp float;
  varying vec3 vDir;
  uniform vec3 uGalN, uGalC;
  uniform float uIntensity;
  ${GLSL_NOISE}
  void main(){
    vec3 d = normalize(vDir);
    float lat = dot(d, uGalN);
    vec3 p = d - uGalN * lat;                               // component inside the galactic plane
    float core = pow(clamp(dot(d, uGalC) * .5 + .5, 0., 1.), 2.5);
    float w = .12 + .11 * core;                             // the band swells toward the core
    float g = lat / w;

    // Smooth body + wide faint skirt, gently modulated by noise at four scales.
    float body = exp(-g * g) + .22 * exp(-g * g / 7.);
    float n = .60 * fbm(d * 2.6 + 1.3, 4) + .38 * fbm(d * 7.5 + 3., 4)
            + .24 * fbm(d * 21. + 9., 4)  + .14 * fbm(d * 60. + 5., 3);
    float light = body * max(1. + 1.1 * n, 0.) * (.55 + .9 * core);

    // Dust: filaments stretched along the plane, plus a wandering central rift.
    vec3 q = p * 5. + uGalN * lat * 13.;
    float wv = fbm(q * .7 + 2., 3);
    float fil = 1. - abs(fbm(q + wv * 1.2, 5)) * 3.4;
    float lanes = smoothstep(.15, .95, fil + .5 * fbm(q * 2.7 + 8., 4)) * exp(-g * g / .5);
    float rc = (lat - .02 - .06 * fbm(p * 3. + 4., 3)) / (w * .24);
    float rift = exp(-rc * rc) * clamp(.85 + .9 * fbm(p * 9. + wv, 3), 0., 1.);
    float dust = clamp(lanes * .7 + rift * .7, 0., 1.);
    light *= 1. - .82 * dust;

    // Warm toward the core and the midplane, cool at the edges; dust reddens.
    float warm = clamp(core * 1.8 - .7, 0., 1.) + .3 * exp(-g * g / .35);
    vec3 tint = mix(vec3(.50, .62, 1.), vec3(1., .80, .58), clamp(warm, 0., 1.));
    tint *= mix(vec3(1.), vec3(1., .78, .6), dust * .6);
    gl_FragColor = vec4(tint * light * uIntensity + vec3(.0012, .0014, .002), 1.);
  }
`;
const SKY_VERT = /* glsl */`
  varying vec3 vDir;
  void main(){ vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.); }
`;
const SKY_FRAG = /* glsl */`
  precision highp float;
  varying vec3 vDir;
  uniform sampler2D uMap;
  uniform float uTan;
  ${GLSL_NOISE}
  void main(){
    vec3 d = normalize(vDir);
    vec3 col = texture2D(uMap, d.xy / max(-d.z, 1e-3) / uTan * .5 + .5).rgb;
    col *= 1. + .2 * gnoise(d * 330.) + .12 * gnoise(d * 640. + 7.);   // fine unresolved-star grain
    gl_FragColor = vec4(col, 1.);
  }
`;

const STAR_VERT = /* glsl */`
  attribute float aMag, aPhase;
  attribute vec3 aColor;
  uniform float uTime, uDpr, uTwinkle, uBrightness;
  varying vec3 vColor;
  void main(){
    float tw = 1. + uTwinkle * sin(uTime * (.5 + 1.8 * aPhase) + aPhase * 50.) * smoothstep(.1, 1., aMag);
    vColor = aColor * aMag * tw * uBrightness;
    gl_PointSize = uDpr * (1.7 + 2.0 * sqrt(min(aMag, 4.)));
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.);
  }
`;
const STAR_FRAG = /* glsl */`
  precision highp float;
  varying vec3 vColor;
  void main(){
    vec2 c = gl_PointCoord * 2. - 1.;
    float r2 = dot(c, c);
    gl_FragColor = vec4(vColor * exp(-r2 * 4.5) * (1. - smoothstep(.7, 1., r2)), 1.);
  }
`;

const SUN_VERT = /* glsl */`
  uniform float uSize;
  varying vec2 vP;
  void main(){
    vP = position.xy * uSize;
    vec4 mv = modelViewMatrix * vec4(0., 0., 0., 1.);
    mv.xy += position.xy * uSize;                       // camera-facing billboard
    gl_Position = projectionMatrix * mv;
  }
`;
const SUN_FRAG = /* glsl */`
  precision highp float;
  varying vec2 vP;
  uniform float uTime, uPower, uEclipse, uSize;
  uniform float uCore, uHalo, uCorona, uGlow, uZod, uCoronaBoost;
  uniform vec3 uColor;
  ${GLSL_NOISE}
  void main(){
    float r = length(vP);
    vec2 dir = vP / max(r, 1e-4);
    float core = uCore * exp(-r * r / .0009);
    float halo = uHalo / (1. + pow(r / .055, 2.2));
    float glow = uGlow / (1. + pow(r / .5, 2.));
    // corona: slow radial streamers
    float n = gnoise(vec3(dir * 2.4, uTime * .05 + r * .5)) * 1.2
            + gnoise(vec3(dir * 6.5, uTime * .08 - r * 1.4)) * .6;
    float corona = uCorona * max(.55 + 1.3 * n, 0.) / (1. + pow(r / .16, 2.6));
    corona *= 1. + uCoronaBoost * uEclipse;
    // zodiacal dust: faint glow stretched along a tilted ecliptic
    vec2 z = vec2(vP.x * .974 + vP.y * .225, -vP.x * .225 + vP.y * .974);
    float zod = uZod * exp(-abs(z.y) / .24) * exp(-abs(z.x) / 2.6);
    float edge = 1. - smoothstep(uSize * .55, uSize, r);
    vec3 col = uColor * (core + halo)
             + vec3(1., .9, .78) * corona
             + vec3(1., .86, .7) * glow
             + vec3(1., .8, .62) * zod;
    gl_FragColor = vec4(col * uPower * edge, 1.);
  }
`;

// Final pass: lens flare, exposure, vignette, ACES, sRGB, grain/dither.
const FINAL_SHADER = {
  uniforms: {
    tDiffuse: { value: null },
    uRes: { value: new THREE.Vector2(1, 1) },
    uSun: { value: new THREE.Vector2(0.5, 0.5) },
    uSunVis: { value: 0 },
    uFlare: { value: CONFIG.post.flare },
    uExposure: { value: CONFIG.post.exposure },
    uVignette: { value: CONFIG.post.vignette },
    uGrain: { value: CONFIG.post.grain },
    uFade: { value: 0 },
    uSeed: { value: 0 },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.); }
  `,
  fragmentShader: /* glsl */`
    precision highp float;
    varying vec2 vUv;
    uniform sampler2D tDiffuse;
    uniform vec2 uRes, uSun;
    uniform float uSunVis, uFlare, uExposure, uVignette, uGrain, uFade, uSeed;

    vec3 aces(vec3 x){   // Stephen Hill's ACES fit
      const mat3 inM  = mat3(.59719, .07600, .02840, .35458, .90834, .13383, .04823, .01566, .83777);
      const mat3 outM = mat3(1.60475, -.10208, -.00327, -.53108, 1.10813, -.07276, -.07367, -.00605, 1.07602);
      vec3 v = inM * x;
      vec3 a = v * (v + .0245786) - .000090537;
      vec3 b = v * (.983729 * v + .4329510) + .238081;
      return clamp(outM * (a / b), 0., 1.);
    }
    float hash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }

    void main(){
      float aspect = uRes.x / uRes.y;
      vec3 col = texture2D(tDiffuse, vUv).rgb;
      vec2 p = (vUv - .5) * vec2(aspect, 1.);
      vec2 s = (uSun - .5) * vec2(aspect, 1.);

      // Lens flare: three soft ghosts mirrored through the frame center and a thin streak.
      vec3 fl = vec3(0.);
      vec2 g;
      g = p + s * .38; fl += vec3(.35, .55, 1.) * .020 * exp(-dot(g, g) / .0030);
      g = p + s * .85; fl += vec3(1., .68, .38) * .011 * exp(-dot(g, g) / .0130);
      g = p + s * 1.5; fl += vec3(.45, 1., .8)  * .007 * exp(-dot(g, g) / .0450);
      vec2 q = p - s;
      fl += vec3(.55, .72, 1.) * .045 * exp(-abs(q.y) * 85.) / (1. + q.x * q.x * 5.);
      col += fl * uFlare * uSunVis;

      col *= uExposure * uFade;
      col *= 1. - uVignette * smoothstep(.35, 1.25, length(p) * 2. / length(vec2(aspect, 1.)) * 1.25);

      col = aces(col);
      col = pow(col, vec3(1. / 2.2));

      // Film grain, triangular so it doubles as dither against banding.
      vec2 px = vUv * uRes;
      float n = hash12(px + uSeed * 61.7) + hash12(px * 1.37 + 19.3 + uSeed * 37.1) - 1.;
      float lum = dot(col, vec3(.299, .587, .114));
      col += n * (uGrain * (1. - .6 * lum) + 1. / 255.);
      gl_FragColor = vec4(col, 1.);
    }
  `,
};

/* ═══════════════════════════════════════════════════════════════════════════
   Scene
   ═══════════════════════════════════════════════════════════════════════════ */
const canvas = renderer.domElement;
canvas.id = 'space';
document.body.prepend(canvas);
renderer.setClearColor(0x000000, 1);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(CONFIG.camera.fov, 1, 0.1, 4000);
const tanHalfFov = Math.tan(THREE.MathUtils.degToRad(CONFIG.camera.fov / 2));

// deterministic randomness so the sky is the same on every visit
function mulberry32(a) {
  return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
const rand = mulberry32(20261116);

// Uniforms shared by every body (same object → one update reaches all materials).
const NUM = CONFIG.planets.length;
const shared = {
  uTime: { value: 0 },
  uSunPos: { value: new THREE.Vector3() },
  uSunColor: { value: new THREE.Vector3(...CONFIG.sun.color) },
  uSunPower: { value: 0 },
  uFalloff: { value: CONFIG.sun.falloff },
  uBodies: { value: Array.from({ length: NUM }, () => new THREE.Vector4()) },
};

/* ── Milky Way ─────────────────────────────────────────────────────────── */
const galN = new THREE.Vector3(...CONFIG.milkyWay.normal).normalize();
const galC = new THREE.Vector3(...CONFIG.milkyWay.core);
galC.addScaledVector(galN, -galC.dot(galN)).normalize(); // keep the core on the galactic plane

const SKY_TAN = 1.25; // half-extent of the bake in tangent space (~51°), wider than any view
const skyBake = new THREE.WebGLRenderTarget(
  coarsePointer ? CONFIG.milkyWay.bakeSizeMobile : CONFIG.milkyWay.bakeSize,
  coarsePointer ? CONFIG.milkyWay.bakeSizeMobile : CONFIG.milkyWay.bakeSize,
  { type: THREE.HalfFloatType, depthBuffer: false });
const skyBakeScene = new THREE.Scene();
{
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({
    vertexShader: SKY_BAKE_VERT, fragmentShader: SKY_BAKE_FRAG, depthTest: false, depthWrite: false,
    uniforms: { uGalN: { value: galN }, uGalC: { value: galC }, uIntensity: { value: CONFIG.milkyWay.intensity }, uTan: { value: SKY_TAN } },
  }));
  quad.frustumCulled = false;
  skyBakeScene.add(quad);
}
function bakeSky() {
  renderer.setRenderTarget(skyBake);
  renderer.render(skyBakeScene, camera);
  renderer.setRenderTarget(null);
}
bakeSky();

const sky = new THREE.Mesh(
  new THREE.SphereGeometry(1500, 32, 16),
  new THREE.ShaderMaterial({
    vertexShader: SKY_VERT, fragmentShader: SKY_FRAG,
    uniforms: { uMap: { value: skyBake.texture }, uTan: { value: SKY_TAN } },
    side: THREE.BackSide, depthTest: false, depthWrite: false,
  })
);
sky.renderOrder = -3; sky.frustumCulled = false;
scene.add(sky);

/* ── Stars ─────────────────────────────────────────────────────────────── */
function kelvinToLinearRGB(k) {
  const t = k / 100; let r, g, b;
  if (t <= 66) {
    r = 255;
    g = 99.4708025861 * Math.log(t) - 161.1195681661;
    b = t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  } else {
    r = 329.698727446 * Math.pow(t - 60, -0.1332047592);
    g = 288.1221695283 * Math.pow(t - 60, -0.0755148492);
    b = 255;
  }
  const lin = (v) => Math.pow(Math.min(Math.max(v, 0), 255) / 255, 2.2);
  return [lin(r), lin(g), lin(b)];
}
const starUniforms = {
  uTime: shared.uTime, uDpr: { value: 1 },
  uTwinkle: { value: CONFIG.stars.twinkle }, uBrightness: { value: CONFIG.stars.brightness },
};
{
  const n = CONFIG.stars.count;
  const pos = new Float32Array(n * 3), colr = new Float32Array(n * 3), mag = new Float32Array(n), phase = new Float32Array(n);
  const cosCone = Math.cos(THREE.MathUtils.degToRad(CONFIG.stars.coneDeg));
  const v = new THREE.Vector3();
  const sample = () => {
    const c = 1 - rand() * (1 - cosCone), s = Math.sqrt(1 - c * c), a = rand() * Math.PI * 2;
    return v.set(s * Math.cos(a), s * Math.sin(a), -c);
  };
  for (let i = 0; i < n; i++) {
    const galactic = rand() < CONFIG.stars.galacticFraction;
    sample();
    if (galactic) for (let k = 0; k < 40; k++) { const l = v.dot(galN) / 0.2; if (rand() < Math.exp(-l * l)) break; sample(); }
    pos.set([v.x * 1200, v.y * 1200, v.z * 1200], i * 3);
    const u = rand();
    mag[i] = 0.025 + 0.4 * Math.pow(u, 9) + 4.0 * Math.pow(u, 90);          // mostly faint, a few bright
    const [r, g, b] = kelvinToLinearRGB(2900 + 10500 * Math.pow(rand(), 1.5)); // warm orange → blue-white
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b || 1;
    colr.set([r / lum, g / lum, b / lum].map((c) => 0.3 + 0.7 * c), i * 3);    // equal-luminance, gently desaturated
    phase[i] = rand();
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aColor', new THREE.BufferAttribute(colr, 3));
  geo.setAttribute('aMag', new THREE.BufferAttribute(mag, 1));
  geo.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));
  var stars = new THREE.Points(geo, new THREE.ShaderMaterial({
    vertexShader: STAR_VERT, fragmentShader: STAR_FRAG, uniforms: starUniforms,
    blending: THREE.AdditiveBlending, transparent: true, depthTest: false, depthWrite: false,
  }));
  stars.renderOrder = -2; stars.frustumCulled = false;
  scene.add(stars);
}

/* ── Bodies ────────────────────────────────────────────────────────────── */
const TYPE_ID = { gas: 0, rock: 1, ice: 2 };
const Y_AXIS = new THREE.Vector3(0, 1, 0);
const shellGeo = new THREE.SphereGeometry(1, 64, 32);
const v3 = (a) => new THREE.Vector3(a[0], a[1], a[2]);

const bodies = CONFIG.planets.map((def, i) => {
  const atmo = def.atmosphere;
  const atmoH = atmo ? atmo.height * def.radius : 1;
  const bound = (def.ring ? def.ring.outer * 1.03 : def.radius * 1.015 + (atmo ? atmoH * 9 : 0)) * 1.01;
  const axis = v3(def.axis).normalize();
  const storm = def.storm;
  const sLat = storm ? THREE.MathUtils.degToRad(storm.lat) : 0, sLon = storm ? THREE.MathUtils.degToRad(storm.lon) : 0;

  const uniforms = {
    ...shared,
    uCenter: { value: new THREE.Vector3() },
    uRadius: { value: def.radius },
    uRot: { value: new THREE.Matrix3() },
    uSeed: { value: 3.1 + i * 7.77 },
    uSelf: { value: i },
    uColA: { value: v3(def.colors[0]) }, uColB: { value: v3(def.colors[1]) },
    uColC: { value: v3(def.colors[2]) }, uColD: { value: v3(def.colors[3]) },
    uAtmoH: { value: atmoH }, uAtmoTau: { value: atmo ? atmo.density : 0 },
    uAtmoRay: { value: v3(atmo ? atmo.rayleigh : [0, 0, 0]) }, uAtmoMie: { value: v3(atmo ? atmo.mie : [0, 0, 0]) },
    uBandFreq: { value: def.bandFreq ?? 1 }, uTurb: { value: def.turbulence ?? 0 },
    uFlow: { value: def.flow ?? 0 }, uShear: { value: def.shear ?? 0 },
    uStormDir: { value: new THREE.Vector3(Math.cos(sLat) * Math.cos(sLon), Math.sin(sLat), Math.cos(sLat) * Math.sin(sLon)) },
    uStormCol: { value: v3(storm ? storm.color : [0, 0, 0]) },
    uStormSize: { value: storm ? storm.size : 0.1 }, uStormTwist: { value: storm ? storm.twist : 0 }, uStormAmt: { value: storm ? storm.amount : 0 },
    uCraterFreq: { value: def.craterFreq ?? 1 }, uBump: { value: def.bump ?? 0 }, uDetail: { value: def.detail ?? 0 },
    uRingN: { value: axis.clone() },
    uRingIn: { value: def.ring?.inner ?? 0 }, uRingOut: { value: def.ring?.outer ?? 1 },
    uRingTau: { value: def.ring?.opacity ?? 0 }, uRingGain: { value: def.ring?.gain ?? 1 },
    uRingColA: { value: v3(def.ring?.colors[0] ?? [0, 0, 0]) }, uRingColB: { value: v3(def.ring?.colors[1] ?? [0, 0, 0]) },
  };
  const defines = { TYPE: TYPE_ID[def.type], NUM_BODIES: NUM };
  if (def.ring) defines.RING = 1;

  const mesh = new THREE.Mesh(shellGeo, new THREE.ShaderMaterial({
    vertexShader: BODY_VERT, fragmentShader: BODY_FRAG, uniforms, defines,
    transparent: true, premultipliedAlpha: true, depthTest: false, depthWrite: false,
  }));
  mesh.scale.setScalar(bound);
  mesh.frustumCulled = false;
  scene.add(mesh);

  return {
    def, mesh, uniforms,
    base: new THREE.Vector3(), center: new THREE.Vector3(),
    tilt: new THREE.Quaternion().setFromUnitVectors(Y_AXIS, axis),
    angle: def.spin0 ?? 0,
    phase: [rand() * 6.28, rand() * 6.28, rand() * 6.28],
  };
});

/* ── Sun ───────────────────────────────────────────────────────────────── */
const S = CONFIG.sun;
const sunUniforms = {
  uTime: shared.uTime, uPower: { value: 0 }, uEclipse: { value: 0 }, uSize: { value: S.spriteSize },
  uCore: { value: S.core }, uHalo: { value: S.halo }, uCorona: { value: S.corona }, uGlow: { value: S.glow },
  uZod: { value: S.zodiacal }, uCoronaBoost: { value: S.eclipseCoronaBoost },
  uColor: shared.uSunColor,
};
const sunMesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({
  vertexShader: SUN_VERT, fragmentShader: SUN_FRAG, uniforms: sunUniforms,
  blending: THREE.AdditiveBlending, transparent: true, depthTest: false, depthWrite: false,
}));
sunMesh.frustumCulled = false;
scene.add(sunMesh); // sorted by depth with the planets: far ones are drawn under it, near ones over it

/* ── Post ──────────────────────────────────────────────────────────────── */
const composer = new EffectComposer(renderer); // half-float (HDR) targets by default
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), CONFIG.post.bloomStrength, CONFIG.post.bloomRadius, CONFIG.post.bloomThreshold);
composer.addPass(bloom);
const finalPass = new ShaderPass(FINAL_SHADER);
composer.addPass(finalPass);
const fin = finalPass.uniforms;

/* ═══════════════════════════════════════════════════════════════════════════
   Layout & resize
   ═══════════════════════════════════════════════════════════════════════════ */
let camDistance = CONFIG.camera.distance;

function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  const dpr = Math.min(window.devicePixelRatio || 1, coarsePointer ? 1.5 : 2);
  renderer.setPixelRatio(dpr);
  renderer.setSize(w, h, false);
  composer.setPixelRatio(dpr);
  composer.setSize(w, h);
  fin.uRes.value.set(w * dpr, h * dpr);
  starUniforms.uDpr.value = dpr;

  const aspect = w / h;
  camera.aspect = aspect;
  camera.updateProjectionMatrix();

  // Portrait: mirror the composition across the diagonal and pull the camera back.
  const portrait = aspect < 0.9;
  const C = CONFIG.camera;
  camDistance = portrait
    ? Math.max(C.distance, C.portraitHalfHeight / tanHalfFov, C.portraitHalfWidth / (tanHalfFov * aspect))
    : Math.max(C.distance, C.landscapeHalfWidth / (tanHalfFov * aspect));
  for (const b of bodies) {
    const [x, y, z] = b.def.position;
    if (portrait && b.def.portraitPosition) b.base.fromArray(b.def.portraitPosition); // hand-placed override
    else b.base.set(portrait ? -y : x, portrait ? -x : y, z);
  }
}
window.addEventListener('resize', resize);
resize();

/* ═══════════════════════════════════════════════════════════════════════════
   Input — the cursor is the sun
   ═══════════════════════════════════════════════════════════════════════════ */
const pointer = { x: 0, y: 0, lastInput: 0, away: false, down: false, touch: false };
let clock = 0; // seconds of visible, running time

function setPointer(e) {
  pointer.x = (e.clientX / window.innerWidth) * 2 - 1;
  pointer.y = -(e.clientY / window.innerHeight) * 2 + 1;
  pointer.lastInput = clock;
  pointer.away = false;
  pointer.touch = e.pointerType === 'touch';
  idleMix = 0; // hand control back immediately; the spring keeps it smooth
}
window.addEventListener('pointermove', setPointer, { passive: true });
window.addEventListener('pointerdown', (e) => { if (ui.isUiTarget(e)) return; pointer.down = true; setPointer(e); }, { passive: true });
const release = () => { pointer.down = false; pointer.lastInput = clock; };
window.addEventListener('pointerup', release, { passive: true });
window.addEventListener('pointercancel', release, { passive: true });
document.documentElement.addEventListener('mouseleave', () => { pointer.away = true; });
window.addEventListener('blur', () => { pointer.away = true; pointer.down = false; });

/* ═══════════════════════════════════════════════════════════════════════════
   Simulation
   ═══════════════════════════════════════════════════════════════════════════ */
const sunNdc = new THREE.Vector2(0, 0), sunVel = new THREE.Vector2(0, 0), target = new THREE.Vector2(0, 0);
const camNdc = new THREE.Vector2(0, 0);
const sunPos = shared.uSunPos.value;
let idleMix = 0, idleT = 0, eclipse = 0;
const tmpA = new THREE.Vector3(), tmpB = new THREE.Vector3(), tmpQ = new THREE.Quaternion(), tmpM = new THREE.Matrix4();
const smooth = (x) => x * x * (3 - 2 * x);

function update(dt) {
  clock += dt;
  shared.uTime.value = clock;

  // ── where the sun wants to be: the cursor, or a slow Lissajous when idle
  const idleAfter = pointer.touch ? S.touchIdleAfter : S.idleAfter;
  const idle = !pointer.down && (pointer.away || clock - pointer.lastInput > idleAfter);
  if (idle) idleMix = Math.min(1, idleMix + dt / S.idleBlend);
  const k = smooth(idleMix);
  idleT += dt * k * (reducedMotion ? S.idleSpeedReduced : S.idleSpeed);
  target.set(
    THREE.MathUtils.lerp(pointer.x, S.idleExtent[0] * Math.sin(idleT * 0.23 + 0.6), k),
    THREE.MathUtils.lerp(pointer.y, S.idleExtent[1] * Math.sin(idleT * 0.31), k),
  );

  // ── damped spring (sub-stepped for stability)
  const w0 = S.springFreq, c = 2 * S.springDamping * w0, steps = Math.max(1, Math.ceil(dt / (1 / 120)));
  const h = dt / steps;
  for (let i = 0; i < steps; i++) {
    sunVel.x += (w0 * w0 * (target.x - sunNdc.x) - c * sunVel.x) * h;
    sunVel.y += (w0 * w0 * (target.y - sunNdc.y) - c * sunVel.y) * h;
    sunNdc.x += sunVel.x * h;
    sunNdc.y += sunVel.y * h;
  }

  // ── camera parallax, heavier still
  const ease = 1 - Math.exp(-dt * CONFIG.camera.parallaxEase);
  camNdc.x += (sunNdc.x - camNdc.x) * ease;
  camNdc.y += (sunNdc.y - camNdc.y) * ease;
  const maxA = THREE.MathUtils.degToRad(CONFIG.camera.parallaxDeg);
  const yaw = THREE.MathUtils.clamp(camNdc.x, -1, 1) * maxA, pitch = THREE.MathUtils.clamp(camNdc.y, -1, 1) * maxA * 0.7;
  camera.position.set(Math.sin(yaw) * camDistance, Math.sin(pitch) * camDistance, Math.cos(yaw) * Math.cos(pitch) * camDistance);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  sky.position.copy(camera.position);
  stars.position.copy(camera.position);

  // ── sun: unproject the (sprung) cursor onto the plane z = 0
  tmpA.set(sunNdc.x, sunNdc.y, 0.5).unproject(camera).sub(camera.position);
  sunPos.copy(camera.position).addScaledVector(tmpA, -camera.position.z / tmpA.z);
  sunMesh.position.copy(sunPos);

  // ── intro: the sun fades in at the center
  const intro = Math.min(clock / S.introSeconds, 1);
  const introK = 1 - Math.pow(1 - intro, 3);
  shared.uSunPower.value = S.power * introK;
  sunUniforms.uPower.value = introK;
  fin.uFade.value = smooth(Math.min(clock / (S.introSeconds * 0.9), 1));

  // ── bodies: spin, drift, publish positions for shadows
  const D = CONFIG.drift;
  let visible = 1;
  bodies.forEach((b, i) => {
    const t = clock * D.speed;
    b.center.set(
      b.base.x + Math.sin(t + b.phase[0]) * D.amount,
      b.base.y + Math.sin(t * 0.8 + b.phase[1]) * D.amount,
      b.base.z + Math.sin(t * 0.6 + b.phase[2]) * D.amount,
    );
    b.mesh.position.copy(b.center);
    b.uniforms.uCenter.value.copy(b.center);
    shared.uBodies.value[i].set(b.center.x, b.center.y, b.center.z, b.def.radius);

    b.angle += b.def.spin * dt;
    tmpQ.setFromAxisAngle(Y_AXIS, b.angle).premultiply(b.tilt);
    b.uniforms.uRot.value.setFromMatrix4(tmpM.makeRotationFromQuaternion(tmpQ)).transpose();

    // how much of the sun's disc does this body hide from the camera?
    tmpA.copy(sunPos).sub(camera.position);
    const len = tmpA.length(); tmpA.divideScalar(len);
    const along = tmpB.copy(b.center).sub(camera.position).dot(tmpA);
    if (along > 0 && along < len) {
      const d = tmpB.addScaledVector(tmpA, -along).length();
      visible *= THREE.MathUtils.smoothstep(d, b.def.radius - 0.04, b.def.radius + 0.07);
    }
  });

  // ── eclipse: corona swells and exposure opens up, like an eye adapting
  eclipse += ((1 - visible) - eclipse) * (1 - Math.exp(-dt * 5));
  sunUniforms.uEclipse.value = eclipse;
  fin.uExposure.value = CONFIG.post.exposure * (1 + S.eclipseExposureBoost * eclipse);
  fin.uSunVis.value = visible * introK;
  tmpA.copy(sunPos).project(camera);
  fin.uSun.value.set(tmpA.x * 0.5 + 0.5, tmpA.y * 0.5 + 0.5);

  // ── reduced motion: no twinkle, frozen grain
  starUniforms.uTwinkle.value = reducedMotion ? 0 : CONFIG.stars.twinkle;
  fin.uSeed.value = reducedMotion ? 0 : (clock * 24 % 1000) | 0; // grain at 24 fps, like film
}

/* ═══════════════════════════════════════════════════════════════════════════
   Loop — paused while the tab is hidden
   ═══════════════════════════════════════════════════════════════════════════ */
let raf = 0, last = 0;
function frame(now) {
  raf = requestAnimationFrame(frame);
  const dt = Math.min((now - last) / 1000, 1 / 20);
  last = now;
  update(dt);
  composer.render();
}
function play() { if (!raf) { last = performance.now(); raf = requestAnimationFrame(frame); } }
function pause() { cancelAnimationFrame(raf); raf = 0; }
document.addEventListener('visibilitychange', () => (document.hidden ? pause() : play()));
canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); pause(); });
canvas.addEventListener('webglcontextrestored', () => { bakeSky(); play(); });
if (!document.hidden) play();

// Inspection hook for automated tests: only present with ?debug in the URL.
if (new URLSearchParams(location.search).has('debug')) {
  window.__space = {
    camera, bodies, sunNdc, sunPos, pointer, starUniforms, fin, renderer,
    get idleMix() { return idleMix; }, get eclipse() { return eclipse; }, get reducedMotion() { return reducedMotion; },
  };
}

} // start()
