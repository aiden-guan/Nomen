// One continuous camera take (docs/BUILD.md → Camera). @wemakebuild's reels have NO cuts: the camera glides, pushes in and
// pulls out between the places the narration names. A rail is a list of keys {t, pos, look, fov, pass?}:
//   - a normal key is a STOP (zero velocity) unless it carries `vel` (planRail's soft holds: a slow drift through the hold);
//   - a `pass: true` key is a waypoint the camera flows THROUGH without slowing (long travels: wide → across → in).
// Interpolation is a time-parameterized cubic Hermite spline per component (C1 smooth, no overshoot at stops), plus a
// slow "breathing" drift so held frames never freeze. rail.at(t) → {pos, look, fov}.
import { clamp } from '../core.js';

// Speed rule (v2 camera review: 11 "whips" of 9–26 m in < 1.3 s read as cuts): a move of d metres needs ≥ 0.6 + d/8 s.
// The lint below warns (render log) on any segment faster than that; use planRail() to build keys that obey it.
export const moveTime = (d) => 0.6 + d / 8;
const dist3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** Framings → rail keys. frames: [{t (arrive on the word), pos, look, fov, pass?, keep?, stop?, until?}].
 *  - Each framing is LEFT EARLY so the move into the next one takes moveTime(d) and lands on its word.
 *  - A framing that could only be held < minHold s becomes a pass-through point (`keep: true` holds it anyway).
 *  - Holds are SOFT: during a hold the camera already drifts a few % toward the next framing, and the arrive/depart keys carry
 *    that drift velocity, so the camera never comes to a dead stop (v4 camera review: stop→push→stop gave 58 dead stops and
 *    in/out "pumping"; drifting toward the NEXT frame removes both). `stop: true` = a true zero-speed hold (the last frame).
 *  - `until: t` keeps a hold at least until t (a gag that must finish in frame), as long as the next move stays legal.
 *  - Every consecutive pair of keys (pass→pass too) is checked against moveTime; violations print `[rail]` warnings. */
export function planRail(frames, { minHold = 1.3, lead = 0.06, maxLead = 0.15, shortHoldPass = false } = {}) {   // shortHoldPass (026): a ≤ 0.25 s hold flows through as a pass key instead of a dead stop
  const F = [...frames].sort((a, b) => a.t - b.t).map((f) => ({ ...f })), keys = [];
  const comps = (f) => [...f.pos, ...f.look, f.fov ?? 40], un = (v) => ({ pos: v.slice(0, 3), look: v.slice(3, 6), fov: v[6] });
  const need = (f, n) => moveTime(Math.max(dist3(f.pos, n.pos), dist3(f.look, n.look) * 0.7));
  F.forEach((f, i) => { const n = F[i + 1]; if (n && i > 0 && !f.pass && !f.keep && !f.stop && n.t - need(f, n) - f.t < minHold) { f.pass = true; if (planRail.verbose) console.warn(`[rail] framing at t=${f.t.toFixed(2)} becomes a pass (hold ${(n.t - need(f, n) - f.t).toFixed(2)} s)`); } });
  F.forEach((f, i) => {
    const n = F[i + 1];
    if (!n || f.pass) { keys.push({ ...f, stop: !n || f.stop }); return; }
    const nd = need(f, n), dep0 = n.t - Math.max(nd, Math.min(1.6 * nd, 0.55 * (n.t - f.t))), dep = f.until ? Math.max(dep0, Math.min(f.until, n.t - 0.8 * nd)) : dep0, hold = dep - f.t;   // glide out early when there's room (fewer dash-then-hold moves)
    if (f.until && dep < f.until - 0.05) console.warn(`[rail] until ${f.until.toFixed(2)} at t=${f.t.toFixed(2)} clamped to ${dep.toFixed(2)} (the next framing is too far/too soon)`);   // 026: the camera left before the punch word
    if (hold <= 0.25) { keys.push({ ...f, pass: shortHoldPass && !f.stop ? true : f.pass }); return; }
    const A = comps(f), N = comps(n), k = f.stop ? 0 : Math.min(maxLead, lead * hold), B = A.map((a, c) => a + (N[c] - a) * k * (c >= 3 && c < 6 ? 0.5 : 1)), vel = f.stop ? null : B.map((b, c) => (b - A[c]) / hold);   // the aim leads half as much: close frames keep their subject
    keys.push({ t: f.t, ...un(A), vel }, { t: dep, ...un(B), vel });
  });
  for (let i = 0; i + 1 < keys.length; i++) { const a = keys[i], b = keys[i + 1], d = Math.max(dist3(a.pos, b.pos), dist3(a.look, b.look) * 0.7), dt = b.t - a.t; if (d > 1.5 && dt < moveTime(d) * 0.8) console.warn(`[rail] ${d.toFixed(1)} m in ${dt.toFixed(2)} s at t=${a.t.toFixed(2)} (needs ${moveTime(d).toFixed(2)} s)`); }
  // opt-in (planRail.strict = true, 025 camera review): the metre rule misses crash zooms (a big push from far away) and fast
  // pans across a close subject. Warn when the framed size changes > 50 %/s or the aim crosses > 0.7 frame widths/s.
  if (planRail.strict) for (let i = 0; i + 1 < keys.length; i++) { const a = keys[i], b = keys[i + 1], dt = b.t - a.t; if (dt <= 0) continue;
    const half = (k) => dist3(k.pos, k.look) * Math.tan(((k.fov ?? 40) * Math.PI) / 360), ha = half(a), hb = half(b), zoom = Math.abs(hb - ha) / Math.min(ha, hb) / dt, pan = dist3(a.look, b.look) / (2 * Math.min(ha, hb) * 9 / 16) / dt;
    if (zoom > 0.5) console.warn(`[rail] zoom ${(zoom * 100).toFixed(0)} %/s at t=${a.t.toFixed(2)}`); if (pan > 0.7) console.warn(`[rail] pan ${pan.toFixed(2)} frame widths/s at t=${a.t.toFixed(2)}`); }
  return keys;
}

