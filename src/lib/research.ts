import { ApiError } from "./http";
import type { MonidInput } from "./monid";
import type { NaiveClient } from "./naive";
import { getSetting } from "./settings";

// The research pack: Monid data pulls in two phases, with a planning call in between.

export type RunSpec = { key: string; phase: "A" | "C" | "D"; label: string; provider: string; endpoint: string; input: MonidInput };

export type ResearchPlan = {
  brand_name: string;
  category: string;
  audience: string;
  competitors: Array<{ name: string; domain?: string }>;
  content_queries: string[];
  /**
   * Searches for videos that sell in this category: reviews, "I tried", comparisons, demos,
   * testimonials. Likes prove reach; these find the formats that turn viewers into customers.
   */
  conversion_queries?: string[];
  ads_query: string;
  reddit_query: string;
  aeo_prompts: string[];
  /**
   * Brands or creators famous for short-form whose hooks and formats would transfer: some for reach
   * (Cluely, MrBeast), some for UGC that converts (an app or DTC brand that scales creator ads).
   */
  benchmarks?: Array<{ name: string; why: string; role?: "reach" | "convert" }>;
  /** Set once the scout has looked at the first results and queued its follow-up searches (phase D). */
  scouted?: boolean;
  /** What the scout saw and why it searched further, for the activity feed and the research tab. */
  scout_notes?: string;
};

/** The three short-video searches research can run, by platform. */
export function videoSearch(key: string, platform: "tiktok" | "instagram" | "youtube", query: string, phase: RunSpec["phase"]): RunSpec {
  if (platform === "instagram") return { key, phase, label: `Instagram Reels: ${query}`, provider: "anyapi", endpoint: "/instagram.reels_search", input: { body: { query } } };
  if (platform === "youtube") return { key, phase, label: `YouTube Shorts: ${query}`, provider: "anyapi", endpoint: "/youtube.search_shorts", input: { body: { query, sortBy: "popular" } } };
  return { key, phase, label: `TikTok: ${query}`, provider: "anyapi", endpoint: "/tiktok.search_keyword", input: { body: { query, sortBy: "most-liked" } } };
}

/** Run keys whose output is a list of short videos, and which platform each searched. */
export const VIDEO_RUN = /^(tiktok_(brand|\d+|comp_\d+|bench_\d+|conv_\d+)|reels(_\d+|_conv_\d+)?|shorts(_\d+)?|scout_(tiktok|reels|shorts)_\d+)$/;
export const platformOfRun = (key: string): Video["platform"] => (key.includes("reels") ? "instagram" : key.includes("shorts") ? "youtube" : "tiktok");

export type Video = {
  platform: "tiktok" | "instagram" | "youtube";
  url: string;
  caption: string;
  views: number;
  likes: number;
  comments: number;
  shares: number;
  saves: number;
  duration: number | null;
  author: string;
  followers: number | null;
  paid: boolean;
  thumbnail: string | null;
  /** Direct, short-lived link to the video file (used for the format study, never sent to a model). */
  media_url: string | null;
  source: string;
  /** Set when the video is a paid ad from an ad library: what the library says about it. */
  ad?: AdSignals;
};

/**
 * The public evidence that an ad pays for itself. Ad libraries hide spend and results, but
 * advertisers stop paying for ads that lose money, so how long an ad has run and how many ads reuse
 * its creative are the closest public stand-ins for conversion data.
 */
export type AdSignals = {
  network: "meta" | "tiktok";
  /** Days from first to last shown (to today while it still runs), or null when unknown. */
  days: number | null;
  active: boolean | null;
  /** Meta: how many ads use this same creative and text. */
  variants: number | null;
  /** The button: "Shop now", "Sign up", "Learn more", or "". */
  cta: string;
  /** TikTok Creative Center: the campaign objective it was bought for ("conversions"), or "". */
  objective: string;
};

export type Ad = {
  platform: "tiktok" | "meta";
  advertiser: string;
  text: string;
  url: string;
  media: string;
  started: string;
  source: string;
  /** Last shown (YYYY-MM-DD), or "" when unknown. */
  ended?: string;
  days?: number | null;
  active?: boolean | null;
  variants?: number | null;
  cta?: string;
  /** Where the ad sends people. */
  link?: string;
  /** Direct link to the ad's video file, when the library gives one. */
  video_url?: string | null;
  cover?: string | null;
  /** TikTok's EU library: the estimated audience band, e.g. "10K-100K". */
  audience?: string;
  objective?: string;
  likes?: number | null;
  duration?: number | null;
};

export type ResearchPack = {
  domain: string;
  brand: { name: string; description: string; slogan: string; industry: string; colors: string[]; logo: string | null; socials: Array<{ type: string; url: string }>; images: string[] };
  site_excerpt: string;
  similar_sites: string[];
  seo: { domain_rating: number | null; keywords: Array<{ keyword: string; volume: number | null; position: number | null; traffic: number | null }> };
  videos: Video[];
  ads: Ad[];
  reddit: Array<{ title: string; subreddit: string; score: number; comments: number; url: string; text: string }>;
  aeo: Array<{ engine: string; prompt: string; answer: string; mentions_brand: boolean; competitors_mentioned: string[] }>;
};

