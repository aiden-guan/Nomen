// SET: a rooftop pool at golden hour (Nomen code ads). A teak deck on a high roof, an infinity pool whose water ripples,
// loungers, potted palms, a glass railing over a sunset skyline, an outdoor screen on a stand (the screen) and a high
// cocktail table with the laptop and a drink: the company runs while the lead is at the pool. The camera on +z.
// Deck x ∈ [-4, 4], z ∈ [-3, 3]; the pool runs along the front-left.
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mat, mk, canvasTex, rng } from '../core.js';
import { addWallScreen, addLaptop } from './devoffice.js';
import { makeShades } from '../build/toon.js';

export function buildRooftop(studio, opts = {}) {
  const { scene } = studio;
  const root = new THREE.Group(); scene.add(root);
  scene.background = new THREE.Color(0xf2a86b);
  const brand = opts.brand || {}, C = { primary: 0x2f6fd6, accent: 0xffc21a, ...(brand.colors || {}) };
  const box = (w, h, d, m, x, y, z, p = root) => mk(new THREE.BoxGeometry(w, h, d), m, p, x, y, z);
  const rbox = (w, h, d, r, m, x, y, z, p = root) => mk(new RoundedBoxGeometry(w, h, d, 2, r), m, p, x, y, z);

  // the sky and the skyline at sunset, far behind the railing
  const sky = new THREE.Mesh(new THREE.PlaneGeometry(40, 16), new THREE.MeshBasicMaterial({ toneMapped: false, map: canvasTex(1024, 420, (g, w, h) => {
    const gr = g.createLinearGradient(0, 0, 0, h); gr.addColorStop(0, '#5a6fb4'); gr.addColorStop(0.45, '#f39a6b'); gr.addColorStop(0.75, '#ffd38a'); gr.addColorStop(1, '#ffe8b8'); g.fillStyle = gr; g.fillRect(0, 0, w, h);
    g.fillStyle = 'rgba(255,240,200,.9)'; g.beginPath(); g.arc(w * 0.72, h * 0.66, 34, 0, 7); g.fill();
    const r = rng(12); for (let x = 0; x < w;) { const bw = 30 + r() * 70, bh = 60 + r() * 170; g.fillStyle = `hsl(${250 + r() * 30},${18 + r() * 10}%,${28 + r() * 12}%)`; g.fillRect(x, h - bh, bw, bh); g.fillStyle = 'rgba(255,214,140,.55)'; for (let y = h - bh + 8; y < h; y += 13) for (let xx = x + 5; xx < x + bw - 6; xx += 10) if (r() < 0.45) g.fillRect(xx, y, 5, 6); x += bw + 3; }
  }) }));
  sky.position.set(0, 3.2, -14); root.add(sky);
  // the deck (teak boards) on the roof slab, its cut face
  const teak = canvasTex(256, 256, (g, w, h) => { g.fillStyle = '#9a6a43'; g.fillRect(0, 0, w, h); const r = rng(2); for (let x = 0; x < w; x += 32) { g.fillStyle = `hsl(26,${38 + r() * 10}%,${36 + r() * 8}%)`; g.fillRect(x, 0, 30, h); g.fillStyle = 'rgba(0,0,0,.2)'; g.fillRect(x + 30, 0, 2, h); } }, [6, 5]);
  const deck = mk(new THREE.PlaneGeometry(8.4, 6.4), new THREE.MeshStandardMaterial({ map: teak, roughness: 0.6 }), root, 0, 0, 0); deck.rotation.x = -Math.PI / 2; deck.castShadow = false;
  box(8.6, 0.5, 6.6, mat(0xd8d2c6, 0.85), 0, -0.262, 0);
  // the pool, front left: tiled walls, water that ripples (a scrolling texture), a ladder
  const tile = mat(0xe8f2f6, 0.4);
  const P = { x: -1.9, z: 1.3, w: 3.4, d: 2.0 };
  for (const [w, d, x, z] of [[P.w + 0.2, 0.1, P.x, P.z - P.d / 2], [P.w + 0.2, 0.1, P.x, P.z + P.d / 2], [0.1, P.d, P.x - P.w / 2, P.z], [0.1, P.d, P.x + P.w / 2, P.z]]) box(w, 0.12, d, tile, x, 0.06, z);
  const waterTex = canvasTex(256, 256, (g, w, h) => { g.fillStyle = '#2aa6d8'; g.fillRect(0, 0, w, h); g.strokeStyle = 'rgba(220,250,255,.55)'; g.lineWidth = 3; const r = rng(7); for (let i = 0; i < 40; i++) { const x = r() * w, y = r() * h; g.beginPath(); g.moveTo(x, y); g.bezierCurveTo(x + 20, y - 10, x + 40, y + 10, x + 60, y); g.stroke(); } }, [3, 2]);
  const water = mk(new THREE.PlaneGeometry(P.w, P.d), new THREE.MeshStandardMaterial({ map: waterTex, roughness: 0.08, metalness: 0.15, color: 0xbfefff }), root, P.x, 0.08, P.z); water.rotation.x = -Math.PI / 2; water.castShadow = false;
  for (const s of [-1, 1]) { const rail = mk(new THREE.TorusGeometry(0.16, 0.015, 6, 16, Math.PI), mat(0xd9dde2, 0.2, { metalness: 0.9 }), root, P.x + P.w / 2 - 0.4 + s * 0.12, 0.12, P.z - P.d / 2 + 0.08); rail.rotation.y = Math.PI / 2; }
  // loungers with towels, potted palms, a glass railing at the back and the sides
  for (const [x, z] of [[1.6, 1.4], [2.7, 1.2]]) { const l = new THREE.Group(); l.position.set(x, 0, z); l.rotation.y = -0.2; root.add(l); rbox(0.62, 0.08, 1.7, 0.03, mat(0xf4f1ea, 0.7), 0, 0.3, 0, l); const back = rbox(0.62, 0.08, 0.6, 0.03, mat(0xf4f1ea, 0.7), 0, 0.5, -0.82, l); back.rotation.x = 0.8; rbox(0.5, 0.03, 0.9, 0.01, mat(new THREE.Color(C.accent ?? 0xffc21a), 0.8), 0, 0.35, 0.25, l); for (const [a, b] of [[-0.26, -0.7], [0.26, -0.7], [-0.26, 0.7], [0.26, 0.7]]) box(0.04, 0.28, 0.04, mat(0x8a8f96, 0.4), a, 0.14, b, l); }
  const palm = (x, z, s) => { const g = new THREE.Group(); g.position.set(x, 0, z); g.scale.setScalar(s); root.add(g); mk(new THREE.CylinderGeometry(0.28, 0.22, 0.5, 14), mat(0xe9e3d6, 0.6), g, 0, 0.25, 0); for (let k = 0; k < 5; k++) mk(new THREE.CylinderGeometry(0.06, 0.07, 0.42, 8), mat(0x7a5a3a, 0.8), g, Math.sin(k) * 0.03, 0.7 + k * 0.4, 0); for (let k = 0; k < 7; k++) { const f = mk(new THREE.SphereGeometry(0.5, 10, 6), mat(0x3d8a3a, 0.8), g, Math.cos(k * 0.9) * 0.45, 2.55, Math.sin(k * 0.9) * 0.45); f.scale.set(1.3, 0.12, 0.35); f.rotation.set(0, -k * 0.9, -0.35); } };
  palm(-3.2, -2.3, 1); palm(3.3, -2.2, 0.9);
  const glass = new THREE.MeshStandardMaterial({ color: 0xdff2ff, roughness: 0.05, metalness: 0.1, transparent: true, opacity: 0.25, depthWrite: false });
  box(8.2, 1.05, 0.03, glass, 0, 0.55, -3.0).receiveShadow = false; box(8.2, 0.05, 0.08, mat(0xd9dde2, 0.2, { metalness: 0.9 }), 0, 1.08, -3.0);
  // the outdoor screen on a sleek stand behind the table
  const SA = { x: 0, y: 1.86, z: -2.45, w: 1.84, h: 1.035 };
  box(0.1, 1.3, 0.1, mat(0x24262b, 0.3, { metalness: 0.6 }), 0, 0.65, -2.52); box(0.9, 0.04, 0.5, mat(0x24262b, 0.3, { metalness: 0.6 }), 0, 0.02, -2.52);
  const screen = addWallScreen(root, SA, C, { glow: 0.7 });
  // the high cocktail table: the laptop and a drink with a straw
  const top = 0.64, tz = -1.3;
  mk(new THREE.CylinderGeometry(0.62, 0.62, 0.04, 32), mat(0xf6f4ef, 0.3), root, 0, top - 0.02, tz).scale.set(1.25, 1, 0.75);
  mk(new THREE.CylinderGeometry(0.04, 0.05, top - 0.04, 12), mat(0x24262b, 0.3, { metalness: 0.6 }), root, 0, (top - 0.04) / 2, tz);
  mk(new THREE.CylinderGeometry(0.3, 0.3, 0.02, 24), mat(0x24262b, 0.3, { metalness: 0.6 }), root, 0, 0.01, tz);
  const laptop = addLaptop(root, [0.12, top, -1.28], opts.logo, C);
  const drink = new THREE.Group(); drink.position.set(-0.52, top, -1.18); root.add(drink);
  mk(new THREE.CylinderGeometry(0.045, 0.035, 0.13, 14), new THREE.MeshStandardMaterial({ color: 0xffb347, roughness: 0.1, transparent: true, opacity: 0.8 }), drink, 0, 0.065, 0);
  const straw = mk(new THREE.CylinderGeometry(0.006, 0.006, 0.2, 6), mat(0xff4d6d, 0.5), drink, 0.02, 0.15, 0); straw.rotation.z = -0.25;
  mk(new THREE.SphereGeometry(0.02, 8, 6), mat(0xffe066, 0.5), drink, -0.04, 0.135, 0);
  // golden-hour light: a low warm sun from the back-right (long shadows), a pink-blue sky fill, a soft key from the lens side
  root.add(new THREE.HemisphereLight(0xa9b8ff, 0xd08a5a, 0.85));
  const sun = new THREE.DirectionalLight(0xffc88a, 2.4); sun.position.set(4, 8, -6); sun.target.position.set(0, 0, 0); root.add(sun, sun.target);
  sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048); sun.shadow.bias = -0.0005; sun.shadow.normalBias = 0.03; Object.assign(sun.shadow.camera, { left: -4, right: 4, top: 4, bottom: -4, near: 1, far: 24 });
  const key = new THREE.DirectionalLight(0xfff0e0, 1.3); key.position.set(-2.5, 4.5, 6); key.target.position.set(0, 0.9, -1.4); root.add(key, key.target);
  root.traverse((o) => { if (o.isMesh && (o.material.isMeshBasicMaterial || o.material.transparent)) o.castShadow = false; });

  return {
    root,
    stations: {
      hero: {
        x: 0, y: 0, z: -1.86, rotY: 0, top, laptop, laptopAt: [0.12, -1.28], button: [-0.4, -1.42], strip: [0.48, -1.5], crate: [1.25, -0.4],
        orbit: { cx: 0.6, cz: -0.2, rx: 1.4, rz: 0.35, w: 0.6 }, money: [[0.5, top, -1.42], [-0.3, top, -1.55], [1.4, 0, -1.6]],
        screen: { ...SA, ...screen },
        // shades pushed up on his head
        attach(toon) { const sh = makeShades(0.062, 0.085); toon.head.add(sh); sh.position.set(0, 0.26, 0.21); sh.rotation.x = -0.6; sh.visible = true; },
      },
    },
    update(t) { waterTex.offset.set((t * 0.03) % 1, (t * 0.017) % 1); },
  };
}
