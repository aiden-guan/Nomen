import type { Stage as PipelineStage } from "../api";
import type { IslandSpec } from "../engine/grounds";
import type { Point } from "../engine/walker";
import type { PropId } from "./stations";

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
  // The scouts' island bulges to the left for the stable and the aisle behind its horses.
  const lobes = station.id === "scouts" ? [{ cx: -42, cy: 0, r: 27 }] : undefined;
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

/** Where the hitching rail stands on the scouts' island (it runs along y, horses on its -x side). */
export const STABLE = { x: -30, y: 5 };

/** Past the rail's end, where the road west to the lands starts: everyone going to or from the horses passes here. */
export const STABLE_GATE = { x: STABLE.x - 4, y: STABLE.y + 24 };

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

// --- The wider world: the lands the scouts ride to -------------------------------------------------
//
// West of the camp a high road runs north and south, with a land on either side of it for each
// website or API the research reads. A road from the scouts' stable joins it at a crossroads.

export type LandId = "site" | "similarweb" | "ahrefs" | "tiktok" | "instagram" | "youtube" | "metaads" | "reddit" | "chatgpt" | "perplexity";

export type Land = {
  id: LandId;
  name: string;
  /** What the scouts bring back from there. */
  what: string;
  prop: PropId;
  /** Its colour, for its label. */
  color: string;
  /** World centre. */
  x: number;
  y: number;
  /** Screen position (art px), for the camera. */
  sx: number;
  sy: number;
  /** The high road's row it sits on. */
  row: number;
};

/** Screen x of the high road, and of the lands between it and the camp ("near") and beyond it ("far"). */
const ROAD_SX = -470;
const SIDE_SX = { near: -390, far: -550 };
/** Screen y of each row of lands, and of the crossroads (between the second and third rows). */
const ROW_SY = [22, 124, 250, 352, 454];
const JUNCTION_SY = 180;

export const LAND_RADIUS = 30;

function land(id: LandId, name: string, what: string, prop: PropId, color: string, row: number, side: keyof typeof SIDE_SX): Land {
  const sx = SIDE_SX[side];
  const sy = ROW_SY[row];
  const p = ground(sx, sy);
  return { id, name, what, prop, color, x: p.x, y: p.y, sx, sy, row };
}

export const LANDS: Land[] = [
  land("chatgpt", "ChatGPT", "AI answers about the brand", "orbshrine", "#18a07c", 0, "near"),
  land("perplexity", "Perplexity", "AI answers about the brand", "crystal", "#2d7b98", 0, "far"),
  land("ahrefs", "Ahrefs", "Domain rating and keywords", "beacon", "#df7c22", 1, "near"),
  land("similarweb", "SimilarWeb", "Sites like the brand's", "huts", "#2b6be0", 1, "far"),
  land("site", "The brand's site", "Brand profile and website", "gate", "#b73a31", 2, "near"),
  land("tiktok", "TikTok", "Top videos and ads", "phone", "#e0264f", 2, "far"),
  land("instagram", "Instagram", "Top Reels", "gallery", "#d65a45", 3, "near"),
  land("youtube", "YouTube", "Top Shorts", "bigscreen", "#b73a31", 3, "far"),
  land("metaads", "Meta Ad Library", "Rivals' running ads", "billboards", "#2b6be0", 4, "near"),
  land("reddit", "Reddit", "What people say", "forum", "#de6c4a", 4, "far"),
];

export const LAND = Object.fromEntries(LANDS.map((l) => [l.id, l])) as Record<LandId, Land>;

