// SET: the dev office, a dollhouse cut (adapted from ED Studio's engine/sets/office.js, video 012, for Nomen's code ads).
// The camera lives on +z and looks into the room. Room x∈[-3.5,3.5], z∈[-2.6,2.6], ceiling 2.9; the floor slab is cut open
// at z = 2.6 like the build genre's cutaways. The back wall (z = -2.6) has windows on a painted skyline on both sides and, in
// the middle, the WALL SCREEN (what the computer shows, big enough to read in a vertical frame). Gary stands at a standing
// desk in front of it (D.gary), facing the lens; the laptop on the desk faces him, its lid (with the brand's logo) faces us.
// Free floor for robots, crates and piles: z ∈ [-0.6, 1.6].
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mat, mk, canvasTex, rng } from '../core.js';

export const D = {
  desk: [0, -1.3], deskTop: 0.64, deskW: 1.8, deskD: 0.72,
  gary: [0, -1.86],                                        // Gary's feet, behind the desk
  screen: { x: 0, y: 2.0, z: -2.5, w: 1.84, h: 1.035 },     // the wall screen's centre and size (16:9)
  laptop: [0.12, -1.28],
  floorFront: 2.6,
  crate: [1.12, -0.82],
  button: [-0.62, -1.08],                                  // the big button's pedestal, on the desk's left end
};

const hex = (c) => '#' + new THREE.Color(c).getHexString();

