import { beforeAll, describe, expect, it } from "vitest";
import type { BrandView } from "@/components/troy/api";
import type { Baker } from "@/components/troy/engine/baker";
import type { Entity, Stage as StageType } from "@/components/troy/engine/stage";

// The camp's agents are people who walk, ride and climb: these tests run the real scene on a
// stage with a stubbed canvas (nothing is drawn, nothing is baked) and follow them.

type Fake = Record<string, unknown>;

function fakeContext(): Fake {
  const noop = () => undefined;
  return new Proxy(
    { createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }), createPattern: () => null },
    { get: (target, key) => (key in target ? target[key as keyof typeof target] : noop) },
  );
}

function fakeCanvas(): Fake {
  return { width: 0, height: 0, getContext: () => fakeContext(), getBoundingClientRect: () => ({ width: 1440, height: 900 }) };
}

let Stage: typeof StageType;
let CampScene: typeof import("@/components/troy/scenes/camp").CampScene;
let LandingScene: typeof import("@/components/troy/scenes/landing").LandingScene;
let derive: typeof import("@/components/troy/scenes/derive").derive;

beforeAll(async () => {
  (globalThis as Fake).document = { createElement: () => fakeCanvas() };
  ({ Stage } = await import("@/components/troy/engine/stage"));
  ({ CampScene } = await import("@/components/troy/scenes/camp"));
  ({ LandingScene } = await import("@/components/troy/scenes/landing"));
  ({ derive } = await import("@/components/troy/scenes/derive"));
});

const baker = { request: () => new Promise(() => undefined), get: () => undefined, has: () => false } as unknown as Baker;

type AgentState = { plan: { id: string; station: string; x: number; y: number; z: number }; entity: Entity; where: string; delivered: boolean; finished: boolean };
type Internals = { agents: Map<string, AgentState>; stalls: Array<{ steed: Entity; rider: unknown }>; keyed: Map<string, Entity> };

function world(entrance: boolean) {
  const stage = new Stage(fakeCanvas() as unknown as HTMLCanvasElement, baker);
  const landing = new LandingScene(stage, {});
  const camp = new CampScene(stage, landing);
  landing.recruit = () => camp.nextRecruit();
  camp.prepare("brd_1");
  if (entrance) camp.beginEntrance();
  landing.openNow();
  camp.show(true);
  stage.look(camp.camera(), 0);
  const step = (stage as unknown as { step(dt: number): void }).step.bind(stage);
  const internals = camp as unknown as Internals;
  const seen = new Map<Entity, number>();
  /** Runs the world for `seconds`, checking after every frame that nobody fades out in the open. */
  const run = (seconds: number) => {
    for (let t = 0; t < seconds; t += 1 / 30) {
      step(1 / 30);
      for (const agent of internals.agents.values()) {
        const e = agent.entity;
        if (!stage.has(e)) continue;
        // A figure may appear (out of the doorway, or with its island), but only fades away inside the horse's doorway.
        const solid = (e.alpha ?? 1) * (e.reveal ?? 1);
        if (solid < (seen.get(e) ?? 0) - 1e-9) expect(e.z, `${agent.plan.id} faded in the open`).toBeGreaterThan(40);
        seen.set(e, solid);
      }
    }
  };
  return { stage, camp, internals, run };
}

const run = (key: string, status: string, phase = "C") => ({ key, phase, provider: "anyapi", endpoint: "/x", status, error: null, cost_micro: 0, cost: 0 });

function view(campaign: Record<string, unknown>): BrandView {
  return {
    brand: { id: "brd_1", name: "Acme", domain: "acme.com", url: "https://acme.com", profile: null, connected: false },
    campaign: {
      id: "cmp_1",
      status: "running",
      stage: "research",
      stageIndex: 0,
      error: null,
      naiveOut: false,
      options: { concepts: 2, shotsPerConcept: 2, secondsPerShot: 8, videoModel: "google/veo-3.1", learnStyle: true },
      estimateUsd: null,
      plan: null,
      research: null,
      style: null,
      strategy: null,
      runs: [],
      creatives: [],
      posts: [],
      spend: { naive: 0, monid: 0, style: 0, strategy: 0 },
      createdAt: "2026-11-07T10:00:00Z",
      ...campaign,
    },
    campaigns: [],
    events: [],
  } as unknown as BrandView;
}

function atPost(stage: StageType, agent: AgentState, station: { x: number; y: number }) {
  const e = agent.entity;
  return stage.has(e) && Math.hypot(e.x - (station.x + agent.plan.x), e.y - (station.y + agent.plan.y)) < 0.6 && Math.abs(e.z - agent.plan.z) < 0.4;
}

