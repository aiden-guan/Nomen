// Build-genre toon cast (docs/BUILD.md): big-headed mascots whose FACES do the comedy (wide eyes, spirals, X eyes,
// screams), unlike the small-headed wooden rig in rig.js. ~1.42 m tall; the head is ~40 % of the height.
//   const gary = makeToon({ shirt: 0x2bb3a3, pants: 0x34495e, hair: 0x6b3f22, hairStyle: 'tuft', hat: 'hardhat' });
//   scene.add(gary.root); gary.set({ x, y, z, rotY, walk: phase, eyes: 'wide', mouth: 'scream', look: [0.3, 0] });
// Pose fields (all optional; omitted = neutral): x,y,z (feet), rotY (model faces +z), rx/rz (tilt around the belly — lying
// down = rx -PI/2), scale, squash [sx, sy], lean, walk (gait phase, radians) + walkAmt, armL/armR {x: forward(-)/back(+),
// z: out(+), el: elbow bend(+)}, legL/legR {x, kn}, head {x: nod, y: turn, z: tilt}, eyes 'open'|'wide'|'half'|'closed'|
// 'spiral'|'x', look [dx, dy] (-1..1), brows -1 angry … +1 worried, mouth 'smile'|'grin'|'o'|'scream'|'flat'|'frown'|'wavy'|
// 'teeth', beard 0..1 (1 = to the floor), gray 0..1 (hair goes white), hairUp 0..1, xray (bool, skeleton flash), char 0..1,
// tint [color, 0..1] (whole body, e.g. fossil stone), faceTint [color, k] (skin only: strain red, nausea green), hatLift 0..1
// (the hard hat pops off; spikes show), noHat.
// Nomen additions (code ads cast developers, not builders): makeToon({ build: 'heavy'|'fit', glasses: 'round'|'square',
// hairStyle: 'mop'|'quiff', hood, headphones, jaw, watch, browW }) and the 'smirk' mouth. All optional and additive.
// The code-ad cast (engine/cast.js) adds: build 'buff' (a V-shaped lifter: pecs, delts, traps, biceps, a thick neck) and
// 'obese' (a gut the tee rides up over, moobs, chunky limbs), face 'chad' (a chiselled, stubbled jaw, high cheekbones) and
// 'chud' (jowls, a double chin, a red nose, pimples), eyeShape 'hunter' (narrow, hooded, tilted, coloured irises) and
// 'beady', hairStyle 'wolf' (a shaggy wolf cut) and 'balding' (a greasy comb-over, stringy sides), print {image, text, ink}
// (a print on the tee), stains, greasy, sweat, flies, tape (taped glasses), bags (under the eyes), height, armOut, and the
// 'line' and 'slack' mouths.
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { clamp, lerp, mk } from '../core.js';

const tex = (w, h, draw) => {
  const c = document.createElement('canvas'); c.width = w; c.height = h; draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
};
let MOUTHS = null, EYEFX = null;
function mouthTextures() {
  if (MOUTHS) return MOUTHS;
  const ink = '#3a1a14', lip = (g) => { g.lineCap = 'round'; g.lineJoin = 'round'; g.strokeStyle = ink; g.lineWidth = 16; };
  const open = (g, w, h, rx, ry, cy, teeth = true, tongue = true) => {
    g.save(); g.beginPath(); g.ellipse(w / 2, cy, rx, ry, 0, 0, Math.PI * 2); g.fillStyle = '#5a1714'; g.fill(); g.clip();
    if (tongue) { g.fillStyle = '#e8616b'; g.beginPath(); g.ellipse(w / 2, cy + ry * 0.75, rx * 0.65, ry * 0.5, 0, 0, Math.PI * 2); g.fill(); }
    if (teeth) { g.fillStyle = '#fff'; g.fillRect(w / 2 - rx, cy - ry, rx * 2, ry * 0.32); }
    g.restore(); lip(g); g.lineWidth = 9; g.beginPath(); g.ellipse(w / 2, cy, rx, ry, 0, 0, Math.PI * 2); g.stroke();
  };
  MOUTHS = {
    smile: tex(256, 192, (g, w, h) => { lip(g); g.beginPath(); g.arc(w / 2, h * 0.18, 92, 0.22 * Math.PI, 0.78 * Math.PI); g.stroke(); }),
    smirk: tex(256, 192, (g, w, h) => { lip(g); g.beginPath(); g.moveTo(w * 0.3, h * 0.5); g.quadraticCurveTo(w * 0.55, h * 0.58, w * 0.72, h * 0.34); g.stroke(); }),
    // a short, firm, closed mouth that lifts at one corner (the leading man's resting face)
    line: tex(256, 192, (g, w, h) => { lip(g); g.lineWidth = 12; g.beginPath(); g.moveTo(w * 0.37, h * 0.5); g.quadraticCurveTo(w * 0.52, h * 0.54, w * 0.65, h * 0.45); g.stroke(); }),
    // slack-jawed and half open, yellowed buck teeth
    slack: tex(256, 192, (g, w, h) => {
      const cy = h * 0.56;
      g.save(); g.beginPath(); g.ellipse(w / 2, cy, 54, 36, 0, 0, Math.PI * 2); g.fillStyle = '#4a1512'; g.fill(); g.clip();
      g.fillStyle = '#e9dc98'; g.fillRect(w / 2 - 23, cy - 36, 21, 27); g.fillRect(w / 2 + 2, cy - 36, 19, 22);
      g.fillStyle = '#cf5f69'; g.beginPath(); g.ellipse(w / 2 + 6, cy + 27, 36, 18, 0, 0, Math.PI * 2); g.fill(); g.restore();
      lip(g); g.lineWidth = 9; g.beginPath(); g.ellipse(w / 2, cy, 54, 36, 0, 0, Math.PI * 2); g.stroke();
    }),
    flat: tex(256, 192, (g, w, h) => { lip(g); g.beginPath(); g.moveTo(w * 0.32, h * 0.52); g.lineTo(w * 0.68, h * 0.52); g.stroke(); }),
    frown: tex(256, 192, (g, w, h) => { lip(g); g.beginPath(); g.arc(w / 2, h * 0.95, 80, 1.25 * Math.PI, 1.75 * Math.PI); g.stroke(); }),
    wavy: tex(256, 192, (g, w, h) => { lip(g); g.beginPath(); for (let i = 0; i <= 20; i++) { const x = w * 0.26 + (w * 0.48 * i) / 20, y = h * 0.52 + Math.sin(i * 0.95) * 10; i ? g.lineTo(x, y) : g.moveTo(x, y); } g.stroke(); }),
    grin: tex(256, 192, (g, w, h) => {
      g.save(); g.beginPath(); g.moveTo(w * 0.18, h * 0.3); g.quadraticCurveTo(w / 2, h * 0.38, w * 0.82, h * 0.3); g.quadraticCurveTo(w / 2, h * 1.05, w * 0.18, h * 0.3);
      g.fillStyle = '#5a1714'; g.fill(); g.clip(); g.fillStyle = '#fff'; g.fillRect(0, h * 0.25, w, h * 0.17);
      g.fillStyle = '#e8616b'; g.beginPath(); g.ellipse(w / 2, h * 0.78, 50, 26, 0, 0, Math.PI * 2); g.fill(); g.restore();
      lip(g); g.lineWidth = 9; g.beginPath(); g.moveTo(w * 0.18, h * 0.3); g.quadraticCurveTo(w / 2, h * 0.38, w * 0.82, h * 0.3); g.quadraticCurveTo(w / 2, h * 1.05, w * 0.18, h * 0.3); g.stroke();
    }),
    o: tex(256, 192, (g, w, h) => open(g, w, h, 26, 32, h * 0.5, false, false)),
    scream: tex(256, 192, (g, w, h) => open(g, w, h, 62, 78, h * 0.5)),
    teeth: tex(256, 192, (g, w, h) => {
      g.fillStyle = '#fff'; g.beginPath(); g.roundRect(w * 0.2, h * 0.3, w * 0.6, h * 0.4, 30); g.fill();
      g.strokeStyle = '#9aa'; g.lineWidth = 4; for (let i = 1; i < 6; i++) { g.beginPath(); g.moveTo(w * 0.2 + (w * 0.6 * i) / 6, h * 0.3); g.lineTo(w * 0.2 + (w * 0.6 * i) / 6, h * 0.7); g.stroke(); }
      g.beginPath(); g.moveTo(w * 0.2, h * 0.5); g.lineTo(w * 0.8, h * 0.5); g.stroke(); lip(g); g.lineWidth = 9; g.beginPath(); g.roundRect(w * 0.2, h * 0.3, w * 0.6, h * 0.4, 30); g.stroke();
    }),
  };
  return MOUTHS;
}
function eyeFx() {
  if (EYEFX) return EYEFX;
  EYEFX = {
    spiral: tex(128, 128, (g, w) => { g.fillStyle = '#fff'; g.beginPath(); g.arc(w / 2, w / 2, w / 2, 0, 7); g.fill(); g.strokeStyle = '#222'; g.lineWidth = 7; g.beginPath(); for (let a = 0; a < 6 * Math.PI; a += 0.1) { const r = 3 + a * 3.2; g.lineTo(w / 2 + Math.cos(a) * r, w / 2 + Math.sin(a) * r); } g.stroke(); }),
    x: tex(128, 128, (g, w) => { g.fillStyle = '#fff'; g.beginPath(); g.arc(w / 2, w / 2, w / 2, 0, 7); g.fill(); g.strokeStyle = '#222'; g.lineWidth = 14; g.lineCap = 'round'; g.beginPath(); g.moveTo(34, 34); g.lineTo(94, 94); g.moveTo(94, 34); g.lineTo(34, 94); g.stroke(); }),
  };
  return EYEFX;
}

