import { beforeAll, describe, expect, it, vi } from "vitest";
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

  it("has the first soldier out call the brand's men out of the horse", () => {
    const { camp, run: tick } = world(true);
    const said: string[] = [];
    camp.events.onSay = (line) => said.push(line.text);
    camp.brandName = "Naïve";
    camp.apply(derive(view({ runs: [run("brand", "pending", "A")] })));
    tick(3);
    expect(said[0]).toBe("Men of Naïve, out of the horse! Let's roll out!");
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
  it("ride a horse from the stable to their source's land, gather there, ride back and drop the case in the basket", async () => {
    const { LAND } = await import("@/components/troy/scenes/layout");
    const { stage, camp, internals, run: tick } = world(false);
    camp.apply(derive(view({ runs: [run("brand", "pending", "A"), run("similar", "pending", "A")] })));
    tick(1);
    camp.apply(derive(view({ runs: [run("brand", "running", "A"), run("similar", "pending", "A")] })));
    tick(8);
    const scout = internals.agents.get("scout:site")!;
    // At the brand's own site, in plain view, gathering.
    expect(scout.where).toBe("afield");
    expect(stage.has(scout.entity)).toBe(true);
    const land = LAND.site;
    expect(Math.hypot(scout.entity.x - land.x, scout.entity.y - land.y)).toBeLessThan(30);
    // Its horse went with it: gone from the stable, waiting at the land.
    expect(internals.stalls.filter((s) => s.rider === scout)).toHaveLength(1);
    expect(internals.stalls.filter((s) => !stage.has(s.steed))).toHaveLength(1);

    camp.apply(derive(view({ runs: [run("brand", "done", "A"), run("similar", "pending", "A")] })));
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

  it("run on foot when every horse is out", async () => {
    const { landFor } = await import("@/components/troy/scenes/layout");
    const { internals, camp, run: tick } = world(false);
    // One source for each of the ten lands: ten scouts.
    const keys = ["brand", "similar", "seo_rating", "tiktok_0", "reels", "shorts", "meta_ads_0", "reddit", "aeo_chatgpt", "aeo_perplexity"];
    camp.apply(derive(view({ runs: keys.map((k) => run(k, "pending", "A")) })));
    tick(1);
    camp.apply(derive(view({ runs: keys.map((k) => run(k, "running", "A")) })));
    tick(22);
    const scouts = keys.map((k) => internals.agents.get(`scout:${landFor(k)}`)!);
    expect(scouts.every((s) => s.where === "afield")).toBe(true);
    // Seven horses are for scouts (the eighth is the courier's); the other three went on foot.
    expect(scouts.filter((s) => (s as unknown as { onFoot: boolean }).onFoot)).toHaveLength(3);
  });

  it("set out again when their land has another source to fetch", () => {
    const { camp, internals, run: tick } = world(false);
    camp.apply(derive(view({ runs: [run("brand", "running", "A")] })));
    tick(10);
    camp.apply(derive(view({ runs: [run("brand", "done", "A")] })));
    tick(14);
    const scout = internals.agents.get("scout:site")!;
    expect(scout.delivered).toBe(true);
    // The site is wanted again: the same scout rides back out to it.
    camp.apply(derive(view({ runs: [run("brand", "done", "A"), run("site", "running", "C")] })));
    tick(40);
    expect(scout.where).toBe("afield");
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

  it("talks with the station's head at each end, under the dispatch's key", () => {
    const { camp, run: tick } = world(false);
    camp.apply(derive(view({})));
    const talks: Array<{ key: string; phase: string; speakers: string[] }> = [];
    camp.events.onExchange = ({ key, phase, speakers }) => talks.push({ key, phase, speakers });
    camp.dispatch("scouts", "oracle", "scouts>oracle#1");
    tick(8);
    expect(talks).toEqual([
      { key: "scouts>oracle#1", phase: "pickup", speakers: ["lookout", "courier"] },
      { key: "scouts>oracle#1", phase: "handover", speakers: ["courier", "watcher"] },
    ]);
  });
});

describe("looking at one agent", () => {
  it("picks the soldier under the pointer, and nothing on empty ground", () => {
    const { stage, camp, run: tick } = world(false);
    camp.apply(derive(view({})));
    // Opened directly, everyone appears with their island first.
    expect(camp.pick(...(() => {
      const q = camp.position("lookout")!;
      const t = stage.toScreen(q.x, q.y, q.z);
      return [t.x, t.y - 10 * stage.camera.zoom] as const;
    })())).toBeNull();
    tick(2);
    const p = camp.position("lookout")!;
    const s = stage.toScreen(p.x, p.y, p.z);
    expect(camp.pick(s.x, s.y - 10 * stage.camera.zoom)).toBe("lookout");
    expect(camp.pick(5, 5)).toBeNull();
  });

  it("tells the card what a scout is doing and how far its trip has got", () => {
    const { camp, run: tick } = world(false);
    camp.apply(derive(view({ runs: [run("brand", "pending", "A")] })));
    expect(camp.info("scout:site")).toMatchObject({ trip: "camp", visible: true });
    camp.apply(derive(view({ runs: [run("brand", "running", "A")] })));
    tick(1.5);
    const riding = camp.info("scout:site")!;
    expect(riding.trip).toBe("out");
    expect(riding.doing).toMatch(/stable|Saddling|Galloping/);
    tick(8);
    expect(camp.info("scout:site")).toMatchObject({ trip: "there", where: "afield", visible: true, land: "site" });
    expect(camp.info("scout:site")!.doing).toMatch(/Gathering at The brand's site/);
    camp.apply(derive(view({ runs: [run("brand", "done", "A")] })));
    tick(1);
    expect(camp.info("scout:site")).toMatchObject({ trip: "back", mounted: true });
    tick(12);
    expect(camp.info("scout:site")!.trip).toBe("done");
  });

  it("tells the card where the courier is going and how many dispatches he has carried", () => {
    const { camp, run: tick } = world(false);
    camp.apply(derive(view({})));
    camp.dispatch("scouts", "oracle");
    tick(2);
    expect(camp.info("courier")!.errand).toEqual({ from: "scouts", to: "oracle" });
    tick(12);
    expect(camp.info("courier")).toMatchObject({ errand: null, deliveries: 1, where: "posted" });
  });

  it("gives every agent its own Greek name, the same each time", async () => {
    const { greekName } = await import("@/components/troy/camp/ui");
    const ids = ["lookout", "courier", "watcher", "general", "scribe", "painter", "inspector", "herald", ...Array.from({ length: 16 }, (_, i) => `scout:k${i}`), ...Array.from({ length: 6 }, (_, i) => `editor:${i}`), ...Array.from({ length: 4 }, (_, i) => `audience:${i}`)];
    const names = ids.map(greekName);
    expect(new Set(names).size).toBe(ids.length);
    expect(ids.map(greekName)).toEqual(names);
  });
});

describe("agents the plan no longer needs", () => {
  it("march back into the horse instead of vanishing", () => {
    const { stage, camp, internals, run: tick } = world(false);
    camp.apply(derive(view({ runs: [run("brand", "pending", "A")] })));
    const scout = internals.agents.get("scout:site")!;
    expect(stage.has(scout.entity)).toBe(true);
    camp.apply(derive(view({ runs: [] })));
    tick(2);
    // Still walking, still solid.
    expect(stage.has(scout.entity)).toBe(true);
    tick(40);
    expect(internals.agents.has("scout:site")).toBe(false);
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

describe("the expedition", () => {
  const videoNumbers = (views: number, likes: number) => ({ platform: "tiktok", url: "", caption: "", views, likes, comments: 0, shares: 0, saves: 0, duration: null, author: "", followers: null, paid: false, thumbnail: null, media_url: null, source: "" });
  const research = { domain: "acme.com", seo: { domain_rating: null, keywords: [] }, reddit: [], aeo: [], ads: [], videos: [videoNumbers(1000, 60), videoNumbers(2000, 120), videoNumbers(3000, 180)] };
  const plan = { brand_name: "Acme", category: "soap", audience: "", competitors: [{ name: "Rival Co" }], content_queries: [], ads_query: "", reddit_query: "", aeo_prompts: [] };
  const creative = (idx: number, approved: boolean) => ({ id: `crv_${idx}`, idx, generation: 1, status: "ready", concept: { title: `Concept ${idx}` }, caption: "", platforms: ["tiktok"], approved, videoUrl: null, posterUrl: null, qcScore: null, cost: 0, error: null, continuity: null, shots: [] });
  const post = (idx: number, status: string, analytics: Record<string, number> | null = null) => ({ id: `pst_${idx}`, creativeId: `crv_${idx}`, platforms: ["tiktok"], scheduledAt: null, status, error: null, analytics });
  const at = (stage: string, status: string, extra: Record<string, unknown>) => view({ stage, status, plan, research, ...extra });
  type Roman = { down: number; gone: boolean; routed: boolean; back: boolean; entity: Entity & { job: { act?: string } | null } };
  type Scene = { ships: Array<{ state: string }>; romans: Roman[]; runs: Array<{ stage: string; outcome: string | null }>; standards: Entity[] };
  const scene = (camp: unknown) => (camp as { expedition: Scene }).expedition;
  const army = (internals: Internals) => [...internals.agents.values()].filter((a) => /^(hoplite|archer):/.test(a.plan.id));
  const act = (internals: Internals, id: string) => (internals.agents.get(id)!.entity as Entity & { act?: string }).act;

  /** Two videos ready and mustered on the quay below the agora. */
  function mustered() {
    const w = world(false);
    w.camp.apply(derive(at("production", "running", { creatives: [] })));
    w.run(1);
    w.camp.apply(derive(at("review", "review", { creatives: [creative(0, false), creative(1, false)] })));
    w.run(80);
    return w;
  }

  it("musters on the quay, sails when the posts go out, and ends each attack the way its video does", async () => {
    const { ROME, ROME_LINES, STATION } = await import("@/components/troy/scenes/layout");
    const { stage, camp, internals, run: tick } = mustered();
    expect(army(internals)).toHaveLength(2 * 7);
    for (const agent of army(internals)) expect(atPost(stage, agent, STATION.agora), `${agent.plan.id} mustered on the quay`).toBe(true);

    // The posts go out: the companies go aboard and their ships put to sea.
    camp.apply(derive(at("review", "publishing", { creatives: [creative(0, true), creative(1, true)], posts: [post(0, "pending"), post(1, "pending")] })));
    tick(20);
    for (const agent of army(internals)) expect(agent.where, `${agent.plan.id} away with the fleet`).toBe("expedition");
    expect(scene(camp).ships.filter((s) => s.state !== "moored")).toHaveLength(2);

    // Out, with numbers: video 0 (10% likes per view against 6%) routs the legion facing it;
    // video 1 (4%) is thrown back to the quay. Then it is over: nobody fights on.
    camp.apply(derive(at("live", "live", { creatives: [creative(0, true), creative(1, true)], posts: [post(0, "posted", { views: 1000, likes: 100 }), post(1, "posted", { views: 1000, likes: 40 })] })));
    tick(70);
    expect(scene(camp).runs.map((r) => r.outcome)).toEqual(["won", "repulsed"]);
    const e = internals.agents.get("hoplite:0:0")!.entity;
    expect(e.x - ROME.x).toBeGreaterThan(ROME_LINES.landing);
    expect(act(internals, "hoplite:0:0")).toBe("cheer");
    expect(act(internals, "hoplite:1:0")).toBe("stand");
    expect(army(internals).every((a) => act(internals, a.plan.id) !== "fight")).toBe(true);
    // Not every video won: the gate stays the legion's.
    expect(camp.expedition.taken).toBe(false);
    expect(scene(camp).romans.some((r) => !r.gone)).toBe(true);
  });

  it("takes the city when every video beats the top videos, and hands it back when the demo starts over", () => {
    const { camp, internals, run: tick } = mustered();
    camp.apply(derive(at("live", "live", { creatives: [creative(0, true), creative(1, true)], posts: [post(0, "posted", { views: 1000, likes: 100 }), post(1, "posted", { views: 1000, likes: 90 })] })));
    tick(90);
    expect(camp.expedition.taken).toBe(true);
    // The whole legion ran for the gate; the Greeks' banners fly over it.
    expect(scene(camp).romans.every((r) => r.gone)).toBe(true);
    expect(scene(camp).standards.every((b) => b.job?.k === "prop" && b.job.v >= 4)).toBe(true);

    // Back to the start: the army re-embarks, sails home and marches into the horse; the legion
    // comes back out of its gate.
    camp.apply(derive(at("production", "running", { creatives: [] })));
    tick(150);
    expect(camp.expedition.taken).toBe(false);
    expect(scene(camp).romans.every((r) => !r.gone && !r.routed && !r.back)).toBe(true);
    expect(scene(camp).ships.every((s) => s.state === "moored")).toBe(true);
    expect(army(internals)).toHaveLength(0);
  });

  it("knocks legionaries flat with arrows during the attack, and they get up again", () => {
    // Every arrow finds its man.
    const random = vi.spyOn(Math, "random").mockReturnValue(0.1);
    try {
      const { camp, run: tick } = mustered();
      camp.apply(derive(at("live", "live", { creatives: [creative(0, true), creative(1, true)], posts: [post(0, "posted", { views: 1000, likes: 62 }), post(1, "posted", { views: 1000, likes: 61 })] })));
      const romans = scene(camp).romans;
      let knocked = 0;
      for (let s = 0; s < 70; s++) {
        tick(1);
        knocked = Math.max(knocked, romans.filter((r) => r.down > 0).length);
      }
      expect(knocked).toBeGreaterThan(0);
      // Level with the top videos: both companies hold, and everyone is on his feet.
      expect(scene(camp).runs.map((r) => r.outcome)).toEqual(["held", "held"]);
      expect(romans.every((r) => r.down <= 0 && r.entity.job?.act !== "fallen")).toBe(true);
    } finally {
      random.mockRestore();
    }
  });
});
