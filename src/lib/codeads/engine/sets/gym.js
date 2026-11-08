// SET: the gym (Nomen code ads). A dollhouse cut of a weight room: rubber floor, a mirror wall with a big TV on it (the
// screen), a squat rack with a loaded barbell, a dumbbell rack, a bench, kettlebells, fluorescent strips. The lead types
// on a laptop set on a plyo box with one hand and curls a dumbbell with the other: the company runs while he trains.
// Room x ∈ [-3.5, 3.5], z ∈ [-2.6, 2.4], the camera on +z.
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mat, mk, canvasTex, rng } from '../core.js';
import { addWallScreen, addLaptop, drawContain } from './devoffice.js';

export function makeDumbbell(scale = 1) {
  const g = new THREE.Group(), iron = mat(0x1b1c1f, 0.45, { metalness: 0.5 }), chrome = mat(0xc9ced6, 0.2, { metalness: 0.85 });
  const bar = mk(new THREE.CylinderGeometry(0.016, 0.016, 0.2, 10), chrome, g, 0, 0, 0); bar.rotation.z = Math.PI / 2;
  for (const s of [-1, 1]) { const p = mk(new THREE.CylinderGeometry(0.055, 0.055, 0.06, 6), iron, g, s * 0.12, 0, 0); p.rotation.z = Math.PI / 2; }
  g.scale.setScalar(scale); return g;
}