/** Which land a research source is fetched from (a run's key, as the core names it). */
export function landFor(runKey: string): LandId {
  if (runKey === "brand" || runKey === "site") return "site";
  if (runKey === "similar") return "similarweb";
  if (runKey.startsWith("seo")) return "ahrefs";
  if (runKey.startsWith("tiktok")) return "tiktok";
  if (runKey === "reels") return "instagram";
  if (runKey === "shorts") return "youtube";
  if (runKey.startsWith("meta_ads")) return "metaads";
  if (runKey === "reddit") return "reddit";
  if (runKey === "aeo_chatgpt") return "chatgpt";
  if (runKey === "aeo_perplexity") return "perplexity";
  // A source this camp doesn't know yet: the open web, as the brand's neighbours on SimilarWeb.
  return "similarweb";
}

/** The land a scout rides to, from its id: one scout per land ("scout:tiktok"). */
export function scoutLand(agentId: string): LandId {
  const key = agentId.startsWith("scout:") ? agentId.slice(6) : agentId;
  return key in LAND ? (key as LandId) : landFor(key);
}

/** The research runs that a land's scout fetches, in the order the core lists them. */
export function landRuns<T extends { key: string }>(runs: T[], land: LandId): T[] {
  return runs.filter((run) => landFor(run.key) === land);
}

/** The crossroads where the road from the camp meets the high road (world). */
export const JUNCTION: Point = ground(ROAD_SX, JUNCTION_SY);

/** The stable's gate in world units. */
export function stableGate(): Point {
  const s = STATIONS[0];
  return { x: s.x + STABLE_GATE.x, y: s.y + STABLE_GATE.y, z: 0 };
}

/** Points along the high road, north to south, the crossroads among them. */
function highRoad(): Array<{ sy: number; p: Point }> {
  return [...ROW_SY, JUNCTION_SY].sort((a, b) => a - b).map((sy) => ({ sy, p: ground(ROAD_SX, sy) }));
}

/** The sandbars of the wider world: the road from the stable, the high road, and a spur to each land. */
export function worldTrails(): Array<{ a: Point; b: Point }> {
  const road = highRoad();
  const trails: Array<{ a: Point; b: Point }> = [{ a: stableGate(), b: JUNCTION }];
  for (let i = 0; i < road.length - 1; i++) trails.push({ a: road[i].p, b: road[i + 1].p });
  for (const l of LANDS) trails.push({ a: ground(ROAD_SX, ROW_SY[l.row]), b: { x: l.x, y: l.y, z: 0 } });
  return trails;
}

/** The way from the crossroads to where a land's spur reaches its shore (world points). */
export function roadToLand(id: LandId): Point[] {
  const l = LAND[id];
  const target = ROW_SY[l.row];
  const road = highRoad();
  const from = road.findIndex((r) => r.sy === JUNCTION_SY);
  const to = road.findIndex((r) => r.sy === target);
  const step = to >= from ? 1 : -1;
  const points: Point[] = [];
  for (let i = from; i !== to + step; i += step) points.push(road[i].p);
  const spur = points[points.length - 1];
  const dx = spur.x - l.x;
  const dy = spur.y - l.y;
  const len = Math.hypot(dx, dy) || 1;
  points.push({ x: l.x + (dx / len) * (LAND_RADIUS - 7), y: l.y + (dy / len) * (LAND_RADIUS - 7), z: 0 });
  return points;
}

export function landIsland(l: Land, index: number): IslandSpec {
  return { cx: 0, cy: 0, rx: LAND_RADIUS, ry: LAND_RADIUS * 0.94, seed: 71 + index * 13, rim: 10, wobble: 10, grass: 0.35, trodden: 0.6 };
}

/** The screen rectangle (art px) that holds the camp and every land, for the camera's view of the world. */
export const WORLD_VIEW = { x0: SIDE_SX.far - 62, x1: 300, y0: ROW_SY[0] - 48, y1: ROW_SY[ROW_SY.length - 1] + 52 };

/** The lands and the roads west, out to the scouts' island (the east edge of the scouts' errands). */
export const LANDS_VIEW = { ...WORLD_VIEW, x1: CAMP_CENTER.sx - COLUMN + ISLAND_RADIUS + 40 };
