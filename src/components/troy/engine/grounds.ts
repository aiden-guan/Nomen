import { R } from "./palette";
import { fbm, type Ground, hash2, type ShadeOut } from "./tracer";

// Islands: soft blobs of sand that dissolve into the page at their rim, like the references.

export type IslandSpec = {
  /** Centre and radii in world units. */
  cx: number;
  cy: number;
  rx: number;
  ry: number;
  seed: number;
  /** Width of the dissolving rim. */
  rim?: number;
  /** How wobbly the outline is, in world units. */
  wobble?: number;
  /** Dry grass patches: 0 = none, 1 = plenty. */
  grass?: number;
  /** Darker trodden sand around the middle (paths, work areas). */
  trodden?: number;
  /** Extra blobs merged into the outline (e.g. a peninsula toward a path). */
  lobes?: Array<{ cx: number; cy: number; r: number }>;
};

export function island(spec: IslandSpec): Ground {
  const rim = spec.rim ?? 12;
  const wobble = spec.wobble ?? 18;
  const seed = spec.seed * 17.31;
  const lobes = spec.lobes ?? [];
  const sdf = (x: number, y: number) => {
    const dx = (x - spec.cx) / spec.rx;
    const dy = (y - spec.cy) / spec.ry;
    let d = (Math.hypot(dx, dy) - 1) * Math.min(spec.rx, spec.ry);
    for (const lobe of lobes) d = Math.min(d, Math.hypot(x - lobe.cx, y - lobe.cy) - lobe.r);
    return d + (fbm(x * 0.045 + seed, y * 0.045 - seed) - 0.5) * wobble;
  };
  const grass = spec.grass ?? 0;
  const trodden = spec.trodden ?? 0;
  const shade = (x: number, y: number, out: ShadeOut) => {
    out.ramp = R.sand;
    const n = hash2(Math.floor(x * 1.4), Math.floor(y * 1.4));
    let tone = n < 0.07 ? -1 : n > 0.95 ? 1 : 0;
    if (grass > 0) {
      // Sparse dry tufts: small clumps where the noise peaks, speckled at their edges.
      const g = fbm(x * 0.09 + seed * 2, y * 0.09 + 3.1);
      const edge = 0.76 - grass * 0.1;
      if (g > edge && (g > edge + 0.04 || n > 0.45)) {
        out.ramp = R.grass;
        tone = (n < 0.3 ? -1 : n > 0.85 ? 1 : 0) + (g > edge + 0.06 ? 0.4 : -0.3);
      }
    }
    if (trodden > 0 && out.ramp === R.sand) {
      const d = Math.hypot((x - spec.cx) / spec.rx, (y - spec.cy) / spec.ry);
      if (d < 0.55 * trodden && fbm(x * 0.09, y * 0.09 + seed) > 0.45) tone -= 0.6;
    }
    out.tone = tone;
  };
  const pad = wobble + rim;
  let x0 = spec.cx - spec.rx - pad;
  let x1 = spec.cx + spec.rx + pad;
  let y0 = spec.cy - spec.ry - pad;
  let y1 = spec.cy + spec.ry + pad;
  for (const lobe of lobes) {
    x0 = Math.min(x0, lobe.cx - lobe.r - pad);
    x1 = Math.max(x1, lobe.cx + lobe.r + pad);
    y0 = Math.min(y0, lobe.cy - lobe.r - pad);
    y1 = Math.max(y1, lobe.cy + lobe.r + pad);
  }
  return { sdf, shade, bounds: { x0, y0, x1, y1 }, rim };
}

/** The island the horse stands on, sized for the gangplank's reach. */
export const HORSE_ISLAND: IslandSpec = { cx: 4, cy: 16, rx: 78, ry: 70, seed: 1, rim: 15, wobble: 22, grass: 0.4 };

/** A narrow strip of sand between two points: the road between islands. */
export function sandbar(a: { x: number; y: number }, b: { x: number; y: number }, seed: number): Ground {
  const width = 7.5;
  const rim = 7;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy || 1;
  const sdf = (x: number, y: number) => {
    const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / len2));
    const d = Math.hypot(x - (a.x + dx * t), y - (a.y + dy * t)) - width;
    return d + (fbm(x * 0.08 + seed, y * 0.08) - 0.5) * 6;
  };
  const shade = (x: number, y: number, out: ShadeOut) => {
    out.ramp = R.path;
    const n = hash2(Math.floor(x * 1.4), Math.floor(y * 1.4));
    // Wheel ruts and hoof prints: a darker line down the middle.
    const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / len2));
    const centre = Math.hypot(x - (a.x + dx * t), y - (a.y + dy * t));
    out.tone = (n < 0.08 ? -1 : n > 0.95 ? 1 : 0) + (centre < 2.4 && fbm(x * 0.3, y * 0.3) > 0.42 ? -0.7 : 0);
  };
  const pad = width + rim + 4;
  return {
    sdf,
    shade,
    bounds: { x0: Math.min(a.x, b.x) - pad, y0: Math.min(a.y, b.y) - pad, x1: Math.max(a.x, b.x) + pad, y1: Math.max(a.y, b.y) + pad },
    rim,
    ao: 0,
  };
}
