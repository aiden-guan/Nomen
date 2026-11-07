import type { ResearchPack } from "./research";

// The strategist's contract: the JSON Schema Naive enforces on the session, and the types it fills.

export type Shot = { seconds: number; frame_prompt: string; video_prompt: string; dialogue: string };

export type Concept = {
  title: string;
  format: string;
  angle: string;
  platforms: string[];
  hook: string;
  creator: string;
  setting: string;
  shots: Shot[];
  reference_images: string[];
  caption: string;
  hashtags: string[];
  cta: string;
  inspired_by: string[];
  why: string;
};

export type Strategy = {
  brand: { name: string; one_liner: string; category: string; value_props: string[]; tone: string; visual_style: string; product_look: string; proof_points: string[] };
  audience: Array<{ name: string; description: string; pains: string[]; motivations: string[] }>;
  competitors: Array<{ name: string; positioning: string; what_works: string }>;
  content_patterns: Array<{ pattern: string; why_it_works: string; examples: string[] }>;
  search: { seo_keywords: Array<{ keyword: string; intent: string; priority: string }>; seo_actions: string[]; aeo_status: string; aeo_actions: string[]; geo_actions: string[] };
  campaign: { name: string; objective: string; concepts: Concept[]; posting_plan: { cadence: string; best_times: string[]; notes: string } };
};

export const PLATFORMS = ["tiktok", "instagram", "youtube", "x", "facebook", "linkedin", "threads"] as const;

const str = { type: "string" };
const strs = { type: "array", items: str };

export const STRATEGY_SCHEMA = {
  type: "object",
  required: ["brand", "audience", "competitors", "content_patterns", "search", "campaign"],
  properties: {
    brand: {
      type: "object",
      required: ["name", "one_liner", "category", "value_props", "tone", "visual_style", "product_look", "proof_points"],
      properties: { name: str, one_liner: str, category: str, value_props: strs, tone: str, visual_style: str, product_look: str, proof_points: strs },
    },
    audience: {
      type: "array",
      items: { type: "object", required: ["name", "description", "pains", "motivations"], properties: { name: str, description: str, pains: strs, motivations: strs } },
    },
    competitors: { type: "array", items: { type: "object", required: ["name", "positioning", "what_works"], properties: { name: str, positioning: str, what_works: str } } },
    content_patterns: {
      type: "array",
      items: { type: "object", required: ["pattern", "why_it_works", "examples"], properties: { pattern: str, why_it_works: str, examples: strs } },
    },
    search: {
      type: "object",
      required: ["seo_keywords", "seo_actions", "aeo_status", "aeo_actions", "geo_actions"],
      properties: {
        seo_keywords: { type: "array", items: { type: "object", required: ["keyword", "intent", "priority"], properties: { keyword: str, intent: str, priority: str } } },
        seo_actions: strs,
        aeo_status: str,
        aeo_actions: strs,
        geo_actions: strs,
      },
    },
    campaign: {
      type: "object",
      required: ["name", "objective", "concepts", "posting_plan"],
      properties: {
        name: str,
        objective: str,
        concepts: {
          type: "array",
          items: {
            type: "object",
            required: ["title", "format", "angle", "platforms", "hook", "creator", "setting", "shots", "reference_images", "caption", "hashtags", "cta", "inspired_by", "why"],
            properties: {
              title: str,
              format: str,
              angle: str,
              platforms: { type: "array", items: { type: "string", enum: [...PLATFORMS] } },
              hook: str,
              creator: str,
              setting: str,
              shots: {
                type: "array",
                items: { type: "object", required: ["seconds", "frame_prompt", "video_prompt", "dialogue"], properties: { seconds: { type: "integer" }, frame_prompt: str, video_prompt: str, dialogue: str } },
              },
              reference_images: strs,
              caption: str,
              hashtags: strs,
              cta: str,
              inspired_by: strs,
              why: str,
            },
          },
        },
        posting_plan: { type: "object", required: ["cadence", "best_times", "notes"], properties: { cadence: str, best_times: strs, notes: str } },
      },
    },
  },
} as const;

export type StrategyOptions = { concepts: number; shotsPerConcept: number; secondsPerShot: number; videoModel: string };

/** The first message of a strategist session: the brief, the research and the house rules for this run. */
export function strategyMessage(pack: ResearchPack, style: { skill_md: string } | null, options: StrategyOptions) {
  const research = {
    domain: pack.domain,
    brand: pack.brand,
    site_excerpt: pack.site_excerpt,
    similar_sites: pack.similar_sites,
    seo: pack.seo,
    top_videos: pack.videos.slice(0, 16).map(({ source, thumbnail, ...video }) => video),
    ads: pack.ads.slice(0, 12),
    reddit: pack.reddit.slice(0, 10),
    aeo: pack.aeo,
  };
  return [
    `Build the campaign for ${pack.brand.name || pack.domain}.`,
    `Deliver exactly ${options.concepts} concepts. Each concept has ${options.shotsPerConcept} shots of ${options.secondsPerShot} seconds; shots are rendered separately by ${options.videoModel} (vertical 9:16, native audio) and cut together in order.`,
    `Product images you may list in reference_images (use only these URLs, copied exactly): ${JSON.stringify(pack.brand.images.slice(0, 8))}`,
    style?.skill_md
      ? `A format study of the best-performing short videos in this category follows. Use its structure, pacing and hooks; never copy its people, script or branding.\n<format_study>\n${style.skill_md.slice(0, 9000)}\n</format_study>`
      : "No format study is available for this run; derive the format from the top videos in the research.",
    `Research (collected today from public sources):\n<research>\n${JSON.stringify(research)}\n</research>`,
  ].join("\n\n");
}

/** Trims what the model returned to what production can render: shot counts, word budgets, platforms. */
export function normalizeStrategy(raw: unknown, options: StrategyOptions, pack: ResearchPack): Strategy {
  const strategy = raw as Strategy;
  const allowedImages = new Set(pack.brand.images);
  strategy.campaign.concepts = (strategy.campaign.concepts ?? []).slice(0, options.concepts).map((concept) => ({
    ...concept,
    platforms: (concept.platforms ?? []).filter((p): p is (typeof PLATFORMS)[number] => (PLATFORMS as readonly string[]).includes(p)).slice(0, 4),
    shots: (concept.shots ?? []).slice(0, Math.max(1, options.shotsPerConcept)).map((shot) => ({ ...shot, seconds: options.secondsPerShot })),
    reference_images: (concept.reference_images ?? []).filter((url) => allowedImages.has(url)).slice(0, 3),
    hashtags: (concept.hashtags ?? []).map((tag) => tag.replace(/^#?/, "#").replace(/\s+/g, "")).slice(0, 6),
  }));
  for (const concept of strategy.campaign.concepts) {
    if (concept.platforms.length === 0) concept.platforms = ["tiktok", "instagram", "youtube"];
  }
  return strategy;
}

export function captionFor(concept: Concept) {
  const tags = concept.hashtags.join(" ");
  return [concept.caption.trim(), tags].filter(Boolean).join("\n\n");
}
