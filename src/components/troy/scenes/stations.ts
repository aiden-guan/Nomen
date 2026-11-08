import type { StationId } from "./layout";

// What stands on each island, relative to the island's centre (world units), and where the
// agents work. Props are their own sprites so figures can walk in front of and behind them.

export type PropId = "tower" | "basket" | "signpost" | "shrine" | "pavilion" | "maptable" | "desk" | "easel" | "reels" | "tier" | "screen" | "podium" | "banner" | "olive" | "amphora" | "campfire";

export type Placement = { prop: PropId; x: number; y: number; v?: number; key?: string; sort?: number };

export type Spot = { x: number; y: number; z?: number; dir: number };

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
    { prop: "signpost", x: 22, y: -22 },
    { prop: "basket", x: 8, y: 8, v: 0, key: "basket" },
    { prop: "olive", x: -32, y: 22, v: 1 },
    { prop: "amphora", x: 30, y: 8 },
  ],
  oracle: [
    { prop: "shrine", x: -8, y: -8, v: 0, key: "shrine" },
    { prop: "olive", x: 26, y: -22, v: 2 },
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
    { prop: "banner", x: 16, y: -20, v: 0, key: "banner0" },
    { prop: "banner", x: 24, y: -4, v: 4, key: "banner1" },
    { prop: "banner", x: -20, y: 16, v: 8, key: "banner2" },
    { prop: "olive", x: -30, y: -20, v: 6 },
    { prop: "amphora", x: 26, y: 18 },
  ],
};

/** Named places where agents stand or sit (relative to the island centre). */
export const SPOTS = {
  lookout: { x: -16, y: -14, z: 25.1, dir: 1 },
  queue: (i: number): Spot => ({ x: -2 + (i % 3) * 5, y: 6 + Math.floor(i / 3) * 6 - (i % 3) * 2, dir: 6 }),
  basket: { x: 12, y: 14, dir: 5 },
  /** Where scouts leave the island (toward the outside of the camp) and come back. */
  exits: [
    { x: -38, y: 26, dir: 2 },
    { x: -42, y: -6, dir: 3 },
    { x: -16, y: 38, dir: 2 },
  ] as Spot[],
  watcher: { x: 0.5, y: -8, dir: 4 },
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
};

/** Seated spectators sit this far below the seat top (their feet rest on the step below). */
export const WATCH_DROP = 2.4;