const today = () => new Date().toISOString().slice(0, 10);

export function phaseASpecs(domain: string): RunSpec[] {
  return [
    { key: "brand", phase: "A", label: "Brand profile", provider: "context.dev", endpoint: "/brand/retrieve", input: { queryParams: { domain } } },
    {
      key: "site",
      phase: "A",
      label: "Website content",
      provider: "context.dev",
      endpoint: "/web/scrape/markdown",
      input: { queryParams: { url: `https://${domain}`, useMainContentOnly: true, includeImages: true, includeLinks: false } },
    },
    { key: "similar", phase: "A", label: "Similar sites", provider: "anyapi", endpoint: "/similarweb.similar_sites", input: { body: { domain } } },
    { key: "seo_rating", phase: "A", label: "Domain rating", provider: "ahrefs", endpoint: "/site-explorer/domain-rating", input: { queryParams: { target: domain, date: today() } } },
    {
      key: "seo_keywords",
      phase: "A",
      label: "Organic keywords",
      provider: "ahrefs",
      endpoint: "/site-explorer/organic-keywords",
      input: { queryParams: { target: domain, date: today(), country: "us", mode: "subdomains", limit: 20 } },
    },
  ];
}

/** TikTok Creative Center's campaign objectives, as its ad search numbers them. 3 is "conversions". */
export const TOP_ADS_CONVERSIONS = 3;

/**
 * Phase C casts a wide net for short videos that already work: every content query on TikTok, the
 * best two on Reels and Shorts, the brand's name, and each competitor's name (their own posts and
 * posts about them). Ranking happens later, by how far a video outran its account, not raw views.
 *
 * Reach is half the story, so it also looks for proof that a format sells: the conversion queries
 * (reviews, "I tried", comparisons), the competitors' own ads on Meta and TikTok (an ad that keeps
 * running is an ad that pays), the category's ads, and TikTok's top ads bought for conversions.
 */
export function phaseCSpecs(plan: ResearchPlan): RunSpec[] {
  const queries = plan.content_queries.filter(Boolean).slice(0, 5);
  const top = queries.slice(0, 2).length ? queries.slice(0, 2) : [plan.category];
  const conversion = (plan.conversion_queries ?? []).filter(Boolean).slice(0, 3);
  // A keyword search matches ad text, so a competitor's name finds anyone who says it ("RapidAPI"
  // found WhatsApp ads saying "rapid"); the company search lists that advertiser's own ads.
  const metaCompany = (key: string, name: string): RunSpec => ({
    key,
    phase: "C",
    label: `Meta ads by ${name}`,
    provider: "anyapi",
    endpoint: "/facebook.company_ads",
    input: { body: { companyName: name, mediaType: "VIDEO", status: "ACTIVE", sortBy: "impressions", country: "US" } },
  });
  // TikTok's public ad library covers the EU and UK only (the US is not served); GB is the English one.
  const tiktokAds = (key: string, body: Record<string, unknown>, label: string): RunSpec => ({
    key,
    phase: "C",
    label,
    provider: "anyapi",
    endpoint: "/tiktok.ad_library_search",
    input: { body: { ...body, region: "GB" } },
  });
  return [
    videoSearch("tiktok_brand", "tiktok", plan.brand_name, "C"),
    ...queries.map((query, i) => videoSearch(`tiktok_${i}`, "tiktok", query, "C")),
    ...conversion.map((query, i) => videoSearch(`tiktok_conv_${i}`, "tiktok", query, "C")),
    ...conversion.slice(0, 1).map((query, i) => videoSearch(`reels_conv_${i}`, "instagram", query, "C")),
    ...plan.competitors.slice(0, 3).map((competitor, i) => videoSearch(`tiktok_comp_${i}`, "tiktok", competitor.name, "C")),
    ...(plan.benchmarks ?? []).slice(0, 3).map((benchmark, i) => videoSearch(`tiktok_bench_${i}`, "tiktok", benchmark.name, "C")),
    ...top.map((query, i) => videoSearch(`reels_${i}`, "instagram", query, "C")),
    ...top.map((query, i) => videoSearch(`shorts_${i}`, "youtube", query, "C")),
    tiktokAds("tiktok_ads", { query: plan.ads_query }, `TikTok ads: ${plan.ads_query}`),
    ...plan.competitors.slice(0, 2).map((competitor, i) => tiktokAds(`tiktok_ads_comp_${i}`, { advertiserName: competitor.name }, `TikTok ads by ${competitor.name}`)),
    {
      key: "tiktok_top_ads",
      phase: "C",
      label: `TikTok top ads for conversions: ${plan.ads_query}`,
      provider: "tikhub",
      endpoint: "/api/v1/tiktok/ads/search_ads",
      input: { body: { keyword: plan.ads_query, objective: TOP_ADS_CONVERSIONS, period: 180, country_code: "US", order_by: "likes", limit: 20 } },
    },
    metaCompany("meta_ads_brand", plan.brand_name),
    ...plan.competitors.slice(0, 3).map((competitor, i) => metaCompany(`meta_ads_comp_${i}`, competitor.name)),
    {
      key: "meta_ads_cat",
      phase: "C",
      label: `Meta ads: ${plan.ads_query}`,
      provider: "anyapi",
      endpoint: "/facebook.ads_search",
      input: { body: { query: plan.ads_query, mediaType: "VIDEO", status: "ACTIVE", sortBy: "impressions", country: "US" } },
    },
    { key: "reddit", phase: "C", label: `Reddit: ${plan.reddit_query}`, provider: "anyapi", endpoint: "/reddit.search", input: { body: { query: plan.reddit_query, sort: "top", timeframe: "year" } } },
    {
      key: "aeo_chatgpt",
      phase: "C",
      label: "ChatGPT answer",
      provider: "dataforseo",
      endpoint: "/ai/chatgpt-search",
      input: { body: { keyword: plan.aeo_prompts[0], location_name: "United States", language_code: "en" } },
    },
    { key: "aeo_perplexity", phase: "C", label: "Perplexity answer", provider: "anyapi", endpoint: "/perplexity.search", input: { body: { prompt: plan.aeo_prompts[1] ?? plan.aeo_prompts[0] } } },
  ];
}

