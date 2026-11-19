/* ============================================================================
   HOLD SPACE
   Floating still among the stars. Hold the spacebar (or the mouse, or a finger)
   to accelerate; let go to coast to a stop somewhere new.

   The starfield is an infinite volume: stars are hashed out of spatial cells
   around the camera in the vertex shader, so there is nothing to load and
   nothing loops. The journey is one number, the throttle s in [0,1]; every
   visual regime (streaks, field of view, aberration, Doppler shift, beaming)
   is a continuous function of it.

   Places are real objects in the world. The one you leave stays where it is
   and slides away behind you; the next is set down far ahead the moment you
   let go, and you glide into it from a point of light.

   Debug query flags (for testing only):
     ?seed=42        fix the per-visit seed
     ?dest=nebula    open at, and always arrive at, one destination type
                     (star | binary | cluster | nebula | blackhole | galaxy)
     ?speed=0.8      lock the throttle at a value in [0,1] (regime preview)
     ?fps            record frame rate in window.__holdSpace.samples
     ?still          no idle camera sway
     ?reduced        force reduced-motion      ?nowebgl   force the fallback
   ============================================================================ */
import * as THREE from 'three';
import { mountUI } from '../ui/ui.js';

const ui = mountUI({ id: 'hold-space' });

/* ----------------------------------------------------------------------------
   CONFIG: every tunable in one place.
   ---------------------------------------------------------------------------- */
const CONFIG = {
  // ---- the journey ----
  journey: {
    // Throttle while holding: s = 1 - exp(-(t / riseTime)^risePower). Slow at first, then building.
    riseTime: 5.0, risePower: 2.0,
    // The throttle drives two speeds. The starfield's (in its own cell units) sets how motion looks.
    starSpeed: { max: 150, curve: 5.0, linear: 0.02 },
    // Travel through places is far faster, and back-loaded: you barely move while turning away, then
    // cover enough ground that the next place starts as a point. v0 * (s / atS)^power, then up to max.
    travel: { atS: 0.237, v0: 220, power: 4, max: 30000 },
    // Departure: each hold swings the heading off where you are, just enough that the path is clear.
    turn: { min: 16, max: 75, step: 2, margin: 1.6, time: 1.9, perDeg: 0.02 },   // degrees; x bound radius; seconds + per degree
    // Glide: ease down through the regimes (base + perS * throttle drop, seconds), then a final approach
    // scaled to the place: over the last `tail` seconds the remaining distance is depth * approach * tau^2.
    glide: { base: 2.6, perS: 3.5, approach: 0.25, tail: 4.5 },
    commit: 0.085,          // letting go below this throttle is a tap: swing back and settle
    spawnMin: 0.21,         // letting go between commit and this: the jump runs on to here, then glides
    // Narrative speed for the HUD, light-years / s = lyBase * exp(lyCurve * s).
    lyBase: 0.5, lyCurve: 13,
  },

  // ---- speed regimes (all in throttle units, all blended) ----
  regimes: {
    streakShort: [0.07, 0.30, 0.030], // cruise: shutter time rises to this many seconds
    streakLong: [0.30, 0.78, 0.075],  // fast: and then by this much more
    streakDim: 0.62,                  // how much a streak dims as it lengthens (0 = not at all)
    fov: [55, 80], fovRange: [0.30, 1.0],
    vignette: [0.30, 0.72], vignetteRange: [0.28, 0.9],
    relativity: [0.55, 1.0],          // aberration / Doppler / beaming ramp in over this range
  },

  // ---- relativistic effects at full speed ----
  relativity: {
    betaMax: 0.93,       // v / c at full throttle
    betaPower: 1.35,     // shape of the ramp
    dopplerNorm: 0.86,   // 0 = physical Doppler factor, 1 = re-centred so the view edge reddens (artistic)
    dopplerColor: 1.5,   // colour temperature scales with D^this
    beaming: 1.1,        // brightness scales with D^this
    skyBeaming: 1.6,
    haze: 0.05,          // faint blue glow dead ahead
  },

  // ---- the starfield: nested layers of hashed cells, each ~5x larger than the last ----
  stars: {
    grid: 10,                                  // cells per axis around the camera (fade ends at 3.9 cells)
    layers: [                                  // cell size (units), stars per cell, brightness
      { cell: 3, perCell: 26, lum: 1.0 },
      { cell: 14, perCell: 26, lum: 1.0 },
      { cell: 70, perCell: 26, lum: 1.0 },
      { cell: 3000, perCell: 64, lum: 0.75 },  // the far field: barely moves at any speed
    ],
    mobileScale: 0.6,
    twinkle: 0.1,
    saturation: 0.72,
  },

  // ---- Milky Way band ----
  sky: { gain: 1.0, milkyWay: 0.045, turnPerUnit: 0.00035 },

  // ---- destinations: chosen by how far the hop went (light-years) ----
  destinations: {
    // hop distance below ladder[i] picks tier i; beyond the last: the galaxy from outside
    ladder: [40, 4000, 60000, 600000],
    tiers: [['star'], ['binary', 'cluster'], ['nebula'], ['blackhole'], ['galaxy']],
    home: 'star',                // what the page opens on
    nebulaSteps: { desktop: 48, mobile: 28 },
    clusterStars: { desktop: 7000, mobile: 3500 },
    galaxyStars: { desktop: 150000, mobile: 60000 },
  },

  // ---- camera ----
  camera: {
    parallaxDeg: [2.6, 1.8], parallaxInertia: 0.9,
    sway: { yaw: 0.5, pitch: 0.35, roll: 0.6, pos: 0.22 },   // idle drift: degrees, degrees, degrees, units
  },

  // ---- grade ----
  bloom: { strength: 0.5, threshold: 0.9, knee: 0.6, radius: 0.62, levels: 6 },
  grain: 0.032,
  exposure: 1.0,

  // ---- quality ----
  quality: {
    maxDpr: { desktop: 2.0, mobile: 1.5 },
    ladder: [1.0, 0.85, 0.72, 0.6, 0.5],   // render scale steps, taken when fps < minFps
    minFps: 50,
  },

  hud: { show: 5.5 },        // seconds the distance line stays
  reducedMotion: { fade: 0.6, coastSpeedup: 6 },
};

