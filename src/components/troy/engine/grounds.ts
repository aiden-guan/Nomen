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

/** A narrow strip of sand between two points: the road between islands, and out to the lands. */
export function sandbar(a: { x: number; y: number }, b: { x: number; y: number }, seed: number): Ground {
  const base = 7.5;
  const rim = 7;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy || 1;
  const sdf = (x: number, y: number) => {
    const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / len2));
    const d = Math.hypot(x - (a.x + dx * t), y - (a.y + dy * t)) - base;
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
  const pad = base + rim + 4;
  return {
    sdf,
    shade,
    bounds: { x0: Math.min(a.x, b.x) - pad, y0: Math.min(a.y, b.y) - pad, x1: Math.max(a.x, b.x) + pad, y1: Math.max(a.y, b.y) + pad },
    rim,
    ao: 0,
  };
}

/** Screen position (art px) of a world point on the ground, for shapes laid out on screen. */
const toScreen = (x: number, y: number) => ({ sx: x - y, sy: (x + y) / 2 });

/**
 * The sea: deep in the open, lighter over the shallows, streaked with swell, and white with foam
 * where it laps against a shore. Its open edges dissolve into the page like an island's. `shores`
 * are the lands it washes against (their signed distances); `area` is the sea itself in screen
 * space, as a rounded box with a wobbly edge. Baked in tiles: `tile` limits one bake to part of it.
 */
export function sea(spec: {
  area: { cx: number; cy: number; hw: number; hh: number };
  shores: Array<(x: number, y: number) => number>;
  seed: number;
  tile?: { x0: number; y0: number; x1: number; y1: number };
}): Ground {
  const { cx, cy, hw, hh } = spec.area;
  const seed = spec.seed * 13.7;
  const rim = 16;
  const sdf = (x: number, y: number) => {
    const { sx, sy } = toScreen(x, y);
    // A rounded box in screen space, in roughly world units, with a coast that wanders in and out.
    const u = Math.abs(sx - cx) / hw;
    const v = Math.abs(sy - cy) / hh;
    const d = (Math.pow(u ** 4 + v ** 4, 1 / 4) - 1) * Math.min(hw * 0.7, hh * 1.4);
    return d + (fbm(x * 0.011 + seed, y * 0.011 - seed) - 0.5) * 110 + (fbm(x * 0.03 + seed, y * 0.03 - seed) - 0.5) * 30;
  };
  const shade = (x: number, y: number, out: ShadeOut) => {
    const { sx, sy } = toScreen(x, y);
    let land = Infinity;
    for (const shore of spec.shores) land = Math.min(land, shore(x, y));
    const open = Math.min(1, Math.max(0, -sdf(x, y) / 90));
    const n = hash2(Math.floor(x * 1.3), Math.floor(y * 1.3));
    out.dither = 0.5;
    // Foam where the water meets a shore, in broken bands that come and go along it.
    const lap = land + (fbm(sx * 0.08 + seed, sy * 0.2) - 0.5) * 5;
    if (lap < 2.4 || (lap < 5 && n > 0.55)) {
      out.ramp = R.foam;
      out.tone = lap < 1.2 ? 0.6 : 0;
      return;
    }
    out.ramp = R.sea;
    // Shallows near the shores and the open edge; deep water further out.
    const shallow = Math.max(0, 1 - Math.min(land, 60) / 60) * 0.9 + (1 - open) * 0.7;
    let tone = -1.2 + shallow * 1.4;
    // Long swells, a little darker in their troughs and catching the light on their crests.
    const swell = fbm(sx * 0.022 + seed, sy * 0.09, 3);
    if (swell > 0.64) tone += 0.75;
    else if (swell > 0.58 && n > 0.5) tone += 0.45;
    else if (swell < 0.3) tone -= 0.35;
    if (n > 0.985) tone += 1.2;
    out.tone = tone;
  };
  const tile = spec.tile;
  // The sea's box in world units, from its screen corners.
  const corners = [
    [cx - hw, cy - hh],
    [cx + hw, cy - hh],
    [cx - hw, cy + hh],
    [cx + hw, cy + hh],
  ].map(([s, t]) => ({ x: t + s / 2, y: t - s / 2 }));
  const pad = rim + 24;
  const bounds = tile ?? {
    x0: Math.min(...corners.map((c) => c.x)) - pad,
    y0: Math.min(...corners.map((c) => c.y)) - pad,
    x1: Math.max(...corners.map((c) => c.x)) + pad,
    y1: Math.max(...corners.map((c) => c.y)) + pad,
  };
  return { sdf: (x, y) => (tile && (x < tile.x0 || x > tile.x1 || y < tile.y0 || y > tile.y1) ? 1e3 : sdf(x, y)), shade, bounds, rim, ao: 0, lit: 3.6, dark: 2.6 };
}