/** opts: { brand: { name, colors: { primary, accent, screenBg, screenFg } }, logo: HTMLImageElement | null, nameplate, poster } */
export function buildDevOffice(studio, opts = {}) {
  const { scene } = studio;
  const root = new THREE.Group(); scene.add(root);
  const R = rng(opts.seed ?? 7);
  const brand = opts.brand || {};
  const C = { primary: 0x2f6fd6, accent: 0xffc21a, ...(brand.colors || {}) };
  const box = (w, h, d, m, x, y, z, p = root) => mk(new THREE.BoxGeometry(w, h, d), m, p, x, y, z);
  const rbox = (w, h, d, r, m, x, y, z, p = root) => mk(new RoundedBoxGeometry(w, h, d, 2, r), m, p, x, y, z);

  // floor: warm planks over a slab whose cut front face shows (the dollhouse cut)
  const floorTex = canvasTex(256, 256, (g, w, h) => { g.fillStyle = '#9a7552'; g.fillRect(0, 0, w, h); const r = rng(2); for (let y = 0; y < h; y += 32) { g.fillStyle = `hsl(28,${34 + r() * 10}%,${38 + r() * 9}%)`; g.fillRect(0, y, w, 30); for (let x = (y / 32) % 2 ? 0 : 64; x < w; x += 128) { g.fillStyle = 'rgba(0,0,0,.12)'; g.fillRect(x, y, 2, 30); } } }, [5, 4]);
  const floor = mk(new THREE.PlaneGeometry(7.2, 5.2), new THREE.MeshStandardMaterial({ map: floorTex, roughness: 0.55 }), root, 0, 0, 0); floor.rotation.x = -Math.PI / 2; floor.castShadow = false;
  const slabTex = canvasTex(512, 64, (g, w, h) => { g.fillStyle = '#d9d4cb'; g.fillRect(0, 0, w, h); g.fillStyle = '#b9b2a6'; g.fillRect(0, 0, w, 8); g.fillStyle = '#f2c230'; g.fillRect(0, 30, w, h - 30); g.fillStyle = '#222'; for (let x = -32; x < w; x += 48) { g.beginPath(); g.moveTo(x, h); g.lineTo(x + 22, h); g.lineTo(x + 46, 30); g.lineTo(x + 24, 30); g.fill(); } }, [6, 1]);
  const slab = box(7.4, 0.42, 5.3, [mat(0xd9d4cb, 0.8), mat(0xd9d4cb, 0.8), mat(0xd9d4cb, 0.8), mat(0xd9d4cb, 0.8), new THREE.MeshStandardMaterial({ map: slabTex, roughness: 0.8 }), mat(0xd9d4cb, 0.8)], 0, -0.215, 0);
  slab.receiveShadow = true;
  const wallM = mat(0xeee8dd, 0.92), trim = mat(0x3a3d42, 0.45);
  box(0.12, 2.9, 5.2, wallM, -3.56, 1.45, 0); box(0.12, 2.9, 5.2, wallM, 3.56, 1.45, 0);
  box(7.3, 0.1, 5.3, mat(0xf4f2ee, 0.95), 0, 2.95, 0);
  for (const s of [-1, 1]) box(0.14, 0.12, 5.2, trim, s * 3.48, 0.06, 0);   // skirting

  // back wall: skyline windows left + right, a solid panel in the middle that carries the wall screen
  const sky = new THREE.Mesh(new THREE.PlaneGeometry(14, 5.2), new THREE.MeshBasicMaterial({ toneMapped: false, map: canvasTex(1024, 380, (g, w, h) => {
    const gr = g.createLinearGradient(0, 0, 0, h); gr.addColorStop(0, '#7cb6ea'); gr.addColorStop(1, '#e2eef6'); g.fillStyle = gr; g.fillRect(0, 0, w, h);
    const r = rng(4); for (let x = 0; x < w;) { const bw = 36 + r() * 70, bh = 90 + r() * 220; g.fillStyle = `hsl(${205 + r() * 20},${16 + r() * 14}%,${58 + r() * 18}%)`; g.fillRect(x, h - bh, bw, bh); g.fillStyle = 'rgba(255,255,255,.35)'; for (let y = h - bh + 8; y < h; y += 14) for (let xx = x + 5; xx < x + bw - 6; xx += 11) g.fillRect(xx, y, 6, 7); x += bw + 4; }
  }) }));
  sky.position.set(0, 1.5, -4.6); root.add(sky);
  for (const s of [-1, 1]) {
    for (let k = 0; k <= 2; k++) box(0.08, 2.9, 0.1, trim, s * (1.1 + k * 1.2), 1.45, -2.6);
    box(2.5, 0.12, 0.12, trim, s * 2.3, 0.06, -2.6); box(2.5, 0.12, 0.12, trim, s * 2.3, 2.84, -2.6);
  }
  const panelM = mat(new THREE.Color(C.wall ?? 0x3a414d), 0.6);
  box(2.2, 2.9, 0.1, panelM, 0, 1.45, -2.62);

  // the wall screen: a canvas the ad redraws (terminal, chat, a screenshot, the logo) inside a dark bezel
  const S = D.screen;
  const wall = addWallScreen(root, S, C);

  // the standing desk: top, metal legs, a modesty panel that hides Gary's legs, a nameplate facing the lens
  const [dx, dz] = D.desk, wood = mat(0x6a4630, 0.45), steel = mat(0x2a2d33, 0.35, { metalness: 0.5 });
  rbox(D.deskW, 0.06, D.deskD, 0.02, wood, dx, D.deskTop - 0.03, dz);
  for (const s of [-1, 1]) { box(0.06, D.deskTop - 0.06, 0.06, steel, dx + s * (D.deskW / 2 - 0.12), (D.deskTop - 0.06) / 2, dz); box(0.08, 0.04, D.deskD * 0.9, steel, dx + s * (D.deskW / 2 - 0.12), 0.02, dz); }
  box(D.deskW - 0.12, 0.5, 0.03, mat(0x5a3a26, 0.5), dx, D.deskTop - 0.33, dz + D.deskD / 2 - 0.03);
  const plateTex = canvasTex(512, 96, (g, w, h) => { g.fillStyle = '#c9a25a'; g.fillRect(0, 0, w, h); g.fillStyle = '#1d1d22'; g.font = 'bold 44px Helvetica, Arial, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(String(opts.nameplate || 'GARY · FOUNDER').toUpperCase().slice(0, 22), w / 2, h / 2 + 2); });
  const plate = mk(new THREE.PlaneGeometry(0.62, 0.116), new THREE.MeshStandardMaterial({ map: plateTex, roughness: 0.3, metalness: 0.4 }), root, dx, D.deskTop - 0.2, dz + D.deskD / 2 + 0.002);

  // the laptop: base on the desk, the lid tilted toward Gary; its back (toward us) carries the brand's logo
  const laptop = addLaptop(root, [D.laptop[0], D.deskTop, D.laptop[1]], opts.logo, C);

  // desk clutter: a mug, a little plant, sticky notes
  const mug = new THREE.Group(); mug.position.set(dx + 0.66, D.deskTop, dz + 0.12); root.add(mug);
  mk(new THREE.CylinderGeometry(0.045, 0.04, 0.1, 14), mat(new THREE.Color(C.primary).lerp(new THREE.Color(0xffffff), 0.15), 0.4), mug, 0, 0.05, 0);
  mk(new THREE.TorusGeometry(0.028, 0.008, 6, 12), mat(new THREE.Color(C.primary), 0.4), mug, 0.05, 0.05, 0).rotation.y = Math.PI / 2;
  const pot = new THREE.Group(); pot.position.set(dx - 0.74, D.deskTop, dz - 0.15); root.add(pot);
  mk(new THREE.CylinderGeometry(0.06, 0.045, 0.09, 12), mat(0xd8cfc0, 0.6), pot, 0, 0.045, 0);
  for (let k = 0; k < 6; k++) { const lf = mk(new THREE.SphereGeometry(0.05, 8, 6), mat(0x4f8a3e, 0.8), pot, Math.sin(k * 2.3) * 0.035, 0.13 + (k % 2) * 0.04, Math.cos(k * 2.3) * 0.035); lf.scale.set(0.5, 1.4, 0.3); lf.rotation.z = Math.sin(k) * 0.6; }
  const noteCols = ['#ffe066', '#ff9ec7', '#8ce3ff'];
  for (let k = 0; k < 3; k++) { const n = mk(new THREE.PlaneGeometry(0.075, 0.075), mat(new THREE.Color(noteCols[k]), 0.8), root, dx - 0.55 + k * 0.1, D.deskTop - 0.12 - (k % 2) * 0.08, dz + D.deskD / 2 + 0.004); n.rotation.z = (k - 1) * 0.15; n.castShadow = false; }

  // a server rack (left of the screen) with blinking LEDs, a big plant (right), a poster on the right wall
  const rack = new THREE.Group(); rack.position.set(-1.75, 0, -2.2); root.add(rack);
  rbox(0.62, 1.9, 0.6, 0.03, mat(0x1f2228, 0.4, { metalness: 0.3 }), 0, 0.95, 0, rack);
  const leds = [];
  for (let u = 0; u < 9; u++) {
    box(0.54, 0.16, 0.02, mat(0x30343c, 0.35, { metalness: 0.4 }), 0, 0.22 + u * 0.19, 0.305, rack);
    for (let l = 0; l < 4; l++) { const led = mk(new THREE.SphereGeometry(0.012, 6, 4), new THREE.MeshBasicMaterial({ color: [0x46e07a, 0x46e07a, 0xffb43c, 0x6ac8ff][l], toneMapped: false }), rack, -0.2 + l * 0.05, 0.22 + u * 0.19, 0.318); leds.push({ led, ph: R() * 10, rate: 2 + R() * 7 }); }
  }
  const big = new THREE.Group(); big.position.set(1.85, 0, -2.15); root.add(big);
  mk(new THREE.CylinderGeometry(0.24, 0.18, 0.42, 14), mat(0xf4f1ea, 0.5), big, 0, 0.21, 0);
  for (let k = 0; k < 10; k++) { const lf = mk(new THREE.SphereGeometry(0.24, 10, 8), mat(0x3f7a3a, 0.8), big, Math.sin(k * 2.4) * 0.2, 0.7 + (k % 3) * 0.22, Math.cos(k * 2.4) * 0.2); lf.scale.set(0.45, 1.6, 0.25); lf.rotation.z = Math.sin(k) * 0.6; }
  const poster = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 1.2), new THREE.MeshStandardMaterial({ roughness: 0.7, map: canvasTex(360, 480, (g, w, h) => {
    g.fillStyle = hex(C.screenBg ?? 0x1d2433); g.fillRect(0, 0, w, h);
    if (opts.logo) drawContain(g, opts.logo, w / 2 - 90, 70, 180, 180);
    g.fillStyle = hex(C.screenFg ?? 0xffffff); g.font = 'bold 34px Helvetica, Arial, sans-serif'; g.textAlign = 'center';
    wrap(g, String(opts.poster || brand.name || ''), w / 2, 320, w - 60, 40);
  }) }));
  poster.position.set(3.49, 1.6, -0.9); poster.rotation.y = -Math.PI / 2; root.add(poster);
  const clock = new THREE.Mesh(new THREE.CircleGeometry(0.18, 32), new THREE.MeshStandardMaterial({ map: canvasTex(128, 128, (g) => { g.fillStyle = '#fff'; g.beginPath(); g.arc(64, 64, 60, 0, 7); g.fill(); g.strokeStyle = '#222'; g.lineWidth = 6; g.stroke(); g.lineCap = 'round'; g.beginPath(); g.moveTo(64, 64); g.lineTo(64, 30); g.stroke(); g.beginPath(); g.moveTo(64, 64); g.lineTo(88, 72); g.stroke(); }), roughness: 0.5 }));
  clock.position.set(-3.49, 2.1, 0.4); clock.rotation.y = Math.PI / 2; root.add(clock);

  // lights: window daylight from behind, a soft key from the lens side (faces), the ceiling panel, a warm fill
  const hemi = new THREE.HemisphereLight(0xeaf3ff, 0x7a6450, 1.15); root.add(hemi);
  const sun = new THREE.DirectionalLight(0xfff2e0, 1.4); sun.position.set(2.5, 6, -7); sun.target.position.set(0, 0, 0); root.add(sun, sun.target);
  const key = new THREE.DirectionalLight(0xfff6ec, 2.1); key.position.set(-2.2, 5.5, 6); key.target.position.set(0, 0.8, -1.2); root.add(key, key.target);
  key.castShadow = true; key.shadow.mapSize.set(2048, 2048); key.shadow.bias = -0.0004; Object.assign(key.shadow.camera, { left: -4.5, right: 4.5, top: 4.5, bottom: -4.5, near: 1, far: 22 });
  const ceil = new THREE.PointLight(0xfff6ea, 3.5, 7, 1.5); ceil.position.set(0, 2.7, -0.4); root.add(ceil);
  root.traverse((o) => { if (o.isMesh && (o.material.isMeshBasicMaterial || o.material.transparent)) o.castShadow = false; });

  return {
    root, D,
    screen: wall, laptop,
    // the one station: the developer behind the standing desk, the wall screen behind him (see codead.js)
    stations: {
      hero: {
        x: D.gary[0], y: 0, z: D.gary[1], rotY: 0, top: D.deskTop, laptop, laptopAt: D.laptop, button: D.button, strip: [0.55, -1.52], crate: D.crate,
        orbit: { cx: 0.05, cz: -0.42, rx: 1.0, rz: 0.2, w: 0.7 }, money: [[0.62, D.deskTop, -1.45], [-0.66, D.deskTop, -1.5], [1.25, 0, -1.55]],
        screen: { ...D.screen, ...wall },
      },
    },
    update(t) { for (const L of leds) L.led.visible = Math.sin(t * L.rate + L.ph) > -0.3; },
  };
}