describe("the march into the camp", () => {
  it("brings every agent out of the horse and walks it to its post", async () => {
    const { STATION } = await import("@/components/troy/scenes/layout");
    const { stage, camp, internals, run: tick } = world(true);
    camp.apply(derive(view({ runs: [run("brand", "pending", "A")] })));
    // Nobody is placed: they all wait inside the horse.
    expect([...internals.agents.values()].every((a) => a.where === "queued" && !stage.has(a.entity))).toBe(true);
    tick(1);
    expect(camp.waiting).toBeGreaterThan(0);
    tick(90);
    expect(camp.waiting).toBe(0);
    for (const agent of internals.agents.values()) {
      const station = STATION[agent.plan.station as keyof typeof STATION];
      expect(atPost(stage, agent, station), `${agent.plan.id} at its post`).toBe(true);
    }
    // The lookout climbed the ladder to the platform.
    expect(internals.agents.get("lookout")!.entity.z).toBeGreaterThan(25);
  });

  it("places everyone at once when the camp is opened directly", async () => {
    const { STATION } = await import("@/components/troy/scenes/layout");
    const { stage, camp, internals } = world(false);
    camp.apply(derive(view({})));
    expect(camp.waiting).toBe(0);
    for (const agent of internals.agents.values()) expect(atPost(stage, agent, STATION[agent.plan.station as keyof typeof STATION])).toBe(true);
  });
});

describe("scouts", () => {
  it("ride off the map on a horse from the stable, ride back and drop the case in the basket", () => {
    const { stage, camp, internals, run: tick } = world(false);
    camp.apply(derive(view({ runs: [run("brand", "pending", "A"), run("site", "pending", "A")] })));
    tick(1);
    camp.apply(derive(view({ runs: [run("brand", "running", "A"), run("site", "pending", "A")] })));
    tick(8);
    const scout = internals.agents.get("scout:brand")!;
    expect(scout.where).toBe("out");
    expect(stage.has(scout.entity)).toBe(false);
    // Its horse went with it.
    expect(internals.stalls.filter((s) => s.rider === scout)).toHaveLength(1);
    expect(internals.stalls.filter((s) => !stage.has(s.steed))).toHaveLength(1);

    camp.apply(derive(view({ runs: [run("brand", "done", "A"), run("site", "pending", "A")] })));
    tick(12);
    expect(scout.delivered).toBe(true);
    // The horse is back at the rail, and the basket shows one of two cases.
    expect(internals.stalls.every((s) => stage.has(s.steed))).toBe(true);
    const basket = internals.keyed.get("scouts:basket")!;
    expect(basket.job).toMatchObject({ k: "prop", v: Math.round((1 / 2) * 7) });
    // Done with the run, the scout marches back up to the horse.
    tick(40);
    expect(scout.where).toBe("home");
    expect(stage.has(scout.entity)).toBe(false);
  });

  it("run on foot when every horse is out", () => {
    const { internals, camp, run: tick } = world(false);
    const keys = ["a", "b", "c", "d", "e", "f"];
    camp.apply(derive(view({ runs: keys.map((k) => run(k, "pending", "A")) })));
    tick(1);
    camp.apply(derive(view({ runs: keys.map((k) => run(k, "running", "A")) })));
    tick(10);
    const scouts = keys.map((k) => internals.agents.get(`scout:${k}`)!);
    expect(scouts.every((s) => s.where === "out")).toBe(true);
    // Four horses are for scouts; the other two went on foot.
    expect(scouts.filter((s) => (s as unknown as { onFoot: boolean }).onFoot)).toHaveLength(2);
  });
});

describe("the courier", () => {
  it("saddles up, carries the work to the next station and comes back to the stable", () => {
    const { stage, camp, internals, run: tick } = world(false);
    camp.apply(derive(view({})));
    const reached: string[] = [];
    camp.events.onArrive = (station) => reached.push(station);
    camp.dispatch("scouts", "oracle");
    tick(7);
    expect(reached).toEqual(["oracle"]);
    tick(10);
    const courier = internals.agents.get("courier")!;
    expect(courier.where).toBe("posted");
    expect(internals.stalls.every((s) => stage.has(s.steed))).toBe(true);
  });
});

describe("agents the plan no longer needs", () => {
  it("march back into the horse instead of vanishing", () => {
    const { stage, camp, internals, run: tick } = world(false);
    camp.apply(derive(view({ runs: [run("brand", "pending", "A")] })));
    const scout = internals.agents.get("scout:brand")!;
    expect(stage.has(scout.entity)).toBe(true);
    camp.apply(derive(view({ runs: [] })));
    tick(2);
    // Still walking, still solid.
    expect(stage.has(scout.entity)).toBe(true);
    tick(40);
    expect(internals.agents.has("scout:brand")).toBe(false);
    expect(stage.has(scout.entity)).toBe(false);
  });
});

describe("the stage", () => {
  it("removes exactly the entity that asks to go, even when its tick already removed it", () => {
    // A fading figure used to remove itself and also return "remove": the stage then spliced the
    // stale index and took its neighbour with it (the oracle's watcher vanished like this).
    const stage = new Stage(fakeCanvas() as unknown as HTMLCanvasElement, baker);
    const first: Entity = { x: 0, y: 0, z: 0 };
    const leaving: Entity = { x: 0, y: 0, z: 0, tick: () => (stage.remove(leaving), "remove") };
    const neighbour: Entity = { x: 0, y: 0, z: 0 };
    stage.add(first);
    stage.add(leaving);
    stage.add(neighbour);
    (stage as unknown as { step(dt: number): void }).step(1 / 60);
    expect(stage.entities).toEqual([first, neighbour]);
  });
});