/* ---------------------------------------------------------------------------- */
const params = new URLSearchParams(location.search);
const REDUCED = params.has('reduced') || matchMedia('(prefers-reduced-motion: reduce)').matches;
const MOBILE = matchMedia('(pointer: coarse)').matches || Math.min(screen.width, screen.height) < 600;
const SEED = params.has('seed') ? (parseInt(params.get('seed'), 10) | 0) : (Math.random() * 2 ** 30) | 0;
const TAU = Math.PI * 2, DEG = Math.PI / 180;
const canvas = document.getElementById('stage');

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const mix = (a, b, t) => a + (b - a) * t;
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const fl = (x) => Number(x).toFixed(5);
function mulberry32(a) {
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
/** Black-body colour (Tanner Helland's fit), normalised, as [r,g,b]. */
function blackbody(K) {
  const t = K / 100;
  const r = t <= 66 ? 1 : clamp(1.292936186 * Math.pow(t - 60, -0.1332047592), 0, 1);
  const g = t <= 66 ? clamp(0.390081579 * Math.log(t) - 0.631841444, 0, 1) : clamp(1.129890861 * Math.pow(t - 60, -0.0755148492), 0, 1);
  const b = t >= 66 ? 1 : t <= 19 ? 0 : clamp(0.543206789 * Math.log(t - 10) - 1.196254089, 0, 1);
  return [r, g, b];
}
const starColor = (K, sat = 0.8) => blackbody(K).map((c) => mix(1, c, sat));

/* ---- journey curves ---- */
const JC = CONFIG.journey, SS = JC.starSpeed, TV = JC.travel;
const throttleAt = (t) => 1 - Math.exp(-Math.pow(t / JC.riseTime, JC.risePower));
const holdTimeFor = (s) => JC.riseTime * Math.pow(-Math.log(1 - Math.min(s, 0.9999)), 1 / JC.risePower);
const starSpeedAt = (s) => SS.max * (SS.linear * s + (1 - SS.linear) * (Math.exp(SS.curve * s) - 1) / (Math.exp(SS.curve) - 1));
// Above atS, log-speed rises as 1 - (1 - x)^m, with m chosen so its slope matches the power law below.
const TV_L = Math.log(TV.max / TV.v0), TV_M = (TV.power / TV.atS) * (1 - TV.atS) / TV_L;
const travelAt = (s) => (s <= 0 ? 0 : s < TV.atS ? TV.v0 * (s / TV.atS) ** TV.power
  : TV.v0 * Math.exp(TV_L * (1 - Math.pow(1 - Math.min((s - TV.atS) / (1 - TV.atS), 1), TV_M))));
const travelSlope = (s) => (travelAt(s + 1e-4) - travelAt(Math.max(0, s - 1e-4))) / (s + 1e-4 - Math.max(0, s - 1e-4));
function throttleFor(v) { let lo = 0, hi = 1; for (let i = 0; i < 40; i++) { const m = (lo + hi) / 2; if (travelAt(m) < v) lo = m; else hi = m; } return (lo + hi) / 2; }
const lyRateAt = (s) => (s <= 0 ? 0 : JC.lyBase * Math.exp(JC.lyCurve * s) * smooth(0, 0.03, s));
const smoother = (x) => { x = clamp(x, 0, 1); return x * x * x * (x * (x * 6 - 15) + 10); };
function formatLy(ly) {
  if (ly < 10) return ly.toFixed(1);
  if (ly < 1000) return Math.round(ly).toString();
  const p = Math.pow(10, Math.floor(Math.log10(ly)) - 2);
  return (Math.round(ly / p) * p).toLocaleString('en-US');
}

/* ----------------------------------------------------------------------------
   Fallback: no WebGL (or it failed). A calm static page with the text.
   ---------------------------------------------------------------------------- */
function fallback() {
  document.body.classList.remove('live');
  ui.showHint(false).message(null);
  document.body.classList.add('fallback');
}

/* ============================================================================
   GLSL
   ============================================================================ */
const GLSL_NOISE = /* glsl */`
  float hash13(vec3 p){ p = fract(p * .1031); p += dot(p, p.zyx + 31.32); return fract((p.x + p.y) * p.z); }
  float hash12(vec2 p){ vec3 q = fract(vec3(p.xyx) * .1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
  float vnoise(vec3 p){
    vec3 i = floor(p), f = fract(p); f = f * f * (3. - 2. * f);
    return mix(mix(mix(hash13(i), hash13(i + vec3(1,0,0)), f.x), mix(hash13(i + vec3(0,1,0)), hash13(i + vec3(1,1,0)), f.x), f.y),
               mix(mix(hash13(i + vec3(0,0,1)), hash13(i + vec3(1,0,1)), f.x), mix(hash13(i + vec3(0,1,1)), hash13(i + vec3(1,1,1)), f.x), f.y), f.z);
  }
  float fbm(vec3 p){ float a = .5, s = 0.; for (int i = 0; i < 5; i++){ s += a * vnoise(p); p = p * 2.03 + vec3(17.1, 3.7, 9.2); a *= .5; } return s; }
  float fbm3(vec3 p){ float a = .5, s = 0.; for (int i = 0; i < 3; i++){ s += a * vnoise(p); p = p * 2.03 + vec3(17.1, 3.7, 9.2); a *= .5; } return s / .875; }
`;

// Black-body colour in GLSL, so the Doppler shift can act on temperature.
const GLSL_BLACKBODY = /* glsl */`
  vec3 blackbody(float K){
    float t = clamp(K, 1000., 40000.) / 100.;
    float r = t <= 66. ? 1. : clamp(1.292936186 * pow(t - 60., -.1332047592), 0., 1.);
    float g = t <= 66. ? clamp(.390081579 * log(t) - .631841444, 0., 1.) : clamp(1.129890861 * pow(t - 60., -.0755148492), 0., 1.);
    float b = t >= 66. ? 1. : (t <= 19. ? 0. : clamp(.543206789 * log(t - 10.) - 1.196254089, 0., 1.));
    return vec3(r, g, b);
  }
`;

// Relativistic aberration + Doppler factor, shared by every star shader.
// p is a view-space position in the rest frame; the result is where it is seen.
const GLSL_RELATIVITY = /* glsl */`
  uniform vec3 uVelDir; uniform float uBeta, uGamma, uDnorm;
  vec3 aberrate(vec3 p, out float D){
    float d = length(p); vec3 n = p / max(d, 1e-6);
    float c = dot(n, uVelDir);
    vec3 perp = n - c * uVelDir; float s = length(perp);
    float c2 = (c + uBeta) / (1. + uBeta * c);                 // cos of the observed angle
    D = uGamma * (1. + uBeta * c) * uDnorm;                    // Doppler factor (re-centred)
    return (c2 * uVelDir + (s > 1e-5 ? perp / s : vec3(0.)) * sqrt(max(0., 1. - c2 * c2))) * d;
  }
`;

const GLSL_RING = /* glsl */`
  float ringDensity(float rad, vec2 span){
    float x = (rad - span.x) / (span.y - span.x);
    if (x < 0. || x > 1.) return 0.;
    float d = smoothstep(0., .05, x) * (1. - smoothstep(.95, 1., x));
    d *= .7 + .3 * sin(x * 17. + sin(x * 7.) * 1.5);
    d *= 1. - .92 * (smoothstep(.585, .61, x) - smoothstep(.665, .69, x));
    d *= mix(.3, 1., smoothstep(.12, .3, x));
    return d;
  }
`;

const FULLSCREEN_VERT = /* glsl */`
  varying vec2 vUv;
  void main(){ vUv = position.xy * .5 + .5; gl_Position = vec4(position.xy, 0., 1.); }
`;
const SPRITE_FRAG = /* glsl */`
  varying vec3 vCol;
  void main(){ vec2 q = gl_PointCoord - .5; float a = exp(-dot(q, q) * 16.) - .018; if (a <= 0.) discard; gl_FragColor = vec4(vCol * a, 1.); }
`;
const ADD = { transparent: true, depthWrite: false, blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor };

/* ============================================================================
   The piece
   ============================================================================ */
function start() {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false, depth: false, stencil: false, powerPreference: 'high-performance' });
  const gl = renderer.getContext();
  if (!renderer.capabilities.isWebGL2) throw new Error('WebGL2 required');
  if (!gl.getExtension('EXT_color_buffer_float') && !gl.getExtension('EXT_color_buffer_half_float')) throw new Error('no HDR targets');
  renderer.autoClear = false;
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.setClearColor(0x000000, 1);

  const Q = CONFIG.quality, DC = CONFIG.destinations;
  const dprCap = MOBILE ? Q.maxDpr.mobile : Q.maxDpr.desktop;
  let qualityLevel = 0;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(CONFIG.regimes.fov[0], 1, 0.05, 3e6);     // always at the origin: the world moves
  const visitRng = mulberry32(SEED);

  /* ---- fullscreen-pass helper ---- */
  const passGeo = new THREE.BufferGeometry();
  passGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
  const passMesh = new THREE.Mesh(passGeo); passMesh.frustumCulled = false;
  const passScene = new THREE.Scene(); passScene.add(passMesh);
  const passCam = new THREE.Camera();
  function runPass(material, target, clear = true) {
    passMesh.material = material;
    renderer.setRenderTarget(target);
    if (clear) renderer.clear();
    renderer.render(passScene, passCam);
  }
  const passMat = (fragmentShader, uniforms, extra = {}) =>
    new THREE.ShaderMaterial({ vertexShader: FULLSCREEN_VERT, fragmentShader, uniforms, depthTest: false, depthWrite: false, ...extra });

  /* ---- uniforms shared by many materials ---- */
  const U = {
    time: { value: 0 },                                   // seconds, wall clock
    cam: { value: new THREE.Matrix3() },                  // view -> world rotation
    view: { value: new THREE.Matrix3() },                 // world -> view rotation
    tan: { value: new THREE.Vector2(1, 1) },              // (tan(fov/2) * aspect, tan(fov/2))
    res: { value: new THREE.Vector2(1, 1) },              // drawing buffer size
    dpr: { value: 1 },
    pxScale: { value: 1 },                                // pixels per unit at distance 1
    velDir: { value: new THREE.Vector3(0, 0, -1) },       // direction of travel, view space
    velW: { value: new THREE.Vector3(0, 0, -1) },         // direction of travel, world space
    beta: { value: 0 }, gamma: { value: 1 }, dnorm: { value: 1 },
    twinkle: { value: REDUCED ? 0 : CONFIG.stars.twinkle },
  };
  const REL_UNIFORMS = { uVelDir: U.velDir, uBeta: U.beta, uGamma: U.gamma, uDnorm: U.dnorm };

  /* --------------------------------------------------------------------------
     Baked procedural textures
     -------------------------------------------------------------------------- */
  // 1. Tileable 2D fbm (four decorrelated channels): accretion disk, galaxy dust.
  const noiseRT = new THREE.WebGLRenderTarget(512, 512, {
    wrapS: THREE.RepeatWrapping, wrapT: THREE.RepeatWrapping, generateMipmaps: true,
    minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false,
  });
  runPass(passMat(/* glsl */`
    varying vec2 vUv;
    float h(vec2 p, float s){ vec3 q = fract(vec3(p.xyx) * .1031 + s); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
    float pn(vec2 p, float per, float s){
      vec2 i = floor(p), f = fract(p); f = f * f * (3. - 2. * f);
      vec2 a = mod(i, per), b = mod(i + 1., per);
      return mix(mix(h(a, s), h(vec2(b.x, a.y), s), f.x), mix(h(vec2(a.x, b.y), s), h(b, s), f.x), f.y);
    }
    float pfbm(vec2 uv, float s){ float per = 6., a = .5, v = 0.; for (int i = 0; i < 5; i++){ v += a * pn(uv * per, per, s + float(i) * 1.7); per *= 2.; a *= .5; } return v / .97; }
    void main(){ gl_FragColor = vec4(pfbm(vUv, .11), pfbm(vUv, .37), pfbm(vUv, .59), pfbm(vUv, .83)); }
  `, {}), noiseRT);

  // 2. Tileable 3D fbm, built on the CPU once: the nebula is marched through this.
  const noise3D = (() => {
    const N = 64, data = new Uint8Array(N * N * N), acc = new Float32Array(N * N * N), r = mulberry32(SEED ^ 0x5bd1e995);
    let amp = 0.5;
    for (let period = 4; period <= 32; period *= 2, amp *= 0.5) {
      const lat = new Float32Array(period * period * period); for (let i = 0; i < lat.length; i++) lat[i] = r();
      const step = period / N, at = (x, y, z) => lat[(z % period) * period * period + (y % period) * period + (x % period)];
      for (let z = 0, i = 0; z < N; z++) {
        const fz = z * step, z0 = Math.floor(fz); let tz = fz - z0; tz = tz * tz * (3 - 2 * tz);
        for (let y = 0; y < N; y++) {
          const fy = y * step, y0 = Math.floor(fy); let ty = fy - y0; ty = ty * ty * (3 - 2 * ty);
          for (let x = 0; x < N; x++, i++) {
            const fx = x * step, x0 = Math.floor(fx); let tx = fx - x0; tx = tx * tx * (3 - 2 * tx);
            const a = mix(mix(at(x0, y0, z0), at(x0 + 1, y0, z0), tx), mix(at(x0, y0 + 1, z0), at(x0 + 1, y0 + 1, z0), tx), ty);
            const b = mix(mix(at(x0, y0, z0 + 1), at(x0 + 1, y0, z0 + 1), tx), mix(at(x0, y0 + 1, z0 + 1), at(x0 + 1, y0 + 1, z0 + 1), tx), ty);
            acc[i] += amp * mix(a, b, tz);
          }
        }
      }
    }
    let lo = 1, hi = 0; for (const v of acc) { if (v < lo) lo = v; if (v > hi) hi = v; }
    for (let i = 0; i < acc.length; i++) data[i] = Math.round(((acc[i] - lo) / (hi - lo)) * 255);
    const tex = new THREE.Data3DTexture(data, N, N, N);
    tex.format = THREE.RedFormat; tex.type = THREE.UnsignedByteType; tex.minFilter = tex.magFilter = THREE.LinearFilter;
    tex.wrapS = tex.wrapT = tex.wrapR = THREE.RepeatWrapping; tex.unpackAlignment = 1; tex.needsUpdate = true;
    return tex;
  })();

  // 3. The Milky Way band as an equirectangular HDR map in galactic coordinates (band along the equator).
  const skyRT = new THREE.WebGLRenderTarget(MOBILE ? 2048 : 4096, MOBILE ? 1024 : 2048, {
    type: THREE.HalfFloatType, wrapS: THREE.RepeatWrapping, wrapT: THREE.ClampToEdgeWrapping,
    minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false,
  });
  runPass(passMat(/* glsl */`
    varying vec2 vUv; uniform vec3 uOff;
    ${GLSL_NOISE}
    void main(){
      float lon = (vUv.x - .5) * 6.2831853, lat = (vUv.y - .5) * 3.14159265;
      vec3 g = vec3(cos(lat) * cos(lon), sin(lat), cos(lat) * sin(lon));
      float b = asin(clamp(g.y, -1., 1.)), l = atan(g.z, g.x);
      vec3 q = g + uOff;
      // several noise scales, multiplied and layered so nothing reads as a blotch
      float n1 = fbm(q * 2.2 + 4.), n2 = fbm(q * 5.5 + n1 * 1.5), n3 = fbm(q * 13. + 9.), n4 = fbm(q * 31.);
      float bb = b + .05 * (n1 - .5) + .02 * (n2 - .5);                       // the band wanders a little
      float band = exp(-pow(abs(bb) / .105, 1.5));
      float toward = .4 + .6 * (.5 + .5 * cos(l));                             // brighter towards the galactic centre
      float bulge = exp(-(l * l / .45 + bb * bb / .02));
      float glow = band * toward * (.3 + 1.4 * n1 * n2) * (.7 + .6 * n3) * (.85 + .3 * n4) + bulge * .8 * (.6 + .8 * n2);
      // dust: clouds stretched along the plane, thick near the midline, with finer filaments inside
      vec3 qs = vec3(q.x, q.y * 3.6, q.z);
      float d1 = smoothstep(.40, .66, fbm(qs * 3.6 + vec3(3.1, 7.7, 1.3) + .8 * n1));
      float d2 = smoothstep(.45, .7, fbm(qs * 10. + vec3(8.2, 1.9, 4.4) + .5 * n2));
      float dust = clamp(d1 + .45 * d2, 0., 1.) * exp(-pow(abs(bb) / .06, 2.));
      glow *= 1. - .8 * dust;
      vec3 col = mix(vec3(.55, .68, 1.), vec3(1., .85, .68), clamp(bulge * 1.2 + (n1 - .35) * .8 + .2 * toward, 0., 1.));
      col = mix(col, vec3(.9, .5, .32), .4 * dust);                            // reddened near the dust
      gl_FragColor = vec4(col * glow * ${fl(CONFIG.sky.milkyWay)}, 1.);
    }
  `, { uOff: { value: new THREE.Vector3(visitRng() * 40, visitRng() * 40, visitRng() * 40) } }), skyRT);

  /* --------------------------------------------------------------------------
     Sky: the Milky Way, drawn as a fullscreen layer so aberration can be exact
     -------------------------------------------------------------------------- */
  const skyU = { tSky: { value: skyRT.texture }, uCam: U.cam, uTan: U.tan, uVelW: U.velW, uBeta: U.beta, uGamma: U.gamma, uDnorm: U.dnorm, uSky: { value: new THREE.Matrix3() }, uGain: { value: 1 } };
  const skyMesh = new THREE.Mesh(passGeo, new THREE.ShaderMaterial({
    depthTest: false, depthWrite: false, uniforms: skyU, vertexShader: FULLSCREEN_VERT,
    fragmentShader: /* glsl */`
      varying vec2 vUv; uniform sampler2D tSky; uniform mat3 uCam, uSky; uniform vec2 uTan; uniform vec3 uVelW; uniform float uBeta, uGamma, uDnorm, uGain;
      void main(){
        vec3 n = normalize(uCam * vec3((vUv * 2. - 1.) * uTan, -1.));         // where we look
        float c2 = dot(n, uVelW); vec3 perp = n - c2 * uVelW; float s2 = length(perp);
        float c = (c2 - uBeta) / (1. - uBeta * c2);                            // where that light really came from
        vec3 r = c * uVelW + (s2 > 1e-5 ? perp / s2 : vec3(0.)) * sqrt(max(0., 1. - c * c));
        float D = uDnorm / (uGamma * (1. - uBeta * c2));
        vec3 g = uSky * r;
        vec2 uv = vec2(atan(g.z, g.x) / 6.2831853 + .5, asin(clamp(g.y, -1., 1.)) / 3.14159265 + .5);
        vec3 tint = D > 1. ? mix(vec3(1.), vec3(.62, .78, 1.3), clamp((D - 1.) * .8, 0., 1.)) : mix(vec3(1.), vec3(1.3, .5, .28), clamp((1. - D) * 1.6, 0., 1.));
        gl_FragColor = vec4(textureLod(tSky, uv, 0.).rgb * tint * pow(D, ${fl(CONFIG.relativity.skyBeaming)}) * uGain, 1.);
      }`,
  }));
  skyMesh.frustumCulled = false; skyMesh.renderOrder = -30; scene.add(skyMesh);
  const skyBase = new THREE.Quaternion().setFromEuler(new THREE.Euler(visitRng() * TAU, visitRng() * TAU, visitRng() * TAU));
  const skyAxis = new THREE.Vector3(visitRng() - 0.5, visitRng() - 0.5, (visitRng() - 0.5) * 0.3).normalize();

  /* --------------------------------------------------------------------------
     The starfield: instanced quads, hashed out of spatial cells in the vertex
     shader. A star is a capsule from where it is to where it was one shutter
     ago, so streaks are real motion blur, not an effect.
     -------------------------------------------------------------------------- */
  const SC = CONFIG.stars, G = SC.grid;
  const STAR_VERT = /* glsl */`
    attribute float aId;
    uniform ivec3 uCell; uniform vec3 uFrac, uTrail; uniform mat3 uView;
    uniform float uCellSize, uLum, uDensity, uTime, uTwinkle, uDpr, uSeed, uLayer; uniform int uK; uniform vec2 uRes;
    varying vec3 vCol; varying vec2 vQ, vRot; varying vec4 vP;
    ${GLSL_BLACKBODY} ${GLSL_RELATIVITY}
    uvec3 pcg3d(uvec3 v){
      v = v * 1664525u + 1013904223u; v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
      v ^= v >> 16u; v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y; return v;
    }
    const float INV = 1. / 4294967296.;
    void main(){
      gl_Position = vec4(2., 2., 2., 1.); vCol = vec3(0.); vQ = vec2(0.); vRot = vec2(1., 0.); vP = vec4(0., 1., 1., 0.);
      // which cell, which star in it
      int id = int(aId + .5), k = id % uK, c = id / uK;
      ivec3 off = ivec3(c % ${G}, (c / ${G}) % ${G}, c / ${G * G}) - ${G / 2};
      uvec3 h1 = pcg3d(uvec3(uCell + off) + uvec3(uint(k) * 7919u, uint(uLayer) * 104729u, uint(uSeed)));
      uvec3 h2 = pcg3d(h1 ^ uvec3(0x9E3779B9u, 0x85EBCA6Bu, 0xC2B2AE35u));
      uvec3 h3 = pcg3d(h2 + 77u);
      vec3 r1 = vec3(h1) * INV, r2 = vec3(h2) * INV, r3 = vec3(h3) * INV;

      vec3 rel = vec3(off) + r1 - uFrac;                          // camera-relative, in cells
      float dc = length(rel);
      // fade with distance (so cells never pop), very near the lens, and with the local star density
      float fade = (1. - smoothstep(2.9, 3.9, dc)) * smoothstep(.012, .07, dc) * clamp((uDensity - r3.x) / .06, 0., 1.);
      if (fade <= 0.) return;

      // rest-frame positions now and one shutter ago, then relativistic aberration on both
      vec3 pA = uView * rel * uCellSize, pB = pA + uTrail;
      float D, D2; vec3 a = aberrate(pA, D), b = aberrate(pB, D2);
      vec4 ca = projectionMatrix * vec4(a, 1.), cb = projectionMatrix * vec4(b, 1.);
      if (ca.w <= 1e-4 || cb.w <= 1e-4) return;
      vec2 sa = ca.xy / ca.w * .5 * uRes, sb = cb.xy / cb.w * .5 * uRes;
      vec2 dlt = sb - sa; float len = length(dlt);
      vec2 t = len > .01 ? dlt / len : vec2(1., 0.), nrm = vec2(-t.y, t.x);

      // apparent brightness: luminosity (steep power law: mostly faint) over distance squared
      float lum = uLum * .013 * pow(max(r2.x, .004), -1.1);
      float f = min(lum / max(dc * dc, .02), 80.);
      float K = 2700. + 6500. * pow(r2.y, 1.7) + step(.86, r2.z) * 11000. * r3.y;
      // Doppler: temperature and brightness both follow D
      vec3 col = mix(vec3(1.), blackbody(K * pow(D, ${fl(CONFIG.relativity.dopplerColor)})), ${fl(SC.saturation)});
      f *= pow(D, ${fl(CONFIG.relativity.beaming)});
      f *= 1. + uTwinkle * sin(uTime * (1.3 + r3.y * 4.) + r3.z * 60.) * sin(uTime * (.7 + r3.z * 2.) + r3.y * 31.);

      float core = 1. + .55 * clamp(log2(1. + f * 2.), 0., 3.5);           // px (before dpr)
      core = mix(core, min(core, 1.25), smoothstep(4., 60., len / uDpr));  // streaks stay fine
      float spike = smoothstep(1.5, 10., f) * (1. - smoothstep(2., 30., len / uDpr));
      float halo = 10. + 26. * smoothstep(1.5, 25., f);
      float I = f * 2.2 / (core * core) / pow(1. + len / (2. * core * uDpr), ${fl(CONFIG.regimes.streakDim)});
      float R = uDpr * max(core * 3., halo * step(.001, spike));

      vec2 px = mix(sa, sb, position.x) + t * (position.x * 2. - 1.) * R + nrm * position.y * R;
      gl_Position = vec4(px / (.5 * uRes), ca.z / ca.w, 1.);
      vQ = vec2(position.x * len + (position.x * 2. - 1.) * R, position.y * R);
      vRot = t; vP = vec4(len, core * uDpr, halo * uDpr, spike); vCol = col * I * fade;
    }`;
  const STAR_FRAG = /* glsl */`
    varying vec3 vCol; varying vec2 vQ, vRot; varying vec4 vP;
    void main(){
      vec2 q = vec2(vQ.x - clamp(vQ.x, 0., vP.x), vQ.y);                // distance to the streak segment
      float d2 = dot(q, q), a = exp(-d2 / (vP.y * vP.y));
      if (vP.w > 0.){                                                   // bright stars: halo + diffraction spikes
        vec2 s = vec2(vRot.x * q.x - vRot.y * q.y, vRot.y * q.x + vRot.x * q.y);
        float edge = clamp(1. - sqrt(d2) / vP.z, 0., 1.);
        float sp = exp(-abs(s.y) / (vP.y * .7)) * exp(-abs(s.x) / (vP.z * .3)) + exp(-abs(s.x) / (vP.y * .7)) * exp(-abs(s.y) / (vP.z * .3));
        a += vP.w * (.05 / (1. + d2 / (vP.y * vP.y) * .35) + .2 * sp) * edge * edge;
      }
      gl_FragColor = vec4(vCol * a, 1.);
    }`;
  const quad = { pos: new Float32Array([0, -1, 0, 1, -1, 0, 1, 1, 0, 0, 1, 0]), idx: [0, 1, 2, 0, 2, 3] };
  const starLayers = SC.layers.map((L, i) => {
    const perCell = Math.max(4, Math.round(L.perCell * (MOBILE ? SC.mobileScale : 1))), n = G * G * G * perCell;
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(quad.pos, 3)); g.setIndex(quad.idx);
    const ids = new Float32Array(n); for (let j = 0; j < n; j++) ids[j] = j;
    g.setAttribute('aId', new THREE.InstancedBufferAttribute(ids, 1)); g.instanceCount = n;
    const u = {
      uCell: { value: new THREE.Vector3() }, uFrac: { value: new THREE.Vector3() }, uTrail: { value: new THREE.Vector3() }, uView: U.view,
      uCellSize: { value: L.cell }, uLum: { value: L.lum }, uDensity: { value: 1 }, uTime: U.time, uTwinkle: U.twinkle, uDpr: U.dpr,
      uSeed: { value: SEED & 0xffff }, uLayer: { value: i + 1 }, uK: { value: perCell }, uRes: U.res, ...REL_UNIFORMS,
    };
    const m = new THREE.Mesh(g, new THREE.ShaderMaterial({ ...ADD, depthTest: true, uniforms: u, vertexShader: STAR_VERT, fragmentShader: STAR_FRAG }));
    m.frustumCulled = false; m.renderOrder = -20; scene.add(m);
    return { cfg: L, u };
  });

  /* --------------------------------------------------------------------------
     Shared building blocks for places
     -------------------------------------------------------------------------- */
  // One pool of random numbers per point; each point-cloud shader turns them into a shape.
  const POOL = Math.max(MOBILE ? DC.galaxyStars.mobile : DC.galaxyStars.desktop, 8000);
  const poolA = new Float32Array(POOL * 4), poolB = new Float32Array(POOL * 4);
  { const r = mulberry32(SEED ^ 0x1234567); for (let i = 0; i < POOL * 4; i++) { poolA[i] = r(); poolB[i] = r(); } }
  const attrA = new THREE.BufferAttribute(poolA, 4), attrB = new THREE.BufferAttribute(poolB, 4), attrP = new THREE.BufferAttribute(new Float32Array(POOL * 3), 3);
  function cloud(count, vertexShader, uniforms, order = 6) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', attrP); g.setAttribute('aA', attrA); g.setAttribute('aB', attrB); g.setDrawRange(0, Math.min(count, POOL));
    const m = new THREE.Points(g, new THREE.ShaderMaterial({ ...ADD, depthTest: true, uniforms, vertexShader, fragmentShader: SPRITE_FRAG }));
    m.frustumCulled = false; m.renderOrder = order; return m;
  }

  // The camera sits at the origin, so an object's matrixWorld is already camera-relative.
  const vW = new THREE.Vector3(), vW2 = new THREE.Vector3(), qW = new THREE.Quaternion();
  /** Radius in pixels of a sphere of radius r (in obj's units), as seen right now. */
  const pxRadius = (obj, r = 1) => { vW.setFromMatrixPosition(obj.matrixWorld); return (r * obj.matrixWorld.getMaxScaleOnAxis() / Math.max(vW.length(), 1e-6)) * U.pxScale.value; };

  // A star seen up close: granulated sphere + glow with soft diffraction spikes.
  const SUN_VERT = /* glsl */`
    varying vec3 vN, vWN, vWP;
    void main(){ vN = normalize(position); vWN = normalize(mat3(modelMatrix) * normal); vec4 wp = modelMatrix * vec4(position, 1.); vWP = wp.xyz; gl_Position = projectionMatrix * viewMatrix * wp; }`;
  const sphereGeo = new THREE.SphereGeometry(1, 64, 40), planeGeo = new THREE.PlaneGeometry(1, 1);
  function makeSun() {
    const u = { uCol: { value: new THREE.Vector3(1, 1, 1) }, uI: { value: 14 }, uTime: U.time, uLod: { value: 1 }, uSeed: { value: 0 } };
    const body = new THREE.Mesh(sphereGeo, new THREE.ShaderMaterial({
      uniforms: u, vertexShader: SUN_VERT,
      fragmentShader: /* glsl */`
        varying vec3 vN, vWN, vWP; uniform vec3 uCol; uniform float uI, uTime, uLod, uSeed;
        ${GLSL_NOISE}
        void main(){
          float nv = clamp(dot(normalize(vWN), normalize(-vWP)), 0., 1.);
          float gran = fbm(vN * 7. + vec3(uSeed, uTime * .012, 0.)) * fbm3(vN * 19. - vec3(uTime * .02) + uSeed);
          gl_FragColor = vec4(uCol * uI * uLod * (.55 + 1.9 * gran) * (.42 + .58 * pow(nv, .6)), 1.);
        }`,
    }));
    body.renderOrder = 0;
    const gu = { uCol: u.uCol, uI: { value: 3 } };
    const glow = new THREE.Mesh(planeGeo, new THREE.ShaderMaterial({
      ...ADD, depthTest: true, uniforms: gu,
      vertexShader: /* glsl */`varying vec2 vQ; void main(){ vQ = position.xy * 2.; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.); }`,
      fragmentShader: /* glsl */`
        varying vec2 vQ; uniform vec3 uCol; uniform float uI;
        void main(){
          float d = length(vQ); if (d >= 1.) discard;
          float edge = (1. - d) * (1. - d), d2 = d * d;
          // Core and halo never get thinner than about a pixel: far away they keep the star's light, not its size.
          float px = length(fwidth(vQ)), m = px * px * 1.6;
          const float W1 = 1. / 170., W2 = 1. / 190.;
          float w1 = max(W1, m), w2 = max(W2, m);
          float core = exp(-d2 / w1) * W1 / w1, halo = edge / (1. + d2 / w2) * W2 / w2;
          vec2 a = abs(vQ);                                            // four faint diffraction spikes
          float spikes = (exp(-a.y * 90.) * exp(-a.x * 5.) + exp(-a.x * 90.) * exp(-a.y * 5.)) * edge * clamp(.011 / px, 0., 1.);
          gl_FragColor = vec4(mix(uCol, vec3(1.), .25) * uI * (core + .16 * halo + .05 * spikes), 1.);
        }`,
    }));
    glow.renderOrder = 4;
    const group = new THREE.Group(); group.add(body, glow);
    return {
      group, body, glow, u, gu,
      set(K, radius, brightness = 14, glowSize = 30, glowGain = 0.22) {
        const c = starColor(K, 1).map((x) => x * x);                   // squared: colour survives the highlights
        u.uCol.value.set(c[0], c[1], c[2]); u.uI.value = brightness; gu.uI.value = brightness * glowGain;
        body.scale.setScalar(radius); glow.scale.setScalar(radius * glowSize); u.uSeed.value = radius * 37.7 + K * 0.01;
      },
      // Turn the glow to the camera, and hand the disk's light to the glow core once it is under a pixel or two.
      face(camQ) { glow.parent.getWorldQuaternion(qW); glow.quaternion.copy(qW.invert().multiply(camQ)); u.uLod.value = smooth(0.6, 2.2, pxRadius(body)); },
    };
  }

  // Planets: five procedural characters, lit only by their star.
  const PLANET_FRAG = /* glsl */`
    varying vec3 vN, vWN, vWP;
    uniform int uType; uniform vec3 uSunW, uSunL, uLight, uAtm, uTint;
    uniform float uSpin, uSeed, uWrap, uRingVis, uLod; uniform vec2 uRing;
    ${GLSL_NOISE} ${GLSL_RING}
    vec3 rotY(vec3 p, float a){ float c = cos(a), s = sin(a); return vec3(c * p.x + s * p.z, p.y, -s * p.x + c * p.z); }
    vec3 albedo(vec3 p){
      if (uType == 0){            // scorched rock: mottled, cratered
        float n1 = fbm(p * 3. + uSeed), n2 = fbm(p * 9. + uSeed);
        float pits = smoothstep(.56, .72, vnoise(p * 15. + uSeed));
        vec3 c = mix(vec3(.20, .165, .15), vec3(.56, .45, .37), smoothstep(.25, .75, n1)) * (.75 + .5 * n2);
        return mix(c, c * .55, pits);
      }
      if (uType == 1){            // temperate: sea, land, cloud, polar caps
        float land = smoothstep(.5, .56, fbm(p * 2.1 + uSeed));
        vec3 c = mix(vec3(.025, .10, .24), mix(vec3(.40, .33, .20), vec3(.16, .27, .14), fbm(p * 6.)), land);
        c = mix(c, vec3(.9), smoothstep(.72, .9, abs(p.y) + .12 * (fbm(p * 8.) - .5)));
        vec3 q = p * 3.2 + vec3(0., uSeed, 0.) + .9 * (fbm3(p * 2.) - .5);
        return mix(c, vec3(.93), .88 * smoothstep(.48, .72, fbm(vec3(q.x, q.y * 2.2, q.z))));
      }
      if (uType == 2){            // banded gas giant
        float turb = fbm(vec3(p.x * 2., p.y * 7., p.z * 2.) + uSeed);
        float band = sin(p.y * 17. + (turb - .5) * 5.) * .5 + .5;
        vec3 c = mix(vec3(.50, .26, .15), vec3(.92, .82, .64), smoothstep(.15, .85, band));
        c = mix(c, vec3(.72, .50, .36), .5 * fbm3(vec3(p.x * 3., p.y * 26., p.z * 3.)));
        vec3 sp = p - normalize(vec3(.72, -.36, .59));
        c = mix(c, vec3(.62, .22, .12), smoothstep(.2, .08, length(sp * vec3(1., 2.3, 1.))));
        return c * mix(.6, 1., smoothstep(1., .7, abs(p.y)));
      }
      if (uType == 3){            // pale giant, soft bands
        float turb = fbm(vec3(p.x * 1.5, p.y * 5., p.z * 1.5) + uSeed);
        float band = sin(p.y * 11. + (turb - .5) * 3.) * .5 + .5;
        vec3 c = mix(vec3(.66, .55, .37), vec3(.90, .81, .60), smoothstep(.1, .9, band));
        return mix(c, vec3(.55, .58, .56), .35 * smoothstep(.6, 1., abs(p.y)));
      }
      float plains = fbm(p * 2. + uSeed);   // ice world: pale plains, blue fracture lines
      float cracks = pow(1. - abs(vnoise(p * 5.5 + uSeed) * 2. - 1.), 9.) + .6 * pow(1. - abs(vnoise(p * 12. - uSeed) * 2. - 1.), 12.);
      vec3 c = mix(vec3(.62, .76, .90), vec3(.86, .93, .98), smoothstep(.3, .7, plains));
      return mix(c, vec3(.22, .42, .68), clamp(cracks, 0., 1.) * .8);
    }
    void main(){
      vec3 N = normalize(vWN), V = normalize(-vWP);
      float nv = clamp(dot(N, V), 0., 1.), ndl = dot(N, uSunW);
      vec3 alb = albedo(rotY(vN, uSpin)) * uTint;
      float d = clamp((ndl + uWrap) / (1. + uWrap), 0., 1.);            // soft terminator
      float gas = step(1.5, float(uType)) * step(float(uType), 3.5);
      vec3 col = alb * uLight * pow(d, 1.15) * mix(1., .62 + .38 * sqrt(nv), gas);
      if (uRingVis > 0. && abs(uSunL.y) > 1e-4){                          // shadow of the rings
        float s = -vN.y / uSunL.y;
        if (s > 0.){ vec3 q = vN + s * uSunL; col *= 1. - .78 * uRingVis * ringDensity(length(q.xz), uRing); }
      }
      col += uAtm * uLight * pow(1. - nv, 3.2) * smoothstep(-.42, .3, ndl) * .85;   // atmospheric rim
      float aa = clamp(nv / max(fwidth(nv) * 1.5, 1e-4), 0., 1.);
      gl_FragColor = vec4(col, aa * uLod);
    }`;
  function makePlanet() {
    const group = new THREE.Group(), tilt = new THREE.Group(); group.add(tilt);
    const u = {
      uType: { value: 0 }, uSunW: { value: new THREE.Vector3() }, uSunL: { value: new THREE.Vector3() }, uLight: { value: new THREE.Vector3() },
      uAtm: { value: new THREE.Vector3() }, uTint: { value: new THREE.Vector3(1, 1, 1) }, uSpin: { value: 0 }, uSeed: { value: 0 }, uWrap: { value: 0.1 },
      uRing: { value: new THREE.Vector2(1.35, 2.4) }, uRingVis: { value: 0 }, uLimb: { value: 0.37 }, uUpW: { value: new THREE.Vector3() }, uLod: { value: 1 },
    };
    const body = new THREE.Mesh(sphereGeo, new THREE.ShaderMaterial({ uniforms: u, vertexShader: SUN_VERT, fragmentShader: PLANET_FRAG, transparent: true }));
    body.renderOrder = 1; tilt.add(body);
    const shell = new THREE.Mesh(sphereGeo, new THREE.ShaderMaterial({
      ...ADD, uniforms: u, vertexShader: SUN_VERT,
      fragmentShader: /* glsl */`
        varying vec3 vN, vWN, vWP; uniform vec3 uSunW, uLight, uAtm; uniform float uLimb, uLod;
        void main(){
          vec3 N = normalize(vWN); float nv = clamp(dot(N, normalize(-vWP)), 0., 1.);
          float a = smoothstep(0., uLimb, nv) * (1. - smoothstep(uLimb, uLimb + .3, nv));
          gl_FragColor = vec4(uAtm * uLight * a * a * smoothstep(-.5, .25, dot(N, uSunW)) * .5 * uLod, 1.);
        }`,
    }));
    shell.scale.setScalar(1.075); shell.renderOrder = 3; tilt.add(shell);
    const ring = new THREE.Mesh(new THREE.RingGeometry(1.35, 2.4, 128, 1), new THREE.ShaderMaterial({
      uniforms: u, transparent: true, depthWrite: false, side: THREE.DoubleSide,
      vertexShader: /* glsl */`
        varying vec3 vL, vWP;
        void main(){ vL = vec3(position.x, 0., position.y); vec4 wp = modelMatrix * vec4(vL, 1.); vWP = wp.xyz; gl_Position = projectionMatrix * viewMatrix * wp; }`,
      fragmentShader: /* glsl */`
        varying vec3 vL, vWP; uniform vec3 uSunL, uLight, uUpW; uniform float uRingVis, uLod; uniform vec2 uRing;
        ${GLSL_RING}
        void main(){
          float rad = length(vL.xz), dens = ringDensity(rad, uRing);
          float t = -dot(vL, uSunL);
          float shadow = t > 0. ? smoothstep(.93, 1.04, length(vL + t * uSunL)) : 1.;       // shadow of the planet
          float sameSide = step(0., uSunL.y * dot(normalize(-vWP), uUpW));
          float x = (rad - uRing.x) / (uRing.y - uRing.x);
          vec3 col = mix(vec3(.62, .52, .40), vec3(.93, .87, .76), dens) * mix(.85, 1.1, x);
          col *= uLight * shadow * mix(.3 * (1. - dens * .6), .95, sameSide) * (.35 + .65 * smoothstep(0., .25, abs(uSunL.y)));
          gl_FragColor = vec4(col, dens * .9 * uRingVis * uLod);
        }`,
    }));
    ring.renderOrder = 2; ring.frustumCulled = false; tilt.add(ring);
    const ATM = [null, [0.32, 0.58, 1.0], [1.0, 0.72, 0.46], [1.0, 0.88, 0.62], [0.6, 0.85, 1.0]];
    return {
      group, u, spin: 0.02, reach: 1,
      set(rng, type, radius, light) {
        u.uType.value = type; u.uSeed.value = rng() * 40; group.scale.setScalar(radius);
        const atm = ATM[type]; u.uAtm.value.set(...(atm || [0, 0, 0])); shell.visible = !!atm;
        u.uWrap.value = type === 0 ? 0.03 : type === 1 ? 0.22 : 0.13;
        u.uTint.value.set(0.85 + 0.3 * rng(), 0.85 + 0.3 * rng(), 0.85 + 0.3 * rng());
        const ringed = type >= 2 && type <= 3 && rng() < 0.45;
        ring.visible = ringed; u.uRingVis.value = ringed ? 1 : 0; this.reach = radius * (ringed ? 2.6 : 1.3);
        tilt.rotation.set((rng() - 0.5) * 1.1, 0, (rng() - 0.5) * 0.9);
        u.uLight.value.set(light[0], light[1], light[2]); this.spin = (0.012 + 0.03 * rng()) * (rng() < 0.5 ? -1 : 1); this.phase = rng() * TAU;
      },
      update(sunW, t) {       // sunW: the star's camera-relative position
        group.getWorldPosition(vW2); u.uSunW.value.copy(sunW).sub(vW2).normalize();
        tilt.getWorldQuaternion(qW); u.uUpW.value.set(0, 1, 0).applyQuaternion(qW);
        u.uSunL.value.copy(u.uSunW.value).applyQuaternion(qW.invert());
        u.uSpin.value = (this.phase + this.spin * t) % TAU;
        u.uLod.value = smooth(0.6, 2.2, pxRadius(group));
      },
    };
  }

  /* --------------------------------------------------------------------------
     Places. Every kind is built twice, so the place you are leaving stays in
     the world while the next one is set down ahead. An instance:
       roll(rng, frame)  choose colour, scale, angle, composition
       update(t, camQ)   its own quiet life
       bounds            [x, y, z, r] spheres the path must not cross
       focus, core       which bound is the subject, and the radius that reads as it from afar
     Everything is composed in the resting frame (the camera as it will be at
     rest there, looking down -z). frame.at(x, y, d) gives the position that
     lands at screen (x, y) in -1..1. In the world, the instance sits at an
     anchor: the position and heading the camera will have at rest.
     -------------------------------------------------------------------------- */
  const KINDS = {}, PLACES = [];
  const pick = (rng, a, b) => a + (b - a) * rng();
  const sign = (rng) => (rng() < 0.5 ? -1 : 1);
  function kind(name, build, env = {}) {
    KINDS[name] = [0, 1].map(() => {
      const p = {
        name, env, group: new THREE.Group(), live: false, anchor: { pos: new THREE.Vector3(), q: new THREE.Quaternion() },
        o: { value: 1 },                             // level of detail for the soft parts: 0 while the place is a point
        bounds: [], focus: 0, core: 1, dref: 10, cull: { c: new THREE.Vector3(), r: 1 }, lens: null, volume: null,
      };
      p.group.visible = false; scene.add(p.group);
      build(p); PLACES.push(p);
      return p;
    });
  }

  // ---- a lone sun with a planet or two ----
  kind('star', (p) => {
    const sun = makeSun(), p1 = makePlanet(), p2 = makePlanet();
    p.group.add(sun.group, p1.group, p2.group);
    let two = false;
    p.roll = (rng, f) => {
      const K = 3300 + 7200 * Math.pow(rng(), 1.6), side = rng() < 0.7 ? 1 : -1;
      const sd = pick(rng, 26, 40), k = sd / 20, sr = pick(rng, 0.45, 0.95) * k;
      sun.group.position.copy(f.at(side * pick(rng, 0.12, 0.5), pick(rng, -0.02, 0.36), sd));
      sun.set(K, sr);
      const c = starColor(K, 0.5), L = 1.7, light = [c[0] * L, c[1] * L, c[2] * L];
      // the near planet: large in frame, mostly night side, a lit crescent towards the sun
      const dist = pick(rng, 7, 11);
      p1.group.position.copy(f.at(-side * pick(rng, 0.22, 0.52), pick(rng, -0.34, 0.06), dist));
      p1.set(rng, (rng() * 5) | 0, pick(rng, 0.22, 0.46) * dist / 3, light);
      two = rng() < 0.6; p2.group.visible = two;
      p.bounds = [[...sun.group.position, sr * 15], [...p1.group.position, p1.reach * 2]];
      if (two) {
        p2.group.position.copy(sun.group.position).add(vW.set(side * pick(rng, -5, -2), pick(rng, -1.2, 1.2), pick(rng, 3, 8)).multiplyScalar(k));
        p2.set(rng, (rng() * 5) | 0, pick(rng, 0.12, 0.3) * k, light);
        p.bounds.push([...p2.group.position, p2.reach * 2]);
      }
      p.focus = 0; p.core = sr;
    };
    const sw = new THREE.Vector3();
    p.update = (t, camQ) => { sun.face(camQ); sun.group.getWorldPosition(sw); p1.update(sw, t); if (two) p2.update(sw, t); };
  });

  // ---- a binary pair, slowly circling, sometimes inside a faint dust ring ----
  kind('binary', (p) => {
    const a = makeSun(), b = makeSun();
    const ru = { uTime: U.time, uPx: U.pxScale, uDpr: U.dpr, uR: { value: 9 }, uCol: { value: new THREE.Vector3() } };
    const ringPts = cloud(MOBILE ? 6000 : 14000, /* glsl */`
      attribute vec4 aA, aB; uniform float uTime, uPx, uDpr, uR; uniform vec3 uCol; varying vec3 vCol;
      void main(){
        float g = sqrt(-2. * log(max(aA.x, 1e-4))) * cos(6.2831853 * aA.y);
        float r = uR * (1. + .13 * g), th = aA.z * 6.2831853 + uTime * .9 * pow(r, -1.5);
        vec3 p = vec3(r * cos(th), (aB.x - .5) * .12 * r * aB.y, r * sin(th));
        vec4 mv = modelViewMatrix * vec4(p, 1.);
        gl_Position = projectionMatrix * mv;
        float px = (.02 + .04 * aB.z) * uPx / -mv.z, cl = clamp(px, 1.3 * uDpr, 4. * uDpr);
        vCol = uCol * (.25 + aB.w) * min(1., px * px / (cl * cl)); gl_PointSize = cl;
      }`, ru);
    const orbit = new THREE.Group(); orbit.add(a.group, b.group, ringPts); p.group.add(orbit);
    let ra = 1, rb = 0.5, sep = 5, phase = 0, rate = 0.05;
    p.roll = (rng, f) => {
      const twins = rng() < 0.25, Ka = twins ? pick(rng, 5200, 7000) : pick(rng, 3600, 5200), Kb = twins ? Ka + pick(rng, -500, 500) : pick(rng, 9000, 19000);
      ra = pick(rng, 0.75, 1.1); rb = twins ? ra * pick(rng, 0.8, 1) : pick(rng, 0.35, 0.6);
      a.set(Ka, ra, 14, 20); b.set(Kb, rb, 14, 26);
      sep = pick(rng, 4.2, 6.5); phase = rng() * TAU; rate = TAU / pick(rng, 80, 130);
      orbit.position.copy(f.at(sign(rng) * pick(rng, 0.05, 0.4), pick(rng, -0.02, 0.3), pick(rng, 15, 27) * f.wide));
      orbit.rotation.set(pick(rng, 0.15, 0.9) * sign(rng), rng() * TAU, pick(rng, -1.1, 1.1));
      ringPts.visible = rng() < 0.6; ru.uR.value = pick(rng, 8.5, 12);
      const c = starColor(mix(Ka, Kb, 0.3), 0.7); ru.uCol.value.set(c[0] * 0.05, c[1] * 0.05, c[2] * 0.05);
      p.bounds = [[...orbit.position, Math.max(ringPts.visible ? ru.uR.value * 1.2 : 0, sep * 0.7 + Math.max(ra * 10, rb * 13))]];
      p.focus = 0; p.core = sep * 0.5 + ra;
    };
    p.update = (t, camQ) => {
      const th = phase + rate * t, ma = rb ** 3, mb = ra ** 3, m = ma + mb;      // orbit about the barycentre
      a.group.position.set(Math.cos(th) * sep * ma / m, 0, Math.sin(th) * sep * ma / m);
      b.group.position.set(-Math.cos(th) * sep * mb / m, 0, -Math.sin(th) * sep * mb / m);
      orbit.updateMatrixWorld(true); a.face(camQ); b.face(camQ);
    };
  });

  // ---- a dense star cluster ----
  kind('cluster', (p) => {
    const u = { uTime: U.time, uPx: U.pxScale, uDpr: U.dpr, uA: { value: 3 }, uK: { value: new THREE.Vector2(6000, 12000) }, uGiants: { value: 0.05 } };
    const pts = cloud(MOBILE ? DC.clusterStars.mobile : DC.clusterStars.desktop, /* glsl */`
      attribute vec4 aA, aB; uniform float uTime, uPx, uDpr, uA, uGiants; uniform vec2 uK; varying vec3 vCol;
      ${GLSL_BLACKBODY}
      void main(){
        float r = min(uA / sqrt(pow(max(aA.x, .002), -.6667) - 1.), uA * 9.);       // Plummer sphere
        float z = aA.y * 2. - 1., ph = aA.z * 6.2831853 + uTime * .02 / (.4 + r / uA), s = sqrt(1. - z * z);
        vec3 p = r * vec3(s * cos(ph), z, s * sin(ph));
        vec4 mv = modelViewMatrix * vec4(p, 1.);
        gl_Position = projectionMatrix * mv;
        float giant = step(1. - uGiants, aB.x);
        float lum = .08 * pow(max(aB.y, .003), -.7) * (1. + 4. * giant);
        vec3 col = mix(vec3(1.), blackbody(mix(mix(uK.x, uK.y, aA.w), 3900., giant)), .8);
        float px = (.035 + .05 * clamp(lum, 0., 1.5)) * uPx / -mv.z, cl = clamp(px, 1.5 * uDpr, 9. * uDpr);
        vCol = col * min(lum, 4.) * 2.2 * min(1., px * px / (cl * cl)); gl_PointSize = cl;
      }`, u);
    const hu = { uO: p.o, uCol: { value: new THREE.Vector3() } };
    const haze = new THREE.Mesh(sphereGeo, new THREE.ShaderMaterial({
      ...ADD, uniforms: hu, vertexShader: SUN_VERT,
      fragmentShader: /* glsl */`
        varying vec3 vWN, vWP; uniform vec3 uCol; uniform float uO;
        void main(){ float nv = clamp(dot(normalize(vWN), normalize(-vWP)), 0., 1.); gl_FragColor = vec4(uCol * (pow(nv, 3.) * .25 + pow(nv, 14.)) * uO, 1.); }`,
    }));
    haze.renderOrder = 5; p.group.add(pts, haze);
    p.roll = (rng, f) => {
      const globular = rng() < 0.45, a = pick(rng, 2.2, 3.4);
      u.uA.value = a; u.uGiants.value = globular ? 0.1 : 0.03;
      u.uK.value.set(globular ? 4400 : 8500, globular ? 7000 : pick(rng, 18000, 30000));
      const c = globular ? [1, 0.82, 0.58] : [0.45, 0.62, 1.0], g = globular ? 0.05 : 0.045;
      hu.uCol.value.set(c[0] * g, c[1] * g, c[2] * g); haze.scale.setScalar(a * (globular ? 2.6 : 3.4));
      pts.position.copy(f.at(pick(rng, -0.3, 0.4), pick(rng, -0.02, 0.3), pick(rng, 13, 26) * f.wide)); haze.position.copy(pts.position); pts.rotation.set(rng() * TAU, rng() * TAU, 0);
      p.bounds = [[...pts.position, a * 4]]; p.focus = 0; p.core = a;
    };
    p.update = () => {};
  });

  // ---- an emission nebula: marched through 3D noise at half resolution ----
  const NEB_STEPS = MOBILE ? DC.nebulaSteps.mobile : DC.nebulaSteps.desktop;
  const NEBULA_FRAG = /* glsl */`
    varying vec2 vUv;
    uniform highp sampler3D tN; uniform mat3 uCam, uRot; uniform vec2 uTan;
    uniform vec3 uCenter, uScale, uSeed, uHa, uO3, uS2, uLights[3];
    uniform float uR, uTime, uO, uCavity, uFil, uDust, uGain, uLightI[3];
    float n3(vec3 p){ return texture(tN, p).r; }
    // a thin sheet where the noise crosses its middle value: seen through, sheets read as filaments
    float ridge(float n, float w){ float x = (n - .5) / w; return exp(-x * x); }
    float light(vec3 p, int k){ vec3 d = p - uLights[k]; return uLightI[k] / (.04 + dot(d, d) * 5.); }
    void main(){
      gl_FragColor = vec4(0., 0., 0., 1.);                       // rgb: emission, a: transmittance
      if (uO <= 0.) return;
      vec3 rd = normalize(uCam * vec3((vUv * 2. - 1.) * uTan, -1.)), oc = -uCenter;
      float b = dot(oc, rd), disc = b * b - (dot(oc, oc) - uR * uR);
      if (disc <= 0.) return;
      float sq = sqrt(disc), t0 = max(-b - sq, 0.), t1 = -b + sq;
      if (t1 <= t0) return;
      vec3 hq = fract(vec3(gl_FragCoord.xyx) * .1031); hq += dot(hq, hq.yzx + 33.33);
      float dt = (t1 - t0) / ${fl(NEB_STEPS)}, t = t0 + dt * fract((hq.x + hq.y) * hq.z), ds = dt / uR;   // jittered start: steps become grain, not bands
      vec3 acc = vec3(0.); float T = 1.;
      for (int i = 0; i < ${NEB_STEPS}; i++){
        vec3 p = uRot * (oc + rd * t) / uR; t += dt;             // inside the unit ball
        float r = length(p * uScale);
        if (r >= 1.) continue;
        vec3 s = p * .5 + uSeed;
        // a slow churn: two lookups warp the space everything else is sampled in
        float wa = n3(s * .45 + vec3(0., uTime * .003, 0.)), wb = n3(s * .45 + vec3(5.2, 1.3, -uTime * .002));
        vec3 q = s + vec3(wa - .5, wb - .5, wa - wb) * .6;
        float body = smoothstep(.34, .64, n3(q * .8 + 3.1) + (1. - r) * .5 - .25) * smoothstep(1., .78, r);
        if (body < .004) continue;
        // filaments: ridged noise at three scales, each finer one living on the one above
        float f1 = ridge(n3(q * 1.7), .09);
        float f2 = ridge(n3(q * 3.9 + f1 * .1 + 7.3), .06);
        float f3 = ridge(n3(q * 7.7 + f2 * .06 + 2.9), .045);
        float fil = f1 * .3 + f1 * f2 * 1.1 + f2 * f3 * 1.2;
        // starlight. The main star has blown a bubble; its wall glows as an ionisation front.
        vec3 dl = p - uLights[0]; float d0 = length(dl);
        float L = .05 + light(p, 0) + light(p, 1) + light(p, 2);
        L /= 1. + L * .35;                                         // the gas saturates rather than burning to white
        float wall = exp(-pow((d0 - uCavity * 1.05) / (.04 + .05 * f1), 2.));
        float gas = body * smoothstep(uCavity * .55, uCavity, d0) * (fil * uFil + .04) * (1. + 1.6 * wall);
        // dust: dark pillars standing just outside the bubble, pointing at the main star
        // (noise that varies across directions, slowly along the radius, so it forms columns)
        float pn = n3(dl / max(d0, 1e-3) * 1.05 + vec3(d0 * .35) + uSeed.zxy + (wa - .5) * .25) + (f1 - .5) * .07;
        float band = smoothstep(uCavity * .95, uCavity * 1.3, d0) * (1. - smoothstep(uCavity * 1.7, uCavity * 3.1, d0)) * smoothstep(1., .6, r);
        float pillar = smoothstep(.645, .7, pn) * band;
        float lane = smoothstep(.58, .72, n3(q * 2.3 + 11.1)) * body;
        float dust = (pillar * 1.4 + lane * .5) * uDust;
        // bright rims where starlight meets the dust
        float rim = (smoothstep(.61, .645, pn) - smoothstep(.645, .69, pn)) * band * body * (1. - smoothstep(uCavity, uCavity * 1.7, d0));   // lit heads, not long sides
        // colour by excitation: oxygen in the hot zone around the stars, hydrogen further out, sulphur along the finest outer threads
        float hot = 1. - smoothstep(uCavity * .9, uCavity * 2.2, d0);
        vec3 col = mix(uHa, uO3, hot * (.4 + .5 * f2));
        col = mix(col, uS2, .5 * f3 * (1. - hot));
        vec3 em = col * gas * L + mix(col, vec3(1., .96, .9), .45) * rim * L * 1.4;
        acc += T * em * ds * uGain;
        T *= exp(-(gas * 1.5 + dust * 16.) * ds * 3.2);
        if (T < .02) break;
      }
      gl_FragColor = vec4(acc * uO, mix(1., T, uO));
    }`;
  const VOL_OPTS = { type: THREE.HalfFloatType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false };
  kind('nebula', (p) => {
    const nu = {
      tN: { value: noise3D }, uCam: U.cam, uTan: U.tan, uTime: U.time, uO: p.o,
      uCenter: { value: new THREE.Vector3() }, uRot: { value: new THREE.Matrix3() }, uR: { value: 25 },
      uScale: { value: new THREE.Vector3(1, 1, 1) }, uSeed: { value: new THREE.Vector3() }, uCavity: { value: 0.3 }, uFil: { value: 1 }, uDust: { value: 1 }, uGain: { value: 3 },
      uHa: { value: new THREE.Vector3() }, uO3: { value: new THREE.Vector3() }, uS2: { value: new THREE.Vector3() },
      uLights: { value: [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()] }, uLightI: { value: [1, 0, 0] },
    };
    // The half-res volume is laid over everything behind it: scene = scene * transmittance + emission.
    const rt = new THREE.WebGLRenderTarget(2, 2, VOL_OPTS);
    const comp = new THREE.Mesh(passGeo, new THREE.ShaderMaterial({
      depthTest: false, depthWrite: false, transparent: true, blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor, blendDst: THREE.SrcAlphaFactor, blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
      uniforms: { tVol: { value: rt.texture } }, vertexShader: FULLSCREEN_VERT,
      fragmentShader: /* glsl */`varying vec2 vUv; uniform sampler2D tVol; void main(){ gl_FragColor = texture(tVol, vUv); }`,
    }));
    comp.frustumCulled = false; comp.renderOrder = -10; comp.visible = false; scene.add(comp);
    p.volume = { mat: passMat(NEBULA_FRAG, nu), rt, comp };

    const su = { uPx: U.pxScale, uDpr: U.dpr, uR: { value: 25 } };
    const sprinkle = cloud(MOBILE ? 260 : 420, /* glsl */`
      attribute vec4 aA, aB; uniform float uPx, uDpr, uR; varying vec3 vCol;
      ${GLSL_BLACKBODY}
      void main(){
        float z = aA.y * 2. - 1., ph = aA.z * 6.2831853, s = sqrt(1. - z * z);
        vec3 p = uR * .62 * pow(aA.x, .6) * vec3(s * cos(ph), z, s * sin(ph));
        vec4 mv = modelViewMatrix * vec4(p, 1.); gl_Position = projectionMatrix * mv;
        float lum = .05 * pow(max(aB.y, .004), -.7);
        float px = (.1 + .12 * clamp(lum, 0., 2.)) * uPx / -mv.z, cl = clamp(px, 1.5 * uDpr, 10. * uDpr);
        vCol = mix(vec3(1.), blackbody(6000. + 22000. * aB.x * aB.x), .8) * min(lum, 5.) * 2. * min(1., px * px / (cl * cl)); gl_PointSize = cl;
      }`, su);
    const heroes = [makeSun(), makeSun(), makeSun()];
    const inner = new THREE.Group(); inner.add(sprinkle, ...heroes.map((h) => h.group)); p.group.add(inner);
    // emission palettes: [hydrogen, oxygen, sulphur], each as it reads in that rendering
    const PALETTES = [
      [[1.0, 0.16, 0.24], [0.16, 0.80, 0.84], [0.95, 0.38, 0.14]],   // natural: hydrogen red, oxygen teal
      [[1.0, 0.74, 0.32], [0.14, 0.62, 0.95], [0.95, 0.30, 0.12]],   // mapped: gold hydrogen, blue oxygen
      [[1.0, 0.22, 0.42], [0.36, 0.70, 1.00], [0.85, 0.16, 0.10]],   // rose and blue
      [[0.95, 0.20, 0.16], [0.30, 0.95, 0.70], [1.00, 0.62, 0.20]],   // red with green oxygen
    ];
    let R = 25;
    p.roll = (rng, f) => {
      R = pick(rng, 22, 30); const P = PALETTES[(rng() * PALETTES.length) | 0];
      su.uR.value = R;
      inner.position.copy(f.at(pick(rng, -0.25, 0.38), pick(rng, 0.0, 0.22), R * pick(rng, 1.55, 2.2) * f.wide));
      inner.rotation.set(rng() * TAU, rng() * TAU, rng() * TAU);
      nu.uScale.value.set(1, pick(rng, 1, 1.6), pick(rng, 1, 1.3));
      nu.uSeed.value.set(rng() * 9, rng() * 9, rng() * 9);
      nu.uCavity.value = pick(rng, 0.18, 0.38); nu.uFil.value = pick(rng, 0.8, 1.3); nu.uDust.value = pick(rng, 0.6, 1.3); nu.uGain.value = pick(rng, 2.6, 3.6);
      [nu.uHa, nu.uO3, nu.uS2].forEach((c, i) => c.value.set(...P[i]));
      const n = 1 + ((rng() * 3) | 0);
      heroes.forEach((h, i) => {
        h.group.visible = i < n;
        const l = nu.uLights.value[i].set(rng() - 0.5, (rng() - 0.5) * 0.6, rng() - 0.5).multiplyScalar(i === 0 ? 0.12 : 0.5);
        nu.uLightI.value[i] = i < n ? (i === 0 ? 1 : pick(rng, 0.35, 0.8)) : 0;
        h.group.position.copy(l).multiplyScalar(R);
        h.set(pick(rng, 12000, 30000), R * 0.005, 14, 150 * (i === 0 ? 1 : 0.7));
      });
      p.bounds = [[...inner.position, R]]; p.focus = 0; p.core = R * 0.5;
    };
    p.update = (t, camQ) => {
      heroes.forEach((h) => h.face(camQ));
      inner.getWorldPosition(nu.uCenter.value);
      inner.getWorldQuaternion(qW); nu.uRot.value.setFromMatrix4(m4.makeRotationFromQuaternion(qW.invert()));
      nu.uR.value = R * p.group.scale.x;
    };
  });

  // ---- a black hole: rays are bent through a Schwarzschild field, as a lens over the finished scene ----
  const BH_FRAG = /* glsl */`
    varying vec2 vUv;
    uniform sampler2D tScene, tNoise; uniform mat3 uCam; uniform vec2 uTan;
    uniform vec3 uCenter, uN, uE1, uE2, uPal[4]; uniform float uRs, uRin, uRout, uTime, uPxRs, uHeat, uGain, uSeed;
    vec3 heatColor(float h){
      vec3 c = mix(uPal[0], uPal[1], smoothstep(0., .42, h));
      c = mix(c, uPal[2], smoothstep(.38, .82, h));
      return mix(c, uPal[3], smoothstep(.78, 1.3, h));
    }
    float streaks(vec2 uv, float lod){ return textureLod(tNoise, uv, lod).r * .5 + textureLod(tNoise, uv * vec2(3., 2.) + .37, lod).g * .3 + textureLod(tNoise, uv * vec2(8., 5.) + .71, lod).b * .2; }
    // the accretion disk where a ray crosses its plane
    vec4 disk(vec3 hp, float rr, vec3 dir){
      float th = atan(dot(hp, uE2), dot(hp, uE1)), x = (rr - uRin) / (uRout - uRin);
      float w = 2.2 * pow(rr, -1.5);                                   // Keplerian: the inside laps the outside
      const float P = 14.;                                             // advect in two overlapping phases
      float f1 = fract(uTime / P), f2 = fract(uTime / P + .5), wa = 1. - abs(2. * f1 - 1.);
      float lr = log(rr) * 1.5 + uSeed;
      float n = mix(streaks(vec2((th - w * (f2 * P + 4.)) / 6.2831853 * 4., lr + floor(uTime / P + .5) * .37 + .5), 0.),
                    streaks(vec2((th - w * (f1 * P + 4.)) / 6.2831853 * 4., lr + floor(uTime / P) * .37), 0.), wa);
      n = (n - .5) / mix(.72, 1., abs(2. * wa - 1.)) + .5;
      float dens = smoothstep(0., .05, x) * pow(1. - x, 1.4) * (.25 + 1.5 * smoothstep(.25, .8, n));
      // orbital motion: the side coming towards us is brighter and bluer
      vec3 vdir = normalize(cross(uN, hp)); float vm = sqrt(.5 / rr);
      float D = sqrt(1. - vm * vm) / (1. - vm * dot(vdir, -dir));
      float heat = uHeat * pow(uRin / rr, .7) * D * sqrt(max(1. - 1. / rr, 0.)) * 1.35;
      vec3 c = heatColor(heat) * pow(D, 2.1) * (.1 + heat * heat) * uGain * (.55 + .9 * n);
      return vec4(c, clamp(dens * 1.8, 0., 1.));
    }
    vec3 background(vec3 d){
      vec3 v = d * uCam;                                               // world -> view
      if (v.z > -1e-3) return vec3(0.);
      vec2 uv = v.xy / -v.z / uTan * .5 + .5, e = smoothstep(vec2(-.25), vec2(0.), uv) * (1. - smoothstep(vec2(1.), vec2(1.25), uv));
      return texture(tScene, clamp(uv, .001, .999)).rgb * e.x * e.y;
    }
    void main(){
      vec3 base = texture(tScene, vUv).rgb;
      gl_FragColor = vec4(base, 1.);
      vec3 rd = normalize(uCam * vec3((vUv * 2. - 1.) * uTan, -1.)), ro = -uCenter / uRs;
      float tca = -dot(ro, rd), b = length(ro + rd * tca);
      const float BMAX = 26., RSPH = 30.;
      if (b > BMAX || tca < 0.) return;
      // Far away the disk is a few pixels: its light goes to a soft point that never gets thinner than a pixel.
      float far = 1. - smoothstep(4., 12., uRout * uPxRs);
      vec3 blob = vec3(0.);
      if (far > 0.){
        float w0 = uRout * .45, w = max(w0, 1.4 / uPxRs);
        blob = heatColor(.8 * uHeat) * uGain * .6 * (w0 * w0) / (w * w) * exp(-b * b / (w * w)) * far;
        if (far >= 1.){ gl_FragColor = vec4(base + blob, 1.); return; }
      }
      float wgt = 1. - smoothstep(BMAX * .3, BMAX, b);                 // the lens fades out at its edge
      float t = max(tca - sqrt(max(RSPH * RSPH - b * b, 0.)), 0.);
      vec3 p = ro + rd * t, v = rd, hv = cross(p, v);
      float h2 = dot(hv, hv), prevY = dot(p, uN), T = 1.; vec3 col = vec3(0.); bool captured = false;
      for (int i = 0; i < 120; i++){
        float r2 = dot(p, p), r = sqrt(r2);
        if (r < 1.01){ captured = true; break; }                       // through the horizon
        if (r > RSPH * 1.03 && dot(p, v) > 0.) break;                  // escaped
        float dt = clamp(r * .12, .035, 1.2) * mix(1., .45, smoothstep(.6, 0., abs(prevY)));
        v += -1.5 * h2 * p / (r2 * r2 * r) * dt;                       // null geodesic in Schwarzschild space
        vec3 pn = p + v * dt; float y = dot(pn, uN);
        if (y * prevY < 0.){
          vec3 hp = mix(p, pn, prevY / (prevY - y)); float rr = length(hp);
          if (rr > uRin && rr < uRout){ vec4 dk = disk(hp, rr, normalize(v)); col += T * dk.rgb * dk.a; T *= 1. - dk.a; }
        }
        prevY = y; p = pn;
        if (T < .01) break;
      }
      if (!captured) col += T * background(normalize(mix(rd, normalize(v), wgt)));
      gl_FragColor = vec4(mix(mix(base, col, max(wgt, 1. - T)), base, far) + blob, 1.);
    }`;
  kind('blackhole', (p) => {
    const bu = {
      tScene: { value: null }, tNoise: { value: noiseRT.texture }, uCam: U.cam, uTan: U.tan, uTime: U.time,
      uCenter: { value: new THREE.Vector3() }, uRs: { value: 1 }, uRin: { value: 2.6 }, uRout: { value: 11 }, uPxRs: { value: 100 },
      uN: { value: new THREE.Vector3(0, 1, 0) }, uE1: { value: new THREE.Vector3(1, 0, 0) }, uE2: { value: new THREE.Vector3(0, 0, 1) },
      uHeat: { value: 1 }, uGain: { value: 2.4 }, uPal: { value: [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()] }, uSeed: { value: 0 },
    };
    p.lens = { mat: passMat(BH_FRAG, bu), u: bu };
    const PALS = [
      [[0.30, 0.035, 0.008], [1.0, 0.30, 0.055], [1.0, 0.70, 0.28], [1.0, 0.95, 0.86]],   // ember to white-hot
      [[0.25, 0.05, 0.02], [1.0, 0.42, 0.12], [1.0, 0.85, 0.6], [0.8, 0.9, 1.0]],         // hotter: blue-white core
      [[0.22, 0.03, 0.05], [0.95, 0.22, 0.12], [1.0, 0.62, 0.42], [1.0, 0.92, 0.9]],       // redder, cooler
    ];
    const center = new THREE.Object3D(); p.group.add(center);         // the hole itself; its frame carries the disk axes
    const n = new THREE.Vector3(), e1 = new THREE.Vector3(), e2 = new THREE.Vector3(), Z = new THREE.Vector3(0, 0, 1);
    p.roll = (rng, f) => {
      center.position.copy(f.at(pick(rng, -0.25, 0.38), pick(rng, -0.02, 0.24), pick(rng, 28, 46) * f.wide));
      const inc = pick(rng, 70, 86.5) * DEG * sign(rng), roll = pick(rng, -0.45, 0.45);
      n.set(Math.sin(inc) * Math.sin(roll), Math.sin(inc) * Math.cos(roll), Math.cos(inc)).normalize();
      e1.crossVectors(n, Z).normalize(); e2.crossVectors(n, e1);
      bu.uRout.value = pick(rng, 9, 13.5); bu.uHeat.value = pick(rng, 0.8, 1.1); bu.uSeed.value = rng() * 5;
      const P = PALS[rng() < 0.62 ? 0 : rng() < 0.6 ? 1 : 2]; bu.uPal.value.forEach((v, i) => v.set(...P[i]));
      p.bounds = [[...center.position, 24]]; p.focus = 0; p.core = bu.uRout.value;
    };
    p.update = () => {
      center.getWorldPosition(bu.uCenter.value); bu.uRs.value = p.group.scale.x;
      bu.uPxRs.value = bu.uRs.value / Math.max(bu.uCenter.value.length(), 1e-6) * U.pxScale.value;
      p.group.getWorldQuaternion(qW);
      bu.uN.value.copy(n).applyQuaternion(qW); bu.uE1.value.copy(e1).applyQuaternion(qW); bu.uE2.value.copy(e2).applyQuaternion(qW);
    };
  });

  // ---- outside the galaxy, looking back at the whole spiral ----
  kind('galaxy', (p) => {
    const gu = {
      uO: p.o, uTime: U.time, uPx: U.pxScale, uDpr: U.dpr, tNoise: { value: noiseRT.texture },
      uR: { value: 60 }, uArms: { value: 2 }, uWind: { value: 3 }, uBulge: { value: 0.14 }, uSharp: { value: 2 }, uSpin: { value: 0.004 }, uHue: { value: 0 },
    };
    const GAL = /* glsl */`
      uniform float uR, uArms, uWind, uSharp, uSpin, uTime;
      // offset from the nearest spiral arm, -0.5..0.5, at radius r (0..1) and angle th
      float armPhase(float r, float th){ float seg = 6.2831853 / uArms; return mod(th - uWind * log(r + .04) - uTime * uSpin, seg) / seg - .5; }
    `;
    const pts = cloud(POOL, /* glsl */`
      attribute vec4 aA, aB; uniform float uPx, uDpr, uBulge, uHue; varying vec3 vCol;
      ${GAL}
      float gaus(vec2 u){ return sqrt(-2. * log(max(u.x, 1e-4))) * cos(6.2831853 * u.y); }
      void main(){
        vec3 p, col; float lum;
        if (aA.x < uBulge){                                   // the old, yellow bulge
          float r = .035 * tan(aA.y * 1.45), z = aA.z * 2. - 1., ph = aA.w * 6.2831853, s = sqrt(1. - z * z);
          p = min(r, .4) * vec3(s * cos(ph), z * .62, s * sin(ph));
          col = vec3(1., .80, .56); lum = .5 + aB.x;
        } else {                                              // the disk: stars gathered into trailing arms
          float r = min(-.2 * log(1. - aA.y * .985), 1.), th = aA.z * 6.2831853;
          float ph = armPhase(r, th), grip = smoothstep(.07, .25, r);
          float ph2 = sign(ph) * pow(abs(ph) * 2., 1. + uSharp * grip) * .5;
          th += (ph2 - ph) * 6.2831853 / uArms;
          float inArm = 1. - smoothstep(0., .22, abs(ph2));
          p = vec3(r * cos(th), gaus(aB.xy) * .011 * (1. + r), r * sin(th));
          p.xz += (aB.zw - .5) * .035;
          col = mix(vec3(1., .84, .66), mix(vec3(.6, .74, 1.), vec3(.75, .7, 1.), uHue), inArm * smoothstep(.08, .35, r));
          lum = (.3 + aB.x) * mix(.45, 1.25, inArm) * (1.2 - r * .7);
          if (aA.w > .982 && inArm > .5){ col = vec3(1., .3, .45); lum *= 3.5; }     // star-forming regions
        }
        vec4 mv = modelViewMatrix * vec4(p * uR, 1.); gl_Position = projectionMatrix * mv;
        float px = (.16 + .3 * aB.w) * uPx / -mv.z, cl = clamp(px, 1.3 * uDpr, 6. * uDpr);
        vCol = col * lum * .2 * min(1., px * px / (cl * cl)); gl_PointSize = cl;
      }`, gu, 7);
    // a smooth body of unresolved light under the points, with dust lanes on the inside of each arm
    const body = new THREE.Mesh(new THREE.PlaneGeometry(2.3, 2.3), new THREE.ShaderMaterial({
      ...ADD, depthTest: true, side: THREE.DoubleSide, uniforms: gu,
      vertexShader: /* glsl */`uniform float uR; varying vec2 vP; void main(){ vP = position.xy; gl_Position = projectionMatrix * modelViewMatrix * vec4(position.x * uR, 0., position.y * uR, 1.); }`,
      fragmentShader: /* glsl */`
        varying vec2 vP; uniform sampler2D tNoise; uniform float uO, uHue;
        ${GAL}
        void main(){
          float r = length(vP); if (r >= 1.12) discard;
          float th = atan(vP.y, vP.x), ph = armPhase(r, th), grip = smoothstep(.07, .3, r);
          vec2 nuv = vec2(th / 6.2831853 * 3. - uTime * uSpin * .4775, log(r + .04) * 1.1);
          float n = texture(tNoise, nuv).r, n2 = texture(tNoise, nuv * 3.1 + .4).g;
          float arm = exp(-pow(ph / (.13 + .1 * n), 2.)), lane = exp(-pow((ph + .16 + .06 * (n - .5)) / .06, 2.)) * smoothstep(.3, .6, n2 + .25);
          float disk = exp(-r / .21) * (1. - smoothstep(.8, 1.1, r));
          float light = disk * mix(1., .3 + 1.5 * arm, grip) * (.6 + .8 * n2) * (1. - .85 * lane * grip);
          vec3 col = mix(vec3(1., .78, .55), mix(vec3(.55, .68, 1.), vec3(.7, .62, 1.), uHue), smoothstep(.05, .45, r) * (.4 + .6 * arm));
          gl_FragColor = vec4(col * light * .5 * uO, 1.);
        }`,
    }));
    body.renderOrder = 6;
    const bu = { uO: p.o, uCol: { value: new THREE.Vector3(0.9, 0.7, 0.45) } };
    const bulge = new THREE.Mesh(sphereGeo, new THREE.ShaderMaterial({
      ...ADD, uniforms: bu, vertexShader: SUN_VERT,
      fragmentShader: /* glsl */`
        varying vec3 vWN, vWP; uniform vec3 uCol; uniform float uO;
        void main(){ float nv = clamp(dot(normalize(vWN), normalize(-vWP)), 0., 1.); gl_FragColor = vec4(uCol * (pow(nv, 4.) * .5 + pow(nv, 22.) * 2.5) * uO, 1.); }`,
    }));
    bulge.renderOrder = 6;
    const disk = new THREE.Group(); disk.add(pts, body, bulge); p.group.add(disk);
    p.roll = (rng, f) => {
      const R = 60; gu.uR.value = R;
      gu.uArms.value = rng() < 0.5 ? 2 : rng() < 0.55 ? 4 : 3; gu.uWind.value = pick(rng, 1.8, 4.6) * sign(rng);
      gu.uSharp.value = pick(rng, 1.6, 3); gu.uBulge.value = pick(rng, 0.1, 0.2); gu.uHue.value = rng();
      gu.uSpin.value = 0.0035 * Math.sign(gu.uWind.value);          // arms trail
      bulge.scale.set(R * 0.2, R * 0.13, R * 0.2);
      disk.position.copy(f.at(pick(rng, -0.15, 0.25), pick(rng, 0.0, 0.16), R * pick(rng, 1.75, 2.6) * f.wide));
      // tilt the disk 24-76 degrees away from face-on, then roll it in the frame
      disk.rotation.set(0, 0, 0); disk.rotateZ(pick(rng, -1.2, 1.2)); disk.rotateX((90 - pick(rng, 24, 76) * sign(rng)) * DEG); disk.rotateY(rng() * TAU);
      p.bounds = [[...disk.position, R * 1.15]]; p.focus = 0; p.core = R * 0.35;
    };
    p.update = () => {};
  }, { density: 0.03, far: 0.3, sky: 0 });

  /* --------------------------------------------------------------------------
     Post: HDR target -> (lenses) -> bloom pyramid -> filmic tone map, grain, vignette
     -------------------------------------------------------------------------- */
  const BL = CONFIG.bloom;
  const hdrOpts = { type: THREE.HalfFloatType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false };
  const sceneRT = new THREE.WebGLRenderTarget(4, 4, { ...hdrOpts, depthBuffer: true });
  const lensRT = new THREE.WebGLRenderTarget(4, 4, hdrOpts);
  const mips = Array.from({ length: BL.levels }, () => new THREE.WebGLRenderTarget(2, 2, hdrOpts));
  const downMat = passMat(/* glsl */`
    varying vec2 vUv; uniform sampler2D tSrc; uniform vec2 uTexel; uniform float uPrefilter;
    vec3 s(vec2 o){ return texture(tSrc, vUv + o * uTexel).rgb; }
    void main(){   // 13-tap downsample: stable, no shimmer on small bright things
      vec3 c = s(vec2(0)) * .125;
      c += (s(vec2(-1,-1)) + s(vec2(1,-1)) + s(vec2(-1,1)) + s(vec2(1,1))) * .125;
      c += (s(vec2(-2,-2)) + s(vec2(2,-2)) + s(vec2(-2,2)) + s(vec2(2,2))) * .03125;
      c += (s(vec2(0,-2)) + s(vec2(-2,0)) + s(vec2(2,0)) + s(vec2(0,2))) * .0625;
      if (uPrefilter > .5){   // soft-knee threshold
        c = min(c * ${fl(CONFIG.exposure)}, vec3(60.));
        float br = max(c.r, max(c.g, c.b)), soft = clamp(br - ${fl(BL.threshold - BL.knee)}, 0., ${fl(2 * BL.knee)});
        soft = soft * soft / ${fl(4 * BL.knee + 1e-4)};
        c *= max(soft, br - ${fl(BL.threshold)}) / max(br, 1e-4);
      }
      gl_FragColor = vec4(c, 1.);
    }`, { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() }, uPrefilter: { value: 0 } });
  const upMat = passMat(/* glsl */`
    varying vec2 vUv; uniform sampler2D tSrc; uniform vec2 uTexel;
    vec3 s(vec2 o){ return texture(tSrc, vUv + o * uTexel).rgb; }
    void main(){   // 3x3 tent, blended into the level above
      vec3 c = s(vec2(0)) * 4. + (s(vec2(-1,0)) + s(vec2(1,0)) + s(vec2(0,-1)) + s(vec2(0,1))) * 2. + s(vec2(-1,-1)) + s(vec2(1,-1)) + s(vec2(-1,1)) + s(vec2(1,1));
      gl_FragColor = vec4(c / 16., ${fl(BL.radius)});
    }`, { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() } }, { transparent: true, blending: THREE.NormalBlending, premultipliedAlpha: false });
  const finalMat = passMat(/* glsl */`
    varying vec2 vUv;
    uniform sampler2D tScene, tBloom; uniform vec2 uCentre;
    uniform float uVignette, uHaze, uFade, uGrain, uGrainSeed, uAspect;
    float hash12(vec2 p){ vec3 q = fract(vec3(p.xyx) * .1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
    vec3 aces(vec3 x){ return clamp((x * (2.51 * x + .03)) / (x * (2.43 * x + .59) + .14), 0., 1.); }
    vec3 toSrgb(vec3 c){ return mix(c * 12.92, 1.055 * pow(c, vec3(1. / 2.4)) - .055, step(.0031308, c)); }
    void main(){
      vec3 c = texture(tScene, vUv).rgb * ${fl(CONFIG.exposure)} + texture(tBloom, vUv).rgb * ${fl(BL.strength)};
      vec2 q = (vUv - .5) * vec2(min(uAspect, 1.6), 1.), qc = (vUv - uCentre) * vec2(uAspect, 1.);
      c += vec3(.45, .62, 1.) * uHaze * exp(-dot(qc, qc) * 9.);                    // relativistic beaming: a faint glow ahead
      c *= 1. - uVignette * smoothstep(.25, 1.05, length(q) * 1.15);
      c = toSrgb(aces(c)) * (1. - uFade);
      float lum = dot(c, vec3(.299, .587, .114));
      float g = hash12(gl_FragCoord.xy + uGrainSeed * 61.7) + hash12(gl_FragCoord.yx + uGrainSeed * 17.3 + 5.) - 1.;
      c += g * uGrain * (.4 + .6 * smoothstep(0., .3, lum) * (1. - smoothstep(.75, 1., lum)));
      c += (hash12(gl_FragCoord.xy * 1.31 + 3.7) + hash12(gl_FragCoord.xy * .77 + 11.1) - 1.) / 255.;   // dither
      gl_FragColor = vec4(c, 1.);
    }`, {
    tScene: { value: null }, tBloom: { value: mips[0].texture }, uCentre: { value: new THREE.Vector2(0.5, 0.5) },
    uVignette: { value: 0.3 }, uHaze: { value: 0 }, uFade: { value: 0 }, uGrain: { value: CONFIG.grain }, uGrainSeed: { value: 0 }, uAspect: { value: 1 },
  });

  /* --------------------------------------------------------------------------
     Size, quality, framing
     -------------------------------------------------------------------------- */
  let viewW = 1, viewH = 1, aspect = 1;
  const restTan = Math.tan(CONFIG.regimes.fov[0] * DEG / 2);
  // Compose in the resting frame: screen position (-1..1) and distance -> position relative to the resting camera.
  const frame = {
    wide: 1, v: new THREE.Vector3(),
    at(x, y, d) { return this.v.set(x * restTan * Math.min(aspect, 1.9) * d, y * restTan * d, -d); },
  };
  function resize() {
    viewW = Math.max(1, window.innerWidth); viewH = Math.max(1, window.innerHeight); aspect = viewW / viewH;
    const dpr = Math.min(window.devicePixelRatio || 1, dprCap) * Q.ladder[qualityLevel];
    renderer.setPixelRatio(dpr); renderer.setSize(viewW, viewH, false);
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    sceneRT.setSize(size.x, size.y); lensRT.setSize(size.x, size.y);
    for (const p of PLACES) if (p.volume) p.volume.rt.setSize(Math.max(2, size.x >> 1), Math.max(2, size.y >> 1));
    let w = size.x, h = size.y;
    for (const m of mips) { w = Math.max(1, w >> 1); h = Math.max(1, h >> 1); m.setSize(w, h); }
    camera.aspect = aspect;
    frame.wide = clamp(1.3 / aspect, 1, 2.3);              // portrait: stand further back from wide subjects
    U.res.value.copy(size); U.dpr.value = Math.max(1, dpr);
    finalMat.uniforms.uAspect.value = aspect;
  }
  function setQuality(level) { qualityLevel = clamp(level, 0, Q.ladder.length - 1); resize(); }

  /* --------------------------------------------------------------------------
     The journey
     The camera has a position and a heading (J.pos, J.q) in place units. A
     hold swings the heading off the current place, then builds speed. On
     release the whole glide is planned at once, so the next place can be set
     down in the world right then, exactly where the glide ends.
     -------------------------------------------------------------------------- */
  const J = {
    s: 0, held: false, holdT: 0, completing: false,   // throttle, input, effective hold time, finishing a committed jump
    pos: new THREE.Vector3(), q: new THREE.Quaternion(), departQ: new THREE.Quaternion(),
    turn: { from: new THREE.Quaternion(), to: new THREE.Quaternion(), t: 0, dur: 1 },
    starPos: new THREE.Vector3(), starDist: 0,         // the starfield's own, slower space
    glide: null,                                       // the planned glide: { t, dt, n, s, pos }
    here: null,                                        // the place you are at, or gliding into
    ly: 0, hopLy: 0, arrivals: 0, presses: 0,
    env: { density: 1, far: 1, sky: 1 }, envTo: { density: 1, far: 1, sky: 1 },
    everHeld: false, hudUntil: 0, fade: 0,
  };
  const lockedSpeed = params.has('speed') ? clamp(parseFloat(params.get('speed')) || 0, 0, 1) : null;
  const forcedDest = KINDS[params.get('dest')] ? params.get('dest') : null;
  const TN = JC.turn, GL = JC.glide, GLIDE_DT = 1 / 120;
  const FWD = new THREE.Vector3(0, 0, -1), vF = new THREE.Vector3(), qT = new THREE.Quaternion(), qA = new THREE.Quaternion(), vA = new THREE.Vector3();

  const headingAt = (t, out) => out.slerpQuaternions(J.turn.from, J.turn.to, smoother(t / J.turn.dur));
  function startTurn(to, dur) { J.turn.from.copy(J.q); J.turn.to.copy(to); J.turn.t = 0; J.turn.dur = dur; }

  /** The smallest swing off the current heading that keeps the path clear of every place still in the world. */
  function departureHeading(rng, out) {
    const spheres = [];
    for (const p of PLACES) if (p.live) for (const b of p.bounds) {
      vA.set(b[0], b[1], b[2]).applyQuaternion(p.anchor.q).add(p.anchor.pos).sub(J.pos);
      const r = b[3] * TN.margin;
      if (vA.lengthSq() > r * r) spheres.push([vA.x, vA.y, vA.z, r]);   // already inside one: nothing to steer around
    }
    const jitter = rng() * TAU;
    for (let a = TN.min; a <= TN.max; a += TN.step) {
      let best = -1, bestPhi = 0;
      for (let k = 0; k < 24; k++) {
        const phi = jitter + (k / 24) * TAU;
        qT.copy(J.q).multiply(qA.setFromAxisAngle(vA.set(Math.cos(phi), Math.sin(phi), 0), a * DEG));
        vF.copy(FWD).applyQuaternion(qT);
        let clear = Infinity;
        for (const s of spheres) {
          const along = s[0] * vF.x + s[1] * vF.y + s[2] * vF.z;
          if (along <= 0) continue;                                     // behind us
          clear = Math.min(clear, Math.sqrt(Math.max(0, s[0] * s[0] + s[1] * s[1] + s[2] * s[2] - along * along)) / s[3]);
        }
        if (clear < 1) continue;
        const score = Math.min(clear, 3) + 0.8 * Math.abs(Math.sin(phi));  // prefer turning sideways over pitching
        if (score > best) { best = score; bestPhi = phi; }
      }
      if (best >= 0) return { q: out.copy(J.q).multiply(qA.setFromAxisAngle(vA.set(Math.cos(bestPhi), Math.sin(bestPhi), 0), a * DEG)), angle: a };
    }
    return { q: out.copy(J.q).multiply(qA.setFromAxisAngle(vA.set(0, 1, 0), TN.max * DEG)), angle: TN.max };
  }

  /** Throttle samples for a glide from s0. With a depth, the final approach scales to that place; without, just ease to rest. */
  function glideThrottle(s0, depth) {
    const out = [];
    if (depth == null) {
      const dur = 0.8 + 4 * s0;
      for (let t = 0; t < dur; t += GLIDE_DT) out.push(s0 * (1 - smooth(0, 1, t / dur)));
    } else {
      const v0 = travelAt(s0); let a = 2 * GL.approach * depth;
      if (v0 > a * GL.tail) {
        // first ease down through the regimes (a cubic in throttle that meets the approach's deceleration)
        const sa = throttleFor(a * GL.tail), m1 = -a / travelSlope(sa), D1 = GL.base + GL.perS * (s0 - sa);
        for (let t = 0; t < D1; t += GLIDE_DT) { const u = t / D1, u2 = u * u, u3 = u2 * u; out.push((2 * u3 - 3 * u2 + 1) * s0 + (3 * u2 - 2 * u3) * sa + (u3 - u2) * D1 * m1); }
      } else a = v0 / GL.tail;
      // then the approach: speed falls linearly to zero, so the remaining distance shrinks as tau^2
      for (let tau = GL.tail; tau > 0; tau -= GLIDE_DT) out.push(throttleFor(a * tau));
    }
    out.push(0);
    return out;
  }
  /** Fly the throttle samples along the (still turning) heading: positions for every sample. */
  function planGlide(samples) {
    const n = samples.length, pos = new Float64Array(n * 3), p = vA.copy(J.pos);
    let t = J.turn.t;
    for (let i = 0; i < n; i++) {
      pos[i * 3] = p.x; pos[i * 3 + 1] = p.y; pos[i * 3 + 2] = p.z;
      vF.copy(FWD).applyQuaternion(headingAt(t, qT));
      p.addScaledVector(vF, travelAt(samples[i]) * GLIDE_DT); t += GLIDE_DT;
    }
    return { t: 0, dt: GLIDE_DT, n, s: samples, pos, endTurn: J.turn.t + (n - 1) * GLIDE_DT };
  }

  function setEnv(p) { J.envTo.density = p.env.density ?? 1; J.envTo.far = p.env.far ?? 1; J.envTo.sky = p.env.sky ?? 1; }
  /** Roll a place's look and composition. */
  function compose(p) {
    p.roll(mulberry32((SEED + 7919 * ++J.arrivals) | 0), frame);
    // how close its nearest part is (sets the final approach), and one sphere around everything (for culling)
    p.dref = Math.max(6, Math.min(...p.bounds.map((b) => Math.hypot(b[0], b[1], b[2]) - 0.5 * b[3])));
    const c = p.cull.c.set(p.bounds[0][0], p.bounds[0][1], p.bounds[0][2]);
    p.cull.r = Math.max(...p.bounds.map((b) => Math.hypot(b[0] - c.x, b[1] - c.y, b[2] - c.z) + b[3]));
  }
  /** Stand it in the world, at the position and heading the camera will have at rest there. */
  function stand(p, pos, q) { p.anchor.pos.copy(pos); p.anchor.q.copy(q); p.live = true; }
  function tierFor(ly, rng) {
    const L = DC.ladder; let i = 0; while (i < L.length && ly >= L[i]) i++;
    const t = DC.tiers[i]; return t[(rng() * t.length) | 0];
  }
  /** Arrive somewhere immediately: the opening, warm-up, and tests. Nothing else stays in the world. */
  function arriveNow(type, inst = 0) {
    for (const p of PLACES) p.live = false;
    J.glide = null; J.s = 0; J.held = J.completing = false;
    const p = KINDS[type][inst]; compose(p); stand(p, J.pos, J.q); J.here = p; setEnv(p); Object.assign(J.env, J.envTo);
  }

  function press() {
    if (J.held) return;
    J.held = true; J.completing = false;
    if (!J.everHeld) { J.everHeld = true; ui.showHint(false); }
    ui.message(null);
    if (lockedSpeed !== null) return;
    // Carry on from whatever we were doing, at the same throttle; swing off whatever is ahead.
    J.glide = null; J.holdT = holdTimeFor(J.s); J.departQ.copy(J.q);
    const h = departureHeading(mulberry32(SEED + 104729 * ++J.presses), qT);
    startTurn(h.q, TN.time + TN.perDeg * h.angle);
  }
  function release() {
    if (!J.held) return;
    J.held = false;
    if (lockedSpeed !== null) return;
    if (J.s < JC.commit) {                     // a tap: swing back and settle, a breath further on
      startTurn(J.departQ, 1.6);
      J.glide = planGlide(glideThrottle(J.s, null));
    } else if (J.s < JC.spawnMin) J.completing = true;   // committed: the jump runs on to its minimum, then glides
    else depart();
  }
  function depart() {
    J.completing = false;
    const s0 = J.s;
    // the longer the hop, the rarer the place
    let ly = 0; for (const s of glideThrottle(s0, 20)) ly += lyRateAt(s) * GLIDE_DT;
    const type = forcedDest || tierFor(J.hopLy + ly, mulberry32((SEED ^ 0x9e3779b9) + J.arrivals));
    const p = KINDS[type][0] === J.here ? KINDS[type][1] : KINDS[type][0];
    // compose it first (its depth shapes the approach), then plan the glide and stand it where the glide ends
    compose(p);
    const g = J.glide = planGlide(glideThrottle(s0, p.dref)), e = (g.n - 1) * 3;
    stand(p, vA.set(g.pos[e], g.pos[e + 1], g.pos[e + 2]), headingAt(g.endTurn, qT));
    J.here = p; setEnv(p);
  }

  function stopped(now) {
    J.glide = null; J.s = 0;
    if (J.hopLy > 0.05) { ui.message(`${formatLy(J.ly)} light-years from home`); J.hudUntil = now + CONFIG.hud.show; }
    J.hopLy = 0;
  }

  function stepJourney(dt, now) {
    const fast = !J.held && REDUCED ? CONFIG.reducedMotion.coastSpeedup : 1;   // reduced motion: the glide happens behind a fade
    const tdt = dt * fast;
    if (lockedSpeed !== null) {
      J.s = lockedSpeed;
      J.pos.addScaledVector(vF.copy(FWD).applyQuaternion(J.q), travelAt(J.s) * dt);
    } else if (J.held || J.completing) {
      J.holdT += dt; J.s = throttleAt(J.holdT); J.turn.t += dt;
      J.q.copy(headingAt(J.turn.t, qT));
      J.pos.addScaledVector(vF.copy(FWD).applyQuaternion(J.q), travelAt(J.s) * dt);
      if (J.completing && J.s >= JC.spawnMin) depart();
    } else {
      J.turn.t += tdt; J.q.copy(headingAt(J.turn.t, qT));
      const g = J.glide;
      if (g) {
        g.t += tdt;
        const x = g.t / g.dt, i = Math.min(Math.floor(x), g.n - 2), f = Math.min(x - i, 1), k = i * 3;
        J.s = mix(g.s[i], g.s[i + 1], f);
        J.pos.set(mix(g.pos[k], g.pos[k + 3], f), mix(g.pos[k + 1], g.pos[k + 4], f), mix(g.pos[k + 2], g.pos[k + 5], f));
        if (x >= g.n - 1) stopped(now);
      }
    }
    // the starfield moves through its own space at its own pace, along the same heading
    const ss = starSpeedAt(J.s) * tdt;
    J.starPos.addScaledVector(vF.copy(FWD).applyQuaternion(J.q), ss); J.starDist += ss;
    const ly = lyRateAt(J.s) * tdt; J.ly += ly; J.hopLy += ly;
    if (J.hudUntil && now > J.hudUntil) { J.hudUntil = 0; ui.message(null); }
  }

  /* --------------------------------------------------------------------------
     Update: everything from the throttle
     -------------------------------------------------------------------------- */
  const parallax = { x: 0, y: 0, tx: 0, ty: 0 };
  const eul = new THREE.Euler(0, 0, 0, 'YXZ'), qInv = new THREE.Quaternion(), qSky = new THREE.Quaternion(), m4 = new THREE.Matrix4();
  const camPos = new THREE.Vector3(), starCam = new THREE.Vector3(), sway = new THREE.Vector3(), vTmp = new THREE.Vector3();
  const rel = new THREE.Vector3(), relA = new THREE.Vector3(), sph = new THREE.Sphere(), frustum = new THREE.Frustum(), pm = new THREE.Matrix4();
  const noSway = REDUCED || params.has('still');

  /** Relativistic aberration of a camera-relative position: where it is seen. Returns the angular magnification. */
  function aberrate(v, out) {
    const beta = U.beta.value, d = v.length();
    if (beta <= 0 || d < 1e-9) { out.copy(v); return 1; }
    const F = U.velW.value, c = v.dot(F) / d;
    out.copy(v).multiplyScalar(1 / d).addScaledVector(F, -c);
    const sl = out.length(), c2 = (c + beta) / (1 + beta * c), s2 = Math.sqrt(Math.max(0, 1 - c2 * c2));
    if (sl > 1e-9) out.multiplyScalar(s2 / sl); else out.set(0, 0, 0);
    out.addScaledVector(F, c2).multiplyScalar(d);
    return 1 / (U.gamma.value * (1 + beta * c));
  }

  function update(dt, t) {
    const s = J.s, R = CONFIG.regimes, RL = CONFIG.relativity, C = CONFIG.camera;
    const motion = REDUCED ? 0 : 1;                           // reduced motion: no streaks, no tunnel, no warp

    // ---- camera: the heading, cursor parallax, a slow idle sway ----
    const sw = noSway ? 0 : 1 - smooth(0, 0.3, s) * 0.7;
    eul.set(
      (-parallax.y * C.parallaxDeg[1] + sw * C.sway.pitch * Math.sin(t / 29 + 1)) * DEG,
      (-parallax.x * C.parallaxDeg[0] + sw * C.sway.yaw * Math.sin(t / 37)) * DEG,
      sw * C.sway.roll * Math.sin(t / 53 + 2) * DEG);
    camera.quaternion.copy(J.q).multiply(qInv.setFromEuler(eul));
    camera.fov = mix(R.fov[0], R.fov[1], motion * Math.pow(smooth(R.fovRange[0], R.fovRange[1], s), 1.2));
    camera.updateProjectionMatrix(); camera.updateMatrixWorld();
    const tanV = Math.tan(camera.fov * DEG / 2);
    U.tan.value.set(tanV * aspect, tanV);
    U.pxScale.value = U.res.value.y / (2 * tanV);
    U.cam.value.setFromMatrix4(camera.matrixWorld); U.view.value.copy(U.cam.value).transpose();
    qInv.copy(camera.quaternion).invert();
    sway.set(noSway ? 0 : C.sway.pos * Math.sin(t / 41), noSway ? 0 : C.sway.pos * 0.7 * Math.sin(t / 33 + 2), 0).applyQuaternion(J.q);
    camPos.copy(J.pos).add(sway); starCam.copy(J.starPos).add(sway);

    // ---- relativity: the direction of travel is the heading ----
    const beta = motion * RL.betaMax * Math.pow(smooth(R.relativity[0], R.relativity[1], s), RL.betaPower), gamma = 1 / Math.sqrt(1 - beta * beta);
    U.beta.value = beta; U.gamma.value = gamma; U.dnorm.value = 1 / (1 + (gamma - 1) * RL.dopplerNorm);
    U.velW.value.copy(FWD).applyQuaternion(J.q); U.velDir.value.copy(U.velW.value).applyQuaternion(qInv);

    // ---- starfield: where the camera is in each layer's cells, and the shutter trail ----
    const shutter = motion * (R.streakShort[2] * smooth(R.streakShort[0], R.streakShort[1], s) + R.streakLong[2] * smooth(R.streakLong[0], R.streakLong[1], s));
    vTmp.copy(U.velDir.value).multiplyScalar(starSpeedAt(s) * shutter);
    const k = 1 - Math.exp(-dt / 1.4);
    for (const key in J.env) J.env[key] += (J.envTo[key] - J.env[key]) * k;
    starLayers.forEach((L, i) => {
      const c = L.cfg.cell, far = i === starLayers.length - 1;
      for (const ax of ['x', 'y', 'z']) {
        const p = starCam[ax] / c, f = Math.floor(p);
        L.u.uCell.value[ax] = ((f % 1048576) + 1048576) % 1048576 + 4096; L.u.uFrac.value[ax] = p - f;
      }
      L.u.uTrail.value.copy(vTmp); L.u.uDensity.value = (far ? J.env.far : J.env.density) * 1.06;
    });

    // ---- sky: the band turns very slowly as we travel ----
    qSky.setFromAxisAngle(skyAxis, J.starDist * CONFIG.sky.turnPerUnit).multiply(skyBase);
    skyU.uSky.value.setFromMatrix4(m4.makeRotationFromQuaternion(qSky));
    skyU.uGain.value = CONFIG.sky.gain * J.env.sky;

    // ---- places: stand each one at its anchor, seen through the same aberration as the stars ----
    pm.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse); frustum.setFromProjectionMatrix(pm);
    for (const p of PLACES) {
      if (!p.live) { p.group.visible = false; continue; }
      rel.copy(p.anchor.pos).sub(camPos);                     // camera-relative (double precision until here)
      const mag = aberrate(rel, relA);
      p.group.position.copy(relA); p.group.quaternion.copy(p.anchor.q); p.group.scale.setScalar(mag);
      sph.center.copy(p.cull.c).multiplyScalar(mag).applyQuaternion(p.anchor.q).add(relA); sph.radius = p.cull.r * mag;
      p.group.visible = frustum.intersectsSphere(sph);        // off screen is not drawn; it is still there
      if (!p.group.visible) continue;
      p.group.updateMatrixWorld(true);
      const b = p.bounds[p.focus]; vTmp.set(b[0], b[1], b[2]).multiplyScalar(mag).applyQuaternion(p.anchor.q).add(relA);
      p.o.value = smooth(1.5, 6, (p.core * mag / Math.max(vTmp.length(), 1e-6)) * U.pxScale.value);
      p.update(t, camera.quaternion);
    }

    // ---- grade ----
    const fu = finalMat.uniforms;
    fu.uVignette.value = mix(R.vignette[0], R.vignette[1], motion * smooth(R.vignetteRange[0], R.vignetteRange[1], s));
    fu.uHaze.value = RL.haze * (beta / RL.betaMax) ** 2;
    vTmp.copy(U.velDir.value);                                         // where "dead ahead" is on screen
    fu.uCentre.value.set(0.5 + 0.5 * vTmp.x / -vTmp.z / U.tan.value.x, 0.5 + 0.5 * vTmp.y / -vTmp.z / U.tan.value.y);
    fu.uGrainSeed.value = REDUCED ? 0.5 : ((t * 24) % 1000 | 0) / 10;
    if (REDUCED) {                                                     // travel happens behind a slow fade
      J.fade += ((J.held || J.completing || J.s > 0.002 ? 1 : 0) - J.fade) * (1 - Math.exp(-dt / CONFIG.reducedMotion.fade));
      fu.uFade.value = J.fade < 0.004 ? 0 : J.fade;
    }
  }

  function render() {
    for (const p of PLACES) if (p.volume) {
      const on = p.group.visible && p.o.value > 0;
      p.volume.comp.visible = on;
      if (on) runPass(p.volume.mat, p.volume.rt);
    }
    renderer.setRenderTarget(sceneRT); renderer.clear(); renderer.render(scene, camera);
    let src = sceneRT, dst = lensRT;                       // lenses, one after another
    for (const p of PLACES) if (p.lens && p.group.visible) {
      p.lens.u.tScene.value = src.texture; runPass(p.lens.mat, dst); [src, dst] = [dst, src];
    }

    let from = src;                              // bloom: down the pyramid, then back up
    for (let i = 0; i < mips.length; i++) {
      downMat.uniforms.tSrc.value = from.texture; downMat.uniforms.uTexel.value.set(1 / from.width, 1 / from.height);
      downMat.uniforms.uPrefilter.value = i === 0 ? 1 : 0;
      runPass(downMat, mips[i]); from = mips[i];
    }
    for (let i = mips.length - 2; i >= 0; i--) {
      upMat.uniforms.tSrc.value = mips[i + 1].texture; upMat.uniforms.uTexel.value.set(1 / mips[i + 1].width, 1 / mips[i + 1].height);
      runPass(upMat, mips[i], false);
    }
    finalMat.uniforms.tScene.value = src.texture;
    runPass(finalMat, null);
  }

  /* --------------------------------------------------------------------------
     Input: one control. Space, a touch, or the mouse held anywhere but the text.
     -------------------------------------------------------------------------- */
  const onText = (e) => ui.isUiTarget(e);
  const holding = { key: false, pointers: new Set() };
  const sync = () => (holding.key || holding.pointers.size ? press() : release());
  window.addEventListener('keydown', (e) => {
    if (e.code !== 'Space' || (e.target && e.target.closest && e.target.closest('a'))) return;
    e.preventDefault();                                     // never scroll the page
    if (!e.repeat) { holding.key = true; sync(); }
  });
  window.addEventListener('keyup', (e) => { if (e.code === 'Space') { e.preventDefault(); holding.key = false; sync(); } });
  window.addEventListener('blur', () => { holding.key = false; holding.pointers.clear(); sync(); });   // losing focus is letting go
  window.addEventListener('pointerdown', (e) => {
    if (onText(e) || (e.pointerType === 'mouse' && e.button !== 0)) return;
    if (e.pointerType === 'mouse') e.preventDefault();      // no text selection or focus change from the sky
    try { e.target.setPointerCapture(e.pointerId); } catch {}
    holding.pointers.add(e.pointerId); sync();
  });
  for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) window.addEventListener(ev, (e) => { if (holding.pointers.delete(e.pointerId)) sync(); });
  window.addEventListener('contextmenu', (e) => { if (!onText(e) && holding.pointers.size) e.preventDefault(); });
  if (!REDUCED) window.addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'mouse') return;
    parallax.tx = (e.clientX / viewW) * 2 - 1; parallax.ty = (e.clientY / viewH) * 2 - 1;
  });
  ui.hint(MOBILE ? 'press and hold' : 'hold space');

  /* --------------------------------------------------------------------------
     Loop
     -------------------------------------------------------------------------- */
  let wall = 0, last = 0, raf = 0, running = false;
  const perf = { frames: 0, since: 0, fps: 60, graceUntil: 0, samples: [] };
  window.__holdSpace = {
    press, release, arrive: (type) => { if (KINDS[type]) arriveNow(type); }, config: CONFIG, seed: SEED, samples: perf.samples,
    get s() { return J.s; }, get held() { return J.held || J.completing; }, get ly() { return J.ly; }, get gliding() { return !!J.glide; },
    get dest() { return J.here && J.here.name; }, get fps() { return perf.fps; }, get quality() { return qualityLevel; },
    /** How the place being approached looks right now: radius of its subject in px, and which places are in view. */
    probe() {
      const p = J.here, b = p.bounds[p.focus];
      vTmp.set(b[0], b[1], b[2]).multiplyScalar(p.group.scale.x).applyQuaternion(p.anchor.q).add(p.group.position);
      return { s: J.s, px: (p.core * p.group.scale.x / vTmp.length()) * U.pxScale.value, dist: vTmp.length(), drawn: PLACES.filter((x) => x.group.visible).map((x) => x.name), live: PLACES.filter((x) => x.live).length };
    },
  };

  function tick(now) {
    raf = requestAnimationFrame(tick);
    const dt = Math.min((now - last) / 1000, 0.05); last = now;
    if (dt <= 0) return;
    wall += dt;
    stepJourney(dt, wall);
    const k = 1 - Math.exp(-dt / CONFIG.camera.parallaxInertia);
    parallax.x += (parallax.tx - parallax.x) * k; parallax.y += (parallax.ty - parallax.y) * k;
    U.time.value = wall;
    update(dt, wall); render();
    if (!J.everHeld && wall > 2 && !hinted) { hinted = true; ui.showHint(true); }

    perf.frames++;                               // adaptive quality: cut render scale before anything else suffers
    if (now - perf.since >= 1000) {
      perf.fps = (perf.frames * 1000) / (now - perf.since); perf.frames = 0; perf.since = now;
      if (params.has('fps')) perf.samples.push(+perf.fps.toFixed(1));
      if (now > perf.graceUntil && perf.fps < Q.minFps && qualityLevel < Q.ladder.length - 1) { setQuality(qualityLevel + 1); perf.graceUntil = now + 2000; }
    }
  }
  let hinted = false;
  function play() { if (running) return; running = true; last = performance.now(); perf.since = last; perf.frames = 0; perf.graceUntil = last + 2500; raf = requestAnimationFrame(tick); }
  function stop() { running = false; cancelAnimationFrame(raf); }
  document.addEventListener('visibilitychange', () => { if (document.hidden) { holding.key = false; holding.pointers.clear(); sync(); stop(); } else play(); });
  window.addEventListener('resize', () => { resize(); if (!running) { update(0.016, wall); render(); } });
  canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); stop(); fallback(); });

  // Warm up: compile every place and pass now, so nothing hitches mid-flight.
  resize();
  for (const name in KINDS) for (const i of [0, 1]) { arriveNow(name, i); update(0.016, 0); renderer.compile(scene, camera); render(); }
  J.arrivals = 0;
  arriveNow(forcedDest || DC.home);
  if (lockedSpeed !== null) J.q.copy(departureHeading(mulberry32(SEED), qT).q);   // preview flights start clear of home
  update(0.016, 0); render();
  document.body.classList.add('live');
  if (!document.hidden) play();
}

/* ---- go ---- */
try {
  if (params.has('nowebgl')) throw new Error('WebGL disabled by flag');
  start();
} catch (err) {
  console.warn('[hold space] falling back:', err);
  fallback();
}
