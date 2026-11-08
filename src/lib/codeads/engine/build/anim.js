// Build-genre animation helpers (docs/BUILD.md). Everything is a pure function of t — no state between frames, so any
// frame renders on its own (stills, ranges) and renders stay deterministic.
import * as THREE from 'three';
import { clamp, lerp } from '../core.js';

export const u01 = (t, a, b) => clamp((t - a) / (b - a));
export const easeOutBack = (u, s = 1.9) => { u = clamp(u); return 1 + (s + 1) * Math.pow(u - 1, 3) + s * Math.pow(u - 1, 2); };
export const easeInQuad = (u) => clamp(u) ** 2;
export function easeOutBounce(u) {
  u = clamp(u); const n = 7.5625, d = 2.75;
  if (u < 1 / d) return n * u * u;
  if (u < 2 / d) return n * (u -= 1.5 / d) * u + 0.75;
  if (u < 2.5 / d) return n * (u -= 2.25 / d) * u + 0.9375;
  return n * (u -= 2.625 / d) * u + 0.984375;
}

/** Pop-in scale: 0 before t0, overshoots, settles to 1 (the build genre's "it just appears" move). */
export const pop = (t, t0, dur = 0.32) => (t < t0 ? 0 : easeOutBack((t - t0) / dur, 2.4));
/** Pop-out: 1 until t0, then shrinks to 0. */
export const unpop = (t, t0, dur = 0.2) => (t < t0 ? 1 : 1 - clamp((t - t0) / dur) ** 2);
/** Height above rest for something dropped from h at t0 that lands at t0+dur and bounces twice. */
export function drop(t, t0, h = 4, dur = 0.45) {
  if (t < t0) return h;
  const a = t - t0;
  if (a < dur) return h * (1 - (a / dur) ** 2);
  const b = a - dur, b1 = 0.28, b2 = 0.14;
  if (b < b1) return h * 0.07 * Math.sin(Math.PI * b / b1);
  if (b < b1 + b2) return h * 0.02 * Math.sin(Math.PI * (b - b1) / b2);
  return 0;
}
/** Squash-and-stretch after an impact at tHit: returns [sideways scale, vertical scale]. */
export function squash(t, tHit, amt = 0.28) {
  const a = t - tHit; if (a < 0) return [1, 1];
  const k = amt * Math.exp(-a * 8) * Math.cos(a * 24);
  return [1 + k * 0.55, 1 - k];
}
/** A wobble that dies out (springy settle), e.g. rotation after a hit. */
export const wobble = (t, t0, amp = 0.2, f = 14, d = 5) => (t < t0 ? 0 : amp * Math.exp(-(t - t0) * d) * Math.sin((t - t0) * f));

const hash = (n) => { const s = Math.sin(n * 127.1 + 311.7) * 43758.5453; return s - Math.floor(s); };
const vnoise = (x) => { const i = Math.floor(x), f = x - i, u = f * f * (3 - 2 * f); return lerp(hash(i), hash(i + 1), u) * 2 - 1; };
/** Camera shake from impacts: hits = [[t, amp(m), dur(s)], ...] → {x, y, r} offsets (deterministic noise). */
export function shake(t, hits) {
  let x = 0, y = 0, r = 0;
  for (const [t0, amp, dur = 0.6] of hits) {
    const a = t - t0; if (a < 0 || a > dur) continue;
    const e = amp * (1 - a / dur) ** 2;
    x += e * vnoise(a * 31 + t0 * 7); y += e * vnoise(a * 29 + t0 * 13 + 50); r += e * 0.06 * vnoise(a * 23 + t0 * 3 + 90);
  }
  return { x, y, r };
}

/**
 * Beat clock from story.json (tools/narrate.py). B.T(id) = {t0,t1,s0,s1}, B.lt(t,id) = seconds into the beat,
 * B.u(t,id) = 0..1 through the beat, B.W(id, word, nth) = when that word is spoken (absolute s), B.at(t) = current beat id.
 * Author every gag against B.W(...) so a re-voiced narration (scratch → ElevenLabs) keeps it on its word.
 */
export function beatClock(story) {
  const T = (id) => { const b = story.beats[id]; if (!b) throw new Error('no beat ' + id); return b; };
  const norm = (w) => String(w).toLowerCase().replace(/[^a-z0-9]/g, '');
  return {
    T, order: story.order,
    lt: (t, id) => t - T(id).t0,
    u: (t, id) => clamp((t - T(id).t0) / (T(id).t1 - T(id).t0)),
    in: (t, id) => t >= T(id).t0 && t < T(id).t1,
    W(id, word, nth = 1) {
      const hits = T(id).w.filter((w) => w[0] === norm(word));
      if (hits.length < nth) throw new Error(`word "${word}" not in beat ${id}`);
      return hits[nth - 1][1];
    },
    WE(id, word, nth = 1) { const hits = T(id).w.filter((w) => w[0] === norm(word)); return hits[nth - 1][2]; },
    at(t) { let cur = story.order[0]; for (const id of story.order) if (t >= T(id).t0) cur = id; return cur; },
  };
}

/**
 * Camera director: shots = [{t0, t1?, pos: [[t,[x,y,z]],...] | [x,y,z], look: same, fov: number | [[t,f],...]}] in absolute
 * time, sorted. A shot runs until the next one starts (a hard cut). Keys inside a shot are eased. Returns {pos, look, fov}.
 */
export function camAt(t, shots, K3) {
  let s = shots[0];
  for (const sh of shots) if (t >= sh.t0) s = sh;
  const ev = (v) => (Array.isArray(v) && Array.isArray(v[0]) ? K3(t, v) : v);
  const evf = (v) => (Array.isArray(v) ? K3(t, v.map(([a, b]) => [a, [b]]))[0] : v);
  return { pos: ev(s.pos), look: ev(s.look), fov: evf(s.fov ?? 40), shot: s };
}

/** Make a soft round radial-gradient sprite texture (dust, glow, smoke). */
export function softTex(rgb = '255,255,255', size = 128, hard = 0.0) {
  const c = document.createElement('canvas'); c.width = c.height = size; const g = c.getContext('2d');
  const gr = g.createRadialGradient(size / 2, size / 2, size * 0.5 * hard, size / 2, size / 2, size / 2);
  gr.addColorStop(0, `rgba(${rgb},1)`); gr.addColorStop(0.55, `rgba(${rgb},.55)`); gr.addColorStop(1, `rgba(${rgb},0)`);
  g.fillStyle = gr; g.fillRect(0, 0, size, size);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}
