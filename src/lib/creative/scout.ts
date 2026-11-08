import type { NaiveClient } from "../naive";
import { extractJson, type ResearchPlan, roughScore, type RunSpec, videoSearch, type Video } from "../research";
import { getSetting } from "../settings";
import { cloneabilityPrior } from "./cloneability";

// The scout: after the first wave of searches, an agent reads what came back (stats, captions,
// hashtags, which accounts broke out) and decides where to dig next. It is what makes research
// follow the evidence instead of a fixed list of queries.

export type ScoutSearch = { platform: "tiktok" | "instagram" | "youtube"; query: string; why: string };
export type ScoutReport = { notes: string; searches: ScoutSearch[] };

const MAX_SEARCHES = 5;

const SCOUT_TOOL = {
  name: "scout_report",
  description: "Record what the first wave of results shows and the follow-up searches to run.",
  input_schema: {
    type: "object",
    required: ["notes", "searches"],
    properties: {
      notes: {
        type: "string",
        description:
          "2-4 sentences: which videos broke out (views far above the account's followers), which ones look like they sell (high saves per like, a call to action, a review or demo), what they have in common (hook, format, topic), and what is missing from the results.",
      },
      searches: {
        type: "array",
        maxItems: MAX_SEARCHES,
        description: "Up to 5 follow-up searches, most promising first. Each must be new (not one already run).",
        items: {
          type: "object",
          required: ["platform", "query", "why"],
          properties: {
            platform: { type: "string", enum: ["tiktok", "instagram", "youtube"] },
            query: { type: "string", description: "2-5 words, as a person would type it into that app's search. A hashtag is fine without the #." },
            why: { type: "string", description: "One short sentence: what evidence in the results points here." },
          },
        },
      },
    },
  },
};

/**
 * The top of the first wave, as the scout sees it: numbers it can reason about, no links to follow.
 * Ads are left out (they have no views to compare); saves per like is in, because a video people
 * save is one they mean to act on, and so is the cloneability prior, so the scout follows formats the
 * footage clone can remake.
 */
export function scoutDigest(videos: Video[], limit = 18) {
  return videos
    .filter((video) => !video.ad)
    .sort((a, b) => roughScore(b) - roughScore(a))
    .slice(0, limit)
    .map((video) => ({
      platform: video.platform,
      from_search: video.source,
      author: video.author,
      views: video.views,
      followers: video.followers,
      views_per_follower: video.followers ? Math.round((video.views / Math.max(video.followers, 1000)) * 10) / 10 : null,
      engagement_pct: Math.round(((video.likes + video.comments + 2 * video.shares + 2 * video.saves) / Math.max(video.views, 1)) * 1000) / 10,
      saves_per_like: video.likes >= 100 && video.saves > 0 ? Math.round((video.saves / video.likes) * 100) / 100 : null,
      clones: cloneabilityPrior(video).score,
      seconds: video.duration,
      caption: video.caption.slice(0, 160),
      hashtags: hashtags(video.caption),
    }));
}

export function hashtags(caption: string) {
  return [...new Set([...caption.matchAll(/#([\p{L}\p{N}_]{2,40})/gu)].map((m) => m[1].toLowerCase()))].slice(0, 8);
}

export async function scout(naive: NaiveClient, input: { plan: ResearchPlan; videos: Video[]; brand: { name: string; description: string }; alreadySearched: string[] }): Promise<ScoutReport> {
  const digest = scoutDigest(input.videos);
  // The conversion and face searches ran in the first wave too; the caller's list predates them.
  const alreadySearched = [...new Set([...input.alreadySearched, ...(input.plan.conversion_queries ?? []), ...(input.plan.face_queries ?? [])])];
  const reply = await naive.message({
    model: getSetting("planner_model"),
    max_tokens: 1500,
    system: [
      "You are the research scout on a short-form video team. Your job is to find videos that perform because the video is good, not because the account is big: a video with 10x more views than its account has followers proves its hook and format work.",
      "The team is paid for its customer's sales, not views, so it needs two kinds of evidence: videos that earn reach, and videos that make people act. A video that sells shows it in its numbers and caption: many saves per like (people keep it to come back to), a call to action or offer (link in bio, a code, 'comment AGENT'), a review, a demo, an 'I tried' or a comparison.",
      "Read the first wave of search results and decide where to dig next. Good follow-ups: a hashtag several breakout videos share; the exact phrasing of a breakout hook or topic; the buyer's identity as creators tag it; an adjacent niche whose formats would transfer to this product; a competitor's name plus 'review' or 'vs'. Make at least one search find videos that sell in this niche (a review, demo, comparison or testimonial phrase, or the phrasing of a high-saves video that asks for action).",
      "The team remakes a chosen video from its own footage with one AI presenter copying the original's motion, so one person talking to camera is the format it can use best, and the one that sells best. Make at least one search find that face-to-camera UGC in this niche: a talking-head testimonial, 'I tried X', storytime, a POV reaction or green-screen commentary, phrased the way the best such results are. Each result's 'clones' (0-10) guesses from its caption and length how cleanly it could be remade: follow the high ones, not dances, duets, vlogs or crowds.",
      "Bad follow-ups: the brand name alone, generic words like 'marketing' or 'viral', anything already searched.",
      "If the results are thin or off-topic (the category barely exists on short video), search adjacent topics where the same buyer spends attention. Call the scout_report tool once.",
    ].join("\n"),
    messages: [
      {
        role: "user",
        content: [
          `Brand: ${input.brand.name}: ${input.brand.description || input.plan.category}`,
          `Category: ${input.plan.category}. Buyer: ${input.plan.audience}`,
          `Competitors: ${input.plan.competitors.map((c) => c.name).join(", ") || "unknown"}`,
          `Already searched: ${alreadySearched.join(" | ")}`,
          `First-wave results, best first (${input.videos.length} videos in total):\n${JSON.stringify(digest)}`,
        ].join("\n\n"),
      },
    ],
    tools: [SCOUT_TOOL],
  });
  const call = reply.content.find((block) => block.type === "tool_use" && block.name === SCOUT_TOOL.name);
  const raw = (call?.input ?? extractJson(reply.content.map((block) => block.text ?? "").join("\n"))) as Partial<ScoutReport> | null;
  return cleanReport(raw, alreadySearched);
}

export function cleanReport(raw: Partial<ScoutReport> | null, alreadySearched: string[]): ScoutReport {
  const seen = new Set(alreadySearched.map((query) => query.toLowerCase().trim()));
  const searches: ScoutSearch[] = [];
  for (const search of Array.isArray(raw?.searches) ? raw.searches : []) {
    const query = typeof search?.query === "string" ? search.query.replace(/^#/, "").replace(/\s+/g, " ").trim().slice(0, 60) : "";
    const platform = (["tiktok", "instagram", "youtube"] as const).find((p) => p === search?.platform) ?? "tiktok";
    const key = query.toLowerCase();
    if (!query || seen.has(key)) continue;
    seen.add(key);
    searches.push({ platform, query, why: typeof search?.why === "string" ? search.why.slice(0, 200) : "" });
    if (searches.length >= MAX_SEARCHES) break;
  }
  return { notes: typeof raw?.notes === "string" ? raw.notes.slice(0, 800) : "", searches };
}

/** The scout's searches as phase-D research runs. */
export function scoutSpecs(report: ScoutReport): RunSpec[] {
  const prefix = { tiktok: "tiktok", instagram: "reels", youtube: "shorts" } as const;
  return report.searches.map((search, i) => videoSearch(`scout_${prefix[search.platform]}_${i}`, search.platform, search.query, "D"));
}
