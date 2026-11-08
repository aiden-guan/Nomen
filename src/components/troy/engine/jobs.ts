import { HORSE_ISLAND, island, sandbar, sea, town } from "./grounds";
import { ballista, catapult, romanFort } from "./models/battle";
import { doorPose, horseBody, horseLeaves, horsePlank } from "./models/horse";
import { adBillboards, answerShrine, brandGate, crystalSpire, instagramGallery, lookalikeHuts, rankBeacon, redditForum, tiktokPhone, youtubeScreen } from "./models/lands";
import { amphora, banner, campfire, easel, editDesk, hitchingRail, mapTable, mount, oliveTree, pavilion, PLATFORM_FLAGS, podium, reels, screenFrame, scrollBasket, shrine, signpost, tier, tvOnTripod, watchtower } from "./models/props";
import { amphitheatre, aqueduct, cypress, fountain, gatehouse, honourColumn, horreum, house, pharos, pine, rocks, ruin, standard, temple, tower, wall } from "./models/rome";
import { beacon as firetower, bollard, cargo, crane, hullModel, type Plank, rigModel } from "./models/ships";
import { type Look, lookByIndex, type Pose, soldierInto, soldierModel, STANDING } from "./models/soldier";
import {
  harborProps,
  HOME_SHORE,
  isletAt,
  isletIsland,
  isletProps,
  ISLETS,
  homeQuay,
  homeShore,
  LAND,
  type LandId,
  LANDS,
  landIsland,
  ROME,
  romeLand,
  ROME_PAVING,
  romeProps,
  romeQuay,
  romeTiles,
  sandbars,
  SEA,
  seaTiles,
  SHORE_ROAD,
  type Standing,
  STATIONS,
  type StationId,
  stationIsland,
  worldTrails,
} from "../scenes/layout";
import { LAND_SPOTS, PROPS, type PropId } from "../scenes/stations";
import { bake, type BakeOptions, Model, mul, type Prim, rotZ, type Sprite, translate } from "./tracer";

// Everything the camp can draw is a "job": a small, serialisable description that turns into a
// baked sprite. Workers and the inline fallback share this file, so a job always bakes the same.

/** Steps of the door opening: leaves over the first 40% of the timeline, the plank after. */
export const LEAF_STEPS = 16;
export const PLANK_STEPS = 26;
export const PLANK_FROM = 0.36;

export type Act =
  | "stand"
  | "march"
  | "carry"
  | "climb"
  | "type"
  | "paint"
  | "inspect"
  | "read"
  | "lookout"
  | "herald"
  | "point"
  | "cheer"
  | "sit"
  | "watch"
  // The battle below the agora: thrusting the spear (a Roman stabs with his gladius), charging
  // with it levelled, loosing arrows, knocked flat, and hauling a catapult's arm down.
  | "fight"
  | "charge"
  | "shoot"
  | "fallen"
  | "haul";

export type Job =
  | { k: "horse-island" }
  | { k: "horse-body" }
  | { k: "horse-leaves"; s: number }
  | { k: "horse-plank"; s: number }
  | { k: "soldier"; look: number; act: Act; dir: number; f: number }
  | { k: "island"; id: StationId }
  | { k: "bar"; i: number }
  /** A road of the wider world (see worldTrails). */
  | { k: "road"; i: number }
  /** A land the scouts ride to, with its landmark's shadow. */
  | { k: "land"; id: LandId }
  /** The crossroads on the high road. */
  | { k: "junction" }
  /** A ship's hull (oar frame `f`, gangplank `p`) or its rig (sail `s` set or furled), heading `dir`, in colour `c`. */
  | { k: "hull"; dir: number; f: number; c: number; p: number }
  | { k: "rig"; dir: number; s: number; c: number }
  /** A tile of the sea between the harbours. */
  | { k: "sea"; i: number }
  /** The shore below the agora with its quay; the road down to it. */
  | { k: "shore" }
  | { k: "shore-road" }
  /** A tile of the rival's city, with the shadows of what stands on it. */
  | { k: "rome"; i: number }
  /** An islet in the sea. */
  | { k: "islet"; i: number }
  | { k: "prop"; id: PropId; v: number }
  /** A mounted soldier. `f` is the gallop frame, or -1 standing still; `c` 1 carries a scroll case. */
  | { k: "rider"; look: number; dir: number; f: number; c?: number; h?: number }
  /** A riderless horse standing still (tied at the stable). */
  | { k: "steed"; dir: number; h?: number };

