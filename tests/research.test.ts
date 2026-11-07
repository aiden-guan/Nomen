import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { compactResearch, extractJson, fallbackPlan, parseCount, phaseASpecs, phaseCSpecs, type ResearchPlan } from "@/lib/research";

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

  it("phase C searches the brand, the category and two competitors' ads", () => {
    const specs = phaseCSpecs(plan);
    expect(specs.find((spec) => spec.key === "tiktok_brand")?.input.body).toMatchObject({ query: plan.brand_name });
    expect(specs.filter((spec) => spec.key.startsWith("meta_ads_")).length).toBe(3);
    expect(new Set(specs.map((spec) => spec.key)).size).toBe(specs.length);
  });

  it("falls back to a usable plan without a model", () => {
    const fallback = fallbackPlan("acme.com", { ...pack.brand, name: "", industry: "" }, ["rival.com"]);
    expect(fallback.brand_name).toBe("Acme");
    expect(fallback.competitors[0]).toEqual({ name: "Rival", domain: "rival.com" });
    expect(fallback.aeo_prompts.length).toBe(2);
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
