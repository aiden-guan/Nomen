// Punch-in cuts + frame-relative impact kicks (docs/BUILD.md → Cuts). User steer, Oct 26: @wemakebuild's newer reels cut every
// ~1–1.5 s — mostly to FACE close-ups during gags (the face IS the gag: purple, X eyes, dizzy stars, labels over the face),
// a detail insert on each TERM, longer continuous moves in between — and the screen shakes hard when things land.
// The one-take rail stays the master; a cut overrides it for [t0, t1]. Everything is a pure function of t (deterministic).
import * as THREE from 'three';
import { clamp } from '../core.js';

const V = new THREE.Vector3(), Q = new THREE.Quaternion(), F = new THREE.Vector3();

/** list: face shots {t0, t1, face: rig | (t) => rig, dist = 2.6, fov = 30, yaw = 0.25, pitch = 0.08, faceY = 0.4,
 *  push = 0.1, scale = 1, facing = false} and inserts {t0, t1, pos, look, fov = 32, push = 0.06}.
 *  - A face shot tracks `rig.head` every frame. `dist` is for a full-size toon (head + shoulders, head ≈ 40 % of the frame height at fov 30; 1.6 crops the head); pass the
 *    rig's root `scale` for small/big characters. `yaw` (rad) swings the camera to the side for a three-quarter face; by
 *    default the camera stays on the +z (lens) side of the cut face — `facing: true` measures yaw from the rig's own facing.
 *  - `faceY` = where the face sits (fraction of frame height from the top). 0.4 puts the one-word caption (52 %) on the chin,
 *    like the reference; `push` = how much the shot dollies in over its length (motion inside every insert).
 *  at(t) → {pos, look, fov, cut} inside a cut, else null. Registers the cut times in window.EDSTUDIO_CUTS so the motion-blur
 *  renderer never blends two shots across a cut (engine/main.js renderAtBlur). */
export function makeCuts(list) {
  const L = [...list].sort((a, b) => a.t0 - b.t0);
  L.forEach((c, i) => {
    const d = c.t1 - c.t0;
    if (d < 0.3 || d > 2.5) console.warn(`[cuts] cut at t=${c.t0.toFixed(2)} lasts ${d.toFixed(2)} s (an insert reads at 0.4–1.5 s)`);
    if (i && c.t0 < L[i - 1].t1) console.warn(`[cuts] cuts overlap at t=${c.t0.toFixed(2)}`);
  });
  if (typeof window !== 'undefined') window.EDSTUDIO_CUTS = [...new Set(L.flatMap((c) => [c.t0, c.t1]))].sort((a, b) => a - b);
  return {
    list: L,
    at(t) {
      const i = L.findIndex((k) => t >= k.t0 && t < k.t1); if (i < 0) return null;
      const c = L[i], u = clamp((t - c.t0) / (c.t1 - c.t0));
      if (!c.face) {
        const k = (c.push ?? 0.06) * u;
        return { pos: c.pos.map((p, j) => p + (c.look[j] - p) * k), look: c.look, fov: c.fov ?? 32, cut: i };
      }
      const rig = typeof c.face === 'function' ? c.face(t) : c.face;
      rig.root.updateMatrixWorld(true); rig.head.getWorldPosition(V);
      let yaw = c.yaw ?? 0.25;
      if (c.facing) { rig.root.getWorldQuaternion(Q); F.set(0, 0, 1).applyQuaternion(Q); yaw += Math.atan2(F.x, F.z); }
      const pitch = c.pitch ?? 0.08, fov = c.fov ?? 30, dist = (c.dist ?? 2.6) * (c.scale ?? 1) * (1 - (c.push ?? 0.1) * u);
      const dir = [Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch)];
      const H = 2 * dist * Math.tan((fov * Math.PI) / 360), off = (0.5 - (c.faceY ?? 0.4)) * H;
      return { pos: [V.x + dir[0] * dist, V.y + dir[1] * dist, V.z + dir[2] * dist], look: [V.x, V.y - off, V.z], fov, cut: i };
    },
  };
}

/** Frame-relative impact kick: hits [[t, strength 0–1+, dur = 0.45]]. apply(camera, t, lookDist) shakes the CURRENT frame by
 *  up to ~amp × its height × strength plus a little roll, decaying fast — the same violence in a close-up as in a wide
 *  (anim.js shake() is in metres, so it is gentle in wides and wild in close-ups). Call it after studio.setCamera(). */
export function makeKick(hits, { amp = 0.035, roll = 0.03, freq = 42 } = {}) {
  const H = [...hits].sort((a, b) => a[0] - b[0]);
  return {
    hits: H,
    apply(camera, t, lookDist) {
      let x = 0, y = 0, r = 0;
      for (const [t0, s = 1, dur = 0.45] of H) {
        const a = t - t0; if (a < 0 || a > dur) continue;
        const e = s * (1 - a / dur) ** 2;
        x += e * Math.sin(a * freq + t0 * 7.13); y += e * Math.sin(a * freq * 1.17 + t0 * 3.71 + 1.3); r += e * Math.sin(a * freq * 0.83 + t0 * 5.29 + 2.1);
      }
      if (!x && !y && !r) return;
      const h = 2 * lookDist * Math.tan((camera.fov * Math.PI) / 360);
      camera.translateX(x * amp * h); camera.translateY(y * amp * h); camera.rotateZ(r * roll);
    },
  };
}