/** Frames in each act's loop. */
export const ACT_FRAMES: Record<Act, number> = { stand: 1, march: 8, carry: 8, climb: 4, type: 4, paint: 4, inspect: 4, read: 2, lookout: 2, herald: 2, point: 4, cheer: 2, sit: 1, watch: 2, fight: 4, charge: 8, shoot: 4, fallen: 1, haul: 4 };

/** Seconds per frame for each act (walks are driven by distance instead). */
export const ACT_RATE: Record<Act, number> = { stand: 1, march: 0.09, carry: 0.09, climb: 0.14, type: 0.13, paint: 0.22, inspect: 0.4, read: 0.9, lookout: 1.2, herald: 0.5, point: 0.35, cheer: 0.25, sit: 1, watch: 1.6, fight: 0.17, charge: 0.07, shoot: 0.32, fallen: 1, haul: 0.26 };

/** The frame of the "shoot" loop on which the arrow leaves the string. */
export const SHOOT_RELEASE = 3;

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
    case "road":
      return `rd${job.i}`;
    case "land":
      return `l.${job.id}`;
    case "junction":
      return "jn";
    case "hull":
      return `hu${job.dir}.${job.f}.${job.c}.${job.p}`;
    case "rig":
      return `rg${job.dir}.${job.s}.${job.c}`;
    case "sea":
      return `se${job.i}`;
    case "shore":
      return "so";
    case "shore-road":
      return "sr";
    case "rome":
      return `ro${job.i}`;
    case "islet":
      return `il${job.i}`;
    case "prop":
      return `p.${job.id}.${job.v}`;
    case "rider":
      return `r${job.look}.${job.dir}.${job.f}.${job.c ?? 0}.${job.h ?? 0}`;
    case "steed":
      return `st${job.dir}.${job.h ?? 0}`;
  }
}

/** Fixed canvas shared by a ship's hull and rig in every heading, so the two always line up. */
export const SHIP_FRAME = { w: 150, h: 120, ax: 75, ay: 80 };

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
    case "catapult":
      catapult(m, v);
      break;
    case "ballista":
      ballista(m, v);
      break;
    case "fort":
      romanFort(m);
      break;
    case "crane":
      crane(m);
      break;
    case "cargo":
      cargo(m, v);
      break;
    case "bollard":
      bollard(m);
      break;
    case "firetower":
      firetower(m, v);
      break;
    case "temple":
      temple(m);
      break;
    case "wall":
      wall(m, v);
      break;
    case "tower":
      tower(m, v);
      break;
    case "gatehouse":
      gatehouse(m, v);
      break;
    case "house":
      house(m, v);
      break;
    case "amphitheatre":
      amphitheatre(m);
      break;
    case "aqueduct":
      // 100 and up: the same run turned to stride along x.
      m.with(rotZ(v >= 100 ? Math.PI / 2 : 0), () => aqueduct(m, v % 100));
      break;
    case "pharos":
      pharos(m, v);
      break;
    case "cypress":
      cypress(m, v);
      break;
    case "pine":
      pine(m, v);
      break;
    case "column":
      honourColumn(m);
      break;
    case "fountain":
      fountain(m, v);
      break;
    case "horreum":
      horreum(m);
      break;
    case "standard":
      // v: 0..3 the legion's banner waving, 4..7 the Greeks'.
      standard(m, v >= 4 ? 1 : 0, (v % 4) / 4);
      break;
    case "rocks":
      rocks(m, v);
      break;
    case "ruin":
      ruin(m);
      break;
    case "phone":
      tiktokPhone(m);
      break;
    case "gallery":
      instagramGallery(m);
      break;
    case "bigscreen":
      youtubeScreen(m);
      break;
    case "billboards":
      adBillboards(m);
      break;
    case "forum":
      redditForum(m);
      break;
    case "orbshrine":
      answerShrine(m);
      break;
    case "crystal":
      crystalSpire(m);
      break;
    case "beacon":
      rankBeacon(m);
      break;
    case "huts":
      lookalikeHuts(m);
      break;
    case "gate":
      brandGate(m);
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