// ---------------------------------------------------------------- Nomen: a sculpted head, hair clumps, tee prints, stains
/**
 * The leading man's head, sculpted from a unit sphere: the lower face squares off (crisp jaw corners) and tapers to a
 * narrower chin that juts forward with a flat underside; a brow ridge over deep-set eyes, cheekbones, hollows under them,
 * slightly narrower temples. Smooth, one surface (the seam is welded so the shading has no line).
 */
function sculptedHead(R) {
  let geo = new THREE.SphereGeometry(1, 56, 40);
  const p = geo.attributes.position, v = new THREE.Vector3(), cols = [];
  const ss = (a, b, x) => { const u = Math.min(1, Math.max(0, (x - a) / (b - a))); return u * u * (3 - 2 * u); };
  const bump = (cx, cy, cz, w, amt) => amt * Math.exp(-((v.x - cx) ** 2 + (v.y - cy) ** 2 + (v.z - cz) ** 2) / w);
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    let { x, y, z } = v;
    const k = ss(0.15, -0.45, y);
    if (k > 0) { const th = Math.atan2(x, z), n = 4, sq = 1 / (Math.abs(Math.sin(th)) ** n + Math.abs(Math.cos(th)) ** n) ** (1 / n), f = 1 + (sq - 1) * k; x *= f; z *= f; }
    x *= 1 - 0.17 * ss(-0.5, -0.98, y);   // a square chin, narrower than the jaw
    z += 0.1 * ss(-0.5, -0.9, y) * ss(0.1, 0.7, v.z);
    if (y < -0.86) y = -0.86 + (y + 0.86) * 0.35;
    x *= 1 - 0.06 * ss(0.1, 0.6, y);
    if (y < 0) y *= 1 + 0.16 * ss(0, -0.7, y);   // a longer lower face: an adult, not a baby
    const r = 1 + bump(0.39, 0.36, 0.84, 0.03, 0.04) + bump(-0.39, 0.36, 0.84, 0.03, 0.04) + bump(0.66, -0.02, 0.75, 0.022, 0.045) + bump(-0.66, -0.02, 0.75, 0.022, 0.045)
      - bump(0.62, -0.42, 0.66, 0.03, 0.07) - bump(-0.62, -0.42, 0.66, 0.03, 0.07);
    p.setXYZ(i, x * r * R[0], y * r * R[1], z * r * R[2]);
    // a shadow of stubble on the jaw, the chin and the upper lip (vertex colours, multiplied into the skin)
    const st = ss(-0.2, -0.46, v.y) * ss(-0.5, 0.0, v.z) * (1 - 0.35 * ss(0.8, 0.99, Math.abs(v.x)));
    cols.push(1 - 0.62 * st, 1 - 0.6 * st, 1 - 0.52 * st);
  }
  geo.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
  geo.deleteAttribute('normal'); geo.deleteAttribute('uv');
  geo = mergeVertices(geo); geo.computeVertexNormals();
  return geo;
}
const LOCKS = {};
/** A tapered hair clump (a lathe): root at the origin, tip at y = -1, max radius 1; `sharp` makes the tip pointier. */
function lockGeo(sharp = 0) {
  if (LOCKS[sharp]) return LOCKS[sharp];
  const pts = [];
  for (let i = 0; i <= 14; i++) { const u = i / 14; pts.push(new THREE.Vector2(Math.max(1e-4, Math.sin(Math.PI * (0.12 + 0.88 * u)) ** 0.6 * (1 - u) ** (0.5 * sharp)), -u)); }
  return (LOCKS[sharp] = new THREE.LatheGeometry(pts, 10));
}
const DOWN = new THREE.Vector3(0, -1, 0);
/** One hair clump on `parent`: rooted at p, pointing along d, `len` long, `r` thick (flattened by `flat`). */
function addLock(parent, m, p, d, len, r, flat = 0.75, sharp = 0) {
  const lk = new THREE.Mesh(lockGeo(sharp), m); lk.position.set(p[0], p[1], p[2]);
  lk.quaternion.setFromUnitVectors(DOWN, new THREE.Vector3(d[0], d[1], d[2]).normalize());
  lk.scale.set(r, len, r * flat); lk.castShadow = true; lk.receiveShadow = true; parent.add(lk); return lk;
}
/**
 * A print for a tee, on a transparent canvas: an image (contained; a squarish mark gets `text` under it in `font`), or
 * bold caps in `ink`.
 */
function printTex(img, text, ink = '#ffffff', font = null, w = 512, h = 320) {
  return tex(w, h, (g) => {
    g.fillStyle = ink; g.textAlign = 'center'; g.textBaseline = 'middle';
    if (img) {
      const iw = img.naturalWidth || img.width || 1, ih = img.naturalHeight || img.height || 1, mark = !!text && iw / ih < 1.6;
      const s = Math.min((w * 0.92) / iw, ((mark ? 0.6 : 0.92) * h) / ih);
      g.drawImage(img, (w - iw * s) / 2, mark ? h * 0.03 : (h - ih * s) / 2, iw * s, ih * s);
      if (mark) {
        let size = 96; const fam = font ? `"${font}", Helvetica, Arial, sans-serif` : 'Helvetica, Arial, sans-serif';
        do { g.font = `700 ${size}px ${fam}`; size -= 4; } while (g.measureText(text).width > w * 0.9 && size > 30);
        g.fillText(text, w / 2, h * 0.82);
      }
      return;
    }
    const words = String(text || '').toUpperCase().split(/\s+/).filter(Boolean);
    const lines = words.length > 2 ? [words.slice(0, Math.ceil(words.length / 2)).join(' '), words.slice(Math.ceil(words.length / 2)).join(' ')] : [words.join(' ')];
    let size = 160; const widest = () => { g.font = `400 ${size}px "Luckiest Guy", Impact, "Arial Black", sans-serif`; return Math.max(...lines.map((l) => g.measureText(l).width)); };
    while (widest() > w * 0.94 && size > 40) size -= 6;
    lines.forEach((l, i) => g.fillText(l, w / 2, h / 2 + 8 + (i - (lines.length - 1) / 2) * size * 0.98));
  });
}
/** A grubby tee: an off-white base under coffee, ketchup, mustard and cheese-dust stains, grease spots and crumbs. */
function stainTex(base = '#ebe3cd') {
  return tex(512, 512, (g, w, h) => {
    g.fillStyle = base; g.fillRect(0, 0, w, h);
    let s = 11; const r = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    const blob = (x, y, rad, col, a) => { g.globalAlpha = a; g.fillStyle = col; g.beginPath(); for (let k = 0; k <= 16; k++) { const an = (k / 16) * Math.PI * 2, rr = rad * (0.65 + r() * 0.55); g.lineTo(x + Math.cos(an) * rr, y + Math.sin(an) * rr * 0.8); } g.fill(); g.globalAlpha = 1; };
    for (let i = 0; i < 34; i++) blob(r() * w, r() * h, 9 + r() * 30, ['#6f4a2c', '#b3312a', '#d4a11c', '#e07f27', '#8a8466'][i % 5], 0.4 + r() * 0.4);
    for (let i = 0; i < 420; i++) { g.fillStyle = r() < 0.55 ? 'rgba(226,128,38,.75)' : 'rgba(80,60,36,.4)'; g.fillRect(r() * w, r() * h, 3 + r() * 3, 3 + r() * 3); }
  });
}

