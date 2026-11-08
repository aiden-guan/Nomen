// Props for Nomen's code ads. makeAgent is ED Studio's makeRoomba (engine/build/factory.js, video 026: the Roomba that
// gets promoted) recoloured in the brand's colours, with a role sign on a mast instead of the chequered flag; the rest are
// new: the brand's crate, a cardboard box with a printed label (piles that bury Gary), the big button (approvals).
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mat, mk, canvasTex } from './core.js';
import { drawContain } from './sets/devoffice.js';

const PI = Math.PI;
const hex = (c) => '#' + new THREE.Color(c).getHexString();
const luma = (c) => { const k = new THREE.Color(c); return 0.2126 * k.r + 0.7152 * k.g + 0.0722 * k.b; };
const ink = (c) => (luma(c) > 0.55 ? '#141414' : '#ffffff');

/** A sign's canvas: bold caps on a coloured plate, fitted to the width. */
function signTex(text, bg, w = 512, h = 160) {
  return canvasTex(w, h, (g) => {
    g.fillStyle = hex(bg); g.beginPath(); g.roundRect(4, 4, w - 8, h - 8, 26); g.fill();
    g.strokeStyle = 'rgba(0,0,0,.35)'; g.lineWidth = 8; g.stroke();
    g.fillStyle = ink(bg); g.textAlign = 'center'; g.textBaseline = 'middle';
    let size = 92; g.font = `400 ${size}px "Luckiest Guy", Impact, sans-serif`;
    while (g.measureText(text).width > w - 50 && size > 30) { size -= 4; g.font = `400 ${size}px "Luckiest Guy", Impact, sans-serif`; }
    g.fillText(text, w / 2, h / 2 + 6);
  });
}

/** An AI agent as a robot vacuum (r ≈ 0.3 m): LED eyes that blink, a role sign on a mast, a tiny hard hat (the boss). */
export function makeAgent({ body = 0x2b2e33, eye = 0x8ef0ff, label = '', sign = 0xffc21a } = {}) {
  const g = new THREE.Group(), Rr = 0.3;
  const shell = mk(new THREE.CylinderGeometry(Rr, Rr, 0.1, 40), mat(body, 0.35), g, 0, 0.06, 0);
  mk(new THREE.CylinderGeometry(Rr * 0.82, Rr * 0.86, 0.012, 40), mat(new THREE.Color(body).lerp(new THREE.Color(0xffffff), 0.12), 0.25), g, 0, 0.115, 0);
  const bump = mk(new THREE.CylinderGeometry(Rr + 0.012, Rr + 0.012, 0.07, 40, 1, true, -PI / 2.2, PI / 1.1), mat(0x8d949c, 0.4), g, 0, 0.055, 0); bump.rotation.y = PI / 2;
  mk(new THREE.CylinderGeometry(0.07, 0.07, 0.02, 20), mat(0xdfe3e8, 0.3), g, 0, 0.125, 0);
  const ring = mk(new THREE.TorusGeometry(0.075, 0.008, 6, 24), new THREE.MeshBasicMaterial({ color: eye, toneMapped: false }), g, 0, 0.13, 0); ring.rotation.x = PI / 2;
  const eyeM = new THREE.MeshBasicMaterial({ color: eye, toneMapped: false });
  const eyes = [-0.08, 0.08].map((z) => { const e = mk(new THREE.SphereGeometry(0.034, 12, 8), eyeM, g, Rr * 0.66, 0.13, z); e.scale.y = 0.65; return e; });
  const hat = new THREE.Group(); g.add(hat); hat.position.set(-Rr * 0.1, 0.13, 0);
  mk(new THREE.CylinderGeometry(0.15, 0.18, 0.08, 18), mat(0xffc21a, 0.35), hat, 0, 0.045, 0); mk(new THREE.CylinderGeometry(0.19, 0.19, 0.012, 18), mat(0xffc21a, 0.35), hat, 0.03, 0.006, 0);
  const mast = new THREE.Group(); g.add(mast); mast.position.set(-Rr * 0.55, 0.12, 0);
  mk(new THREE.CylinderGeometry(0.008, 0.008, 0.4, 6), mat(0x999999), mast, 0, 0.2, 0);
  const plate = mk(new THREE.PlaneGeometry(0.34, 0.106), new THREE.MeshStandardMaterial({ map: signTex(label || 'AGENT', sign), side: THREE.DoubleSide, roughness: 0.6 }), mast, 0, 0.42, 0);
  plate.castShadow = false;
  mast.visible = Boolean(label);
  for (const m of [shell]) m.castShadow = true;
  return {
    g, eyes, hat, mast,
    /** x, z (floor), rotY (+x is its front), t, hat 0..1, scale, spin (extra yaw), hop (m), blinkAt */
    set({ x = 0, z = 0, y = 0, rotY = 0, t = 0, hat: h = 0, scale = 1.2, hop = 0, blinkAt = -9 } = {}) {
      g.position.set(x, y + hop, z); g.rotation.y = rotY; g.scale.setScalar(Math.max(0.001, scale)); g.visible = scale > 0.002;
      hat.visible = h > 0.01; hat.scale.setScalar(Math.max(0.001, h));
      plate.rotation.y = -rotY;   // the sign keeps facing the lens (+z) whichever way the robot drives
      const bl = (t % 3.1) < 0.12 || Math.abs(t - blinkAt) < 0.08; eyes.forEach((e) => (e.scale.y = bl ? 0.12 : 0.65));
    },
  };
}

