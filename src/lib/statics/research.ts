import type { NaiveClient } from "../naive";
import { collectStrings, extractJson, items, num, pick, record, type ResearchPack, type ResearchPlan, text } from "../research";
import type { RunSpec } from "../runs";
import { getSetting } from "../settings";

// Static-ad research. The researchers fan out over the places static ads are judged: the category's
// image ads in Meta's ad library ranked by impressions, competitors' and category leaders' own
// image posts on X (views and engagement are public there), their Google display ads, the paid
// search ads on the category's keywords, LinkedIn's ad library for B2B brands, agency case studies,
// and a screenshot of the brand's own site. Ad libraries do not publish results for commercial ads,
// so every ad carries the signals they do publish, and the study looks at the ads themselves.

export type StaticPlan = {
  /** The brand's own X handle, from its profile, so the study sees how it already presents itself. */
  brand_handle: string | null;
  competitors: Array<{ name: string; domain?: string; x_handle?: string }>;
  /** The best-known companies in the category, whose ads set the bar for craft. */
  leaders: Array<{ name: string; domain?: string; x_handle?: string }>;
  meta_queries: string[];
  search_keywords: string[];
  case_study_queries: string[];
  b2b: boolean;
};

export type StaticAd = {
  id: string;
  source: "meta" | "x" | "google" | "linkedin";
  role: "brand" | "competitor" | "leader" | "category";
  advertiser: string;
  image: string | null;
  text: string;
  headline: string;
  cta: string;
  url: string;
  started: string | null;
  days: number | null;
  variants: number | null;
  rank: number;
  views: number | null;
  engagement: number | null;
  /** 0-1, comparable across sources: how strongly the published signals say this ad performs. */
  score: number;
  /** The signals in words, e.g. "#2 by impressions · running 74 days · 3 versions". */
  signal: string;
};

export type StaticResearch = {
  plan: StaticPlan;
  ads: StaticAd[];
  search_ads: Array<{ keyword: string; advertiser: string; title: string; description: string; url: string }>;
  cases: Array<{ title: string; url: string; excerpt: string }>;
  screenshot: string | null;
  sources: { done: number; total: number };
};

const DAY = 24 * 3600 * 1000;

// ---------- planning ----------

const PLAN_TOOL = {
  name: "static_research_plan",
  description: "Record where to look for this brand's static-ad research.",
  strict: true,
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["competitors", "leaders", "meta_queries", "search_keywords", "case_study_queries", "b2b"],
    properties: {
      competitors: {
        type: "array",
        description: "Up to 3 direct competitors, with their website domain and X handle (without @) if you know them; empty string if not.",
        items: { type: "object", additionalProperties: false, required: ["name", "domain", "x_handle"], properties: { name: { type: "string" }, domain: { type: "string" }, x_handle: { type: "string" } } },
      },
      leaders: {
        type: "array",
        description: "3 companies whose advertising sets the bar in this category or the nearest bigger one (for a developer tool: the best-known developer and AI companies), with domain and X handle.",
        items: { type: "object", additionalProperties: false, required: ["name", "domain", "x_handle"], properties: { name: { type: "string" }, domain: { type: "string" }, x_handle: { type: "string" } } },
      },
      meta_queries: { type: "array", items: { type: "string" }, description: "2 short phrases (1-3 words) that find this category's image ads in Meta's ad library." },
      search_keywords: { type: "array", items: { type: "string" }, description: "2 high-intent Google searches a buyer of this category types (they show the paid search ads)." },
      case_study_queries: { type: "array", items: { type: "string" }, description: "2-3 web searches that find agency case studies or breakdowns of the best static ads in this category." },
      b2b: { type: "boolean", description: "true if the brand sells to businesses or developers." },
    },
  },
};

