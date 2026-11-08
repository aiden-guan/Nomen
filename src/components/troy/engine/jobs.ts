import { HORSE_ISLAND, island, sandbar } from "./grounds";
import { doorPose, horseBody, horseLeaves, horsePlank } from "./models/horse";
import { amphora, banner, campfire, easel, editDesk, hitchingRail, mapTable, mount, oliveTree, pavilion, PLATFORM_FLAGS, podium, reels, screenFrame, scrollBasket, shrine, signpost, tier, tvOnTripod, watchtower } from "./models/props";
import { GENERAL, type Look, look, type Pose, soldierInto, soldierModel, STANDING } from "./models/soldier";
import { sandbars, STATIONS, type StationId, stationIsland, TRAIL } from "../scenes/layout";
import { PROPS, type PropId } from "../scenes/stations";
import { bake, type BakeOptions, Model, mul, type Prim, rotZ, type Sprite, translate } from "./tracer";

// Everything the camp can draw is a "job": a small, serialisable description that turns into a
// baked sprite. Workers and the inline fallback share this file, so a job always bakes the same.

/** Steps of the door opening: leaves over the first 40% of the timeline, the plank after. */
export const LEAF_STEPS = 16;
export const PLANK_STEPS = 26;
export const PLANK_FROM = 0.36;

export type Act = "stand" | "march" | "carry" | "climb" | "type" | "paint" | "inspect" | "read" | "lookout" | "herald" | "point" | "cheer" | "sit" | "watch";

export type Job =
  | { k: "horse-island" }
  | { k: "horse-body" }
  | { k: "horse-leaves"; s: number }
  | { k: "horse-plank"; s: number }
  | { k: "soldier"; look: number; act: Act; dir: number; f: number }
  | { k: "island"; id: StationId }
  | { k: "bar"; i: number }
  /** The scouts' trail, leading off the edge of the world. */
  | { k: "trail" }
  | { k: "prop"; id: PropId; v: number }
  /** A mounted soldier. `f` is the gallop frame, or -1 standing still; `c` 1 carries a scroll case. */
  | { k: "rider"; look: number; dir: number; f: number; c?: number }
  /** A riderless horse standing still (tied at the stable). */
  | { k: "steed"; dir: number };

/** Frames in each act's loop. */
export const ACT_FRAMES: Record<Act, number> = { stand: 1, march: 8, carry: 8, climb: 4, type: 4, paint: 4, inspect: 4, read: 2, lookout: 2, herald: 2, point: 4, cheer: 2, sit: 1, watch: 2 };

/** Seconds per frame for each act (walks are driven by distance instead). */
export const ACT_RATE: Record<Act, number> = { stand: 1, march: 0.09, carry: 0.09, climb: 0.14, type: 0.13, paint: 0.22, inspect: 0.4, read: 0.9, lookout: 1.2, herald: 0.5, point: 0.35, cheer: 0.25, sit: 1, watch: 1.6 };

/** Fixed canvas shared by every soldier frame so feet never jump between frames. */
export const SOLDIER_FRAME = { w: 44, h: 58, ax: 22, ay: 48 };

export function jobKey(job: Job): string {
  switch (job.k) {
    case "horse-island":
      return "hi";
    case "horse-body":
      return "hb";
    case "horse-leaves":
      return `hl${job.s}`;
    case "horse-plank":
      return `hp${job.s}`;
    case "soldier":
      return `s${job.look}.${job.act}.${job.dir}.${job.f}`;
    case "island":
      return `i.${job.id}`;
    case "bar":
      return `b${job.i}`;
    case "trail":
      return "tr";
    case "prop":
      return `p.${job.id}.${job.v}`;
    case "rider":
      return `r${job.look}.${job.dir}.${job.f}.${job.c ?? 0}`;
    case "steed":
      return `st${job.dir}`;
  }
}

/** Fixed canvas for riders. */
export const RIDER_FRAME = { w: 72, h: 72, ax: 36, ay: 54 };
export const RIDER_FRAMES = 6;

