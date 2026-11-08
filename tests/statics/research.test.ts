import { describe, expect, it } from "vitest";
import { compactStatics, fallbackStaticPlan, type StaticPlan, staticSpecs, studySet } from "@/lib/statics/research";
import { PLACEMENTS } from "@/lib/statics/specs";
import type { ResearchPack } from "@/lib/research";

// Output shapes follow real Monid responses (Meta ad library search, X timelines, Google Ads
// Transparency, context.dev screenshots), trimmed to the fields Nomen reads.

const NOW = Date.parse("2026-11-08T00:00:00Z");
const day = (n: number) => Math.round((NOW - n * 24 * 3600 * 1000) / 1000);

const plan: StaticPlan = {
  brand_handle: "monid_ai",
  competitors: [{ name: "Toolhub", domain: "toolhub.dev", x_handle: "toolhub" }],
  leaders: [{ name: "Vercel", domain: "vercel.com", x_handle: "vercel" }],
  meta_queries: ["ai agents"],
  search_keywords: ["api marketplace for agents"],
  case_study_queries: ["saas static ad case study"],
  b2b: true,
};

const runs = [
  {
    key: "s_meta_q0",
    status: "done",
    output: {
      data: {
        ads: [
          { id: "111", pageName: "Agentco", text: "Agents that ship", title: "Build agents", ctaText: "Learn more", startDate: day(90), adCount: 4, media: [{ type: "image", url: "https://scontent.example/a.jpg" }], sourceUrl: "https://www.facebook.com/ads/library/?id=111" },
          { id: "222", pageName: "Newco", text: "New", title: "", startDate: day(3), adCount: 1, media: [{ type: "image", url: "https://scontent.example/b.jpg" }] },
        ],
      },
    },
  },
  {
    key: "s_meta_c0",
    status: "done",
    output: { data: { ads: [{ id: "333", pageName: "Toolhub", text: "Every API", startDate: day(40), adCount: 2, media: [{ type: "image", url: "https://scontent.example/c.jpg" }] }, { id: "444", pageName: "Someone Else", text: "Mentions Toolhub", startDate: day(10), media: [] }] } },
  },
  {
    key: "s_x_l_vercel",
    status: "done",
    output: {
      data: {
        tweets: [
          { id: "9", authorHandle: "vercel", text: "Introducing X", views: 500000, likes: 4000, retweets: 300, bookmarks: 500, createdUtc: day(5), isReply: false, url: "https://x.com/i/web/status/9", media: [{ type: "photo", url: "https://pbs.twimg.com/media/9.jpg" }] },
          { id: "8", authorHandle: "vercel", text: "A video", views: 900000, likes: 9000, isReply: false, media: [{ type: "video", url: "https://pbs.twimg.com/v.jpg" }] },
          { id: "7", authorHandle: "vercel", text: "reply", views: 100, isReply: true, media: [{ type: "photo", url: "https://pbs.twimg.com/media/7.jpg" }] },
        ],
      },
    },
  },
  { key: "s_gads_0", status: "done", output: { ads: [{ creativeId: "CR1", advertiserName: "Toolhub Inc", firstShown: "2026-06-01", lastShown: "2026-11-07", format: "image", imageUrl: "https://tpc.example/1.png", adUrl: "https://adstransparency.google.com/x" }] } },
  { key: "s_serp_0", status: "done", output: { ads: [{ title: "Toolhub - Every API", link: "https://toolhub.dev", description: "One key for every API." }] } },
  { key: "s_cases", status: "done", output: { results: [{ url: "https://agency.example/case", title: "How static ads cut CPA", excerpts: ["Static ads with a product screenshot outperformed..."] }] } },
  { key: "s_shot", status: "done", output: { status: "ok", screenshot: "https://media.example/shot.png", width: 1920, height: 1080 } },
  { key: "s_li_0", status: "failed", output: undefined },
];