// ---------- planning ----------

const PLAN_TOOL = {
  name: "research_plan",
  description: "Record the research plan for this brand.",
  input_schema: {
    type: "object",
    required: ["brand_name", "category", "audience", "competitors", "content_queries", "conversion_queries", "ads_query", "reddit_query", "aeo_prompts", "benchmarks"],
    properties: {
      brand_name: { type: "string", description: "The brand's name as customers say it." },
      category: { type: "string", description: "The product category in 2-4 words, e.g. 'prebiotic soda'." },
      audience: { type: "string", description: "Who buys it, in one sentence." },
      competitors: {
        type: "array",
        description: "3-5 direct competitors customers compare it with.",
        items: { type: "object", required: ["name"], properties: { name: { type: "string" }, domain: { type: "string" } } },
      },
      content_queries: {
        type: "array",
        items: { type: "string" },
        description:
          "5 short phrases (2-5 words, no brand names) that surface short videos this brand's buyers already watch, one of each kind, in this order: (1) the problem in the buyer's words, (2) the job they are trying to get done, (3) the buyer's identity or role as creators tag it, e.g. 'day in the life backend engineer', (4) the category as people say it, (5) a format phrase that fits, e.g. 'tools I wish I knew sooner'.",
      },
      conversion_queries: {
        type: "array",
        maxItems: 3,
        items: { type: "string" },
        description:
          "3 short phrases (2-5 words) that surface videos that SELL in this category rather than just entertain, as buyers search them: a review or 'I tried' ('I tried prebiotic soda', 'honest review agent tools'), a comparison with a competitor ('poppi vs olipop'), and a demo, before-and-after or testimonial phrase that fits the product. Competitor names are fine; not this brand's own name.",
      },
      ads_query: { type: "string", description: "A 1-3 word phrase to search ad libraries for this category." },
      reddit_query: { type: "string", description: "A phrase that finds real customer discussions of this category on Reddit." },
      aeo_prompts: { type: "array", items: { type: "string" }, description: "2 questions a buyer would ask ChatGPT or Perplexity when choosing a product in this category." },
      benchmarks: {
        type: "array",
        maxItems: 3,
        description:
          "2-3 brands or creators famous for short-form video whose hooks and formats would transfer to this brand (not competitors), as they are known on TikTok. Include at least one known for reach (e.g. Cluely for an AI startup, Duolingo for a consumer app, MrBeast for hooks) and at least one known for creator videos that convert, i.e. a brand that grew sales or sign-ups with UGC ads (e.g. Cal AI for an app, Ridge or Dr. Squatch for a physical product). Real, well-known names only.",
        items: {
          type: "object",
          required: ["name", "why", "role"],
          properties: {
            name: { type: "string" },
            why: { type: "string", description: "What about their videos would transfer." },
            role: { type: "string", enum: ["reach", "convert"], description: "reach: famous for views and shares; convert: famous for UGC that drives sales or sign-ups." },
          },
        },
      },
    },
  },
};

