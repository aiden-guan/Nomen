import { describe, expect, it } from "vitest";
import { island } from "@/components/troy/engine/grounds";
import { bakeJob, dirFor, type Job, jobKey, LEAF_STEPS, PLANK_STEPS, RIDER_FRAME, SOLDIER_FRAME } from "@/components/troy/engine/jobs";
import { doorPose, exitPath, HORSE, PLANK_REST } from "@/components/troy/engine/models/horse";
import { projectX, projectY, unprojectGround } from "@/components/troy/engine/tracer";
import { knockJolt } from "@/components/troy/scenes/landing";
import {
  HORSE_GATE,
  hub,
  ISLAND_RADIUS,
  JUNCTION,
  LAND,
  LAND_RADIUS,
  landFor,
  landIsland,
  LANDS,
  type Node,
  road,
  roadToLand,
  route,
  sandbars,
  stableGate,
  STATION,
  STATIONS,
  stationIsland,
  travel,
  worldTrails,
} from "@/components/troy/scenes/layout";
import { DESK_SLOTS, LAND_SPOTS, PROPS, SPOTS, STABLE_GATE, STALLS } from "@/components/troy/scenes/stations";

// The art pipeline is deterministic: the same job always bakes the same pixels, in a worker or not.

const opaque = (rgba: Uint8ClampedArray) => {
  let n = 0;
  for (let i = 3; i < rgba.length; i += 4) if (rgba[i]) n++;
  return n;
};

describe("projection", () => {
  it("maps the ground plane back and forth", () => {
    for (const [x, y] of [
      [0, 0],
      [37.5, -12],
      [-80, 64],
    ]) {
      const back = unprojectGround(projectX(x, y), projectY(x, y, 0));
      expect(back.x).toBeCloseTo(x, 9);
      expect(back.y).toBeCloseTo(y, 9);
    }
  });

  it("draws 2:1 isometric lines", () => {
    expect(projectX(1, 0) - projectX(0, 0)).toBe(1);
    expect(projectY(1, 0, 0) - projectY(0, 0, 0)).toBe(0.5);
  });

  it("picks the heading of a move", () => {
    expect(dirFor(1, 0)).toBe(0);
    expect(dirFor(0, 1)).toBe(2);
    expect(dirFor(-1, 0)).toBe(4);
    expect(dirFor(0, -1)).toBe(6);
  });
});

describe("jobs", () => {
  it("have distinct keys", () => {
    const jobs: Job[] = [
      { k: "horse-island" },
      { k: "horse-body" },
      { k: "horse-leaves", s: 3 },
      { k: "horse-plank", s: 3 },
      { k: "soldier", look: 1, act: "march", dir: 2, f: 3 },
      { k: "soldier", look: 1, act: "march", dir: 3, f: 2 },
      { k: "island", id: "scouts" },
      { k: "bar", i: 0 },
      { k: "prop", id: "desk", v: 5 },
      { k: "rider", look: 0, dir: 1, f: 2 },
      { k: "rider", look: 0, dir: 1, f: 2, c: 1 },
      { k: "rider", look: 0, dir: 1, f: -1 },
      { k: "steed", dir: 1 },
      { k: "road", i: 0 },
      { k: "land", id: "tiktok" },
      { k: "junction" },
    ];
    expect(new Set(jobs.map(jobKey)).size).toBe(jobs.length);
  });

  it("bake soldiers into one fixed frame so feet never jump", () => {
    for (const f of [0, 3, 7]) {
      const sprite = bakeJob({ k: "soldier", look: 2, act: "march", dir: 1, f });
      expect([sprite.w, sprite.h, sprite.ax, sprite.ay]).toEqual([SOLDIER_FRAME.w, SOLDIER_FRAME.h, SOLDIER_FRAME.ax, SOLDIER_FRAME.ay]);
      expect(opaque(sprite.rgba)).toBeGreaterThan(80);
    }
  });

  it("bake riders and tied horses into one fixed frame", () => {
    for (const job of [{ k: "rider", look: 1, dir: 3, f: -1, c: 1 }, { k: "rider", look: 1, dir: 3, f: 4, c: 0 }, { k: "steed", dir: 0 }] as Job[]) {
      const sprite = bakeJob(job);
      expect([sprite.w, sprite.h, sprite.ax, sprite.ay]).toEqual([RIDER_FRAME.w, RIDER_FRAME.h, RIDER_FRAME.ax, RIDER_FRAME.ay]);
      expect(opaque(sprite.rgba)).toBeGreaterThan(60);
    }
  });

  it("bake the same pixels every time", () => {
    const a = bakeJob({ k: "prop", id: "podium", v: 0 });
    const b = bakeJob({ k: "prop", id: "podium", v: 0 });
    expect(Buffer.from(a.rgba).equals(Buffer.from(b.rgba))).toBe(true);
  });

  it("bake the horse with every door frame on the way", () => {
    const body = bakeJob({ k: "horse-body" });
    expect(opaque(body.rgba)).toBeGreaterThan(8000);
    expect(opaque(bakeJob({ k: "horse-leaves", s: LEAF_STEPS }).rgba)).toBeGreaterThan(50);
    expect(opaque(bakeJob({ k: "horse-plank", s: PLANK_STEPS }).rgba)).toBeGreaterThan(200);
  });
});

