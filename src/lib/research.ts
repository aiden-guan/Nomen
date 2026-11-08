import type { NaiveClient } from "./naive";
import type { RunSpec } from "./runs";
import { getSetting } from "./settings";

// The research pack: Monid data pulls in two phases, with a planning call in between.

export type { RunSpec };

export type ResearchPlan = {
  brand_name: string;
  category: string;
  audience: string;
  competitors: Array<{ name: string; domain?: string }>;
  content_queries: string[];
  ads_query: string;
  reddit_query: string;
  aeo_prompts: string[];
};

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
};

export type Ad = { platform: "tiktok" | "meta"; advertiser: string; text: string; url: string; media: string; started: string; source: string };

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

export function phaseCSpecs(plan: ResearchPlan): RunSpec[] {
  const queries = plan.content_queries.filter(Boolean).slice(0, 2);
  const first = queries[0] ?? plan.category;
  const tiktok = (key: string, query: string): RunSpec => ({
    key,
    phase: "C",
    label: `TikTok: ${query}`,
    provider: "anyapi",
    endpoint: "/tiktok.search_keyword",
    input: { body: { query, sortBy: "most-liked" } },
  });
  const metaAds = (key: string, query: string): RunSpec => ({
    key,
    phase: "C",
    label: `Meta ads: ${query}`,
    provider: "anyapi",
    endpoint: "/facebook.ads_search",
    input: { body: { query, mediaType: "VIDEO", status: "ACTIVE", sortBy: "impressions", country: "US" } },
  });
  return [
    tiktok("tiktok_brand", plan.brand_name),
    ...queries.map((query, i) => tiktok(`tiktok_${i}`, query)),
    { key: "reels", phase: "C", label: `Instagram Reels: ${first}`, provider: "anyapi", endpoint: "/instagram.reels_search", input: { body: { query: first } } },
    { key: "shorts", phase: "C", label: `YouTube Shorts: ${first}`, provider: "anyapi", endpoint: "/youtube.search_shorts", input: { body: { query: first, sortBy: "popular" } } },
    { key: "tiktok_ads", phase: "C", label: `TikTok ads: ${plan.ads_query}`, provider: "anyapi", endpoint: "/tiktok.ad_library_search", input: { body: { query: plan.ads_query } } },
    metaAds("meta_ads_brand", plan.brand_name),
    ...plan.competitors.slice(0, 2).map((competitor, i) => metaAds(`meta_ads_${i}`, competitor.name)),
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
    required: ["brand_name", "category", "audience", "competitors", "content_queries", "ads_query", "reddit_query", "aeo_prompts"],
    properties: {
      brand_name: { type: "string", description: "The brand's name as customers say it." },
      category: { type: "string", description: "The product category in 2-4 words, e.g. 'prebiotic soda'." },
      audience: { type: "string", description: "Who buys it, in one sentence." },
      competitors: {
        type: "array",
        description: "3-5 direct competitors customers compare it with.",
        items: { type: "object", required: ["name"], properties: { name: { type: "string" }, domain: { type: "string" } } },
      },
      content_queries: { type: "array", items: { type: "string" }, description: "2-3 short phrases people type into TikTok search for this category (not the brand name)." },
      ads_query: { type: "string", description: "A 1-3 word phrase to search ad libraries for this category." },
      reddit_query: { type: "string", description: "A phrase that finds real customer discussions of this category on Reddit." },
      aeo_prompts: { type: "array", items: { type: "string" }, description: "2 questions a buyer would ask ChatGPT or Perplexity when choosing a product in this category." },
    },
  },
};

