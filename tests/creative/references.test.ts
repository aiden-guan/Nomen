import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  type Baseline,
  breakdownAll,
  breakdownReference,
  canonicalUrl,
  conversionOf,
  DEFAULT_BASELINE,
  detectCuts,
  frameTimes,
  pickForBreakdown,
  poolBaseline,
  readBreakdown,
  ReferenceUnavailableError,
  referenceId,
  referenceRole,
  scoreCandidates,
  scoreVideo,
  wordsPerMinute,
  type BreakdownClient,
} from "@/lib/creative/references";
import type { ReferenceCandidate } from "@/lib/creative/types";
import { ApiError } from "@/lib/http";
import { ffmpegPath } from "@/lib/media";
import type { Transcription } from "@/lib/naive";
import { QC_MODEL } from "@/lib/qc";
import type { Video } from "@/lib/research";

const exec = promisify(execFile);

function video(overrides: Partial<Video> = {}): Video {
  return {
    platform: "tiktok",
    url: `https://www.tiktok.com/@creator/video/${Math.floor(Math.random() * 1e12)}`,
    caption: "",
    views: 100_000,
    likes: 4_000,
    comments: 100,
    shares: 50,
    saves: 100,
    duration: 25,
    author: "creator",
    followers: 50_000,
    paid: false,
    thumbnail: null,
    media_url: "https://cdn.example.com/video.mp4",
    source: "tiktok_0",
    ...overrides,
  };
}

const category = () => "category" as const;

// ---------- scoring ----------

describe("scoreVideo", () => {
  it("computes outlier and engagement as the contract defines them and explains them in one line", () => {
    // 410k views on a 10k account; (30,000 + 900 + 2 x 2,000 + 2 x 1,500) / 410,000 = 9.2%
    const score = scoreVideo(video({ views: 410_000, followers: 10_000, likes: 30_000, comments: 900, shares: 2_000, saves: 1_500, duration: 23 }));
    expect(score.outlier).toBe(41);
    expect(score.engagement).toBeCloseTo(0.0924, 4);
    expect(score.why).toBe("41x the account's followers, 9% engagement, 23 s");
    expect(Number.isFinite(score.total)).toBe(true);
  });

  it("floors followers at 1,000 so a brand-new account is not an infinite outlier", () => {
    expect(scoreVideo(video({ views: 5_000, followers: 200 })).outlier).toBe(5);
    expect(scoreVideo(video({ views: 5_000, followers: 0 })).outlier).toBe(5);
  });

  it("reports unknown followers as null and says so", () => {
    const score = scoreVideo(video({ views: 1_200_000, followers: null, likes: 90_000, duration: null }));
    expect(score.outlier).toBeNull();
    expect(score.why).toBe("1.2M views, followers unknown, 8% engagement, length unknown");
  });

  it("penalizes accounts over 1M followers by 3 + 3 x log10(followers / 1M)", () => {
    const mega = video({ views: 12_000_000, followers: 25_000_000, likes: 450_000, comments: 3_000, shares: 4_000, saves: 12_000 });
    const penalized = scoreVideo(mega).total;
    const unpenalized = scoreVideo(mega, { bigAccount: 1e12 }).total;
    expect(unpenalized - penalized).toBeCloseTo(3 + 3 * Math.log10(25), 1);
    expect(scoreVideo(mega).why).toContain("big account (25M followers)");
  });

  it("penalizes paid posts", () => {
    const organic = scoreVideo(video({ paid: false })).total;
    const paid = scoreVideo(video({ paid: true }));
    expect(organic - paid.total).toBeCloseTo(4, 1);
    expect(paid.why).toContain("paid partnership");
  });

  it("prefers 6-45 second videos, and charges a point per 10 s of remake past 45 s", () => {
    const at = (duration: number | null) => scoreVideo(video({ duration })).total;
    expect(at(23)).toBeGreaterThan(at(null));
    expect(at(null)).toBeGreaterThan(at(4));
    expect(at(6)).toBe(at(45));
    expect(at(45) - at(65)).toBeCloseTo(2, 5);
    expect(at(75)).toBeGreaterThan(at(90));
    expect(at(90)).toBeGreaterThan(at(161));
    expect(at(161)).toBeGreaterThan(at(372));
  });

  it("does not trust a huge engagement rate or outlier on a few thousand views", () => {
    // 57% engagement on 300 views, and a "5x outlier" that is 5,000 views on a 50-follower account.
    const tiny = scoreVideo(video({ views: 300, followers: 0, likes: 150, comments: 20, shares: 0, saves: 0 }));
    const fluke = scoreVideo(video({ views: 5_000, followers: 50, likes: 900, comments: 40, shares: 10, saves: 10 }));
    const solid = scoreVideo(video({ views: 200_000, followers: 60_000, likes: 11_000, comments: 300, shares: 400, saves: 500 }));
    expect(fluke.outlier).toBeGreaterThan(solid.outlier!);
    expect(solid.total).toBeGreaterThan(tiny.total);
    expect(solid.total).toBeGreaterThan(fluke.total);
  });

  it("survives missing numbers without NaN", () => {
    const score = scoreVideo(video({ views: 0, likes: 0, comments: 0, shares: 0, saves: 0, followers: null, duration: null }));
    expect(Number.isFinite(score.total)).toBe(true);
    expect(score.engagement).toBe(0);
  });
});