export async function planResearch(naive: NaiveClient, input: { domain: string; brand: ResearchPack["brand"]; siteExcerpt: string; similar: string[] }): Promise<ResearchPlan> {
  const fallback = fallbackPlan(input.domain, input.brand, input.similar);
  try {
    const reply = await naive.message({
      model: getSetting("planner_model"),
      // The plan now carries conversion searches and benchmark roles: 1200 tokens cut it off mid-call.
      max_tokens: 3000,
      system:
        "You plan market research for a marketing team that makes short videos to grow a customer's sales, not just its views: it needs both what gets watched in this category and what makes people buy (reviews, demos, comparisons, ads that keep running). Call the research_plan tool exactly once. Be concrete and use the words real customers use.",
      messages: [
        {
          role: "user",
          content: [
            `Website: ${input.domain}`,
            `Brand profile: ${JSON.stringify({ name: input.brand.name, description: input.brand.description, slogan: input.brand.slogan, industry: input.brand.industry })}`,
            `Similar sites: ${input.similar.slice(0, 12).join(", ") || "unknown"}`,
            `Homepage excerpt:\n${input.siteExcerpt.slice(0, 4000)}`,
          ].join("\n\n"),
        },
      ],
      tools: [PLAN_TOOL],
    });
    const call = reply.content.find((block) => block.type === "tool_use" && block.name === PLAN_TOOL.name);
    const raw = (call?.input ?? extractJson(reply.content.map((block) => block.text ?? "").join("\n"))) as Partial<ResearchPlan> | null;
    return raw ? mergePlan(raw, fallback) : fallback;
  } catch (error) {
    // A busy or failing model is worth waiting for: a generic plan searches the brand's name and
    // fills the research with noise (the first naive run pulled in music, anime and NIVEA ads).
    if (error instanceof ApiError && error.retryable) throw error;
    return fallback;
  }
}

function mergePlan(raw: Partial<ResearchPlan>, fallback: ResearchPlan): ResearchPlan {
  const strings = (value: unknown) => (Array.isArray(value) ? value.filter((v): v is string => typeof v === "string" && v.trim() !== "").map((v) => v.trim()) : []);
  const competitors = Array.isArray(raw.competitors) ? raw.competitors.filter((c) => c && typeof c.name === "string" && c.name.trim()) : [];
  const queries = strings(raw.content_queries);
  const conversion = strings(raw.conversion_queries);
  const prompts = strings(raw.aeo_prompts);
  return {
    brand_name: text(raw.brand_name) || fallback.brand_name,
    category: text(raw.category) || fallback.category,
    audience: text(raw.audience) || fallback.audience,
    competitors: competitors.length ? competitors.slice(0, 5) : fallback.competitors,
    content_queries: queries.length ? queries.slice(0, 5) : fallback.content_queries,
    conversion_queries: conversion.length ? conversion.slice(0, 3) : fallback.conversion_queries,
    ads_query: text(raw.ads_query) || fallback.ads_query,
    reddit_query: text(raw.reddit_query) || fallback.reddit_query,
    aeo_prompts: prompts.length ? prompts.slice(0, 2) : fallback.aeo_prompts,
    benchmarks: Array.isArray(raw.benchmarks)
      ? raw.benchmarks
          .filter((b) => b && typeof b.name === "string" && b.name.trim())
          .slice(0, 3)
          .map((b) => ({ name: b.name.trim(), why: text(b.why), ...(b.role === "reach" || b.role === "convert" ? { role: b.role } : {}) }))
      : [],
  };
}

export function fallbackPlan(domain: string, brand: ResearchPack["brand"], similar: string[]): ResearchPlan {
  const name = brand.name || titleCase(domain.split(".")[0]);
  const category = brand.industry || "products";
  return {
    brand_name: name,
    category,
    audience: `People shopping for ${category}`,
    competitors: similar.slice(0, 4).map((site) => ({ name: titleCase(site.split(".")[0]), domain: site })),
    content_queries: [category, `${name} review`, `best ${category}`, `${category} tips`],
    conversion_queries: [`${category} review`, `I tried ${category}`],
    ads_query: category,
    reddit_query: `best ${category}`,
    aeo_prompts: [`What are the best ${category} brands?`, `Which ${category} should I buy?`],
  };
}

// ---------- compaction ----------

type RunResult = { key: string; status: string; output: unknown };