describe("the horse opening", () => {
  it("ends with the doors open and the plank resting on the sand", () => {
    const end = doorPose(1);
    expect(end.doors).toBeGreaterThan(1.8);
    expect(end.extend).toBeCloseTo(1, 6);
    expect(end.tip).toBeCloseTo(1, 6);
    // The plank's foot touches the ground exactly.
    expect(HORSE.sillZ - HORSE.plankLength * Math.sin(PLANK_REST)).toBeCloseTo(0, 9);
  });

  it("starts closed", () => {
    expect(doorPose(0)).toMatchObject({ doors: 0, extend: 0, tip: 0, glow: 0 });
  });

  it("knocks twice from inside, each time jolting the doors out and letting them fall back", () => {
    expect(knockJolt(0)).toBe(1);
    expect(knockJolt(0.12)).toBe(0);
    expect(knockJolt(0.19)).toBe(1);
    expect(knockJolt(0.4)).toBe(0);
    for (let t = 0; t < 0.5; t += 0.01) expect(knockJolt(t)).toBeLessThanOrEqual(1);
  });

  it("walks soldiers from inside the horse down to the sand", () => {
    const path = exitPath();
    expect(path[0].z).toBeGreaterThan(HORSE.sillZ);
    expect(path[path.length - 1].z).toBe(0);
  });
});

describe("the camp's roads", () => {
  it("link the horse to the scouts and every station in a ring, pipeline order first", () => {
    expect(sandbars()).toHaveLength(STATIONS.length + 1);
    expect(road("scouts", "agora")).toHaveLength(6);
    expect(road("theatre", "workshop")).toHaveLength(2);
  });

  it("take the shortest way, so nobody walks round the camp to the station below the scouts", () => {
    expect(route("horse", "agora")).toEqual(["horse", "scouts", "agora"]);
    expect(route("horse", "tent")).toEqual(["horse", "scouts", "oracle", "tent"]);
    expect(route("agora", "scouts")).toEqual(["agora", "scouts"]);
    expect(route("theatre", "horse")).toEqual(["theatre", "agora", "scouts", "horse"]);
    expect(route("oracle", "oracle")).toEqual(["oracle"]);
  });

  it("walk from the horse's gate along the sandbars to where the last one meets the island", () => {
    const path = travel("horse", "agora");
    expect(path[0]).toEqual(HORSE_GATE);
    // Through the scouts' island by its crossing point, never by the oracle.
    expect(path.some((p) => p.x === hub("scouts").x && p.y === hub("scouts").y)).toBe(true);
    expect(path.some((p) => Math.hypot(p.x - STATION.oracle.x, p.y - STATION.oracle.y) < 60)).toBe(false);
    const end = path[path.length - 1];
    expect(Math.hypot(end.x - STATION.agora.x, end.y - STATION.agora.y)).toBeCloseTo(34, 6);
    // And back the same way.
    expect(travel("agora", "horse").map((p) => [p.x, p.y])).toEqual(travel("horse", "agora").reverse().map((p) => [p.x, p.y]));
    expect(travel("oracle", "oracle")).toEqual([]);
  });

  it("cross every island clear of its furniture", () => {
    const distToSegment = (p: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }) => {
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
      return Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t));
    };
    // Furniture a walker must not cross, relative to each island: points with a clearance radius.
    const prop = (station: (typeof STATIONS)[number]["id"], id: string) => PROPS[station].find((p) => p.prop === id)!;
    const shrine = prop("oracle", "shrine");
    const podium = prop("agora", "podium");
    const tiers = prop("theatre", "tier");
    const blockers: Partial<Record<(typeof STATIONS)[number]["id"], Array<{ x: number; y: number; r: number }>>> = {
      // The shrine's platform corner nearest the road, and its middle.
      oracle: [
        { x: shrine.x + 12.5, y: shrine.y + 10.5, r: 1.5 },
        { x: shrine.x, y: shrine.y, r: 14 },
      ],
      // The seats: an arc of radius 15 to 26 around the screen.
      theatre: [0, 1, 2, 3, 4].map((i) => ({ x: tiers.x + Math.cos((i / 4) * (Math.PI / 2)) * 20, y: tiers.y + Math.sin((i / 4) * (Math.PI / 2)) * 20, r: 7 })),
      agora: [
        { x: podium.x, y: podium.y, r: 9 },
        ...PROPS.agora.filter((p) => p.prop === "banner").map((p) => ({ x: p.x, y: p.y, r: 2.5 })),
      ],
      workshop: DESK_SLOTS.slice(0, 4).map((d) => ({ x: d.x, y: d.y, r: 4.5 })),
    };
    const pairs: Array<[Node, Node]> = [
      ["scouts", "tent"],
      ["oracle", "workshop"],
      ["tent", "theatre"],
      ["workshop", "agora"],
      ["theatre", "scouts"],
    ];
    for (const [from, to] of pairs) {
      const path = travel(from, to);
      const through = route(from, to).slice(1, -1) as Array<(typeof STATIONS)[number]["id"]>;
      for (const id of through) {
        const s = STATION[id];
        for (const block of blockers[id] ?? []) {
          const p = { x: s.x + block.x, y: s.y + block.y };
          const nearest = Math.min(...path.slice(1).map((b, i) => distToSegment(p, path[i], b)));
          expect(nearest, `${from}→${to} crosses ${id} clear of furniture at (${block.x}, ${block.y})`).toBeGreaterThan(block.r);
        }
      }
    }
  });

  it("lead west from the stable to a crossroads, and on to every land", () => {
    const trails = worldTrails();
    expect(trails[0].a).toEqual(stableGate());
    expect(trails[0].b).toEqual(JUNCTION);
    for (const land of LANDS) {
      const way = roadToLand(land.id);
      expect(way[0]).toEqual(JUNCTION);
      const end = way[way.length - 1];
      expect(Math.hypot(end.x - land.x, end.y - land.y)).toBeLessThan(LAND_RADIUS);
      // Every leg of the way is on a sandbar.
      for (let i = 0; i < way.length - 2; i++) {
        const on = trails.some((t) => [t.a, t.b].some((p) => Math.hypot(p.x - way[i].x, p.y - way[i].y) < 0.01) && [t.a, t.b].some((p) => Math.hypot(p.x - way[i + 1].x, p.y - way[i + 1].y) < 0.01));
        expect(on, `${land.id}: leg ${i}`).toBe(true);
      }
    }
    // The lands lie west of the camp.
    for (const land of LANDS) expect(projectX(land.x, land.y)).toBeLessThan(projectX(STATION.scouts.x, STATION.scouts.y) - 150);
  });
});