/** Builds one prop (variant `v`) around its own origin. */
export function propModel(id: PropId, v = 0): Model {
  const m = new Model();
  switch (id) {
    case "tower":
      watchtower(m);
      break;
    case "basket":
      scrollBasket(m, v / 7);
      break;
    case "signpost":
      signpost(m);
      break;
    case "shrine":
      shrine(m);
      // The television inside; v = 0 is off, 1..4 are frames of whatever it is studying.
      m.with(translate(0, 0, 3), () => tvOnTripod(m, v > 0 ? 1 : 0, (v % 4) / 4));
      break;
    case "pavilion":
      pavilion(m);
      break;
    case "maptable":
      mapTable(m);
      break;
    case "desk":
      // v = state * 4 + phase (state: 0 idle, 1 rendering, 2 done, 3 failed).
      editDesk(m, Math.floor(v / 4), (v % 4) / 4);
      break;
    case "easel":
      easel(m, v / 4);
      break;
    case "reels":
      reels(m, v);
      break;
    case "tier":
      tier(m, v);
      break;
    case "screen":
      screenFrame(m);
      break;
    case "podium":
      podium(m);
      break;
    case "banner": {
      const flag = PLATFORM_FLAGS[Math.floor(v / 4) % PLATFORM_FLAGS.length];
      banner(m, flag.colors, (v % 4) / 4);
      break;
    }
    case "olive":
      oliveTree(m, v);
      break;
    case "amphora":
      amphora(m);
      break;
    case "campfire":
      campfire(m, v);
      break;
    case "rail":
      hitchingRail(m);
      break;
  }
  return m;
}

/** Everything standing on a station's island, placed, for the island's shadows. */
function stationCasters(id: StationId): Prim[] {
  const all: Prim[] = [];
  for (const placement of PROPS[id]) {
    const holder = new Model();
    holder.with(translate(placement.x, placement.y, 0), () => holder.include(propModel(placement.prop, placement.v ?? 0)));
    all.push(...holder.prims);
  }
  return all;
}

function riderModel(lookIndex: number, dir: number, f: number, carry: number) {
  const m = new Model();
  const still = f < 0;
  m.with(rotZ(dir * (Math.PI / 4)), () => {
    mount(m, f);
    const bob = still ? 0 : Math.sin((f / RIDER_FRAMES) * Math.PI * 4) * 0.35;
    m.with(mul(translate(-0.6, 0, bob), rotZ(0)), () => {
      // Out on a run the hands are on the reins; coming back they hold the scroll case.
      const pose = carry ? { armL: 0.9, armR: 0.7, hold: "case" as const } : { armL: 0.75, armR: 0.75, hold: "none" as const };
      soldierInto(m, { ...STANDING, facing: 0, sit: 11.4, ride: true, ...pose, shield: false, lean: still ? 0.05 : 0.25 }, lookFor(lookIndex));
    });
  });
  return m;
}

function steedModel(dir: number) {
  const m = new Model();
  m.with(rotZ(dir * (Math.PI / 4)), () => mount(m, -1));
  return m;
}

/** Eight headings, 45° apart; index 0 faces +x (screen right-down). */
export function dirFor(dx: number, dy: number) {
  return (Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) + 8) % 8;
}

function lookFor(index: number): Look {
  return index < 0 ? GENERAL : look(index);
}

