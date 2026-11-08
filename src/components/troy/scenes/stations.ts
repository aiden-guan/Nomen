import { STABLE, STABLE_GATE, type StationId } from "./layout";

export { STABLE, STABLE_GATE };

// What stands on each island, relative to the island's centre (world units), and where the
// agents work. Props are their own sprites so figures can walk in front of and behind them.

export type PropId =
  | "tower"
  | "basket"
  | "signpost"
  | "shrine"
  | "pavilion"
  | "maptable"
  | "desk"
  | "easel"
  | "reels"
  | "tier"
  | "screen"
  | "podium"
  | "banner"
  | "olive"
  | "amphora"
  | "campfire"
  | "rail"
  // The lands' landmarks (engine/models/lands.ts).
  | "phone"
  | "gallery"
  | "bigscreen"
  | "billboards"
  | "forum"
  | "orbshrine"
  | "crystal"
  | "beacon"
  | "huts"
  | "gate"
  // The battle below the agora (engine/models/battle.ts).
  | "catapult"
  | "ballista"
  | "fort";

export type Placement = { prop: PropId; x: number; y: number; v?: number; key?: string; sort?: number };

export type Spot = { x: number; y: number; z?: number; dir: number };

/** A point on the way to a post (relative to the island), with the act and heading for that leg. */
export type Waypoint = { x: number; y: number; z: number; act?: "climb" | "march"; dir?: number };

/** Desk slots in the workshop. Desks face the camera; the editor sits at EDITOR_OFFSET from it. */
export const DESK_SLOTS: Array<{ x: number; y: number }> = [
  { x: -22, y: -16 },
  { x: -8, y: -28 },
  { x: -26, y: 2 },
  { x: -6, y: -8 },
  { x: -12, y: 16 },
  { x: 10, y: -2 },
];

/** Where an editor sits relative to their desk (on the stool, in front of the screen). */
export const EDITOR_OFFSET = { x: 4.95, y: 4.95, dir: 5 };


export const PROPS: Record<StationId, Placement[]> = {
  scouts: [
    { prop: "tower", x: -16, y: -14 },
    // Beside the road to the oracle, not on it.
    { prop: "signpost", x: 20, y: -30 },
    { prop: "basket", x: 8, y: 8, v: 0, key: "basket" },
    // The stable: scouts take a horse here and ride off along the road west to the lands (left).
    // Centred on the line of eight horses (see STALLS).
    { prop: "rail", x: STABLE.x, y: STABLE.y - 7 },
    { prop: "olive", x: -6, y: -38, v: 1 },
    { prop: "amphora", x: 30, y: 8 },
  ],
  oracle: [
    // Set back from the road, which runs straight through the island in front of it.
    { prop: "shrine", x: -12, y: -12, v: 0, key: "shrine" },
    { prop: "olive", x: 12, y: -30, v: 2 },
    { prop: "amphora", x: 22, y: 18 },
    { prop: "amphora", x: 26, y: 13 },
  ],
  tent: [
    { prop: "pavilion", x: -14, y: -14 },
    { prop: "maptable", x: 12, y: 8 },
    { prop: "amphora", x: -30, y: 14 },
    { prop: "olive", x: 26, y: -28, v: 3 },
  ],
  workshop: [
    { prop: "easel", x: 20, y: -24, v: 0, key: "easel" },
    { prop: "reels", x: 22, y: 18, v: 0, key: "reels" },
    { prop: "olive", x: 32, y: -6, v: 4 },
  ],
  theatre: [
    { prop: "screen", x: -15, y: -15, key: "screen" },
    // Each row of seats is its own sprite so spectators layer between rows (see SPOTS.audience).
    { prop: "tier", x: -15, y: -15, v: 0, sort: 18 },
    { prop: "tier", x: -15, y: -15, v: 1, sort: 24 },
    { prop: "tier", x: -15, y: -15, v: 2, sort: 30 },
    { prop: "olive", x: 26, y: -28, v: 5 },
  ],
  agora: [
    { prop: "podium", x: -6, y: -6 },
    { prop: "banner", x: 14, y: -10, v: 0, key: "banner0" },
    { prop: "banner", x: 24, y: -4, v: 4, key: "banner1" },
    { prop: "banner", x: -20, y: 16, v: 8, key: "banner2" },
    { prop: "olive", x: -30, y: -20, v: 6 },
    { prop: "amphora", x: 26, y: 18 },
  ],
};