export function buildGym(studio, opts = {}) {
  const { scene } = studio;
  const root = new THREE.Group(); scene.add(root);
  scene.background = new THREE.Color(0x1d2026);
  const brand = opts.brand || {}, C = { primary: 0x2f6fd6, accent: 0xffc21a, ...(brand.colors || {}) };
  const box = (w, h, d, m, x, y, z, p = root) => mk(new THREE.BoxGeometry(w, h, d), m, p, x, y, z);
  const rbox = (w, h, d, r, m, x, y, z, p = root) => mk(new RoundedBoxGeometry(w, h, d, 2, r), m, p, x, y, z);

  // rubber floor with flecks, the slab's cut face, side walls
  const rubber = canvasTex(256, 256, (g, w, h) => { g.fillStyle = '#26282c'; g.fillRect(0, 0, w, h); const r = rng(6); for (let i = 0; i < 900; i++) { g.fillStyle = ['rgba(255,255,255,.12)', 'rgba(120,120,130,.18)', 'rgba(0,0,0,.25)'][i % 3]; g.fillRect(r() * w, r() * h, 2, 2); } g.strokeStyle = 'rgba(0,0,0,.4)'; g.lineWidth = 3; g.strokeRect(0, 0, w, h); }, [7, 5]);
  const floor = mk(new THREE.PlaneGeometry(7.2, 5.2), new THREE.MeshStandardMaterial({ map: rubber, roughness: 0.9 }), root, 0, 0, -0.1); floor.rotation.x = -Math.PI / 2; floor.castShadow = false;
  box(7.4, 0.42, 5.3, mat(0x9b9a97, 0.85), 0, -0.215, -0.1);
  const wallM = mat(0x3c4250, 0.85);
  for (const s of [-1, 1]) box(0.12, 3.0, 5.2, wallM, s * 3.56, 1.5, -0.1);
  // the mirror wall: a pale, slightly blue, glossy panel with a soft sheen; a brand-coloured stripe above it
  const mirror = new THREE.Mesh(new THREE.PlaneGeometry(7.0, 2.3), new THREE.MeshStandardMaterial({ roughness: 0.08, metalness: 0.9, color: 0x9fb0c4, map: canvasTex(512, 256, (g, w, h) => { const gr = g.createLinearGradient(0, 0, w, h); gr.addColorStop(0, '#c7d3e0'); gr.addColorStop(0.45, '#8c9cb0'); gr.addColorStop(0.55, '#b9c7d6'); gr.addColorStop(1, '#7d8ca0'); g.fillStyle = gr; g.fillRect(0, 0, w, h); }) }));
  mirror.position.set(0, 1.25, -2.6); root.add(mirror);
  box(7.1, 0.7, 0.1, wallM, 0, 2.75, -2.62);
  box(7.1, 0.12, 0.06, new THREE.MeshBasicMaterial({ color: new THREE.Color(C.accent ?? 0xffc21a), toneMapped: false }), 0, 2.45, -2.56).castShadow = false;
  // the TV on the mirror wall
  const SA = { x: 0, y: 1.78, z: -2.48, w: 1.84, h: 1.035 };
  const screen = addWallScreen(root, SA, C, { glow: 0.8 });
  // the squat rack with a loaded barbell (left), a dumbbell rack (right), a bench, kettlebells, a water bottle
  const steel = mat(0x2a2d33, 0.35, { metalness: 0.6 }), red = mat(0xb3261e, 0.5), iron = mat(0x1b1c1f, 0.45, { metalness: 0.5 }), chrome = mat(0xc9ced6, 0.2, { metalness: 0.85 });
  const RX = -1.65;   // the squat rack, close enough to read in a medium shot
  for (const [x, z] of [[RX - 0.5, -2.3], [RX + 0.5, -2.3], [RX - 0.5, -1.6], [RX + 0.5, -1.6]]) box(0.08, 2.2, 0.08, steel, x, 1.1, z);
  box(1.08, 0.08, 0.08, steel, RX, 2.2, -2.3); box(1.08, 0.08, 0.08, steel, RX, 2.2, -1.6);
  const bar = mk(new THREE.CylinderGeometry(0.02, 0.02, 1.9, 10), chrome, root, RX, 1.35, -1.6); bar.rotation.z = Math.PI / 2;
  for (const s of [-1, 1]) for (const k of [0, 1]) { const p = mk(new THREE.CylinderGeometry(0.24 - k * 0.04, 0.24 - k * 0.04, 0.05, 24), k ? iron : red, root, RX + s * (0.72 + k * 0.06), 1.35, -1.6); p.rotation.z = Math.PI / 2; }
  const DX = 1.55;   // the dumbbell rack, right of the plyo box
  for (let row = 0; row < 2; row++) { box(1.5, 0.05, 0.36, steel, DX, 0.42 + row * 0.38, -2.2); for (let i = 0; i < 6; i++) { const d = makeDumbbell(0.8 + i * 0.05); d.position.set(DX - 0.6 + i * 0.24, 0.5 + row * 0.38, -2.2); d.rotation.y = Math.PI / 2; root.add(d); } }
  for (const s of [-1, 1]) box(0.05, 0.8, 0.05, steel, DX + s * 0.72, 0.4, -2.2);
  rbox(0.32, 0.12, 1.25, 0.04, mat(0x1c1d21, 0.6), -2.4, 0.46, 0.2); box(0.06, 0.4, 0.06, steel, -2.4, 0.2, -0.25); box(0.06, 0.4, 0.06, steel, -2.4, 0.2, 0.65);
  for (const [x, z, s] of [[-0.78, -1.55, 1], [-0.98, -1.38, 0.8], [0.82, -1.6, 1.1]]) { const kb = new THREE.Group(); kb.position.set(x, 0, z); kb.scale.setScalar(s); root.add(kb); mk(new THREE.SphereGeometry(0.13, 16, 12), iron, kb, 0, 0.13, 0); const hd = mk(new THREE.TorusGeometry(0.07, 0.018, 8, 16, Math.PI), iron, kb, 0, 0.24, 0); hd.rotation.z = 0; }
  mk(new THREE.CylinderGeometry(0.035, 0.035, 0.2, 12), mat(new THREE.Color(C.primary ?? 0x2f6fd6), 0.3), root, -0.5, 0.64 + 0.1, -1.15);
  // the plyo box that carries the laptop
  const top = 0.64, tz = -1.3;
  const ply = canvasTex(256, 256, (g, w, h) => { g.fillStyle = '#c99f6a'; g.fillRect(0, 0, w, h); g.strokeStyle = 'rgba(80,50,20,.35)'; g.lineWidth = 3; for (let y = 10; y < h; y += 22) { g.beginPath(); g.moveTo(0, y); g.bezierCurveTo(w * 0.3, y + 6, w * 0.6, y - 6, w, y); g.stroke(); } if (opts.logo) { g.globalAlpha = 0.85; drawContain(g, opts.logo, w * 0.3, h * 0.3, w * 0.4, h * 0.4); g.globalAlpha = 1; } });
  rbox(1.1, top, 0.62, 0.03, new THREE.MeshStandardMaterial({ map: ply, roughness: 0.75 }), 0, top / 2, tz);
  const laptop = addLaptop(root, [0.14, top, -1.28], opts.logo, C);
  // fluorescent strips and the light they throw; a cool fill from the lens side
  for (const x of [-1.6, 0, 1.6]) { box(0.12, 0.04, 1.6, new THREE.MeshBasicMaterial({ color: 0xf2f8ff, toneMapped: false }), x, 2.98, -0.6).castShadow = false; const L = new THREE.PointLight(0xeef4ff, 3.4, 6, 1.4); L.position.set(x, 2.7, -0.6); root.add(L); }
  root.add(new THREE.HemisphereLight(0xe8eef8, 0x3a3630, 0.9));
  const key = new THREE.DirectionalLight(0xfff6ec, 1.9); key.position.set(-2.2, 5.5, 6); key.target.position.set(0, 0.8, -1.2); root.add(key, key.target);
  key.castShadow = true; key.shadow.mapSize.set(2048, 2048); key.shadow.bias = -0.0004; Object.assign(key.shadow.camera, { left: -4.5, right: 4.5, top: 4.5, bottom: -4.5, near: 1, far: 22 });
  root.traverse((o) => { if (o.isMesh && (o.material.isMeshBasicMaterial || o.material.transparent)) o.castShadow = false; });

  let bell = null;
  const curling = new Set(['hack', 'idle', 'team', 'show', 'money', 'deliver', null]);
  return {
    root,
    stations: {
      hero: {
        x: 0, y: 0, z: -1.86, rotY: 0, top, laptop, laptopAt: [0.14, -1.28], button: [-0.42, -1.12], strip: [0.48, -1.45], crate: [1.2, -0.45],
        orbit: { cx: 0.1, cz: -0.25, rx: 1.3, rz: 0.3, w: 0.7 }, money: [[0.45, top, -1.42], [-0.45, top, -1.45], [1.3, 0, -1.5]],
        screen: { ...SA, ...screen },
        // a dumbbell in the left hand
        attach(toon) { bell = makeDumbbell(0.95); bell.position.set(0, -0.02, 0.02); bell.rotation.y = Math.PI / 2; toon.armL.hand.add(bell); },
        // while he works he curls: the left arm pumps slow reps, the right hand stays on the keys
        pose(p, t, gag) {
          if (!curling.has(gag)) { if (bell) bell.visible = gag !== 'approve' && gag !== 'celebrate'; return; }
          if (bell) bell.visible = true;
          const rep = 0.5 - 0.5 * Math.cos(t * 2.6);
          p.armL = { x: -0.35 - 0.25 * rep, z: 0.2, el: 0.35 + 1.75 * rep };
        },
      },
    },
    update() {},
  };
}