/** The brand's crate (≈ 0.8 m): its colour, its logo on every side and the name on the front; the lid can fly off. */
export function makeCrate({ color = 0x2f6fd6, logo = null, name = '' } = {}) {
  const g = new THREE.Group(), S = 0.66;
  if (luma(color) < 0.03) color = 0x2a2a2e;   // a black brand still reads as a crate on a wooden floor
  const face = canvasTex(256, 256, (c, w, h) => {
    c.fillStyle = hex(color); c.fillRect(0, 0, w, h);
    c.strokeStyle = 'rgba(255,255,255,.25)'; c.lineWidth = 14; c.strokeRect(10, 10, w - 20, h - 20);
    if (logo) drawContain(c, logo, w * 0.22, h * 0.12, w * 0.56, h * 0.5);
    c.fillStyle = ink(color); c.textAlign = 'center'; c.textBaseline = 'middle';
    let size = 44; c.font = `400 ${size}px "Luckiest Guy", Impact, sans-serif`;
    while (c.measureText(name).width > w - 40 && size > 18) { size -= 2; c.font = `400 ${size}px "Luckiest Guy", Impact, sans-serif`; }
    c.fillText(name.toUpperCase(), w / 2, h * 0.8);
  });
  const side = new THREE.MeshStandardMaterial({ map: face, roughness: 0.55 }), top = mat(new THREE.Color(color).multiplyScalar(0.85), 0.55);
  const body = mk(new RoundedBoxGeometry(S, S * 0.86, S, 2, 0.03), [side, side, top, top, side, side], g, 0, S * 0.43, 0);
  const lid = new THREE.Group(); g.add(lid); lid.position.y = S * 0.86;
  mk(new RoundedBoxGeometry(S + 0.04, 0.1, S + 0.04, 2, 0.03), mat(new THREE.Color(color).multiplyScalar(0.7), 0.5), lid, 0, 0.05, 0);
  return { g, body, lid, S };
}

/** A cardboard box (≈ 0.34 m) with a printed label: the stuff that buries Gary. */
export function makeBox(label = '', seed = 0) {
  const g = new THREE.Group(), s = 0.3 + ((seed * 37) % 7) * 0.012;
  const t = canvasTex(256, 256, (c, w, h) => {
    c.fillStyle = '#c99a62'; c.fillRect(0, 0, w, h); c.fillStyle = '#b8874f'; c.fillRect(0, h * 0.44, w, h * 0.12);
    c.fillStyle = '#2b1d10'; c.textAlign = 'center'; c.textBaseline = 'middle';
    let size = 64; c.font = `400 ${size}px "Luckiest Guy", Impact, sans-serif`;
    while (c.measureText(label).width > w - 30 && size > 22) { size -= 3; c.font = `400 ${size}px "Luckiest Guy", Impact, sans-serif`; }
    c.fillText(label.toUpperCase(), w / 2, h * 0.28);
  });
  const m = new THREE.MeshStandardMaterial({ map: t, roughness: 0.85 });
  mk(new RoundedBoxGeometry(s, s * 0.8, s, 2, 0.015), m, g, 0, s * 0.4, 0);
  return { g, s };
}

/** The big button on a pedestal: a mushroom cap that squashes when slammed. set({ y, press 0..1, scale }). */
export function makeBigButton({ color = 0x2fbf5a, label = 'APPROVE' } = {}) {
  const g = new THREE.Group();
  mk(new THREE.CylinderGeometry(0.16, 0.19, 0.12, 24), mat(0x2a2d33, 0.4, { metalness: 0.3 }), g, 0, 0.06, 0);
  const cap = mk(new THREE.SphereGeometry(0.14, 24, 12, 0, PI * 2, 0, PI / 2), new THREE.MeshStandardMaterial({ color, roughness: 0.25, emissive: color, emissiveIntensity: 0.25 }), g, 0, 0.12, 0);
  cap.scale.y = 0.75;
  const plate = mk(new THREE.PlaneGeometry(0.4, 0.12), new THREE.MeshStandardMaterial({ map: signTex(label, color, 512, 150), roughness: 0.5 }), g, 0, 0.06, 0.2);
  plate.rotation.x = -0.15; plate.castShadow = false;
  return {
    g, cap,
    set({ x = 0, y = 0, z = 0, press = 0, scale = 1 } = {}) {
      g.position.set(x, y, z); g.scale.setScalar(Math.max(0.001, scale)); g.visible = scale > 0.002;
      cap.scale.y = 0.75 * (1 - 0.55 * press); cap.position.y = 0.12 - 0.02 * press;
    },
  };
}
