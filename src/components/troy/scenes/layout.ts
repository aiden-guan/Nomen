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
  return { cx: 0, cy: 0, rx: ISLAND_RADIUS, ry: ISLAND_RADIUS * 0.94, seed: 11 + index * 7, rim: 12, wobble: 14, grass: 0.22, trodden: 0.8 };
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