export function compactResearch(domain: string, runs: RunResult[], plan: ResearchPlan | null): ResearchPack {
  const out = (key: string) => runs.find((run) => run.key === key && run.status === "done")?.output;
  const brand = brandFrom(out("brand"), domain);
  const siteText = longestString(out("site"), ["markdown", "content", "text"]) ?? "";
  const images = unique([...extractImages(siteText), ...brand.images], (url) => url.split("?")[0]).slice(0, 8);
  const names = [plan?.brand_name ?? brand.name, ...(plan?.competitors.map((c) => c.name) ?? [])];

  // A name search also returns look-alikes (searching "Monid" finds "monolid" makeup), so keep a
  // brand or competitor search result only if it actually names who was searched.
  const squash = (value: string) => value.toLowerCase().replace(/[\s#@._-]+/g, "");
  const brandName = squash(plan?.brand_name ?? brand.name);
  const competitorNames = (plan?.competitors ?? []).map((c) => squash(c.name));
  const benchmarkNames = (plan?.benchmarks ?? []).map((b) => squash(b.name));
  const mentions = (video: Video, name: string | undefined) => !name || squash(`${video.caption} ${video.author}`).includes(name);
  const onTopic = (video: Video) => {
    if (video.source === "tiktok_brand") return mentions(video, brandName);
    const comp = video.source.match(/^tiktok_comp_(\d+)$/);
    if (comp) return mentions(video, competitorNames[Number(comp[1])]);
    const bench = video.source.match(/^tiktok_bench_(\d+)$/);
    return bench ? mentions(video, benchmarkNames[Number(bench[1])]) : true;
  };
  const allVideos = unique(
    runs
      .filter((run) => run.status === "done" && VIDEO_RUN.test(run.key))
      .flatMap((run) => videosFrom(run.key, run.output))
      .filter(onTopic),
    (video) => video.url,
  ).sort((a, b) => roughScore(b) - roughScore(a));
  // Keep a wide pool for the reference engine to rank properly; TikTok volume would crowd out the
  // others, so each platform gets its own quota.
  const quota: Record<Video["platform"], number> = { tiktok: 50, instagram: 20, youtube: 20 };
  const organic = allVideos.filter((video) => quota[video.platform]-- > 0);

  // The brand's and competitors' own ads first (they prove what sells to this buyer), then the
  // category's; longest-running first, since an advertiser keeps paying only for ads that return.
  const ownAds = (ad: Ad) => /^(meta_ads_(brand|comp_\d+|\d+)|tiktok_ads_comp_\d+)$/.test(ad.source);
  // An ad library keyword search returns any ad that says the word ("RapidAPI" found truck dealers
  // saying "rapid"), so keep an ad only if it names who or what was searched.
  const adTerms = [plan?.ads_query, plan?.category]
    .flatMap((phrase) => (phrase ?? "").toLowerCase().split(/[^\p{L}\p{N}]+/u))
    .filter((word) => word.length > 3);
  const adOnTopic = (ad: Ad) => {
    if (!plan) return true;
    const said = `${ad.advertiser} ${ad.text} ${ad.link ?? ""}`;
    const names = (name: string | undefined) => Boolean(name) && squash(said).includes(name!);
    if (ad.source === "meta_ads_brand") return names(brandName);
    const comp = ad.source.match(/^(?:meta_ads_(?:comp_)?|tiktok_ads_comp_)(\d+)$/);
    if (comp) {
      const competitor = plan.competitors[Number(comp[1])];
      return names(competitorNames[Number(comp[1])]) || Boolean(competitor?.domain && said.toLowerCase().includes(competitor.domain.toLowerCase()));
    }
    if (ad.source === "meta_ads_cat" || ad.source === "tiktok_ads") return adTerms.some((term) => said.toLowerCase().includes(term)) || [brandName, ...competitorNames].some(names);
    return true;
  };
  const ads = unique(
    runs
      .filter((run) => run.status === "done" && /ads/.test(run.key))
      .flatMap((run) => adsFrom(run.key, run.output))
      .filter(adOnTopic),
    (ad) => `${ad.advertiser}|${ad.text}`,
  )
    .sort((a, b) => Number(ownAds(b)) - Number(ownAds(a)) || (b.days ?? -1) - (a.days ?? -1))
    .slice(0, 16);
  // Ads with a video join the pool the reference engine ranks: they are the conversion lane.
  const videos = [...organic, ...unique(ads.map(adVideo).filter((video): video is Video => video !== null), (video) => video.url).slice(0, 10)];
  const terms = [brand.name, plan?.brand_name, plan?.category, ...(plan?.competitors.map((c) => c.name) ?? [])]
    .filter((term): term is string => Boolean(term))
    .flatMap((term) => [term, ...term.split(/\s+/).filter((word) => word.length > 4)]);

  return {
    domain,
    brand: { ...brand, images },
    site_excerpt: siteText.replace(/!\[[^\]]*\]\([^)]*\)/g, "").replace(/\n{3,}/g, "\n\n").slice(0, 6000),
    similar_sites: similarFrom(out("similar")),
    seo: { domain_rating: numberAt(out("seo_rating"), ["domain_rating", "domainRating", "dr"]), keywords: keywordsFrom(out("seo_keywords")) },
    videos,
    ads,
    reddit: redditFrom(out("reddit"), terms),
    aeo: [
      aeoFrom("ChatGPT", plan?.aeo_prompts[0] ?? "", out("aeo_chatgpt"), names),
      aeoFrom("Perplexity", plan?.aeo_prompts[1] ?? plan?.aeo_prompts[0] ?? "", out("aeo_perplexity"), names),
    ].filter((entry): entry is ResearchPack["aeo"][number] => entry !== null),
  };
}

