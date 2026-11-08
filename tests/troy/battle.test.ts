import { describe, expect, it } from "vitest";
import type { BrandView } from "@/components/troy/api";
import { benchmarkOf, type Company, companyFront, deriveBattle, postNumbers, VICTORY } from "@/components/troy/scenes/battle";
import { derive } from "@/components/troy/scenes/derive";
import { BATTLE_LINES } from "@/components/troy/scenes/layout";

// The battle below the agora is a picture of real numbers: each posted video's likes per view
// against the median of the top videos the research found. These tests pin how the campaign
// becomes companies, phases and a score, and that missing numbers never turn into a result.

type Campaign = NonNullable<BrandView["campaign"]>;

function view(campaign: Partial<Campaign>): BrandView {
  const base = {
    id: "cmp_1",
    status: "review",
    stage: "review",
    stageIndex: 4,
    error: null,
    naiveOut: false,
    options: { concepts: 2, shotsPerConcept: 2, secondsPerShot: 8, videoModel: "google/veo-3.1", learnStyle: true },
    estimateUsd: null,
    plan: { brand_name: "Acme", category: "soap", audience: "", competitors: [{ name: "Rival Co" }], content_queries: [], ads_query: "", reddit_query: "", aeo_prompts: [] },
    research: {
      domain: "acme.com",
      seo: { domain_rating: null, keywords: [] },
      reddit: [],
      aeo: [],
      videos: [video(100000, 5000), video(200000, 12000), video(50000, 4000), video(80, 70)],
      ads: [{ advertiser: "Rival Co Ltd" }, { advertiser: "Someone else" }, { advertiser: "rival co" }],
    },
    style: null,
    strategy: null,
    runs: [],
    creatives: [],
    posts: [],
    spend: { naive: 0, monid: 0, style: 0, strategy: 0 },
    createdAt: "2026-11-07T10:00:00Z",
  };
  return { brand: { id: "brd_1", name: "Acme", domain: "acme.com", url: "https://acme.com", profile: null, connected: false }, campaign: { ...base, ...campaign } as unknown as Campaign, campaigns: [], events: [] } as unknown as BrandView;
}

function video(views: number, likes: number) {
  return { platform: "tiktok", url: "", caption: "", views, likes, comments: 0, shares: 0, saves: 0, duration: null, author: "", followers: null, paid: false, thumbnail: null, media_url: null, source: "" };
}

function creative(idx: number, approved = false) {
  return { id: `crv_${idx}`, idx, generation: 1, status: "ready", concept: { title: `Concept ${idx}` }, caption: "", platforms: ["tiktok"], approved, videoUrl: null, posterUrl: null, qcScore: null, cost: 0, error: null, continuity: null, shots: [] };
}

function post(idx: number, status: string, analytics: Record<string, unknown> | null = null) {
  return { id: `pst_${idx}`, creativeId: `crv_${idx}`, platforms: ["tiktok"], scheduledAt: null, status, error: null, analytics };
}

describe("the battle's numbers", () => {
  it("reads views and likes from analytics of any shape, never counting a total twice", () => {
    expect(postNumbers({ views: 1200, likes: 96 })).toEqual({ views: 1200, likes: 96 });
    expect(postNumbers({ tiktok: { play_count: 800, like_count: 40 }, instagram: { views: 200, likes: 12 } })).toEqual({ views: 1000, likes: 52 });
    // A total beside a breakdown: the total wins.
    expect(postNumbers({ views: 1000, likes: 50, platforms: { tiktok: { views: 600, likes: 30 } } })).toEqual({ views: 1000, likes: 50 });
    expect(postNumbers({ likes: 10 })).toBeNull();
    expect(postNumbers({ views: 0, likes: 0 })).toBeNull();
    expect(postNumbers(null)).toBeNull();
  });

  it("benchmarks against the median likes per view of the top videos, from at least three", () => {
    // 5%, 6% and 8%; the fourth has too few views to count.
    const benchmark = benchmarkOf(view({}).campaign);
    expect(benchmark?.videos).toBe(3);
    expect(benchmark?.engagement).toBeCloseTo(0.06);
    expect(benchmarkOf(view({ research: { videos: [video(1000, 50), video(1000, 60)] } as never }).campaign)).toBeNull();
  });
});

