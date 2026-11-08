import type { NaiveClient } from "../naive";
import { QC_MODEL } from "../qc";
import { extractJson } from "../research";
import { hashtags } from "./scout";
import type { ProductBrief, ReferenceCandidate } from "./types";

// The relevance screen: numbers alone pick viral clips that have nothing to do with the brand (a
// trending "#api" emoji loop, a news slideshow). Before anything is broken down, an agent reads the
// top-ranked candidates and judges whether each one could be remade for this product.

const SCREEN_SIZE = 24;
/** Seats in the screen kept for the best conversion evidence: ads have no views, so the reach ranking alone would never show them. */
const CONVERT_SEATS = 8;
export const MIN_RELEVANCE = 6;

/**
 * Who the screen reads: the top of the reach ranking, plus the candidates with the most conversion
 * evidence (ads, reviews, videos that ask for the sale) that the ranking left below the cut. Only
 * videos whose footage can be downloaded: a remake is rebuilt from the reference's own frames.
 */
export function screenPool(candidates: ReferenceCandidate[], size = SCREEN_SIZE, convertSeats = CONVERT_SEATS): ReferenceCandidate[] {
  const usable = candidates.filter((c) => Boolean(c.media_url));
  const converters = usable
    .filter((c) => c.score.role === "convert")
    .sort((a, b) => (b.score.conversion ?? 0) - (a.score.conversion ?? 0))
    .slice(0, convertSeats);
  const top = usable.slice(0, size).filter((c) => !converters.includes(c));
  const pool = [...top.slice(0, size - converters.length), ...converters];
  // Keep the ranking's order so the list reads best first.
  return pool.sort((a, b) => usable.indexOf(a) - usable.indexOf(b));
}

export type Relevance = { url: string; relevance: number; reason: string };

const SCREEN_TOOL = {
  name: "relevance_screen",
  description: "Record how well each candidate video could be remade for this product.",
  input_schema: {
    type: "object",
    required: ["videos"],
    properties: {
      videos: {
        type: "array",
        items: {
          type: "object",
          required: ["n", "relevance", "reason"],
          properties: {
            n: { type: "integer", description: "The candidate's number." },
            relevance: {
              type: "integer",
              description:
                "0-10. 9-10: same buyer and topic (a competitor's or the category's own content, including its ads, reviews, demos and comparisons) and the format would carry this product. 6-8: an adjacent topic this buyer watches, or a format that clearly transfers (a talking-head explainer, a screen demo, a 'tools I use' list, a testimonial or problem-solution ad). 3-5: loosely related. 0-2: unrelated (a meme, a news clip, music, a trend that only shares a hashtag or word, an ad for a product this buyer would never buy).",
            },
            reason: { type: "string", description: "One short sentence." },
          },
        },
      },
    },
  },
};

export async function screenRelevance(naive: Pick<NaiveClient, "message">, candidates: ReferenceCandidate[], input: { product: ProductBrief; scoutNotes?: string }): Promise<Relevance[]> {
  const top = screenPool(candidates);
  if (!top.length) return [];
  const list = top.map((c, i) => ({
    n: i + 1,
    platform: c.platform,
    author: c.author,
    from: c.origin,
    stats: c.score.why,
    ...(c.score.signals?.length ? { sells: `${c.score.conversion ?? 0}/10: ${c.score.signals.join(", ")}` } : {}),
    seconds: c.duration,
    caption: c.caption.slice(0, 220),
    hashtags: hashtags(c.caption),
  }));
  const reply = await naive.message({
    model: QC_MODEL,
    max_tokens: 3000,
    system: [
      "You screen viral short videos for a team that remakes them for a brand: the remake keeps the video's hook, beats and wording and swaps in the brand's product. A video is only useful if a remake would make sense for this product's buyer.",
      "Judge each candidate from its caption, hashtags, author and stats. Be strict about topic: going viral on a shared hashtag or word is not relevance. The exception is a candidate marked from: benchmark (a brand or creator famous for viral short-form, like Cluely or MrBeast): judge whether its hook and format could be remade for this product, not its topic (6-8 if it clearly transfers).",
      "Some candidates are there because they sell, not because they were seen (the 'sells' field: an ad that kept running, a review, a video that asks for the sale). A candidate marked from: ad is a paid ad from an ad library and has no view count: judge it by whether its buyer and offer match this product's, the same as any video. A keyword search of an ad library also returns unrelated advertisers; score those 0-2.",
      "The team copies a chosen video one-to-one (layout, graphics, captions, timing) with its own AI presenter and product. A presenter talking to camera, a green screen or a screen recording rebuilds cleanly; when the caption or hashtags show the video depends on real-world footage it cannot recreate (travel, crowds, sports, a stunt, a live event), take 1-2 points off.",
      "Call the relevance_screen tool once with every candidate.",
    ].join("\n"),
    messages: [
      {
        role: "user",
        content: [
          `Product: ${input.product.name}: ${input.product.one_liner} (${input.product.kind}). Buyer: ${input.product.audience || "unknown"}. Problem it solves: ${input.product.problem || "unknown"}.`,
          input.scoutNotes ? `The research scout's notes on these results: ${input.scoutNotes}` : "",
          `Candidates, ranked by how far they outran their accounts (ads, which have no views, come last):\n${JSON.stringify(list)}`,
        ]
          .filter(Boolean)
          .join("\n\n"),
      },
    ],
    tools: [SCREEN_TOOL],
  });
  const call = reply.content.find((block) => block.type === "tool_use" && block.name === SCREEN_TOOL.name);
  const raw = (call?.input ?? extractJson(reply.content.map((block) => block.text ?? "").join("\n"))) as { videos?: Array<{ n?: unknown; relevance?: unknown; reason?: unknown }> } | null;
  const out: Relevance[] = [];
  for (const item of raw?.videos ?? []) {
    const candidate = top[Number(item?.n) - 1];
    if (!candidate) continue;
    out.push({ url: candidate.url, relevance: Math.max(0, Math.min(10, Math.round(Number(item.relevance) || 0))), reason: typeof item.reason === "string" ? item.reason.slice(0, 200) : "" });
  }
  return out;
}

/**
 * Relevant candidates first: those at or above the bar, ordered by relevance and then by their
 * performance score. When fewer than three pass, the best of the rest follow so there is always
 * something to learn from.
 */
export function applyRelevance(candidates: ReferenceCandidate[], screened: Relevance[]): ReferenceCandidate[] {
  const byUrl = new Map(screened.map((r) => [r.url, r]));
  const judged = candidates.filter((c) => byUrl.has(c.url));
  const passing = judged.filter((c) => byUrl.get(c.url)!.relevance >= MIN_RELEVANCE);
  // Relevance first; among equally relevant videos, the one that outran its account more.
  const order = (list: ReferenceCandidate[]) => [...list].sort((a, b) => byUrl.get(b.url)!.relevance - byUrl.get(a.url)!.relevance || b.score.total - a.score.total);
  if (passing.length >= 3) return order(passing);
  const rest = order(judged.filter((c) => !passing.includes(c)));
  return [...order(passing), ...rest.slice(0, 3 - passing.length)];
}
