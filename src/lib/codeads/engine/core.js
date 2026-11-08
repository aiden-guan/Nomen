// EDStudio core: renderer + post-processing, deterministic timeline helpers, and the text overlay.
// Everything here is generic — no video-specific content. Videos import what they need.
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

export const W = 1080, H = 1920;

// ---------------------------------------------------------------- math + easing
export const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
export const lerp = (a, b, t) => a + (b - a) * t;
export const smooth = (t) => { t = clamp(t); return t * t * (3 - 2 * t); };
export const easeIO = (t) => { t = clamp(t); return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; };
export const easeOut = (t) => { t = clamp(t); return 1 - Math.pow(1 - t, 3); };
export const between = (t, a, b) => t >= a && t < b;
export const win = (t, a, b, fade = 0.25) => smooth((t - a) / fade) * (1 - smooth((t - (b - fade)) / fade));

/** Keyframe track: K(t, [[t0, v0], [t1, v1], ...]) — eased between keys, held outside. */
export function K(t, keys, fn = easeIO) {
  if (t <= keys[0][0]) return keys[0][1];
  for (let i = 0; i < keys.length - 1; i++) {
    const [t0, v0] = keys[i], [t1, v1] = keys[i + 1];
    if (t <= t1) return lerp(v0, v1, fn(t1 === t0 ? 1 : (t - t0) / (t1 - t0)));
  }
  return keys[keys.length - 1][1];
}
/** Vector keyframe track: KV(t, [[t0, [x,y,z]], ...]). */
export function KV(t, keys, fn = easeIO) {
  return keys[0][1].map((_, i) => K(t, keys.map((k) => [k[0], k[1][i]]), fn));
}
export function lerpAngle(a, b, t) {
  const d = ((((b - a + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) - Math.PI;
  return a + d * t;
}
/** Seeded PRNG (mulberry32) — never use Math.random in a video (renders must be deterministic). */
export function rng(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------- walking along paths
const WA = 0.18; // fraction of a walk spent accelerating / decelerating
const wEase = (u) => (u <= 0 ? 0 : u >= 1 ? 1 : u < WA ? (0.5 * u * u) / WA / (1 - WA) : u < 1 - WA ? (u - WA / 2) / (1 - WA) : 1 - (0.5 * (1 - u) * (1 - u)) / WA / (1 - WA));
const wEaseD = (u) => (u <= 0 || u >= 1 ? 0 : u < WA ? u / WA / (1 - WA) : u < 1 - WA ? 1 / (1 - WA) : (1 - u) / WA / (1 - WA));
function polyLen(p) { let L = 0; for (let i = 0; i < p.length - 1; i++) L += Math.hypot(p[i + 1][0] - p[i][0], p[i + 1][1] - p[i][1]); return L; }
function polyAt(p, d) {
  for (let i = 0; i < p.length - 1; i++) {
    const dx = p[i + 1][0] - p[i][0], dz = p[i + 1][1] - p[i][1], l = Math.hypot(dx, dz);
    if (d <= l || i === p.length - 2) { const f = l ? clamp(d / l) : 0; return [p[i][0] + dx * f, p[i][1] + dz * f]; }
    d -= l;
  }
  return p[p.length - 1].slice();
}
/**
 * Walk a character along floor paths (x,z). legs = [{t0, t1, pts: [[x,z], ...]}, ...]; each leg starts where the last ended.
 * Returns {x, z, head (facing angle for rotation.y, model faces +z), dist (for the gait cycle), speed}.
 */
export function walkLegs(t, start, legs) {
  let pos = start.slice(), dist = 0, head = null, speed = 0;
  for (const g of legs) {
    if (t <= g.t0) break;
    const pts = [pos.slice(), ...g.pts], L = polyLen(pts);
    const u = clamp((t - g.t0) / (g.t1 - g.t0)), d = wEase(u) * L;
    pos = polyAt(pts, d); dist += d;
    const a = polyAt(pts, Math.max(0, d - 0.15)), b = polyAt(pts, Math.min(L, d + 0.15));
    if (Math.hypot(b[0] - a[0], b[1] - a[1]) > 1e-4) head = Math.atan2(b[0] - a[0], b[1] - a[1]);
    speed = u > 0 && u < 1 ? (L / (g.t1 - g.t0)) * wEaseD(u) : 0;
    if (t < g.t1) break;
  }
  return { x: pos[0], z: pos[1], dist, head, speed };
}
/** Facing angle (rotation.y) for a model facing +z to look from (x,z) toward (tx,tz). */
export const faceToward = (x, z, tx, tz) => Math.atan2(tx - x, tz - z);

// ---------------------------------------------------------------- materials + textures
export function mat(color, roughness = 0.85, extra = {}) {
  return new THREE.MeshStandardMaterial({ color, roughness, metalness: 0, ...extra });
}
export function canvasTex(w, h, draw, repeat) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
  if (repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(repeat[0], repeat[1]); }
  return t;
}
/** Add a mesh with shadows on. */
export function mk(geo, material, parent, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(geo, material);
  m.position.set(x, y, z); m.castShadow = true; m.receiveShadow = true;
  parent.add(m); return m;
}

// ---------------------------------------------------------------- renderer + post
const GradeShader = {
  uniforms: { tDiffuse: { value: null }, uTime: { value: 0 }, uVig: { value: 0.42 }, uGrain: { value: 0.035 }, uLift: { value: 0.018 }, uWarm: { value: 1.0 }, uSat: { value: 1.0 } },
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: `
    uniform sampler2D tDiffuse; uniform float uTime, uVig, uGrain, uLift, uWarm, uSat; varying vec2 vUv;
    float hash(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
    void main(){
      vec4 c = texture2D(tDiffuse, vUv);
      vec2 q = vUv - 0.5;
      float v = smoothstep(0.78, 0.22, length(q * vec2(1.0, 0.92)));
      c.rgb *= mix(1.0 - uVig, 1.0, v);
      c.rgb = uLift + c.rgb * (1.0 - uLift);                     // filmic black lift
      c.rgb *= mix(vec3(1.0), vec3(1.02, 1.0, 0.97), uWarm);      // gentle warm grade (look.warm 0 = neutral)
      c.rgb = mix(vec3(dot(c.rgb, vec3(0.2126, 0.7152, 0.0722))), c.rgb, uSat);   // look.saturation
      float n = hash(vUv * vec2(1080.0, 1920.0) + fract(uTime * 7.31) * 113.0) - 0.5;
      c.rgb += n * uGrain;
      gl_FragColor = vec4(clamp(c.rgb, 0.0, 1.0), 1.0);
    }`,
};

/** One studio per video: renderer, scene, camera, composer. look = story.look overrides. */
export function createStudio(canvas, look = {}) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, preserveDrawingBuffer: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(1); renderer.setSize(W, H, false);
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  // look.toneMapping 'agx' | 'neutral' (build genre: brighter, cleaner yellows than ACES); default ACES
  renderer.toneMapping = { agx: THREE.AgXToneMapping, neutral: THREE.NeutralToneMapping }[look.toneMapping] ?? THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = look.exposure ?? 1.0;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene(); scene.background = new THREE.Color(0x000000);
  const camera = new THREE.PerspectiveCamera(60, W / H, 0.03, 80);
  // soft fill that rides with the camera: lifts faces in close-ups, barely touches wide shots (inverse-square)
  const fill = new THREE.PointLight(look.fillColor ?? 0xffe2c4, look.fill ?? 0.5, 7, 2);
  fill.position.set(0.25, 0.15, 0); camera.add(fill); scene.add(camera);

  const rt = new THREE.WebGLRenderTarget(W, H, { type: THREE.HalfFloatType, samples: 4 });
  const composer = new EffectComposer(renderer, rt);
  composer.setPixelRatio(1); composer.setSize(W, H);
  composer.addPass(new RenderPass(scene, camera));
  // look.ao = { radius, intensity, thickness } (opt-in): ground-truth ambient occlusion — contact darkening in corners/under feet,
  // the soft "Blender" depth the build-genre look reviews kept asking for. Costs ~one extra scene pass per frame.
  if (look.ao) { const ao = new GTAOPass(scene, camera, W, H); ao.updateGtaoMaterial({ radius: look.ao.radius ?? 0.6, distanceExponent: 1, thickness: look.ao.thickness ?? 1, scale: 1, samples: 16 }); ao.updatePdMaterial({ radius: 6, samples: 16 }); ao.blendIntensity = look.ao.intensity ?? 1; composer.addPass(ao); }
  // Guard: a single NaN/Inf pixel (degenerate normal, extreme highlight) gets smeared by bloom into big black
  // rectangles. Scrub non-finite values and clamp hot pixels before bloom.
  composer.addPass(new ShaderPass({
    uniforms: { tDiffuse: { value: null } },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: 'uniform sampler2D tDiffuse; varying vec2 vUv; void main(){ vec4 c = texture2D(tDiffuse, vUv); if (any(isnan(c)) || any(isinf(c))) c = vec4(0.0, 0.0, 0.0, 1.0); gl_FragColor = min(c, vec4(48.0)); }',
  }));
  const bloom = new UnrealBloomPass(new THREE.Vector2(W, H), look.bloom ?? 0.3, 0.5, look.bloomThreshold ?? 0.92);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());
  const grade = new ShaderPass(GradeShader);
  if (look.vignette !== undefined) grade.uniforms.uVig.value = look.vignette;
  if (look.grain !== undefined) grade.uniforms.uGrain.value = look.grain;
  if (look.warm !== undefined) grade.uniforms.uWarm.value = look.warm;
  if (look.saturation !== undefined) grade.uniforms.uSat.value = look.saturation;
  if (look.lift !== undefined) grade.uniforms.uLift.value = look.lift;
  composer.addPass(grade);

  const _t = new THREE.Vector3();
  /** Camera with subtle handheld drift (amp in meters; 0 = locked off). */
  function setCamera(pos, target, fov, t = 0, amp = 0.005) {
    const n1 = Math.sin(t * 1.13) + 0.6 * Math.sin(t * 2.71 + 1.3), n2 = Math.sin(t * 0.87 + 2.1) + 0.5 * Math.sin(t * 2.23 + 0.4);
    camera.position.set(pos[0] + n1 * amp, pos[1] + n2 * amp, pos[2]);
    camera.fov = fov; camera.updateProjectionMatrix();
    camera.lookAt(_t.set(target[0] + n2 * amp * 0.5, target[1] + n1 * amp * 0.5, target[2]));
  }
  function render(t) { grade.uniforms.uTime.value = t; composer.render(); }
  return { THREE, renderer, scene, camera, fill, composer, bloom, grade, setCamera, render };
}

// ---------------------------------------------------------------- text overlay (driven by story.json)
const $ = (id) => document.getElementById(id);
const fmt = (n) => Math.round(n).toLocaleString('en-US');
/** 020: a length given in cm, printed with its unit at ~3 significant figures (36 cm, 1.44 m, 23.0 m, 11.8 km, 6,040 km). */
const fmtLen = (cm) => {
  const m = cm / 100, km = m / 1000;
  if (m < 1) return `${Math.round(cm)} cm`;
  if (m < 10) return `${m.toFixed(2)} m`;
  if (m < 100) return `${m.toFixed(1)} m`;
  if (km < 1) return `${Math.round(m)} m`;
  if (km < 10) return `${km.toFixed(2)} km`;
  if (km < 100) return `${km.toFixed(1)} km`;
  return `${Math.round(km).toLocaleString('en-US')} km`;
};
/** seconds → "320 femtoseconds" / "1.0 nanoseconds" / "8 min 17 s" (3 significant digits; 027). */
export function fmtTime(v) {
  if (!(v > 0)) return '0 seconds';
  if (v >= 60) { const m = Math.floor(v / 60), s = Math.floor(v - m * 60); return `${m} min ${s} s`; }
  const U = [[1e-18, 'attosecond'], [1e-15, 'femtosecond'], [1e-12, 'picosecond'], [1e-9, 'nanosecond'], [1e-6, 'microsecond'], [1e-3, 'millisecond'], [1, 'second']];
  let k = 0; while (k < U.length - 1 && v >= U[k + 1][0] * 0.9995) k++;
  const x = v / U[k][0], str = x < 9.95 ? x.toFixed(1) : x < 99.5 ? x.toFixed(0) : x.toFixed(0);
  return `${str} ${U[k][1]}s`;
}

/** 036: seconds → a countdown "8:19" (rounded up, so it reads 0:00 only when it has run out). */
const fmtClock = (v) => { const s = Math.max(0, Math.ceil(v - 1e-6)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
/** 036: seconds → elapsed "+1.3 s" / "+8 min 19 s" / "+1 h 10 min". */
const fmtDur = (v) => { if (v < 60) return `+${v.toFixed(1)} s`; if (v < 3600) { const m = Math.floor(v / 60); return `+${m} min ${Math.floor(v - m * 60)} s`; } const h = Math.floor(v / 3600); return `+${h} h ${Math.floor((v - h * 3600) / 60)} min`; };
/** 036: a temperature with a real minus sign ("−18 °C"). */
const fmtTemp = (v) => { const r = Math.round(v); return `${r < 0 ? '−' : ''}${Math.abs(r)} °C`; };

export function createOverlay(story) {
  const title = $('title'), hud = $('hud'), num = $('hudNum'), time = $('hudTime'), age = $('hudAge');
  const sub = $('sub'), fade = $('fade'), end = $('end');
  if (story.title) title.innerHTML = story.title.html;
  $('hudLabel').textContent = story.hudLabel || '';
  if (story.end) end.innerHTML = story.end.html + (story.end.small ? `<span class="small">${story.end.small}</span>` : '');
  let lastSub = null;

  const inOut = (t, a, b, f = 0.35) => smooth((t - a) / f) * (1 - smooth((t - (b - f)) / f));

  function update(t) {
    // opening: the title alone, centered. HUD + subtitles only appear after it has faded out.
    if (story.title) title.style.opacity = inOut(t, story.title.in, story.title.out);
    const afterTitle = story.title ? smooth((t - story.title.out) / 0.35) : 1;

    // HUD: segments of {t0,t1,from,to,r0,r1,time,age,ageFrom,ageGoldAt}
    //      + (020) fmt: 'len' = the value is a length in cm, printed with its unit; geo: true = roll geometrically (a doubling)
    const segs = story.hud || [];
    const seg = segs.find((s) => t >= s.t0 && t < s.t1) || segs[segs.length - 1];
    if (seg) {
      const endT = story.finalFade ? story.finalFade[0] : 1e9;
      // Steady: fades in once after the opening title, stays at full opacity, fades out once at the end. Never pulses/dims.
      hud.style.opacity = afterTitle * (1 - smooth((t - endT) / 0.3));
      let n = seg.from, u = 1;
      // seg.ease 'linear' = a steady clock across segments (017); seg.dec decimals + seg.unit suffix ("2.5 s") (017)
      // seg.geo = geometric roll for doublings, seg.fmt 'len' = cm / m / km (020, 022)
      // 027: seg.ease 'log' = from·(to/from)^u (a clock that sweeps decades); seg.text = a literal string instead of the number;
      // seg.timefmt = n is seconds, shown with the right SI word ("320 femtoseconds", "8 min 17 s"); seg.label overrides hudLabel
      if (seg.r0 !== undefined) {
        u = clamp((t - seg.r0) / (seg.r1 - seg.r0));
        if (seg.ease === 'log') n = seg.from * Math.pow(seg.to / seg.from, u);
        else {
          const k = seg.ease === 'linear' ? u : easeIO(u);
          n = seg.geo && seg.from > 0 && seg.to > 0 ? seg.from * Math.pow(seg.to / seg.from, k) : lerp(seg.from, seg.to, k);
        }
      }
      num.textContent = seg.text !== undefined ? seg.text : seg.timefmt ? fmtTime(n)
        : seg.fmt === 'len' ? fmtLen(n) : seg.fmt === 'clock' ? fmtClock(n) : seg.fmt === 'dur' ? fmtDur(n) : seg.fmt === 'temp' ? fmtTemp(n)
        : (seg.dec ? n.toFixed(seg.dec) : fmt(n)) + (seg.unit || '');
      if (seg.label !== undefined || story.hudLabel) $('hudLabel').textContent = seg.label ?? story.hudLabel ?? '';
      time.textContent = seg.time || '';
      age.textContent = seg.ageFrom && u < 0.5 ? seg.ageFrom : seg.age || '';
      const g = seg.ageGoldAt !== undefined ? clamp(1 - (t - seg.ageGoldAt) / 1.6) * (t >= seg.ageGoldAt ? 1 : 0) : 0;
      num.style.color = g > 0 ? `rgb(${lerp(255, 243, g)},${lerp(255, 196, g)},${lerp(255, 107, g)})` : '#fff';
      age.classList.toggle('gold', t >= (seg.ageGoldAt ?? 1e9));
    }

    // subtitles
    const s = (story.subs || []).find(([a, b]) => t >= a && t < b);
    if (s) {
      if (lastSub !== s[2]) { sub.textContent = s[2]; lastSub = s[2]; }
      const a = smooth((t - s[0]) / 0.22) * (1 - smooth((t - (s[1] - 0.22)) / 0.22));
      sub.style.opacity = a * afterTitle; sub.style.transform = `translateY(${(1 - smooth((t - s[0]) / 0.3)) * 10}px)`;
    } else { sub.style.opacity = 0; }

    // dips to black [start, peak, end] + final fade + end card
    let f = 0;
    for (const [a, m, b] of story.dips || []) {
      if (t >= a && t <= b) f = Math.max(f, t < m ? (m === a ? 1 : smooth((t - a) / (m - a))) : (b === m ? 1 : 1 - smooth((t - m) / (b - m))));
    }
    // finalFade [start, end, depth?]: depth (036, default 1) < 1 only dims the frame, so the end card can sit over a live scene
    if (story.finalFade) f = Math.max(f, (story.finalFade[2] ?? 1) * smooth((t - story.finalFade[0]) / (story.finalFade[1] - story.finalFade[0])));
    fade.style.opacity = f;
    if (story.end) end.style.opacity = smooth((t - story.end.in) / 0.5);
  }
  return { update };
}
