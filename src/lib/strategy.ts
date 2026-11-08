import type { ResearchPack } from "./research";
import type { CreativeBrief, ProductBrief, ProductionPlan, ReferenceBreakdown, Script, VideoFormat } from "./creative/types";

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
  /** Creative engine: the director's brief, the script room's script and the shot plan behind this video. */
  brief?: CreativeBrief;
  script?: Script;
  plan?: ProductionPlan;
  reference?: { id: string; url: string; author: string; views: number; followers: number | null; outlier: number | null; format: string; hook_mechanic: string };
};

export type Strategy = {
  brand: { name: string; one_liner: string; category: string; value_props: string[]; tone: string; visual_style: string; product_look: string; proof_points: string[] };
  audience: Array<{ name: string; description: string; pains: string[]; motivations: string[] }>;
  competitors: Array<{ name: string; positioning: string; what_works: string }>;
  content_patterns: Array<{ pattern: string; why_it_works: string; examples: string[] }>;
  search: { seo_keywords: Array<{ keyword: string; intent: string; priority: string }>; seo_actions: string[]; aeo_status: string; aeo_actions: string[]; geo_actions: string[] };
  campaign: {
    name: string;
    objective: string;
    /** The videos once scripted and planned (filled by the script room after the director's briefs). */
    concepts: Concept[];
    /** The creative director's briefs, one per video. */
    briefs?: CreativeBrief[];
    posting_plan: { cadence: string; best_times: string[]; notes: string };
    /** How many times the script room has run, so a model that keeps fumbling cannot loop forever. */
    script_rounds?: number;
  };
};

