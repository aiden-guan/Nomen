import type { BrandView } from "../api";

// A demo camp at /camp/demo: a made-up brand going through every stage in about a minute and a
// half, so the camp can be seen without keys or spending. It is labeled as a demo everywhere it
// shows, and it builds the same BrandView the core's API returns, so every view of the camp is
// exercised exactly as with a real campaign.

export const DEMO_ID = "demo";
export const DEMO_SECONDS = 96;

const RUNS_A = ["brand", "site", "similar", "seo_rating", "seo_keywords"];
const RUNS_C = ["tiktok_brand", "tiktok_0", "tiktok_1", "reels", "shorts", "tiktok_ads", "meta_ads_brand", "meta_ads_0", "reddit", "aeo_chatgpt", "aeo_perplexity"];

const CONCEPTS = [
  { title: "The ten-second hand wash", angle: "product demo", hook: "“Watch how fast this lathers.”" },
  { title: "Bathroom shelf glow-up", angle: "day-in-the-life", hook: "“I replaced five bottles with one bar.”" },
  { title: "What's actually in it", angle: "myth-busting", hook: "“Three ingredients. I counted.”" },
  { title: "First wash, honest take", angle: "first reaction", hook: "“Okay, the smell is unreal.”" },
];

type Clock = (t: number) => number;
/** 0 before `a`, 1 after `b`, linear between. */
const between: (a: number, b: number) => Clock = (a, b) => (t) => Math.max(0, Math.min(1, (t - a) / (b - a)));

