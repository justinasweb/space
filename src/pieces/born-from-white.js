/* ============================================================================
   BORN FROM WHITE
   A solar system forms out of the white of an empty page.

   Everything is a pure function of one time value T (seconds): camera,
   exposure, every dust particle, the gas, the planets. Nothing is simulated
   step by step, so speeding time up is just advancing T faster.

   Debug query flags (for testing only):
     ?t=20      start at T = 20s          ?pause     freeze T
     ?reduced   force reduced-motion      ?nowebgl   force the no-WebGL fallback
     ?fps       log frame rate to window.__bornFromWhite.fps
   ============================================================================ */
import * as THREE from 'three';
import { mountUI } from '../ui/ui.js';

// The UI starts hidden with dark ink: the piece opens on plain white.
const ui = mountUI({ id: 'born-from-white', tone: 'light', hidden: true });

/* ----------------------------------------------------------------------------
   CONFIG: every tunable in one place.
   Tracks are [time, value] keyframes, interpolated with a monotone cubic.
   ---------------------------------------------------------------------------- */
const CONFIG = {
  // ---- stage timings (seconds of piece time T) ----
  time: {
    startAt: 2.5,          // the piece opens this far in (0 = the full, slow opening on plain white)
    shimmerStart: 1.5,     // the white starts to breathe
    captureStart: 9.0,     // gaps start to open, dust starts flowing into clumps
    ignition: 17.0,        // the star switches on
    waveDelay: 0.25,       // solar-wind front leaves the star this long after ignition
    waveSpeed: 3.1,        // front speed, world units / s
    dustGone: 26.0,        // after this only the surviving belts are drawn
    settled: 28.0,         // the original signature fade-in (no longer used)
    ui: 6.0,               // the UI fades in and its ink turns light, as the white gives way to space
    hint: [4.0, 8.5],      // "hold space" is visible between these times
    orbitSlowdown: [22, 30, 0.4], // orbital motion eases to 40% speed once settled
  },

  // ---- interaction ----
  input: {
    fastForward: 5.0,      // time multiplier while space / touch is held
    easeIn: 0.45,          // seconds (time constant) to speed up
    easeOut: 0.6,          // seconds (time constant) to slow back down
    parallaxDeg: [2.6, 1.6], // max camera swing following the cursor (azimuth, elevation)
    parallaxInertia: 0.9,  // seconds (time constant)
  },

  // ---- quality ----
  quality: {
    particles: { desktop: 420000, mobile: 140000 },
    stars: { desktop: 7000, mobile: 3800 },
    maxDpr: { desktop: 2.0, mobile: 1.5 },
    // If the frame rate sinks below minFps, step down this ladder: [render scale, dust fraction].
    ladder: [[1.0, 1.0], [0.85, 0.75], [0.72, 0.55], [0.6, 0.4], [0.5, 0.3]],
    minFps: 50,
  },

  // ---- camera ----
  camera: {
    fov: 35,
    closeDistance: 6.4,    // face-on, the disk fills the screen
    closeDrift: 0.14,      // slow creep outwards before the pull-back (units / s)
    pullBack: [8.5, 21.0], // distance eases from close to final over this span
    tilt: [9.0, 18.0],     // elevation eases from face-on to tiltDeg over this span
    tiltDeg: 25,           // final elevation above the disk plane
    fitRadius: { landscape: 12.2, portrait: 9.3 }, // world radius that must fit the frame width
    fitMargin: 1.07,
  },

  // ---- exposure & grading (this is what turns white into night) ----
  exposure: [[0, 6.0], [3, 2.0], [5.5, 0.4], [8, 0.125], [9, 0.105], [17, 0.1], [20, 0.15], [22.5, 0.42], [25.5, 1.0]],
  // Blinding glare added on top of the scene, in display units. >= 7.3 is pure white.
  veil: [[0, 40], [1.5, 8.4], [3, 5.2], [5, 1.3], [7.2, 0]],
  veilWhite: [1.0, 0.975, 0.93],
  veilWarm: [1.0, 0.66, 0.30],
  shimmer: 0.11,           // amplitude of the breathing in the white
  bloom: { strength: 0.42, threshold: 0.95, knee: 0.6, radius: 0.62, levels: 6 },
  grain: 0.035,
  vignette: 0.32,

  // ---- the disk ----
  disk: {
    inner: 0.45, outer: 13.2,
    kepler: 0.9,           // angular speed = kepler * r^-1.5
    thickness: 0.034,      // scale height / radius
    particleGain: 1.8,     // HDR radiance of a dust sprite
    particleSize: 0.062,    // world diameter
    gasGain: 9.0,         // HDR radiance of each gas layer
    gasLayers: 3,
    heat: [[0, 1.5], [3, 1.3], [9, 0.86], [17, 0.64], [22, 0.45]],
    arms: [[4, 0], [8.5, 1], [17, 0.8]], // visibility of the spiral density wave
    armPitch: 5.5, armSpeed: 0.11,
    windSpeed: 4.2,        // how fast blown dust leaves
    // heat palette: ember -> deep orange -> yellow -> white-hot
    palette: [[0.30, 0.035, 0.008], [1.0, 0.30, 0.055], [1.0, 0.70, 0.28], [1.0, 0.95, 0.86]],
  },

  // ---- what is left behind ----
  belt: { radius: 3.25, width: 0.17, count: 0.022, color: [0.80, 0.66, 0.52], gain: 0.11, thickness: 0.03 },
  outerRing: { radius: [10.1, 11.6], count: 0.045, color: [0.52, 0.62, 0.80], gain: 0.03, thickness: 0.014 },

  // ---- the star (brightness in display units, i.e. already exposure-compensated) ----
  star: {
    radius: 0.3,
    color: [1.0, 0.86, 0.62], protoColor: [1.0, 0.42, 0.14],
    brightness: [[0, 300], [5, 200], [8, 40], [10.5, 10], [16.9, 10], [17.28, 30], [18.3, 16], [20.5, 12], [25, 10.5]],
    flash: [[16.9, 0], [17.28, 1], [18.4, 0.22], [20.5, 0]],
    glowSize: 11, glowGain: 0.22,
    light: [[9, 0], [16.9, 0.12], [17.5, 1.25], [19.5, 1.0]], // how strongly it lights the planets
    lightFalloff: 0.55,    // artistic: planet light ~ (1.5 / a)^falloff, not inverse-square
    lightColor: [1.0, 0.94, 0.84],
  },

  // ---- planets. type: 0 rocky, 1 temperate, 2 banded giant, 3 ringed giant, 4 ice ----
  planets: [
    { type: 0, a: 1.5, radius: 0.055, theta0: 5.2, tilt: 0.05, spin: 0.5, born: 12.0, gap: [0.13, 0.7],
      wrap: 0.03, atm: null, seed: 1.7 },
    { type: 1, a: 2.4, radius: 0.085, theta0: 2.2, tilt: 0.35, spin: 0.9, born: 11.2, gap: [0.19, 0.8],
      wrap: 0.22, atm: [0.32, 0.58, 1.0], seed: 4.1 },
    { type: 2, a: 4.6, radius: 0.27, theta0: 0.25, tilt: 0.06, spin: 1.6, born: 9.6, gap: [0.5, 0.94],
      wrap: 0.14, atm: [1.0, 0.72, 0.46], seed: 7.3 },
    { type: 3, a: 6.6, radius: 0.2, theta0: 3.55, tilt: 0.45, spin: 1.3, born: 10.2, gap: [0.46, 0.92],
      wrap: 0.14, atm: [1.0, 0.88, 0.62], seed: 2.9, ring: [1.35, 2.4] },
    { type: 4, a: 8.6, radius: 0.105, theta0: 1.45, tilt: 0.5, spin: 0.7, born: 10.8, gap: [0.3, 0.85],
      wrap: 0.1, atm: [0.6, 0.85, 1.0], seed: 5.5 },
  ],
  moltenGain: 15,          // HDR glow of a freshly accreted protoplanet
  moltenCool: [17.2, 21.8],

  // ---- sky ----
  sky: {
    gain: 1.0, milkyWay: 0.035, starGain: 1.5, twinkle: 0.22,
    bandTilt: 20, bandLift: 0.3, bulgeAngle: 40, // where the Milky Way crosses the settled frame
  },

  reducedMotion: { startTime: 60, fade: 3.2 },
};