describe("the lands", () => {
  it("send every research source to the land of the website or API it reads", () => {
    const expected: Record<string, string> = {
      brand: "site",
      site: "site",
      similar: "similarweb",
      seo_rating: "ahrefs",
      seo_keywords: "ahrefs",
      tiktok_brand: "tiktok",
      tiktok_0: "tiktok",
      tiktok_1: "tiktok",
      tiktok_ads: "tiktok",
      reels: "instagram",
      reels_0: "instagram",
      reels_conv_0: "instagram",
      shorts: "youtube",
      shorts_1: "youtube",
      scout_tiktok_0: "tiktok",
      scout_shorts_4: "youtube",
      meta_ads_brand: "metaads",
      meta_ads_0: "metaads",
      meta_ads_1: "metaads",
      reddit: "reddit",
      aeo_chatgpt: "chatgpt",
      aeo_perplexity: "perplexity",
    };
    for (const [key, land] of Object.entries(expected)) expect(landFor(key), key).toBe(land);
    expect(new Set(Object.values(expected)).size).toBe(LANDS.length);
  });

  it("stand apart from each other, the camp and the horse", () => {
    const islands = [...STATIONS.map((s) => ({ x: s.x, y: s.y, r: ISLAND_RADIUS })), { x: 4, y: 16, r: 78 }];
    LANDS.forEach((a, i) => {
      for (const b of LANDS.slice(i + 1)) expect(Math.hypot(a.x - b.x, a.y - b.y), `${a.id}–${b.id}`).toBeGreaterThan(2 * LAND_RADIUS + 20);
      for (const s of islands) expect(Math.hypot(a.x - s.x, a.y - s.y), a.id).toBeGreaterThan(LAND_RADIUS + s.r + 20);
    });
  });

  it("keep the scouts' spots and their horses on the land's sand", () => {
    LANDS.forEach((land, i) => {
      const sand = island(landIsland(LAND[land.id], i));
      for (const spot of [...LAND_SPOTS.gather, ...LAND_SPOTS.horses]) expect(sand.sdf(spot.x, spot.y), `${land.id} (${spot.x}, ${spot.y})`).toBeLessThan(0);
    });
  });

  it("bake every landmark", () => {
    for (const land of LANDS) expect(opaque(bakeJob({ k: "prop", id: land.prop, v: 0 }).rgba), land.id).toBeGreaterThan(150);
  });
});

describe("the camp's places", () => {
  const onSand = (station: (typeof STATIONS)[number], x: number, y: number) => island(stationIsland(station, STATIONS.indexOf(station))).sdf(x, y) < 0;

  it("keep the stable, its horses and its gate on the scouts' sand", () => {
    const scouts = STATION.scouts;
    for (const stall of STALLS) {
      expect(onSand(scouts, stall.horse.x, stall.horse.y)).toBe(true);
      expect(onSand(scouts, stall.mount.x, stall.mount.y)).toBe(true);
    }
    expect(onSand(scouts, STABLE_GATE.x, STABLE_GATE.y)).toBe(true);
    expect(onSand(scouts, SPOTS.courier.x, SPOTS.courier.y)).toBe(true);
  });

  it("keep everyone's waiting places on their island", () => {
    for (const spot of SPOTS.audienceRest) expect(onSand(STATION.theatre, spot.x, spot.y)).toBe(true);
    expect(onSand(STATION.workshop, SPOTS.inspector.x, SPOTS.inspector.y)).toBe(true);
  });
});
