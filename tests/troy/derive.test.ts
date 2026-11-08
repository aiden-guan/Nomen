import { describe, expect, it } from "vitest";
import { type BrandView, normalizeSite } from "@/components/troy/api";
import { activeStation, derive, stationForEvent, stationOf } from "@/components/troy/scenes/derive";
import { normalizeDomain } from "@/lib/pipeline";

// The camp is a picture of the core's BrandView. These tests pin what each station shows for
// each state of a campaign, using view objects shaped like the core's GET /api/brands/[id].

type Campaign = NonNullable<BrandView["campaign"]>;

function view(campaign: Partial<Campaign> | null): BrandView {
  const base = {
    id: "cmp_1",
    status: "running",
    stage: "research",
    stageIndex: 0,
    error: null,
    naiveOut: false,
    options: { concepts: 4, shotsPerConcept: 2, secondsPerShot: 8, videoModel: "google/veo-3.1", learnStyle: true },
    estimateUsd: 25.6,
    plan: null,
    research: null,
    style: null,
    strategy: null,
    runs: [],
    creatives: [],
    posts: [],
    spend: { naive: 0, monid: 0, style: 0, strategy: 0 },
    createdAt: "2026-11-07T10:00:00Z",
  };
  return {
    brand: { id: "brd_1", name: "Acme", domain: "acme.com", url: "https://acme.com", profile: null, connected: false },
    campaign: campaign === null ? null : ({ ...base, ...campaign } as unknown as Campaign),
    campaigns: [],
    events: [],
  } as unknown as BrandView;
}

const run = (key: string, status: string, phase = "C") => ({ key, phase, provider: "anyapi", endpoint: "/x", status, error: null, cost_micro: 0, cost: 0 });

const shot = (n: number, status: string) => ({ n, status, provider: status === "rendering" ? "naive" : null, renders: 0, frameUrl: null, qc: null, error: null });

function creative(idx: number, status: string, shots: string[], extra: Record<string, unknown> = {}) {
  return {
    id: `crv_${idx}`,
    idx,
    generation: 1,
    status,
    concept: { title: `Concept ${idx}` },
    caption: "",
    platforms: ["tiktok"],
    approved: false,
    videoUrl: null,
    posterUrl: null,
    qcScore: null,
    cost: 0,
    error: null,
    continuity: null,
    shots: shots.map((s, i) => shot(i + 1, s)),
    ...extra,
  };
}

describe("the camp before and during research", () => {
  it("shows every station waiting when there is no campaign", () => {
    const plan = derive(view(null));
    expect(Object.values(plan.stations).map((s) => s.state)).toEqual(["waiting", "waiting", "waiting", "waiting", "waiting", "waiting"]);
    expect(plan.desks).toEqual([]);
    // Everyone the camp has is there from the start; only scouts (one per run) come and go.
    expect(plan.agents.map((a) => a.id)).toEqual(["lookout", "courier", "watcher", "general", "scribe", "painter", "inspector", "audience:0", "audience:1", "audience:2", "audience:3", "herald"]);
  });

  it("sets up a desk and an editor for every planned video before the concepts arrive", () => {
    const plan = derive(view({}));
    expect(plan.desks).toEqual([0, 1, 2, 3].map((slot) => ({ slot, creativeId: "", state: 0, title: `Video ${slot + 1}` })));
    const editors = plan.agents.filter((a) => a.id.startsWith("editor:"));
    expect(editors.map((a) => a.id)).toEqual(["editor:0", "editor:1", "editor:2", "editor:3"]);
    expect(editors.every((a) => a.act === "sit" && a.state === "idle")).toBe(true);
    // The painter, the inspector and the audience wait at their places.
    expect(plan.agents.find((a) => a.id === "painter")).toMatchObject({ act: "stand", state: "idle" });
    expect(plan.agents.find((a) => a.id === "inspector")).toMatchObject({ act: "stand", state: "idle" });
    expect(plan.agents.filter((a) => a.id.startsWith("audience:")).every((a) => a.act === "stand")).toBe(true);
  });

  it("sends the lookout up the tower's ladder and the herald up the podium's step", () => {
    const plan = derive(view({}));
    expect(plan.agents.find((a) => a.id === "lookout")?.via?.some((w) => w.act === "climb")).toBe(true);
    expect(plan.agents.find((a) => a.id === "herald")?.via?.length).toBeGreaterThan(0);
  });

  it("counts sources and posts one scout per land they come from", () => {
    const plan = derive(
      view({
        runs: [
          run("brand", "done", "A"),
          run("site", "done", "A"),
          run("tiktok_brand", "running"),
          run("tiktok_0", "pending"),
          run("reels", "pending"),
          run("meta_ads_brand", "done"),
          run("meta_ads_0", "pending"),
          run("reddit", "failed"),
        ] as never,
      }),
    );
    expect(plan.stations.scouts).toMatchObject({ state: "working", status: "3 of 8 sources in" });
    expect(plan.stations.scouts.progress).toBeCloseTo(4 / 8);
    const scouts = Object.fromEntries(plan.agents.filter((a) => a.id.startsWith("scout:")).map((a) => [a.id, a]));
    expect(Object.keys(scouts)).toEqual(["scout:site", "scout:tiktok", "scout:instagram", "scout:metaads", "scout:reddit"]);
    // The brand and its site are both fetched from the brand's own site: one scout brings both back.
    expect(scouts["scout:site"]).toMatchObject({ returning: "scroll", state: "done" });
    expect(scouts["scout:tiktok"]).toMatchObject({ away: true, state: "working" });
    expect(scouts["scout:instagram"]).toMatchObject({ act: "stand", state: "idle" });
    // One source back and one still to start: the scout waits at the land rather than riding twice.
    expect(scouts["scout:metaads"]).toMatchObject({ away: true, state: "working" });
    expect(scouts["scout:reddit"]).toMatchObject({ returning: "empty", state: "failed" });
    expect(plan.agents.find((a) => a.id === "lookout")?.act).toBe("lookout");
    expect(plan.props.basket).toBe(Math.round((3 / 8) * 7));
  });

  it("sends a scout for a source the camp has no land for to the open web (SimilarWeb)", () => {
    const plan = derive(view({ runs: [run("similar", "done", "A"), run("news_mentions", "running")] as never }));
    expect(plan.agents.filter((a) => a.id.startsWith("scout:")).map((a) => a.id)).toEqual(["scout:similarweb"]);
    expect(plan.agents.find((a) => a.id === "scout:similarweb")).toMatchObject({ away: true, state: "working" });
  });

  it("says when the scouts are planning the second sweep", () => {
    const plan = derive(view({ runs: [run("brand", "done", "A"), run("site", "failed", "A")] as never }));
    expect(plan.stations.scouts.status).toBe("Planning the next sweep");
  });
});