export function demoView(t: number): BrandView {
  const research = t < 20;
  const stage = t < 20 ? "research" : t < 28 ? "style" : t < 37 ? "strategy" : t < 66 ? "production" : t < 82 ? "review" : "live";
  const stageIndex = ["research", "style", "strategy", "production", "review", "live"].indexOf(stage);
  const status = stage === "review" ? "review" : stage === "live" ? (t < 88 ? "publishing" : "live") : "running";

  const runs = [...RUNS_A, ...RUNS_C].map((key, i) => {
    const phaseA = i < RUNS_A.length;
    const start = phaseA ? 1 + i * 0.6 : 7 + (i - RUNS_A.length) * 0.9;
    const done = start + (phaseA ? 2.2 : 4 + (i % 3) * 1.5);
    const failed = key === "aeo_perplexity";
    const s = t < start ? "pending" : t < done ? "running" : failed ? "failed" : "done";
    return { key, phase: phaseA ? "A" : "C", provider: phaseA ? "context.dev" : "anyapi", endpoint: "/demo", status: phaseA && t < 7 && s === "pending" ? "pending" : s, error: s === "failed" ? "provider HTTP 502" : null, cost_micro: s === "done" ? 20000 : 0, cost: s === "done" ? 0.02 : 0 };
  }).filter((run) => run.phase === "A" || t >= 6.5);

  const creatives =
    stageIndex < 3
      ? []
      : CONCEPTS.map((concept, idx) => {
          const begin = 37 + idx * 2.5;
          const frames = between(begin, begin + 5)(t);
          const render = between(begin + 5, begin + 17)(t);
          const qc = between(begin + 17, begin + 21)(t);
          const shot = (n: number) => {
            const offset = (n - 1) * 0.35;
            const status =
              frames <= offset ? "pending" : render <= offset ? "framed" : render < 1 - (n - 1) * 0.2 ? "rendering" : qc < 0.5 + offset / 2 ? "rendered" : "passed";
            const qcScore = status === "passed" ? 8 + ((idx + n) % 2) : null;
            return { n, status, provider: status === "rendering" || status === "rendered" || status === "passed" ? "naive" : null, renders: status === "pending" || status === "framed" ? 0 : 1, frameUrl: null, qc: qcScore ? { score: qcScore, pass: true, issues: [], fix_prompt: "" } : null, error: null };
          };
          const shots = [shot(1), shot(2)];
          const ready = shots.every((s) => s.status === "passed");
          return {
            id: `crv_demo${idx}`,
            idx,
            generation: 1,
            status: t < begin ? "queued" : ready ? "ready" : "producing",
            concept: { ...concept, format: "UGC", platforms: ["tiktok", "instagram"], creator: "", setting: "", shots: [], reference_images: [], caption: "", hashtags: [], cta: "", inspired_by: [], why: "" },
            caption: `${concept.hook} #oliveoilsoap #selfcare`,
            platforms: ["tiktok", "instagram"],
            approved: t > 76 + idx,
            videoUrl: null,
            posterUrl: ready ? demoPoster(idx) : null,
            qcScore: ready ? 8 : null,
            cost: Math.round(render * 640) / 100,
            error: null,
            continuity: null,
            shots,
          };
        });

  const posts =
    stage === "live"
      ? CONCEPTS.map((_, i) => ({
          id: `pst_demo${i}`,
          creativeId: `crv_demo${i}`,
          platforms: ["tiktok", "instagram"],
          scheduledAt: i === 0 ? null : new Date(Date.now() + i * 86_400_000).toISOString(),
          status: i === 0 ? (t < 88 ? "processing" : "posted") : "scheduled",
          error: null,
          analytics: i === 0 && t >= 88 ? { views: 1240, likes: 96 } : null,
        }))
      : [];

  const events: Array<{ at: number; message: string; level?: string }> = [
    { at: 0, message: "Campaign started: 4 videos, 2 shots each, google/veo-3.1" },
    { at: 5.5, message: "Research plan: olive oil soap; competitors Dr. Bronner's, Savon de Marseille; searching olive oil soap review, natural soap haul" },
    { at: 19, message: "Research done: 24 top videos, 12 live ads, 10 Reddit threads, 18 keywords (15/16 sources)" },
    { at: 21, message: "Studying the format of 3 top-performing videos" },
    { at: 27.5, message: "Format study ready (skill nomen-style-demo@1)" },
    { at: 29, message: "The strategist is writing the brand brief and 4 concepts" },
    { at: 36.5, message: 'Campaign "Clean Hands, Short Story": 4 concepts, now producing' },
    { at: 52, message: 'QC sent "What\'s actually in it" shot 1 back (6/10): the bar\'s label is garbled' },
    { at: 59, message: '"The ten-second hand wash" is ready (QC 8/10)' },
    { at: 65.5, message: "4 of 4 videos are ready for review" },
    { at: 81.5, message: "Queued 4 posts one per day" },
    { at: 88, message: "Post submitted: tiktok, instagram" },
  ];
  const now = Date.now();
  const visible = events.filter((e) => e.at <= t).reverse();

  const view = {
    brand: { id: DEMO_ID, name: "Olive & Ash (demo)", domain: "oliveandash.example", url: "https://oliveandash.example", profile: { name: "Olive & Ash", description: "", slogan: "", industry: "Personal care", colors: ["#647247", "#ead6ad"], logo: null, socials: [], images: [] }, connected: true },
    campaign: {
      id: "cmp_demo",
      status,
      stage,
      stageIndex,
      error: null,
      naiveOut: false,
      options: { concepts: 4, shotsPerConcept: 2, secondsPerShot: 8, videoModel: "google/veo-3.1", learnStyle: true },
      estimateUsd: 25.6,
      plan: t >= 5.5 ? { brand_name: "Olive & Ash", category: "olive oil soap", audience: "People who read the back of the bottle", competitors: [{ name: "Dr. Bronner's" }, { name: "Savon de Marseille" }], content_queries: ["olive oil soap review", "natural soap haul"], ads_query: "natural soap", reddit_query: "best olive oil soap", aeo_prompts: [] } : null,
      research: research ? null : { domain: "", brand: {}, site_excerpt: "", similar_sites: [], seo: { domain_rating: 41, keywords: Array(18).fill({}) }, videos: Array(24).fill({}), ads: Array(12).fill({}), reddit: Array(10).fill({}), aeo: [] },
      style: t >= 27.5 ? { slug: "nomen-style-demo", version: 1, skill_md: "", samples: ["a", "b", "c"] } : null,
      strategy:
        t >= 36.5
          ? {
              brand: { name: "Olive & Ash", one_liner: "Olive & Ash: a three-ingredient olive oil bar.", category: "olive oil soap", value_props: [], tone: "Calm, a little funny, never preachy", visual_style: "", product_look: "", proof_points: [] },
              audience: [{ name: "Label readers", description: "", pains: [], motivations: [] }, { name: "Shelf minimalists", description: "", pains: [], motivations: [] }],
              competitors: [],
              content_patterns: [],
              search: { seo_keywords: [], seo_actions: [], aeo_status: "", aeo_actions: [], geo_actions: [] },
              campaign: { name: "Clean Hands, Short Story", objective: "Get people to try one bar instead of five bottles.", concepts: CONCEPTS, posting_plan: { cadence: "One video a day for four days", best_times: [], notes: "" } },
            }
          : null,
      runs,
      creatives,
      posts,
      spend: { naive: Math.min(14.8, Math.max(0, t - 29) * 0.4), monid: Math.min(0.48, t * 0.03), style: 0.6, strategy: 0.9 },
      createdAt: new Date(now - t * 1000).toISOString(),
    },
    campaigns: [],
    events: visible.map((e) => ({ ts: new Date(now - (t - e.at) * 1000).toISOString(), level: e.level ?? "info", message: e.message })),
  };
  return view as unknown as BrandView;
}

const posters = new Map<number, string>();

/** A small painted still for each demo video: a sky, a person, the product. */
function demoPoster(i: number) {
  const cached = posters.get(i);
  if (cached || typeof document === "undefined") return cached ?? null;
  const canvas = document.createElement("canvas");
  canvas.width = 90;
  canvas.height = 160;
  const ctx = canvas.getContext("2d")!;
  const skies = ["#f2c4a0", "#b0d6dc", "#ecdeb4", "#dcbee6"];
  const shirts = ["#3c5078", "#7a2a22", "#2d7b98", "#647247"];
  ctx.fillStyle = skies[i % 4];
  ctx.fillRect(0, 0, 90, 100);
  ctx.fillStyle = "#d6ba8c";
  ctx.fillRect(0, 100, 90, 60);
  ctx.fillStyle = "#c98e5c";
  ctx.beginPath();
  ctx.arc(40, 58, 18, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = shirts[i % 4];
  ctx.fillRect(18, 76, 44, 54);
  ctx.fillStyle = "#97a052";
  ctx.fillRect(58, 84, 20, 14);
  ctx.fillStyle = "#faf7ee";
  ctx.fillRect(61, 88, 14, 6);
  const url = canvas.toDataURL();
  posters.set(i, url);
  return url;
}