/** Where a town is paved, and how: quay blocks, a forum's marble slabs (round a medallion at `centre`), or a street's cobbles. */
export type Paving = { kind: "forum" | "street" | "quay"; inside: (x: number, y: number) => boolean; centre?: { x: number; y: number } };

/** A straight quay: its edge from `a` to `b`, the water on the side `water` points to, paved `depth` deep. */
export type Quay = { a: { x: number; y: number }; b: { x: number; y: number }; water: { x: number; y: number }; depth: number };

/**
 * A town on its own land: an island's outline and sand, cut straight along its quays (a crisp stone
 * edge there, not the dissolving rim) and paved where `paving` says. `distance` is how far a point
 * is from the land, along the quays included, for the sea's foam.
 */
export function town(spec: { land: IslandSpec; quays: Quay[]; paving: Paving[]; tile?: { x0: number; y0: number; x1: number; y1: number } }): Ground & { distance: (x: number, y: number) => number } {
  const base = island(spec.land);
  const rim = base.rim;
  /** Along a quay (0..1 within it) and across it (positive over the water). */
  const measure = (q: Quay, x: number, y: number) => {
    const dx = q.b.x - q.a.x;
    const dy = q.b.y - q.a.y;
    const len = Math.hypot(dx, dy) || 1;
    const t = ((x - q.a.x) * dx + (y - q.a.y) * dy) / (len * len);
    const s = (x - q.a.x) * q.water.x + (y - q.a.y) * q.water.y;
    return { t, s, along: t * len };
  };
  const sdf = (x: number, y: number) => {
    let d = base.sdf(x, y);
    for (const q of spec.quays) {
      const { t, s } = measure(q, x, y);
      if (t < 0 || t > 1) continue;
      if (s > 0) return rim;
      if (s > -q.depth - 6) d = Math.min(d, -rim - 1);
    }
    return d;
  };
  const distance = (x: number, y: number) => {
    for (const q of spec.quays) {
      const { t, s } = measure(q, x, y);
      if (t >= 0 && t <= 1 && s > -q.depth) return s;
    }
    return base.sdf(x, y);
  };
  const shade = (x: number, y: number, out: ShadeOut) => {
    for (const q of spec.quays) {
      const { t, s, along } = measure(q, x, y);
      if (t < 0 || t > 1 || s > 0 || s < -q.depth) continue;
      quayStone(-s, along, out);
      return;
    }
    // Paving gives out a little inside the coast, into sand.
    if (base.sdf(x, y) > -6 - hash2(Math.floor(x), Math.floor(y)) * 3) return base.shade(x, y, out);
    for (const zone of spec.paving) {
      if (!zone.inside(x, y)) continue;
      if (zone.kind === "forum") forumSlab(x, y, out, zone.centre);
      else if (zone.kind === "street") cobble(x, y, out);
      else quayStone(10 + (y % 40), x, out);
      return;
    }
    base.shade(x, y, out);
  };
  const tile = spec.tile;
  if (!tile) return { ...base, sdf, shade, distance };
  // One tile of a big town: nothing outside it.
  return { ...base, bounds: tile, sdf: (x, y) => (x < tile.x0 || x > tile.x1 || y < tile.y0 || y > tile.y1 ? 1e3 : sdf(x, y)), shade, distance };
}