describe("the camp through the pipeline", () => {
  it("lights the oracle and its television while the format is studied", () => {
    const plan = derive(view({ stage: "style", stageIndex: 1, research: { videos: [1, 2], ads: [1], reddit: [], seo: { keywords: [1] } } as never }));
    expect(plan.stations.scouts).toMatchObject({ state: "done", status: "2 videos · 1 ad · 0 threads" });
    expect(plan.stations.oracle.state).toBe("working");
    expect(plan.tvOn).toBe(true);
    expect(plan.agents.find((a) => a.id === "watcher")?.act).toBe("watch");
  });

  it("marks the oracle skipped when the strategy started without a format study", () => {
    const plan = derive(view({ stage: "strategy", stageIndex: 2, style: null }));
    expect(plan.stations.oracle.state).toBe("skipped");
    expect(plan.stations.tent).toMatchObject({ state: "working", status: "Writing 4 concepts" });
    expect(plan.agents.find((a) => a.id === "general")?.act).toBe("point");
  });

  it("gives every video a desk and calls the painter and the inspector when needed", () => {
    const plan = derive(
      view({
        stage: "production",
        stageIndex: 3,
        style: { slug: "s", version: 1, skill_md: "", samples: [] },
        creatives: [creative(0, "producing", ["passed", "rendering"]), creative(1, "producing", ["pending", "pending"]), creative(2, "producing", ["rendered", "framed"]), creative(3, "ready", ["passed", "passed"])] as never,
      }),
    );
    expect(plan.desks.map((d) => d.state)).toEqual([1, 1, 1, 2]);
    expect(plan.stations.workshop).toMatchObject({ state: "working", status: "1 of 4 ready · 1 shot rendering" });
    expect(plan.agents.some((a) => a.id === "painter")).toBe(true);
    expect(plan.agents.find((a) => a.id === "inspector")?.task).toMatch(/Checking every frame/);
    expect(plan.agents.find((a) => a.id === "editor:0")?.task).toBe("“Concept 0”: shot 2 of 2 rendering on Veo");
    expect(plan.props.reels).toBe(1);
  });

  it("hands review to you and puts the finished cut on the theatre screen", () => {
    const plan = derive(
      view({
        stage: "review",
        stageIndex: 4,
        status: "review",
        style: { slug: "s", version: 1, skill_md: "", samples: [] },
        creatives: [
          creative(0, "ready", ["passed"], { approved: true, posterUrl: "https://x/p.jpg" }),
          creative(1, "ready", ["passed"], { videoUrl: "/api/media/crv_1/final.mp4" }),
          creative(2, "failed", ["failed"]),
        ] as never,
      }),
    );
    expect(plan.stations.theatre).toMatchObject({ state: "yours", status: "2 to review · 1 approved", progress: 0.5 });
    // Without a still, the theatre screen takes a frame from the video itself.
    expect(plan.posters).toEqual([
      { creativeId: "crv_0", url: "https://x/p.jpg", video: null, title: "Concept 0" },
      { creativeId: "crv_1", url: null, video: "/api/media/crv_1/final.mp4", title: "Concept 1" },
    ]);
    // Two videos to watch: two spectators take their seats, the other two wait by the theatre.
    const audience = plan.agents.filter((a) => a.station === "theatre");
    expect(audience).toHaveLength(4);
    expect(audience.filter((a) => a.act === "watch")).toHaveLength(2);
    expect(audience.filter((a) => a.act === "stand")).toHaveLength(2);
  });

  it("hands the work to the agora while posts go out, though the core still says review", () => {
    const plan = derive(
      view({
        stage: "review",
        stageIndex: 4,
        status: "publishing",
        creatives: [creative(0, "ready", ["passed"], { approved: true })] as never,
        posts: [{ id: "p1", creativeId: "crv_0", platforms: ["tiktok"], scheduledAt: null, status: "pending", error: null, analytics: null }] as never,
      }),
    );
    expect(plan.stations.theatre).toMatchObject({ state: "done", status: "1 video approved" });
    expect(plan.stations.agora.state).toBe("working");
    expect(plan.agents.find((a) => a.id === "herald")?.act).toBe("herald");
    expect(activeStation(view({ stage: "review", stageIndex: 4, status: "publishing" }).campaign)).toBe("agora");
    expect(activeStation(view({ stage: "review", stageIndex: 4, status: "review" }).campaign)).toBe("theatre");
  });

  it("marks the agora done once every video is out", () => {
    const plan = derive(
      view({
        stage: "live",
        stageIndex: 5,
        status: "live",
        posts: [
          { id: "p1", creativeId: "crv_0", platforms: ["tiktok"], scheduledAt: null, status: "posted", error: null, analytics: null },
          { id: "p2", creativeId: "crv_1", platforms: ["tiktok"], scheduledAt: null, status: "posted", error: null, analytics: null },
        ] as never,
      }),
    );
    expect(plan.stations.agora).toMatchObject({ state: "done", status: "2 videos posted", progress: 1 });
    expect(plan.agents.find((a) => a.id === "herald")).toMatchObject({ act: "stand", state: "done" });
  });

  it("sends the herald out while posting", () => {
    const plan = derive(
      view({
        stage: "live",
        stageIndex: 5,
        status: "live",
        posts: [
          { id: "p1", creativeId: "crv_0", platforms: ["tiktok"], scheduledAt: null, status: "posted", error: null, analytics: null },
          { id: "p2", creativeId: "crv_1", platforms: ["tiktok"], scheduledAt: "2026-11-09T16:00:00Z", status: "scheduled", error: null, analytics: null },
        ] as never,
      }),
    );
    expect(plan.stations.agora).toMatchObject({ state: "working", status: "1 posted · 1 scheduled" });
    expect(plan.agents.find((a) => a.id === "herald")?.act).toBe("herald");
  });

  it("shows where a campaign stopped, with the core's message", () => {
    const plan = derive(view({ stage: "strategy", stageIndex: 2, status: "failed", error: "Naive has no agent named nomen-strategist." }));
    expect(plan.stations.tent).toMatchObject({ state: "failed", status: "Naive has no agent named nomen-strategist." });
    expect(plan.stations.scouts.state).toBe("done");
    expect(plan.stations.workshop.state).toBe("waiting");
  });
});

