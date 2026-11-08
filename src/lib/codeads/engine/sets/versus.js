// SET: the versus dollhouse (Nomen code ads, chud vs Chad). Two floors cut open like the build genre's cutaways, so a
// vertical frame holds both: downstairs, the rival's basement (the old way): bare concrete, a dim bulb, pizza boxes,
// energy-drink cans, a cheap monitor full of errors; upstairs, the lead's penthouse (the product): floor-to-ceiling
// windows on a skyline, a clean desk, the brand's wall screen. The camera lives on +z.
// Floors: basement y = 0, penthouse y = UP (2.85). Each floor: x ∈ [-2.4, 2.4], z ∈ [-2.6, 1.2]; the person stands
// behind a desk at z = -1.86 facing the lens, the wall screen behind them.
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mat, mk, canvasTex, rng } from '../core.js';
import { addWallScreen, addLaptop, drawContain, wrap } from './devoffice.js';

export const UP = 2.85;
const W = 4.8, Z0 = -2.6, Z1 = 1.2, H = 2.55;
const hex = (c) => '#' + new THREE.Color(c).getHexString();

export function buildVersus(studio, opts = {}) {
  const { scene } = studio;
  const root = new THREE.Group(); scene.add(root);
  scene.background = new THREE.Color(0x1e232b);
  const brand = opts.brand || {}, C = { primary: 0x2f6fd6, accent: 0xffc21a, ...(brand.colors || {}) };
  const R = rng(9);
  const box = (w, h, d, m, x, y, z, p = root) => mk(new THREE.BoxGeometry(w, h, d), m, p, x, y, z);
  const rbox = (w, h, d, r, m, x, y, z, p = root) => mk(new RoundedBoxGeometry(w, h, d, 2, r), m, p, x, y, z);
  const plate = (text, x, y, z, bg = '#c9a25a', fg = '#1d1d22') => {
    const t = canvasTex(512, 96, (g, w, h) => { g.fillStyle = bg; g.fillRect(0, 0, w, h); g.fillStyle = fg; g.font = 'bold 44px Helvetica, Arial, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(String(text).toUpperCase().slice(0, 22), w / 2, h / 2 + 2); });
    return mk(new THREE.PlaneGeometry(0.62, 0.116), new THREE.MeshStandardMaterial({ map: t, roughness: 0.4, metalness: 0.2 }), root, x, y, z);
  };

  // ------------------------------------------------ the ground under the basement and the slab between the floors (cut faces show)
  const soil = canvasTex(512, 128, (g, w, h) => { g.fillStyle = '#4a3626'; g.fillRect(0, 0, w, h); const r = rng(3); for (let i = 0; i < 260; i++) { g.fillStyle = r() < 0.5 ? 'rgba(0,0,0,.25)' : 'rgba(160,120,80,.25)'; g.beginPath(); g.arc(r() * w, r() * h, 2 + r() * 7, 0, 7); g.fill(); } g.fillStyle = '#5b7f3a'; g.fillRect(0, 0, w, 6); }, [3, 1]);
  const dirt = mat(0x3a2a1e, 0.95);
  box(W + 0.4, 1.4, Z1 - Z0 + 0.3, [dirt, dirt, dirt, dirt, new THREE.MeshStandardMaterial({ map: soil, roughness: 0.95 }), dirt], 0, -0.7, (Z0 + Z1) / 2);
  const slabTex = canvasTex(512, 64, (g, w, h) => { g.fillStyle = '#cfcac0'; g.fillRect(0, 0, w, h); g.fillStyle = '#a9a398'; g.fillRect(0, 0, w, 10); g.fillRect(0, h - 10, w, 10); }, [4, 1]);
  const conc = mat(0xbdb8ae, 0.85);
  box(W + 0.2, UP - H, Z1 - Z0 + 0.2, [conc, conc, conc, conc, new THREE.MeshStandardMaterial({ map: slabTex, roughness: 0.85 }), conc], 0, (H + UP) / 2, (Z0 + Z1) / 2);
  box(W + 0.2, 0.25, Z1 - Z0 + 0.2, [conc, conc, conc, conc, new THREE.MeshStandardMaterial({ map: slabTex, roughness: 0.85 }), conc], 0, UP + H + 0.125, (Z0 + Z1) / 2);

  // ------------------------------------------------ downstairs: the basement
  const damp = canvasTex(512, 256, (g, w, h) => { g.fillStyle = '#5d625a'; g.fillRect(0, 0, w, h); const r = rng(5); for (let i = 0; i < 40; i++) { const gr = g.createRadialGradient(r() * w, r() * h, 0, r() * w, r() * h, 20 + r() * 60); gr.addColorStop(0, 'rgba(40,52,30,.45)'); gr.addColorStop(1, 'rgba(40,52,30,0)'); g.fillStyle = gr; g.fillRect(0, 0, w, h); } g.strokeStyle = 'rgba(0,0,0,.18)'; g.lineWidth = 3; for (let y = 0; y < h; y += 32) { g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke(); } }, [3, 1]);
  const dampM = new THREE.MeshStandardMaterial({ map: damp, roughness: 0.95 });
  box(W, H, 0.12, dampM, 0, H / 2, Z0 - 0.06);
  for (const s of [-1, 1]) box(0.12, H, Z1 - Z0, dampM, s * (W / 2 + 0.06), H / 2, (Z0 + Z1) / 2);
  const bfloor = mk(new THREE.PlaneGeometry(W, Z1 - Z0), new THREE.MeshStandardMaterial({ color: 0x4b4d4a, roughness: 0.95 }), root, 0, 0.001, (Z0 + Z1) / 2); bfloor.rotation.x = -Math.PI / 2;
  // a stained rug, a barred window high up with blue night, a bare bulb on a cord
  const rug = mk(new THREE.CircleGeometry(1.0, 24), new THREE.MeshStandardMaterial({ color: 0x6a3b32, roughness: 1 }), root, 0.9, 0.004, -0.2); rug.rotation.x = -Math.PI / 2; rug.scale.set(1.3, 0.8, 1); rug.receiveShadow = true;
  box(0.9, 0.32, 0.04, new THREE.MeshBasicMaterial({ color: 0x1a2a4a }), -1.45, 2.15, Z0 + 0.01);
  for (let k = 0; k < 5; k++) box(0.025, 0.32, 0.03, mat(0x222222, 0.5), -1.83 + k * 0.19, 2.15, Z0 + 0.04);
  mk(new THREE.CylinderGeometry(0.006, 0.006, 0.55, 5), mat(0x111111), root, 0.0, H - 0.27, -0.7);
  const bulb = mk(new THREE.SphereGeometry(0.05, 12, 10), new THREE.MeshBasicMaterial({ color: 0xffd98a, toneMapped: false }), root, 0.0, H - 0.6, -0.7); bulb.castShadow = false;
  const bulbLight = new THREE.PointLight(0xffc477, 3.2, 4.2, 1.6); bulbLight.position.set(0, H - 0.65, -0.7); root.add(bulbLight);
  // the rival's desk: a cheap, shallow, cluttered one with nothing in front (his gut and his crocs show); he stands well back
  const rdz = -1.45, rTop = 0.64;
  const cheap = mat(0x7a6a55, 0.7);
  box(1.6, 0.05, 0.5, cheap, 0, rTop - 0.025, rdz);
  for (const s of [-1, 1]) for (const dz of [-0.2, 0.2]) box(0.045, rTop - 0.05, 0.045, mat(0x5a4c3c, 0.7), s * 0.74, (rTop - 0.05) / 2, rdz + dz);
  plate(opts.rival?.name || 'THE OLD WAY', 0, rTop - 0.075, rdz + 0.252, '#8a8a8a', '#202020');
  const rScreenAt = { x: 0, y: 1.72, z: Z0 + 0.1, w: 1.6, h: 0.9 };
  const rScreen = addWallScreen(root, rScreenAt, { ...C, screenBg: 0x5a1010 }, { glow: 1.6, glowRange: 3.4 });
  const rLaptop = addLaptop(root, [0.1, rTop, -1.5], null, { ...C, accent: 0x777777 });
  // junk: energy drink cans, pizza boxes, a chip bag, sticky notes, a tangle of cables
  const canM = [mat(0x2bd16a, 0.35, { metalness: 0.6 }), mat(0x2f5bd9, 0.35, { metalness: 0.6 }), mat(0xe03a3a, 0.35, { metalness: 0.6 })];
  const cans = [[0.55, rTop, -1.3], [0.66, rTop, -1.55], [-0.58, rTop, -1.4], [-1.3, 0, -0.4], [-1.1, 0, 0.2], [1.5, 0, 0.3], [1.2, 0, -0.9], [0.4, 0, 0.6]];
  cans.forEach(([x, y, z], k) => { const c = mk(new THREE.CylinderGeometry(0.035, 0.035, 0.12, 12), canM[k % 3], root, x, y + (y ? 0.06 : 0.035), z); if (!y) { c.rotation.z = Math.PI / 2; c.rotation.y = k; } });
  const pizza = canvasTex(256, 256, (g, w, h) => { g.fillStyle = '#d8c3a0'; g.fillRect(0, 0, w, h); g.fillStyle = '#b8322a'; g.font = 'bold 54px Georgia, serif'; g.textAlign = 'center'; g.fillText('PIZZA', w / 2, h / 2 + 18); g.strokeStyle = 'rgba(120,70,30,.5)'; g.lineWidth = 10; g.beginPath(); g.arc(w * 0.7, h * 0.3, 40, 0, 7); g.stroke(); });
  const pm = [mat(0xc8b08a, 0.9), mat(0xc8b08a, 0.9), new THREE.MeshStandardMaterial({ map: pizza, roughness: 0.9 }), mat(0xc8b08a, 0.9), mat(0xc8b08a, 0.9), mat(0xc8b08a, 0.9)];
  for (let k = 0; k < 6; k++) { const b = box(0.46, 0.05, 0.46, pm, -1.55 + (k % 2) * 0.06, 0.025 + k * 0.05, -1.7 + (k % 3) * 0.03); b.rotation.y = (k * 0.37) % 0.6 - 0.3; }
  for (let k = 0; k < 3; k++) { const b = box(0.46, 0.05, 0.46, pm, 1.55, 0.025 + k * 0.05, -1.9); b.rotation.y = k * 0.5; }
  const notes = ['#ffe066', '#ff9ec7', '#8ce3ff', '#ffe066', '#b4f08a'];
  for (let k = 0; k < 9; k++) { const n = mk(new THREE.PlaneGeometry(0.1, 0.1), mat(new THREE.Color(notes[k % 5]), 0.8), root, -0.95 + (k % 3) * 0.13 + (k > 5 ? 1.6 : 0), 1.25 + Math.floor(k / 3) % 2 * 0.14 + (k > 5 ? 0.2 : 0), Z0 + 0.008); n.rotation.z = ((k * 1.7) % 1) - 0.5; n.castShadow = false; }
  for (let k = 0; k < 7; k++) { const cab = mk(new THREE.TorusGeometry(0.12 + (k % 3) * 0.05, 0.012, 6, 20), mat([0x111111, 0x2a2a2a, 0xdddddd][k % 3], 0.6), root, -0.4 + k * 0.13, 0.03, -1.55 + (k % 2) * 0.1); cab.rotation.x = Math.PI / 2 + ((k * 0.3) % 0.4); }

  // ------------------------------------------------ upstairs: the penthouse
  const y0 = UP;
  const wood = canvasTex(256, 256, (g, w, h) => { g.fillStyle = '#c9a77c'; g.fillRect(0, 0, w, h); const r = rng(2); for (let y = 0; y < h; y += 32) { g.fillStyle = `hsl(32,${40 + r() * 10}%,${58 + r() * 8}%)`; g.fillRect(0, y, w, 30); } }, [5, 4]);
  const pfloor = mk(new THREE.PlaneGeometry(W, Z1 - Z0), new THREE.MeshStandardMaterial({ map: wood, roughness: 0.45 }), root, 0, y0 + 0.001, (Z0 + Z1) / 2); pfloor.rotation.x = -Math.PI / 2;
  const white = mat(0xf2efe9, 0.9);
  for (const s of [-1, 1]) box(0.12, H, Z1 - Z0, white, s * (W / 2 + 0.06), y0 + H / 2, (Z0 + Z1) / 2);
  // floor-to-ceiling glass on a sunny skyline, a solid panel in the middle that carries the wall screen
  const sky = new THREE.Mesh(new THREE.PlaneGeometry(12, 4.5), new THREE.MeshBasicMaterial({ toneMapped: false, map: canvasTex(1024, 380, (g, w, h) => {
    const gr = g.createLinearGradient(0, 0, 0, h); gr.addColorStop(0, '#6fb2ee'); gr.addColorStop(1, '#dff0fa'); g.fillStyle = gr; g.fillRect(0, 0, w, h);
    const r = rng(8); for (let x = 0; x < w;) { const bw = 40 + r() * 80, bh = 70 + r() * 200; g.fillStyle = `hsl(${205 + r() * 20},${18 + r() * 14}%,${62 + r() * 16}%)`; g.fillRect(x, h - bh, bw, bh); g.fillStyle = 'rgba(255,255,255,.4)'; for (let y = h - bh + 8; y < h; y += 14) for (let xx = x + 5; xx < x + bw - 6; xx += 11) g.fillRect(xx, y, 6, 7); x += bw + 5; }
  }) }));
  sky.position.set(0, y0 + 1.3, Z0 - 2.2); root.add(sky);
  const trim = mat(0x2c3036, 0.4);
  for (const s of [-1, 1]) { for (let k = 0; k <= 2; k++) box(0.06, H, 0.08, trim, s * (1.1 + k * 0.62), y0 + H / 2, Z0); box(1.3, 0.08, 0.1, trim, s * 1.75, y0 + 0.04, Z0); box(1.3, 0.08, 0.1, trim, s * 1.75, y0 + H - 0.04, Z0); }
  box(2.2, H, 0.1, mat(new THREE.Color(C.wall ?? 0x3a414d), 0.6), 0, y0 + H / 2, Z0 - 0.02);
  const hScreenAt = { x: 0, y: y0 + 1.75, z: Z0 + 0.1, w: 1.84, h: 1.035 };
  const hScreen = addWallScreen(root, hScreenAt, C, { glow: 0.8 });
  // the lead's desk: a clean white standing desk, a plant, a coffee
  const hdz = -1.3, hTop = 0.64;
  rbox(1.8, 0.05, 0.72, 0.02, mat(0xf4f4f2, 0.35), 0, y0 + hTop - 0.025, hdz);
  for (const s of [-1, 1]) box(0.05, hTop - 0.05, 0.05, mat(0x2a2d33, 0.3, { metalness: 0.5 }), s * 0.78, y0 + (hTop - 0.05) / 2, hdz);
  box(1.68, 0.48, 0.03, mat(0xe8e6e1, 0.5), 0, y0 + hTop - 0.3, hdz + 0.33);
  plate(opts.nameplate || 'FOUNDER', 0, y0 + hTop - 0.2, hdz + 0.352);
  const hLaptop = addLaptop(root, [0.12, y0 + hTop, -1.28], opts.logo, C);
  const mug = mk(new THREE.CylinderGeometry(0.045, 0.04, 0.1, 14), mat(new THREE.Color(C.primary).lerp(new THREE.Color(0xffffff), 0.15), 0.4), root, 0.66, y0 + hTop + 0.05, hdz + 0.12);
  void mug;
  const big = new THREE.Group(); big.position.set(1.85, y0, -2.1); root.add(big);
  mk(new THREE.CylinderGeometry(0.24, 0.18, 0.42, 14), mat(0xf4f1ea, 0.5), big, 0, 0.21, 0);
  for (let k = 0; k < 10; k++) { const lf = mk(new THREE.SphereGeometry(0.24, 10, 8), mat(0x3f7a3a, 0.8), big, Math.sin(k * 2.4) * 0.2, 0.7 + (k % 3) * 0.22, Math.cos(k * 2.4) * 0.2); lf.scale.set(0.45, 1.6, 0.25); lf.rotation.z = Math.sin(k) * 0.6; }
  const poster = new THREE.Mesh(new THREE.PlaneGeometry(0.8, 1.05), new THREE.MeshStandardMaterial({ roughness: 0.7, map: canvasTex(320, 420, (g, w, h) => {
    g.fillStyle = hex(C.screenBg ?? 0x1d2433); g.fillRect(0, 0, w, h);
    if (opts.logo) drawContain(g, opts.logo, w / 2 - 80, 60, 160, 160);
    g.fillStyle = hex(C.screenFg ?? 0xffffff); g.font = 'bold 30px Helvetica, Arial, sans-serif'; g.textAlign = 'center';
    wrap(g, String(opts.poster || brand.name || ''), w / 2, 280, w - 50, 36);
  }) }));
  poster.position.set(-W / 2 + 0.01, y0 + 1.5, -0.6); poster.rotation.y = Math.PI / 2; root.add(poster);

  // ------------------------------------------------ light: a key from the lens side over both floors, sun upstairs, the bulb downstairs
  const hemi = new THREE.HemisphereLight(0xe6eefc, 0x4a4038, 0.75); root.add(hemi);
  const key = new THREE.DirectionalLight(0xfff4e8, 1.7); key.position.set(-2.5, 9, 8); key.target.position.set(0, 2.2, -1.2); root.add(key, key.target);
  key.castShadow = true; key.shadow.mapSize.set(2048, 2048); key.shadow.bias = -0.0004; Object.assign(key.shadow.camera, { left: -4, right: 4, top: 6, bottom: -3, near: 1, far: 26 });
  const sun = new THREE.PointLight(0xfff1dc, 7, 6, 1.4); sun.position.set(0.4, y0 + 2.3, -0.4); root.add(sun);
  const sun2 = new THREE.DirectionalLight(0xfff3e0, 0.8); sun2.position.set(2, y0 + 6, -8); sun2.target.position.set(0, y0, 0); root.add(sun2, sun2.target);
  root.traverse((o) => { if (o.isMesh && (o.material.isMeshBasicMaterial || o.material.transparent)) o.castShadow = false; });

  // the framings: the whole house, then each floor
  const station = (y, top, laptop, screenAt, screen, extra) => ({
    x: 0, y, z: -1.86, rotY: 0, top, laptop, laptopAt: [0.12, -1.28], button: [-0.62, -1.08], strip: [0.55, -1.52], crate: [1.05, -0.62],
    orbit: { cx: 0.05, cz: -0.35, rx: 1.2, rz: 0.25, w: 0.7 }, money: [[0.62, top, -1.45], [-0.66, top, -1.5], [1.35, 0, -1.6]],
    screen: { ...screenAt, ...screen }, ...extra,
  });
  return {
    root,
    stations: {
      hero: station(y0, hTop, hLaptop, hScreenAt, hScreen, {}),
      rival: station(0, rTop, rLaptop, rScreenAt, rScreen, { z: -2.18, laptopAt: [0.1, -1.5], button: [-0.55, -1.38], strip: [0.5, -1.58], money: [[0.6, rTop, -1.4], [-0.62, rTop, -1.45], [1.3, 0, -1.9]], idleScreen: { kind: 'error', lines: ['BUILD FAILED', 'cron job crashed at 3:12 AM', '47 tabs open'] } }),
    },
    /** both floors in the frame */
    wide: (yaw = 0) => ({ pos: [Math.sin(yaw) * 8.6, 2.85 + 1.3, -1.0 + Math.cos(yaw) * 8.6], look: [0, 2.55, -1.0], fov: 42 }),
    update(t) { bulbLight.intensity = 3.2 * (0.82 + 0.18 * Math.max(0, Math.sin(t * 23) * Math.sin(t * 7.3))); },
  };
}