export async function planStatics(naive: NaiveClient | null, pack: ResearchPack, plan: ResearchPlan | null): Promise<StaticPlan> {
  const fallback = fallbackStaticPlan(pack, plan);
  if (!naive) return fallback;
  try {
    const reply = await naive.message({
      model: getSetting("planner_model"),
      max_tokens: 1500,
      system: "You plan advertising research for a creative team. Call the static_research_plan tool exactly once. Only give X handles and domains you are confident are the companies' real, official ones; leave a field empty rather than guess.",
      messages: [
        {
          role: "user",
          content: [
            `Brand: ${pack.brand.name} (${pack.domain})`,
            `What it is: ${pack.brand.description || pack.brand.slogan}`,
            `Category: ${plan?.category ?? pack.brand.industry}`,
            `Known competitors: ${(plan?.competitors ?? []).map((c) => `${c.name}${c.domain ? ` (${c.domain})` : ""}`).join(", ") || "unknown"}`,
            `Similar sites: ${pack.similar_sites.slice(0, 10).join(", ") || "unknown"}`,
          ].join("\n"),
        },
      ],
      tools: [PLAN_TOOL],
    });
    const call = reply.content.find((block) => block.type === "tool_use" && block.name === PLAN_TOOL.name);
    const raw = (call?.input ?? extractJson(reply.content.map((block) => block.text ?? "").join("\n"))) as Partial<StaticPlan> | null;
    return raw ? mergeStaticPlan(raw, fallback) : fallback;
  } catch {
    return fallback;
  }
}

const handle = (value: unknown) => {
  const h = text(value).replace(/^@/, "").replace(/^https?:\/\/(www\.)?(x|twitter)\.com\//i, "").replace(/[/?].*$/, "");
  return /^[A-Za-z0-9_]{1,15}$/.test(h) ? h : undefined;
};
const domainOf = (value: unknown) => {
  const d = text(value).replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "").toLowerCase();
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(d) ? d : undefined;
};

function companies(value: unknown, max: number) {
  return (Array.isArray(value) ? value : [])
    .map((entry) => record(entry))
    .filter((entry): entry is Record<string, unknown> => Boolean(entry && text(entry.name)))
    .slice(0, max)
    .map((entry) => ({ name: text(entry.name), domain: domainOf(entry.domain), x_handle: handle(entry.x_handle) }));
}

function mergeStaticPlan(raw: Partial<StaticPlan>, fallback: StaticPlan): StaticPlan {
  const strings = (value: unknown, max: number) => (Array.isArray(value) ? value.map(text).filter(Boolean).slice(0, max) : []);
  const competitors = companies(raw.competitors, 3);
  const leaders = companies(raw.leaders, 3);
  return {
    brand_handle: fallback.brand_handle,
    competitors: competitors.length ? competitors : fallback.competitors,
    leaders,
    meta_queries: strings(raw.meta_queries, 2).length ? strings(raw.meta_queries, 2) : fallback.meta_queries,
    search_keywords: strings(raw.search_keywords, 2).length ? strings(raw.search_keywords, 2) : fallback.search_keywords,
    case_study_queries: strings(raw.case_study_queries, 3).length ? strings(raw.case_study_queries, 3) : fallback.case_study_queries,
    b2b: typeof raw.b2b === "boolean" ? raw.b2b : fallback.b2b,
  };
}