describe("dispatches", () => {
  it("land on the station they are about", () => {
    const cases: Array<[string, string]> = [
      ["Campaign started: 4 videos, 2 shots each, google/veo-3.1", "scouts"],
      ["Research done: 24 top videos, 12 live ads, 10 Reddit threads, 18 keywords (16/16 sources)", "scouts"],
      ["Studying the format of 3 top-performing videos", "oracle"],
      ["Format study ready (skill nomen-style-acme@1)", "oracle"],
      ["The strategist is writing the brand brief and 4 concepts", "tent"],
      ['Campaign "The Afternoon Swap": 4 concepts, now producing', "tent"],
      ['The creative director chose 3 videos, each on what the research found: "I told Naïve" (faceless clone: one silent desk shot pulled 407K views)', "tent"],
      ['QC sent "Blind taste test" shot 1 back (6/10): the label is garbled', "workshop"],
      ["Shot 2 is rendering on Monid (Kling 3.0) because Naive is unavailable", "workshop"],
      ['"The 3pm slump swap" is ready (QC 8/10)', "workshop"],
      ["3 of 4 videos are ready for review", "theatre"],
      ["Queued 3 posts one per day", "agora"],
    ];
    for (const [message, station] of cases) expect(stationForEvent(message, "research"), message).toBe(station);
  });

  it("fall back to the station of the current stage", () => {
    expect(stationForEvent("Retrying from production", "production")).toBe("workshop");
    expect(stationOf("review")).toBe("theatre");
  });
});

describe("the website box", () => {
  it("accepts and rejects exactly what the server does", () => {
    const inputs = ["acme.com", "https://www.Example.com/shop?x=1", "  monid.ai  ", "http://shop.acme.co.uk", "hello", "localhost", "acme .com", "", "https://", "www.acme.com/"];
    for (const input of inputs) {
      let server: string | null = null;
      try {
        server = normalizeDomain(input).domain;
      } catch {
        server = null;
      }
      const client = normalizeSite(input);
      expect("domain" in client ? client.domain : null, JSON.stringify(input)).toBe(server);
    }
  });
});
