import { describe, expect, it } from "vitest";
import { bakeJob, dirFor, type Job, jobKey, LEAF_STEPS, PLANK_STEPS, SOLDIER_FRAME } from "@/components/troy/engine/jobs";
import { doorPose, exitPath, HORSE, PLANK_REST } from "@/components/troy/engine/models/horse";
import { projectX, projectY, unprojectGround } from "@/components/troy/engine/tracer";
import { road, sandbars, STATIONS } from "@/components/troy/scenes/layout";

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

  it("walks soldiers from inside the horse down to the sand", () => {
    const path = exitPath();
    expect(path[0].z).toBeGreaterThan(HORSE.sillZ);
    expect(path[path.length - 1].z).toBe(0);
  });
});

describe("the camp's roads", () => {
  it("link the horse and every station in pipeline order", () => {
    expect(sandbars()).toHaveLength(STATIONS.length);
    expect(road("scouts", "agora")).toHaveLength(6);
    expect(road("theatre", "workshop")).toHaveLength(2);
  });
});
