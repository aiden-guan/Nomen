import type { Stage as PipelineStage } from "../api";
import type { IslandSpec } from "../engine/grounds";
import type { Point } from "../engine/walker";

// Where everything in the camp sits. Stations follow the core pipeline in reading order: the top
// row runs left to right, then the road turns down and the bottom row runs back.

export type StationId = "scouts" | "oracle" | "tent" | "workshop" | "theatre" | "agora";

export type Station = {
  id: StationId;
  stage: PipelineStage;
  name: string;
  role: string;
  /** Centre on the ground, in world units. */
  x: number;
  y: number;
};

/** Ground point under a screen offset (art px) from the horse: x - y = sx, (x + y) / 2 = sy. */
export function ground(sx: number, sy: number): Point {
  return { x: sy + sx / 2, y: sy - sx / 2, z: 0 };
}

/** Screen-space centre of the camp, in art px below the horse. */
export const CAMP_CENTER = { sx: 0, sy: 312 };
const COLUMN = 196;
const ROW_TOP = -76;
const ROW_BOTTOM = 80;

function at(id: StationId, stage: PipelineStage, name: string, role: string, sx: number, sy: number): Station {
  const p = ground(CAMP_CENTER.sx + sx, CAMP_CENTER.sy + sy);
  return { id, stage, name, role, x: p.x, y: p.y };
}

export const STATIONS: Station[] = [
  at("scouts", "research", "Scouts", "Research", -COLUMN, ROW_TOP),
  at("oracle", "style", "Oracle", "Format study", 0, ROW_TOP),
  at("tent", "strategy", "War tent", "Strategy", COLUMN, ROW_TOP),
  at("workshop", "production", "Workshop", "Production", COLUMN, ROW_BOTTOM),
  at("theatre", "review", "Theatre", "Review", 0, ROW_BOTTOM),
  at("agora", "live", "Agora", "Posting", -COLUMN, ROW_BOTTOM),
];

export const STATION = Object.fromEntries(STATIONS.map((s) => [s.id, s])) as Record<StationId, Station>;

export const ISLAND_RADIUS = 48;

export function stationIsland(station: Station, index: number): IslandSpec {
  // The scouts' island bulges to the left for the stable, where the trail leaves.
  const lobes = station.id === "scouts" ? [{ cx: -40, cy: 5, r: 19 }] : undefined;
  return { cx: 0, cy: 0, rx: ISLAND_RADIUS, ry: ISLAND_RADIUS * 0.94, seed: 11 + index * 7, rim: 12, wobble: 14, grass: 0.22, trodden: 0.8, lobes };
}

/** Sandbars linking the horse to the first station and each station to the next. */
export function sandbars(): Array<{ a: Point; b: Point }> {
  const point = (p: { x: number; y: number }): Point => ({ x: p.x, y: p.y, z: 0 });
  const bars: Array<{ a: Point; b: Point }> = [{ a: { x: 0, y: 62, z: 0 }, b: point(STATIONS[0]) }];
  for (let i = 0; i < STATIONS.length - 1; i++) bars.push({ a: point(STATIONS[i]), b: point(STATIONS[i + 1]) });
  return bars;
}

/** The road a messenger rides from one station to another, along the sandbars. */
export function road(from: StationId, to: StationId): Point[] {
  const i = STATIONS.findIndex((s) => s.id === from);
  const j = STATIONS.findIndex((s) => s.id === to);
  const step = i <= j ? 1 : -1;
  const points: Point[] = [];
  for (let k = i; k !== j + step; k += step) points.push({ x: STATIONS[k].x, y: STATIONS[k].y, z: 0 });
  return points;
}

/** Where the horse's road leaves its island, at the foot of the gangplank. */
export const HORSE_GATE: Point = { x: 0, y: 62, z: 0 };

/** The scouts' trail: from their island off the left edge of the world, where the sources are. */
export const TRAIL = (() => {
  const s = STATIONS[0];
  return { a: { x: s.x, y: s.y, z: 0 }, b: { x: s.x - 300, y: s.y + 300, z: 0 } };
})();

/** A place on the road network: the horse or a station. */
export type Node = StationId | "horse";

/** The road network is one line: the horse, then every station in pipeline order. */
const CHAIN: Node[] = ["horse", ...STATIONS.map((s) => s.id)];

/**
 * A clear point on each island, near the middle, where roads meet (relative to its centre).
 * Walkers pass through it rather than through the furniture in the exact centre.
 */
export const HUBS: Record<StationId, { x: number; y: number }> = {
  scouts: { x: 2, y: -6 },
  oracle: { x: 12, y: 8 },
  tent: { x: 4, y: -6 },
  workshop: { x: 4, y: 10 },
  theatre: { x: 12, y: 6 },
  agora: { x: 8, y: 8 },
};

/** How far inside an island a road starts (the sandbar meets the island here). */
const LANDING = 34;

function centre(node: Node): Point {
  if (node === "horse") return HORSE_GATE;
  const s = STATION[node];
  return { x: s.x, y: s.y, z: 0 };
}

/** A node's hub in world units. */
export function hub(node: Node): Point {
  if (node === "horse") return HORSE_GATE;
  const s = STATION[node];
  return { x: s.x + HUBS[node].x, y: s.y + HUBS[node].y, z: 0 };
}

/**
 * The way from one node's hub to another's along the sandbars, as world points. `lane` shifts the
 * walker sideways on the sandbars (world units) so a column doesn't walk in single file.
 */
export function travel(from: Node, to: Node, lane = 0): Point[] {
  const i = CHAIN.indexOf(from);
  const j = CHAIN.indexOf(to);
  const points: Point[] = [hub(from)];
  if (i === j) return points;
  const step = i < j ? 1 : -1;
  for (let k = i; k !== j; k += step) {
    const a = centre(CHAIN[k]);
    const b = centre(CHAIN[k + step]);
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const ux = (b.x - a.x) / len;
    const uy = (b.y - a.y) / len;
    const ra = CHAIN[k] === "horse" ? 0 : LANDING;
    const rb = CHAIN[k + step] === "horse" ? 0 : LANDING;
    const ox = -uy * lane;
    const oy = ux * lane;
    points.push({ x: a.x + ux * ra + ox, y: a.y + uy * ra + oy, z: 0 });
    points.push({ x: b.x - ux * rb + ox, y: b.y - uy * rb + oy, z: 0 });
    points.push(hub(CHAIN[k + step]));
  }
  return points;
}