/** Named places where agents stand or sit (relative to the island centre). */
export const SPOTS = {
  lookout: { x: -16, y: -14, z: 25.1, dir: 1 },
  /** Up the ladder on the tower's +y face, then across the platform. */
  lookoutClimb: [
    { x: -16, y: -3.6, z: 0, dir: 6 },
    { x: -16, y: -5, z: 24.8, act: "climb", dir: 6 },
  ] as Waypoint[],
  queue: (i: number): Spot => ({ x: -2 + (i % 3) * 5, y: 6 + Math.floor(i / 3) * 6 - (i % 3) * 2, dir: 6 }),
  basket: { x: 12, y: 14, dir: 5 },
  /** Where scouts leave the island (toward the outside of the camp) and come back. */
  exits: [
    { x: -38, y: 26, dir: 2 },
    { x: -42, y: -6, dir: 3 },
    { x: -16, y: 38, dir: 2 },
  ] as Spot[],
  /** On the shrine's floor (its top step is at z 2.8), facing the television. */
  watcher: { x: -3.5, y: -12, z: 2.8, dir: 4 },
  /** Up the shrine's two steps from the front. */
  watcherSteps: [
    { x: 5, y: -9, z: 0, dir: 4 },
    { x: -0.3, y: -10, z: 1.6, dir: 4 },
  ] as Waypoint[],
  general: { x: 1, y: 9, dir: 0 },
  scribe: { x: 15, y: -2, dir: 2 },
  painter: { x: 24.5, y: -24, dir: 4 },
  // Seated on the tiers (centre -15, -15), near the middle of the arc so row sorting holds.
  // `z` is the seat top; seated figures are drawn lower by WATCH_DROP.
  audience: [
    { x: -2.7, y: -6.4, z: 1.2, dir: 5 },
    { x: -6.4, y: -2.7, z: 1.2, dir: 5 },
    { x: 0.6, y: -1.8, z: 2.4, dir: 5 },
    { x: 1.8, y: 3.6, z: 3.6, dir: 5 },
  ] as Spot[],
  herald: { x: -6, y: -6, z: 5.1, dir: 1 },
  /** Onto the podium by its step on the +x side. */
  heraldSteps: [
    { x: 4, y: -6, z: 0, dir: 4 },
    { x: 0.6, y: -6, z: 2.2, dir: 4 },
  ] as Waypoint[],
  /** Where the courier waits between dispatches: by the stable, near his horse. */
  courier: { x: -14, y: 28, dir: 4 },
  /** The inspector's place in the workshop while no shot is in quality check. */
  inspector: { x: 14, y: 22, dir: 5 },
  /** Where the audience waits, standing, until there is a cut to watch. */
  audienceRest: [
    { x: 28, y: -2, dir: 5 },
    { x: 22, y: 4, dir: 5 },
    { x: 32, y: 6, dir: 5 },
    { x: 26, y: 11, dir: 5 },
  ] as Spot[],
};


/**
 * Eight horses tied along the rail, facing it (+x, heads over the rail toward the island), and
 * where a rider stands to mount each one: behind its rump, in the aisle. The last stall, nearest
 * the gate, is the courier's, so dispatches never wait behind the research.
 */
export const STALLS = [-28, -22, -16, -10, -4, 2, 8, 14].map((dy, i) => ({
  horse: { x: STABLE.x - 7, y: STABLE.y + dy, dir: 0 },
  mount: { x: STABLE.x - 14, y: STABLE.y + dy, dir: 0 },
  /** Its horse's coat (bay, chestnut, dun, grey, black: see COATS), never the same as its neighbour's; the courier's is grey. */
  coat: [0, 1, 4, 2, 0, 1, 2, 3][i],
}));
export const COURIER_STALL = STALLS.length - 1;
/**
 * The aisle behind the horses: everyone walks or rides along it between the gate and a stall, so
 * nobody passes through a tied horse. `south` is where it meets the way to the gate.
 */
export const STABLE_AISLE = { x: STABLE.x - 16, south: STABLE.y + 20 };

/**
 * On every land (relative to its centre): its landmark, where scouts stand to gather in front of
 * it, and where they leave their horses meanwhile. Spot `i` goes with horse `i`.
 */
export const LAND_SPOTS = {
  landmark: { x: -5, y: -5 },
  gather: [
    { x: 7, y: 3, dir: 5 },
    { x: 3, y: 8, dir: 5 },
    { x: 11, y: 9, dir: 5 },
    { x: 9, y: -4, dir: 4 },
  ] as Spot[],
  horses: [
    { x: 17, y: 12, dir: 1 },
    { x: 12, y: 18, dir: 1 },
    { x: 20, y: 3, dir: 1 },
    { x: 4, y: 21, dir: 1 },
  ] as Spot[],
};


/** Seated spectators sit this far below the seat top (their feet rest on the step below). */
export const WATCH_DROP = 2.4;