describe("scoreCandidates on real Olipop search results", () => {
  // Numbers from a real drinkolipop.com research run (tests/fixtures/olipop-runs.json).
  const videos: Video[] = [
    video({ url: "https://www.tiktok.com/@sistersisterzz/video/1", author: "sistersisterzz", views: 10_036_174, likes: 524_615, comments: 1_889, shares: 2_967, saves: 16_510, duration: 9.3, followers: 3_388_575, paid: true, source: "tiktok_brand" }),
    video({ url: "https://www.tiktok.com/@dusk_knight04/video/2", author: "dusk_knight04", views: 5_301_055, likes: 431_031, comments: 1_232, shares: 9_730, saves: 21_184, duration: 15.1, followers: 1_015, source: "tiktok_brand" }),
    video({ url: "https://www.tiktok.com/@aridennn15/video/3", author: "aridennn15", views: 4_202_855, likes: 472_100, comments: 4_868, shares: 2_634, saves: 11_843, duration: 8.3, followers: 1_030, source: "tiktok_1" }),
    video({ url: "https://www.tiktok.com/@michael.dicostanzo/video/4", author: "michael.dicostanzo", views: 3_403_740, likes: 449_281, comments: 7_496, shares: 6_285, saves: 13_709, duration: 372.4, followers: 3_187_112, source: "tiktok_1" }),
    video({ url: "https://www.tiktok.com/@danielle.habel/video/5", author: "danielle.habel", views: 3_401_112, likes: 195_476, comments: 1_650, shares: 4_025, saves: 10_900, duration: 161.6, followers: 80_985, source: "tiktok_brand" }),
    video({ url: "https://www.tiktok.com/@makaylaamerie/video/6", author: "makaylaamerie", views: 2_811_917, likes: 220_300, comments: 1_359, shares: 904, saves: 3_547, duration: 7.6, followers: 1_435_770, source: "tiktok_1" }),
    video({ url: "https://www.tiktok.com/@larslavishlife/video/7", author: "larslavishlife", views: 1_508_634, likes: 80_535, comments: 339, shares: 1_107, saves: 4_933, duration: 5.5, followers: 157_709, source: "tiktok_0" }),
    video({ url: "https://www.tiktok.com/@ron.geezy/video/8", author: "ron.geezy", views: 376_313, likes: 41_990, comments: 192, shares: 70, saves: 561, duration: 7.5, followers: 1_832_281, source: "tiktok_0" }),
    video({ platform: "youtube", url: "https://www.youtube.com/shorts/abc", author: "", views: 204_000, likes: 0, comments: 0, shares: 0, saves: 0, duration: null, followers: null, media_url: null, source: "shorts" }),
    video({ platform: "instagram", url: "https://www.instagram.com/reel/xyz/", author: "blissonplate", views: 3_072, likes: 56, comments: 15, shares: 0, saves: 0, duration: 32.5, followers: null, source: "reels" }),
  ];
  const originOf = (v: Video) => (v.source === "tiktok_brand" ? "competitor" : "category");
  const ranked = scoreCandidates(videos, originOf);

  it("puts the small accounts that went viral first, ahead of bigger raw view counts", () => {
    expect(ranked.slice(0, 2).map((c) => c.author).sort()).toEqual(["aridennn15", "dusk_knight04"]);
    const rank = (author: string) => ranked.findIndex((c) => c.author === author);
    expect(rank("aridennn15")).toBeLessThan(rank("sistersisterzz")); // 10M views, but paid and a 3.4M account
    expect(rank("makaylaamerie")).toBeLessThan(rank("ron.geezy")); // both big accounts; one actually outran it
  });

  it("sinks long videos and flops of big accounts below the breakouts", () => {
    const rank = (author: string) => ranked.findIndex((c) => c.author === author);
    expect(rank("michael.dicostanzo")).toBeGreaterThan(rank("larslavishlife")); // 372 s
    expect(rank("ron.geezy")).toBeGreaterThan(rank("dusk_knight04"));
  });

  it("sorts by total, keeps every video's fields, and tags its origin", () => {
    for (let i = 1; i < ranked.length; i++) expect(ranked[i - 1].score.total).toBeGreaterThanOrEqual(ranked[i].score.total);
    const dusk = ranked.find((c) => c.author === "dusk_knight04")!;
    expect(dusk.origin).toBe("competitor");
    expect(dusk.media_url).toBe("https://cdn.example.com/video.mp4");
    expect(dusk.score.why).toMatch(/^5223x the account's followers, 9% engagement, 15 s$/);
    expect(ranked).toHaveLength(videos.length);
  });

  it("does not let one viral mega-account dominate: log scaling caps raw views", () => {
    const viralMega = scoreVideo(video({ views: 100_000_000, followers: 60_000_000, likes: 4_000_000, comments: 20_000, shares: 50_000, saves: 80_000, duration: 20 }));
    const breakout = scoreVideo(video({ views: 900_000, followers: 22_000, likes: 70_000, comments: 1_500, shares: 3_000, saves: 4_000, duration: 20 }));
    expect(breakout.total).toBeGreaterThan(viralMega.total);
  });

  it("still ranks sensibly when no follower counts are known", () => {
    const unknown = scoreCandidates(
      [
        video({ url: "https://www.instagram.com/reel/a/", author: "a", followers: null, views: 800_000, likes: 70_000, comments: 900, shares: 2_000, saves: 3_000 }),
        video({ url: "https://www.instagram.com/reel/b/", author: "b", followers: null, views: 900_000, likes: 9_000, comments: 50, shares: 20, saves: 30 }),
        video({ url: "https://www.instagram.com/reel/c/", author: "c", followers: null, views: 2_000, likes: 40, comments: 2, shares: 0, saves: 0 }),
      ],
      category,
    );
    expect(unknown.map((c) => c.author)).toEqual(["a", "b", "c"]);
    expect(unknown.every((c) => c.score.outlier === null)).toBe(true);
  });
});

describe("scoreCandidates dedupe and author cap", () => {
  it("keeps one entry per video URL, the best-scored, however the link is written", () => {
    const ranked = scoreCandidates(
      [
        video({ url: "https://www.tiktok.com/@a/video/123?is_from_webapp=1", author: "a", views: 10_000 }),
        video({ url: "https://tiktok.com/@a/video/123/", author: "a", views: 900_000 }),
        video({ url: "https://www.youtube.com/watch?v=one", author: "b" }),
        video({ url: "https://www.youtube.com/watch?v=two", author: "c" }),
      ],
      category,
    );
    expect(ranked).toHaveLength(3);
    expect(ranked.find((c) => c.author === "a")?.views).toBe(900_000);
    expect(canonicalUrl("https://www.TikTok.com/@a/video/123?lang=en#x")).toBe("tiktok.com/@a/video/123");
  });

  it("keeps at most two videos per author, ignoring case and @", () => {
    const ranked = scoreCandidates(
      [
        video({ author: "@Chef.Ana", views: 900_000 }),
        video({ author: "chef.ana", views: 800_000 }),
        video({ author: "CHEF.ANA", views: 700_000 }),
        video({ author: "other", views: 10_000 }),
        video({ author: "", views: 5_000 }),
        video({ author: "", views: 4_000 }),
        video({ author: "", views: 3_000 }),
      ],
      category,
    );
    expect(ranked.filter((c) => c.author.toLowerCase().includes("chef.ana")).map((c) => c.views)).toEqual([900_000, 800_000]);
    expect(ranked.filter((c) => c.author === "")).toHaveLength(3);
  });

  it("honours a custom author cap", () => {
    const ranked = scoreCandidates([video({ author: "x" }), video({ author: "x" }), video({ author: "y" })], category, { maxPerAuthor: 1 });
    expect(ranked.map((c) => c.author).sort()).toEqual(["x", "y"]);
  });
});

// ---------- picking ----------

function candidate(overrides: Partial<ReferenceCandidate> & { total: number }): ReferenceCandidate {
  const { total, ...rest } = overrides;
  return { ...video(rest), origin: rest.origin ?? "category", score: { outlier: 5, engagement: 0.06, total, why: "" }, ...rest } as ReferenceCandidate;
}

describe("pickForBreakdown", () => {
  it("takes the top downloadable videos of a plausible length", () => {
    const picked = pickForBreakdown(
      [
        candidate({ author: "a", total: 50, media_url: null }),
        candidate({ author: "b", total: 45, duration: 372 }),
        candidate({ author: "c", total: 40, duration: 3 }),
        candidate({ author: "d", total: 35 }),
        candidate({ author: "e", total: 30, duration: null }),
      ],
      6,
    );
    expect(picked.map((c) => c.author)).toEqual(["d", "e"]);
  });

  it("always includes the best competitor and the best category video when there are any", () => {
    const pool = [
      candidate({ author: "a1", origin: "adjacent", total: 60 }),
      candidate({ author: "a2", origin: "adjacent", total: 55 }),
      candidate({ author: "a3", origin: "ad", total: 50 }),
      candidate({ author: "cat", origin: "category", total: 20 }),
      candidate({ author: "comp", origin: "competitor", total: 10 }),
      candidate({ author: "comp2", origin: "competitor", total: 9 }),
    ];
    const picked = pickForBreakdown(pool, 3);
    expect(picked.map((c) => c.author)).toEqual(["a1", "cat", "comp"]);
  });

  it("spreads picks across authors before taking a second from anyone", () => {
    const pool = [
      candidate({ author: "same", total: 50 }),
      candidate({ author: "same", total: 49 }),
      candidate({ author: "other", total: 20 }),
      candidate({ author: "third", total: 10 }),
    ];
    expect(pickForBreakdown(pool, 3).map((c) => `${c.author}:${c.score.total}`)).toEqual(["same:50", "other:20", "third:10"]);
    expect(pickForBreakdown(pool, 4).map((c) => `${c.author}:${c.score.total}`)).toEqual(["same:50", "same:49", "other:20", "third:10"]);
  });

  it("returns at most n, best first", () => {
    const pool = Array.from({ length: 12 }, (_, i) => candidate({ author: `u${i}`, total: i }));
    const picked = pickForBreakdown(pool);
    expect(picked).toHaveLength(6);
    expect(picked.map((c) => c.score.total)).toEqual([11, 10, 9, 8, 7, 6]);
  });

  it("skips videos the brand already remade, whatever form their link takes", () => {
    const pool = [
      candidate({ author: "done", total: 50, url: "https://www.tiktok.com/@done/video/111?is_from_webapp=1" }),
      candidate({ author: "comp", origin: "competitor", total: 40, url: "https://www.tiktok.com/@comp/video/222" }),
      candidate({ author: "fresh", total: 30, url: "https://www.tiktok.com/@fresh/video/333" }),
    ];
    const exclude = ["https://m.tiktok.com/@done/video/111/", "https://www.tiktok.com/@comp/video/222"];
    expect(pickForBreakdown(pool, 6, { exclude }).map((c) => c.author)).toEqual(["fresh"]);
    expect(pickForBreakdown(pool, 6, { exclude, keepOrder: true }).map((c) => c.author)).toEqual(["fresh"]);
    expect(pickForBreakdown(pool, 6, { exclude: [] }).map((c) => c.author)).toEqual(["done", "comp", "fresh"]);
  });
});

// ---------- conversion evidence ----------

const adSignals = (over: Partial<NonNullable<Video["ad"]>> = {}): NonNullable<Video["ad"]> => ({ network: "meta", days: null, active: true, variants: null, cta: "", objective: "", ...over });

describe("conversionOf", () => {
  const typical: Baseline = { savesPerLike: 0.1, commentsPerLike: 0.02 };

  it("reads saves and comments per like against the niche, not raw likes", () => {
    // A save for every two likes, five times this niche's norm: people keep it to act on later.
    const keeper = conversionOf(video({ likes: 10_000, saves: 5_000, comments: 200 }), typical);
    // Two million likes, almost no saves: watched, not acted on.
    const viral = conversionOf(video({ views: 30_000_000, likes: 2_000_000, saves: 20_000, comments: 40_000 }), typical);
    expect(keeper.score).toBe(3);
    expect(keeper.signals).toEqual(["saves per like 5x the pool's"]);
    expect(viral.score).toBe(0);
    expect(viral.role).toBe("reach");
    // At the median: half the intent points, no questions points.
    expect(conversionOf(video({ likes: 1_000, saves: 100, comments: 20 }), typical).score).toBe(1.5);
  });

  it("needs a selling cue on top of high saves to call an organic video a converter", () => {
    const saved = video({ likes: 10_000, saves: 3_000, comments: 200, caption: "my whole agent setup, step by step" });
    expect(conversionOf(saved, typical).role).toBe("reach");
    const asks = conversionOf({ ...saved, caption: "my whole agent setup. Comment “READY” and I'll send the guide" }, typical);
    expect(asks.role).toBe("convert");
    expect(asks.signals).toContain('caption asks: "Comment “READY”"');
    const review = conversionOf(video({ likes: 1_000, saves: 100, comments: 20, paid: true, caption: "honest review after a month" }), typical);
    expect(review.signals).toEqual(["saves per like 1x the pool's", 'caption: "honest"', "paid partnership"]);
    expect(review.role).toBe("convert");
  });

  it("ignores missing saves and comments rather than counting them against the video", () => {
    const reel = conversionOf(video({ platform: "instagram", likes: 5_000, saves: 0, comments: 0, shares: 0 }), typical);
    expect(reel).toEqual({ score: 0, role: "reach", signals: [] });
  });

  it("scores an ad on how long it ran, how many ads reuse it and its button", () => {
    const veteran = conversionOf(video({ views: 0, likes: 0, saves: 0, comments: 0, paid: true, ad: adSignals({ days: 94, variants: 4, cta: "Shop now" }) }), typical);
    expect(veteran.role).toBe("convert");
    expect(veteran.score).toBe(8); // 1 ad + 4 longevity + 2 variants + 1 button
    expect(veteran.signals).toEqual(["Meta ad", "ran 94 days, still running", "4 ads use this creative", "button: Shop now"]);
    const fresh = conversionOf(video({ views: 0, likes: 0, ad: adSignals({ days: 3, cta: "Learn more" }) }), typical);
    expect(fresh).toEqual({ score: 1, role: "convert", signals: ["Meta ad"] });
    const month = conversionOf(video({ views: 0, likes: 0, ad: adSignals({ days: 30 }) }), typical).score;
    expect(month).toBeCloseTo(1 + 4 * (Math.log2(30 / 7) / Math.log2(90 / 7)), 1);
    const top = conversionOf(video({ views: 0, likes: 50_000, ad: adSignals({ network: "tiktok", active: null, objective: "conversions" }) }), typical);
    expect(top.signals).toEqual(["TikTok ad", "TikTok top ad bought for conversions"]);
  });
});

describe("the pool baseline", () => {
  it("uses the pool's median once it has enough measured videos, and a default before", () => {
    const pool = Array.from({ length: 9 }, (_, i) => video({ likes: 1_000, saves: 100 * (i + 1), comments: 10 }));
    expect(poolBaseline(pool)).toEqual({ savesPerLike: 0.5, commentsPerLike: 0.01 });
    expect(poolBaseline(pool.slice(0, 3))).toEqual(DEFAULT_BASELINE);
  });

  it("ranks a niche's converters against that niche", () => {
    // Dev tutorials: a save for every three likes is normal, so 0.4 is not special there.
    const devPool = Array.from({ length: 10 }, (_, i) => video({ url: `https://www.tiktok.com/@d${i}/video/${i}`, author: `d${i}`, likes: 10_000, saves: 3_300, comments: 150 }));
    const candidate = video({ url: "https://www.tiktok.com/@x/video/1", author: "x", likes: 10_000, saves: 4_000, comments: 150 });
    const inDev = scoreCandidates([...devPool, candidate], category).find((c) => c.author === "x")!;
    const alone = scoreCandidates([candidate], category)[0];
    expect(inDev.score.conversion!).toBeLessThan(alone.score.conversion!);
  });
});

describe("ads in the candidate pool", () => {
  it("are always the ad lane, explained by their run, and never collapse into one library link", () => {
    const ads = [
      video({ url: "https://www.facebook.com/ads/library/?id=111", author: "Poppi", views: 0, likes: 0, saves: 0, comments: 0, shares: 0, followers: null, paid: true, duration: null, source: "meta_ads_comp_0", ad: adSignals({ days: 60 }) }),
      video({ url: "https://www.facebook.com/ads/library/?id=222", author: "Poppi", views: 0, likes: 0, saves: 0, comments: 0, shares: 0, followers: null, paid: true, duration: 20, source: "meta_ads_comp_0", ad: adSignals({ days: 5 }) }),
    ];
    const ranked = scoreCandidates(ads, category);
    expect(ranked).toHaveLength(2);
    expect(ranked.every((c) => c.origin === "ad" && c.score.role === "convert")).toBe(true);
    expect(ranked.find((c) => c.url.endsWith("111"))!.score.why).toBe("Meta ad, ran 60 days, length unknown");
    expect(canonicalUrl("https://library.tiktok.com/ads/detail/?ad_id=99&lang=en")).toBe("library.tiktok.com/ads/detail?ad_id=99");
  });
});

describe("pickForBreakdown for a funnel mix", () => {
  const scored = (over: Partial<ReferenceCandidate> & { total: number; role?: "reach" | "convert"; conversion?: number }) => {
    const { total, role = "reach", conversion = 0, ...rest } = over;
    return { ...video(rest), origin: rest.origin ?? "category", score: { outlier: 5, engagement: 0.05, total, why: "", role, conversion, signals: [] }, ...rest } as ReferenceCandidate;
  };

  it("reserves two convert and two reach references, converters by evidence even when their reach is low", () => {
    const pool = [
      scored({ author: "r1", total: 60 }),
      scored({ author: "r2", total: 55 }),
      scored({ author: "r3", total: 50 }),
      scored({ author: "r4", total: 45 }),
      scored({ author: "c-weak", total: 40, role: "convert", conversion: 3.6 }),
      scored({ author: "ad-strong", origin: "ad", total: 3, role: "convert", conversion: 8, duration: null }),
      scored({ author: "c-mid", total: 30, role: "convert", conversion: 5 }),
    ];
    const picked = pickForBreakdown(pool, 4);
    expect(picked.map((c) => c.author).sort()).toEqual(["ad-strong", "c-mid", "r1", "r2"]);
    expect(pickForBreakdown(pool, 2).map((c) => c.author).sort()).toEqual(["ad-strong", "r1"]);
  });

  it("only picks references whose footage it can download", () => {
    const pool = [scored({ author: "gone", total: 10, role: "convert", conversion: 9, media_url: null }), scored({ author: "here", total: 5, role: "convert", conversion: 4 })];
    expect(pickForBreakdown(pool, 2).map((c) => c.author)).toEqual(["here"]);
  });

  it("prefers the shorter of two close converters: every second of a remake is rendered", () => {
    // 5 points at 75 s is 2 after the cost of 30 extra seconds; 4.5 at 30 s keeps all of it.
    const pool = [scored({ author: "long", total: 10, role: "convert", conversion: 5, duration: 75 }), scored({ author: "short", total: 9, role: "convert", conversion: 4.5, duration: 30 }), scored({ author: "reach", total: 50 })];
    expect(pickForBreakdown(pool, 2).map((c) => c.author)).toEqual(["reach", "short"]);
  });

  it("takes a lane's next author rather than a second video from someone already picked", () => {
    const pool = [scored({ author: "same", origin: "adjacent", total: 60 }), scored({ author: "same", origin: "competitor", total: 50 }), scored({ author: "rival", origin: "competitor", total: 40 })];
    expect(pickForBreakdown(pool, 2).map((c) => c.author)).toEqual(["same", "rival"]);
  });
});

describe("referenceRole", () => {
  const anatomy = { role: "convert" as const, structure: "demo" as const, problem: "", proof: "", offer: "", cta: "link in bio", objection: "" };
  it("trusts ad origin and conversion evidence, else a video built to sell that asks for the click", () => {
    expect(referenceRole({ origin: "ad", score: { outlier: null, engagement: 0, total: 0, why: "" } }, undefined)).toBe("convert");
    expect(referenceRole({ origin: "category", score: { outlier: 3, engagement: 0.1, total: 30, why: "", role: "convert" } }, undefined)).toBe("convert");
    expect(referenceRole({ origin: "category", score: { outlier: 3, engagement: 0.1, total: 30, why: "", role: "reach" } }, anatomy)).toBe("convert");
    expect(referenceRole({ origin: "category", score: { outlier: 3, engagement: 0.1, total: 30, why: "", role: "reach" } }, { ...anatomy, cta: "" })).toBe("reach");
    expect(referenceRole({ origin: "benchmark", score: { outlier: 300, engagement: 0.1, total: 60, why: "" } }, { ...anatomy, role: "reach" })).toBe("reach");
  });
});

// ---------- pure helpers ----------

describe("frameTimes", () => {
  it("takes a frame just after every cut and fills the longest gaps", () => {
    const times = frameTimes(7, [2, 4, 5.5], 10);
    expect(times).toHaveLength(5); // 7 s / 1.5 s per frame
    expect(times.filter((t) => t.opensShot).map((t) => t.shot)).toEqual([1, 2, 3, 4]);
    expect(times[0].at).toBeCloseTo(0.2, 2);
    expect(times.find((t) => t.shot === 2 && t.opensShot)?.at).toBeCloseTo(2.4, 2);
    for (let i = 1; i < times.length; i++) expect(times[i].at).toBeGreaterThan(times[i - 1].at);
    expect(times.every((t) => t.at < 7)).toBe(true);
  });

  it("never exceeds the frame budget and keeps the first and last shot when there are many cuts", () => {
    const cuts = Array.from({ length: 29 }, (_, i) => (i + 1) * 2);
    const times = frameTimes(60, cuts, 10);
    expect(times).toHaveLength(10);
    expect(times[0].shot).toBe(1);
    expect(times[times.length - 1].shot).toBe(30);
    expect(times.every((t) => t.opensShot)).toBe(true);
  });

  it("spreads frames over a single long shot", () => {
    const times = frameTimes(30, [], 10);
    expect(times).toHaveLength(10);
    expect(times.every((t) => t.shot === 1)).toBe(true);
    expect(times[times.length - 1].at).toBeGreaterThan(25);
  });
});

describe("wordsPerMinute", () => {
  it("counts words over the time someone is actually talking, not silent stretches", () => {
    const segments = [
      { start_seconds: 1, end_seconds: 4, text: "one two three four five" },
      { start_seconds: 12, end_seconds: 14, text: "six seven eight nine ten" },
    ];
    // 10 words in 3 + 2 = 5 s of talking; the silent 4-12 s B-roll does not count.
    expect(wordsPerMinute("one two three four five six seven eight nine ten", segments, 20)).toBe(120);
    // overlapping segments are merged, not counted twice
    expect(wordsPerMinute("a b c d e f", [{ start_seconds: 0, end_seconds: 2, text: "a b c" }, { start_seconds: 1, end_seconds: 3, text: "d e f" }], 3)).toBe(120);
    expect(wordsPerMinute("one two three", [], 6)).toBe(30);
    expect(wordsPerMinute("", [], 6)).toBeNull();
    expect(wordsPerMinute("— ...", [], 6)).toBeNull();
  });
});

describe("readBreakdown", () => {
  const segments = [
    { start_seconds: 0, end_seconds: 1.9, text: "Okay so nobody tells you this." },
    { start_seconds: 2, end_seconds: 3.9, text: "I used to spend forty minutes on it." },
  ];
  const context = { duration: 4, transcript: "Okay so nobody tells you this. I used to spend forty minutes on it.", segments };

  it("throws a retryable ApiError when no beat survives", () => {
    const error = (() => {
      try {
        readBreakdown({ beats: [{ start: "x" }] }, context);
      } catch (e) {
        return e;
      }
    })();
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).retryable).toBe(true);
  });

  it("tolerates curly quotes and punctuation differences in a verbatim line", () => {
    const read = readBreakdown(
      {
        hook: { line: "okay so NOBODY tells you this" },
        beats: [
          { start: 0, end: 2, job: "hook", shot: "talking_head", line: "Okay so nobody tells you this" },
          { start: 2, end: 4, job: "problem", shot: "talking_head", line: "I used to spend forty minutes on it" },
        ],
        fit: { score: "7" },
      },
      context,
    );
    expect(read.hook.line).toBe("okay so NOBODY tells you this");
    expect(read.beats.map((b) => b.line)).toEqual(["Okay so nobody tells you this", "I used to spend forty minutes on it"]);
    expect(read.fit.score).toBe(7);
    expect(read.caption_style).toBe("none");
  });
});

