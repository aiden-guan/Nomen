// The code ads' cast, on the build genre's toon rig (build/toon.js).
//   chad  the lead: a top-1 % leading man who lifts. Broad V-shaped torso in a fitted tee with the brand's logo on the
//         chest, a chiselled stubbled jaw, high cheekbones, narrow hooded hunter eyes under thick straight brows, a shaggy
//         wolf cut, an intense stare. He uses the product.
//   chud  the rival: the old way (never a real competitor). Obese, sweating, a stained tee riding up over his gut with
//         the old way's name across it, a greasy comb-over, a neckbeard, taped glasses, flies circling his head.
// Old stories named the developer 'geek' or 'mogger'; they map onto the new cast.
import * as THREE from 'three';
import { makeToon } from './build/toon.js';

export const CAST = {
  chad: {
    look: { skin: 0xe0ad86, shirt: 0x16171b, pants: 0x313a49, shoes: 0xf1f1f1, hair: 0x2b1e17, build: 'buff', face: 'chad', eyeShape: 'hunter', hairStyle: 'wolf', browW: 1.3, iris: 0x5a8fb0, height: 1.06 },
    face: { eyes: 'open', mouth: 'line', brows: -0.15, beard: 0 },
    stoic: true,
  },
  chud: {
    look: { skin: 0xf2d4c4, shirt: 0xebe3cd, pants: 0x868991, shoes: 0x82cc48, hair: 0x3d2d20, beard: 0x3d2d20, build: 'obese', face: 'chud', eyeShape: 'beady', hairStyle: 'balding', glasses: 'round', tape: true, bags: true, neckbeard: true, stains: true, greasy: true, sweat: true, flies: true, armOut: 0.3, height: 0.97 },
    face: { eyes: 'open', mouth: 'slack', brows: 0.35, beard: 0 },
  },
};
const ALIAS = { geek: 'chud', mogger: 'chad' };
export const castName = (name) => (CAST[name] ? name : ALIAS[name] || 'chad');

/** How light a logo's ink is, 0 (dark) … 1 (light), over its opaque pixels; null when it cannot be read. */
export function inkOf(img) {
  if (!img) return null;
  try {
    const c = document.createElement('canvas'); c.width = 64; c.height = 64; const g = c.getContext('2d');
    const iw = img.naturalWidth || img.width || 1, ih = img.naturalHeight || img.height || 1, s = Math.min(64 / iw, 64 / ih);
    g.drawImage(img, (64 - iw * s) / 2, (64 - ih * s) / 2, iw * s, ih * s);
    const d = g.getImageData(0, 0, 64, 64).data; let sum = 0, n = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 128) { sum += (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255; n++; }
    return n ? sum / n : null;
  } catch { return null; }
}

/**
 * A cast member's toon. opts: { logo (for dark grounds), logoOnLight, brandName, rivalName, accent }.
 * Chad's tee is black when the brand has a light logo, white when it only has a dark one; with no logo it says the name.
 * Returns { toon, face (resting expression), stoic, name }.
 */
export function makeCast(name, opts = {}) {
  const key = castName(name), def = CAST[key], look = { ...def.look, accent: opts.accent };
  if (key === 'chad') {
    const light = inkOf(opts.logo), dark = inkOf(opts.logoOnLight), name = opts.brandName || '', font = opts.font || null;
    if (opts.logo && light != null && light > 0.45) look.print = { image: opts.logo, text: name, ink: '#f4f4f4', font };
    else if (opts.logoOnLight && dark != null && dark <= 0.45) { look.shirt = 0xf2f2f0; look.print = { image: opts.logoOnLight, text: name, ink: '#151515', font }; }
    else if (name) look.print = { text: name, ink: '#ffffff' };
  }
  if (key === 'chud') look.print = { text: opts.rivalName || 'THE OLD WAY', ink: '#2a2420' };
  const toon = makeToon(look);
  return { toon, face: { ...def.face }, stoic: !!def.stoic, name: key };
}

/** Where a toon's head sits at rest (world y of its centre), for framing. */
export function headHeight(toon) {
  toon.set({}); toon.root.updateMatrixWorld(true);
  const v = new THREE.Vector3(); toon.head.getWorldPosition(v); return v.y;
}