/** Up to three short, high-performing public videos for Naive to learn a format from. */
function brandFrom(output: unknown, domain: string): ResearchPack["brand"] {
  const brand = (record(record(output)?.brand) ?? record(output) ?? {}) as Record<string, unknown>;
  const industries = record(brand.industries)?.eic;
  const industry = Array.isArray(industries) && industries[0] ? text(record(industries[0])?.subindustry) || text(record(industries[0])?.industry) : "";
  const logos = Array.isArray(brand.logos) ? brand.logos.map((logo) => text(record(logo)?.url)).filter(Boolean) : [];
  return {
    name: text(brand.title) || titleCase(domain.split(".")[0]),
    description: text(brand.description),
    slogan: text(brand.slogan),
    industry,
    colors: Array.isArray(brand.colors) ? brand.colors.map((c) => text(record(c)?.hex)).filter(Boolean).slice(0, 6) : [],
    logo: logos[0] ?? null,
    socials: Array.isArray(brand.socials) ? brand.socials.map((s) => ({ type: text(record(s)?.type), url: text(record(s)?.url) })).filter((s) => s.url) : [],
    images: Array.isArray(brand.backdrops) ? brand.backdrops.map((b) => text(record(b)?.url)).filter(Boolean) : [],
  };
}

/**
 * A first-pass rank for the scout and the research tab: views relative to the account's size, with
 * engagement as a tiebreaker. The reference engine re-ranks the pool properly before anything is used.
 */
export function roughScore(video: Pick<Video, "views" | "followers" | "likes" | "comments" | "shares" | "saves">) {
  const outlier = video.followers ? video.views / Math.max(video.followers, 1000) : null;
  const engagement = (video.likes + video.comments + 2 * video.shares + 2 * video.saves) / Math.max(video.views, 1);
  const reach = Math.log10(Math.max(video.views, 10));
  return (outlier === null ? 1 : Math.log2(1 + Math.min(outlier, 200))) * 2 + Math.min(engagement, 0.3) * 10 + reach;
}

function videosFrom(key: string, output: unknown): Video[] {
  const platform = platformOfRun(key);
  return items(output).map((item) => {
    let url = pick(item, ["url", "link", "permalink", "shareUrl", "share_url", "webVideoUrl", "postUrl"]);
    const id = pick(item, ["id", "videoId", "video_id", "shortcode", "code"]);
    if (!url && platform === "youtube" && id) url = `https://www.youtube.com/shorts/${id}`;
    if (!url && platform === "instagram" && id) url = `https://www.instagram.com/reel/${id}/`;
    return {
      platform,
      url,
      caption: pick(item, ["caption", "title", "description", "text", "desc"]).slice(0, 300),
      views: num(item, ["views", "viewCount", "view_count", "playCount", "play_count", "videoViewCount", "plays"]) ?? 0,
      likes: num(item, ["likes", "likeCount", "like_count", "diggCount", "digg_count"]) ?? 0,
      comments: num(item, ["comments", "commentCount", "comment_count"]) ?? 0,
      shares: num(item, ["shares", "shareCount", "share_count"]) ?? 0,
      saves: num(item, ["saves", "collectCount", "saveCount"]) ?? 0,
      duration: num(item, ["durationSeconds", "duration", "videoDuration", "lengthSeconds", "duration_seconds"]),
      author: pick(item, ["author", "username", "authorName", "ownerUsername", "channel", "channelName", "owner"]),
      followers: num(item, ["authorFollowers", "followers", "followerCount", "subscriberCount"]),
      paid: Boolean(item.paidPartnership ?? item.isAd ?? item.is_ad ?? false),
      thumbnail: pick(item, ["image", "thumbnail", "cover", "thumbnailUrl", "displayUrl"]) || null,
      media_url: pick(item, ["videoUrl", "video_url", "downloadUrl", "playUrl"]) || null,
      source: key,
    };
  }).filter((video) => video.url);
}

/**
 * Ads from Meta's library (anyapi), TikTok's EU library (anyapi) and TikTok Creative Center's top
 * ads (tikhub), with what each says about how long the ad ran, how many ads reuse it and its button.
 */
