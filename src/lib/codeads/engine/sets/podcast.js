// SET: a podcast studio (Nomen code ads): the clip format. Acoustic foam on the walls, a neon sign with the brand's
// name, a TV behind the host (the screen), a round table with a boom-arm microphone in front of the lead's mouth and a
// second, empty one across, warm practicals. The lead sits on a stool in on-ear headphones, typing on a laptop on the
// table. Room x ∈ [-3.5, 3.5], z ∈ [-2.6, 2.2], the camera on +z.
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mat, mk, canvasTex, rng } from '../core.js';
import { addWallScreen, addLaptop } from './devoffice.js';

export function buildPodcast(studio, opts = {}) {
  const { scene } = studio;
  const root = new THREE.Group(); scene.add(root);
  scene.background = new THREE.Color(0x15161b);
  const brand = opts.brand || {}, C = { primary: 0x2f6fd6, accent: 0xffc21a, ...(brand.colors || {}) };
  const accent = new THREE.Color(C.accent ?? 0xffc21a);
  const box = (w, h, d, m, x, y, z, p = root) => mk(new THREE.BoxGeometry(w, h, d), m, p, x, y, z);
  const rbox = (w, h, d, r, m, x, y, z, p = root) => mk(new RoundedBoxGeometry(w, h, d, 2, r), m, p, x, y, z);

  // floor: a dark rug on dark boards; the slab's cut face
  const boards = canvasTex(256, 256, (g, w, h) => { g.fillStyle = '#3b2a20'; g.fillRect(0, 0, w, h); const r = rng(3); for (let y = 0; y < h; y += 32) { g.fillStyle = `hsl(22,${30 + r() * 10}%,${18 + r() * 6}%)`; g.fillRect(0, y, w, 30); } }, [5, 4]);
  const floor = mk(new THREE.PlaneGeometry(7.2, 4.8), new THREE.MeshStandardMaterial({ map: boards, roughness: 0.6 }), root, 0, 0, -0.2); floor.rotation.x = -Math.PI / 2; floor.castShadow = false;
  box(7.4, 0.42, 4.9, mat(0x8f8a84, 0.85), 0, -0.215, -0.2);
  const rug = mk(new THREE.CircleGeometry(1.5, 40), new THREE.MeshStandardMaterial({ color: 0x5a2e2a, roughness: 1 }), root, 0, 0.004, -1.3); rug.rotation.x = -Math.PI / 2; rug.scale.set(1.3, 0.8, 1); rug.receiveShadow = true;
  // acoustic foam: a wedge pattern on the back wall and the sides
  const foam = canvasTex(256, 256, (g, w, h) => { g.fillStyle = '#25262d'; g.fillRect(0, 0, w, h); for (let y = 0; y < h; y += 32) for (let x = 0; x < w; x += 32) { const gr = g.createLinearGradient(x, y, x + ((x + y) / 32 % 2 ? 32 : 0), y + ((x + y) / 32 % 2 ? 0 : 32)); gr.addColorStop(0, '#383a44'); gr.addColorStop(1, '#17181d'); g.fillStyle = gr; g.fillRect(x + 1, y + 1, 30, 30); } }, [8, 3]);
  const foamM = new THREE.MeshStandardMaterial({ map: foam, roughness: 1 });
  box(7.2, 3.0, 0.12, foamM, 0, 1.5, -2.66);
  for (const s of [-1, 1]) box(0.12, 3.0, 4.8, foamM, s * 3.56, 1.5, -0.2);
  // the neon sign: the brand's name in its accent colour, glowing, above the TV
  const name = String(brand.name || 'ON AIR');
  const neon = canvasTex(1024, 256, (g, w, h) => { g.clearRect(0, 0, w, h); g.font = `400 150px "Luckiest Guy", Impact, sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.shadowColor = '#' + accent.getHexString(); g.shadowBlur = 40; g.fillStyle = '#ffffff'; g.fillText(name.toUpperCase().slice(0, 14), w / 2, h / 2 + 8); g.shadowBlur = 0; g.lineWidth = 6; g.strokeStyle = '#' + accent.getHexString(); g.strokeText(name.toUpperCase().slice(0, 14), w / 2, h / 2 + 8); });
  const sign = mk(new THREE.PlaneGeometry(2.0, 0.5), new THREE.MeshBasicMaterial({ map: neon, transparent: true, toneMapped: false }), root, 0, 2.62, -2.58); sign.castShadow = false;
  const neonLight = new THREE.PointLight(accent.getHex(), 3, 4, 1.6); neonLight.position.set(0, 2.5, -2.2); root.add(neonLight);
  // the TV on the wall behind the host
  const SA = { x: 0, y: 1.72, z: -2.55, w: 1.84, h: 1.035 };
  const screen = addWallScreen(root, SA, C, { glow: 0.8 });
  // the round table, the lead's laptop, two boom-arm mics (his in front of his mouth), a mug, a stool
  const top = 0.64, tz = -1.3;
  mk(new THREE.CylinderGeometry(0.75, 0.75, 0.05, 40), mat(0x6b4a32, 0.45), root, 0, top - 0.025, tz).scale.set(1.3, 1, 0.75);
  mk(new THREE.CylinderGeometry(0.06, 0.08, top - 0.05, 12), mat(0x1c1d21, 0.4, { metalness: 0.5 }), root, 0, (top - 0.05) / 2, tz);
  mk(new THREE.CylinderGeometry(0.35, 0.38, 0.03, 24), mat(0x1c1d21, 0.4, { metalness: 0.5 }), root, 0, 0.015, tz);
  const laptop = addLaptop(root, [0.14, top, -1.36], opts.logo, C);
  const metal = mat(0x2a2c31, 0.35, { metalness: 0.6 }), mic = mat(0x15161a, 0.3, { metalness: 0.4 });
  const boomMic = (x, z, toward) => {
    const g = new THREE.Group(); g.position.set(x, top, z); root.add(g);
    mk(new THREE.CylinderGeometry(0.03, 0.04, 0.05, 12), metal, g, 0, 0.025, 0);
    const arm1 = mk(new THREE.CylinderGeometry(0.012, 0.012, 0.42, 8), metal, g, 0, 0.23, 0); arm1.rotation.z = 0.05;
    const arm2 = mk(new THREE.CylinderGeometry(0.012, 0.012, 0.36, 8), metal, g, 0, 0.44, toward * 0.17); arm2.rotation.x = toward * 1.25;
    const head = mk(new THREE.CapsuleGeometry(0.045, 0.1, 6, 12), mic, g, 0, 0.42, toward * 0.36); head.rotation.x = toward * 1.1;
    mk(new THREE.TorusGeometry(0.05, 0.006, 6, 18), metal, g, 0, 0.42, toward * 0.36).rotation.x = toward * 1.1 + Math.PI / 2;
    return g;
  };
  boomMic(0.32, -1.25, -1);
  boomMic(-0.2, -0.98, 1);
  mk(new THREE.CylinderGeometry(0.045, 0.04, 0.1, 14), mat(new THREE.Color(C.primary ?? 0x2f6fd6), 0.4), root, -0.48, top + 0.05, -1.2);
  // light: warm practicals (two lamps), a soft key from the lens side, the neon
  for (const s of [-1, 1]) { const lamp = new THREE.Group(); lamp.position.set(s * 2.2, 0, -2.1); root.add(lamp); mk(new THREE.CylinderGeometry(0.015, 0.015, 1.5, 8), metal, lamp, 0, 0.75, 0); mk(new THREE.CylinderGeometry(0.16, 0.24, 0.26, 18, 1, true), new THREE.MeshStandardMaterial({ color: 0xf2dcb8, roughness: 0.8, side: THREE.DoubleSide, emissive: 0xffc98a, emissiveIntensity: 0.6 }), lamp, 0, 1.55, 0); const L = new THREE.PointLight(0xffc98a, 2.6, 4, 1.6); L.position.set(0, 1.5, 0); lamp.add(L); }
  root.add(new THREE.HemisphereLight(0xd8def0, 0x2a221e, 0.55));
  const key = new THREE.DirectionalLight(0xfff0e0, 1.9); key.position.set(-2.4, 5, 6); key.target.position.set(0, 0.9, -1.6); root.add(key, key.target);
  key.castShadow = true; key.shadow.mapSize.set(2048, 2048); key.shadow.bias = -0.0004; Object.assign(key.shadow.camera, { left: -4, right: 4, top: 4, bottom: -4, near: 1, far: 20 });
  root.traverse((o) => { if (o.isMesh && (o.material.isMeshBasicMaterial || o.material.transparent)) o.castShadow = false; });

  // he sits on a stool: hips up a little, legs bent, the stool under him
  const stool = new THREE.Group(); root.add(stool);
  mk(new THREE.CylinderGeometry(0.2, 0.2, 0.05, 20), mat(0x1c1d21, 0.5), stool, 0, 0.5, 0);
  for (let k = 0; k < 3; k++) { const leg = mk(new THREE.CylinderGeometry(0.015, 0.02, 0.5, 6), metal, stool, Math.cos(k * 2.1) * 0.14, 0.25, Math.sin(k * 2.1) * 0.14); leg.rotation.set(Math.sin(k * 2.1) * 0.2, 0, -Math.cos(k * 2.1) * 0.2); }
  const SEAT = 0.1, STAND = new Set(['celebrate', 'show', 'approve']);
  return {
    root,
    stations: {
      hero: {
        x: 0, y: 0, z: -1.9, rotY: 0, top, laptop, laptopAt: [0.14, -1.36], button: [-0.42, -1.12], strip: [0.48, -1.45], crate: [1.25, -0.45],
        orbit: { cx: 0.1, cz: -0.2, rx: 1.4, rz: 0.3, w: 0.65 }, money: [[0.5, top, -1.3], [-0.55, top, -1.4], [1.35, 0, -1.6]],
        screen: { ...SA, ...screen },
        // on-ear headphones
        attach(toon) {
          const hm = new THREE.MeshStandardMaterial({ color: 0x1b1c20, roughness: 0.35 });
          const band = new THREE.Mesh(new THREE.TorusGeometry(0.29, 0.02, 8, 28, Math.PI), hm); band.position.set(0, 0.04, -0.01); toon.head.add(band);
          for (const s of [-1, 1]) { const cup = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 0.06, 20), hm); cup.rotation.z = Math.PI / 2; cup.position.set(s * 0.27, -0.01, 0); toon.head.add(cup); const pad = new THREE.Mesh(new THREE.CylinderGeometry(0.062, 0.062, 0.02, 20), new THREE.MeshStandardMaterial({ color: accent.getHex(), roughness: 0.5 })); pad.rotation.z = Math.PI / 2; pad.position.set(s * 0.302, -0.01, 0); toon.head.add(pad); }
        },
        // seated on the stool, except when he stands for the payoff, a demo or a button slam
        pose(p, t, gag) {
          stool.position.set(0, 0, -1.92);
          if (STAND.has(gag)) return;
          p.y = (p.y ?? 0) + SEAT; p.legL = { x: -1.45, kn: 1.45 }; p.legR = { x: -1.45, kn: 1.45 }; p.walk = undefined;
        },
      },
    },
    update(t) { neonLight.intensity = 3 * (0.92 + 0.08 * Math.sin(t * 17) * Math.sin(t * 3.1)); },
  };
}
