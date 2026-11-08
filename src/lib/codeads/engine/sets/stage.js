// SET: a launch keynote (Nomen code ads). A black stage with a giant LED wall (the screen), a truss of spotlights with
// beams, brand-coloured light pillars, the lead at a demo table with a headset mic, and the audience's heads in the dark
// in front of the stage (they bob when the room cheers). The camera sits in the audience on +z.
// Stage floor y = 0, front edge z = 1.0; the audience floor is 0.9 m lower. LED wall centre (0, 2.3, -2.9), 2.4 x 1.35,
// between two tall light panels, so a vertical frame holds the wall and the presenter.
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mat, mk, canvasTex, rng } from '../core.js';
import { addWallScreen, addLaptop } from './devoffice.js';

export function buildStage(studio, opts = {}) {
  const { scene } = studio;
  const root = new THREE.Group(); scene.add(root);
  scene.background = new THREE.Color(0x07080c);
  const brand = opts.brand || {}, C = { primary: 0x2f6fd6, accent: 0xffc21a, ...(brand.colors || {}) };
  const accent = new THREE.Color(C.accent ?? 0xffc21a);
  const R = rng(4);
  const box = (w, h, d, m, x, y, z, p = root) => mk(new THREE.BoxGeometry(w, h, d), m, p, x, y, z);
  const rbox = (w, h, d, r, m, x, y, z, p = root) => mk(new RoundedBoxGeometry(w, h, d, 2, r), m, p, x, y, z);

  // the stage: a glossy black deck with an accent strip on its front edge, a black backdrop
  box(12, 0.9, 5.2, mat(0x0d0e12, 0.25, { metalness: 0.2 }), 0, -0.45, -1.6);
  const strip = box(12, 0.035, 0.03, new THREE.MeshBasicMaterial({ color: accent.clone().multiplyScalar(1.6), toneMapped: false }), 0, -0.02, 1.0);
  strip.castShadow = false;
  box(14, 7, 0.2, mat(0x050608, 0.9), 0, 2.6, -3.6);
  // the LED wall in a thin frame, flanked by two light pillars in the brand's accent
  const SA = { x: 0, y: 2.3, z: -2.9, w: 2.4, h: 1.35 };
  box(SA.w + 0.12, SA.h + 0.12, 0.08, mat(0x111216, 0.4), SA.x, SA.y, SA.z - 0.05);
  const screen = addWallScreen(root, SA, C, { bezel: false, glow: 2.2, glowRange: 6 });
  const pillarM = new THREE.MeshBasicMaterial({ color: accent.clone().multiplyScalar(1.3), toneMapped: false });
  for (const s of [-1, 1]) { const p = box(0.12, 3.4, 0.12, pillarM, s * 1.55, 1.7, -2.95); p.castShadow = false; const pan = box(0.9, 2.6, 0.06, new THREE.MeshBasicMaterial({ color: accent.clone().multiplyScalar(0.22), toneMapped: false }), s * 2.25, 1.9, -3.0); pan.castShadow = false; }
  // the truss, its cans and their beams (additive cones, aimed at the lead)
  box(7, 0.18, 0.18, mat(0x2a2c31, 0.4, { metalness: 0.6 }), 0, 4.3, -0.4);
  const beamM = new THREE.MeshBasicMaterial({ color: 0xfff1d6, transparent: true, opacity: 0.022, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false });
  for (const x of [-2.4, 2.4]) {
    rbox(0.22, 0.3, 0.22, 0.04, mat(0x18191d, 0.4), x, 4.1, -0.4);
    const len = 4.4, beam = new THREE.Mesh(new THREE.ConeGeometry(0.55, len, 24, 1, true), beamM);
    const from = new THREE.Vector3(x, 4.0, -0.4), to = new THREE.Vector3(x * 0.25, 0, -1.7), dir = to.clone().sub(from).normalize();
    beam.position.copy(from).addScaledVector(dir, len / 2); beam.quaternion.setFromUnitVectors(new THREE.Vector3(0, -1, 0), dir); beam.castShadow = false; root.add(beam);
  }
  // the demo table: black glass on a slim base, an accent light along its front edge
  const tz = -1.3, top = 0.66;
  rbox(1.5, 0.04, 0.62, 0.015, mat(0x101114, 0.12, { metalness: 0.3 }), 0, top - 0.02, tz);
  box(0.12, top - 0.04, 0.12, mat(0x1b1c20, 0.3, { metalness: 0.5 }), 0, (top - 0.04) / 2, tz);
  box(0.7, 0.03, 0.4, mat(0x1b1c20, 0.3, { metalness: 0.5 }), 0, 0.015, tz);
  const edge = box(1.5, 0.012, 0.012, new THREE.MeshBasicMaterial({ color: accent.clone().multiplyScalar(1.5), toneMapped: false }), 0, top - 0.035, tz + 0.31); edge.castShadow = false;
  const laptop = addLaptop(root, [0.1, top, -1.28], opts.logo, C);
  // the audience: rows of heads and shoulders in the dark below the stage edge
  const crowd = [], skinM = [0x3a2c26, 0x2a201c, 0x4a3a30, 0x1e1a18].map((c) => mat(c, 0.8)), cloth = [0x15161a, 0x1c1e24, 0x22252c, 0x101114].map((c) => mat(c, 0.9));
  for (let row = 0; row < 3; row++) for (let i = 0; i < 9; i++) {
    const g = new THREE.Group(); g.position.set(-3.3 + i * 0.82 + (row % 2) * 0.4 + (R() - 0.5) * 0.15, -0.98 + row * 0.09, 1.45 + row * 0.68); g.scale.setScalar(0.92); root.add(g);
    const sh = mk(new THREE.SphereGeometry(0.26, 12, 8), cloth[(i + row) % 4], g, 0, 0.95, 0); sh.scale.set(1.3, 0.75, 0.8);
    mk(new THREE.SphereGeometry(0.15, 12, 10), skinM[(i * 3 + row) % 4], g, 0, 1.28, 0);
    crowd.push({ g, ph: R() * 6 });
  }
  // light: a cool hemisphere, a warm spot on the lead (shadows), the wall's glow, rim lights from behind
  root.add(new THREE.HemisphereLight(0x9fb2d6, 0x15161a, 0.45));
  const key = new THREE.SpotLight(0xfff0dc, 45, 0, 0.42, 0.5, 1.2); key.position.set(0.8, 6.5, 3.2); key.target.position.set(0, 1.0, -1.8); root.add(key, key.target);
  key.castShadow = true; key.shadow.mapSize.set(2048, 2048); key.shadow.bias = -0.0004;
  const fill = new THREE.DirectionalLight(0xcfd8ff, 0.6); fill.position.set(-4, 3, 5); root.add(fill);
  const face = new THREE.PointLight(0xfff0dc, 4, 7, 1.4); face.position.set(0.3, 1.7, 1.0); root.add(face);   // a soft front light so the presenter's face reads
  for (const s of [-1, 1]) { const rim = new THREE.PointLight(accent.getHex(), 6, 5, 1.5); rim.position.set(s * 2.0, 2.2, -2.7); root.add(rim); }
  root.traverse((o) => { if (o.isMesh && (o.material.isMeshBasicMaterial || o.material.transparent)) o.castShadow = false; });

  for (const c of crowd) c.y0 = c.g.position.y;
  return {
    root,
    stations: {
      hero: {
        x: 0, y: 0, z: -1.86, rotY: 0, top, laptop, laptopAt: [0.1, -1.28], button: [-0.55, -1.12], strip: [0.5, -1.45], crate: [1.25, -0.5],
        orbit: { cx: 0.0, cz: -0.6, rx: 1.6, rz: 0.35, w: 0.65 }, money: [[0.55, top, -1.4], [-0.6, top, -1.45], [1.5, 0, -1.7]],
        screen: { ...SA, ...screen },
        // the keynote look: a small presenter under a giant screen, seen from the seats
        frames: (base, HEAD, SCR) => {
          // from the seats, aimed low enough that the presenter's head sits high in the frame (the caption goes on his chest)
          const seats = (yaw = 0, d = 6.6, h = 1.55, lookY = 0.62) => ({ pos: [Math.sin(yaw) * d, h, -1.86 + Math.cos(yaw) * d], look: [0, lookY, -1.86], fov: 42 });
          return {
            home: (yaw = 0) => seats(yaw),
            floor: (yaw = 0) => seats(yaw * 0.6, 7.2, 1.45, 0.55),
            wide: (yaw = 0) => seats(yaw, 8.6, 1.6, 0.75),
            screen: (yaw = 0) => ({ pos: [SCR[0] + Math.sin(yaw) * 7.0, SCR[1] - 0.35, SCR[2] + Math.cos(yaw) * 7.0], look: [SCR[0], SCR[1] - 0.95, SCR[2]], fov: 40 }),
          };
        },
        // a headset mic on the lead
        attach(toon) {
          const m = new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.4 });
          const boom = new THREE.Mesh(new THREE.TorusGeometry(0.2, 0.006, 6, 20, 1.2), m); boom.position.set(-0.04, -0.05, 0.0); boom.rotation.set(0, Math.PI / 2 - 0.25, Math.PI + 0.3); toon.head.add(boom);
          const mic = new THREE.Mesh(new THREE.SphereGeometry(0.018, 10, 8), m); mic.position.set(-0.075, -0.17, 0.235); toon.head.add(mic);
        },
      },
    },
    update(t) { for (const c of crowd) c.g.position.y = c.y0 + 0.03 * Math.sin(t * 1.1 + c.ph); },
    // the room cheers on the celebration: codead.js calls this with how loud (0..1)
    cheer(t, k) { for (const c of crowd) c.g.position.y = c.y0 + 0.03 * Math.sin(t * 1.1 + c.ph) + k * Math.abs(Math.sin(t * 9 + c.ph)) * 0.16; },
  };
}