export function adsFrom(key: string, output: unknown, nowSeconds = Date.now() / 1000): Ad[] {
  const platform: Ad["platform"] = key.startsWith("tiktok") ? "tiktok" : "meta";
  const creativeCenter = key === "tiktok_top_ads";
  return items(output)
    .map((item): Ad => {
      const info = record(item.ads_info) ?? {};
      const video = record(item.video_info) ?? {};
      const stats = record(item.statistics) ?? {};
      const start = epochSeconds(item.startDate ?? item.start_date ?? item.firstShownUtc ?? item.firstShown ?? item.first_shown ?? item.createdAt ?? item.ad_delivery_start_time ?? item.create_time);
      const end = epochSeconds(item.endDate ?? item.end_date ?? item.lastShownUtc ?? item.lastShown ?? item.last_shown ?? item.ad_delivery_stop_time);
      const active = typeof item.active === "boolean" ? item.active : null;
      // Meta reports today as the end of an ad that is still running; without an end, count to today.
      const days = start === null || creativeCenter ? null : Math.max(0, Math.round(((end ?? (active === false ? start : nowSeconds)) - start) / 86400));
      const id = pick(item, ["id", "adId", "material_id"]);
      return {
        platform,
        advertiser: text(info.advertiser_name) || pick(item, ["advertiser", "advertiserName", "pageName", "page_name", "brandName", "brand", "name"]),
        text: (pick(item, ["text", "body", "adText", "ad_text", "adTitle", "title", "caption", "description", "headline", "desc"]) || text(item.highlight)).slice(0, 400),
        url: creativeCenter && id ? `https://ads.tiktok.com/business/creativecenter/topads/${id}/pc/en` : pick(item, ["sourceUrl", "adUrl", "snapshotUrl", "ad_snapshot_url", "url", "linkUrl", "landingPage", "link"]),
        media: pick(item, ["displayFormat", "mediaType", "media_type", "format", "type"]).toLowerCase(),
        started: start === null ? "" : isoDate(start),
        source: key,
        ended: end === null ? "" : isoDate(end),
        days,
        active,
        variants: parseCount(item.adCount),
        cta: pick(item, ["ctaText", "cta_text"]),
        link: text(info.landing_page) || pick(item, ["linkUrl", "landingPage", "landing_page"]),
        video_url: adVideoUrl(item) || null,
        cover: pick(item, ["coverUrl", "cover", "thumbnail"]) || text(video.cover) || null,
        audience: pick(item, ["estimatedAudience"]),
        objective: creativeCenter ? "conversions" : "",
        likes: parseCount(stats.digg_count ?? item.like ?? item.likes),
        duration: parseCount(video.duration ?? item.durationSeconds),
      };
    })
    .filter((ad) => ad.advertiser || ad.text);
}

/** The ad's video file: Meta keeps it under media or creatives, TikTok on the item, tikhub by quality. */
function adVideoUrl(item: Record<string, unknown>): string {
  const direct = pick(item, ["videoUrl", "video_url"]);
  if (/^https?:/.test(direct)) return direct;
  for (const list of [item.media, item.creatives]) {
    for (const entry of Array.isArray(list) ? list : []) {
      const url = text(record(entry)?.videoUrl);
      if (url) return url;
    }
  }
  const qualities = record(record(item.video_info)?.video_url);
  if (qualities) return text(qualities["720p"] ?? qualities["540p"] ?? qualities["480p"] ?? Object.values(qualities)[0]);
  return text(record(item.video_info)?.video_url);
}

/** An ad with a video, as a research video the reference engine can rank, break down and remake. */
export function adVideo(ad: Ad): Video | null {
  if (!ad.video_url || !ad.url) return null;
  return {
    // Meta ads run on Facebook and Instagram; the vertical cut is the Instagram one.
    platform: ad.platform === "tiktok" ? "tiktok" : "instagram",
    url: ad.url,
    caption: ad.text,
    // Ad libraries publish no views: 0 here means unknown. Ads are judged on their ad signals.
    views: 0,
    likes: ad.likes ?? 0,
    comments: 0,
    shares: 0,
    saves: 0,
    duration: ad.duration ?? null,
    author: ad.advertiser,
    followers: null,
    paid: true,
    thumbnail: ad.cover ?? null,
    media_url: ad.video_url,
    source: ad.source,
    ad: { network: ad.platform, days: ad.days ?? null, active: ad.active ?? null, variants: ad.variants ?? null, cta: ad.cta ?? "", objective: ad.objective ?? "" },
  };
}

/** Unix seconds (or milliseconds) or an ISO date, as unix seconds. */
function epochSeconds(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value > 1e12 ? value / 1000 : value;
  if (typeof value === "string" && value.trim()) {
    if (/^\d+$/.test(value.trim())) return epochSeconds(Number(value));
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed / 1000 : null;
  }
  return null;
}

const isoDate = (seconds: number) => new Date(seconds * 1000).toISOString().slice(0, 10);