export async function planResearch(naive: NaiveClient, input: { domain: string; brand: ResearchPack["brand"]; siteExcerpt: string; similar: string[] }): Promise<ResearchPlan> {
  const fallback = fallbackPlan(input.domain, input.brand, input.similar);
  try {
    const reply = await naive.message({
      model: getSetting("planner_model"),
      max_tokens: 1200,
      system: "You plan market research for a marketing team. Call the research_plan tool exactly once. Be concrete and use the words real customers use.",
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
  } catch {
    return fallback;
  }
}

function mergePlan(raw: Partial<ResearchPlan>, fallback: ResearchPlan): ResearchPlan {
  const strings = (value: unknown) => (Array.isArray(value) ? value.filter((v): v is string => typeof v === "string" && v.trim() !== "").map((v) => v.trim()) : []);
  const competitors = Array.isArray(raw.competitors) ? raw.competitors.filter((c) => c && typeof c.name === "string" && c.name.trim()) : [];
  const queries = strings(raw.content_queries);
  const prompts = strings(raw.aeo_prompts);
  return {
    brand_name: text(raw.brand_name) || fallback.brand_name,
    category: text(raw.category) || fallback.category,
    audience: text(raw.audience) || fallback.audience,
    competitors: competitors.length ? competitors.slice(0, 5) : fallback.competitors,
    content_queries: queries.length ? queries.slice(0, 3) : fallback.content_queries,
    ads_query: text(raw.ads_query) || fallback.ads_query,
    reddit_query: text(raw.reddit_query) || fallback.reddit_query,
    aeo_prompts: prompts.length ? prompts.slice(0, 2) : fallback.aeo_prompts,
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
    content_queries: [category, `${name} review`],
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

  // A brand-name search also returns look-alikes (searching "Monid" finds "monolid" makeup), so
  // keep a brand-search video only if it actually names the brand.
  const brandName = (plan?.brand_name ?? brand.name).toLowerCase().replace(/\s+/g, "");
  const namesBrand = (video: Video) => `${video.caption} ${video.author}`.toLowerCase().replace(/[\s#@]+/g, "").includes(brandName);
  const allVideos = unique(
    runs
      .filter((run) => run.status === "done" && /^(tiktok_(brand|\d)|reels|shorts)$/.test(run.key))
      .flatMap((run) => videosFrom(run.key, run.output))
      .filter((video) => video.source !== "tiktok_brand" || !brandName || namesBrand(video)),
    (video) => video.url,
  ).sort((a, b) => b.views - a.views);
  // TikTok numbers dwarf the others, so keep the best of each platform rather than the best overall.
  const quota: Record<Video["platform"], number> = { tiktok: 14, instagram: 6, youtube: 6 };
  const videos = allVideos.filter((video) => quota[video.platform]-- > 0);

  const ads = unique(
    runs.filter((run) => run.status === "done" && /ads/.test(run.key)).flatMap((run) => adsFrom(run.key, run.output)),
    (ad) => `${ad.advertiser}|${ad.text}`,
  ).slice(0, 16);
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

function videosFrom(key: string, output: unknown): Video[] {
  const platform: Video["platform"] = key === "reels" ? "instagram" : key === "shorts" ? "youtube" : "tiktok";
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

function adsFrom(key: string, output: unknown): Ad[] {
  const platform: Ad["platform"] = key.startsWith("tiktok") ? "tiktok" : "meta";
  return items(output)
    .map((item) => {
      const started = item.startDate ?? item.start_date ?? item.firstShown ?? item.first_shown ?? item.createdAt ?? item.ad_delivery_start_time;
      return {
        platform,
        advertiser: pick(item, ["advertiser", "advertiserName", "pageName", "page_name", "brand", "name"]),
        text: pick(item, ["text", "body", "adText", "ad_text", "title", "caption", "description", "headline"]).slice(0, 400),
        url: pick(item, ["sourceUrl", "adUrl", "snapshotUrl", "ad_snapshot_url", "url", "linkUrl", "landingPage", "link"]),
        media: pick(item, ["displayFormat", "mediaType", "media_type", "format", "type"]).toLowerCase(),
        started: typeof started === "number" ? new Date((started < 1e12 ? started * 1000 : started)).toISOString().slice(0, 10) : text(started).slice(0, 10),
        source: key,
      };
    })
    .filter((ad) => ad.advertiser || ad.text);
}

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

export function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

export function text(value: unknown): string {
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

export function pick(item: Record<string, unknown>, keys: string[]): string {
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

export function num(item: Record<string, unknown>, keys: string[]): number | null {
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

export function collectStrings(output: unknown, keys: string[], depth = 0, into: string[] = []): string[] {
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