export function makeToon(o = {}) {
  const C = { skin: 0xf2c29a, shirt: 0x2bb3a3, pants: 0x34495e, shoes: 0x3b2a20, hair: 0x6b3f22, ...o };
  const M = {
    skin: new THREE.MeshStandardMaterial({ color: C.skin, roughness: C.sweat ? 0.36 : 0.55 }), shirt: new THREE.MeshStandardMaterial({ color: C.stains ? 0xffffff : C.shirt, roughness: 0.8, map: C.stains ? stainTex() : null }),
    pants: new THREE.MeshStandardMaterial({ color: C.pants, roughness: 0.85 }), shoes: new THREE.MeshStandardMaterial({ color: C.shoes, roughness: 0.6 }),
    hair: new THREE.MeshStandardMaterial({ color: C.hair, roughness: C.greasy ? 0.24 : 0.72, metalness: C.greasy ? 0.18 : 0 }), white: new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.25 }),
    stubble: new THREE.MeshStandardMaterial({ color: new THREE.Color(C.skin).lerp(new THREE.Color(0x4a4048), C.stubble ?? 0.15), roughness: 0.62 }),
    flush: new THREE.MeshStandardMaterial({ color: new THREE.Color(C.skin).lerp(new THREE.Color(0xe0606a), 0.07), roughness: C.sweat ? 0.36 : 0.5 }),
    iris: new THREE.MeshStandardMaterial({ color: C.iris ?? 0x4f86a6, roughness: 0.2 }),
    face: new THREE.MeshStandardMaterial({ color: C.skin, roughness: 0.55, vertexColors: true }), hair2: new THREE.MeshStandardMaterial({ color: new THREE.Color(C.hair).lerp(new THREE.Color(0x8a6a4a), 0.22), roughness: 0.6 }),
    lash: new THREE.MeshStandardMaterial({ color: 0x3a2418, roughness: 0.6 }), lid: new THREE.MeshStandardMaterial({ color: new THREE.Color(C.skin).lerp(new THREE.Color(0x6a4636), 0.28), roughness: 0.55 }), nose: new THREE.MeshStandardMaterial({ color: new THREE.Color(C.skin).lerp(new THREE.Color(0xd8505a), 0.36), roughness: 0.45 }),
    pupil: new THREE.MeshStandardMaterial({ color: 0x1d1612, roughness: 0.2 }), hat: new THREE.MeshStandardMaterial({ color: C.hatColor ?? 0xffc21a, roughness: 0.35 }),
    beard: new THREE.MeshStandardMaterial({ color: C.beard ?? 0xeeeeee, roughness: 0.9 }), bone: new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.5, emissive: 0xd8f2ff, emissiveIntensity: 0.9 }),
  };
  const base = Object.fromEntries(Object.entries(M).map(([k, m]) => [k, m.color.clone()]));
  const root = new THREE.Group(), pivot = new THREE.Group(), body = new THREE.Group();
  root.add(pivot); pivot.position.y = 0.62; pivot.add(body); body.position.y = -0.62;
  const bones = []; const bone = (parent, len, r, y) => { const b = mk(new THREE.CapsuleGeometry(r, len, 4, 8), M.bone, parent, 0, y, 0); b.visible = false; b.castShadow = false; bones.push(b); return b; };

  // torso + hips
  const pelvis = mk(new THREE.SphereGeometry(0.165, 24, 16), M.pants, body, 0, 0.47, 0); pelvis.scale.set(1, 0.72, 0.85);
  const heavy = C.build === 'heavy', fit = C.build === 'fit', buff = C.build === 'buff', obese = C.build === 'obese';
  if (heavy) pelvis.scale.set(1.32, 0.82, 1.18); else if (fit) pelvis.scale.set(0.9, 0.7, 0.8);
  else if (buff) pelvis.scale.set(0.98, 0.72, 0.82); else if (obese) pelvis.scale.set(1.92, 1.0, 1.56);
  const torso = new THREE.Group(); body.add(torso); torso.position.y = 0.47;
  const chest = mk(new THREE.CapsuleGeometry(0.168, 0.14, 8, 20), M.shirt, torso, 0, 0.19, 0); chest.scale.set(1, 1, 0.85);
  if (heavy) { chest.scale.set(1.34, 1.06, 1.22); const belly = mk(new THREE.SphereGeometry(0.2, 24, 16), M.shirt, torso, 0, 0.08, 0.06); belly.scale.set(1.12, 0.92, 1.05); }
  if (fit) { chest.scale.set(1.12, 1.06, 0.88); for (const s of [-1, 1]) mk(new THREE.SphereGeometry(0.082, 16, 12), M.shirt, torso, s * 0.175, 0.33, 0); }
  if (buff) {
    // a V: a broad chest and shoulders over a narrow waist; pecs, delts, traps; a thick neck in a crew collar
    chest.scale.set(1.0, 0.85, 0.8); chest.position.y = 0.12;
    const ch = mk(new THREE.SphereGeometry(0.2, 28, 18), M.shirt, torso, 0, 0.3, -0.005); ch.scale.set(1.42, 0.98, 0.9);
    for (const s of [-1, 1]) {
      const pec = mk(new THREE.SphereGeometry(0.095, 18, 12), M.shirt, torso, s * 0.088, 0.3, 0.112); pec.scale.set(1.18, 0.82, 0.62);
      mk(new THREE.SphereGeometry(0.094, 18, 12), M.shirt, torso, s * 0.268, 0.355, 0);
      const trap = mk(new THREE.SphereGeometry(0.085, 16, 10), M.shirt, torso, s * 0.12, 0.44, -0.035); trap.scale.set(1.55, 0.62, 0.95);
    }
    mk(new THREE.CylinderGeometry(0.084, 0.1, 0.2, 18), M.skin, torso, 0, 0.5, 0);
    const collar = mk(new THREE.TorusGeometry(0.098, 0.016, 8, 24), M.shirt, torso, 0, 0.455, 0.012); collar.rotation.x = Math.PI / 2 - 0.22;
  }
  if (obese) {
    // a gut the tee rides up over (skin below the hem, a navel), moobs, no neck
    chest.scale.set(1.62, 1.0, 1.25); chest.position.y = 0.24;
    const gut = mk(new THREE.SphereGeometry(0.3, 28, 20), M.skin, torso, 0, 0.02, 0.1); gut.scale.set(1.2, 1.04, 1.16);
    const hem = mk(new THREE.SphereGeometry(0.306, 28, 20, 0, Math.PI * 2, 0, Math.PI * 0.6), M.shirt, torso, 0, 0.02, 0.1); hem.scale.set(1.2, 1.04, 1.16);
    const navel = mk(new THREE.SphereGeometry(0.018, 8, 6), new THREE.MeshStandardMaterial({ color: 0x7a4436, roughness: 0.8 }), torso, 0, -0.18, 0.37); navel.scale.set(1, 1.4, 0.5); navel.castShadow = false;
    for (const s of [-1, 1]) {
      const moob = mk(new THREE.SphereGeometry(0.095, 16, 12), M.shirt, torso, s * 0.12, 0.26, 0.17); moob.scale.set(1.25, 1.05, 0.85);
      // pit stains, for when the arms go up
      const pit = new THREE.Mesh(new THREE.CircleGeometry(0.06, 18), new THREE.MeshStandardMaterial({ color: 0xa88a2e, roughness: 0.9, transparent: true, opacity: 0.6, polygonOffset: true, polygonOffsetFactor: -2 }));
      pit.position.set(s * 0.274, 0.29, 0); pit.rotation.y = s * Math.PI / 2; pit.scale.set(0.75, 1.25, 1); pit.castShadow = false; torso.add(pit);
    }
  }
  let print = null;
  if (C.print && (C.print.image || C.print.text)) {
    // the tee's print: the brand's logo on the lead's chest, the old way's name stretched across the gut
    const [pw, ph] = obese ? [0.42, 0.2] : [0.24, 0.15];
    const geo = new THREE.PlaneGeometry(pw, ph, 16, 2), pa = geo.attributes.position, bend = obese ? 1.55 : 0.9;
    for (let i = 0; i < pa.count; i++) pa.setZ(i, -bend * pa.getX(i) ** 2);
    geo.computeVertexNormals();
    print = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ map: printTex(C.print.image, C.print.text, C.print.ink, C.print.font), transparent: true, roughness: 0.8, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
    print.castShadow = false;
    if (obese) { print.position.set(0, 0.13, 0.437); print.rotation.x = -0.35; } else if (buff) print.position.set(0, 0.3, 0.181); else print.position.set(0, 0.23, 0.15);
    torso.add(print);
  }
  // a hoodie: a thick hood collar round the neck and two drawstrings
  if (C.hood) {
    const hood = mk(new THREE.TorusGeometry(heavy ? 0.17 : 0.15, 0.065, 10, 24), M.shirt, torso, 0, 0.4, -0.02); hood.rotation.x = Math.PI / 2 - 0.25; hood.scale.set(1.1, 1, 0.85);
    for (const s of [-1, 1]) { const d = mk(new THREE.CylinderGeometry(0.008, 0.008, 0.16, 6), M.white, torso, s * 0.045, 0.3, heavy ? 0.24 : 0.16); d.castShadow = false; }
  }
  // headphones resting round the neck
  if (C.headphones) {
    const hm = new THREE.MeshStandardMaterial({ color: 0x24262b, roughness: 0.35 });
    const band = mk(new THREE.TorusGeometry(0.19, 0.016, 6, 24, Math.PI), hm, torso, 0, 0.42, 0.02); band.rotation.set(Math.PI / 2 + 0.35, 0, 0);
    for (const s of [-1, 1]) { const cup = mk(new THREE.CylinderGeometry(0.062, 0.062, 0.045, 18), hm, torso, s * 0.19, 0.42, 0.06); cup.rotation.z = Math.PI / 2; const pad = mk(new THREE.TorusGeometry(0.05, 0.012, 6, 16), new THREE.MeshStandardMaterial({ color: C.accent ?? 0xd29922, roughness: 0.5 }), cup, 0, s * 0.024, 0); pad.rotation.x = Math.PI / 2; }
  }
  bone(torso, 0.3, 0.025, 0.2);
  for (let i = 0; i < 3; i++) { const rib = new THREE.Mesh(new THREE.TorusGeometry(0.1 - i * 0.01, 0.012, 6, 16, Math.PI), M.bone); rib.position.set(0, 0.32 - i * 0.06, 0.02); rib.rotation.set(Math.PI / 2, 0, 0); rib.visible = false; torso.add(rib); bones.push(rib); }

  // head
  const neck = new THREE.Group(); torso.add(neck); neck.position.y = buff ? 0.45 : 0.42;
  const head = new THREE.Group(); neck.add(head); head.position.y = buff ? 0.24 : 0.23;
  const chadFace = C.face === 'chad', chudFace = C.face === 'chud';
  // the skull's radii (x, y, z): a longer, leaner, sculpted head for the lead, a bloated one for the slob
  const SK = chadFace ? [0.25, 0.28, 0.26] : chudFace ? [0.297, 0.265, 0.281] : [0.27, 0.27, 0.27];
  const skull = chadFace ? mk(sculptedHead(SK), M.face, head, 0, 0, 0) : mk(new THREE.SphereGeometry(0.27, 32, 24), M.skin, head, 0, 0, 0);
  if (!chadFace) skull.scale.set(SK[0] / 0.27, SK[1] / 0.27, SK[2] / 0.27);
  // a point on the face: cast a ray at the skull from the front (features sit on the surface, sculpted or not)
  skull.updateMatrix(); const probe = new THREE.Mesh(skull.geometry, new THREE.MeshBasicMaterial()); probe.scale.copy(skull.scale); probe.updateMatrixWorld(true);
  const ray = new THREE.Raycaster(), RO = new THREE.Vector3(), RD = new THREE.Vector3(0, 0, -1);
  const onSkull = (x, y, lift = 0) => { ray.set(RO.set(x, y, 1), RD); const hit = ray.intersectObject(probe, false)[0]; return (hit ? hit.point.z : SK[2] * Math.sqrt(Math.max(0, 1 - (x / SK[0]) ** 2 - (y / SK[1]) ** 2))) + lift; };
  if (chadFace) head.scale.setScalar(0.87);   // heroic proportions: a smaller head on the big frame
  if (chudFace) head.scale.setScalar(0.93);  // a small head on a big body reads heavier
  // a strong jaw: a wider lower face (kept behind the mouth decal)
  if (C.jaw) { const jaw = mk(new THREE.SphereGeometry(0.2, 24, 16), M.skin, head, 0, -0.1, 0.0); jaw.scale.set(1.18, 0.86, 1.05); }
  if (chadFace) {
    // a straight nose with a bridge
    // a straight nose: one long narrow ridge from between the brows to the tip
    const nose = mk(new THREE.SphereGeometry(0.03, 16, 12), M.skin, head, 0, -0.022, onSkull(0, -0.022, -0.012)); nose.scale.set(0.72, 2.25, 1.05); nose.rotation.x = 0.3;
  } else if (chudFace) {
    // drooping jowls, a double chin and a second roll under it, a red bulb of a nose, a few pimples
    for (const s of [-1, 1]) { const j = mk(new THREE.SphereGeometry(0.135, 16, 12), M.flush, head, s * 0.17, -0.13, 0.11); j.scale.set(1, 0.95, 0.92); }
    const c1 = mk(new THREE.SphereGeometry(0.17, 20, 14), M.skin, head, 0, -0.25, 0.07); c1.scale.set(1.5, 0.66, 1.08);
    const c2 = mk(new THREE.SphereGeometry(0.16, 20, 14), M.skin, head, 0, -0.33, 0.02); c2.scale.set(1.72, 0.55, 1.15);
    mk(new THREE.SphereGeometry(0.048, 14, 10), M.nose, head, 0, -0.03, onSkull(0, -0.03, 0.004));
    const zit = new THREE.MeshStandardMaterial({ color: 0xc8463f, roughness: 0.45 });
    for (const [x, y] of [[0.115, 0.17], [-0.16, 0.12], [0.2, 0.06], [-0.05, 0.2]]) mk(new THREE.SphereGeometry(0.012, 8, 6), zit, head, x, y, onSkull(x, y, 0.002)).castShadow = false;
  } else mk(new THREE.SphereGeometry(0.036, 12, 10), M.skin, head, 0, -0.035, 0.27);
  for (const s of [-1, 1]) { const ear = mk(new THREE.SphereGeometry(0.055, 12, 10), M.skin, head, s * (SK[0] - 0.008), -0.01, 0); ear.scale.set(0.55, 1, 0.9); }
  const xskull = mk(new THREE.SphereGeometry(0.2, 20, 14), M.bone, head, 0, 0.02, 0); xskull.visible = false; bones.push(xskull);
  // eyes: white + pupil + glint + lid (a skin-colored cap that rotates down) + an fx decal (spiral / X)
  const eyes = [], E = eyeFx();
  // eye shapes: the toon's big round eyes; 'hunter' (narrow, hooded, deep-set, the outer corners tilted up, a coloured
  // iris under a low upper lid and a lower lid); 'beady' (small, close-set, puffy bags under them)
  const hunter = C.eyeShape === 'hunter', beady = C.eyeShape === 'beady';
  const ES = hunter ? { x: 0.094, y: 0.03, w: 0.78, h: 0.42, tilt: 0.12, p: 0.95, sink: 0.03, lz: 0.8 }
    : beady ? { x: 0.088, y: 0.062, w: 0.5, h: 0.55, tilt: -0.05, p: 0.55, sink: 0.016, lz: 0.62 }
    : { x: 0.1, y: 0.045, w: 0.9, h: 1.12, tilt: 0, p: 1, sink: 0.019, lz: 0.62 };
  const BY = hunter ? 0.108 : beady ? 0.15 : 0.165, bw = C.browW ?? 1;
  for (const s of [-1, 1]) {
    const eg = new THREE.Group(); head.add(eg); eg.position.set(s * ES.x, ES.y, onSkull(ES.x, ES.y) - ES.sink); eg.rotation.set(-0.14, s * 0.38, s * ES.tilt);
    const white = mk(new THREE.SphereGeometry(0.085, 24, 16), M.white, eg); white.scale.set(ES.w, ES.h, 0.55); white.castShadow = false;
    const pg = new THREE.Group(); eg.add(pg);
    const pupil = mk(new THREE.SphereGeometry(0.043, 16, 12), hunter ? M.iris : M.pupil, pg, 0, 0, 0.034); pupil.scale.set(ES.p, 1.1 * ES.p, 0.55); pupil.castShadow = false;
    if (hunter) { const dot = mk(new THREE.SphereGeometry(0.019, 12, 8), M.pupil, pg, 0, 0, 0.053); dot.scale.set(1, 1.1, 0.5); dot.castShadow = false; }
    const glint = mk(new THREE.SphereGeometry(hunter ? 0.009 : 0.012, 8, 6), M.white, pg, hunter ? 0.012 : 0.014, hunter ? -0.002 : 0.018, 0.058); glint.castShadow = false;
    // hunter eyes: the hooded upper lid is a shade darker than the skin, with a fine dark line at its edge
    const lid = mk(new THREE.SphereGeometry(0.088, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2), hunter ? M.lid : M.skin, eg); lid.scale.set(ES.w + 0.05, ES.h + 0.04, ES.lz); lid.castShadow = false;
    if (hunter) { const lash = new THREE.Mesh(new THREE.TorusGeometry(0.088, 0.0035, 6, 28, Math.PI), M.lash); lash.rotation.x = Math.PI / 2; lash.castShadow = false; lid.add(lash); }
    if (C.bags) { const bag = mk(new THREE.TorusGeometry(0.046, 0.012, 6, 16, Math.PI), new THREE.MeshStandardMaterial({ color: new THREE.Color(C.skin).lerp(new THREE.Color(0x6a4a66), 0.45), roughness: 0.7 }), eg, 0, -0.052, 0.012); bag.rotation.z = Math.PI; bag.scale.set(1, 0.6, 1); bag.castShadow = false; }
    const fx = new THREE.Mesh(new THREE.CircleGeometry(0.07, 24), new THREE.MeshBasicMaterial({ map: E.spiral, transparent: true })); fx.position.z = 0.05; fx.visible = false; eg.add(fx);
    const bx = hunter ? 0.098 : 0.1;
    const brow = mk(new THREE.CapsuleGeometry(0.017 * bw, 0.075 * bw, 4, 8), M.hair, head, s * bx, BY, hunter ? onSkull(bx, BY, 0.016) : beady ? onSkull(bx, BY, 0.02) : 0.226);
    brow.rotation.set(0, s * (hunter ? 0.34 : beady ? 0.12 : 0), Math.PI / 2); brow.castShadow = false;
    if (hunter) brow.scale.set(1.0, 1.06, 0.55);   // thick but flat to the brow ridge
    eyes.push({ s, eg, white, pg, pupil, lid, fx, brow });
  }
  // mouth decal (follows the sphere's tilt below center)
  const MT = mouthTextures();
  const mouth = new THREE.Mesh(new THREE.PlaneGeometry(0.17, 0.128), new THREE.MeshStandardMaterial({ map: MT.smile, transparent: true, roughness: 0.6 }));
  if (chadFace) { mouth.position.set(0, -0.175, onSkull(0, -0.175, 0.008)); mouth.rotation.x = -0.16; mouth.scale.setScalar(0.85); }
  else if (chudFace) { mouth.position.set(0, -0.118, onSkull(0, -0.118, 0.012)); mouth.rotation.x = -0.42; }
  else { mouth.position.set(0, -0.112, 0.248); mouth.rotation.x = -0.42; }
  head.add(mouth);
  // glasses: round (the geek) or square frames, a bridge and arms back to the ears (tape: mended at the bridge)
  if (C.glasses) {
    const gm = new THREE.MeshStandardMaterial({ color: C.glassesColor ?? 0x17181c, roughness: 0.3, metalness: 0.2 });
    const lensM = new THREE.MeshStandardMaterial({ color: C.tape ? 0xe8efd8 : 0xdfefff, roughness: 0.05, transparent: true, opacity: C.tape ? 0.24 : 0.16, depthWrite: false });
    const go = chudFace ? [0, 0.014, 0.016] : [0, 0, 0];
    for (const s of [-1, 1]) {
      const rim = C.glasses === 'square' ? new THREE.TorusGeometry(0.094, 0.013, 6, 4) : new THREE.TorusGeometry(0.088, 0.011, 8, 28);
      const f = mk(rim, gm, head, s * 0.105, 0.05 + go[1], 0.3 + go[2]); f.rotation.set(0, s * 0.28, C.glasses === 'square' ? Math.PI / 4 : 0); f.castShadow = false;
      const lens = new THREE.Mesh(new THREE.CircleGeometry(C.glasses === 'square' ? 0.086 : 0.082, 24), lensM); lens.position.set(s * 0.105, 0.05 + go[1], 0.298 + go[2]); lens.rotation.y = s * 0.28; head.add(lens);
      // the arm runs from the rim's outer edge back to the ear
      const ax0 = 0.105 + 0.088, az0 = 0.29 + go[2], ax1 = SK[0] * 0.93, az1 = -0.03, alen = Math.hypot(ax1 - ax0, az1 - az0);
      const arm = mk(new THREE.BoxGeometry(0.012, 0.012, alen), gm, head, s * (ax0 + ax1) / 2, 0.055 + go[1], (az0 + az1) / 2); arm.rotation.y = s * Math.atan2(ax1 - ax0, az0 - az1) * -1; arm.castShadow = false;
    }
    const bridge = mk(new THREE.BoxGeometry(0.04, 0.012, 0.012), gm, head, 0, 0.07 + go[1], 0.315 + go[2]); bridge.castShadow = false;
    if (C.tape) { const tp = mk(new RoundedBoxGeometry(0.062, 0.05, 0.034, 2, 0.008), new THREE.MeshStandardMaterial({ color: 0xf1ead2, roughness: 0.9 }), head, 0, 0.07 + go[1], 0.314 + go[2]); tp.rotation.z = 0.18; tp.castShadow = false; }
  }
  // hair
  const hair = new THREE.Group(); head.add(hair); const spikes = [];
  if (C.hairStyle === 'tuft' || C.hairStyle === 'messy') {
    const cap = mk(new THREE.SphereGeometry(0.276, 28, 16, 0, Math.PI * 2, 0, Math.PI * 0.36), M.hair, hair, 0, 0.004, -0.008); cap.rotation.x = -0.25;
    const n = C.hairStyle === 'messy' ? 11 : 6;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2, rr = 0.07 + (i % 3) * 0.03;
      const sp = mk(new THREE.ConeGeometry(0.06, 0.16, 8), M.hair, hair, Math.cos(a) * rr, 0.26, Math.sin(a) * rr * 0.8 + 0.02);
      sp.rotation.set(Math.sin(a) * 0.5 - 0.15, 0, -Math.cos(a) * 0.5); spikes.push(sp);
    }
  } else if (C.hairStyle === 'mop') {
    // a shaggy mop: a cap and soft clumps over the top, the sides and a fringe that stops above the brows
    const cap = mk(new THREE.SphereGeometry(0.285, 28, 16, 0, Math.PI * 2, 0, Math.PI * 0.42), M.hair, hair, 0, 0.0, -0.01); cap.rotation.x = -0.2;
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2, ring = i % 3, r = 0.2 + ring * 0.03;
      const c = mk(new THREE.SphereGeometry(0.1 + (i % 2) * 0.02, 12, 10), M.hair, hair, Math.cos(a) * r, 0.2 - ring * 0.02, Math.sin(a) * r * 0.9 - 0.02);
      c.scale.set(1, 0.7, 1);
    }
    for (let i = 0; i < 5; i++) { const c = mk(new THREE.SphereGeometry(0.075, 12, 10), M.hair, hair, -0.14 + i * 0.07, 0.205, 0.19); c.scale.set(1, 0.75, 0.7); }
  } else if (C.hairStyle === 'quiff') {
    // short sides and a swept-up quiff at the front
    const cap = mk(new THREE.SphereGeometry(0.279, 28, 16, 0, Math.PI * 2, 0, Math.PI * 0.4), M.hair, hair, 0, 0.0, -0.01); cap.rotation.x = -0.24;
    const quiff = mk(new THREE.SphereGeometry(0.17, 20, 14), M.hair, hair, 0.03, 0.25, 0.08); quiff.scale.set(1.25, 0.62, 1.0); quiff.rotation.set(-0.45, 0, -0.12);
    const sweep = mk(new THREE.SphereGeometry(0.12, 16, 12), M.hair, hair, 0.1, 0.29, 0.13); sweep.scale.set(1.2, 0.55, 0.9); sweep.rotation.set(-0.7, 0, -0.35);
  } else if (C.hairStyle === 'side') {
    const cap = mk(new THREE.SphereGeometry(0.28, 28, 16, 0, Math.PI * 2, 0, Math.PI * 0.42), M.hair, hair, 0, 0.005, -0.012); cap.rotation.set(-0.2, 0, 0.12);
  } else if (C.hairStyle === 'wolf' || C.hairStyle === 'balding') {
    // points on (and the outward direction of) the scalp: th from the crown (0) down, ph round from the front (+x at PI/2)
    const at = (th, ph, k = 0.96) => [SK[0] * Math.sin(th) * Math.sin(ph) * k, SK[1] * Math.cos(th) * k, SK[2] * Math.sin(th) * Math.cos(ph) * k];
    const out = (th, ph) => [Math.sin(th) * Math.sin(ph), Math.cos(th), Math.sin(th) * Math.cos(ph)];
    const PI = Math.PI;
    if (C.hairStyle === 'wolf') {
      // a wolf cut: a shaggy mop of layers that fall from the crown (fuller on top, flicking out at the ends), curtain
      // bangs parted in the middle that sweep to the temples, layers over the ears, a longer mane down to the nape.
      // Clumps alternate two shades so the layers read.
      const cap = mk(new THREE.SphereGeometry(0.27, 28, 16, 0, PI * 2, 0, PI * 0.47), M.hair, hair, 0, 0.01, -0.016); cap.scale.set((SK[0] + 0.016) / 0.27, (SK[1] + 0.02) / 0.27, (SK[2] + 0.016) / 0.27); cap.rotation.x = -0.32;
      // a clump that starts at (th, ph) and falls down the head's slope: lift pushes it off the scalp, droop pulls it down, splay turns it sideways
      const fall = (th, ph, len, r, lift, droop, splay = 0, m = M.hair, sharp = 1) => {
        const o = out(th, ph), tg = [Math.cos(th) * Math.sin(ph), -Math.sin(th), Math.cos(th) * Math.cos(ph)], sd = [Math.cos(ph), 0, -Math.sin(ph)];
        return addLock(hair, m, at(th, ph, 0.94), [tg[0] + lift * o[0] + splay * sd[0], tg[1] + lift * o[1] - droop + splay * sd[1], tg[2] + lift * o[2] + splay * sd[2]], len, r, 0.7, sharp);
      };
      let hs = 3; const hr = () => ((hs = (hs * 16807) % 2147483647) / 2147483647);
      // a messy, textured top: tapered pieces standing up and back off the crown, each a little different
      for (let i = 0; i < 26; i++) { const ph = (i / 26) * PI * 2 + hr() * 0.25, th = (0.05 + hr() * 0.2) * PI; fall(th, ph, 0.16 + hr() * 0.08, 0.04 + hr() * 0.016, 0.3 + hr() * 0.35, 0.05, (hr() - 0.5) * 0.7, i % 2 ? M.hair2 : M.hair, 1.1); }
      // a few pieces fall onto the forehead, off-centre, stopping above the brows
      for (const [ph, len, sp] of [[-0.32, 0.14, -0.55], [0.04, 0.12, 0.2], [0.3, 0.15, 0.6], [0.55, 0.16, 0.5]]) fall(0.12 * PI, ph, len, 0.04, 0.15, 0.8, sp, ph > 0 ? M.hair2 : M.hair, 1.2);
      // short shaggy layers over the ears, flicking out
      for (const s of [-1, 1]) for (const [ph, th, len] of [[1.05, 0.37, 0.15], [1.3, 0.4, 0.17], [1.55, 0.42, 0.18], [1.8, 0.44, 0.19]]) fall(th * PI, s * ph, len, 0.045, 0.55, 0.15, 0, ph > 1.3 ? M.hair : M.hair2, 1.2);
      // the mane: longer layers down the back to the nape (the cut's signature)
      for (let i = 0; i < 11; i++) { const ph = PI + (i - 5) * 0.23; fall((0.5 + (i % 2) * 0.07) * PI, ph, 0.25 + (i % 3) * 0.04, 0.056, 0.3, 0.25, 0, i % 2 ? M.hair2 : M.hair, 1.2); }
    } else {
      // balding: a shiny bare crown under a greasy comb-over, stringy hair hanging round the sides and the back
      for (let i = 0; i < 5; i++) {
        const dz = 0.13 - i * 0.055, k = Math.sqrt(Math.max(0.2, 1 - (dz / SK[2]) ** 2));
        const strand = mk(new THREE.TorusGeometry(1, 0.045, 6, 28, 1.75), M.hair, hair, 0, -0.004, dz); strand.scale.set((SK[0] + 0.006) * k, (SK[1] + 0.006) * k, 0.3); strand.rotation.z = PI / 2 - 0.875 + 0.3; strand.castShadow = false;
      }
      for (let i = 0; i < 15; i++) { const ph = PI + (i - 7) * 0.25, th = 0.47 * PI; addLock(hair, M.hair, at(th, ph, 0.98), [Math.sin(ph) * 0.2, -1, Math.cos(ph) * 0.2], 0.3 + (i % 3) * 0.05, 0.036, 0.6); }
    }
  }
  if (C.mustache) for (const s of [-1, 1]) { const m = mk(new THREE.CapsuleGeometry(0.022, 0.06, 4, 8), M.hair, head, s * 0.04, -0.07, 0.262); m.rotation.z = s * 1.25; }
  // hats
  const hat = new THREE.Group(); head.add(hat);
  if (C.hat === 'hardhat') {
    const dome = mk(new THREE.SphereGeometry(0.29, 28, 14, 0, Math.PI * 2, 0, Math.PI / 2), M.hat, hat, 0, 0.06, 0); dome.scale.y = 0.86;
    mk(new THREE.CylinderGeometry(0.335, 0.34, 0.03, 32), M.hat, hat, 0, 0.065, 0.03);
    mk(new THREE.BoxGeometry(0.04, 0.05, 0.5), M.hat, hat, 0, 0.29, 0).scale.set(1, 1, 1);
  } else if (C.hat === 'chef') {
    const wm = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.8 });
    mk(new THREE.CylinderGeometry(0.2, 0.21, 0.22, 24), wm, hat, 0, 0.29, -0.02);
    for (const [x, z] of [[0, 0], [0.09, 0.05], [-0.09, 0.05], [0, -0.09]]) mk(new THREE.SphereGeometry(0.14, 16, 12), wm, hat, x, 0.43, z - 0.02);
  } else if (C.hat === 'cap') {
    const d = mk(new THREE.SphereGeometry(0.28, 28, 14, 0, Math.PI * 2, 0, Math.PI / 2), M.hat, hat, 0, 0.04, 0); d.scale.y = 0.6;
    const v = mk(new THREE.CylinderGeometry(0.17, 0.17, 0.02, 24, 1, false, -Math.PI / 2, Math.PI), M.hat, hat, 0, 0.05, 0.22); v.scale.z = 1.3;
  }
  // beard: a chin puff + a long cone that grows to the floor
  const beard = new THREE.Group(); head.add(beard); beard.position.set(0, -0.17, 0.13);
  const chin = mk(new THREE.SphereGeometry(0.15, 16, 12), M.beard, beard, 0, 0, 0); chin.scale.set(1.25, 0.9, 0.75);
  const long = new THREE.Group(); beard.add(long);
  for (let i = 0; i < 16; i++) { const r = 0.16 * (1 - i / 22); const b = mk(new THREE.SphereGeometry(r, 14, 10), M.beard, long, Math.sin(i * 1.7) * 0.03, -(i + 0.5) / 16, 0.02 + Math.cos(i * 1.3) * 0.015); b.scale.set(1.15, 1.5, 0.8); }
  if (C.neckbeard) {
    // a patchy neckbeard: scruffy tufts under the chins and along the jaw, bare cheeks
    let sd = 5; const rr = () => ((sd = (sd * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 34; i++) {
      const a = -1.35 + rr() * 2.7, lo = rr();
      const t = mk(new THREE.SphereGeometry(0.018 + rr() * 0.016, 8, 6), M.beard, head, Math.sin(a) * (0.2 + lo * 0.05), -0.3 - lo * 0.07 + Math.abs(a) * 0.06, 0.04 + Math.cos(a) * (0.17 - lo * 0.03));
      t.scale.set(1, 0.7 + rr() * 0.6, 1); t.castShadow = false;
    }
  }

  // arms + legs (the lifter's and the slob's arms are bare under short sleeves)
  const LP = buff ? { ax: 0.3, ay: 0.335, ur: 0.086, el: 0.21, fr: 0.066, hr: 0.064, hx: 0.098, tr: 0.08, sr: 0.066, sleeve: true }
    : obese ? { ax: 0.335, ay: 0.29, ur: 0.088, el: 0.19, fr: 0.074, hr: 0.076, hx: 0.14, tr: 0.112, sr: 0.096, sleeve: true }
    : { ax: heavy ? 0.235 : fit ? 0.205 : 0.19, ay: 0.32, ur: 0.054, el: 0.18, fr: 0.046, hr: 0.066, hx: heavy ? 0.105 : 0.085, tr: 0.064, sr: 0.058, sleeve: false };
  const limb = (side, isArm) => {
    const g = new THREE.Group(); torso.add(g);
    if (isArm) {
      g.position.set(side * LP.ax, LP.ay, 0);
      mk(new THREE.CapsuleGeometry(LP.ur, 0.1, 4, 10), LP.sleeve ? M.skin : M.shirt, g, 0, -0.08, 0);
      if (LP.sleeve) mk(new THREE.CylinderGeometry(LP.ur + 0.02, LP.ur + 0.016, 0.1, 16), M.shirt, g, 0, -0.025, 0);
      if (buff) { const bi = mk(new THREE.SphereGeometry(0.064, 14, 10), M.skin, g, 0, -0.115, 0.036); bi.scale.set(1, 1.25, 1); const tri = mk(new THREE.SphereGeometry(0.058, 14, 10), M.skin, g, 0, -0.1, -0.03); tri.scale.set(1, 1.3, 1); }
      bone(g, 0.16, 0.014, -0.09);
      const el = new THREE.Group(); g.add(el); el.position.y = -LP.el;
      mk(new THREE.CapsuleGeometry(LP.fr, 0.1, 4, 10), M.skin, el, 0, -0.08, 0);
      bone(el, 0.12, 0.012, -0.08);
      const hand = new THREE.Group(); el.add(hand); hand.position.y = -(LP.el + 0.01);
      mk(new THREE.SphereGeometry(LP.hr, 14, 10), M.skin, hand, 0, 0, 0).scale.set(1, 1.05, 0.85);
      mk(new THREE.SphereGeometry(0.03, 8, 6), M.skin, hand, -side * 0.05, 0.03, 0.03);
      return { g, el, hand };
    }
    const hip = new THREE.Group(); body.add(hip); hip.position.set(side * LP.hx, 0.42, 0);
    mk(new THREE.CapsuleGeometry(LP.tr, 0.1, 4, 10), M.pants, hip, 0, -0.1, 0);
    bone(hip, 0.16, 0.016, -0.1);
    const kn = new THREE.Group(); hip.add(kn); kn.position.y = -0.2;
    mk(new THREE.CapsuleGeometry(LP.sr, 0.09, 4, 10), M.pants, kn, 0, -0.08, 0);
    bone(kn, 0.14, 0.014, -0.08);
    mk(obese ? new RoundedBoxGeometry(0.16, 0.1, 0.235, 3, 0.048) : new RoundedBoxGeometry(0.13, 0.085, 0.215, 3, 0.035), M.shoes, kn, 0, -0.175, 0.035);
    return { g: hip, el: kn };
  };
  const armL = limb(-1, true), armR = limb(1, true), legL = limb(-1, false), legR = limb(1, false);
  if (C.watch) { const w = mk(new THREE.CylinderGeometry(0.052, 0.052, 0.035, 18), new THREE.MeshStandardMaterial({ color: 0xc9ced6, roughness: 0.2, metalness: 0.8 }), armL.el, 0, -0.15, 0); w.castShadow = false; }
  // sweat that beads on the forehead and runs down, and flies circling the head
  const drops = [], flies = [];
  if (C.sweat) {
    const dm = new THREE.MeshStandardMaterial({ color: 0xc4e8ff, roughness: 0.05, metalness: 0.1, transparent: true, opacity: 0.85 });
    for (const [x, y, ph] of [[0.12, 0.17, 0], [-0.19, 0.1, 0.62], [0.22, 0.03, 1.21]]) { const d = mk(new THREE.SphereGeometry(0.016, 10, 8), dm, head, x, y, onSkull(x, y, 0.008)); d.scale.set(1, 1.45, 0.8); d.castShadow = false; drops.push({ d, x, y, ph }); }
  }
  if (C.flies) {
    const fm = new THREE.MeshStandardMaterial({ color: 0x141518, roughness: 0.35 }), wm = new THREE.MeshBasicMaterial({ color: 0xe6eeff, transparent: true, opacity: 0.6, side: THREE.DoubleSide, depthWrite: false });
    for (let k = 0; k < 3; k++) {
      const f = new THREE.Group(); root.add(f);
      const fb = mk(new THREE.SphereGeometry(0.016, 8, 6), fm, f, 0, 0, 0); fb.scale.set(1, 0.8, 1.5); fb.castShadow = false;
      const wings = [-1, 1].map((s) => { const w = new THREE.Mesh(new THREE.CircleGeometry(0.016, 10), wm); w.scale.set(0.6, 1.4, 1); w.position.set(s * 0.013, 0.012, -0.004); f.add(w); return w; });
      flies.push({ f, wings, k });
    }
  }
  root.traverse((m) => { if (m.isMesh && m.material === M.bone) m.castShadow = false; });

  let mouthKey = 'smile';
  function set(p = {}) {
    const s = (p.scale ?? 1) * (C.height ?? 1);
    root.position.set(p.x ?? 0, p.y ?? 0, p.z ?? 0); root.rotation.y = p.rotY ?? 0; root.scale.setScalar(s);
    const [sx, sy] = p.squash || [1, 1]; body.scale.set(sx, sy, sx);
    pivot.rotation.set(p.rx ?? 0, 0, p.rz ?? 0);
    const wk = p.walk, wa = p.walkAmt ?? 1;
    const swing = wk === undefined || wk === null ? 0 : Math.sin(wk) * wa;
    body.position.y = -0.62 + (wk == null ? 0 : Math.abs(Math.cos(wk)) * 0.03 * wa);
    torso.rotation.set((p.lean ?? 0.03), 0, wk == null ? 0 : Math.sin(wk) * 0.05 * wa);
    const A = (arm, q, side) => { arm.g.rotation.set(q.x ?? 0, q.y ?? 0, side * ((q.z ?? 0.12) + (C.armOut ?? 0))); arm.el.rotation.set(-(q.el ?? 0.15), 0, 0); };
    A(armL, { x: wk == null ? 0 : swing * 0.55, ...p.armL }, -1); A(armR, { x: wk == null ? 0 : -swing * 0.55, ...p.armR }, 1);
    const Lg = (leg, q) => { leg.g.rotation.set(q.x ?? 0, 0, q.z ?? 0); leg.el.rotation.set(q.kn ?? 0, 0, 0); };
    const kneeL = wk == null ? 0 : Math.max(0, Math.sin(wk + Math.PI / 2)) * 0.7 * wa, kneeR = wk == null ? 0 : Math.max(0, Math.sin(wk - Math.PI / 2)) * 0.7 * wa;
    Lg(legL, { x: -swing * 0.6, kn: kneeL, ...p.legL }); Lg(legR, { x: swing * 0.6, kn: kneeR, ...p.legR });
    const hd = p.head || {}; head.rotation.set(hd.x ?? 0, hd.y ?? 0, hd.z ?? 0);
    // eyes
    const ek = p.eyes || 'open', [lx, ly] = p.look || [0, 0];
    for (const e of eyes) {
      const wide = ek === 'wide' ? 1.22 : 1;
      e.white.scale.set(ES.w * wide, ES.h * wide, 0.55); e.lid.scale.set((ES.w + 0.05) * wide, (ES.h + 0.04) * wide, ES.lz);
      e.pg.position.set(clamp(lx, -1, 1) * 0.03, clamp(ly, -1, 1) * 0.035 * Math.min(1, ES.h), 0); e.pg.scale.setScalar(ek === 'wide' ? 0.88 : 1); // wide = big whites + a still-readable pupil (0.72 read as blank discs)
      e.lid.rotation.x = ek === 'closed' ? 1.62 : (LIDS[ek] ?? LIDS.open);   // cool (Nomen): lids a little low, a confident look
      const fx = ek === 'spiral' || ek === 'x'; e.fx.visible = fx; e.pg.visible = !fx;
      if (fx) { e.fx.material.map = EYEFX[ek]; e.fx.rotation.z = ek === 'spiral' ? (p.t ?? 0) * -9 * e.s : 0; }
      const b = p.brows ?? 0; e.brow.rotation.z = Math.PI / 2 + e.s * b * 0.45; e.brow.position.y = BY + Math.abs(b) * 0.012 + (ek === 'wide' ? 0.025 : 0);
    }
    const mk2 = p.mouth || 'smile'; if (mk2 !== mouthKey) { mouth.material.map = MT[mk2] || MT.smile; mouth.material.needsUpdate = true; mouthKey = mk2; }
    // beard / gray / hair up
    const bd = p.beard ?? 0; beard.visible = bd > 0.001; chin.scale.set(1.25 * Math.min(1, bd * 4), 0.9 * Math.min(1, bd * 4), 0.75);
    const L = Math.max(0.001, bd * 1.25); long.scale.set(1, L, 1); long.position.y = 0; long.visible = bd > 0.12;
    const gray = p.gray ?? 0; M.hair.color.copy(base.hair).lerp(new THREE.Color(0xe8e8e8), gray);
    const up = p.hairUp ?? 0, lift = p.hatLift ?? 0; // zap / wind: spikes stand up; a hat hides them unless it's knocked off
    const hatOn = !!C.hat && lift < 0.25;
    for (const sp of spikes) { sp.visible = !hatOn; sp.scale.set(1, 1 + up * 1.6, 1); sp.position.y = 0.26 + up * 0.08; }
    if (!spikes.length) { hair.scale.set(1, 1 + up * 0.5, 1); hair.position.y = up * 0.04; }
    // a hard hat sits high + tipped back so the brim never hides the eyes (v2 review: the face stopped acting under it)
    const hb = C.hat === 'hardhat' ? [0.075, -0.035, -0.3] : [0, 0, 0];
    hat.position.set(0, hb[0] + lift * 0.55, hb[1] - lift * 0.15); hat.rotation.set(hb[2] - lift * 0.9, 0, lift * 0.5); hat.visible = !p.noHat;
    // x-ray zap + char
    const xr = !!p.xray, ch = p.char ?? 0, [tc, ta] = p.tint || [0, 0], [fc, fa] = p.faceTint || [0, 0], [gc, ga] = p.glow || [0, 0]; // glow: emissive [color, intensity] (a character that IS the light)
    for (const b of bones) b.visible = xr;
    M.hair2.color.copy(base.hair2).lerp(new THREE.Color(0xe8e8e8), gray);
    for (const k of ['skin', 'shirt', 'pants', 'shoes', 'hair', 'hair2', 'hat', 'stubble', 'flush', 'face', 'nose']) {
      const m = M[k];
      if ((k !== 'hair' && k !== 'hair2') || gray === 0) m.color.copy(base[k]);
      if (ch > 0) m.color.lerp(new THREE.Color(0x2a2522), ch * 0.9);
      if (ta > 0) m.color.lerp(new THREE.Color(tc), ta);
      if (fa > 0 && (k === 'skin' || k === 'stubble' || k === 'flush' || k === 'face' || k === 'nose')) m.color.lerp(new THREE.Color(fc), fa);
      m.transparent = xr; m.opacity = xr ? 0.3 : 1; m.depthWrite = !xr; m.emissive.setHex(ga > 0 ? gc : 0); m.emissiveIntensity = ga;
      if (xr) m.color.set(0x7fb4ff);
    }
    for (const e of eyes) { e.white.visible = !xr; e.pg.visible = e.pg.visible && !xr; }
    mouth.visible = !xr;
    if (print) print.visible = !xr;
    // sweat runs down and beads again; flies loop round the head
    const tt = p.t ?? 0;
    for (const d of drops) { const u = ((tt + d.ph) % 1.85) / 1.85, y = d.y - 0.14 * u * u; d.d.position.set(d.x * (1 + 0.08 * u), y, onSkull(d.x, y, 0.008)); d.d.visible = !xr && u < 0.88; }
    for (const f of flies) {
      const k = f.k, a = tt * (2.3 + k * 0.55) + k * 2.1;
      f.f.position.set(Math.sin(a) * (0.36 + 0.07 * k), 1.36 + 0.1 * Math.sin(tt * 3.3 + k * 1.7), Math.cos(a * 0.83) * 0.32 + 0.06);
      f.f.rotation.y = a + Math.PI / 2; f.f.visible = !xr;
      const fl = 0.45 + 0.55 * Math.abs(Math.sin(tt * 53 + k * 1.3)); f.wings.forEach((w, i) => (w.rotation.y = (i ? 1 : -1) * fl));
    }
  }
  const LIDS = hunter ? { open: -0.3, cool: -0.14, half: 0.2, wide: -0.75, fx: -1.15 } : beady ? { open: -0.22, cool: 0.1, half: 0.38, wide: -0.95, fx: -0.95 } : { open: -0.95, half: 0.55, cool: 0.12, wide: -0.95, fx: -0.95 };
  LIDS.spiral = LIDS.fx; LIDS.x = LIDS.fx;
  set({});
  return { root, set, armL, armR, legL, legR, head, hat, M, hand: (side) => (side < 0 ? armL.hand : armR.hand) };
}

// ---------------------------------------------------------------- critters
/** Cool-guy sunglasses (two dark lenses + a bridge), facing +z. r = lens radius, dx = half the lens spacing. */
export function makeShades(r = 0.035, dx = 0.045) {
  const g = new THREE.Group(), m = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.15, metalness: 0.4 });
  for (const s of [-1, 1]) mk(new THREE.CircleGeometry(r, 16), m, g, s * dx, 0, 0).scale.set(1.15, 0.85, 1);
  mk(new THREE.BoxGeometry(dx * 0.9, r * 0.25, r * 0.25), m, g, 0, r * 0.2, -0.002);
  g.visible = false; return g;
}
/** Toon raccoon (~0.55 m on all fours). set({x,y,z,rotY, stand 0..1, wave 0..1, t, eyes, look}) */
export function makeRaccoon() {
  const fur = new THREE.MeshStandardMaterial({ color: 0x8b8f96, roughness: 0.9 }), light = new THREE.MeshStandardMaterial({ color: 0xe9e6df, roughness: 0.9 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x2b2b2e, roughness: 0.8 }), white = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.25 });
  const root = new THREE.Group(), body = new THREE.Group(); root.add(body);
  const torso = mk(new THREE.SphereGeometry(0.2, 20, 14), fur, body, 0, 0.24, 0); torso.scale.set(0.9, 0.85, 1.25);
  mk(new THREE.SphereGeometry(0.14, 16, 12), light, body, 0, 0.2, 0.1).scale.set(0.8, 0.7, 1);
  const head = new THREE.Group(); body.add(head); head.position.set(0, 0.4, 0.2);
  mk(new THREE.SphereGeometry(0.15, 20, 16), fur, head).scale.set(1.15, 0.95, 1);
  const snout = mk(new THREE.SphereGeometry(0.08, 14, 10), light, head, 0, -0.04, 0.12); snout.scale.set(1, 0.8, 1.1);
  mk(new THREE.SphereGeometry(0.028, 10, 8), dark, head, 0, -0.02, 0.21);
  const mask = mk(new THREE.SphereGeometry(0.152, 20, 12, -0.9, 1.8, 1.1, 0.55), dark, head, 0, 0.0, 0.0); mask.scale.set(1.16, 1, 1.03); mask.rotation.y = 0;
  const eyes = [];
  for (const s of [-1, 1]) {
    const e = mk(new THREE.SphereGeometry(0.042, 12, 10), white, head, s * 0.06, 0.02, 0.125); e.scale.z = 0.6;
    const p = mk(new THREE.SphereGeometry(0.022, 10, 8), dark, head, s * 0.06, 0.02, 0.152); eyes.push(p);
    const ear = mk(new THREE.ConeGeometry(0.05, 0.09, 10), fur, head, s * 0.1, 0.14, -0.02); ear.rotation.z = -s * 0.35;
  }
  const tail = new THREE.Group(); body.add(tail); tail.position.set(0, 0.24, -0.24);
  for (let i = 0; i < 6; i++) { const r = 0.07 - i * 0.004; mk(new THREE.SphereGeometry(r, 12, 10), i % 2 ? dark : fur, tail, 0, i * 0.03, -i * 0.07); }
  const legs = [];
  for (const [x, z] of [[-0.09, 0.14], [0.09, 0.14], [-0.09, -0.12], [0.09, -0.12]]) { const l = mk(new THREE.CapsuleGeometry(0.035, 0.1, 4, 8), dark, body, x, 0.08, z); legs.push(l); }
  const shades = makeShades(0.042, 0.06); head.add(shades); shades.position.set(0, 0.025, 0.158);
  function set(p = {}) {
    root.position.set(p.x ?? 0, p.y ?? 0, p.z ?? 0); root.rotation.y = p.rotY ?? 0; root.scale.setScalar(p.scale ?? 1);
    const st = p.stand ?? 0, t = p.t ?? 0; shades.visible = !!p.shades;
    body.rotation.x = -st * 1.15; body.position.set(0, st * 0.12, -st * 0.12);
    head.rotation.set(st * 1.0 + (p.nod ?? 0), p.headY ?? 0, Math.sin(t * 2) * 0.05);
    legs[0].rotation.x = legs[1].rotation.x = st * 0.4;
    legs[1].rotation.z = (p.wave ?? 0) * (1.6 + Math.sin(t * 14) * 0.4); legs[1].position.y = 0.08 + (p.wave ?? 0) * 0.1;
    tail.rotation.set(0.3 + Math.sin(t * 3) * 0.15, Math.sin(t * 2.3) * 0.35, 0);
    const [lx, ly] = p.look || [0, 0]; eyes.forEach((e, i) => { e.position.x = (i ? 0.06 : -0.06) + lx * 0.012; e.position.y = 0.02 + ly * 0.012; });
  }
  set({});
  return { root, set };
}