function similarFrom(output: unknown): string[] {
  return items(output)
    .map((item) => pick(item, ["domain", "site", "url", "website", "name"]).replace(/^https?:\/\//, "").replace(/\/.*$/, ""))
    .filter(Boolean)
    .slice(0, 15);
}

function keywordsFrom(output: unknown): ResearchPack["seo"]["keywords"] {
  return items(output)
    .map((item) => ({
      keyword: pick(item, ["keyword", "query", "term"]),
      volume: num(item, ["volume", "search_volume", "sum_volume"]),
      position: num(item, ["best_position", "position", "rank"]),
      traffic: num(item, ["sum_traffic", "traffic", "estimated_traffic"]),
    }))
    .filter((k) => k.keyword)
    .slice(0, 20);
}

function redditFrom(output: unknown, terms: string[]): ResearchPack["reddit"] {
  const lowered = terms.map((term) => term.toLowerCase()).filter(Boolean);
  return items(output)
    .map((item) => {
      const permalink = pick(item, ["permalink"]);
      return {
        title: pick(item, ["title"]),
        subreddit: pick(item, ["subreddit", "subredditName", "community"]),
        score: num(item, ["score", "ups", "upvotes"]) ?? 0,
        comments: num(item, ["numComments", "num_comments", "comments", "commentCount"]) ?? 0,
        url: permalink ? `https://www.reddit.com${permalink}` : pick(item, ["url", "link"]),
        text: pick(item, ["selftext", "text", "body", "content"]).slice(0, 400),
      };
    })
    // Reddit's top-of-year search returns popular posts that barely match; keep the on-topic ones.
    .filter((post) => post.title && (lowered.length === 0 || lowered.some((term) => `${post.title} ${post.text}`.toLowerCase().includes(term))))
    .slice(0, 12);
}

function aeoFrom(engine: string, prompt: string, output: unknown, names: string[]): ResearchPack["aeo"][number] | null {
  if (output === undefined) return null;
  const answer = collectStrings(output, ["text", "answer", "markdown", "content", "response", "message"]).join("\n").slice(0, 2500);
  if (!answer) return null;
  const lower = answer.toLowerCase();
  const [brand, ...competitors] = names.filter(Boolean);
  return {
    engine,
    prompt,
    answer,
    mentions_brand: brand ? lower.includes(brand.toLowerCase()) : false,
    competitors_mentioned: competitors.filter((name) => lower.includes(name.toLowerCase())),
  };
}

// ---------- tolerant readers for provider JSON ----------

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "";
}

/** The first array of objects found in a provider's output, breadth-first. */
export function items(output: unknown, depth = 0): Array<Record<string, unknown>> {
  if (Array.isArray(output)) return output.filter((entry) => record(entry)) as Array<Record<string, unknown>>;
  const obj = record(output);
  if (!obj || depth > 4) return [];
  const preferred = ["videos", "data", "items", "results", "posts", "ads", "keywords", "similar_sites", "sites", "reels", "shorts", "children", "result", "tasks"];
  for (const key of preferred) {
    const value = obj[key];
    if (Array.isArray(value) && value.some((entry) => record(entry))) {
      const nested = value.length === 1 && record(value[0]) && depth < 4 ? items(value[0], depth + 1) : [];
      return nested.length > 1 ? nested : (value.filter((entry) => record(entry)) as Array<Record<string, unknown>>);
    }
  }
  for (const value of Object.values(obj)) {
    const found = items(value, depth + 1);
    if (found.length) return found;
  }
  return [];
}

function pick(item: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = item[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number") return String(value);
    const nested = record(value);
    if (nested) {
      const inner = text(nested.uniqueId ?? nested.username ?? nested.name ?? nested.url ?? nested.text);
      if (inner) return inner;
    }
  }
  return "";
}

export function parseCount(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  const match = value.trim().replace(/,/g, "").match(/^(\d+(?:\.\d+)?)\s*([kmb])?$/i);
  if (!match) return null;
  const scale = { k: 1e3, m: 1e6, b: 1e9 }[(match[2] ?? "").toLowerCase() as "k" | "m" | "b"] ?? 1;
  return Math.round(Number(match[1]) * scale);
}

function num(item: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const parsed = parseCount(item[key]);
    if (parsed !== null) return parsed;
  }
  return null;
}

function numberAt(output: unknown, keys: string[], depth = 0): number | null {
  const obj = record(output);
  if (!obj || depth > 4) return null;
  for (const key of keys) {
    const parsed = parseCount(obj[key]);
    if (parsed !== null) return parsed;
  }
  for (const value of Object.values(obj)) {
    const found = numberAt(value, keys, depth + 1);
    if (found !== null) return found;
  }
  return null;
}

function longestString(output: unknown, keys: string[]): string | null {
  const found = collectStrings(output, keys);
  return found.sort((a, b) => b.length - a.length)[0] ?? null;
}

function collectStrings(output: unknown, keys: string[], depth = 0, into: string[] = []): string[] {
  if (depth > 6) return into;
  if (Array.isArray(output)) output.forEach((entry) => collectStrings(entry, keys, depth + 1, into));
  const obj = record(output);
  if (obj) {
    for (const [key, value] of Object.entries(obj)) {
      if (typeof value === "string" && keys.includes(key) && value.trim().length > 20) into.push(value.trim());
      else if (typeof value === "object") collectStrings(value, keys, depth + 1, into);
    }
  }
  return into;
}

function extractImages(markdown: string): string[] {
  const urls = [...markdown.matchAll(/!\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/g)].map((match) => match[1]);
  return urls.filter((url) => /\.(jpe?g|png|webp)(\?|$)/i.test(url) && !/(icon|favicon|sprite|badge|logo|payment|flag)/i.test(url));
}

export function extractJson(raw: string): unknown {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
}

function unique<T>(values: T[], by: (value: T) => unknown = (value) => value): T[] {
  const seen = new Set<unknown>();
  return values.filter((value) => {
    const key = by(value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function titleCase(word: string) {
  return word ? word[0].toUpperCase() + word.slice(1) : word;
}