describe("the battle from the campaign", () => {
  it("has no army before a video is finished", () => {
    expect(deriveBattle(view({ stage: "production", creatives: [] })).phase).toBe("none");
    expect(derive(view({ stage: "production", creatives: [] })).agents.some((a) => a.id.startsWith("hoplite:"))).toBe(false);
  });

  it("forms up a company for each finished video, with the rival from the plan", () => {
    const battle = deriveBattle(view({ creatives: [creative(0), creative(1, true)] as never }));
    expect(battle.phase).toBe("muster");
    expect(battle.companies.map((c) => c.state)).toEqual(["formed", "approved"]);
    // Two of the three ads the scouts found are the rival's.
    expect(battle.rival).toEqual({ name: "Rival Co", ads: 2 });
    expect(battle.score).toBeNull();
    // Six hoplites a company, four archers and two catapult crews, all marching to the field.
    const army = derive(view({ creatives: [creative(0), creative(1, true)] as never })).agents.filter((a) => /^(hoplite|archer|crew):/.test(a.id));
    expect(army).toHaveLength(2 * 6 + 4 + 2);
    expect(army.every((a) => a.station === "agora" && a.via?.length && a.dir === 0)).toBe(true);
  });

  it("closes up while posts go out, then fights as far forward as each video does", () => {
    const sending = deriveBattle(view({ status: "publishing", creatives: [creative(0, true), creative(1, true)] as never, posts: [post(0, "pending"), post(1, "pending")] as never }));
    expect(sending.phase).toBe("advance");
    expect(sending.companies.every((c) => c.state === "sent" && companyFront(c) === BATTLE_LINES.ready)).toBe(true);

    // Video 0: 9% likes per view against 6% (1.5x); video 1: 3% (0.5x).
    const fighting = deriveBattle(
      view({
        status: "live",
        stage: "live",
        creatives: [creative(0, true), creative(1, true)] as never,
        posts: [post(0, "posted", { views: 1000, likes: 90 }), post(1, "posted", { views: 2000, likes: 60 })] as never,
      }),
    );
    expect(fighting.phase).toBe("clash");
    const [strong, weak] = fighting.companies;
    expect(strong.ratio).toBeCloseTo(1.5);
    expect(weak.ratio).toBeCloseTo(0.5);
    expect(strong.ratio! >= VICTORY).toBe(true);
    // The strong one reaches the Romans' gate; the weak one is pushed back but holds.
    expect(companyFront(strong)).toBeGreaterThan(BATTLE_LINES.romans);
    expect(companyFront(weak)).toBeLessThan(0);
    expect(companyFront(weak)).toBeGreaterThan(BATTLE_LINES.ready);
    // Pooled: 150 likes on 3000 views is 5%, against 6%.
    expect(fighting.score).toMatchObject({ views: 3000, likes: 150 });
    expect(fighting.score!.ratio).toBeCloseTo(0.05 / 0.06);
    const plan = derive(view({ status: "live", stage: "live", creatives: [creative(0, true), creative(1, true)] as never, posts: [post(0, "posted", { views: 1000, likes: 90 }), post(1, "posted", { views: 2000, likes: 60 })] as never }));
    expect(plan.agents.find((a) => a.id === "hoplite:0:0")?.act).toBe("cheer");
    expect(plan.agents.find((a) => a.id === "hoplite:1:0")?.act).toBe("fight");
    expect(plan.agents.find((a) => a.id === "archer:0")?.act).toBe("shoot");
  });

  it("shows no result where numbers are missing", () => {
    const noNumbers = deriveBattle(view({ status: "live", creatives: [creative(0, true)] as never, posts: [post(0, "posted", null)] as never }));
    expect(noNumbers.companies[0]).toMatchObject({ state: "engaged", ratio: null, views: null });
    expect(companyFront(noNumbers.companies[0])).toBe(0);
    // Without a benchmark the posts' own numbers are kept, but there is nothing to compare them with.
    const noBenchmark = deriveBattle(view({ status: "live", research: { domain: "acme.com", seo: { domain_rating: null, keywords: [] }, reddit: [], aeo: [], videos: [], ads: [] } as never, creatives: [creative(0, true)] as never, posts: [post(0, "posted", { views: 500, likes: 20 })] as never }));
    expect(noBenchmark.benchmark).toBeNull();
    expect(noBenchmark.companies[0]).toMatchObject({ views: 500, likes: 20, ratio: null });
    expect(noBenchmark.score).toMatchObject({ views: 500, likes: 20, ratio: null });
  });

  it("holds back a company whose post failed", () => {
    const battle = deriveBattle(view({ status: "live", creatives: [creative(0, true)] as never, posts: [post(0, "failed")] as never }));
    const company: Company = battle.companies[0];
    expect(company.state).toBe("failed");
    expect(companyFront(company)).toBe(BATTLE_LINES.muster);
  });
});