/** Toon pigeon (~0.3 m). set({x,y,z,rotY, t, peck 0..1, out (passed out, on its back) 0..1}) */
export function makePigeon() {
  const gray = new THREE.MeshStandardMaterial({ color: 0x9aa0ab, roughness: 0.8 }), neck = new THREE.MeshStandardMaterial({ color: 0x5f7f7a, roughness: 0.5, metalness: 0.2 });
  const orange = new THREE.MeshStandardMaterial({ color: 0xe0823a, roughness: 0.6 }), dark = new THREE.MeshStandardMaterial({ color: 0x222222, roughness: 0.5 });
  const white = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.3 });
  const root = new THREE.Group(), body = new THREE.Group(); root.add(body);
  const b = mk(new THREE.SphereGeometry(0.12, 18, 12), gray, body, 0, 0.16, 0); b.scale.set(0.85, 0.85, 1.3);
  const head = new THREE.Group(); body.add(head); head.position.set(0, 0.28, 0.1);
  mk(new THREE.SphereGeometry(0.075, 14, 10), neck, head, 0, -0.04, -0.01);
  mk(new THREE.SphereGeometry(0.065, 14, 10), gray, head, 0, 0.02, 0.01);
  const beak = mk(new THREE.ConeGeometry(0.018, 0.06, 8), orange, head, 0, 0.0, 0.085); beak.rotation.x = Math.PI / 2;
  const eyeX = [];
  for (const s of [-1, 1]) {
    const e = mk(new THREE.SphereGeometry(0.022, 10, 8), white, head, s * 0.045, 0.035, 0.04);
    const p = mk(new THREE.SphereGeometry(0.012, 8, 6), dark, head, s * 0.052, 0.037, 0.055);
    const x1 = mk(new THREE.BoxGeometry(0.006, 0.03, 0.006), dark, head, s * 0.056, 0.035, 0.058); x1.rotation.z = 0.8;
    const x2 = mk(new THREE.BoxGeometry(0.006, 0.03, 0.006), dark, head, s * 0.056, 0.035, 0.058); x2.rotation.z = -0.8;
    eyeX.push({ e, p, x: [x1, x2] });
  }
  mk(new THREE.ConeGeometry(0.06, 0.16, 10), dark, body, 0, 0.16, -0.18).rotation.x = -Math.PI / 2 - 0.3;
  const legs = [-1, 1].map((s) => mk(new THREE.CylinderGeometry(0.008, 0.008, 0.1, 6), orange, body, s * 0.04, 0.05, 0.02));
  const wings = [-1, 1].map((s) => { const w = new THREE.Group(); body.add(w); w.position.set(s * 0.085, 0.2, 0); const f = mk(new THREE.SphereGeometry(0.1, 14, 8), gray, w, s * 0.07, 0, -0.02); f.scale.set(0.9, 0.18, 1.2); return w; });
  const shades = makeShades(0.02, 0.045); head.add(shades); shades.position.set(0, 0.04, 0.072);
  function set(p = {}) {
    root.position.set(p.x ?? 0, p.y ?? 0, p.z ?? 0); root.rotation.y = p.rotY ?? 0; root.scale.setScalar(p.scale ?? 1);
    const out = p.out ?? 0, t = p.t ?? 0, fl = p.flap ?? 0; shades.visible = !!p.shades;
    wings.forEach((w, i) => (w.rotation.z = (i ? -1 : 1) * (fl * (0.3 + 1.1 * Math.abs(Math.sin(t * 26)))))); // flap 0..1
    body.rotation.z = out * Math.PI * 0.95; body.position.y = out * 0.3;
    head.rotation.x = (p.peck ?? 0) * 0.9 * Math.max(0, Math.sin(t * 9)) + Math.sin(t * 4) * 0.08 * (1 - out);
    head.position.z = 0.1 + Math.sin(t * 6) * 0.02 * (1 - out);
    for (const e of eyeX) { e.p.visible = out < 0.5; e.x.forEach((x) => (x.visible = out >= 0.5)); }
    legs.forEach((l, i) => { l.rotation.x = out * 0.3 + (out > 0.5 ? Math.sin(t * 20 + i) * 0.05 : 0); });
  }
  set({});
  return { root, set };
}