export function makeRail(keys, { drift = 0.035, driftLook = 0.02 } = {}) {
  const K = [...keys].sort((a, b) => a.t - b.t);
  const comps = (k) => [...k.pos, ...k.look, k.fov ?? 40];
  const P = K.map(comps);
  // tangents (units per second): a soft hold's drift velocity (planRail `vel`), Catmull-Rom at pass-through keys, 0 at stops
  const M = K.map((k, i) => {
    if (k.vel) return k.vel.slice();
    if (!k.pass || i === 0 || i === K.length - 1) return P[i].map(() => 0);
    const dt = K[i + 1].t - K[i - 1].t;
    return P[i].map((_, c) => (P[i + 1][c] - P[i - 1][c]) / dt);
  });
  function sample(t) {
    if (t <= K[0].t) return P[0];
    if (t >= K[K.length - 1].t) return P[K.length - 1];
    let i = 0;
    while (i < K.length - 2 && t > K[i + 1].t) i++;
    const dt = K[i + 1].t - K[i].t, u = clamp((t - K[i].t) / dt), u2 = u * u, u3 = u2 * u;
    const h00 = 2 * u3 - 3 * u2 + 1, h10 = u3 - 2 * u2 + u, h01 = -2 * u3 + 3 * u2, h11 = u3 - u2;
    return P[i].map((p0, c) => h00 * p0 + h10 * dt * M[i][c] + h01 * P[i + 1][c] + h11 * dt * M[i + 1][c]);
  }
  return {
    keys: K,
    at(t) {
      const v = sample(t);
      const d = Math.hypot(v[0] - v[3], v[1] - v[4], v[2] - v[5]);
      const a = drift * Math.min(1, d / 8), b = driftLook * Math.min(1, d / 8);
      const n1 = Math.sin(t * 0.61) + 0.5 * Math.sin(t * 1.37 + 1.1), n2 = Math.sin(t * 0.47 + 2.0) + 0.5 * Math.sin(t * 1.13 + 0.3);
      return { pos: [v[0] + n1 * a, v[1] + n2 * a, v[2] + n2 * a * 0.5], look: [v[3] + n2 * b, v[4] + n1 * b, v[5]], fov: v[6] };
    },
  };
}