/** Props standing near a world rectangle (within `reach`), placed, for a ground's shadows. */
function castersNear(props: Standing[], r: { x0: number; y0: number; x1: number; y1: number }, reach: number): Prim[] {
  const all: Prim[] = [];
  for (const p of props) {
    if (p.x < r.x0 - reach || p.x > r.x1 + reach || p.y < r.y0 - reach || p.y > r.y1 + reach) continue;
    const holder = new Model();
    holder.with(translate(p.x, p.y, p.z ?? 0), () => holder.include(propModel(p.prop, p.v ?? 0)));
    all.push(...holder.prims);
  }
  return all;
}

/** The home shore as a town: its quay along the water, its sand and grass. */
export function shoreGround() {
  const spec = homeShore();
  return town({
    land: { ...spec, cx: HOME_SHORE.x + spec.cx, cy: HOME_SHORE.y + spec.cy, lobes: spec.lobes?.map((l) => ({ ...l, cx: HOME_SHORE.x + l.cx, cy: HOME_SHORE.y + l.cy })) },
    quays: [homeQuay()],
    paving: [],
  });
}

/** The rival's city as a town (one tile of it, or all of it for the sea's foam). */
export function romeGround(tile?: { x0: number; y0: number; x1: number; y1: number }) {
  const spec = romeLand();
  const inBox = (box: { a0: number; a1: number; b0: number; b1: number }) => (x: number, y: number) => {
    const a = x - ROME.x;
    const b = y - ROME.y;
    return a >= box.a0 && a <= box.a1 && b >= box.b0 && b <= box.b1;
  };
  return town({
    land: { ...spec, cx: ROME.x + spec.cx, cy: ROME.y + spec.cy, lobes: spec.lobes?.map((l) => ({ ...l, cx: ROME.x + l.cx, cy: ROME.y + l.cy })) },
    quays: [romeQuay()],
    paving: [
      { kind: "forum", inside: inBox(ROME_PAVING.forum), centre: { x: ROME.x - 10, y: ROME.y + 12 } },
      ...ROME_PAVING.streets.map((street) => ({ kind: "street" as const, inside: inBox(street) })),
      { kind: "quay", inside: inBox(ROME_PAVING.mole) },
    ],
    tile,
  });
}

/** A soldier on horseback; `coat` is the horse's (see COATS in props.ts). */
function riderModel(lookIndex: number, dir: number, f: number, carry: number, coat: number) {
  const m = new Model();
  const still = f < 0;
  m.with(rotZ(dir * (Math.PI / 4)), () => {
    mount(m, f, coat);
    const bob = still ? 0 : Math.sin((f / RIDER_FRAMES) * Math.PI * 4) * 0.35;
    m.with(mul(translate(-0.6, 0, bob), rotZ(0)), () => {
      // Out on a run the hands are on the reins; coming back they hold the scroll case.
      const pose = carry ? { armL: 0.9, armR: 0.7, hold: "case" as const } : { armL: 0.75, armR: 0.75, hold: "none" as const };
      soldierInto(m, { ...STANDING, facing: 0, sit: 11.4, ride: true, ...pose, shield: false, lean: still ? 0.05 : 0.25 }, lookFor(lookIndex));
    });
  });
  return m;
}

function steedModel(dir: number, coat: number) {
  const m = new Model();
  m.with(rotZ(dir * (Math.PI / 4)), () => mount(m, -1, coat));
  return m;
}

/** Eight headings, 45° apart; index 0 faces +x (screen right-down). */
export function dirFor(dx: number, dy: number) {
  return (Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) + 8) % 8;
}

