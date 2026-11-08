import { R } from "./palette";
import { hash2, type HitInfo, type ShadeOut } from "./tracer";

// Reusable surface patterns. Each is a material function for Model primitives.

const frac = (v: number) => v - Math.floor(v);

/** Horizontal planks by world height, with staggered butt joints, nails and per-plank tone. */
export function planks(options: { ramp?: number; row?: number; length?: number; seam?: number; vary?: number; axis?: "x" | "y" } = {}) {
  const rampId = options.ramp ?? R.wood;
  const row = options.row ?? 4.4;
  const length = options.length ?? 17;
  const seam = options.seam ?? 1.6;
  const vary = options.vary ?? 0.55;
  const axis = options.axis ?? "x";
  return (h: HitInfo, out: ShadeOut) => {
    out.ramp = rampId;
    out.dither = 0;
    const r = Math.floor(h.z / row);
    const v = frac(h.z / row);
    const along = axis === "x" ? h.x : h.y;
    const joint = frac((along + r * 7.3) / length);
    let tone = (hash2(r, 11) - 0.5) * vary;
    if (v < 0.13) tone -= seam;
    else if (v > 0.9) tone += 0.35; // sunlit lip of the plank above the seam
    if (joint < 0.035 && Math.abs(h.nz) < 0.7) tone -= seam * 0.8;
    // Nails near the joints.
    if (Math.abs(joint - 0.07) < 0.02 && Math.abs(v - 0.55) < 0.12 && Math.abs(h.nz) < 0.7) tone -= 1.4;
    out.tone = tone;
  };
}

/** Deck boards running along x with dark gaps. */
export function deck(rampId = R.woodPale) {
  return (h: HitInfo, out: ShadeOut) => {
    out.ramp = rampId;
    if (h.nz > 0.7) {
      const board = Math.floor(h.y / 5.2);
      const v = frac(h.y / 5.2);
      let tone = (hash2(board, 3) - 0.5) * 0.7;
      if (v < 0.14) tone -= 1.8;
      const joint = frac((h.x + board * 11) / 23);
      if (joint < 0.03) tone -= 1.4;
      out.tone = tone;
    } else {
      // Side of the deck: a beam with darker end grain.
      out.ramp = R.wood;
      out.tone = frac(h.z / 5) < 0.18 ? -1.2 : -0.2;
    }
  };
}

/** Spoked cart wheel: iron rim, wooden spokes, iron hub. Cylinder axis is the local z. */
export function wheel(radius: number, half: number, spokes = 8, turn = 0) {
  return (h: HitInfo, out: ShadeOut) => {
    const r = Math.hypot(h.lx, h.ly);
    const cap = Math.abs(Math.abs(h.lz) - half) < 0.05;
    out.dither = 0;
    if (!cap) {
      out.ramp = R.iron;
      out.tone = 0.2;
      return;
    }
    if (r > radius * 0.8) {
      out.ramp = R.iron;
      out.tone = 0.5;
      return;
    }
    if (r < radius * 0.26) {
      out.ramp = R.iron;
      out.tone = 1;
      return;
    }
    const angle = Math.atan2(h.ly, h.lx) + turn;
    const slot = frac((angle / (Math.PI * 2)) * spokes + 0.5);
    if (slot < 0.2 || slot > 0.8) {
      out.ramp = R.wood;
      out.tone = 0.7;
    } else {
      out.ramp = R.woodDark;
      out.tone = -1.6;
    }
  };
}

/** Solid ramp with an optional fixed tone and dither. */
export function solid(rampId: number, tone = 0, dither = -1) {
  return (_h: HitInfo, out: ShadeOut) => {
    out.ramp = rampId;
    out.tone = tone;
    if (dither >= 0) out.dither = dither;
  };
}

/** Rope: twisted strands as diagonal bands. */
export function rope(rampId = R.rope) {
  return (h: HitInfo, out: ShadeOut) => {
    out.ramp = rampId;
    out.tone = frac((h.lz + Math.atan2(h.ly, h.lx) * 0.9) / 2.2) < 0.4 ? -0.8 : 0.2;
  };
}

/** Light pouring out of the horse: brightest low and in the middle, like torches on the floor. */
export function torchlight(strength = 1, floor = 31, tall = 22, halfWidth = 13) {
  return (h: HitInfo, out: ShadeOut) => {
    out.ramp = R.fire;
    const height = Math.max(0, Math.min(1, (h.z - floor) / tall));
    const centre = 1 - Math.min(1, Math.abs(h.x) / halfWidth);
    out.glow = Math.max(0, Math.min(1, strength));
    out.tone = (centre * 1.6 - height * 2.4 + 0.2) * strength - (1 - strength) * 3;
    out.dither = 0.9;
  };
}
