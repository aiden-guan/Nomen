// Lookdev for the code-ad cast (engine/cast.js): both characters under neutral studio light, one camera preset per second
// of t, for stills (story.json { lookdev: { logo, logoOnLight, brandName, rival } }). Not used in ads.
import * as THREE from 'three';
import { makeCast, headHeight } from './cast.js';
import { mk, mat } from './core.js';

const loadImage = (src) => new Promise((res) => { if (!src) return res(null); const im = new Image(); im.onload = () => res(im); im.onerror = () => res(null); im.src = src; });

export async function build(studio, story) {
  const { scene, camera } = studio, L = story.lookdev || {};
  await document.fonts.load('400 60px "Luckiest Guy"');
  scene.background = new THREE.Color(0x3b414c); camera.near = 0.05; camera.far = 60;
  const logo = await loadImage(L.logo), logoOnLight = await loadImage(L.logoOnLight);
  const floor = mk(new THREE.CircleGeometry(9, 48), mat(0x7d838e, 0.85), scene, 0, 0, 0); floor.rotation.x = -Math.PI / 2;
  scene.add(new THREE.HemisphereLight(0xeef4ff, 0x5a4c40, 1.1));
  const key = new THREE.DirectionalLight(0xfff3e6, 2.3); key.position.set(-2.2, 5, 6); key.castShadow = true; key.shadow.mapSize.set(2048, 2048);
  Object.assign(key.shadow.camera, { left: -3, right: 3, top: 3, bottom: -3, near: 1, far: 20 }); scene.add(key);
  const rim = new THREE.DirectionalLight(0xbcd6ff, 1.3); rim.position.set(3, 4, -5); scene.add(rim);
  const chad = makeCast('chad', { logo, logoOnLight, brandName: L.brandName || 'Naïve' });
  const chud = makeCast('chud', { rivalName: L.rival || 'THE OLD WAY' });
  scene.add(chad.toon.root, chud.toon.root);
  const CX = 0.66, UX = -0.7, HC = headHeight(chad.toon), HU = headHeight(chud.toon);
  const face = (x, h, yaw = 0, d = 2.3) => ({ pos: [x + Math.sin(yaw) * d, h + 0.04, Math.cos(yaw) * d], look: [x, h - 0.03, 0], fov: 30 });
  const both = { pos: [0, 1.05, 6.6], look: [0, 0.78, 0], fov: 34 };
  const SHOTS = [
    both,
    face(CX, HC), face(CX, HC, 0.65), { pos: [CX + 1.9, 1.15, 3.4], look: [CX, 0.8, 0], fov: 34 },
    face(UX, HU), face(UX, HU, -0.65), { pos: [UX - 1.9, 1.15, 3.4], look: [UX, 0.75, 0], fov: 34 },
    { ...both, chad: { armL: { x: 0, z: 2.6, el: 0.2 }, armR: { x: 0, z: 2.6, el: 0.2 }, mouth: 'grin' }, chud: { eyes: 'x', mouth: 'scream', armL: { x: 0.6, z: 2.3, el: 0.5 }, armR: { x: 0.6, z: 2.3, el: 0.5 } } },
    { pos: [0, 1.5, -6.2], look: [0, 0.9, 0], fov: 34 },
  ];
  function update(t) {
    const s = SHOTS[Math.max(0, Math.min(SHOTS.length - 1, Math.floor(t + 1e-6)))];
    chad.toon.set({ x: CX, t, ...chad.face, ...(s.chad || {}) });
    chud.toon.set({ x: UX, t, ...chud.face, ...(s.chud || {}) });
    studio.setCamera(s.pos, s.look, s.fov, t, 0);
  }
  return { update, qc: () => [] };
}