export function fallbackStaticPlan(pack: ResearchPack, plan: ResearchPlan | null): StaticPlan {
  const category = plan?.category || pack.brand.industry || pack.brand.name;
  const x = pack.brand.socials.find((s) => /(^x$|twitter)/i.test(s.type) || /(x|twitter)\.com\//i.test(s.url));
  return {
    brand_handle: x ? (handle(x.url) ?? null) : null,
    competitors: (plan?.competitors ?? []).slice(0, 3).map((c) => ({ name: c.name, domain: domainOf(c.domain) })),
    leaders: [],
    meta_queries: [plan?.ads_query || category],
    search_keywords: [`best ${category}`],
    case_study_queries: [`${category} static ad case study`, `best ${category} ads examples`],
    b2b: /software|saas|developer|b2b|api|platform|enterprise/i.test(`${pack.brand.industry} ${pack.brand.description}`),
  };
}

// ---------- the fan-out ----------

export function staticSpecs(domain: string, plan: StaticPlan): RunSpec[] {
  const specs: RunSpec[] = [];
  const add = (key: string, label: string, provider: string, endpoint: string, input: RunSpec["input"]) => specs.push({ key, phase: "S", label, provider, endpoint, input });
  const metaImages = (key: string, label: string, query: string, exact: boolean) =>
    add(key, label, "anyapi", "/facebook.ads_search", { body: { query, mediaType: "IMAGE", status: "ACTIVE", sortBy: "impressions", country: "US", ...(exact ? { searchType: "keyword_exact_phrase" } : {}) } });

  plan.meta_queries.slice(0, 2).forEach((query, i) => metaImages(`s_meta_q${i}`, `Meta image ads: ${query}`, query, false));
  plan.competitors.slice(0, 3).forEach((c, i) => metaImages(`s_meta_c${i}`, `Meta image ads: ${c.name}`, c.name, true));
  plan.leaders.slice(0, 2).forEach((c, i) => metaImages(`s_meta_l${i}`, `Meta image ads: ${c.name}`, c.name, true));

  const handles = [
    ...(plan.brand_handle ? [{ h: plan.brand_handle, role: "b" }] : []),
    ...plan.competitors.filter((c) => c.x_handle).slice(0, 3).map((c) => ({ h: c.x_handle!, role: "c" })),
    ...plan.leaders.filter((c) => c.x_handle).slice(0, 3).map((c) => ({ h: c.x_handle!, role: "l" })),
  ];
  const seen = new Set<string>();
  for (const { h, role } of handles) {
    if (seen.has(h.toLowerCase())) continue;
    seen.add(h.toLowerCase());
    add(`s_x_${role}_${h.toLowerCase()}`, `X posts: @${h}`, "anyapi", "/twitter.user_tweets", { body: { handle: h, limit: 40 } });
  }

  const domains = [...plan.competitors.filter((c) => c.domain).slice(0, 2), ...plan.leaders.filter((c) => c.domain).slice(0, 1)];
  domains.forEach((c, i) => add(`s_gads_${i}`, `Google display ads: ${c.domain}`, "anyapi", "/google_ads.company_ads", { body: { domain: c.domain, format: "image", region: "US" } }));

  plan.search_keywords.slice(0, 2).forEach((q, i) => add(`s_serp_${i}`, `Google search ads: ${q}`, "litescrape", "/google/ads", { queryParams: { q, location: "United States", hl: "en", device: "desktop" } }));

  if (plan.b2b) plan.competitors.slice(0, 2).forEach((c, i) => add(`s_li_${i}`, `LinkedIn ads: ${c.name}`, "anyapi", "/linkedin.ads_search", { body: { company: c.name } }));

  if (plan.case_study_queries.length) {
    add("s_cases", "Agency case studies", "parallel", "/search", {
      body: {
        objective: "Find agency case studies, creative-analytics reports and breakdowns of the best-performing static image ads for this category, with their results (CTR, CPA, ROAS) and what the creative looked like.",
        search_queries: plan.case_study_queries.slice(0, 3),
        mode: "basic",
        max_chars_total: 12000,
      },
    });
  }
  add("s_shot", "Screenshot of the brand's site", "context.dev", "/web/screenshot", { queryParams: { domain, handleCookiePopup: true, waitForMs: 2500 } });
  return specs;
}

// ---------- compaction ----------

type RunResult = { key: string; status: string; output: unknown };

export function compactStatics(runs: RunResult[], plan: StaticPlan, now = Date.now()): StaticResearch {
  const out = (key: string) => runs.find((run) => run.key === key && run.status === "done")?.output;
  const competitorNames = plan.competitors.map((c) => c.name);
  const leaderNames = plan.leaders.map((c) => c.name);
  const ads: StaticAd[] = [];

  for (const run of runs.filter((r) => r.status === "done" && r.key.startsWith("s_meta_"))) {
    const role: StaticAd["role"] = run.key.startsWith("s_meta_c") ? "competitor" : run.key.startsWith("s_meta_l") ? "leader" : "category";
    const wanted = role === "competitor" ? competitorNames[Number(run.key.slice(8))] : role === "leader" ? leaderNames[Number(run.key.slice(8))] : null;
    items(run.output).forEach((item, rank) => {
      const media = (Array.isArray(item.media) ? item.media : []).map(record).filter(Boolean) as Array<Record<string, unknown>>;
      const image = media.map((m) => text(m.url) || text(m.imageUrl)).find((u) => /^https:\/\//.test(u)) ?? null;
      const advertiser = pick(item, ["pageName", "advertiser", "page_name"]);
      // A name search also returns other advertisers mentioning the name; keep those as category ads.
      const owned = !wanted || sameName(advertiser, wanted);
      const started = epoch(item.startDate);
      const days = started ? Math.max(0, Math.round((now - started) / DAY)) : null;
      const variants = num(item, ["adCount"]);
      const score = 0.5 / (1 + rank * 0.25) + 0.35 * Math.min(1, (days ?? 0) / 60) + 0.15 * Math.min(1, Math.max(0, (variants ?? 1) - 1) / 4);
      ads.push({
        id: `meta-${pick(item, ["id", "adArchiveId"]) || `${run.key}-${rank}`}`,
        source: "meta",
        role: owned ? role : "category",
        advertiser,
        image,
        text: pick(item, ["text", "body"]).slice(0, 400),
        headline: pick(item, ["title", "linkDescription"]).slice(0, 120),
        cta: pick(item, ["ctaText"]),
        url: pick(item, ["sourceUrl"]) || (pick(item, ["id"]) ? `https://www.facebook.com/ads/library/?id=${pick(item, ["id"])}` : ""),
        started: started ? new Date(started).toISOString().slice(0, 10) : null,
        days,
        variants,
        rank: rank + 1,
        views: null,
        engagement: null,
        score: round(score),
        signal: [`#${rank + 1} by impressions`, days !== null ? `running ${days} days` : null, variants && variants > 1 ? `${variants} versions` : null].filter(Boolean).join(" · "),
      });
    });
  }

  for (const run of runs.filter((r) => r.status === "done" && r.key.startsWith("s_x_"))) {
    const role: StaticAd["role"] = run.key.startsWith("s_x_b_") ? "brand" : run.key.startsWith("s_x_c_") ? "competitor" : "leader";
    const tweets = items(run.output).filter((t) => !t.isReply);
    const maxViews = Math.max(1, ...tweets.map((t) => num(t, ["views"]) ?? 0));
    for (const t of tweets) {
      const media = (Array.isArray(t.media) ? t.media : []).map(record).filter(Boolean) as Array<Record<string, unknown>>;
      const photo = media.find((m) => text(m.type).toLowerCase() === "photo");
      if (!photo) continue;
      const views = num(t, ["views"]);
      const interactions = (num(t, ["likes"]) ?? 0) + (num(t, ["retweets"]) ?? 0) + (num(t, ["bookmarks"]) ?? 0) + (num(t, ["quotes"]) ?? 0);
      const engagement = views ? interactions / views : null;
      const created = epoch(t.createdUtc);
      const score = 0.6 * Math.sqrt((views ?? 0) / maxViews) + 0.4 * Math.min(1, (engagement ?? 0) / 0.02);
      ads.push({
        id: `x-${pick(t, ["id"])}`,
        source: "x",
        role,
        advertiser: `@${pick(t, ["authorHandle"])}`,
        image: text(photo.url) || null,
        text: pick(t, ["text"]).slice(0, 400),
        headline: "",
        cta: "",
        url: pick(t, ["url"]),
        started: created ? new Date(created).toISOString().slice(0, 10) : null,
        days: created ? Math.round((now - created) / DAY) : null,
        variants: null,
        rank: 0,
        views,
        engagement,
        score: round(score),
        signal: [views !== null ? `${compactNumber(views)} views` : null, engagement !== null ? `${(engagement * 100).toFixed(1)}% engagement` : null].filter(Boolean).join(" · "),
      });
    }
  }

  for (const run of runs.filter((r) => r.status === "done" && r.key.startsWith("s_gads_"))) {
    items(run.output).forEach((item, rank) => {
      const first = Date.parse(text(item.firstShown));
      const last = Date.parse(text(item.lastShown));
      const days = Number.isFinite(first) && Number.isFinite(last) ? Math.max(1, Math.round((last - first) / DAY)) : null;
      const live = Number.isFinite(last) && now - last < 4 * DAY;
      ads.push({
        id: `google-${pick(item, ["creativeId"]) || `${run.key}-${rank}`}`,
        source: "google",
        role: "competitor",
        advertiser: pick(item, ["advertiserName", "domain"]),
        image: pick(item, ["imageUrl"]) || null,
        text: "",
        headline: "",
        cta: "",
        url: pick(item, ["adUrl"]),
        started: Number.isFinite(first) ? new Date(first).toISOString().slice(0, 10) : null,
        days,
        variants: null,
        rank: rank + 1,
        views: null,
        engagement: null,
        score: round(0.3 + 0.5 * Math.min(1, (days ?? 0) / 90) + (live ? 0.2 : 0)),
        signal: [days !== null ? `shown over ${days} days` : null, live ? "still running" : null].filter(Boolean).join(" · "),
      });
    });
  }

  for (const run of runs.filter((r) => r.status === "done" && r.key.startsWith("s_li_"))) {
    items(run.output).forEach((item, rank) => {
      const started = Date.parse(text(item.startDate));
      const impressions = num(item, ["totalImpressions"]);
      ads.push({
        id: `linkedin-${pick(item, ["id"]) || `${run.key}-${rank}`}`,
        source: "linkedin",
        role: "competitor",
        advertiser: pick(item, ["advertiser"]),
        image: null,
        text: pick(item, ["description"]).slice(0, 400),
        headline: pick(item, ["headline"]).slice(0, 160),
        cta: pick(item, ["cta"]),
        url: pick(item, ["url"]),
        started: Number.isFinite(started) ? new Date(started).toISOString().slice(0, 10) : null,
        days: Number.isFinite(started) ? Math.round((now - started) / DAY) : null,
        variants: null,
        rank: rank + 1,
        views: impressions,
        engagement: null,
        score: round(0.4 / (1 + rank * 0.25) + 0.3),
        signal: impressions ? `${compactNumber(impressions)} impressions` : `#${rank + 1} in LinkedIn's ad library`,
      });
    });
  }

  const search_ads = runs
    .filter((r) => r.status === "done" && r.key.startsWith("s_serp_"))
    .flatMap((run) => {
      const keyword = plan.search_keywords[Number(run.key.slice(7))] ?? "";
      const list = record(run.output)?.ads ?? record(record(run.output)?.data)?.ads;
      return (Array.isArray(list) ? list : items(run.output)).map(record).filter(Boolean).map((item) => {
        const ad = item as Record<string, unknown>;
        return {
          keyword,
          advertiser: pick(ad, ["displayed_link", "displayedLink", "source", "domain"]) || domainOf(pick(ad, ["link", "url"])) || "",
          title: pick(ad, ["title"]),
          description: pick(ad, ["description", "snippet", "text"]).slice(0, 200),
          url: pick(ad, ["link", "url"]),
        };
      });
    })
    .filter((ad) => ad.title)
    .slice(0, 16);

  const cases = items(out("s_cases"))
    .map((item) => ({
      title: pick(item, ["title"]),
      url: pick(item, ["url", "link"]),
      excerpt: (Array.isArray(item.excerpts) ? item.excerpts.map(text).join(" ") : pick(item, ["excerpt", "snippet", "content"])).replace(/\s+/g, " ").slice(0, 900),
    }))
    .filter((c) => c.title && c.url)
    .slice(0, 8);

  const shot = record(out("s_shot"));
  const screenshot = text(shot?.screenshot) || collectStrings(out("s_shot"), ["screenshot", "url"]).find((u) => /^https:\/\/.+\.(png|jpe?g|webp)/i.test(u)) || null;

  const unique = new Map<string, StaticAd>();
  for (const ad of ads.sort((a, b) => b.score - a.score)) {
    const key = ad.image ? ad.image.split("?")[0] : ad.id;
    if (!unique.has(key)) unique.set(key, ad);
  }
  const statics = runs.filter((r) => r.key.startsWith("s_"));
  return {
    plan,
    ads: [...unique.values()].slice(0, 80),
    search_ads,
    cases,
    screenshot,
    sources: { done: statics.filter((r) => r.status === "done").length, total: statics.length },
  };
}

/**
 * Up to `max` ads with pictures for the vision study: the best of each source and role, with no
 * advertiser taking more than three places, so the study sees the category and not one brand.
 */
export function studySet(research: StaticResearch, max = 11): StaticAd[] {
  const withImage = research.ads.filter((ad) => ad.image);
  const picked: StaticAd[] = [];
  const per = new Map<string, number>();
  const take = (ad: StaticAd) => {
    const count = per.get(ad.advertiser.toLowerCase()) ?? 0;
    if (count >= 3 || picked.includes(ad) || picked.length >= max) return;
    per.set(ad.advertiser.toLowerCase(), count + 1);
    picked.push(ad);
  };
  // The brand's own best two, then the best of every role and source, then the rest by score.
  withImage.filter((ad) => ad.role === "brand").slice(0, 2).forEach(take);
  for (const role of ["competitor", "leader", "category"] as const) for (const source of ["meta", "x", "google"] as const) withImage.filter((ad) => ad.role === role && ad.source === source).slice(0, 2).forEach(take);
  withImage.forEach(take);
  return picked;
}

function sameName(a: string, b: string) {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const x = norm(a);
  const y = norm(b);
  return Boolean(x && y && (x.includes(y) || y.includes(x)));
}

function epoch(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value < 1e12 ? value * 1000 : value;
  const parsed = Date.parse(text(value));
  return Number.isFinite(parsed) ? parsed : null;
}

const round = (n: number) => Math.round(n * 1000) / 1000;
const compactNumber = (n: number) => Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(n);