/** A wall screen at S {x, y, z, w, h} facing +z: a dark bezel, a 1280x720 canvas the ad redraws, a glow on the room. */
export function addWallScreen(root, S, C, opts = {}) {
  const rbox = (w, h, d, r, m, x, y, z) => mk(new RoundedBoxGeometry(w, h, d, 2, r), m, root, x, y, z);
  if (opts.bezel !== false) rbox(S.w + 0.1, S.h + 0.1, 0.06, 0.02, mat(0x15171b, 0.35), S.x, S.y, S.z - 0.04);
  const scv = document.createElement('canvas'); scv.width = 1280; scv.height = 720;
  const stex = new THREE.CanvasTexture(scv); stex.colorSpace = THREE.SRGBColorSpace; stex.anisotropy = 8;
  const mesh = mk(new THREE.PlaneGeometry(S.w, S.h), new THREE.MeshBasicMaterial({ map: stex, toneMapped: false }), root, S.x, S.y, S.z);
  if (opts.rotY) mesh.rotation.y = opts.rotY;
  mesh.castShadow = false; mesh.receiveShadow = false;
  const glow = new THREE.PointLight(new THREE.Color(C.screenBg ?? 0x1d2433).lerp(new THREE.Color(0xffffff), 0.4), opts.glow ?? 0.9, opts.glowRange ?? 3.2, 2); glow.position.set(S.x, S.y - 0.2, S.z + 0.6); root.add(glow);
  return { canvas: scv, ctx: scv.getContext('2d'), tex: stex, mesh, glow };
}