describe("referenceId", () => {
  it("is stable across ways of writing the same link", () => {
    expect(referenceId("https://www.tiktok.com/@a/video/1?x=1")).toBe(referenceId("https://tiktok.com/@a/video/1/"));
    expect(referenceId("https://tiktok.com/@a/video/1")).toMatch(/^ref_[0-9a-f]{10}$/);
  });
});

// ---------- the breakdown, on a real synthetic video ----------

const bin = await ffmpegPath();

describe.skipIf(!bin)("breakdownReference on a synthetic video with three hard cuts", () => {
  let root: string;
  let clip: string;
  let silent: string;
  const CUTS = [2, 4, 5.5];

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "nomen-ref-test-"));
    clip = join(root, "source.mp4");
    silent = join(root, "silent.mp4");
    // Four visually distinct shots (2 + 2 + 1.5 + 1.5 s) over a tone: hard cuts at 2, 4 and 5.5 s.
    const shots = ["color=c=black:s=360x640:d=2:r=30", "smptebars=s=360x640:d=2:r=30", "color=c=white:s=360x640:d=1.5:r=30", "testsrc2=s=360x640:d=1.5:r=30"];
    const inputs = shots.flatMap((shot) => ["-f", "lavfi", "-i", shot]);
    const filter = "[0:v][1:v][2:v][3:v]concat=n=4:v=1:a=0,format=yuv420p[v]";
    await exec(bin!, ["-hide_banner", "-loglevel", "error", "-y", ...inputs, "-f", "lavfi", "-i", "sine=frequency=440:duration=7", "-filter_complex", filter, "-map", "[v]", "-map", "4:a", "-c:v", "libx264", "-c:a", "aac", "-shortest", clip]);
    await exec(bin!, ["-hide_banner", "-loglevel", "error", "-y", ...inputs, "-filter_complex", filter, "-map", "[v]", "-c:v", "libx264", silent]);
  }, 60_000);

  afterAll(async () => {
    vi.unstubAllGlobals();
    await rm(root, { recursive: true, force: true });
  });

  const brand = { name: "Lunchly", one_liner: "Meal-prep containers that keep lunches cold for 8 hours", kind: "physical" };

  const segments = [
    { start_seconds: 0, end_seconds: 1.9, text: "Okay so nobody tells you this about packing lunches." },
    { start_seconds: 2, end_seconds: 3.9, text: "I used to spend forty minutes every Sunday." },
    { start_seconds: 4, end_seconds: 5.4, text: "Now it takes me ten." },
    { start_seconds: 5.5, end_seconds: 6.9, text: "Link is in my bio." },
  ];
  const transcriptText = segments.map((s) => s.text).join(" ");

  const job = (status: Transcription["status"], withResult = true): Transcription => ({
    id: "med_1",
    object: "media_job",
    kind: "transcription",
    status,
    model: "stt/auto",
    input: {},
    result: withResult ? { text: transcriptText, language: "en", duration_seconds: 7, segments } : null,
    error: status === "failed" ? { code: "provider_error", message: "the provider failed" } : null,
    cost_micro_usd: withResult ? 120 : null,
    session_id: null,
    created_at: "2026-11-07T10:00:00Z",
    completed_at: withResult ? "2026-11-07T10:00:01Z" : null,
  });

  const toolInput = {
    format: "talking head to a propped-up phone, hard cuts every 1.5-2 s, bold captions",
    hook: { line: "Okay so nobody tells you this about packing lunches.", on_screen_text: "NOBODY TELLS YOU THIS", visual: "black frame, then her face close to the lens", mechanic: "promises insider knowledge the viewer is missing" },
    beats: [
      { start: 0, end: 2, job: "hook", shot: "talking_head", visual: "dark opening frame", on_screen_text: "NOBODY TELLS YOU THIS", line: "Okay so nobody tells you this about packing lunches." },
      // Paraphrased ("40" for "forty"): must be replaced by the transcript's own words.
      { start: 2, end: 4, job: "problem", shot: "b_roll", visual: "colour bars", on_screen_text: "", line: "I used to spend 40 minutes every Sunday" },
      { start: 4, end: 5.5, job: "magic", shot: "hologram", visual: "white frame", on_screen_text: "", line: "Now it takes me ten." },
      // A gap from 5.5 to 5.6 and an early end: beats must still cover 0-7 s.
      { start: 5.6, end: 6.5, job: "cta", shot: "text_only", visual: "test pattern", on_screen_text: "link in bio", line: "Link is in my bio." },
    ],
    caption_style: "white bold, black outline, centre, 2-3 words at a time",
    delivery: "fast, conversational, a little exasperated",
    why_it_works: "Opens on a promise of a secret, then pays it off with a concrete number.",
    conversion: { role: "convert", structure: "before_after", problem: "I used to spend forty minutes every Sunday.", proof: "Now it takes me ten.", offer: "", cta: "Link is in my bio.", objection: "" },
    fit: { score: 14, reason: "Same before/after structure works for the containers." },
  };

  function stubClient(overrides: Partial<Record<keyof BreakdownClient, unknown>> = {}) {
    const uploads: Array<{ name: string; contentType: string; size: number }> = [];
    const client = {
      uploadFile: vi.fn(async (name: string, contentType: string, bytes: Buffer) => {
        uploads.push({ name, contentType, size: bytes.length });
        return "fil_audio1";
      }),
      transcribe: vi.fn(async () => job("processing", false)),
      getTranscription: vi.fn(async () => job("completed")),
      message: vi.fn(async () => ({ content: [{ type: "tool_use", name: "reference_breakdown", input: toolInput }], stop_reason: "tool_use" })),
      ...overrides,
    } as unknown as BreakdownClient & Record<keyof BreakdownClient, ReturnType<typeof vi.fn>>;
    return { client, uploads };
  }

  const reference = (media_url: string | null, overrides: Partial<Video> = {}): ReferenceCandidate => {
    const base = video({ url: "https://www.tiktok.com/@lunchqueen/video/777", author: "lunchqueen", views: 410_000, followers: 10_000, likes: 30_000, comments: 900, shares: 2_000, saves: 1_500, duration: 7, media_url, ...overrides });
    return { ...base, origin: "category", score: scoreVideo(base) };
  };

  it("detects the hard cuts", async () => {
    const cuts = await detectCuts(clip, 0.3, 7);
    expect(cuts).toHaveLength(3);
    cuts.forEach((cut, i) => expect(Math.abs(cut - CUTS[i])).toBeLessThan(0.1));
  });

  it("transcribes, frames and maps the model's breakdown into the contract", async () => {
    const work = join(root, "work-main");
    const { client, uploads } = stubClient();
    const breakdown = await breakdownReference(client, reference(clip), { workDir: work, brand, pollMs: 1 });

    // pacing from ffmpeg
    expect(breakdown.duration).toBe(7);
    expect(breakdown.pacing.cuts).toBe(3);
    expect(breakdown.pacing.avg_shot_seconds).toBeCloseTo(1.8, 1);
    expect(breakdown.pacing.words_per_minute).toBe(Math.round(27 / ((1.9 + 1.9 + 1.4 + 1.4) / 60)));

    // speech to text: the audio went up to Files, was transcribed with timestamps, and polled
    expect(uploads).toHaveLength(1);
    expect(uploads[0].contentType).toBe("audio/mpeg");
    expect(uploads[0].size).toBeGreaterThan(1000);
    expect(client.transcribe).toHaveBeenCalledWith({ file_id: "fil_audio1", model: "stt/auto", timestamps: true, language: "en" }, "nomen-ref-stt-fil_audio1");
    expect(client.getTranscription).toHaveBeenCalledWith("med_1");
    expect(breakdown.transcript).toBe(transcriptText);

    // one vision call with labelled frames, the transcript, the cuts and the brand
    expect(client.message).toHaveBeenCalledTimes(1);
    const request = client.message.mock.calls[0][0] as { model: string; system: string; tools: Array<{ name: string }>; messages: Array<{ content: Array<{ type: string; text?: string }> }> };
    expect(request.model).toBe(QC_MODEL);
    expect(request.tools[0].name).toBe("reference_breakdown");
    expect(request.system).toMatch(/word for word from the transcript/);
    expect(request.system).toMatch(/never reuses this video's people, footage, voice or music/);
    expect(request.system).toMatch(/capture every line, beat and on-screen text exactly/);
    const content = request.messages[0].content;
    const images = content.filter((block) => block.type === "image");
    expect(images.length).toBeGreaterThanOrEqual(4);
    expect(images.length).toBeLessThanOrEqual(10);
    const labels = content.filter((block) => block.type === "text" && /^Frame \d+ of \d+: \d+\.\d s, shot \d of 4/.test(block.text ?? ""));
    expect(labels).toHaveLength(images.length);
    expect(labels[0].text).toBe(`Frame 1 of ${images.length}: 0.2 s, shot 1 of 4 (the opening frame).`);
    expect(labels.filter((label) => label.text?.includes("just after the cut that opens it"))).toHaveLength(3);
    const brief = content[content.length - 2].text ?? "";
    expect(brief).toContain("Hard cuts detected at: 2.0, 4.0, 5.5 s, so 4 shots");
    expect(brief).toContain("[0.0-1.9] Okay so nobody tells you this about packing lunches.");
    expect(brief).toContain("41x the account's followers");
    expect(brief).toContain("Lunchly: Meal-prep containers that keep lunches cold for 8 hours (a physical product)");
    expect(brief).not.toContain("cdn.example.com");
    expect(content[content.length - 1].text).toBe("Call the reference_breakdown tool once.");

    // the tool output, made safe
    expect(breakdown.id).toBe(referenceId("https://www.tiktok.com/@lunchqueen/video/777"));
    expect(breakdown).toMatchObject({ url: "https://www.tiktok.com/@lunchqueen/video/777", platform: "tiktok", author: "lunchqueen", views: 410_000, followers: 10_000, outlier: 41 });
    expect(breakdown.format).toBe(toolInput.format);
    expect(breakdown.hook).toEqual(toolInput.hook);
    expect(breakdown.beats.map((b) => [b.start, b.end])).toEqual([
      [0, 2],
      [2, 4],
      [4, 5.5],
      [5.5, 7],
    ]);
    expect(breakdown.beats.map((b) => b.job)).toEqual(["hook", "problem", "other", "cta"]);
    expect(breakdown.beats.map((b) => b.shot)).toEqual(["talking_head", "b_roll", "b_roll", "text_only"]);
    expect(breakdown.beats[1].line).toBe("I used to spend forty minutes every Sunday.");
    expect(breakdown.beats[3]).toMatchObject({ on_screen_text: "link in bio", line: "Link is in my bio." });
    expect(breakdown.caption_style).toBe(toolInput.caption_style);
    expect(breakdown.fit).toEqual({ score: 10, reason: toolInput.fit.reason });

    // how it sells: the numbers say reach, but the video is built to sell and asks for the click
    expect(brief).toContain("conversion evidence");
    expect(breakdown.anatomy).toEqual(toolInput.conversion);
    expect(breakdown.origin).toBe("category");
    expect(breakdown.role).toBe("convert");
    expect(breakdown.conversion).toEqual({ score: reference(clip).score.conversion, signals: reference(clip).score.signals });

    // the scratch folder is gone; the source file is untouched
    expect(await readdir(work)).toEqual([]);
    expect(existsSync(clip)).toBe(true);
  }, 60_000);

  it("accepts a file: URL", async () => {
    const { client } = stubClient({ transcribe: vi.fn(async () => job("completed")) });
    const breakdown = await breakdownReference(client, reference(pathToFileURL(clip).href), { workDir: join(root, "work-file-url"), brand });
    expect(breakdown.pacing.cuts).toBe(3);
    expect(client.getTranscription).not.toHaveBeenCalled();
  }, 60_000);

  it("falls back to plain JSON when the model fumbles the tool call", async () => {
    const message = vi
      .fn()
      .mockRejectedValueOnce(new ApiError("naive", 502, "provider_error", "the model returned a malformed tool call"))
      .mockResolvedValueOnce({ content: [{ type: "text", text: `Here it is:\n${JSON.stringify(toolInput)}` }], stop_reason: "end_turn" });
    const { client } = stubClient({ message, transcribe: vi.fn(async () => job("completed")) });
    const breakdown = await breakdownReference(client, reference(clip), { workDir: join(root, "work-json"), brand });
    expect(message).toHaveBeenCalledTimes(2);
    expect(message.mock.calls[1][0].tools).toBeUndefined();
    expect(message.mock.calls[1][0].messages[0].content.at(-1).text).toMatch(/^Answer with only a JSON object/);
    expect(breakdown.beats).toHaveLength(4);
  }, 60_000);

  it("throws a retryable ApiError when the model returns nothing usable", async () => {
    const message = vi.fn(async () => ({ content: [{ type: "text", text: "Sorry, I can't." }], stop_reason: "end_turn" }));
    const { client } = stubClient({ message, transcribe: vi.fn(async () => job("completed")) });
    const work = join(root, "work-unreadable");
    const error = await breakdownReference(client, reference(clip), { workDir: work, brand }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe("breakdown_unreadable");
    expect((error as ApiError).retryable).toBe(true);
    expect(await readdir(work)).toEqual([]);
  }, 60_000);

  it("throws a retryable ApiError when the transcription fails upstream", async () => {
    const { client } = stubClient({ transcribe: vi.fn(async () => job("failed", false)) });
    const error = await breakdownReference(client, reference(clip), { workDir: join(root, "work-stt-failed"), brand }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).retryable).toBe(true);
    expect(client.message).not.toHaveBeenCalled();
  }, 60_000);

  it("skips speech to text for a video with no audio track", async () => {
    const { client } = stubClient();
    const breakdown = await breakdownReference(client, reference(silent), { workDir: join(root, "work-silent"), brand });
    expect(client.uploadFile).not.toHaveBeenCalled();
    expect(client.transcribe).not.toHaveBeenCalled();
    expect(breakdown.pacing.words_per_minute).toBeNull();
    expect(breakdown.transcript).toBe("");
    expect(breakdown.beats.every((b) => b.line === "")).toBe(true);
    expect(breakdown.hook.line).toBe("");
  }, 60_000);

  it("throws a clear, non-retryable error when the video cannot be downloaded", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("gone", { status: 403 })),
    );
    const { client } = stubClient();
    const work = join(root, "work-404");
    const error = await breakdownReference(client, reference("https://cdn.example.com/expired.mp4"), { workDir: work, brand }).catch((e: unknown) => e);
    vi.unstubAllGlobals();
    expect(error).toBeInstanceOf(ReferenceUnavailableError);
    expect((error as ReferenceUnavailableError).retryable).toBe(false);
    expect((error as Error).message).toMatch(/could not be downloaded.*HTTP 403/);
    expect(client.uploadFile).not.toHaveBeenCalled();
    expect(await readdir(work)).toEqual([]);
  });

  it("breaks down several references three at a time and reports failures separately", async () => {
    // In flight from the audio upload to the end of the vision call: most of each breakdown.
    let inFlight = 0;
    let peak = 0;
    const { client } = stubClient({
      uploadFile: vi.fn(async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        return "fil_audio1";
      }),
      transcribe: vi.fn(async () => job("completed")),
      message: vi.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 200));
        inFlight--;
        return { content: [{ type: "tool_use", name: "reference_breakdown", input: toolInput }], stop_reason: "tool_use" };
      }),
    });
    const candidates = [
      reference(clip, { url: "https://www.tiktok.com/@a/video/1", author: "a" }),
      reference(join(root, "missing.mp4"), { url: "https://www.tiktok.com/@b/video/2", author: "b" }),
      reference(clip, { url: "https://www.tiktok.com/@c/video/3", author: "c" }),
      reference(clip, { url: "https://www.tiktok.com/@d/video/4", author: "d" }),
      reference(clip, { url: "https://www.tiktok.com/@e/video/5", author: "e" }),
    ];
    const { breakdowns, failures } = await breakdownAll(client, candidates, { workDir: join(root, "work-all"), brand });
    expect(breakdowns.map((b) => b.author)).toEqual(["a", "c", "d", "e"]);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ retryable: false });
    expect(failures[0].candidate.author).toBe("b");
    expect(failures[0].error).toMatch(/could not be downloaded/);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(3);
  }, 120_000);
});