/* ---------------------------------------------------------------------------- */
const params = new URLSearchParams(location.search);
const REDUCED = params.has('reduced') || matchMedia('(prefers-reduced-motion: reduce)').matches;
const MOBILE = matchMedia('(pointer: coarse)').matches || Math.min(screen.width, screen.height) < 600;
const TAU = Math.PI * 2;
const NP = CONFIG.planets.length;
const canvas = document.getElementById('stage');

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const mix = (a, b, t) => a + (b - a) * t;
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const smoother = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * t * (t * (t * 6 - 15) + 10); };
const wrapPi = (a) => a - TAU * Math.round(a / TAU);
const v3 = (a) => `vec3(${a.map((x) => x.toFixed(5)).join(',')})`;
const fl = (x) => Number(x).toFixed(5);

/** Keyframe track with monotone cubic interpolation (no overshoot, no stalls at keys). */
function makeTrack(keys, log = false) {
  const n = keys.length, xs = keys.map((k) => k[0]), ys = keys.map((k) => (log ? Math.log(k[1]) : k[1]));
  const d = [], m = new Array(n).fill(0);
  for (let i = 0; i < n - 1; i++) d[i] = (ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]);
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (2 * d[i - 1] * d[i]) / (d[i - 1] + d[i]);
  return (t) => {
    let v;
    if (t <= xs[0]) v = ys[0];
    else if (t >= xs[n - 1]) v = ys[n - 1];
    else {
      let i = 0; while (t > xs[i + 1]) i++;
      const h = xs[i + 1] - xs[i], u = (t - xs[i]) / h, u2 = u * u, u3 = u2 * u;
      v = (2 * u3 - 3 * u2 + 1) * ys[i] + (u3 - 2 * u2 + u) * h * m[i] + (-2 * u3 + 3 * u2) * ys[i + 1] + (u3 - u2) * h * m[i + 1];
    }
    return log ? Math.exp(v) : v;
  };
}

const TRACK = {
  exposure: makeTrack(CONFIG.exposure, true),
  veil: makeTrack(CONFIG.veil),
  heat: makeTrack(CONFIG.disk.heat),
  arms: makeTrack(CONFIG.disk.arms),
  star: makeTrack(CONFIG.star.brightness, true),
  flash: makeTrack(CONFIG.star.flash),
  light: makeTrack(CONFIG.star.light),
};

/** Orbital time: equals T during formation, then eases down to a slower, calmer rate. */
function orbitTime(T) {
  const [a, b, rate] = CONFIG.time.orbitSlowdown, span = b - a, x = clamp((T - a) / span, 0, 1);
  const integral = span * (x * x * x - 0.5 * x * x * x * x) + Math.max(0, T - b); // ∫ smoothstep
  return T - (1 - rate) * integral;
}
const kepler = (r) => CONFIG.disk.kepler * Math.pow(r, -1.5);
for (const p of CONFIG.planets) p.omega = kepler(p.a);

/* ----------------------------------------------------------------------------
   Fallback: no WebGL (or it failed). White, then a calm static dark page + text.
   ---------------------------------------------------------------------------- */
