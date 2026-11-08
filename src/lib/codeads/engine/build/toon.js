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
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
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

export function makeToon(o = {}) {
  const C = { skin: 0xf2c29a, shirt: 0x2bb3a3, pants: 0x34495e, shoes: 0x3b2a20, hair: 0x6b3f22, ...o };
  const M = {
    skin: new THREE.MeshStandardMaterial({ color: C.skin, roughness: 0.55 }), shirt: new THREE.MeshStandardMaterial({ color: C.shirt, roughness: 0.8 }),
    pants: new THREE.MeshStandardMaterial({ color: C.pants, roughness: 0.85 }), shoes: new THREE.MeshStandardMaterial({ color: C.shoes, roughness: 0.6 }),
    hair: new THREE.MeshStandardMaterial({ color: C.hair, roughness: 0.75 }), white: new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.25 }),
    pupil: new THREE.MeshStandardMaterial({ color: 0x1d1612, roughness: 0.2 }), hat: new THREE.MeshStandardMaterial({ color: C.hatColor ?? 0xffc21a, roughness: 0.35 }),
    beard: new THREE.MeshStandardMaterial({ color: C.beard ?? 0xeeeeee, roughness: 0.9 }), bone: new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.5, emissive: 0xd8f2ff, emissiveIntensity: 0.9 }),
  };
  const base = Object.fromEntries(Object.entries(M).map(([k, m]) => [k, m.color.clone()]));
  const root = new THREE.Group(), pivot = new THREE.Group(), body = new THREE.Group();
  root.add(pivot); pivot.position.y = 0.62; pivot.add(body); body.position.y = -0.62;
  const bones = []; const bone = (parent, len, r, y) => { const b = mk(new THREE.CapsuleGeometry(r, len, 4, 8), M.bone, parent, 0, y, 0); b.visible = false; b.castShadow = false; bones.push(b); return b; };

  // torso + hips
  const pelvis = mk(new THREE.SphereGeometry(0.165, 24, 16), M.pants, body, 0, 0.47, 0); pelvis.scale.set(1, 0.72, 0.85);
  const torso = new THREE.Group(); body.add(torso); torso.position.y = 0.47;
  const chest = mk(new THREE.CapsuleGeometry(0.168, 0.14, 8, 20), M.shirt, torso, 0, 0.19, 0); chest.scale.set(1, 1, 0.85);
  bone(torso, 0.3, 0.025, 0.2);
  for (let i = 0; i < 3; i++) { const rib = new THREE.Mesh(new THREE.TorusGeometry(0.1 - i * 0.01, 0.012, 6, 16, Math.PI), M.bone); rib.position.set(0, 0.32 - i * 0.06, 0.02); rib.rotation.set(Math.PI / 2, 0, 0); rib.visible = false; torso.add(rib); bones.push(rib); }

  // head
  const neck = new THREE.Group(); torso.add(neck); neck.position.y = 0.42;
  const head = new THREE.Group(); neck.add(head); head.position.y = 0.23;
  const skull = mk(new THREE.SphereGeometry(0.27, 32, 24), M.skin, head, 0, 0, 0);
  mk(new THREE.SphereGeometry(0.036, 12, 10), M.skin, head, 0, -0.035, 0.27);
  for (const s of [-1, 1]) { const ear = mk(new THREE.SphereGeometry(0.055, 12, 10), M.skin, head, s * 0.262, -0.01, 0); ear.scale.set(0.55, 1, 0.9); }
  const xskull = mk(new THREE.SphereGeometry(0.2, 20, 14), M.bone, head, 0, 0.02, 0); xskull.visible = false; bones.push(xskull);
  // eyes: white + pupil + glint + lid (a skin-colored cap that rotates down) + an fx decal (spiral / X)
  const eyes = [], E = eyeFx();
  for (const s of [-1, 1]) {
    const eg = new THREE.Group(); head.add(eg); eg.position.set(s * 0.1, 0.045, 0.228); eg.rotation.set(-0.14, s * 0.38, 0);
    const white = mk(new THREE.SphereGeometry(0.085, 24, 16), M.white, eg); white.scale.set(0.9, 1.12, 0.55); white.castShadow = false;
    const pg = new THREE.Group(); eg.add(pg);
    const pupil = mk(new THREE.SphereGeometry(0.043, 16, 12), M.pupil, pg, 0, 0, 0.034); pupil.scale.set(1, 1.1, 0.55); pupil.castShadow = false;
    const glint = mk(new THREE.SphereGeometry(0.012, 8, 6), M.white, pg, 0.014, 0.018, 0.058); glint.castShadow = false;
    const lid = mk(new THREE.SphereGeometry(0.088, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2), M.skin, eg); lid.scale.set(0.95, 1.16, 0.62); lid.castShadow = false;
    const fx = new THREE.Mesh(new THREE.CircleGeometry(0.07, 24), new THREE.MeshBasicMaterial({ map: E.spiral, transparent: true })); fx.position.z = 0.05; fx.visible = false; eg.add(fx);
    const brow = mk(new THREE.CapsuleGeometry(0.017, 0.075, 4, 8), M.hair, head, s * 0.1, 0.165, 0.226); brow.rotation.z = Math.PI / 2; brow.castShadow = false;
    eyes.push({ s, eg, white, pg, pupil, lid, fx, brow });
  }
  // mouth decal (follows the sphere's tilt below center)
  const MT = mouthTextures();
  const mouth = new THREE.Mesh(new THREE.PlaneGeometry(0.17, 0.128), new THREE.MeshStandardMaterial({ map: MT.smile, transparent: true, roughness: 0.6 }));
  mouth.position.set(0, -0.112, 0.248); mouth.rotation.x = -0.42; head.add(mouth);
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
  } else if (C.hairStyle === 'side') {
    const cap = mk(new THREE.SphereGeometry(0.28, 28, 16, 0, Math.PI * 2, 0, Math.PI * 0.42), M.hair, hair, 0, 0.005, -0.012); cap.rotation.set(-0.2, 0, 0.12);
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

  // arms + legs
  const limb = (side, isArm) => {
    const g = new THREE.Group(); torso.add(g);
    if (isArm) {
      g.position.set(side * 0.19, 0.32, 0);
      mk(new THREE.CapsuleGeometry(0.054, 0.1, 4, 10), M.shirt, g, 0, -0.08, 0);
      bone(g, 0.16, 0.014, -0.09);
      const el = new THREE.Group(); g.add(el); el.position.y = -0.18;
      mk(new THREE.CapsuleGeometry(0.046, 0.1, 4, 10), M.skin, el, 0, -0.08, 0);
      bone(el, 0.12, 0.012, -0.08);
      const hand = new THREE.Group(); el.add(hand); hand.position.y = -0.19;
      mk(new THREE.SphereGeometry(0.066, 14, 10), M.skin, hand, 0, 0, 0).scale.set(1, 1.05, 0.85);
      mk(new THREE.SphereGeometry(0.03, 8, 6), M.skin, hand, -side * 0.05, 0.03, 0.03);
      return { g, el, hand };
    }
    const hip = new THREE.Group(); body.add(hip); hip.position.set(side * 0.085, 0.42, 0);
    mk(new THREE.CapsuleGeometry(0.064, 0.1, 4, 10), M.pants, hip, 0, -0.1, 0);
    bone(hip, 0.16, 0.016, -0.1);
    const kn = new THREE.Group(); hip.add(kn); kn.position.y = -0.2;
    mk(new THREE.CapsuleGeometry(0.058, 0.09, 4, 10), M.pants, kn, 0, -0.08, 0);
    bone(kn, 0.14, 0.014, -0.08);
    mk(new RoundedBoxGeometry(0.13, 0.085, 0.215, 3, 0.035), M.shoes, kn, 0, -0.175, 0.035);
    return { g: hip, el: kn };
  };
  const armL = limb(-1, true), armR = limb(1, true), legL = limb(-1, false), legR = limb(1, false);
  root.traverse((m) => { if (m.isMesh && m.material === M.bone) m.castShadow = false; });

  let mouthKey = 'smile';
  function set(p = {}) {
    const s = p.scale ?? 1;
    root.position.set(p.x ?? 0, p.y ?? 0, p.z ?? 0); root.rotation.y = p.rotY ?? 0; root.scale.setScalar(s);
    const [sx, sy] = p.squash || [1, 1]; body.scale.set(sx, sy, sx);
    pivot.rotation.set(p.rx ?? 0, 0, p.rz ?? 0);
    const wk = p.walk, wa = p.walkAmt ?? 1;
    const swing = wk === undefined || wk === null ? 0 : Math.sin(wk) * wa;
    body.position.y = -0.62 + (wk == null ? 0 : Math.abs(Math.cos(wk)) * 0.03 * wa);
    torso.rotation.set((p.lean ?? 0.03), 0, wk == null ? 0 : Math.sin(wk) * 0.05 * wa);
    const A = (arm, q, side) => { arm.g.rotation.set(q.x ?? 0, q.y ?? 0, side * (q.z ?? 0.12)); arm.el.rotation.set(-(q.el ?? 0.15), 0, 0); };
    A(armL, { x: wk == null ? 0 : swing * 0.55, ...p.armL }, -1); A(armR, { x: wk == null ? 0 : -swing * 0.55, ...p.armR }, 1);
    const Lg = (leg, q) => { leg.g.rotation.set(q.x ?? 0, 0, q.z ?? 0); leg.el.rotation.set(q.kn ?? 0, 0, 0); };
    const kneeL = wk == null ? 0 : Math.max(0, Math.sin(wk + Math.PI / 2)) * 0.7 * wa, kneeR = wk == null ? 0 : Math.max(0, Math.sin(wk - Math.PI / 2)) * 0.7 * wa;
    Lg(legL, { x: -swing * 0.6, kn: kneeL, ...p.legL }); Lg(legR, { x: swing * 0.6, kn: kneeR, ...p.legR });
    const hd = p.head || {}; head.rotation.set(hd.x ?? 0, hd.y ?? 0, hd.z ?? 0);
    // eyes
    const ek = p.eyes || 'open', [lx, ly] = p.look || [0, 0];
    for (const e of eyes) {
      const wide = ek === 'wide' ? 1.22 : 1;
      e.white.scale.set(0.9 * wide, 1.12 * wide, 0.55); e.lid.scale.set(0.95 * wide, 1.16 * wide, 0.62);
      e.pg.position.set(clamp(lx, -1, 1) * 0.03, clamp(ly, -1, 1) * 0.035, 0); e.pg.scale.setScalar(ek === 'wide' ? 0.88 : 1); // wide = big whites + a still-readable pupil (0.72 read as blank discs)
      e.lid.rotation.x = ek === 'closed' ? 1.62 : ek === 'half' ? 0.55 : -0.95;
      const fx = ek === 'spiral' || ek === 'x'; e.fx.visible = fx; e.pg.visible = !fx;
      if (fx) { e.fx.material.map = EYEFX[ek]; e.fx.rotation.z = ek === 'spiral' ? (p.t ?? 0) * -9 * e.s : 0; }
      const b = p.brows ?? 0; e.brow.rotation.z = Math.PI / 2 + e.s * b * 0.45; e.brow.position.y = 0.165 + Math.abs(b) * 0.012 + (ek === 'wide' ? 0.025 : 0);
    }
    const mk2 = p.mouth || 'smile'; if (mk2 !== mouthKey) { mouth.material.map = MT[mk2] || MT.smile; mouth.material.needsUpdate = true; mouthKey = mk2; }
    // beard / gray / hair up
    const bd = p.beard ?? 0; beard.visible = bd > 0.001; chin.scale.set(1.25 * Math.min(1, bd * 4), 0.9 * Math.min(1, bd * 4), 0.75);
    const L = Math.max(0.001, bd * 1.25); long.scale.set(1, L, 1); long.position.y = 0; long.visible = bd > 0.12;
    const gray = p.gray ?? 0; M.hair.color.copy(base.hair).lerp(new THREE.Color(0xe8e8e8), gray);
    const up = p.hairUp ?? 0, lift = p.hatLift ?? 0; // zap / wind: spikes stand up; a hat hides them unless it's knocked off
    const hatOn = !!C.hat && lift < 0.25;
    for (const sp of spikes) { sp.visible = !hatOn; sp.scale.set(1, 1 + up * 1.6, 1); sp.position.y = 0.26 + up * 0.08; }
    // a hard hat sits high + tipped back so the brim never hides the eyes (v2 review: the face stopped acting under it)
    const hb = C.hat === 'hardhat' ? [0.075, -0.035, -0.3] : [0, 0, 0];
    hat.position.set(0, hb[0] + lift * 0.55, hb[1] - lift * 0.15); hat.rotation.set(hb[2] - lift * 0.9, 0, lift * 0.5); hat.visible = !p.noHat;
    // x-ray zap + char
    const xr = !!p.xray, ch = p.char ?? 0, [tc, ta] = p.tint || [0, 0], [fc, fa] = p.faceTint || [0, 0], [gc, ga] = p.glow || [0, 0]; // glow: emissive [color, intensity] (a character that IS the light)
    for (const b of bones) b.visible = xr;
    for (const k of ['skin', 'shirt', 'pants', 'shoes', 'hair', 'hat']) {
      const m = M[k];
      if (k !== 'hair' || gray === 0) m.color.copy(base[k]);
      if (ch > 0) m.color.lerp(new THREE.Color(0x2a2522), ch * 0.9);
      if (ta > 0) m.color.lerp(new THREE.Color(tc), ta);
      if (fa > 0 && k === 'skin') m.color.lerp(new THREE.Color(fc), fa);
      m.transparent = xr; m.opacity = xr ? 0.3 : 1; m.depthWrite = !xr; m.emissive.setHex(ga > 0 ? gc : 0); m.emissiveIntensity = ga;
      if (xr) m.color.set(0x7fb4ff);
    }
    for (const e of eyes) { e.white.visible = !xr; e.pg.visible = e.pg.visible && !xr; }
    mouth.visible = !xr;
  }
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