export const FORMATS: VideoFormat[] = ["talking_head_broll", "split_screen", "presenter_inset", "voiceover_demo", "text_story"];

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
      required: ["name", "objective", "briefs", "posting_plan"],
      properties: {
        name: str,
        objective: str,
        briefs: {
          type: "array",
          items: {
            type: "object",
            required: ["title", "reference_id", "format", "angle", "audience", "hook_plan", "keep", "change", "visuals", "creator", "setting", "platforms", "caption", "hashtags", "cta", "why"],
            properties: {
              title: str,
              reference_id: { type: "string", description: "The id of the reference video this one remakes (from <references>)." },
              format: { type: "string", enum: ["talking_head_broll", "split_screen", "presenter_inset", "voiceover_demo", "text_story"] },
              angle: str,
              audience: str,
              hook_plan: { type: "string", description: "The reference's hook mechanic restated for this product: what is said, shown and written in the first 2-3 seconds." },
              keep: strs,
              change: strs,
              visuals: { type: "array", items: str, description: "Product visual ids (from <visuals>) to show, most important first." },
              creator: { type: "string", description: "Formats with a face: one specific, ordinary-looking person (age range, look, hair, wardrobe, energy). Empty for voiceover_demo and text_story." },
              setting: { type: "string", description: "One real place with time of day and light. Empty for formats without a face." },
              platforms: { type: "array", items: { type: "string", enum: [...PLATFORMS] } },
              caption: str,
              hashtags: strs,
              cta: str,
              why: { type: "string", description: "Why this reference and format will work for this product and buyer, citing the reference's numbers." },
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
export type PastResult = { title: string; format: string; hook: string; platforms: string[]; status: string; analytics: Record<string, unknown> | null };

/** What the director sees of a reference: its numbers, mechanics and beats, not its raw transcript. */
export function referenceDigest(breakdowns: ReferenceBreakdown[]) {
  return breakdowns.map((ref) => ({
    id: ref.id,
    url: ref.url,
    platform: ref.platform,
    author: ref.author,
    views: ref.views,
    followers: ref.followers,
    views_per_follower: ref.outlier,
    seconds: ref.duration,
    format: ref.format,
    hook: ref.hook,
    beats: ref.beats.map((beat) => ({ t: `${beat.start.toFixed(1)}-${beat.end.toFixed(1)}s`, job: beat.job, shot: beat.shot, visual: beat.visual, text: beat.on_screen_text, line: beat.line })),
    pacing: ref.pacing,
    delivery: ref.delivery,
    why_it_works: ref.why_it_works,
    fit_for_this_brand: ref.fit,
  }));
}

export function strategyMessage(
  pack: ResearchPack,
  creative: { product: ProductBrief; breakdowns: ReferenceBreakdown[] },
  options: StrategyOptions,
  past: PastResult[] = [],
) {
  const research = {
    domain: pack.domain,
    brand: pack.brand,
    site_excerpt: pack.site_excerpt.slice(0, 3000),
    similar_sites: pack.similar_sites,
    seo: pack.seo,
    ads: pack.ads.slice(0, 10),
    reddit: pack.reddit.slice(0, 8),
    aeo: pack.aeo,
  };
  const { product, breakdowns } = creative;
  return [
    `Build the campaign for ${product.name || pack.brand.name || pack.domain}.`,
    `Deliver exactly ${options.concepts} video briefs. Each brief remakes one of the viral reference videos below for this product, as closely as possible: the same hook, beats, wording, timing, shots and on-screen text, with an AI presenter of the same kind in the same kind of setting, and only the product-specific parts changed. Pick the references with the best mix of proof (views far above the account's followers, or raw virality for a famous benchmark like Cluely or MrBeast) and fit for this product. Give the briefs different styles, not just different references: mix the lanes (a competitor's winning format, a niche breakout, a famous viral hook) and the formats, so the campaign tests several ways to win.`,
    breakdowns.length
      ? `Reference videos, broken down beat by beat from their transcripts and frames:\n<references>\n${JSON.stringify(referenceDigest(breakdowns))}\n</references>`
      : "No reference videos could be broken down for this run. Base each brief on the strongest patterns in the research and set reference_id to an empty string.",
    `The product brief (the only source of claims):\n<product>\n${JSON.stringify({ ...product, visuals: undefined })}\n</product>`,
    product.visuals.length
      ? `Real product visuals that can be on screen (refer to them by id):\n<visuals>\n${JSON.stringify(product.visuals.map(({ id, kind, caption, source }) => ({ id, kind, caption, source })))}\n</visuals>`
      : "There are no product visuals for this brand: choose formats where the creator carries the video (talking_head_broll with creator beats only).",
    `Formats: talking_head_broll (a creator talks to camera; the edit cuts to the product while they keep talking), split_screen (creator on top, product underneath), presenter_inset (product graphics full screen with the presenter in a small rounded window, the look of most viral dev-tool tutorials), voiceover_demo (no face: product on screen, a voice-over and captions), text_story (no face: product on screen with large text). Match the reference's format where you can. Videos with a face cost about $0.40 per second to render; faceless formats cost almost nothing, so use them when the reference is faceless or the product is software that shows well on screen.`,
    `Research for the brand brief and the search plan (collected today from public sources):\n<research>\n${JSON.stringify(research)}\n</research>`,
    ...(past.length
      ? [`How this brand's earlier Nomen videos performed on its own accounts (repeat what worked, drop what did not, do not reuse the same hooks):\n<past_results>\n${JSON.stringify(past)}\n</past_results>`]
      : []),
  ].join("\n\n");
}

/** Trims the director's answer to what the script room can use: known references, formats, visuals, platforms. */
export function normalizeStrategy(raw: unknown, options: StrategyOptions, context: { referenceIds: string[]; visualIds: string[] }): Strategy {
  const strategy = raw as Strategy & { campaign: { briefs?: Array<Partial<CreativeBrief>> } };
  const references = new Set(context.referenceIds);
  const visuals = new Set(context.visualIds);
  const list = (value: unknown) => (Array.isArray(value) ? value.filter((v): v is string => typeof v === "string" && v.trim() !== "").map((v) => v.trim()) : []);
  const briefs: CreativeBrief[] = (strategy.campaign.briefs ?? []).slice(0, options.concepts).map((brief, i) => {
    const format = FORMATS.includes(brief.format as VideoFormat) ? (brief.format as VideoFormat) : "talking_head_broll";
    const reference = typeof brief.reference_id === "string" && references.has(brief.reference_id) ? brief.reference_id : (context.referenceIds[i % Math.max(1, context.referenceIds.length)] ?? "");
    const platforms = list(brief.platforms).filter((p): p is (typeof PLATFORMS)[number] => (PLATFORMS as readonly string[]).includes(p)).slice(0, 4);
    return {
      title: (brief.title ?? `Video ${i + 1}`).toString().trim(),
      reference_id: reference,
      format,
      angle: (brief.angle ?? "").toString(),
      audience: (brief.audience ?? "").toString(),
      hook_plan: (brief.hook_plan ?? "").toString(),
      keep: list(brief.keep),
      change: list(brief.change),
      visuals: list(brief.visuals).filter((id) => visuals.has(id)),
      creator: (brief.creator ?? "").toString(),
      setting: (brief.setting ?? "").toString(),
      platforms: platforms.length ? platforms : ["tiktok", "instagram", "youtube"],
      caption: (brief.caption ?? "").toString(),
      hashtags: list(brief.hashtags).map((tag) => tag.replace(/^#?/, "#").replace(/\s+/g, "")).slice(0, 6),
      cta: (brief.cta ?? "").toString(),
      why: (brief.why ?? "").toString(),
    };
  });
  strategy.campaign.briefs = briefs;
  strategy.campaign.concepts = [];
  return strategy;
}

/** One finished concept: the brief, its script and its shot plan, in the shape production and the UI read. */
export function conceptFrom(brief: CreativeBrief, script: Script, plan: ProductionPlan, reference: ReferenceBreakdown | undefined, product: ProductBrief): Concept {
  const hook = script.beats[0];
  const productPhotos = product.kind === "physical" ? product.visuals.filter((v) => v.kind === "photo" && /^https?:/.test(v.url)).map((v) => v.url) : [];
  return {
    title: brief.title,
    format: brief.format.replace(/_/g, " "),
    angle: brief.angle,
    platforms: brief.platforms,
    hook: [hook?.on_screen_text, hook?.line].filter(Boolean).join(" / "),
    creator: brief.creator,
    setting: brief.setting,
    shots: plan.aroll.map((shot) => ({ seconds: shot.seconds, frame_prompt: shot.frame_prompt, video_prompt: shot.video_prompt, dialogue: shot.line })),
    // A physical product's real photos guide the first frame, so the product looks right when the creator holds it.
    reference_images: productPhotos.slice(0, 2),
    caption: brief.caption,
    hashtags: brief.hashtags,
    cta: brief.cta,
    inspired_by: reference ? [reference.url] : [],
    why: brief.why,
    brief,
    script,
    plan,
    reference: reference && {
      id: reference.id,
      url: reference.url,
      author: reference.author,
      views: reference.views,
      followers: reference.followers,
      outlier: reference.outlier,
      format: reference.format,
      hook_mechanic: reference.hook.mechanic,
    },
  };
}

export function captionFor(concept: Concept) {
  const tags = concept.hashtags.join(" ");
  return [concept.caption.trim(), tags].filter(Boolean).join("\n\n");
}
