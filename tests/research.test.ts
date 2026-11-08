import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { adsFrom, compactResearch, extractJson, fallbackPlan, parseCount, phaseASpecs, phaseCSpecs, planResearch, type ResearchPlan, VIDEO_RUN } from "@/lib/research";

// Real Monid responses from a drinkolipop.com research run, trimmed to four items per list.
const runs = JSON.parse(readFileSync(new URL("./fixtures/olipop-runs.json", import.meta.url), "utf8")) as Array<{ key: string; status: string; output: unknown }>;
const plan = JSON.parse(readFileSync(new URL("./fixtures/olipop-plan.json", import.meta.url), "utf8")) as ResearchPlan;
const pack = compactResearch("drinkolipop.com", runs, plan);

describe("compactResearch on real Monid output", () => {
  it("reads the brand profile", () => {
    expect(pack.brand.name).toBe("Olipop");
    expect(pack.brand.colors.length).toBeGreaterThan(0);
    expect(pack.brand.logo).toMatch(/^https:\/\//);
  });

  it("dedupes product images that differ only by query string", () => {
    const paths = pack.brand.images.map((url) => url.split("?")[0]);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it("keeps the best videos of every platform, not just TikTok", () => {
    const platforms = new Set(pack.videos.map((video) => video.platform));
    expect(platforms.has("tiktok")).toBe(true);
    expect(platforms.has("instagram")).toBe(true);
    expect(platforms.has("youtube")).toBe(true);
    for (const video of pack.videos) expect(video.url).toMatch(/^https:\/\//);
  });

  it("reads ads with their format, link and start date", () => {
    const meta = pack.ads.filter((ad) => ad.platform === "meta");
    expect(meta.length).toBeGreaterThan(0);
    expect(meta[0].advertiser).toBeTruthy();
    expect(meta[0].media).toBe("video");
    expect(meta[0].started).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("keeps only on-topic Reddit threads, with full links", () => {
    for (const post of pack.reddit) {
      expect(post.url).toMatch(/^https:\/\/www\.reddit\.com\/r\//);
      expect(`${post.title} ${post.text}`.toLowerCase()).toMatch(/olipop|poppi|prebiotic|soda|culture pop|zevia|recess|bloom/);
    }
  });

  it("records whether AI answers mention the brand", () => {
    expect(pack.aeo.length).toBe(2);
    expect(pack.aeo.every((answer) => answer.mentions_brand)).toBe(true);
  });

  it("reads Ahrefs keywords and domain rating", () => {
    expect(pack.seo.domain_rating).toBeGreaterThan(0);
    expect(pack.seo.keywords[0].keyword).toBeTruthy();
  });
});

describe("research specs", () => {
  it("phase A needs only the domain", () => {
    const keys = phaseASpecs("example.com").map((spec) => spec.key);
    expect(keys).toEqual(["brand", "site", "similar", "seo_rating", "seo_keywords"]);
  });

  it("phase C searches the brand, the category, and the brand's and competitors' own ads", () => {
    const specs = phaseCSpecs(plan);
    expect(specs.find((spec) => spec.key === "tiktok_brand")?.input.body).toMatchObject({ query: plan.brand_name });
    // Company searches list an advertiser's own ads; a keyword search would match anyone saying the name.
    expect(specs.filter((spec) => spec.endpoint === "/facebook.company_ads").map((spec) => spec.input.body?.companyName)).toEqual(["Olipop", "Poppi", "Culture Pop", "Zevia"]);
    expect(specs.find((spec) => spec.key === "meta_ads_cat")?.input.body).toMatchObject({ query: plan.ads_query, mediaType: "VIDEO" });
    expect(new Set(specs.map((spec) => spec.key)).size).toBe(specs.length);
  });

  it("phase C looks for conversion evidence: sales-format searches, TikTok's ads and its top ads bought for conversions", () => {
    const specs = phaseCSpecs({ ...plan, conversion_queries: ["olipop vs poppi", "I tried prebiotic soda"] });
    const byKey = new Map(specs.map((spec) => [spec.key, spec]));
    expect(byKey.get("tiktok_conv_0")?.input.body).toMatchObject({ query: "olipop vs poppi" });
    expect(byKey.get("tiktok_conv_1")?.input.body).toMatchObject({ query: "I tried prebiotic soda" });
    expect(byKey.get("reels_conv_0")?.endpoint).toBe("/instagram.reels_search");
    expect(VIDEO_RUN.test("tiktok_conv_1") && VIDEO_RUN.test("reels_conv_0")).toBe(true);
    expect(VIDEO_RUN.test("tiktok_ads_comp_0") || VIDEO_RUN.test("tiktok_top_ads")).toBe(false);
    // TikTok's public library serves the EU and UK only; GB is the English-language one.
    expect(byKey.get("tiktok_ads")?.input.body).toMatchObject({ query: plan.ads_query, region: "GB" });
    expect(byKey.get("tiktok_ads_comp_0")?.input.body).toMatchObject({ advertiserName: "Poppi", region: "GB" });
    expect(byKey.get("tiktok_top_ads")).toMatchObject({ provider: "tikhub", endpoint: "/api/v1/tiktok/ads/search_ads", input: { body: { keyword: plan.ads_query, objective: 3 } } });
    // An old plan without conversion queries still works.
    expect(phaseCSpecs(plan).some((spec) => spec.key.startsWith("tiktok_conv_"))).toBe(false);
  });

  it("falls back to a usable plan without a model", () => {
    const fallback = fallbackPlan("acme.com", { ...pack.brand, name: "", industry: "" }, ["rival.com"]);
    expect(fallback.brand_name).toBe("Acme");
    expect(fallback.competitors[0]).toEqual({ name: "Rival", domain: "rival.com" });
    expect(fallback.aeo_prompts.length).toBe(2);
  });
});

describe("ads as conversion evidence", () => {
  // Shapes as Monid returns them: Meta's library (anyapi), TikTok's EU library (anyapi), and TikTok
  // Creative Center top ads (tikhub, from the provider's documented example: not yet seen live).
  const day = 86_400;
  const meta = (over: Record<string, unknown>) => ({
    active: true,
    adCount: 1,
    ctaText: "Learn more",
    ctaType: "LEARN_MORE",
    displayFormat: "VIDEO",
    id: String(Math.random()).slice(2),
    linkUrl: "https://drinkpoppi.com/",
    media: [{ type: "video", url: "https://cdn/thumb.jpg", videoUrl: "https://video.cdn/ad.mp4" }],
    pageName: "Poppi",
    startDate: 1_790_000_000,
    endDate: 1_790_000_000 + 94 * day,
    sourceUrl: `https://www.facebook.com/ads/library/?id=${String(Math.random()).slice(2)}`,
    text: "Gut health soda that tastes like the real thing",
    ...over,
  });
  const tiktokLibrary = {
    data: {
      ads: [
        {
          adId: "1880328060952577",
          adTitle: "Prebiotic soda, 5g sugar",
          brandName: "poppi",
          coverUrl: "https://cdn/cover.jpg",
          estimatedAudience: "10K-100K",
          firstShownUtc: 1_793_145_600,
          lastShownUtc: 1_793_145_600 + 21 * day,
          format: "2",
          status: "1",
          url: "https://library.tiktok.com/ads/detail/?ad_id=1880328060952577",
          videoUrl: "https://library.tiktok.com/api/v1/cdn/1/video/x",
        },
      ],
    },
  };
  const topAds = {
    code: 200,
    data: {
      code: 0,
      data: {
        materials: [
          {
            id: "7213258221116751874",
            desc: "POV: you found a soda that does not wreck your gut",
            create_time: 1_680_234_567,
            video_info: { cover: "https://cdn/c.jpg", duration: 15, video_url: { "720p": "https://v16.tiktokcdn.com/top.mp4" } },
            statistics: { digg_count: 128_456, comment_count: 3_421, share_count: 892 },
            ads_info: { advertiser_name: "Poppi", landing_page: "https://drinkpoppi.com" },
          },
        ],
        pagination: { page: 1, has_more: false },
      },
    },
  };

  it("reads how long an ad ran, how many ads reuse it, its button and its video", () => {
    const [ad] = adsFrom("meta_ads_comp_0", { data: { ads: [meta({ adCount: 3, ctaText: "Shop now" })] } });
    expect(ad).toMatchObject({ platform: "meta", advertiser: "Poppi", days: 94, active: true, variants: 3, cta: "Shop now", video_url: "https://video.cdn/ad.mp4", started: "2026-09-21" });
    const [tiktok] = adsFrom("tiktok_ads", tiktokLibrary);
    expect(tiktok).toMatchObject({ platform: "tiktok", advertiser: "poppi", text: "Prebiotic soda, 5g sugar", days: 21, audience: "10K-100K", video_url: "https://library.tiktok.com/api/v1/cdn/1/video/x" });
    const [top] = adsFrom("tiktok_top_ads", topAds);
    expect(top).toMatchObject({
      advertiser: "Poppi",
      text: "POV: you found a soda that does not wreck your gut",
      url: "https://ads.tiktok.com/business/creativecenter/topads/7213258221116751874/pc/en",
      objective: "conversions",
      likes: 128_456,
      duration: 15,
      link: "https://drinkpoppi.com",
      video_url: "https://v16.tiktokcdn.com/top.mp4",
      days: null,
    });
  });

  it("counts a still-running ad without an end date up to today", () => {
    const [ad] = adsFrom("meta_ads_cat", { data: { ads: [meta({ endDate: undefined, startDate: 1_000_000 })] } }, 1_000_000 + 30 * day);
    expect(ad.days).toBe(30);
  });

  it("adds the ads' videos to the pool as paid ad candidates, competitors' and longest-running first", () => {
    const research = compactResearch(
      "drinkolipop.com",
      [
        {
          key: "meta_ads_cat",
          status: "done",
          output: { data: { ads: [meta({ pageName: "Soda Co", text: "The prebiotic soda for gut health", endDate: 1_790_000_000 + 200 * day, media: [{ videoUrl: "https://video.cdn/cat.mp4" }] })] } },
        },
        { key: "meta_ads_comp_0", status: "done", output: { data: { ads: [meta({ adCount: 4 })] } } },
        { key: "tiktok_top_ads", status: "done", output: topAds },
      ],
      plan,
    );
    expect(research.ads.map((ad) => ad.source)).toEqual(["meta_ads_comp_0", "meta_ads_cat", "tiktok_top_ads"]);
    const adVideos = research.videos.filter((video) => video.ad);
    expect(adVideos).toHaveLength(3);
    expect(adVideos[0]).toMatchObject({ paid: true, views: 0, author: "Poppi", media_url: "https://video.cdn/ad.mp4", ad: { network: "meta", days: 94, variants: 4 } });
    expect(adVideos[2]).toMatchObject({ platform: "tiktok", likes: 128_456, ad: { network: "tiktok", objective: "conversions" } });
  });

  it("drops ad-library keyword matches that do not name who or what was searched", () => {
    const research = compactResearch(
      "drinkolipop.com",
      [
        // A name or keyword search returns anyone who says the word: truck dealers saying "rapid".
        {
          key: "meta_ads_0",
          status: "done",
          output: { data: { ads: [meta({ pageName: "Auto Provider", text: "Need a truck? Financing fast", linkUrl: "https://api.whatsapp.com/send" }), meta({ linkUrl: "https://shop.drinkpoppi.com" })] } },
        },
        { key: "meta_ads_cat", status: "done", output: { data: { ads: [meta({ pageName: "Shenzhen VMT Metal", text: "{{product.brand}}", linkUrl: "" }), meta({ pageName: "Gutsy", text: "A prebiotic you can drink" })] } } },
      ],
      plan,
    );
    expect(research.ads.map((ad) => ad.advertiser)).toEqual(["Poppi", "Gutsy"]);
  });
});

describe("the research plan", () => {
  it("asks for conversion searches, and benchmarks for reach and for conversion", async () => {
    let tools: Array<{ input_schema: { required: string[]; properties: Record<string, { items?: { required?: string[] } }> } }> = [];
    const naive = {
      message: async (request: { tools: typeof tools }) => {
        tools = request.tools;
        return {
          content: [
            {
              type: "tool_use",
              name: "research_plan",
              input: {
                ...plan,
                conversion_queries: ["olipop vs poppi", " ", "prebiotic soda review"],
                benchmarks: [
                  { name: "Duolingo", why: "mascot humour", role: "reach" },
                  { name: "Liquid IV", why: "UGC that sells", role: "convert" },
                  { name: "Nobody", why: "", role: "viral" },
                ],
              },
            },
          ],
        };
      },
    };
    const planned = await planResearch(naive as never, { domain: "drinkolipop.com", brand: pack.brand, siteExcerpt: "", similar: [] });
    expect(tools[0].input_schema.required).toContain("conversion_queries");
    expect(tools[0].input_schema.properties.benchmarks.items?.required).toContain("role");
    expect(planned.conversion_queries).toEqual(["olipop vs poppi", "prebiotic soda review"]);
    expect(planned.benchmarks).toEqual([
      { name: "Duolingo", why: "mascot humour", role: "reach" },
      { name: "Liquid IV", why: "UGC that sells", role: "convert" },
      { name: "Nobody", why: "" },
    ]);
  });

  it("falls back to review and 'I tried' searches", () => {
    expect(fallbackPlan("acme.com", { ...pack.brand, industry: "running shoes" }, []).conversion_queries).toEqual(["running shoes review", "I tried running shoes"]);
  });
});

describe("parsing helpers", () => {
  it("parses compact counts", () => {
    expect(parseCount("1.2M")).toBe(1_200_000);
    expect(parseCount("15K")).toBe(15_000);
    expect(parseCount("3,400")).toBe(3400);
    expect(parseCount(42)).toBe(42);
    expect(parseCount("n/a")).toBeNull();
  });

  it("pulls a JSON object out of prose", () => {
    expect(extractJson('Here you go: {"a": 1} hope that helps')).toEqual({ a: 1 });
    expect(extractJson("no json here")).toBeNull();
  });
});

describe("the research planner when the model is busy", () => {
  const input = { domain: "usenaive.ai", brand: { name: "Naive", description: "", slogan: "", industry: "", colors: [], logo: "", socials: [], images: [] }, siteExcerpt: "", similar: [] };

  it("waits for a busy model instead of falling back to a generic plan", async () => {
    const { ApiError } = await import("@/lib/http");
    const busy = { message: async () => Promise.reject(new ApiError("naive", 429, "rate_limited", "the service is at capacity")) };
    await expect(planResearch(busy as never, input as never)).rejects.toThrow(/capacity/);
  });

  it("still falls back when the model's answer is unusable", async () => {
    const broken = { message: async () => Promise.reject(new Error("unexpected reply")) };
    const plan = await planResearch(broken as never, input as never);
    expect(plan.content_queries.length).toBeGreaterThan(0);
  });
});

describe("campaign retries after a busy provider", () => {
  it("back off from 5 s to 5 min", async () => {
    const { retryDelayMs } = await import("@/lib/pipeline");
    expect([1, 2, 3, 6, 7, 12].map(retryDelayMs)).toEqual([5000, 10000, 20000, 160000, 300000, 300000]);
  });
});
