// Nomen's code-ad scene: ED Studio's build genre (docs/BUILD.md in ED Studio: one gliding camera take,
// hard impact kicks, analytic FX, one word of narration at a time + callouts), compiled from a list of beats instead of a
// hand-written shots.js. story.codead (src/lib/codeads/layout.ts) carries, per beat: its gag, who plays it, its absolute
// times (t0..t1, speech s0..s1, the hit word's time) and what the big screen shows. Every frame is a pure function of t
// (deterministic: no Math.random, no Date), so a still at 12.0 s is exactly frame 720 of the 60 fps render.
//
// The set (story.codead.scene, engine/sets/) gives each character a station: where they stand, a work surface with a
// laptop, a big screen. The cast (engine/cast.js): the lead (Chad, the product) and, in a versus ad, the rival (the old
// way) on his own floor.
//
// Gags (what happens on the beat; `hit` is the word it lands on):
//   hack       the character types furiously; their screen types the beat's terminal or chat
//   explode    the laptop blows up on the hit: smoke, sparks, debris; the character charred, X eyes
//   bury       an avalanche of labelled boxes (labels) buries the character to the nose; spiral eyes, dizzy stars
//   zap        the character touches the power strip: two x-ray pulses, sparks, hair up
//   money      banknotes pour out of the screen; what it bought lands in boxes (labels)
//   deliver    the brand's crate drops in front of the desk, bursts open, the brand's agent robot hops out
//   team       more agent robots pop in, one per label, and get to work around the station
//   approve    a big button pops up on the desk; slammed on the hit (the stamp callout says what it did)
//   show       the camera pushes in on the screen (a real screenshot or the logo); the character presents it
//   celebrate  confetti, the character jumps with arms up, the robots spin
//   idle       the character just reacts
import * as THREE from 'three';
import { clamp, lerp, easeIO, easeOut } from './core.js';
import { makeFX, makeDizzy } from './build/fx.js';
import { pop, drop, squash, wobble, easeOutBack } from './build/anim.js';
import { planRail, makeRail } from './build/rail.js';
import { makeKick } from './build/cuts.js';
import { makeCast, headHeight } from './cast.js';
import { SETS } from './sets/index.js';
import { makeAgent, makeCrate, makeBox, makeBigButton } from './props.js';
import { drawScreen } from './screen.js';

const PI = Math.PI;
const u01 = (t, a, b) => clamp((t - a) / Math.max(1e-6, b - a));
const loadImage = (src) => new Promise((res) => { if (!src) return res(null); const im = new Image(); im.onload = () => res(im); im.onerror = () => res(null); im.src = src; });
// a leading man keeps his cool: no screams, no goofy grins
const STOIC_MOUTH = { scream: 'o', teeth: 'line', wavy: 'flat', grin: 'smirk', smile: 'line' };

/** Where the camera stands to put `at` at `frac` of the frame height (0 = top), d metres away, yaw/pitch in radians. */
function aim(at, { frac = 0.4, d = 3.2, fov = 40, yaw = 0, pitch = 0.1, dx = 0 } = {}) {
  const H = 2 * d * Math.tan((fov * PI) / 360), off = (0.5 - frac) * H;
  return { pos: [at[0] + Math.sin(yaw) * Math.cos(pitch) * d + dx, at[1] + Math.sin(pitch) * d, at[2] + Math.cos(yaw) * Math.cos(pitch) * d], look: [at[0] + dx * 0.4, at[1] - off, at[2]], fov };
}

