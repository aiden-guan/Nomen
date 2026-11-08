import { CLONE_EASY, cloneLine } from "./creative/cloneability";
import type { ResearchPack } from "./research";
import type { BrainrotScript } from "./creative/brainrot";
import type { CreativeBrief, FunnelRole, ProductBrief, ProductionPlan, ReferenceBreakdown, Script, SuccessMetric, VideoFormat } from "./creative/types";

// The strategist's contract: the JSON Schema Naive enforces on the session, and the types it fills.

export type Shot = { seconds: number; frame_prompt: string; video_prompt: string; dialogue: string; pose?: string };

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
  /** Its job in the campaign and the number it is judged on (from the brief). */
  role?: FunnelRole;
  metric?: SuccessMetric;
  /** Creative engine: the director's brief, the script room's script and the shot plan behind this video. */
  brief?: CreativeBrief;
  script?: Script;
  plan?: ProductionPlan;
  /** Brainrot videos: the bit (characters, shots, voice, stamps, sound) instead of a script and plan. */
  brainrot?: BrainrotScript;
  reference?: { id: string; url: string; author: string; views: number; followers: number | null; outlier: number | null; format: string; hook_mechanic: string };
  /** For internal review only (one-to-one remakes): publishing refuses it unless `cleared` is set. */
  internal?: boolean;
  /** Who cleared an internal video for posting, when and why. */
  cleared?: { at: string; by: string; note: string };
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

export const FORMATS: VideoFormat[] = ["talking_head_broll", "split_screen", "presenter_inset", "voiceover_demo", "filmed_screen", "text_story", "remake", "brainrot"];

export const PLATFORMS = ["tiktok", "instagram", "youtube", "x", "facebook", "linkedin", "threads"] as const;