function lookFor(index: number): Look {
  return lookByIndex(index);
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
    case "fight": {
      // Shield up, spear (or gladius) back, thrust, hold, recover.
      const thrust = [0, 1, 0.75, 0.2][f % 4];
      return { ...base, hold: "lance", armR: 1.2 + thrust * 0.32, armL: 0.35, lean: 0.08 + thrust * 0.26, walk: 0.25, stride: 0.25 + thrust * 0.2 };
    }
    case "charge":
      return { ...base, walk: phase, stride: 1.15, lean: 0.24, hold: "lance", armR: 1.3, armL: 0.3 };
    case "shoot":
      // Nock, draw, full draw, loose.
      return { ...base, hold: "bow", shield: false, armL: 1.5, draw: [0, 0.55, 1, 0][f % 4], lean: 0.04, nod: -0.05 };
    case "fallen":
      return { ...base, fallen: true };
    case "haul":
      return { ...base, hold: "none", shield: false, armL: 1.15 + wave * 0.5, armR: 1.15 + wave * 0.5, lean: 0.32 + wave * 0.08 };
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
    case "road": {
      const road = worldTrails()[job.i];
      return bake([], { ground: sandbar(road.a, road.b, 140 + job.i) });
    }
    case "land": {
      const index = LANDS.findIndex((l) => l.id === job.id);
      const holder = new Model();
      holder.with(translate(LAND_SPOTS.landmark.x, LAND_SPOTS.landmark.y, 0), () => holder.include(propModel(LAND[job.id].prop)));
      return bake([], { ground: island(landIsland(LAND[job.id], index)), shadowCasters: holder.prims });
    }
    case "junction": {
      const holder = new Model();
      holder.with(translate(-3, -3, 0), () => holder.include(propModel("signpost")));
      return bake([], { ground: island({ cx: 0, cy: 0, rx: 13, ry: 12, seed: 61, rim: 8, wobble: 6, grass: 0.4 }), shadowCasters: holder.prims });
    }
    case "hull": {
      const m = new Model();
      hullModel(m, job.dir, job.f, job.c, job.p as Plank);
      // The sail's shadow falls on the deck.
      const rigging = new Model();
      rigModel(rigging, job.dir, 1, job.c);
      return withOptions(m, { frame: SHIP_FRAME, shadowCasters: rigging.prims.filter((p) => p.cast) });
    }
    case "rig": {
      const m = new Model();
      rigModel(m, job.dir, job.s, job.c);
      // The hull hides the foot of the mast behind it.
      const body = new Model();
      hullModel(body, job.dir, 4, job.c, 0);
      return withOptions(m, { frame: SHIP_FRAME, holdouts: body.prims });
    }
    case "sea": {
      const shore = shoreGround();
      const rome = romeGround();
      const islets = ISLETS.map((_, i) => {
        const c = isletAt(i);
        const g = island(isletIsland(i));
        return (x: number, y: number) => g.sdf(x - c.x, y - c.y);
      });
      return bake([], { ground: sea({ area: SEA, shores: [shore.distance, rome.distance, ...islets], seed: 7, tile: seaTiles()[job.i] }) });
    }
    case "islet": {
      const c = isletAt(job.i);
      return bake([], { ground: island(isletIsland(job.i)), shadowCasters: castersNear(isletProps().map((p) => ({ ...p, x: p.x - c.x, y: p.y - c.y })), { x0: -40, y0: -40, x1: 40, y1: 40 }, 10) });
    }
    case "shore": {
      const ground = shoreGround();
      return bake([], { ground, shadowCasters: castersNear(harborProps(), ground.bounds, 40) });
    }
    case "shore-road":
      return bake([], { ground: sandbar(SHORE_ROAD.a, SHORE_ROAD.b, 171) });
    case "rome": {
      const tile = romeTiles()[job.i];
      return bake([], { ground: romeGround(tile), shadowCasters: castersNear(romeProps(), tile, 80) });
    }
    case "prop":
      return withOptions(propModel(job.id, job.v));
    case "rider":
      return withOptions(riderModel(job.look, job.dir, job.f, job.c ?? 0, job.h ?? 0), { frame: RIDER_FRAME });
    case "steed":
      return withOptions(steedModel(job.dir, job.h ?? 0), { frame: RIDER_FRAME });
  }
}