/** A laptop on a surface at p [x, y, z], open toward -z (the person behind it), the brand's logo on the lid's back. */
export function addLaptop(root, p, logoImg, C) {
  const rbox = (w, h, d, r, m, x, y, z, parent) => mk(new RoundedBoxGeometry(w, h, d, 2, r), m, parent, x, y, z);
  const lap = new THREE.Group(); lap.position.set(p[0], p[1], p[2]); lap.rotation.y = Math.PI; root.add(lap);
  const alu = mat(0xb8bcc2, 0.3, { metalness: 0.55 });
  const base = rbox(0.42, 0.018, 0.29, 0.006, alu, 0, 0.009, 0, lap);
  const hinge = new THREE.Group(); hinge.position.set(0, 0.018, -0.14); lap.add(hinge);
  const lid = new THREE.Group(); hinge.add(lid); lid.rotation.x = -0.32;
  rbox(0.42, 0.28, 0.012, 0.006, alu, 0, 0.14, 0, lid);
  const logo = mk(new THREE.PlaneGeometry(0.11, 0.11), new THREE.MeshBasicMaterial({ transparent: true, toneMapped: false, map: logoTexture(logoImg, C) }), lid, 0, 0.15, -0.0075);
  logo.rotation.y = Math.PI; logo.castShadow = false;
  const screen = mk(new THREE.PlaneGeometry(0.38, 0.24), new THREE.MeshBasicMaterial({ color: new THREE.Color(C.screenBg ?? 0x1d2433).lerp(new THREE.Color(0x6aa8ff), 0.25), toneMapped: false }), lid, 0, 0.14, 0.0065);
  screen.castShadow = false;
  return { g: lap, lid, hinge, base, logo, screen };
}