/** Quay blocks in courses along the edge (`depth` from it, `along` it), the coping at the edge lighter. */
function quayStone(depth: number, along: number, out: ShadeOut) {
  out.ramp = R.stone;
  out.dither = 0;
  if (depth < 2.6) {
    // The coping: long dressed stones with a sunlit lip.
    const block = Math.floor(along / 6.2);
    const joint = along - block * 6.2 < 0.4;
    out.tone = joint ? -0.9 : depth < 0.7 ? 1.1 : 0.55 + (hash2(block, 91) - 0.5) * 0.3;
    return;
  }
  const row = Math.floor((depth - 2.6) / 2.6);
  const shift = row % 2 ? 2.4 : 0;
  const block = Math.floor((along + shift) / 4.8);
  const joint = along + shift - block * 4.8 < 0.36 || depth - 2.6 - row * 2.6 < 0.36;
  const h = hash2(block * 3 + 7, row * 11 + 5);
  out.tone = joint ? -1 : (h - 0.5) * 0.7 + (fbm(along * 0.06, depth * 0.08) > 0.64 ? -0.35 : 0);
}

/**
 * The forum: big slabs of white and cream marble in a chequer, a band of grey stone every few, and
 * a medallion of coloured stone in rings round its centre.
 */
function forumSlab(x: number, y: number, out: ShadeOut, centre?: { x: number; y: number }) {
  out.dither = 0;
  if (centre) {
    const r = Math.hypot(x - centre.x, y - centre.y);
    if (r < 25) {
      // Rings of porphyry red and green round a star of marble.
      const a = Math.atan2(y - centre.y, x - centre.x);
      const star = r < 12 && r < 5 + 7 * Math.abs(Math.cos(a * 4));
      const ring = r > 22.5 ? R.stone : r > 20.5 ? R.tile : r > 19 ? R.marble : r > 16.5 ? R.olive : r > 12 ? R.cream : star ? R.marble : R.tile;
      out.ramp = ring;
      const seam = Math.abs(r - 19) < 0.3 || Math.abs(r - 12) < 0.3 || (r > 12.5 && r < 16.5 && Math.abs(Math.sin(a * 8)) < 0.07);
      out.tone = seam ? -0.9 : ring === R.tile ? 0.2 : ring === R.olive ? 0.4 : 0.55;
      return;
    }
  }
  const size = 5.4;
  const cx = Math.floor(x / size);
  const cy = Math.floor(y / size);
  const fx = x - cx * size;
  const fy = y - cy * size;
  const band = ((cx % 6) + 6) % 6 === 0 || ((cy % 6) + 6) % 6 === 0;
  out.ramp = band ? R.stone : (cx + cy) % 2 ? R.cream : R.marble;
  const joint = fx < 0.34 || fy < 0.34;
  const h = hash2(cx * 5 + 1, cy * 9 + 2);
  out.tone = joint ? -1.05 : (band ? 0.25 : 0.3) + (h - 0.5) * 0.45 + (fbm(x * 0.05, y * 0.05) > 0.66 ? -0.3 : 0);
}

/** A street: small dark setts in staggered rows. */
function cobble(x: number, y: number, out: ShadeOut) {
  const row = Math.floor(y / 1.9);
  const shift = row % 2 ? 1.1 : 0;
  const col = Math.floor((x + shift) / 2.2);
  const fx = x + shift - col * 2.2;
  const fy = y - row * 1.9;
  out.ramp = R.stone;
  out.dither = 0;
  out.tone = fx < 0.3 || fy < 0.3 ? -1.3 : -0.2 + (hash2(col, row * 3) - 0.5) * 0.8;
}
