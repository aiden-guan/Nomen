import type { NaiveClient } from "../naive";
import { QC_MODEL } from "../qc";
import { extractJson } from "../research";
import { hashtags } from "./scout";
import type { ProductBrief, ReferenceCandidate } from "./types";

// The relevance screen: numbers alone pick viral clips that have nothing to do with the brand (a
// trending "#api" emoji loop, a news slideshow). Before anything is broken down, an agent reads the
// top-ranked candidates and judges whether each one could be remade for this product.

const SCREEN_SIZE = 24;
export const MIN_RELEVANCE = 6;

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
                "0-10. 9-10: same buyer and topic (a competitor's or the category's own content) and the format would carry this product. 6-8: an adjacent topic this buyer watches, or a format that clearly transfers (a talking-head explainer, a screen demo, a 'tools I use' list). 3-5: loosely related. 0-2: unrelated (a meme, a news clip, music, a trend that only shares a hashtag or word).",
            },
            reason: { type: "string", description: "One short sentence." },
          },
        },
      },
    },
  },
};

export async function screenRelevance(naive: Pick<NaiveClient, "message">, candidates: ReferenceCandidate[], input: { product: ProductBrief; scoutNotes?: string }): Promise<Relevance[]> {
  const top = candidates.slice(0, SCREEN_SIZE);
  if (!top.length) return [];
  const list = top.map((c, i) => ({
    n: i + 1,
    platform: c.platform,
    author: c.author,
    from: c.origin,
    stats: c.score.why,
    seconds: c.duration,
    caption: c.caption.slice(0, 220),
    hashtags: hashtags(c.caption),
  }));
  const reply = await naive.message({
    model: QC_MODEL,
    max_tokens: 3000,
    system: [
      "You screen viral short videos for a team that remakes them for a brand: the remake keeps the video's hook, beats and wording and swaps in the brand's product. A video is only useful if a remake would make sense for this product's buyer.",
      "Judge each candidate from its caption, hashtags, author and stats. Be strict about topic: going viral on a shared hashtag or word is not relevance. Call the relevance_screen tool once with every candidate.",
    ].join("\n"),
    messages: [
      {
        role: "user",
        content: [
          `Product: ${input.product.name}: ${input.product.one_liner} (${input.product.kind}). Buyer: ${input.product.audience || "unknown"}. Problem it solves: ${input.product.problem || "unknown"}.`,
          input.scoutNotes ? `The research scout's notes on these results: ${input.scoutNotes}` : "",
          `Candidates, ranked by how far they outran their accounts:\n${JSON.stringify(list)}`,
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