function fallback() {
  ui.showHint(false);
  document.body.classList.add('fallback');
  requestAnimationFrame(() => ui.reveal());
  setTimeout(() => setPageDark(), 5000);
}
function setPageDark() {
  document.documentElement.style.background = '#030304';
  document.body.style.background = '#030304';
  document.querySelector('meta[name=theme-color]').content = '#030304';
  ui.tone('dark');
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

// Heat (0 = ember … 1.2 = white-hot) to colour. Shared by gas, dust and molten planets.
const GLSL_HEAT = /* glsl */`
  vec3 heatColor(float h){
    vec3 c = mix(${v3(CONFIG.disk.palette[0])}, ${v3(CONFIG.disk.palette[1])}, smoothstep(0., .42, h));
    c = mix(c, ${v3(CONFIG.disk.palette[2])}, smoothstep(.38, .82, h));
    return mix(c, ${v3(CONFIG.disk.palette[3])}, smoothstep(.78, 1.25, h));
  }
  float heatAt(float r, float heat){ return heat / (.45 + .28 * r); }
`;

const GLSL_RING = /* glsl */`
  // Ring opacity as a function of radius (in planet radii).
  float ringDensity(float rad, vec2 span){
    float x = (rad - span.x) / (span.y - span.x);
    if (x < 0. || x > 1.) return 0.;
    float d = smoothstep(0., .05, x) * (1. - smoothstep(.95, 1., x));
    d *= .7 + .3 * sin(x * 17. + sin(x * 7.) * 1.5);
    d *= 1. - .92 * (smoothstep(.585, .61, x) - smoothstep(.665, .69, x)); // the division
    d *= mix(.3, 1., smoothstep(.12, .3, x));                              // faint inner ring
    return d;
  }
`;

const FULLSCREEN_VERT = /* glsl */`
  varying vec2 vUv;
  void main(){ vUv = position.xy * .5 + .5; gl_Position = vec4(position.xy, 0., 1.); }
`;

/* ============================================================================
   The piece
   ============================================================================ */
function start() {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false, depth: false, stencil: false, powerPreference: 'high-performance' });
  const gl = renderer.getContext();
  if (!renderer.capabilities.isWebGL2 && !gl.getExtension('OES_texture_half_float')) throw new Error('no HDR targets');
  if (!gl.getExtension('EXT_color_buffer_float') && !gl.getExtension('EXT_color_buffer_half_float')) throw new Error('no HDR targets');
  renderer.autoClear = false;
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.setClearColor(0xffffff, 1);

  const Q = CONFIG.quality;
  const dprCap = MOBILE ? Q.maxDpr.mobile : Q.maxDpr.desktop;
  let qualityLevel = 0;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(CONFIG.camera.fov, 1, 0.1, 3000);

  /* ---- fullscreen-pass helper ---- */
  const passGeo = new THREE.BufferGeometry();
  passGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
  const passMesh = new THREE.Mesh(passGeo);
  passMesh.frustumCulled = false;
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

  /* --------------------------------------------------------------------------
     Baked procedural textures (rendered once on the GPU at start-up)
     -------------------------------------------------------------------------- */
  // 1. Tileable fbm for the gas (four decorrelated channels).
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

  // 2. The Milky Way as an equirectangular HDR map: smooth, layered, with dust lanes.
  const S = CONFIG.sky;
  const galBasis = (() => {
    // Place the band relative to the settled view: slightly above centre, gently tilted.
    const el = THREE.MathUtils.degToRad(CONFIG.camera.tiltDeg);
    const view = new THREE.Vector3(0, -Math.sin(el), -Math.cos(el)), up = new THREE.Vector3(0, Math.cos(el), -Math.sin(el)), right = new THREE.Vector3(1, 0, 0);
    const c = view.clone().addScaledVector(up, S.bandLift).normalize();
    const tl = THREE.MathUtils.degToRad(S.bandTilt);
    const t = right.clone().multiplyScalar(Math.cos(tl)).addScaledVector(up, Math.sin(tl));
    const n = new THREE.Vector3().crossVectors(t, c).normalize();           // galactic pole
    const along = new THREE.Vector3().crossVectors(c, n).normalize();
    const ba = THREE.MathUtils.degToRad(S.bulgeAngle);
    const gx = c.clone().multiplyScalar(Math.cos(ba)).addScaledVector(along, Math.sin(ba)).normalize(); // galactic centre
    const gz = new THREE.Vector3().crossVectors(gx, n).normalize();
    return { gx, gy: n, gz };
  })();
  const skyRT = new THREE.WebGLRenderTarget(2048, 1024, {
    type: THREE.HalfFloatType, wrapS: THREE.RepeatWrapping, wrapT: THREE.ClampToEdgeWrapping,
    minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false,
  });
  runPass(passMat(/* glsl */`
    varying vec2 vUv;
    uniform vec3 uGx, uGy, uGz;
    ${GLSL_NOISE}
    void main(){
      float lon = (vUv.x - .5) * 6.2831853, lat = (vUv.y - .5) * 3.14159265;
      vec3 d = vec3(cos(lat) * cos(lon), sin(lat), cos(lat) * sin(lon));
      vec3 g = vec3(dot(d, uGx), dot(d, uGy), dot(d, uGz));
      float b = asin(clamp(g.y, -1., 1.)), l = atan(g.z, g.x);
      // several noise scales, multiplied and layered so nothing reads as a blotch
      float n1 = fbm(g * 2.2 + 4.), n2 = fbm(g * 5.5 + n1 * 1.5), n3 = fbm(g * 13. + 9.), n4 = fbm(g * 31.);
      float bw = .085 + .04 * (n1 - .5);
      float band = exp(-pow(abs(b) / bw, 1.7));
      float bulge = exp(-(l * l / .4 + b * b / .018));
      float glow = band * (.22 + 1.5 * n1 * n2) * (.75 + .5 * n3) * (.85 + .3 * n4) + bulge * .9 * (.6 + .8 * n2);
      // dust lanes: a wandering dark rift along the plane, plus filaments
      float rift = exp(-pow(abs(b + .02 * sin(l * 2.3 + n1 * 3.)) / (.014 + .03 * n2), 2.));
      float lanes = smoothstep(.36, .62, fbm(g * 9. + vec3(3.1, 7.7, 1.3) + .7 * n1));
      glow *= 1. - .82 * rift * lanes;
      glow *= 1. - .35 * smoothstep(.5, .7, n3) * band;
      vec3 warm = vec3(1., .80, .58), cool = vec3(.55, .68, 1.);
      vec3 col = mix(cool, warm, clamp(bulge * 1.4 + (n1 - .35) * .9, 0., 1.));
      col = mix(col, vec3(.9, .45, .3), .35 * rift * lanes);             // reddening near the dust
      gl_FragColor = vec4(col * glow * ${fl(S.milkyWay)}, 1.);
    }
  `, { uGx: { value: galBasis.gx }, uGy: { value: galBasis.gy }, uGz: { value: galBasis.gz } }), skyRT);

  /* --------------------------------------------------------------------------
     Sky: Milky Way sphere + star points. Both follow the camera.
     -------------------------------------------------------------------------- */
  const skyGroup = new THREE.Group(); scene.add(skyGroup);
  const skyMesh = new THREE.Mesh(
    new THREE.SphereGeometry(900, 48, 24),
    new THREE.ShaderMaterial({
      side: THREE.BackSide, depthTest: false, depthWrite: false,
      uniforms: { tSky: { value: skyRT.texture }, uGain: { value: S.gain } },
      vertexShader: /* glsl */`varying vec3 vDir; void main(){ vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.); }`,
      fragmentShader: /* glsl */`
        varying vec3 vDir; uniform sampler2D tSky; uniform float uGain;
        void main(){
          vec3 d = normalize(vDir);
          vec2 uv = vec2(atan(d.z, d.x) / 6.2831853 + .5, asin(clamp(d.y, -1., 1.)) / 3.14159265 + .5);
          gl_FragColor = vec4(textureLod(tSky, uv, 0.).rgb * uGain, 1.);
        }`,
    }));
  skyMesh.renderOrder = -20; skyMesh.frustumCulled = false; skyGroup.add(skyMesh);

  // Stars: black-body colours, a steep brightness distribution (mostly faint, a few bright).
  const rng = mulberry32(20240229);
  function blackbody(K) { // Tanner Helland's fit, normalised
    const t = K / 100; let r, g, b;
    r = t <= 66 ? 255 : 329.698727446 * Math.pow(t - 60, -0.1332047592);
    g = t <= 66 ? 99.4708025861 * Math.log(t) - 161.1195681661 : 288.1221695283 * Math.pow(t - 60, -0.0755148492);
    b = t >= 66 ? 255 : t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
    return [clamp(r, 0, 255) / 255, clamp(g, 0, 255) / 255, clamp(b, 0, 255) / 255];
  }
  const starCount = MOBILE ? Q.stars.mobile : Q.stars.desktop;
  {
    const pos = new Float32Array(starCount * 3), col = new Float32Array(starCount * 3), aux = new Float32Array(starCount * 2);
    const tmp = new THREE.Vector3();
    for (let i = 0; i < starCount; i++) {
      // 62% uniform over the sphere, the rest gathered towards the galactic plane
      let x, y, z;
      if (rng() < 0.62) { y = rng() * 2 - 1; const a = rng() * TAU, s = Math.sqrt(1 - y * y); x = s * Math.cos(a); z = s * Math.sin(a); }
      else { const b = gauss(rng) * 0.17, a = rng() * TAU; y = Math.sin(b); x = Math.cos(b) * Math.cos(a); z = Math.cos(b) * Math.sin(a); }
      tmp.set(0, 0, 0).addScaledVector(galBasis.gx, x).addScaledVector(galBasis.gy, y).addScaledVector(galBasis.gz, z).multiplyScalar(800);
      pos.set([tmp.x, tmp.y, tmp.z], i * 3);
      const flux = Math.min(5, 0.022 * Math.pow(1 - rng() * 0.9995, -0.82));          // power law
      const K = flux > 0.6 && rng() < 0.45 ? 7500 + rng() * 14000 : 2700 + 7800 * Math.pow(rng(), 1.9);
      const c = blackbody(K), sat = 0.62;
      const size = 1.25 + 1.25 * clamp(Math.log10(flux / 0.022) / 2.2, 0, 1);
      // small sprites carry the same energy as large ones would
      const peak = flux * S.starGain * 2.6 / (size * size * 0.6);
      col.set([mix(1, c[0], sat) * peak, mix(1, c[1], sat) * peak, mix(1, c[2], sat) * peak], i * 3);
      aux.set([size, rng()], i * 2);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aCol', new THREE.BufferAttribute(col, 3));
    g.setAttribute('aAux', new THREE.BufferAttribute(aux, 2));
    var starMat = new THREE.ShaderMaterial({
      transparent: true, depthTest: true, depthWrite: false,
      blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
      uniforms: { uDpr: { value: 1 }, uTime: { value: 0 }, uTwinkle: { value: REDUCED ? 0 : S.twinkle } },
      vertexShader: /* glsl */`
        attribute vec3 aCol; attribute vec2 aAux; uniform float uDpr, uTime, uTwinkle; varying vec3 vCol;
        void main(){
          float tw = sin(uTime * (.6 + aAux.y * 2.4) + aAux.y * 61.) * sin(uTime * (.23 + aAux.y) + aAux.y * 17.);
          vCol = aCol * (1. + uTwinkle * tw);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.);
          gl_PointSize = aAux.x * uDpr * 1.6;
        }`,
      fragmentShader: /* glsl */`
        varying vec3 vCol;
        void main(){ vec2 q = gl_PointCoord - .5; float a = exp(-dot(q, q) * 22.) - .0041; if (a <= 0.) discard; gl_FragColor = vec4(vCol * a, 1.); }`,
    });
    const stars = new THREE.Points(g, starMat);
    stars.frustumCulled = false; stars.renderOrder = 0; skyGroup.add(stars);
  }

  /* --------------------------------------------------------------------------
     The star: a granulated sphere + a soft glow billboard
     -------------------------------------------------------------------------- */
  const ST = CONFIG.star;
  const sunMat = new THREE.ShaderMaterial({
    uniforms: { uI: { value: 1 }, uIgnite: { value: 0 }, uTime: { value: 0 } },
    vertexShader: /* glsl */`
      varying vec3 vN, vWN, vWP;
      void main(){ vN = normalize(position); vWN = normalize(mat3(modelMatrix) * normal); vec4 wp = modelMatrix * vec4(position, 1.); vWP = wp.xyz; gl_Position = projectionMatrix * viewMatrix * wp; }`,
    fragmentShader: /* glsl */`
      varying vec3 vN, vWN, vWP; uniform float uI, uIgnite, uTime;
      ${GLSL_NOISE}
      void main(){
        float nv = clamp(dot(normalize(vWN), normalize(cameraPosition - vWP)), 0., 1.);
        float gran = fbm(vN * 7. + vec3(0., uTime * .04, 0.)) * fbm3(vN * 19. - vec3(uTime * .07));
        vec3 col = mix(${v3(ST.protoColor)}, ${v3(ST.color)}, uIgnite);
        gl_FragColor = vec4(col * uI * (.55 + 1.9 * gran) * mix(1., .45 + .55 * pow(nv, .6), uIgnite), 1.);
      }`,
  });
  const sun = new THREE.Mesh(new THREE.SphereGeometry(ST.radius, 48, 32), sunMat);
  sun.renderOrder = -10; scene.add(sun);

  const glowMat = new THREE.ShaderMaterial({
    transparent: true, depthTest: true, depthWrite: false,
    blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
    uniforms: { uI: { value: 0 }, uIgnite: { value: 0 }, uFlash: { value: 0 } },
    vertexShader: /* glsl */`varying vec2 vQ; void main(){ vQ = position.xy * 2.; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.); }`,
    fragmentShader: /* glsl */`
      varying vec2 vQ; uniform float uI, uIgnite, uFlash;
      void main(){
        float d = length(vQ); if (d >= 1.) discard;
        float edge = (1. - d) * (1. - d);
        float core = exp(-d * d * (150. - 60. * uFlash));
        float halo = edge / (1. + d * d * (160. - 90. * uFlash));
        vec3 col = mix(${v3(ST.protoColor)}, ${v3(ST.color)}, uIgnite);
        gl_FragColor = vec4(col * uI * (core + .16 * halo), 1.);
      }`,
  });
  const glow = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), glowMat);
  glow.renderOrder = 4; scene.add(glow);

  /* --------------------------------------------------------------------------
     Planets
     -------------------------------------------------------------------------- */
  const PLANET_VERT = /* glsl */`
    varying vec3 vN, vWN, vWP;
    void main(){ vN = normalize(position); vWN = normalize(mat3(modelMatrix) * normal); vec4 wp = modelMatrix * vec4(position, 1.); vWP = wp.xyz; gl_Position = projectionMatrix * viewMatrix * wp; }`;
  const PLANET_FRAG = /* glsl */`
    varying vec3 vN, vWN, vWP;
    uniform int uType;
    uniform vec3 uSunW, uSunL, uLight, uAtm;
    uniform float uSpin, uMolten, uSeed, uWrap, uRingVis; uniform vec2 uRing;
    ${GLSL_NOISE} ${GLSL_HEAT} ${GLSL_RING}
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
        vec3 sp = p - normalize(vec3(.72, -.36, .59));               // one great storm
        c = mix(c, vec3(.62, .22, .12), smoothstep(.2, .08, length(sp * vec3(1., 2.3, 1.))));
        return c * mix(.6, 1., smoothstep(1., .7, abs(p.y)));
      }
      if (uType == 3){            // pale ringed giant, soft bands
        float turb = fbm(vec3(p.x * 1.5, p.y * 5., p.z * 1.5) + uSeed);
        float band = sin(p.y * 11. + (turb - .5) * 3.) * .5 + .5;
        vec3 c = mix(vec3(.66, .55, .37), vec3(.90, .81, .60), smoothstep(.1, .9, band));
        return mix(c, vec3(.55, .58, .56), .35 * smoothstep(.6, 1., abs(p.y)));
      }
      // ice world: pale plains, blue fracture lines
      float plains = fbm(p * 2. + uSeed);
      float cracks = pow(1. - abs(vnoise(p * 5.5 + uSeed) * 2. - 1.), 9.) + .6 * pow(1. - abs(vnoise(p * 12. - uSeed) * 2. - 1.), 12.);
      vec3 c = mix(vec3(.62, .76, .90), vec3(.86, .93, .98), smoothstep(.3, .7, plains));
      return mix(c, vec3(.22, .42, .68), clamp(cracks, 0., 1.) * .8);
    }

    void main(){
      vec3 N = normalize(vWN), V = normalize(cameraPosition - vWP);
      float nv = clamp(dot(N, V), 0., 1.), ndl = dot(N, uSunW);
      vec3 p = rotY(vN, uSpin);
      vec3 alb = albedo(p);

      // lit only by the star: a soft terminator, softer where there is atmosphere
      float d = clamp((ndl + uWrap) / (1. + uWrap), 0., 1.);
      float diff = pow(d, 1.15) * mix(1., .62 + .38 * sqrt(nv), step(1.5, float(uType)) * step(float(uType), 3.5));
      vec3 col = alb * uLight * diff;

      if (uType == 3 && abs(uSunL.y) > 1e-4){                          // shadow of the rings
        float s = -vN.y / uSunL.y;
        if (s > 0.){ vec3 q = vN + s * uSunL; col *= 1. - .78 * uRingVis * ringDensity(length(q.xz), uRing); }
      }
      // atmospheric rim: scattering reaches a little past the terminator
      float fres = pow(1. - nv, 3.2);
      col += uAtm * uLight * fres * smoothstep(-.42, .3, ndl) * .85;

      // freshly accreted: glowing, then a cooling crust with bright cracks
      float crack = fbm(p * 5. + uSeed);
      float hot = smoothstep(1. - uMolten * 1.3, 1.35 - uMolten * 1.3, crack);
      col = mix(col, heatColor(.5 + .75 * crack) * ${fl(CONFIG.moltenGain)} * (.3 + crack), hot);

      float aa = clamp(nv / max(fwidth(nv) * 1.5, 1e-4), 0., 1.);     // analytic edge anti-aliasing
      gl_FragColor = vec4(col, aa);
    }`;
  const SHELL_FRAG = /* glsl */`
    varying vec3 vN, vWN, vWP; uniform vec3 uSunW, uLight, uAtm; uniform float uLimb, uVis;
    void main(){
      vec3 N = normalize(vWN), V = normalize(cameraPosition - vWP);
      float nv = clamp(dot(N, V), 0., 1.);
      float a = smoothstep(0., uLimb, nv) * (1. - smoothstep(uLimb, uLimb + .3, nv));
      float lit = smoothstep(-.5, .25, dot(N, uSunW));
      gl_FragColor = vec4(uAtm * uLight * a * a * lit * .5 * uVis, 1.);
    }`;
  const RING_FRAG = /* glsl */`
    varying vec3 vL; varying vec3 vWP; uniform vec3 uSunL, uLight, uUpW; uniform float uVis; uniform vec2 uRing;
    ${GLSL_RING}
    void main(){
      float rad = length(vL.xz), dens = ringDensity(rad, uRing);
      float t = -dot(vL, uSunL);                                     // shadow of the planet
      float shadow = t > 0. ? smoothstep(.93, 1.04, length(vL + t * uSunL)) : 1.;
      vec3 V = normalize(cameraPosition - vWP);
      float sameSide = step(0., uSunL.y * dot(V, uUpW));             // lit face vs. light leaking through
      float x = (rad - uRing.x) / (uRing.y - uRing.x);
      vec3 col = mix(vec3(.62, .52, .40), vec3(.93, .87, .76), dens) * mix(.85, 1.1, x);
      col *= uLight * shadow * mix(.3 * (1. - dens * .6), .95, sameSide) * (.35 + .65 * smoothstep(0., .25, abs(uSunL.y)));
      gl_FragColor = vec4(col, dens * .9 * uVis);
    }`;

  const sphereGeo = new THREE.SphereGeometry(1, 64, 40);
  const planets = CONFIG.planets.map((cfg) => {
    const group = new THREE.Group(); scene.add(group);
    const tilt = new THREE.Group(); group.add(tilt);
    tilt.rotation.set(cfg.tilt, 0, cfg.tilt * 0.4);
    const u = {
      uType: { value: cfg.type }, uSunW: { value: new THREE.Vector3() }, uSunL: { value: new THREE.Vector3() },
      uLight: { value: new THREE.Vector3() }, uAtm: { value: new THREE.Vector3(...(cfg.atm || [0, 0, 0])) },
      uSpin: { value: 0 }, uMolten: { value: 1 }, uSeed: { value: cfg.seed }, uWrap: { value: cfg.wrap },
      uRing: { value: new THREE.Vector2(...(cfg.ring || [9, 9])) }, uRingVis: { value: 0 },
      uLimb: { value: 0 }, uVis: { value: 0 }, uUpW: { value: new THREE.Vector3() },
    };
    const body = new THREE.Mesh(sphereGeo, new THREE.ShaderMaterial({ uniforms: u, vertexShader: PLANET_VERT, fragmentShader: PLANET_FRAG, transparent: true }));
    body.renderOrder = 1; tilt.add(body);
    if (cfg.atm) {
      const s = cfg.type === 1 ? 1.1 : 1.07;
      u.uLimb.value = Math.sqrt(1 - 1 / (s * s));
      const shell = new THREE.Mesh(sphereGeo, new THREE.ShaderMaterial({
        uniforms: u, vertexShader: PLANET_VERT, fragmentShader: SHELL_FRAG, transparent: true, depthWrite: false,
        blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
      }));
      shell.scale.setScalar(s); shell.renderOrder = 3; tilt.add(shell);
    }
    if (cfg.ring) {
      const ring = new THREE.Mesh(new THREE.RingGeometry(cfg.ring[0], cfg.ring[1], 128, 1), new THREE.ShaderMaterial({
        uniforms: u, transparent: true, depthWrite: false, side: THREE.DoubleSide,
        vertexShader: /* glsl */`
          varying vec3 vL, vWP;
          void main(){ vL = vec3(position.x, 0., position.y); vec4 wp = modelMatrix * vec4(vL, 1.); vWP = wp.xyz; gl_Position = projectionMatrix * viewMatrix * wp; }`,
        fragmentShader: RING_FRAG,
      }));
      ring.renderOrder = 2; ring.frustumCulled = false; tilt.add(ring);
    }
    return { cfg, group, tilt, u, light: Math.pow(1.5 / cfg.a, ST.lightFalloff) * 1.5 };
  });

  /* --------------------------------------------------------------------------
     Gas: a few noise-shaded, flared disk layers. Gives the dust a body.
     -------------------------------------------------------------------------- */
  const D = CONFIG.disk, TM = CONFIG.time;
  const gapUniform = CONFIG.planets.map((p) => new THREE.Vector4(p.a, p.gap[0], 0, 0));
  const gasShared = {
    tNoise: { value: noiseRT.texture }, uT: { value: 0 }, uTau: { value: 0 }, uHeat: { value: 1 }, uArms: { value: 0 },
    uWaveR: { value: -1 }, uFlash: { value: 0 }, uGain: { value: D.gasGain }, uGap: { value: gapUniform },
  };
  const gasLayers = [];
  const gasGeo = new THREE.RingGeometry(D.inner * 0.6, D.outer + 1, 160, 40);
  for (let i = 0; i < D.gasLayers; i++) {
    const layer = D.gasLayers > 1 ? (i / (D.gasLayers - 1)) * 2 - 1 : 0;
    const m = new THREE.Mesh(gasGeo, new THREE.ShaderMaterial({
      transparent: true, depthTest: true, depthWrite: false, side: THREE.DoubleSide,
      blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
      uniforms: { ...gasShared, uLayer: { value: layer } },
      vertexShader: /* glsl */`
        uniform float uLayer; varying vec2 vP;
        void main(){
          vP = position.xy; float r = length(vP);
          vec3 p = vec3(position.x, uLayer * ${fl(D.thickness * 1.3)} * pow(r, 1.2), position.y);   // flared
          gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.);
        }`,
      fragmentShader: /* glsl */`
        varying vec2 vP;
        uniform sampler2D tNoise; uniform float uT, uTau, uHeat, uArms, uWaveR, uFlash, uGain, uLayer; uniform vec4 uGap[${NP}];
        ${GLSL_HEAT}
        float cloud(vec2 uv, float lod){
          return textureLod(tNoise, uv, lod).r * .5 + textureLod(tNoise, uv * 3. + .37, lod + 1.585).g * .3 + textureLod(tNoise, uv * 9. + .71, lod + 3.17).b * .2;
        }
        void main(){
          float r = length(vP), th = atan(vP.y, vP.x), lr = log(r);
          float w = ${fl(D.kepler)} * pow(r, -1.5);
          // Keplerian shear, advected in two overlapping phases so it never winds up forever
          const float P = 11.;
          float f1 = fract(uTau / P), f2 = fract(uTau / P + .5);
          float c1 = floor(uTau / P), c2 = floor(uTau / P + .5);
          float lod = log2(max(length(fwidth(vP)) / r * 512. * .8, 1.));
          vec2 uvA = vec2((th - w * (f1 * P + 5.)) / 6.2831853 * 3., lr * 1.25 + c1 * .37 + uLayer * .13);
          vec2 uvB = vec2((th - w * (f2 * P + 5.)) / 6.2831853 * 3., lr * 1.25 + c2 * .37 + .5 + uLayer * .13);
          float wa = 1. - abs(2. * f1 - 1.);
          float n = mix(cloud(uvB, lod), cloud(uvA, lod), wa);
          n = (n - .5) / mix(.72, 1., abs(2. * wa - 1.)) + .5;         // keep contrast through the cross-fade
          float turb = smoothstep(.3, .78, n);

          // two-armed trailing density wave
          float arm = .5 + .5 * cos(2. * (th - ${fl(D.armSpeed)} * uT) + ${fl(D.armPitch)} * lr + (n - .5) * 3.2);
          float dens = pow(r, -.85) * smoothstep(${fl(D.inner * 0.75)}, ${fl(D.inner * 2.2)}, r) * (1. - smoothstep(${fl(D.outer * 0.62)}, ${fl(D.outer)}, r));
          dens *= mix(1., .22 + 1.75 * arm * arm, uArms) * (.3 + 1.5 * turb * turb);

          // gaps carved by the protoplanets
          for (int i = 0; i < ${NP}; i++){ float q = (r - uGap[i].x) / uGap[i].y; dens *= 1. - uGap[i].z * exp(-q * q); }

          // the solar wind: cleared inside the front, swept up into a shell at the front
          if (uWaveR > 0.){
            float x = r - uWaveR;
            dens *= smoothstep(-2.6, .2, x);
            dens *= 1. + 1.6 * exp(-x * x / .3) * smoothstep(0., 1.5, uWaveR);
          }
          float h = heatAt(r, uHeat) + .12 * (turb - .5) + .25 * uFlash / (1. + r * .5);
          vec3 col = heatColor(h) * (.2 + 1.6 * h * h);
          gl_FragColor = vec4(col * dens * uGain * (1. + .5 * uFlash / (1. + r * .35)), 1.);
        }`,
    }));
    m.renderOrder = 5; m.frustumCulled = false; scene.add(m); gasLayers.push(m);
  }

  /* --------------------------------------------------------------------------
     Dust: every particle is an analytic orbit with a fate, evaluated in the
     vertex shader from T alone.
       position = (r0, phase, inclination)
       aA       = (fate, tEvent, duration, relative angle at stream start)
       aB       = four random numbers
     Fates: 0 blown away by the wind · 1..NP captured by that planet ·
            NP+1 falls into the star · NP+2 debris belt · NP+3 outer ring
     -------------------------------------------------------------------------- */
  const total = MOBILE ? Q.particles.mobile : Q.particles.desktop;
  const nBelt = Math.round(total * CONFIG.belt.count), nRing = Math.round(total * CONFIG.outerRing.count);
  const nKeep = nBelt + nRing, nDust = total - nKeep;
  const dustGeo = new THREE.BufferGeometry();
  {
    const P = new Float32Array(total * 3), A = new Float32Array(total * 4), B = new Float32Array(total * 4);
    const t9 = TM.captureStart, tEnd = TM.ignition + 0.2;
    for (let i = 0; i < total; i++) {
      let r0, inc, fate = 0, tEvent = 0, dur = 0, rel = 0;
      const phase = rng() * TAU;
      if (i < nBelt) {                 // survivors come first so they can be drawn alone later
        r0 = CONFIG.belt.radius + clamp(gauss(rng), -2.4, 2.4) * CONFIG.belt.width; inc = gauss(rng) * CONFIG.belt.thickness; fate = NP + 2;
      } else if (i < nKeep) {
        const u = rng(), v = rng(); r0 = mix(CONFIG.outerRing.radius[0], CONFIG.outerRing.radius[1], (u + v) * 0.5); inc = gauss(rng) * CONFIG.outerRing.thickness; fate = NP + 3;
      } else {
        do { r0 = D.inner + (D.outer - D.inner) * Math.pow(rng(), 1.12); } while (rng() < smooth(D.outer * 0.72, D.outer, r0));
        inc = gauss(rng) * D.thickness;
        const w0 = kepler(r0);
        if (rng() < 1 - smooth(0.7, 1.05, r0)) {               // innermost dust feeds the star
          fate = NP + 1; dur = 3 + 2.5 * rng(); tEvent = t9 + 0.5 + dur + (tEnd - t9 - dur - 0.3) * Math.pow(rng(), 0.8);
        } else {
          for (let k = 0; k < NP; k++) {
            const p = CONFIG.planets[k], q = (r0 - p.a) / p.gap[0];
            if (Math.abs(q) < 2.3 && rng() < p.gap[1] * Math.exp(-q * q)) {
              // Dust far around the orbit arrives later, and takes longer: the gap empties as a stream.
              const far = Math.abs(wrapPi(phase + w0 * t9 - (p.theta0 + p.omega * t9))) / Math.PI;
              tEvent = Math.min(tEnd, p.born + 0.9 + (tEnd - p.born - 0.9) * Math.pow(far, 0.75) + (rng() - 0.5) * 0.7);
              dur = Math.min(1.7 + 2.6 * far + rng() * 0.6, tEvent - (t9 - 0.6));
              const ts = tEvent - dur;
              rel = wrapPi(phase + w0 * ts - (p.theta0 + p.omega * ts));
              fate = k + 1; break;
            }
          }
        }
      }
      P.set([r0, phase, inc], i * 3); A.set([fate, tEvent, dur, rel], i * 4); B.set([rng(), rng(), rng(), rng()], i * 4);
    }
    dustGeo.setAttribute('position', new THREE.BufferAttribute(P, 3));
    dustGeo.setAttribute('aA', new THREE.BufferAttribute(A, 4));
    dustGeo.setAttribute('aB', new THREE.BufferAttribute(B, 4));
  }
  const plUniform = CONFIG.planets.map((p) => new THREE.Vector4(p.a, 0, p.omega, p.radius));
  const dustMat = new THREE.ShaderMaterial({
    transparent: true, depthTest: true, depthWrite: false,
    blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
    uniforms: {
      uT: { value: 0 }, uTauHi: { value: 0 }, uTauLo: { value: 0 }, uHeat: { value: 1 }, uArms: { value: 0 }, uFlash: { value: 0 },
      uGain: { value: D.particleGain }, uPxScale: { value: 1 }, uMinPx: { value: 1.5 }, uMaxPx: { value: 8 }, uPl: { value: plUniform },
    },
    vertexShader: /* glsl */`
      attribute vec4 aA, aB;
      uniform float uT, uTauHi, uTauLo, uHeat, uArms, uFlash, uGain, uPxScale, uMinPx, uMaxPx; uniform vec4 uPl[${NP}];
      varying vec3 vCol;
      ${GLSL_HEAT}
      const float TAU = 6.2831853;
      void main(){
        float r0 = position.x, inc = position.z, fate = aA.x;
        float w0 = ${fl(D.kepler)} * pow(r0, -1.5);
        // base Keplerian orbit; the time is split in two so precision survives hours of running
        float th = position.y + mod(w0 * uTauHi, TAU) + w0 * uTauLo;
        float r = r0, alpha = 1., boost = 1., hAdd = 0., yScale = 1., cold = 0.;
        vec3 off = vec3(0.);
        float tw = ${fl(TM.ignition + TM.waveDelay)} + r0 / ${fl(TM.waveSpeed)};  // when the wind front arrives
        float x = uT - tw;

        if (fate < .5){                                   // blown out of the system
          if (x > 0.){
            float xr = x * (.55 + .9 * aB.x);
            r += ${fl(D.windSpeed)} * xr * xr / (xr + .8);
            alpha = exp(-1.25 * x) * (1. - smoothstep(1.8, 3.4, x));
            boost = 1. + 2.2 * exp(-5. * x); yScale = 1. + 1.6 * x; hAdd = .3 * exp(-3. * x);
          }
        } else if (fate < ${NP}.5){                        // streams along the gap into a protoplanet
          vec4 pl = uPl[int(fate) - 1];
          float tc = aA.y, ts = aA.y - aA.z;
          if (uT > ts){
            float s = clamp((uT - ts) / aA.z, 0., 1.), e = s * s * (1.6 - .6 * s);
            float rel = aA.w + (w0 - pl.z) * (min(uT, tc) - ts);
            th = pl.y + rel * (1. - e);
            r = mix(r0, pl.x, e);
            float sink = smoothstep(tc, tc + 2.3, uT);     // then it settles onto the growing planet
            float rho = pl.w * (1.2 + 3.4 * aB.y * aB.y) * e * (1. - .92 * sink);
            float phi = aB.x * TAU + (uT - ts) * (3. + 4. * aB.w);
            off = rho * vec3(cos(phi), (aB.z - .5) * .45, sin(phi));
            alpha = 1. - smoothstep(tc + .15, tc + 2.3, uT);
            boost = 1. + .7 * e; hAdd = .22 * e; yScale = 1. - e;
          }
        } else if (fate < ${NP + 1}.5){                    // spirals into the star
          float ts = aA.y - aA.z;
          if (uT > ts){
            float s = clamp((uT - ts) / aA.z, 0., 1.), e = s * s;
            r = mix(r0, .22, e); th += 3.5 * e * e; alpha = 1. - smoothstep(.4, .9, s); boost = 1. + e; hAdd = .4 * e; yScale = 1. - e;
          }
        } else {                                          // survives: belt or outer ring
          if (x > 0.){ boost = 1. + 1.5 * exp(-4. * x); cold = smoothstep(0., 2.5, x); r += .12 * (aB.x - .5) * (1. - exp(-x)); }
        }

        vec3 pos = vec3(r * cos(th), r * inc * sin(th + aB.w * TAU) * yScale, r * sin(th)) + off;

        float h = heatAt(r0, uHeat) + hAdd + .1 * (aB.y - .5) + .25 * uFlash / (1. + r0 * .5);
        float arm = .5 + .5 * cos(2. * (th - ${fl(D.armSpeed)} * uT) + ${fl(D.armPitch)} * log(r0));
        float bright = (.2 + 1.6 * h * h) * (.65 + .7 * aB.z) * mix(1., .3 + 1.6 * arm * arm, uArms * step(fate, .5)) * boost;
        vec3 col = heatColor(h) * bright * uGain * (1. + .5 * uFlash / (1. + r0 * .35));
        vec3 coldCol = fate < ${NP + 2}.5 ? ${v3(CONFIG.belt.color)} * ${fl(CONFIG.belt.gain)} : ${v3(CONFIG.outerRing.color)} * ${fl(CONFIG.outerRing.gain)};
        col = mix(col, coldCol * (.35 + 1.3 * aB.z * aB.z), cold) * alpha;

        vec4 mv = modelViewMatrix * vec4(pos, 1.);
        gl_Position = alpha > .002 ? projectionMatrix * mv : vec4(2., 2., 2., 1.);
        float px = ${fl(D.particleSize)} * (.55 + .9 * aB.x) * mix(1., .42, cold) * uPxScale / -mv.z;
        float cl = clamp(px, uMinPx, uMaxPx);
        vCol = col * min(1., (px * px) / (cl * cl));       // tiny sprites keep their energy, not their size
        gl_PointSize = cl;
      }`,
    fragmentShader: /* glsl */`
      varying vec3 vCol;
      void main(){ vec2 q = gl_PointCoord - .5; float a = exp(-dot(q, q) * 11.) - .064; if (a <= 0.) discard; gl_FragColor = vec4(vCol * a, 1.); }`,
  });
  const dust = new THREE.Points(dustGeo, dustMat);
  dust.frustumCulled = false; dust.renderOrder = 6; scene.add(dust);

  /* --------------------------------------------------------------------------
     Post: HDR target -> bloom pyramid -> exposure, filmic tone map, grain, vignette
     -------------------------------------------------------------------------- */
  const BL = CONFIG.bloom;
  const hdrOpts = { type: THREE.HalfFloatType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false };
  const sceneRT = new THREE.WebGLRenderTarget(4, 4, { ...hdrOpts, depthBuffer: true });
  const mips = Array.from({ length: BL.levels }, () => new THREE.WebGLRenderTarget(2, 2, hdrOpts));

  const downMat = passMat(/* glsl */`
    varying vec2 vUv; uniform sampler2D tSrc; uniform vec2 uTexel; uniform float uExposure, uPrefilter;
    vec3 s(vec2 o){ return texture(tSrc, vUv + o * uTexel).rgb; }
    void main(){   // 13-tap downsample: stable, no shimmer on small bright things
      vec3 c = s(vec2(0)) * .125;
      c += (s(vec2(-1,-1)) + s(vec2(1,-1)) + s(vec2(-1,1)) + s(vec2(1,1))) * .125;
      c += (s(vec2(-2,-2)) + s(vec2(2,-2)) + s(vec2(-2,2)) + s(vec2(2,2))) * .03125;
      c += (s(vec2(0,-2)) + s(vec2(-2,0)) + s(vec2(2,0)) + s(vec2(0,2))) * .0625;
      if (uPrefilter > .5){   // exposed, soft-knee threshold
        c = min(c * uExposure, vec3(60.));
        float br = max(c.r, max(c.g, c.b)), soft = clamp(br - ${fl(BL.threshold - BL.knee)}, 0., ${fl(2 * BL.knee)});
        soft = soft * soft / ${fl(4 * BL.knee + 1e-4)};
        c *= max(soft, br - ${fl(BL.threshold)}) / max(br, 1e-4);
      }
      gl_FragColor = vec4(c, 1.);
    }`, { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() }, uExposure: { value: 1 }, uPrefilter: { value: 0 } });
  const upMat = passMat(/* glsl */`
    varying vec2 vUv; uniform sampler2D tSrc; uniform vec2 uTexel;
    vec3 s(vec2 o){ return texture(tSrc, vUv + o * uTexel).rgb; }
    void main(){   // 3x3 tent, blended into the level above
      vec3 c = s(vec2(0)) * 4. + (s(vec2(-1,0)) + s(vec2(1,0)) + s(vec2(0,-1)) + s(vec2(0,1))) * 2. + s(vec2(-1,-1)) + s(vec2(1,-1)) + s(vec2(-1,1)) + s(vec2(1,1));
      gl_FragColor = vec4(c / 16., ${fl(BL.radius)});
    }`, { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() } }, { transparent: true, blending: THREE.NormalBlending, premultipliedAlpha: false });

  const finalMat = passMat(/* glsl */`
    varying vec2 vUv;
    uniform sampler2D tScene, tBloom;
    uniform float uExposure, uVeil, uVeilNeutral, uShimmer, uTime, uGrain, uGrainSeed, uAspect;
    ${GLSL_NOISE}
    vec3 aces(vec3 x){ return clamp((x * (2.51 * x + .03)) / (x * (2.43 * x + .59) + .14), 0., 1.); }   // reaches exactly 1.0 at x ≈ 7.24
    vec3 toSrgb(vec3 c){ return mix(c * 12.92, 1.055 * pow(c, vec3(1. / 2.4)) - .055, step(.0031308, c)); }
    void main(){
      vec3 c = texture(tScene, vUv).rgb * uExposure + texture(tBloom, vUv).rgb * ${fl(BL.strength)};
      vec2 q = (vUv - .5) * vec2(min(uAspect, 1.6), 1.);
      c *= 1. - ${fl(CONFIG.vignette)} * smoothstep(.28, 1.05, length(q) * 1.15);

      // The blinding light of the newborn system. It does not fade: it cools.
      if (uVeil > 0.){
        float breathe = 0.;
        if (uShimmer > 0.){
          vec2 p = (vUv - .5) * vec2(uAspect, 1.);
          breathe = (fbm3(vec3(p * 1.7, uTime * .16)) - .5) * 1.6 + (fbm3(vec3(p * 4.5 + 7., uTime * .27)) - .5) * .7 + .35 * sin(uTime * .9);
        }
        vec3 tint = mix(mix(${v3(CONFIG.veilWarm)}, ${v3(CONFIG.veilWhite)}, smoothstep(0., 8., uVeil)), vec3(1.), uVeilNeutral);
        c += uVeil * tint * (1. + uShimmer * breathe);
      }

      c = toSrgb(aces(c));
      float open = step(min(c.r, min(c.g, c.b)), .99999);            // leave pure white untouched
      float lum = dot(c, vec3(.299, .587, .114));
      float g = hash12(gl_FragCoord.xy + uGrainSeed * 61.7) + hash12(gl_FragCoord.yx + uGrainSeed * 17.3 + 5.) - 1.;
      c += g * uGrain * (.35 + .65 * smoothstep(0., .3, lum) * (1. - smoothstep(.75, 1., lum))) * open;
      c += (hash12(gl_FragCoord.xy * 1.31 + 3.7) + hash12(gl_FragCoord.xy * .77 + 11.1) - 1.) / 255. * open;   // dither
      gl_FragColor = vec4(c, 1.);
    }`, {
    tScene: { value: sceneRT.texture }, tBloom: { value: mips[0].texture },
    uExposure: { value: 1 }, uVeil: { value: 40 }, uVeilNeutral: { value: REDUCED ? 1 : 0 }, uShimmer: { value: 0 }, uTime: { value: 0 },
    uGrain: { value: CONFIG.grain }, uGrainSeed: { value: 0 }, uAspect: { value: 1 },
  });

  /* --------------------------------------------------------------------------
     Size, quality
     -------------------------------------------------------------------------- */
  let viewW = 1, viewH = 1, finalDistance = 26;
  function resize() {
    viewW = Math.max(1, window.innerWidth); viewH = Math.max(1, window.innerHeight);
    const [scale] = Q.ladder[qualityLevel];
    const dpr = Math.min(window.devicePixelRatio || 1, dprCap) * scale;
    renderer.setPixelRatio(dpr);
    renderer.setSize(viewW, viewH, false);
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    sceneRT.setSize(size.x, size.y);
    let w = size.x, h = size.y;
    for (const m of mips) { w = Math.max(1, w >> 1); h = Math.max(1, h >> 1); m.setSize(w, h); }

    const aspect = viewW / viewH, C = CONFIG.camera;
    camera.aspect = aspect; camera.updateProjectionMatrix();
    const vTan = Math.tan(THREE.MathUtils.degToRad(C.fov) / 2), hTan = vTan * aspect;
    const fitR = mix(C.fitRadius.portrait, C.fitRadius.landscape, smooth(0.75, 1.25, aspect));
    const el = THREE.MathUtils.degToRad(C.tiltDeg);
    finalDistance = Math.max(fitR * C.fitMargin / hTan, fitR * Math.sin(el) * 1.5 / vTan);   // pull back until it fits

    dustMat.uniforms.uPxScale.value = size.y / (2 * vTan);
    dustMat.uniforms.uMinPx.value = Math.max(1.5, 1.25 * dpr);
    dustMat.uniforms.uMaxPx.value = 4 * dpr;
    starMat.uniforms.uDpr.value = Math.max(1, dpr);
    finalMat.uniforms.uAspect.value = aspect;
  }
  function setQuality(level) {
    qualityLevel = clamp(level, 0, Q.ladder.length - 1);
    resize();
  }

  /* --------------------------------------------------------------------------
     Update: everything from T
     -------------------------------------------------------------------------- */
  const sunDir = new THREE.Vector3(), qTmp = new THREE.Quaternion(), qYaw = new THREE.Quaternion(), qPitch = new THREE.Quaternion();
  const X = new THREE.Vector3(1, 0, 0), Y = new THREE.Vector3(0, 1, 0);
  const parallax = { x: 0, y: 0, tx: 0, ty: 0 };
  let pageDark = false, dustSettled = false;

  function update(T, wall) {
    const C = CONFIG.camera, tau = orbitTime(T);
    const exposure = TRACK.exposure(T), flash = TRACK.flash(T), heat = TRACK.heat(T), arms = TRACK.arms(T);
    const ignite = smooth(TM.ignition - 0.3, TM.ignition + 0.5, T);

    // ---- camera: face-on and close, then back and tilted ----
    const dist = mix(C.closeDistance + C.closeDrift * Math.min(T, C.pullBack[0] + 4), finalDistance, smoother(C.pullBack[0], C.pullBack[1], T));
    const el = THREE.MathUtils.degToRad(mix(90, C.tiltDeg, smoother(C.tilt[0], C.tilt[1], T)) + parallax.y * CONFIG.input.parallaxDeg[1]);
    const az = THREE.MathUtils.degToRad(parallax.x * CONFIG.input.parallaxDeg[0]);
    qYaw.setFromAxisAngle(Y, az); qPitch.setFromAxisAngle(X, -el);
    camera.quaternion.copy(qYaw).multiply(qPitch);
    camera.position.set(0, 0, dist).applyQuaternion(camera.quaternion);
    camera.updateMatrixWorld();
    skyGroup.position.copy(camera.position);

    // ---- star ----
    const starI = TRACK.star(T) / exposure;      // authored in display units
    sunMat.uniforms.uI.value = starI; sunMat.uniforms.uIgnite.value = ignite; sunMat.uniforms.uTime.value = tau;
    glowMat.uniforms.uI.value = starI * ST.glowGain * (1 + 1.2 * flash); glowMat.uniforms.uIgnite.value = ignite; glowMat.uniforms.uFlash.value = flash;
    glow.quaternion.copy(camera.quaternion);
    glow.scale.setScalar(ST.glowSize * (1 + 0.5 * flash) * Math.min(1, dist / 14 + 0.25));

    // ---- planets ----
    const light = TRACK.light(T);
    for (let i = 0; i < NP; i++) {
      const p = planets[i], c = p.cfg, th = c.theta0 + c.omega * tau;
      plUniform[i].y = th % TAU;
      gapUniform[i].z = c.gap[1] * smooth(c.born - 0.6, TM.ignition - 0.5, T);
      const grow = Math.pow(smooth(c.born, TM.ignition + 0.8, T), 0.55);
      p.group.visible = grow > 0;
      if (!p.group.visible) continue;
      p.group.position.set(c.a * Math.cos(th), 0, c.a * Math.sin(th));
      p.group.scale.setScalar(c.radius * grow);
      p.group.updateMatrixWorld(true);
      sunDir.copy(p.group.position).normalize().negate();
      p.u.uSunW.value.copy(sunDir);
      p.u.uSunL.value.copy(sunDir).applyQuaternion(qTmp.copy(p.tilt.quaternion).invert());
      p.u.uUpW.value.set(0, 1, 0).applyQuaternion(p.tilt.quaternion);
      const L = p.light * light, lc = ST.lightColor;
      p.u.uLight.value.set(lc[0] * L, lc[1] * L, lc[2] * L);
      p.u.uSpin.value = (c.spin * tau) % TAU;
      // small worlds cool first
      p.u.uMolten.value = 1 - smooth(CONFIG.moltenCool[0] - 1.2 + c.radius * 4, CONFIG.moltenCool[1] - 1.6 + c.radius * 6, T);
      p.u.uVis.value = smooth(TM.ignition + 1, TM.ignition + 5, T);
      p.u.uRingVis.value = smooth(TM.ignition + 1.5, TM.ignition + 6.5, T);
    }

    // ---- gas & dust ----
    const waveR = (T - TM.ignition - TM.waveDelay) * TM.waveSpeed;
    const gasOn = waveR < D.outer + 4.5;
    for (const g of gasLayers) g.visible = gasOn;
    const gu = gasShared;
    gu.uT.value = T; gu.uTau.value = tau; gu.uHeat.value = heat; gu.uArms.value = arms; gu.uWaveR.value = waveR; gu.uFlash.value = flash;
    gu.uGain.value = D.gasGain / D.gasLayers * 3;

    const du = dustMat.uniforms, hi = Math.floor(tau / 512) * 512;
    du.uT.value = T; du.uTauHi.value = hi; du.uTauLo.value = tau - hi; du.uHeat.value = heat; du.uArms.value = arms; du.uFlash.value = flash;
    const frac = Q.ladder[qualityLevel][1];
    du.uGain.value = D.particleGain * (420000 / total);
    const settledNow = T > TM.dustGone;
    if (settledNow) dustGeo.setDrawRange(0, nKeep);
    else dustGeo.setDrawRange(0, nKeep + Math.floor(nDust * frac));
    dustSettled = settledNow;

    // ---- grade ----
    const fu = finalMat.uniforms;
    fu.uExposure.value = exposure; downMat.uniforms.uExposure.value = exposure;
    fu.uTime.value = wall;
    if (REDUCED) {
      // no formation: a gentle fade from white, nothing flickering
      const u = clamp(wall / CONFIG.reducedMotion.fade, 0, 1);
      fu.uVeil.value = 14 * Math.pow(1 - u * u * (3 - 2 * u), 2.2); fu.uShimmer.value = 0; fu.uGrainSeed.value = 0.5;
    } else {
      fu.uVeil.value = TRACK.veil(T);
      fu.uShimmer.value = CONFIG.shimmer * smooth(TM.shimmerStart, TM.shimmerStart + 1.6, T);
      fu.uGrainSeed.value = (wall * 24 % 1000 | 0) / 10;   // film-rate grain
    }
    starMat.uniforms.uTime.value = wall;

    // ---- DOM ----
    const hinting = !REDUCED && T > TM.hint[0] && T < TM.hint[1];
    if (hinting !== hintOn) { hintOn = hinting; ui.showHint(hinting); }
    const settled = REDUCED ? wall > CONFIG.reducedMotion.fade * 0.7 : T > TM.ui;
    if (settled && !textOn) { textOn = true; ui.tone('dark').reveal(); }
    if (!pageDark && (REDUCED ? wall > CONFIG.reducedMotion.fade : T > TM.dustGone)) { pageDark = true; setPageDark(); canvas.style.background = '#030304'; }
  }
  let hintOn = false, textOn = false;

  function render() {
    renderer.setRenderTarget(sceneRT);
    renderer.setClearColor(0x000000, 1);
    renderer.clear();
    renderer.render(scene, camera);

    // bloom: downsample chain, then tent-upsample back up, blending as it goes
    let src = sceneRT;
    for (let i = 0; i < mips.length; i++) {
      downMat.uniforms.tSrc.value = src.texture;
      downMat.uniforms.uTexel.value.set(1 / src.width, 1 / src.height);
      downMat.uniforms.uPrefilter.value = i === 0 ? 1 : 0;
      runPass(downMat, mips[i]);
      src = mips[i];
    }
    for (let i = mips.length - 2; i >= 0; i--) {
      upMat.uniforms.tSrc.value = mips[i + 1].texture;
      upMat.uniforms.uTexel.value.set(1 / mips[i + 1].width, 1 / mips[i + 1].height);
      runPass(upMat, mips[i], false);
    }
    runPass(finalMat, null);
  }

  /* --------------------------------------------------------------------------
     Input: hold to move through time, cursor parallax
     -------------------------------------------------------------------------- */
  let held = false, speed = 1, speedLead = 1;
  const hold = (v) => { held = v; };
  window.addEventListener('keydown', (e) => { if (e.code === 'Space' && !e.target.closest?.('a')) { e.preventDefault(); hold(true); } });
  window.addEventListener('keyup', (e) => { if (e.code === 'Space') hold(false); });
  window.addEventListener('blur', () => hold(false));
  canvas.addEventListener('pointerdown', (e) => { if (e.pointerType !== 'mouse') { hold(true); try { canvas.setPointerCapture(e.pointerId); } catch {} } });
  for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) canvas.addEventListener(ev, (e) => { if (e.pointerType !== 'mouse') hold(false); });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  if (!REDUCED) window.addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'mouse') return;
    parallax.tx = (e.clientX / viewW) * 2 - 1; parallax.ty = (e.clientY / viewH) * 2 - 1;
  });
  ui.hint(MOBILE ? 'press and hold' : 'hold space');

  /* --------------------------------------------------------------------------
     Loop
     -------------------------------------------------------------------------- */
  let T = params.has('t') ? parseFloat(params.get('t')) || 0 : REDUCED ? CONFIG.reducedMotion.startTime : CONFIG.time.startAt;
  const paused = params.has('pause');
  let wall = 0, last = 0, raf = 0, running = false;
  const perf = { frames: 0, since: 0, fps: 60, graceUntil: 0, samples: [] };
  const api = (window.__bornFromWhite = { get time() { return T; }, set time(v) { T = v; }, get fps() { return perf.fps; }, get quality() { return qualityLevel; }, get speed() { return speed; }, samples: perf.samples, config: CONFIG });

  function frame(now) {
    raf = requestAnimationFrame(frame);
    const dt = Math.min((now - last) / 1000, 0.05); last = now;
    if (dt <= 0) return;
    const I = CONFIG.input;
    // two cascaded low-passes: the speed change starts and ends gently
    const tc = (held ? I.easeIn : I.easeOut) * 0.5;
    speedLead += ((held ? I.fastForward : 1) - speedLead) * (1 - Math.exp(-dt / tc));
    speed += (speedLead - speed) * (1 - Math.exp(-dt / tc));
    if (!paused) T += dt * speed;
    wall += dt;
    const k = 1 - Math.exp(-dt / I.parallaxInertia);
    parallax.x += (parallax.tx - parallax.x) * k; parallax.y += (parallax.ty - parallax.y) * k;
    update(T, wall);
    render();

    // adaptive quality: cut render scale and dust count before anything else suffers
    perf.frames++;
    if (now - perf.since >= 1000) {
      perf.fps = (perf.frames * 1000) / (now - perf.since); perf.frames = 0; perf.since = now;
      if (params.has('fps')) perf.samples.push(+perf.fps.toFixed(1));
      if (now > perf.graceUntil && perf.fps < Q.minFps && qualityLevel < Q.ladder.length - 1) { setQuality(qualityLevel + 1); perf.graceUntil = now + 2000; }
    }
  }
  function play() { if (running) return; running = true; last = performance.now(); perf.since = last; perf.frames = 0; perf.graceUntil = last + 2500; raf = requestAnimationFrame(frame); }
  function stop() { running = false; cancelAnimationFrame(raf); }

  // Pause when hidden; never let a long absence turn into a time jump.
  document.addEventListener('visibilitychange', () => (document.hidden ? stop() : play()));
  window.addEventListener('resize', () => { resize(); if (!running) { update(T, wall); render(); } });
  canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); stop(); fallback(); });

  // First frame: compile everything, draw T = 0 (pure white), and only then start the clock.
  resize();
  update(T, 0);
  renderer.compile(scene, camera);
  render();
  if (!document.hidden) play();
}

/* ---- small utilities ---- */
function mulberry32(a) {
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function gauss(rng) { return Math.sqrt(-2 * Math.log(1 - rng())) * Math.cos(TAU * rng()); }

/* ---- go ---- */
try {
  if (params.has('nowebgl')) throw new Error('WebGL disabled by flag');
  start();
} catch (err) {
  console.warn('[born from white] falling back:', err);
  fallback();
}
