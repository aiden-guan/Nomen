import { describe, expect, it } from "vitest";
import { pickForBreakdown } from "@/lib/creative/references";
import { applyRelevance, screenPool, screenRelevance } from "@/lib/creative/relevance";
import type { ProductBrief, ReferenceCandidate } from "@/lib/creative/types";

const candidate = (url: string, total: number, extra: Partial<ReferenceCandidate> = {}): ReferenceCandidate => ({
  platform: "tiktok",
  url,
  caption: `caption ${url}`,
  views: 100_000,
  likes: 1000,
  comments: 10,
  shares: 10,
  saves: 10,
  duration: 20,
  author: url,
  followers: 1000,
  paid: false,
  thumbnail: null,
  media_url: `https://cdn/${url}.mp4`,
  source: "tiktok_0",
  origin: "category",
  score: { outlier: 100, engagement: 0.05, total, why: "" },
  ...extra,
});

const product = { name: "Monid", one_liner: "one balance for every API", kind: "software", audience: "agent builders", problem: "too many sign-ups" } as ProductBrief;

describe("the relevance screen", () => {
  const ranked = [candidate("meme", 50), candidate("news", 45), candidate("composio", 30, { origin: "competitor" }), candidate("agent-tips", 25), candidate("claude-skills", 20)];

  it("maps the model's verdicts back to candidates", async () => {
    const naive = {
      message: async () => ({
        stop_reason: "tool_use",
        content: [{ type: "tool_use", name: "relevance_screen", input: { videos: [{ n: 1, relevance: 1, reason: "emoji loop" }, { n: 3, relevance: 9, reason: "competitor creator" }, { n: 9, relevance: 9, reason: "no such video" }] } }],
      }),
    };
    expect(await screenRelevance(naive, ranked, { product })).toEqual([
      { url: "meme", relevance: 1, reason: "emoji loop" },
      { url: "composio", relevance: 9, reason: "competitor creator" },
    ]);
  });

  it("keeps relevant videos, ordered by relevance then performance, and drops unrelated viral clips", () => {
    const screened = [
      { url: "meme", relevance: 1, reason: "" },
      { url: "news", relevance: 2, reason: "" },
      { url: "composio", relevance: 9, reason: "" },
      { url: "agent-tips", relevance: 7, reason: "" },
      { url: "claude-skills", relevance: 8, reason: "" },
    ];
    const kept = applyRelevance(ranked, screened);
    expect(kept.map((c) => c.url)).toEqual(["composio", "claude-skills", "agent-tips"]);
    expect(pickForBreakdown(kept, 6, { keepOrder: true }).map((c) => c.url)).toEqual(["composio", "claude-skills", "agent-tips"]);
  });

  it("keeps seats for the best converters below the reach cut, and only for footage it can download", async () => {
    const reach = Array.from({ length: 30 }, (_, i) => candidate(`viral-${i}`, 100 - i));
    const ad = candidate("long-running-ad", 3, { origin: "ad", score: { outlier: null, engagement: 0, total: 3, why: "Meta ad, ran 94 days, 20 s", conversion: 7, role: "convert", signals: ["Meta ad", "ran 94 days, still running"] } });
    const review = candidate("review", 20, { score: { outlier: 4, engagement: 0.08, total: 20, why: "", conversion: 4, role: "convert", signals: ['caption: "review"'] } });
    const gone = candidate("no-footage", 2, { media_url: null, score: { outlier: null, engagement: 0, total: 2, why: "", conversion: 9, role: "convert", signals: ["Meta ad"] } });
    const ranked = [...reach, review, ad, gone];
    const pool = screenPool(ranked);
    expect(pool).toHaveLength(24);
    expect(pool.map((c) => c.url)).toEqual([...reach.slice(0, 22).map((c) => c.url), "review", "long-running-ad"]);

    let sent = "";
    const naive = {
      message: async (request: { system?: string; messages: Array<{ content: unknown }> }) => {
        sent = `${request.system}\n${String(request.messages[0].content)}`;
        return { stop_reason: "tool_use", content: [{ type: "tool_use", name: "relevance_screen", input: { videos: [{ n: 24, relevance: 9, reason: "competitor ad" }] } }] };
      },
    };
    expect(await screenRelevance(naive, ranked, { product })).toEqual([{ url: "long-running-ad", relevance: 9, reason: "competitor ad" }]);
    expect(sent).toContain('"sells":"7/10: Meta ad, ran 94 days, still running"');
    expect(sent).toContain("from: ad is a paid ad");
  });

  it("tops up with the best of the rest when fewer than three pass", () => {
    const kept = applyRelevance(ranked, [
      { url: "meme", relevance: 2, reason: "" },
      { url: "news", relevance: 1, reason: "" },
      { url: "composio", relevance: 8, reason: "" },
      { url: "agent-tips", relevance: 4, reason: "" },
    ]);
    expect(kept.map((c) => c.url)).toEqual(["composio", "agent-tips", "meme"]);
  });
});