/** The brand's logo on a transparent square (contained), or its initial on a brand-coloured disc. */
export function logoTexture(img, C, size = 256, bg = null) {
  return canvasTex(size, size, (g, w, h) => {
    if (bg) { g.fillStyle = bg; g.fillRect(0, 0, w, h); }
    if (img) drawContain(g, img, w * 0.08, h * 0.08, w * 0.84, h * 0.84);
    else { g.fillStyle = hex(C.accent ?? 0xffc21a); g.beginPath(); g.arc(w / 2, h / 2, w * 0.42, 0, 7); g.fill(); }
  });
}

export function drawContain(g, img, x, y, w, h) {
  const iw = img.naturalWidth || img.width || 1, ih = img.naturalHeight || img.height || 1, s = Math.min(w / iw, h / ih);
  g.drawImage(img, x + (w - iw * s) / 2, y + (h - ih * s) / 2, iw * s, ih * s);
}

export function wrap(g, text, x, y, maxW, lh) {
  const words = text.split(/\s+/); let line = '', yy = y;
  for (const w of words) { const t = line ? line + ' ' + w : w; if (g.measureText(t).width > maxW && line) { g.fillText(line, x, yy); line = w; yy += lh; } else line = t; }
  if (line) g.fillText(line, x, yy);
  return yy;
}
