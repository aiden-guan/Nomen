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

  it("gives the screen's seats to videos the footage clone can reproduce before the ones it cannot", () => {
    // Three duets that went furthest (cloneability 1 from the caption), then plain videos (5).
    const duets = [0, 1, 2].map((i) => candidate(`duet-${i}`, 200 - i, { caption: "duet dance challenge" }));
    const plain = Array.from({ length: 26 }, (_, i) => candidate(`plain-${i}`, 100 - i));
    expect(screenPool([...duets, ...plain]).map((c) => c.url)).toEqual(plain.slice(0, 24).map((c) => c.url));
    // With fewer cloneable videos than seats, the hard ones fill in last.
    expect(screenPool([...duets, ...plain.slice(0, 22)]).map((c) => c.url)).toEqual([...plain.slice(0, 22).map((c) => c.url), "duet-0", "duet-1"]);
  });

  it("shows the screen each candidate's cloneability and asks it to favour one person talking to camera", async () => {
    let sent = "";
    const naive = {
      message: async (request: { system?: string; messages: Array<{ content: unknown }> }) => {
        sent = `${request.system}\n${String(request.messages[0].content)}`;
        return { stop_reason: "tool_use", content: [{ type: "tool_use", name: "relevance_screen", input: { videos: [] } }] };
      },
    };
    await screenRelevance(naive, [candidate("story", 30, { caption: "storytime: my agent bill" })], { product });
    expect(sent).toContain('"clones":"7/10 guessed from the caption and length: not watched yet: 5 to start, caption names a face-to-camera format (\\"storytime\\") +2"');
    expect(sent).toMatch(/one person, in continuous takes/);
    expect(sent).toMatch(/talking-head testimonial, 'I tried X', storytime, a POV reaction, green-screen commentary/);
    expect(sent).toMatch(/take 1-2 points off and say so in the reason/);
  });

  it("breaks a relevance tie by reach and cloneability together", () => {
    const story = candidate("story", 30, { caption: "storytime: my agent bill" }); // 30 + 1.5 x 7 = 40.5
    const plain = candidate("plain", 32); // 32 + 1.5 x 5 = 39.5
    const kept = applyRelevance([plain, story, candidate("c", 10)], [
      { url: "plain", relevance: 8, reason: "" },
      { url: "story", relevance: 8, reason: "" },
      { url: "c", relevance: 9, reason: "" },
    ]);
    expect(kept.map((c) => c.url)).toEqual(["c", "story", "plain"]);
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
