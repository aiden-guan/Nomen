import { describe, expect, it } from "vitest";
import { approveAll, freshState, publish, replay, timeline } from "@/components/troy/camp/demo";
import { collapseRepeats, creatorChips, summarizeEvent } from "@/components/troy/camp/eventSummary";
import { exchangeOf } from "@/components/troy/camp/exchange";
import { SAMPLE } from "@/components/troy/camp/sample";

// What the agents tell each other as work changes hands, and how the station panels make a
// dispatch line scannable.

const campaignAt = (t: number) => replay(SAMPLE, { ...freshState(0), t }).campaign!;

describe("what changes hands", () => {
  const tl = timeline(SAMPLE);

  it("hands the oracle the research, with the bar to clear and the rivals", () => {
    const x = exchangeOf("scouts", "oracle", campaignAt(tl.research[1] + 0.1));
    expect(x.title).toBe("Scouts → Oracle");
    expect(x.lines[0]).toMatch(/^Research: \d+ top videos, \d+ running ads/);
    expect(x.lines.some((l) => /^The bar to clear: the top videos' median [\d.]+% likes per view\.$/.test(l))).toBe(true);
  });

  it("hands the workshop the videos to make, and the theatre each finished one", () => {
    const plan = exchangeOf("tent", "workshop", campaignAt(tl.strategy[1] + 0.1));
    expect(plan.lines.some((l) => /videos? to make:$/.test(l))).toBe(true);
    expect(plan.lines.filter((l) => l.startsWith("· ")).length).toBeGreaterThan(0);
    const cut = exchangeOf("workshop", "theatre", campaignAt(tl.review + 0.1));
    expect(cut.lines[0]).toMatch(/^Finished: /);
    expect(cut.lines.at(-1)).toMatch(/^\d+ of \d+ videos ready for review\.$/);
  });

  it("hands the agora the approved videos", () => {
    const state = publish(SAMPLE, approveAll(SAMPLE, { ...freshState(0), t: tl.review + 1 }), "now");
    const x = exchangeOf("theatre", "agora", replay(SAMPLE, state).campaign!);
    expect(x.lines[0]).toMatch(/^\d+ approved videos? to post/);
  });

  it("says something even without a campaign", () => {
    expect(exchangeOf("scouts", "oracle", null).lines).toEqual(["Scouts hand their work to Oracle."]);
  });
});

describe("a dispatch line, made scannable", () => {
  it("turns counts into chips and leaves no lead that only repeats them", () => {
    const s = summarizeEvent("Research done: 99 short videos to rank, 9 live ads, 5 Reddit threads, 8 keywords (39/42 sources)");
    expect(s).toMatchObject({ headline: "Research done", lead: null });
    expect(s.chips).toEqual(["99 videos", "9 ads", "5 threads", "8 keywords", "39/42 sources"]);
  });

  it("keeps a video's title whole, colon and all, and names its creator once with their numbers", () => {
    const s = summarizeEvent(`"Two founders, one instruction: make money": made as a code ad (3D animation) from @mplentg's video in the research (644K views on 2K followers)`);
    expect(s.headline).toBe("“Two founders, one instruction: make money”");
    expect(s.lead).toMatch(/^made as a code ad/);
    expect(s.chips).toEqual(["@mplentg · 644K"]);
    expect(creatorChips("@a 102.8M views on 42K followers (2457x), @b 1.8M views")).toEqual(["@a · 102.8M · 2457×", "@b · 1.8M"]);
  });

  it("makes a list of what a line lists", () => {
    const dropped = summarizeEvent("Relevance screen: 7 of 24 top-ranked videos could be remade for Naïve (dropped: Duolingo meme; DDLC fanfic drama, unrelated; a mom clip.)");
    expect(dropped.lead).toBe("7 of 24 top-ranked videos could be remade for Naïve");
    expect(dropped.list).toEqual({ label: "Dropped", items: ["Duolingo meme", "DDLC fanfic drama, unrelated", "a mom clip"] });
    const plan = summarizeEvent("Research plan: AI agent company platform; competitors CrewAI, Lindy; searching agents, automation");
    expect(plan.lead).toBe("AI agent company platform");
    expect(plan.list!.items).toEqual(["Competitors CrewAI, Lindy", "Searching agents, automation"]);
    const check = summarizeEvent("Scout: format check, brainrot memes break out on tiny accounts: @c 102.8M views on 42K followers (2457x).");
    expect(check).toMatchObject({ headline: "Format check", lead: "Brainrot memes break out on tiny accounts." });
  });

  it("names a post's platforms, and folds repeats into one line", () => {
    expect(summarizeEvent("Post submitted: tiktok, instagram, youtube").chips).toEqual(["TikTok", "Instagram", "YouTube"]);
    const lines = collapseRepeats([{ message: "a" }, { message: "a" }, { message: "b" }, { message: "a" }]);
    expect(lines.map((l) => [l.message, l.times])).toEqual([["a", 2], ["b", 1], ["a", 1]]);
  });
});