export async function build(studio, story) {
  const { scene, camera } = studio;
  const A = story.codead, brand = A.brand, colors = brand.colors;
  await document.fonts.load('400 60px "Luckiest Guy"');
  if (brand.font && brand.fontFamily) { try { const f = new FontFace(brand.fontFamily, `url(${brand.font})`); await f.load(); document.fonts.add(f); } catch (e) { console.warn('brand font: ' + e); } }
  const logo = await loadImage(brand.logo), logoOnLight = (await loadImage(brand.logoOnLight)) || logo;
  const images = new Map(await Promise.all([...new Set(A.beats.map((b) => b.screen && b.screen.image).filter(Boolean))].map(async (src) => [src, await loadImage(src)])));
  scene.background = new THREE.Color(0x2a303b);
  camera.far = 90; camera.near = 0.05;

  // ---------------------------------------------------------------- the set and the cast
  const versus = !!(A.rival && A.rival.name);
  const sceneName = versus ? 'versus' : SETS[A.scene] ? A.scene : 'office';
  const E = await SETS[sceneName](studio, { brand, logo, logoOnLight, nameplate: A.nameplate, poster: A.poster, rival: A.rival });
  const lead = makeCast(A.hero || 'chad', { logo, logoOnLight, brandName: brand.name, font: brand.fontFamily, accent: colors.accent });
  const members = [{ key: 'hero', C: lead, S: E.stations.hero }];
  if (versus && E.stations.rival) members.push({ key: 'rival', C: makeCast('chud', { rivalName: A.rival.name, accent: colors.accent }), S: E.stations.rival });
  for (const m of members) { scene.add(m.C.toon.root); m.headY = headHeight(m.C.toon); m.S.attach?.(m.C.toon, { brand, logo }); m.dizzy = makeDizzy(scene); }
  const member = (who) => members.find((m) => m.key === who) || members[0];
  const fx = makeFX(scene);
  const beats = A.beats.map((b, i) => { const m = member(b.who === 'rival' ? 'rival' : 'hero'); return { ...b, i, who: m.key, M: m, S: m.S, labels: (b.labels || []).filter(Boolean) }; });
  for (const m of members) m.beats = beats.filter((b) => b.who === m.key);
  const END = story.duration;
  const beatAt = (t) => { let cur = beats[0]; for (const b of beats) if (t >= b.t0) cur = b; return cur; };
  const kicks = [], frames = [];
  const last = beats[beats.length - 1];

  // ---------------------------------------------------------------- props, one set per gag that needs them
  // agents: the brand's robots (deliver brings the first one, team adds one per label). Each roams its station's orbit.
  const agents = [];
  const orbitAt = (S, k, t) => { const O = S.orbit, a = O.w * t + k * 1.9 + 0.4; return { x: O.cx + O.rx * Math.cos(a), z: O.cz + O.rz * Math.sin(a), rotY: Math.atan2(-O.rz * Math.cos(a), -O.rx * Math.sin(a)) }; };
  const addAgent = (S, label, tIn, opts = {}) => {
    if (agents.length >= 6) return null;
    const ag = makeAgent({ body: colors.robot, eye: colors.eye, label, sign: colors.sign });
    scene.add(ag.g);
    const rec = { ag, S, k: agents.length, tIn, ...opts };
    agents.push(rec); return rec;
  };
  let crate = null, crateBeat = null;
  const piles = [], buttons = [], strips = new Map();
  function logoOnCrate() { const c = new THREE.Color(colors.crate); return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b > 0.55 ? logoOnLight : logo; }
  for (const b of beats) {
    const S = b.S, G = { x: S.x, y: S.y, z: S.z };
    if (b.gag === 'deliver' && !crate) {
      crateBeat = b;
      crate = makeCrate({ color: colors.crate, logo: logoOnCrate(), name: brand.name });
      crate.g.position.set(S.crate[0], S.y, S.crate[1]); crate.g.rotation.y = -0.35; scene.add(crate.g);
      addAgent(S, b.labels[0] || 'AGENT', b.hit + 0.55, { fromCrate: true, hat: 1 });
    }
    if (b.gag === 'team') b.labels.slice(0, 5).forEach((label, j) => addAgent(S, label, b.hit - 0.25 + j * 0.32));
    if (b.gag === 'bury') {
      const label = (b.labels[0] || b.label || 'TODO').slice(0, 14), boxes = [], wide = b.M.C.name === 'chud' ? 1.3 : 1;
      for (let k = 0; k < 16; k++) {
        const bx = makeBox(b.labels[k % Math.max(1, b.labels.length)] || label, k); scene.add(bx.g);
        // the pile: around and over the character and the laptop, highest at the chest; then (next beat) knocked off to the floor
        const ring = k < 6 ? 0 : k < 12 ? 1 : 2, a = (k % 6) / 6 * PI * 2 + ring;
        const px = G.x + Math.cos(a) * (0.26 + ring * 0.12) * (ring === 2 ? 1.6 : 1) * wide, pz = G.z + 0.22 + Math.sin(a) * 0.2 * wide;
        const py = G.y + (ring === 0 ? 0.62 : ring === 1 ? 0.38 : 0.66);
        const side = k % 2 ? 1 : -1, fx2 = G.x + side * (1.05 + (k % 4) * 0.22), fz = G.z + 0.66 + ((k * 7) % 5) * 0.32;
        boxes.push({ bx, t0: b.hit - 0.42 + k * 0.035, p1: [px, py, pz], r1: [(k * 0.7) % 0.5 - 0.25, (k * 1.3) % PI, (k * 0.9) % 0.5 - 0.25], p2: [fx2, G.y, fz], r2: [0, (k * 2.1) % PI, 0] });
      }
      piles.push({ b, M: b.M, boxes, clear: (beats[b.i + 1] || { t0: END }).t0 + 0.05 });
    }
    if (b.gag === 'money' && b.labels.length) {
      // what the money bought arrives in boxes printed with it ("YACHT"), dropped beside the character, and stays
      piles.push({ b, M: b.M, boxes: b.labels.slice(0, 3).map((label, k) => { const bx = makeBox(label, k + 3); bx.g.scale.setScalar(1.35); scene.add(bx.g); const sp = S.money[k]; const p1 = [sp[0], S.y + sp[1], sp[2]]; return { bx, t0: b.hit - 0.35 + k * 0.28, p1, r1: [0, (k - 1) * 0.4, 0], p2: p1, r2: [0, (k - 1) * 0.4, 0] }; }), clear: END + 9, purchases: true });
    }
    if (b.gag === 'approve') {
      const deny = /\b(deny|denied|no|reject|stop|block)/i.test(b.label || '');
      const bt = makeBigButton({ color: deny ? 0xe53935 : 0x2fbf5a, label: (b.label || (deny ? 'DENY' : 'APPROVE')).toUpperCase().slice(0, 12) });
      scene.add(bt.g); buttons.push({ bt, b, out: (beats[b.i + 1] || { t0: END + 9 }).t0 + 0.6 });
    }
    if (b.gag === 'zap' && !strips.has(S)) strips.set(S, powerStrip(S));
  }
  function powerStrip(S) {
    const strip = new THREE.Group(); strip.position.set(S.strip[0], S.y + S.top, S.strip[1]); scene.add(strip);
    const m = new THREE.MeshStandardMaterial({ color: 0xf2f2f2, roughness: 0.4 }); const s = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.04, 0.07), m); s.position.y = 0.02; s.castShadow = true; strip.add(s);
    for (let k = 0; k < 3; k++) { const o = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.012, 0.03), new THREE.MeshStandardMaterial({ color: 0x333333 })); o.position.set(-0.08 + k * 0.08, 0.045, 0); strip.add(o); }
    const led = new THREE.Mesh(new THREE.SphereGeometry(0.01, 6, 4), new THREE.MeshBasicMaterial({ color: 0xff3b30, toneMapped: false })); led.position.set(0.115, 0.045, 0.02); strip.add(led);
    return strip;
  }

  // ---------------------------------------------------------------- the camera: one gliding take, a framing per beat
  const framesFor = (m) => {
    const S = m.S, HEAD = [S.x, S.y + m.headY, S.z], SCR = [S.screen.x, S.screen.y, S.screen.z], fit = Math.max(5.2, S.screen.w * 2.85);
    const base = {
      face: (yaw = 0.12) => aim(HEAD, { frac: 0.38, d: 2.3, fov: 34, yaw, pitch: 0.05 }),
      gary: (yaw = 0) => aim(HEAD, { frac: 0.39, d: 3.9, fov: 40, yaw, pitch: 0.1 }),
      home: (yaw = 0) => aim(HEAD, { frac: 0.42, d: 5.3, fov: 40, yaw, pitch: 0.1 }),
      screen: (yaw = 0) => aim(SCR, { frac: 0.27, d: fit, fov: 40, yaw, pitch: 0.03 }),
      wide: (yaw = 0) => aim([S.x + 0.1, S.y + 1.0, S.z + 0.36], { frac: 0.42, d: 6.4, fov: 42, yaw, pitch: 0.16 }),
      floor: (yaw = 0) => aim([S.x + 0.4, S.y + 1.05, S.z + 0.36], { frac: 0.4, d: 5.6, fov: 42, yaw, pitch: 0.14 }),
    };
    return { ...base, ...(S.frames ? S.frames(base, HEAD, SCR) : {}) };
  };
  for (const m of members) m.F = framesFor(m);
  let flip = 1;
  for (const b of beats) {
    flip = -flip;
    const F = b.M.F, y = 0.12 * flip;
    let at = b.i === 0 ? 0 : b.t0;
    // every framing holds until its gag has landed (ED Studio's `until`: a gag must finish in frame)
    const add = (t, f, extra = {}) => frames.push({ t: Math.max(0, t), until: Math.min(b.t1, b.hit + 0.75), ...f, ...extra });
    // a versus ad opens on the whole house, then glides to the first floor that plays
    if (b.i === 0 && versus && E.wide && b.hit > 2.6) { frames.push({ t: 0, until: Math.min(b.t1, 1.0), ...E.wide(0) }); at = Math.min(1.2, Math.max(0.3, b.hit - 1.0)); }
    switch (b.gag) {
      // a beat whose screen carries the point shows the whole screen above the character (the callouts sit in the lower third)
      case 'hack': add(at, b.i === 0 ? F.home(0) : F.home(y)); break;
      case 'explode': add(at, F.home(y)); kicks.push([b.hit, 1.1, 0.55]); break;
      case 'bury': add(at, F.home(y)); kicks.push([b.hit + 0.08, 0.85, 0.5]); break;
      case 'zap': add(at, F.gary(0.16 * flip)); kicks.push([b.hit, 0.6, 0.4]); break;
      case 'money': add(at, F.home(y)); kicks.push([b.hit, 0.4, 0.35]); break;
      case 'deliver': add(at, F.floor(0.1)); kicks.push([b.hit, 0.95, 0.5]); break;
      case 'team': add(at, F.home(y)); break;
      case 'approve': add(at, F.home(-0.12)); kicks.push([b.hit, 0.6, 0.35]); break;
      case 'show': add(at, F.screen(y * 0.4), { keep: true }); break;
      case 'celebrate': add(at, F.wide(y)); kicks.push([b.hit, 0.35, 0.4]); break;
      default: add(at, b.screen && ['terminal', 'chat', 'dashboard', 'image'].includes(b.screen.kind) ? F.home(y) : F.gary(y));
    }
  }
  // the ending holds on the lead's station: the screen (logo + url), the lead, the robots
  const endT = Math.max(last.s1 + 0.2, END - 1.6);
  const endFrame = E.end ? E.end(0) : members[0].F.home(0);
  if (endT - (frames.length ? frames[frames.length - 1].t : 0) >= 1.6) frames.push({ t: endT, ...endFrame, stop: true });
  else if (frames.length) frames[frames.length - 1].stop = true;
  // drop framings closer than ~1.2 s to the next one (the rail would only whip between them)
  frames.sort((a, b) => a.t - b.t);
  const Fr = frames.filter((f, i) => i === frames.length - 1 || f.stop || frames[i + 1].t - f.t >= 1.15 || f.keep);
  const rail = makeRail(planRail(Fr));
  const kick = makeKick(kicks);

  // ---------------------------------------------------------------- FX, scheduled once (analytic particles)
  for (const b of beats) {
    const h = b.hit, S = b.S, LAP = [S.laptopAt[0], S.y + S.top + 0.15, S.laptopAt[1]], HY = S.y + b.M.headY;
    if (b.gag === 'explode') {
      fx.burst('glow', h, { pos: LAP, n: 2, speed: [0, 0.1], size: [0.45, 0.7] });
      fx.burst('spark', h, { pos: LAP, n: 50, dir: [0, 1, 0.3], spread: 1.3, speed: [2.0, 4.5] });
      fx.burst('rock', h, { pos: LAP, n: 16, dir: [0, 1, 0.1], spread: 1.1, speed: [1.6, 3.2], floor: S.y + S.top, size: [0.025, 0.06], color: 0x2e2e2e });
      // smoke rises behind the laptop, off to the side of the face
      fx.stream('smoke', h + 0.05, h + 1.5, { pos: [LAP[0] + 0.25, LAP[1] + 0.05, LAP[2] + 0.1], rate: 7, dir: [0.35, 1, 0.1], spread: 0.3, speed: [0.5, 1.0], box: [0.15, 0.05, 0.1], size: [0.18, 0.32] });
    }
    if (b.gag === 'bury') fx.burst('dust', h + 0.1, { pos: [S.x, S.y + 0.75, S.z], n: 12, dir: [0, 1, 0], spread: 1.4, speed: [0.5, 1.2], box: [1.0, 0.2, 0.3], size: [0.2, 0.42] });
    if (b.gag === 'zap') {
      const st = strips.get(S).position;
      fx.burst('spark', h, { pos: [st.x - 0.05, st.y + 0.08, st.z], n: 40, dir: [0, 1, 0.2], spread: 1.2, speed: [1.5, 4] });
      fx.burst('glow', h, { pos: [st.x - 0.05, st.y + 0.1, st.z], n: 2, speed: [0, 0.1], size: [0.7, 0.9] });
      fx.stream('smoke', h + 0.2, h + 0.9, { pos: [S.x, HY + 0.3, S.z], rate: 5, dir: [0, 1, 0], spread: 0.3, speed: [0.25, 0.5], size: [0.08, 0.16], life: [0.6, 0.9] });
    }
    // the money pours for the whole line, from just after its first word to a beat past the hit
    if (b.gag === 'money') fx.stream('bill', Math.min(h, b.s0 + 0.3), Math.max(h + 0.6, Math.min(h + 0.9, b.t1 - 1.2)), { pos: [S.screen.x, S.screen.y - 0.1, S.screen.z + 0.25], rate: 24, dir: [0, 0.7, 0.7], spread: 1.0, speed: [2.2, 4.0], box: [Math.min(1.5, S.screen.w * 0.8), 0.6, 0.05], life: [1.4, 2.0] });
    if (b.gag === 'deliver') { fx.burst('dust', h, { pos: [S.crate[0], S.y + 0.05, S.crate[1]], n: 12, dir: [0, 1, 0], spread: 1.45, speed: [0.8, 1.8], box: [0.9, 0.05, 0.9], size: [0.22, 0.45] }); fx.burst('confetti', h + 0.55, { pos: [S.crate[0], S.y + 0.9, S.crate[1]], n: 70, dir: [0, 1, 0.2], spread: 0.6, speed: [2.5, 4.5] }); }
    if (b.gag === 'team') agents.filter((a) => !a.fromCrate && a.tIn >= b.t0 - 0.5 && a.tIn < b.t1).forEach((a) => { const p = orbitAt(a.S, a.k, a.tIn); fx.burst('confetti', a.tIn, { pos: [p.x, a.S.y + 0.3, p.z], n: 16, dir: [0, 1, 0], spread: 0.7, speed: [1.5, 3] }); });
    if (b.gag === 'approve') fx.burst('glow', h, { pos: [S.button[0], S.y + S.top + 0.2, S.button[1]], n: 2, speed: [0, 0.1], size: [0.5, 0.7] });
    // confetti from both sides of the desk, kept low: the screen (logo, url) stays readable
    if (b.gag === 'celebrate') for (const s of [-1, 1]) fx.burst('confetti', h + (s > 0 ? 0.12 : 0), { pos: [S.x + s * 1.05, S.y + 0.5, S.z + 0.96], n: 80, dir: [-s * 0.5, 1, 0.4], spread: 0.5, speed: [2.4, 3.6] });
  }

  // ---------------------------------------------------------------- the big screens, one per station
  for (const m of members) m.screenKey = '';
  const screenAt = (m, t) => {
    let s = m.S.idleScreen || { kind: 'logo' }, from = null;
    for (const b of m.beats) {
      if (t < b.t0) break;
      if (b.screen && b.screen.kind && b.screen.kind !== 'none') { s = b.screen; from = b; }
      if ((b.gag === 'explode' || b.gag === 'zap') && t >= b.hit) { s = { kind: 'error', lines: b.screen && b.screen.kind === 'error' ? b.screen.lines : ['ERROR'] }; from = b; }
    }
    const u = from ? u01(t, from.s0, Math.max(from.s0 + 0.5, from.s1 - 0.25)) : 1;
    if (m.key === 'hero' && t >= last.s1 + 0.15) s = { kind: 'logo' };   // the ending: the brand card with its url
    return { s, u };
  };
  function drawWall(m, t) {
    const { s, u } = screenAt(m, t);
    const q = s.kind === 'terminal' || s.kind === 'chat' || s.kind === 'dashboard' || s.kind === 'image' ? Math.round(u * 120) : s.kind === 'logo' ? Math.round(Math.min(1, u * 3) * 30) : 0;
    const blink = s.kind === 'terminal' ? Math.floor(t * 2) % 2 : s.kind === 'error' ? Math.floor(t * 10) : 0;
    const key = JSON.stringify([s, q, blink]);
    if (key === m.screenKey) return;
    m.screenKey = key;
    const img = s.image ? images.get(s.image) : null;
    drawScreen(m.S.screen.ctx, s, q / 120, t, brand, { logo, image: img });
    m.S.screen.tex.needsUpdate = true;
  }

  // ---------------------------------------------------------------- the characters
  for (const m of members) {
    m.explodes = m.beats.filter((b) => b.gag === 'explode'); m.zaps = m.beats.filter((b) => b.gag === 'zap'); m.shows = m.beats.filter((b) => b.gag === 'show');
    m.piles = piles.filter((P) => P.M === m && !P.purchases);
  }
  function poseFor(m, t) {
    const C = m.C, S = m.S, cur = beatAt(t), mine = cur.who === m.key, b = mine ? cur : null;
    const p = { x: S.x, y: S.y, z: S.z, rotY: S.rotY || 0, t, lean: 0.04, eyes: C.face.eyes, mouth: C.face.mouth, beard: C.face.beard, brows: C.face.brows, look: [0, 0], head: { x: 0.04 * Math.sin(t * 1.3), y: 0.08 * Math.sin(t * 0.7), z: 0.03 * Math.sin(t * 0.9) }, armL: { x: 0.05, z: 0.18, el: 0.25 }, armR: { x: 0.05, z: 0.18, el: 0.25 } };
    const breathe = 1 + 0.012 * Math.sin(t * 2.4); p.squash = [1, breathe];
    const typing = () => { const s = Math.sin(t * 23); p.lean = 0.16; p.head = { x: 0.26, y: 0.05 * Math.sin(t * 3), z: 0 }; p.eyes = 'open'; p.look = [0, -0.6]; p.brows = -0.7; p.mouth = 'flat'; p.armL = { x: -1.05 + 0.1 * s, z: 0.22, el: 0.55 }; p.armR = { x: -1.05 - 0.1 * s, z: 0.22, el: 0.55 }; };
    if (!b) {
      // the other floor's beat: the rival keeps grinding (and glances up at the noise); the lead works, unbothered
      if (m.key === 'rival') { typing(); p.mouth = 'frown'; p.brows = 0.85; const up = Math.max(0, Math.sin(t * 0.9)); if (up > 0.6) { p.head = { x: -0.35, y: 0.1, z: 0 }; p.look = [0, 0.8]; p.eyes = 'wide'; p.mouth = 'o'; } }
      else { typing(); p.mouth = 'line'; p.brows = -0.2; }
    } else {
      const h = t - b.hit, lt = t - b.t0;
      switch (b.gag) {
        case 'hack': typing(); if (h > 0) { p.mouth = 'grin'; p.eyes = 'wide'; p.brows = 0.2; } break;
        case 'explode':
          if (h < 0) { typing(); if (h > -0.5) { p.eyes = 'wide'; p.mouth = 'o'; p.brows = 0.8; } }
          else { const k = u01(h, 0, 0.12); p.rx = -0.38 * k + 0.2 * wobble(t, b.hit + 0.12, 0.6, 9, 3); p.squash = squash(t, b.hit, 0.32); p.eyes = 'x'; p.mouth = 'scream'; p.armL = { x: 0.6, z: 2.3, el: 0.5 }; p.armR = { x: 0.6, z: 2.3, el: 0.5 }; p.head = { x: -0.2, y: 0, z: 0.15 * Math.sin(t * 9) }; }
          break;
        case 'bury':
          if (h < 0) { p.head = { x: -0.45, y: 0, z: 0 }; p.eyes = 'wide'; p.mouth = 'o'; p.brows = 0.9; p.armL = { x: -0.4, z: 1.6, el: 1.0 }; p.armR = { x: -0.4, z: 1.6, el: 1.0 }; }
          else { p.squash = squash(t, b.hit + 0.15, 0.3); p.eyes = 'spiral'; p.mouth = 'wavy'; p.head = { x: 0.1, y: 0, z: 0.25 * Math.sin(t * 2.2) }; p.armL = { x: 0, z: 0.1, el: 0.2 }; p.armR = { x: 0, z: 0.1, el: 0.2 }; }
          break;
        case 'zap':
          if (h < 0) { p.armR = { x: -1.0, z: 0.42, el: 0.25 }; p.head = { x: 0.35, y: 0.35, z: 0 }; p.lean = 0.12; p.mouth = 'smile'; }
          // a jolt, not a strobe: two short x-ray pulses, then the shock on the face
          else if (h < 0.55) { p.xray = h < 0.06 || (h > 0.13 && h < 0.19); p.hairUp = 1; p.eyes = 'wide'; p.mouth = 'o'; p.armR = { x: -1.0, z: 0.42, el: 0.25 }; p.squash = [1 + 0.04 * Math.sin(h * 90), 1 + 0.04 * Math.cos(h * 90)]; }
          else { p.hairUp = Math.max(0, 1 - (h - 0.55) / 2.5); p.eyes = 'spiral'; p.mouth = 'wavy'; p.armR = { x: 0.1, z: 0.3, el: 0.4 }; }
          break;
        case 'money':
          if (t > Math.min(b.hit, b.s0 + 0.3) - 0.2) { p.eyes = 'wide'; p.mouth = 'o'; p.brows = 0.9; p.armL = { x: -2.5 + 0.2 * Math.sin(t * 9), z: 0.4, el: 0.5 }; p.armR = { x: -2.5 - 0.2 * Math.sin(t * 9), z: 0.4, el: 0.5 }; p.head = { x: -0.32, y: 0.1 * Math.sin(t * 4), z: 0 }; }
          break;
        case 'deliver': {
          const look = clamp(u01(t, b.hit - 0.6, b.hit - 0.3));
          p.head = { x: lerp(0, -0.15, look) + (h > 0 ? 0.2 : 0), y: lerp(0, 0.55, look), z: 0 }; p.eyes = h < 0.6 ? 'wide' : 'open'; p.mouth = h < 0.6 ? 'o' : 'grin'; p.brows = h < 0.6 ? 0.7 : 0.2;
          if (h > 0 && h < 0.6) p.squash = squash(t, b.hit, 0.2);
          break;
        }
        case 'team': p.mouth = 'grin'; p.armL = { x: -0.5, z: 1.15, el: 0.3 }; p.armR = { x: -0.5, z: 1.15, el: 0.3 }; p.head = { x: 0.15, y: 0.3 * Math.sin(t * 1.6), z: 0 }; break;
        case 'approve': {
          const up = u01(t, b.hit - 0.75, b.hit - 0.3), down = u01(t, b.hit - 0.12, b.hit);
          p.armL = { x: lerp(lerp(0.05, -2.5, easeOut(up)), -1.25, down ** 2), z: lerp(0.18, 0.5, up), el: lerp(0.25, 0.1, up) };
          p.head = { x: 0.2, y: -0.35, z: 0 }; p.brows = h > 0 ? 0.1 : -0.9; p.mouth = h > 0 ? 'grin' : 'teeth'; p.eyes = 'open'; p.look = [-0.5, -0.4];
          break;
        }
        case 'show': p.armR = { x: -2.2, z: 1.0, el: 0.15 }; p.armL = { x: 0, z: 0.2, el: 0.3 }; p.mouth = 'grin'; p.head = { x: 0.05, y: 0.35, z: -0.06 }; break;
        case 'celebrate': {
          if (h > -0.1) { const j = Math.max(0, Math.sin((PI * Math.max(0, h)) / 0.42)); p.y = S.y + 0.22 * j * (h < 1.3 ? 1 : 0.3); p.armL = { x: 0, z: 2.6, el: 0.2 }; p.armR = { x: 0, z: 2.6, el: 0.2 }; p.eyes = 'closed'; p.mouth = 'grin'; p.squash = squash(t, b.hit + 0.42, 0.18); }
          break;
        }
        default: if (lt < 0.4) p.mouth = 'o';
      }
    }
    // the lead's celebration makes the rival hold his head
    if (m.key === 'rival') { const cel = beats.find((x) => x.gag === 'celebrate' && x.who === 'hero' && t >= x.hit); if (cel && !mine) { p.armL = { x: -2.6, z: 0.9, el: 2.0 }; p.armR = { x: -2.6, z: 0.9, el: 2.0 }; p.head = { x: 0.3, y: 0.25 * Math.sin(t * 5), z: 0 }; p.eyes = 'closed'; p.mouth = 'frown'; p.brows = 1; } }
    // a show beat: the character steps aside (walking) so the screen and the caption are clear, presents it, and steps back after
    for (const s of m.shows) {
      const out = u01(t, s.t0, s.t0 + 0.5), back = u01(t, s.t1, s.t1 + 0.5), k = easeIO(out) * (1 - easeIO(back));
      if (k > 0) { p.x = S.x - 0.6 * k; if ((out > 0 && out < 1) || (back > 0 && back < 1)) { p.walk = t * 11; p.walkAmt = 0.8; } }
    }
    // aftermath: an explosion or a zap leaves the character charred for a while
    for (const e of [...m.explodes, ...m.zaps]) { const a = t - e.hit; if (a >= 0 && a < 5) { const c = (e.gag === 'explode' ? 0.85 : 0.45) * (1 - clamp((a - 0.4) / 4.2)); p.char = Math.max(p.char || 0, c); if (e.gag === 'explode' && a < 1.1) p.hairUp = Math.max(p.hairUp || 0, 1 - a / 1.6); } }
    // a blink every few seconds (never on a gag face)
    if ((p.eyes === 'open' || p.eyes === 'cool') && ((t + (m.key === 'rival' ? 1.3 : 0)) % 3.7) < 0.12) p.eyes = 'closed';
    // under a pile until the next beat knocks it off
    for (const P of m.piles) if (t >= P.b.hit && t < P.clear + 0.3) { p.eyes = 'spiral'; if (t > P.clear) { const k = u01(t, P.clear, P.clear + 0.3); p.squash = [1 - 0.1 * (1 - k), 1 + 0.2 * Math.sin(k * PI)]; } }
    if (S.pose) S.pose(p, t, b ? b.gag : null);
    if (C.stoic && STOIC_MOUTH[p.mouth]) p.mouth = STOIC_MOUTH[p.mouth];
    return p;
  }

  // ---------------------------------------------------------------- per frame
  const V = new THREE.Vector3();
  function update(t) {
    E.update(t);
    // laptops: charred and the lid blown open after an explosion (until the brand's crate lands at that station)
    for (const m of members) {
      const L = m.S.laptop; if (!L) continue;
      const boom = m.explodes.find((e) => t >= e.hit), fixedAt = crateBeat && crateBeat.who === m.key ? crateBeat.hit : 1e9;
      const broken = boom && t < fixedAt;
      L.hinge.rotation.x = broken ? -1.15 * clamp((t - boom.hit) / 0.12) + 0.25 * wobble(t, boom.hit + 0.12, 1, 14, 4) : 0;
      L.screen.material.color.setHex(broken ? 0x111111 : 0x3a5f9a);
      L.base.material.color.setHex(broken ? 0x2a2622 : 0xb8bcc2);
    }
    // crate: drops in on the hit, squashes, lid flies off, stays open
    if (crate) {
      const b = crateBeat, S = b.S, t0 = b.hit - 0.42;
      crate.g.visible = t >= t0;
      crate.g.position.y = S.y + drop(t, t0, 3.4, 0.42);
      const [sx, sy] = squash(t, b.hit, 0.25); crate.body.scale.set(sx, sy, sx);
      const a = t - (b.hit + 0.5);
      // the lid flies off to the side and lands flat on the floor
      if (a > 0) { const k = Math.min(a, 0.62); crate.lid.position.set(0.75 * k, crate.S * 0.86 + 2.6 * k - 6.6 * k * k, 0.55 * k); crate.lid.rotation.set(k * 5.07, 0, k * 2); if (a >= 0.62 || crate.lid.position.y < 0.05) { crate.lid.position.set(0.47, 0.05, 0.34); crate.lid.rotation.set(0, 0.5, 0); } }
      else { crate.lid.position.set(0, crate.S * 0.86, 0); crate.lid.rotation.set(0, 0, 0); }
    }
    // agents: pop in (or climb out of the crate), then roam their orbits for the rest of the ad
    const celebrate = beats.find((b) => b.gag === 'celebrate' && b.who === 'hero' && t >= b.hit);
    if (celebrate && E.cheer) E.cheer(t, clamp((t - celebrate.hit) / 0.3));
    for (const r of agents) {
      const s = r.fromCrate ? easeOutBack(u01(t, r.tIn, r.tIn + 0.35)) : pop(t, r.tIn, 0.34);
      const o = orbitAt(r.S, r.k, t);
      let x = o.x, z = o.z, y = r.S.y, rotY = o.rotY;
      if (r.fromCrate) {
        const top = [r.S.crate[0], r.S.y + crate.S * 0.86, r.S.crate[1]], k = u01(t, r.tIn + 0.45, r.tIn + 1.25), o1 = orbitAt(r.S, r.k, r.tIn + 1.25);
        if (k < 1) { x = lerp(top[0], o1.x, k); z = lerp(top[2], o1.z, k); y = lerp(top[1] - 0.15 * (1 - s), r.S.y, k) + Math.sin(k * PI) * 0.55; rotY = Math.atan2(-(o1.z - top[2]), o1.x - top[0]); }
      }
      const hop = celebrate ? Math.abs(Math.sin((t - celebrate.hit) * 9 + r.k)) * 0.12 : 0;
      if (celebrate) rotY += (t - celebrate.hit) * 7;
      r.ag.set({ x, z, y, rotY, t: t + r.k * 0.7, hat: r.hat || 0, scale: 0.75 * s, hop });
    }
    // piles: boxes rain onto the character on the hit, then get knocked off to the floor at the next beat
    for (const P of piles) for (const q of P.boxes) {
      q.bx.g.visible = t >= q.t0;
      if (t < P.clear) { const hgt = drop(t, q.t0, 2.6, 0.4); q.bx.g.position.set(q.p1[0], q.p1[1] + hgt, q.p1[2]); q.bx.g.rotation.set(q.r1[0] + wobble(t, q.t0 + 0.4, 0.2), q.r1[1], q.r1[2]); }
      else { const k = u01(t, P.clear, P.clear + 0.55); q.bx.g.position.set(lerp(q.p1[0], q.p2[0], k), lerp(q.p1[1], q.p2[1], k) + Math.sin(k * PI) * 0.7, lerp(q.p1[2], q.p2[2], k)); q.bx.g.rotation.set(lerp(q.r1[0], q.r2[0], k) + k * 3, lerp(q.r1[1], q.r2[1], k), lerp(q.r1[2], q.r2[2], k)); }
    }
    // buttons: pop up on the desk, slammed on the hit, pop away after the beat
    for (const B of buttons) {
      const S = B.b.S, s = pop(t, B.b.t0 + 0.05, 0.35) * (t > B.out ? Math.max(0, 1 - (t - B.out) / 0.25) : 1);
      const press = t >= B.b.hit ? clamp(1 - (t - B.b.hit - 0.12) / 0.3) : 0;
      B.bt.set({ x: S.button[0], y: S.y + S.top, z: S.button[1], press, scale: s });
    }
    for (const m of members) {
      m.C.toon.set(poseFor(m, t));
      // dizzy stars over a buried or zapped character
      let dz = 0;
      for (const P of m.piles) if (t >= P.b.hit + 0.2 && t < P.clear) dz = 1;
      for (const e of m.zaps) if (t >= e.hit + 0.55 && t < e.hit + 2.6) dz = Math.max(dz, 1 - clamp((t - e.hit - 2.2) / 0.4));
      m.C.toon.head.getWorldPosition(V);
      m.dizzy.update(t, dz, [V.x, V.y + 0.36, V.z]);
      drawWall(m, t);
    }
    fx.update(t, camera);
    const c = rail.at(t);
    studio.setCamera(c.pos, c.look, c.fov, t, 0);
    kick.apply(camera, t, Math.hypot(c.pos[0] - c.look[0], c.pos[1] - c.look[1], c.pos[2] - c.look[2]));
  }

  /** Faces under text (ED Studio's --qc): a character's face under the one-word caption (52 %) or a callout band, per 0.25 s. */
  function qc() {
    const out = [], bands = { term: 0.203, label: 0.136, money: 0.166, stamp: 0.29 };
    const P = new THREE.Vector3();
    for (let t = 0; t < END; t += 0.25) {
      update(t); camera.updateMatrixWorld();
      for (const m of members) {
        const who = m.key === 'rival' ? 'the rival' : 'the developer';
        m.C.toon.root.updateMatrixWorld(true); m.C.toon.head.getWorldPosition(P); P.project(camera);
        const fy = (1 - P.y) / 2, fxp = (P.x + 1) / 2; if (fxp < 0 || fxp > 1 || fy < 0 || fy > 1 || P.z > 1) continue;
        const w = (story.words || []).find((x) => t >= x.t0 && t < x.t1);
        if (w && Math.abs(fy - 0.52) < 0.045) out.push(`t=${t.toFixed(2)}: ${who}'s face under the caption ("${w.w}")`);
        for (const co of story.callouts || []) {
          if (t < co.t0 || t > co.t1) continue;
          const y = co.y ?? (co.pos ? co.pos[1] : bands[co.style]); if (y == null) continue;
          if (Math.abs(fy - y) < 0.065 && (co.x == null || Math.abs(fxp - co.x) < 0.3)) out.push(`t=${t.toFixed(2)}: ${who}'s face under the ${co.style} callout "${co.text}"`);
        }
      }
    }
    return out;
  }

  return { update, qc };
}
