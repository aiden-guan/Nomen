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

/**
 * Sandbars linking the horse to the first station, each station to the next, and the last back to
 * the first: a ring, so nobody walks the long way round to the station below the scouts.
 */
export function sandbars(): Array<{ a: Point; b: Point }> {
  const point = (p: { x: number; y: number }): Point => ({ x: p.x, y: p.y, z: 0 });
  const bars: Array<{ a: Point; b: Point }> = [{ a: { x: 0, y: 62, z: 0 }, b: point(STATIONS[0]) }];
  for (let i = 0; i < STATIONS.length - 1; i++) bars.push({ a: point(STATIONS[i]), b: point(STATIONS[i + 1]) });
  bars.push({ a: point(STATIONS[STATIONS.length - 1]), b: point(STATIONS[0]) });
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

/** The roads: the horse's road to the scouts, then the ring of sandbars. */
const EDGES: Array<[Node, Node]> = [["horse", "scouts"], ...STATIONS.map((s, i): [Node, Node] => [s.id, STATIONS[(i + 1) % STATIONS.length].id])];

/**
 * Where a walker passing through an island goes between the two sandbars, relative to its centre:
 * along the road where it is clear, around the furniture where it isn't (the shrine, the seats, the
 * desks, the podium). Also the meeting point used to leave the stable. Walkers that stop on an
 * island go straight from where the sandbar meets it to their post.
 */
export const HUBS: Record<StationId, Array<{ x: number; y: number }>> = {
  scouts: [{ x: 2, y: -6 }],
  oracle: [{ x: 4, y: 4 }],
  tent: [{ x: 0, y: 24 }],
  workshop: [
    { x: -30, y: -10 },
    { x: -32, y: 10 },
  ],
  theatre: [{ x: 10, y: 10 }],
  agora: [{ x: 0, y: -22 }],
};

/** How far inside an island a road starts (the sandbar meets the island here). */
const LANDING = 34;

function centre(node: Node): Point {
  if (node === "horse") return HORSE_GATE;
  const s = STATION[node];
  return { x: s.x, y: s.y, z: 0 };
}

/** A node's (first) crossing point in world units. */
export function hub(node: Node): Point {
  if (node === "horse") return HORSE_GATE;
  const s = STATION[node];
  return { x: s.x + HUBS[node][0].x, y: s.y + HUBS[node][0].y, z: 0 };
}

/** The shortest way between two places on the road network, as the list of places passed. */
export function route(from: Node, to: Node): Node[] {
  const dist = new Map<Node, number>([[from, 0]]);
  const prev = new Map<Node, Node>();
  const open = new Set<Node>(["horse", ...STATIONS.map((s) => s.id)]);
  while (open.size) {
    let best: Node | null = null;
    for (const n of open) if (dist.has(n) && (best === null || dist.get(n)! < dist.get(best)!)) best = n;
    if (best === null || best === to) break;
    open.delete(best);
    for (const [a, b] of EDGES) {
      const next = a === best ? b : b === best ? a : null;
      if (!next || !open.has(next)) continue;
      const d = dist.get(best)! + Math.hypot(centre(next).x - centre(best).x, centre(next).y - centre(best).y);
      if (d < (dist.get(next) ?? Number.POSITIVE_INFINITY)) {
        dist.set(next, d);
        prev.set(next, best);
      }
    }
  }
  const nodes: Node[] = [to];
  while (nodes[0] !== from) {
    const p = prev.get(nodes[0]);
    if (!p) return [from];
    nodes.unshift(p);
  }
  return nodes;
}

/**
 * The way from one place to another along the sandbars, as world points: from where the first
 * sandbar leaves `from` (its gate, for the horse) to where the last one meets `to`, crossing the
 * islands in between by their crossing points. `lane` shifts the walker sideways on the sandbars
 * (world units) so a column doesn't walk in single file. Empty when `from` is `to`.
 */
export function travel(from: Node, to: Node, lane = 0): Point[] {
  const nodes = route(from, to);
  const points: Point[] = [];
  for (let k = 0; k < nodes.length - 1; k++) {
    const a = centre(nodes[k]);
    const b = centre(nodes[k + 1]);
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const ux = (b.x - a.x) / len;
    const uy = (b.y - a.y) / len;
    const ra = nodes[k] === "horse" ? 0 : LANDING;
    const rb = nodes[k + 1] === "horse" ? 0 : LANDING;
    const ox = -uy * lane;
    const oy = ux * lane;
    const exit = { x: a.x + ux * ra + ox, y: a.y + uy * ra + oy, z: 0 };
    if (k > 0) points.push(...crossing(nodes[k], points[points.length - 1], exit));
    points.push(exit);
    points.push({ x: b.x - ux * rb + ox, y: b.y - uy * rb + oy, z: 0 });
  }
  return points;
}

/** The crossing points of an island, in the order that suits a walker going from `entry` to `exit`. */
function crossing(node: Node, entry: Point, exit: Point): Point[] {
  if (node === "horse") return [];
  const s = STATION[node];
  const pts = HUBS[node].map((h) => ({ x: s.x + h.x, y: s.y + h.y, z: 0 }));
  const d = (p: Point, q: Point) => Math.hypot(p.x - q.x, p.y - q.y);
  if (pts.length > 1 && d(entry, pts[0]) + d(pts[pts.length - 1], exit) > d(entry, pts[pts.length - 1]) + d(pts[0], exit)) pts.reverse();
  return pts;
}