export function poseFor(act: Act, dir: number, f: number): Pose {
  const facing = dir * (Math.PI / 4);
  const n = ACT_FRAMES[act];
  const phase = f / n;
  const wave = Math.sin(phase * Math.PI * 2);
  const base: Pose = { ...STANDING, facing };
  switch (act) {
    case "stand":
      return base;
    case "march":
      return { ...base, walk: phase, stride: 1 };
    case "carry":
      return { ...base, walk: phase, stride: 0.85, hold: "case", shield: false, armL: 0.95, armR: 0.95 };
    case "climb":
      // Hand over hand up a ladder, knees lifting in turn.
      return { ...base, walk: phase, stride: 0.45, hold: "none", shield: false, armL: 2.5 + wave * 0.35, armR: 2.5 - wave * 0.35, lean: -0.08 };
    case "type":
      return { ...base, sit: 2.4, armL: 1.22 + wave * 0.08, armR: 1.22 - wave * 0.08, hold: "none", shield: false, lean: 0.18, nod: -0.15, work: phase };
    case "paint":
      return { ...base, armR: 1.0 + wave * 0.28, armL: 0.25, hold: "brush", shield: false, lean: 0.05 };
    case "inspect":
      return { ...base, armR: 1.0, armL: 0.15, hold: "magnifier", shield: false, lean: 0.32 + wave * 0.08, nod: 0.3 };
    case "read":
      return { ...base, armL: 1.0, armR: 1.0, hold: "scroll", shield: false, nod: 0.22 + wave * 0.06 };
    case "lookout":
      return { ...base, armR: 1.35, armL: 0.9 + wave * 0.05, hold: "spyglass", shield: true };
    case "herald":
      return { ...base, armR: 1.4 + (f % 2) * 0.15, armL: 0.2, hold: "trumpet", shield: false, nod: -(f % 2) * 0.15 };
    case "point":
      return { ...base, armR: 1.3 + wave * 0.12, armL: 0, hold: "point", shield: false, lean: 0.2 };
    case "cheer":
      return { ...base, armR: 2.7 - (f % 2) * 0.3, armL: 2.7 - ((f + 1) % 2) * 0.3, hold: "none", shield: false };
    case "sit":
      return { ...base, sit: 4.2, armL: 0.6, armR: 0.6, hold: "none", shield: false, lean: 0.12 };
    case "watch":
      return { ...base, sit: 2.4, armL: 0.75, armR: 0.75, hold: "none", shield: false, lean: -0.05, nod: f % 2 ? -0.08 : 0 };
  }
}

function withOptions(model: Model, options: BakeOptions = {}) {
  return bake(model.prims, options);
}

export function bakeJob(job: Job): Sprite {
  switch (job.k) {
    case "horse-island":
      // The island with the horse's shadow on it; the horse itself is its own layer above.
      return bake([], { ground: island(HORSE_ISLAND), shadowCasters: horseBody({ silhouettes: false }).prims });
    case "horse-body":
      return withOptions(horseBody());
    case "horse-leaves": {
      const t = (job.s / LEAF_STEPS) * 0.4;
      return withOptions(horseLeaves(doorPose(t).doors), { holdouts: horseBody({ silhouettes: false }).prims });
    }
    case "horse-plank": {
      const t = PLANK_FROM + (job.s / PLANK_STEPS) * (1 - PLANK_FROM);
      const pose = doorPose(t);
      return withOptions(horsePlank(pose.extend, pose.tip), {
        ground: island(HORSE_ISLAND),
        shadowOnly: true,
        holdouts: horseBody({ silhouettes: false }).prims,
      });
    }
    case "soldier":
      return withOptions(soldierModel(poseFor(job.act, job.dir, job.f), lookFor(job.look)), { frame: SOLDIER_FRAME });
    case "island": {
      const index = STATIONS.findIndex((s) => s.id === job.id);
      return bake([], { ground: island(stationIsland(STATIONS[index], index)), shadowCasters: stationCasters(job.id) });
    }
    case "bar": {
      const bar = sandbars()[job.i];
      return bake([], { ground: sandbar(bar.a, bar.b, 100 + job.i) });
    }
    case "trail":
      return bake([], { ground: sandbar(TRAIL.a, TRAIL.b, 140, { fade: true }) });
    case "prop":
      return withOptions(propModel(job.id, job.v));
    case "rider":
      return withOptions(riderModel(job.look, job.dir, job.f, job.c ?? 0), { frame: RIDER_FRAME });
    case "steed":
      return withOptions(steedModel(job.dir), { frame: RIDER_FRAME });
  }
}