/** The numbers each funnel job is judged on; the first is the default. */
export const METRICS: Record<FunnelRole, SuccessMetric[]> = { reach: ["views", "shares", "saves"], convert: ["link_clicks", "sign_ups", "purchases"] };

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
            required: ["title", "reference_id", "role", "metric", "format", "angle", "audience", "hook_plan", "keep", "change", "visuals", "creator", "setting", "platforms", "caption", "hashtags", "cta", "why"],
            properties: {
              title: str,
              reference_id: { type: "string", description: "The id of the reference video this one remakes (from <references>)." },
              role: {
                type: "string",
                enum: ["reach", "convert"],
                description: "This video's job: reach (get the product seen and shared) or convert (make viewers click, sign up or buy). With 2+ videos, at least one of each.",
              },
              metric: {
                type: "string",
                enum: [...METRICS.reach, ...METRICS.convert],
                description: "The number this video is judged on: views, shares or saves for reach; link_clicks, sign_ups or purchases for convert.",
              },
              format: { type: "string", enum: [...FORMATS] },
              angle: str,
              audience: str,
              hook_plan: { type: "string", description: "The reference's hook mechanic restated for this product: what is said, shown and written in the first 2-3 seconds." },
              keep: strs,
              change: strs,
              visuals: { type: "array", items: str, description: "Product visual ids (from <visuals>) to show, most important first." },
              creator: { type: "string", description: "Formats with a face: one specific, ordinary-looking person (age range, look, hair, wardrobe, energy). Empty for voiceover_demo, filmed_screen and text_story." },
              setting: { type: "string", description: "One real place with time of day and light. filmed_screen: the desk and room around the monitor, as in the reference. Empty for the other formats without a face." },
              platforms: { type: "array", items: { type: "string", enum: [...PLATFORMS] } },
              caption: str,
              hashtags: strs,
              cta: {
                type: "string",
                description: "convert: one concrete action true to the product brief's offer ('get the $1 free credit, link in bio'). reach: a soft ask (follow, comment, share) or ''.",
              },
              why: {
                type: "string",
                description: `Why this reference and format will work for this product and buyer, citing the reference's numbers or conversion evidence, and, when its cloneability is below ${CLONE_EASY}, what makes it worth the harder remake.`,
              },
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
export type PastResult = {
  /** One earlier post: what it was, where it went, and what it did (stats read from its analytics). */
  title: string;
  format: string;
  hook: string;
  platforms: string[];
  status: string;
  url: string | null;
  stats: { views?: number; likes?: number; comments?: number; shares?: number; saves?: number } | null;
  /** Why it failed, for a failed post. */
  error: string | null;
  analytics: Record<string, unknown> | null;
};

/** What the director sees of a reference: its numbers, mechanics and beats, not its raw transcript. */
export function referenceDigest(breakdowns: ReferenceBreakdown[]) {
  return breakdowns.map((ref) => ({
    id: ref.id,
    url: ref.url,
    platform: ref.platform,
    author: ref.author,
    // An ad library publishes no views: say so rather than show a flop.
    views: ref.origin === "ad" ? "unknown (paid ad)" : ref.views,
    followers: ref.followers,
    views_per_follower: ref.outlier,
    role: ref.role ?? "reach",
    conversion_evidence: ref.conversion ? `${ref.conversion.score}/10${ref.conversion.signals.length ? `: ${ref.conversion.signals.join(", ")}` : ""}` : "none recorded",
    ...(ref.anatomy ? { how_it_sells: ref.anatomy } : {}),
    // How faithfully the footage clone can remake it, and why: the director must say why when it picks a hard one.
    cloneability: ref.cloneability ? cloneLine(ref.cloneability) : "not recorded",
    ...(ref.footage?.hardest ? { hardest_to_clone: ref.footage.hardest } : {}),
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
    // Competitors' ads first, longest-running first: how long an ad has run is the public proof it pays.
    ads: pack.ads.slice(0, 10).map((ad) => ({ ...ad, video_url: undefined, cover: undefined })),
    reddit: pack.reddit.slice(0, 8),
    aeo: pack.aeo,
  };
  const { product, breakdowns } = creative;
  return [
    `Build the campaign for ${product.name || pack.brand.name || pack.domain}.`,
    `Deliver exactly ${options.concepts} video briefs. Each brief remakes one of the proven reference videos below for this product, as closely as possible: the same hook, beats, wording, timing, shots and on-screen text, with an AI presenter of the same kind in the same kind of setting, and only the product-specific parts changed. Pick the references with the best mix of proof and fit for this product. Give the briefs different styles, not just different references: mix the lanes (a competitor's winning format, a niche breakout, a famous viral hook, a long-running ad) and the formats, so the campaign tests several ways to win.`,
    `Plan the campaign as a funnel mix, the way performance teams do: the customer pays for sales, not views. A video with 2 million likes can sell less than one with 100 thousand. Give every brief a role and the metric it is judged on: reach videos get the product seen and shared (judged on views, shares or saves) and remake references whose proof is reach (views far above the account's followers, or raw virality for a famous benchmark like Cluely or MrBeast); convert videos make viewers click, sign up or buy (judged on link clicks, sign-ups or purchases) and remake references whose proof is that they sell (role "convert": an ad an advertiser kept paying for, many saves per like, a review, demo or testimonial that asks for the sale), keeping their selling beats (problem, proof, objection, offer, call to action) with this product's real facts and offer. ${options.concepts >= 2 ? `With ${options.concepts} videos, include at least one of each role.` : "With one video, pick the role the evidence supports best."} Each video will get its own tracked link, so a convert video's call to action must be one concrete step.`,
    `Remakes are one-to-one, made from the reference's own footage: a lookalike AI presenter performs the original's exact motion (it needs one person, in continuous takes), the original audio is re-voiced with this product's words, and its graphics and captions are replaced in place. cloneability (0-10) says how faithfully that works for each reference, with the reasons, and hardest_to_clone names its hardest part. Face-to-camera UGC (one person talking to the lens: a talking-head testimonial, "I tried X", storytime, a POV reaction, green-screen commentary) is the format with the most return and the hardest to get right, and it is what the clone is built for: favour it, and vary the styles within it (the hook, the selling structure, the lane, the setting). Prefer references with cloneability ${CLONE_EASY} or more. Several people, a moving camera, crowds or real locations, hands working a product in close-up, and songs or dialogue are what it cannot reproduce. When you pick a reference below ${CLONE_EASY}, say in its brief's why what makes it worth the risk. When the evidence is close, take the shorter one: every second is rendered (about $0.40 a second with a presenter), so 45 seconds or less.`,
    breakdowns.length
      ? `Reference videos, broken down beat by beat from their transcripts and frames, the most cloneable first. role and conversion_evidence say what each is proof of; how_it_sells quotes its selling beats; cloneability says how faithfully it can be remade:\n<references>\n${JSON.stringify(referenceDigest(breakdowns))}\n</references>`
      : "No reference videos could be broken down for this run. Base each brief on the strongest patterns in the research and set reference_id to an empty string.",
    `The product brief (the only source of claims):\n<product>\n${JSON.stringify({ ...product, visuals: undefined })}\n</product>`,
    product.visuals.length
      ? `Real product visuals that can be on screen (refer to them by id):\n<visuals>\n${JSON.stringify(product.visuals.map(({ id, kind, caption, source }) => ({ id, kind, caption, source })))}\n</visuals>`
      : "There are no product visuals for this brand: choose formats where the creator carries the video (talking_head_broll with creator beats only), or filmed_screen, whose screens are built from the product brief.",
    `Formats: talking_head_broll (a creator talks to camera; the edit cuts to the product while they keep talking), split_screen (creator on top, product underneath), presenter_inset (product graphics full screen with the presenter in a small rounded window, the look of most viral dev-tool tutorials), voiceover_demo (no face: product on screen, a voice-over and captions), filmed_screen (no face: looks like a phone filming a computer monitor while a voice walks through it; use it when the reference is a filmed screen or screen-recorded walkthrough), text_story (no face: product on screen with large text), remake (a one-to-one remake of the reference itself: its footage, framing, cuts, timing, music, graphic placement and caption look are kept, with the brand's recurring presenter in place of the person, Kling 3.0 voicing them, and only the product facts in its words changed; internal only, never posted unless a person clears it; about $0.17 per second of the reference's full length plus about $0.30), brainrot (a deliberately terrible, so-cringe-it's-funny AI meme ad for reach: an outrageous stunt opener, original absurd characters, current meme trends, bass-boosted sound, the product as the punchline; it uses Nomen's own viral brainrot formats, so reference_id may be any reference; held until a person clears it; about $2-4 a video). Match the reference's format where you can. Videos with a face cost about $0.40 per second to render; faceless formats cost almost nothing, so use them when the reference is faceless or the product is software that shows well on screen.`,
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
    const role: FunnelRole = brief.role === "reach" || brief.role === "convert" ? brief.role : DIRECT_ASK.test(brief.cta ?? "") ? "convert" : "reach";
    return {
      title: (brief.title ?? `Video ${i + 1}`).toString().trim(),
      reference_id: reference,
      role,
      metric: METRICS[role].includes(brief.metric as SuccessMetric) ? (brief.metric as SuccessMetric) : METRICS[role][0],
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
  strategy.campaign.briefs = balanceRoles(briefs);
  strategy.campaign.concepts = [];
  return strategy;
}

/** A call to action that asks for a concrete step, as opposed to "follow for more". */
const DIRECT_ASK = /sign ?up|\btry\b|download|\bget\b|start|link|free|code|shop|\bbuy\b|join|install|order|book|subscribe|credit|trial/i;

/**
 * A campaign of two or more videos tests both jobs: if the director made every video the same role,
 * the one whose call to action fits the other job best switches (its metric with it).
 */
export function balanceRoles(briefs: CreativeBrief[]): CreativeBrief[] {
  if (briefs.length < 2) return briefs;
  for (const role of ["reach", "convert"] as const) {
    if (briefs.some((brief) => brief.role === role)) continue;
    const other: FunnelRole = role === "reach" ? "convert" : "reach";
    // Turning a video into a converter: the one that already asks for a step. Into reach: one that does not.
    const fits = (brief: CreativeBrief) => DIRECT_ASK.test(brief.cta) === (role === "convert");
    const pick = [...briefs].reverse().find((brief) => brief.role === other && fits(brief)) ?? briefs[briefs.length - 1];
    pick.role = role;
    pick.metric = METRICS[role][0];
  }
  return briefs;
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
    shots: plan.aroll.map((shot) => ({ seconds: shot.seconds, frame_prompt: shot.frame_prompt, video_prompt: shot.video_prompt, dialogue: shot.line, ...(shot.pose !== undefined ? { pose: shot.pose } : {}) })),
    // A physical product's real photos guide the first frame, so the product looks right when the creator holds it.
    reference_images: productPhotos.slice(0, 2),
    caption: brief.caption,
    hashtags: brief.hashtags,
    cta: brief.cta,
    inspired_by: reference ? [reference.url] : [],
    why: brief.why,
    ...(brief.role ? { role: brief.role, metric: brief.metric ?? METRICS[brief.role][0] } : {}),
    // Remakes copy a real creator's video one to one: they stay internal (see publish.ts).
    ...(brief.format === "remake" ? { internal: true } : {}),
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