describe("static research compaction", () => {
  const research = compactStatics(runs, plan, NOW);

  it("reads Meta image ads with their published signals", () => {
    const top = research.ads.find((ad) => ad.id === "meta-111")!;
    expect(top.image).toBe("https://scontent.example/a.jpg");
    expect(top.days).toBe(90);
    expect(top.variants).toBe(4);
    expect(top.signal).toBe("#1 by impressions · running 90 days · 4 versions");
    expect(top.score).toBeGreaterThan(research.ads.find((ad) => ad.id === "meta-222")!.score);
  });

  it("keeps a competitor's own ads as the competitor's, and name-mentions as category ads", () => {
    expect(research.ads.find((ad) => ad.id === "meta-333")?.role).toBe("competitor");
    expect(research.ads.find((ad) => ad.id === "meta-444")?.role).toBe("category");
  });

  it("keeps X photo posts with views and engagement, and skips videos and replies", () => {
    const x = research.ads.filter((ad) => ad.source === "x");
    expect(x.map((ad) => ad.id)).toEqual(["x-9"]);
    expect(x[0].role).toBe("leader");
    expect(x[0].signal).toBe("500K views · 1.0% engagement");
  });

  it("reads Google display ads, search ads, case studies and the screenshot", () => {
    expect(research.ads.find((ad) => ad.id === "google-CR1")?.signal).toBe("shown over 159 days · still running");
    expect(research.search_ads[0]).toMatchObject({ keyword: "api marketplace for agents", title: "Toolhub - Every API" });
    expect(research.cases[0].excerpt).toMatch(/screenshot/);
    expect(research.screenshot).toBe("https://media.example/shot.png");
    expect(research.sources).toEqual({ done: 7, total: 8 });
  });

  it("picks a varied study set with pictures", () => {
    const set = studySet(research);
    expect(set.every((ad) => ad.image)).toBe(true);
    expect(new Set(set.map((ad) => ad.source)).size).toBeGreaterThan(1);
  });
});

describe("static research specs", () => {
  it("fans out over Meta, X, Google, LinkedIn, the web and a screenshot, all in phase S", () => {
    const specs = staticSpecs("monid.ai", plan);
    const keys = specs.map((s) => s.key);
    expect(keys).toEqual(expect.arrayContaining(["s_meta_q0", "s_meta_c0", "s_meta_l0", "s_x_b_monid_ai", "s_x_c_toolhub", "s_x_l_vercel", "s_gads_0", "s_serp_0", "s_li_0", "s_cases", "s_shot"]));
    expect(specs.every((s) => s.phase === "S")).toBe(true);
    expect(new Set(keys).size).toBe(keys.length);
    expect(specs.find((s) => s.key === "s_meta_q0")?.input.body).toMatchObject({ mediaType: "IMAGE", sortBy: "impressions" });
  });

  it("falls back to a usable plan, reading the brand's X handle from its profile", () => {
    const pack = { brand: { name: "Monid", description: "An API marketplace for developers", slogan: "", industry: "Software", colors: [], logo: null, socials: [{ type: "x", url: "https://x.com/monid_ai" }], images: [] }, similar_sites: [] } as unknown as ResearchPack;
    const fallback = fallbackStaticPlan(pack, null);
    expect(fallback.brand_handle).toBe("monid_ai");
    expect(fallback.b2b).toBe(true);
  });
});

describe("placements", () => {
  it("covers every platform at the sizes the platforms recommend", () => {
    const sizes = PLACEMENTS.map((p) => `${p.platform}:${p.width}x${p.height}`);
    expect(sizes).toEqual(expect.arrayContaining(["meta:1440x1800", "meta:1440x2560", "x:1200x1200", "x:1200x628", "reddit:1440x1080", "reddit:1080x1350", "google:1200x628", "google:1200x1200", "google:960x1200"]));
    expect(PLACEMENTS.filter((p) => p.platform === "google" && p.textFree).length).toBe(3);
    expect(PLACEMENTS.filter((p) => p.platform !== "meta").every((p) => !p.cta)).toBe(true);
  });
});
