import { describe, expect, it } from "vitest";
import { beatTimes, buildTimeline, groupShots, planProduction, snapSeconds, speakSeconds } from "@/lib/creative/plan";
import { fallbackBrief, toBrief } from "@/lib/creative/product";
import { cleanReport, hashtags, scoutDigest, scoutSpecs } from "@/lib/creative/scout";
import { lintScript, normalizeScript, type ScriptContext, targetSeconds, writeScript } from "@/lib/creative/script";
import type { CreativeBrief, ProductBrief, ReferenceBreakdown, Script } from "@/lib/creative/types";
import { compactResearch, phaseCSpecs, platformOfRun, type ResearchPack, type ResearchPlan, roughScore, type Video } from "@/lib/research";
import { conceptFrom } from "@/lib/strategy";

const product: ProductBrief = {
  name: "Monid",
  one_liner: "One balance that pays for every API your agent uses",
  kind: "software",
  audience: "developers building AI agents",
  problem: "every tool needs its own sign-up, key and bill",
  aha: "you add one skill line and the agent finds and pays for the tool itself",
  features: [{ name: "Tool search", what_it_does: "finds the right API", how_to_show_it: "the tools page" }],
  claims: ["2,000+ tools behind one API", "pay per call", "$1 of free credit"],
  proof: [],
  objections: ["is it more expensive per call"],
  offer: "$1 free credit",
  voice: "dry, technical",
  look: "a dark dashboard with a ranked list of tools",
  visuals: [
    { id: "s1", kind: "screenshot", url: "/tmp/s1.png", caption: "homepage", source: "capture", width: 430, height: 2400 },
    { id: "s2", kind: "screenshot", url: "/tmp/s2.png", caption: "tools page", source: "capture", width: 430, height: 932 },
  ],
};

const reference: ReferenceBreakdown = {
  id: "ref_1",
  url: "https://tiktok.com/@dev/video/1",
  platform: "tiktok",
  author: "dev",
  views: 900_000,
  followers: 12_000,
  outlier: 75,
  duration: 19,
  format: "talking head with screen cutaways",
  hook: { line: "Stop paying for twelve different API keys", on_screen_text: "12 API keys??", visual: "creator deadpan", mechanic: "absurd number + command" },
  beats: [
    { start: 0, end: 2.5, job: "hook", shot: "talking_head", visual: "creator", on_screen_text: "12 API keys??", line: "Stop paying for twelve different API keys" },
    { start: 2.5, end: 9, job: "demo", shot: "screen", visual: "dashboard", on_screen_text: "", line: "this thing finds the tool and pays per call for you" },
    { start: 9, end: 19, job: "cta", shot: "talking_head", visual: "creator", on_screen_text: "", line: "go try it before your bill does" },
  ],
  pacing: { cuts: 4, avg_shot_seconds: 4.7, words_per_minute: 160 },
  caption_style: "white bold",
  delivery: "deadpan, fast",
  why_it_works: "absurd number in the hook",
  fit: { score: 9, reason: "same buyer" },
  transcript: "Stop paying for twelve different API keys. this thing finds the tool and pays per call for you. go try it before your bill does",
};

const brief: CreativeBrief = {
  title: "Twelve keys",
  reference_id: "ref_1",
  format: "talking_head_broll",
  angle: "absurd number",
  audience: "agent builders",
  hook_plan: "absurd number of sign-ups",
  keep: ["pacing"],
  change: ["topic"],
  visuals: ["s2", "s1"],
  creator: "A woman in her late 20s with a dark bob and a grey hoodie, deadpan",
  setting: "a small home office in the evening, warm lamp light",
  platforms: ["tiktok"],
  caption: "one balance",
  hashtags: ["#ai"],
  cta: "try it",
  why: "75x outlier",
};

const ctx: ScriptContext = { product, brief, reference, targetSeconds: 18 };

const goodBeats = [
  { n: 1, job: "hook", seconds: 3, line: "My agent needed nine sign-ups this week.", on_screen_text: "9 sign-ups. For one agent.", visual: "creator", product_visual: null, direction: "deadpan, slight eyebrow raise" },
  { n: 2, job: "demo", seconds: 6, line: "Now it searches the tools page, picks one, and pays per call.", on_screen_text: "", visual: "product", product_visual: "s2", direction: "slow push in" },
  { n: 3, job: "reveal", seconds: 5, line: "Over 2,000+ tools behind one API. One balance.", on_screen_text: "", visual: "product", product_visual: "s1", direction: "slow scroll down" },
  { n: 4, job: "cta", seconds: 4, line: "There's a dollar of free credit. Go poke at it.", on_screen_text: "", visual: "creator", product_visual: null, direction: "small smile" },
] as const;

describe("script normalizing and linting", () => {
  it("keeps a clean, human script clean", () => {
    const script = normalizeScript(goodBeats.map((b) => ({ ...b })), ctx);
    expect(script.total_seconds).toBe(18);
    expect(lintScript(script, ctx)).toEqual([]);
  });

  it("forces format rules and valid visual ids", () => {
    const faceless = normalizeScript(
      goodBeats.map((b) => ({ ...b, product_visual: b.product_visual === "s1" ? "nope" : b.product_visual })),
      { ...ctx, brief: { ...brief, format: "voiceover_demo" } },
    );
    expect(faceless.beats.every((b) => b.visual === "product")).toBe(true);
    expect(faceless.beats.every((b) => b.product_visual === "s2" || b.product_visual === "s1")).toBe(true);
    expect(faceless.beats.find((b) => b.n === 3)?.product_visual).toBe("s2"); // unknown id falls back to the brief's first visual
  });

  it("strips em dashes and clamps beat lengths", () => {
    const script = normalizeScript([{ n: 1, job: "hook", seconds: 30, line: "wait — what", on_screen_text: "", visual: "creator", product_visual: null, direction: "" }], ctx);
    expect(script.beats[0].seconds).toBe(8);
    expect(script.beats[0].line).toBe("wait, what");
  });

  it("catches ad copy, fake testimonials, invented numbers, their handle, fast talking and a missing product", () => {
    const bad = normalizeScript(
      [
        { n: 1, job: "hook", seconds: 2, line: "Monid is a total game changer for every single developer on earth today honestly", on_screen_text: "", visual: "creator", product_visual: null, direction: "" },
        { n: 2, job: "demo", seconds: 3, line: "I've been using it for 3 months, shout out to @dev", on_screen_text: "", visual: "creator", product_visual: null, direction: "" },
        { n: 3, job: "proof", seconds: 2, line: "It saves 90% instantly", on_screen_text: "", visual: "creator", product_visual: null, direction: "" },
        { n: 4, job: "other", seconds: 2, line: "ok", on_screen_text: "", visual: "creator", product_visual: null, direction: "" },
        { n: 5, job: "cta", seconds: 2, line: "go", on_screen_text: "", visual: "creator", product_visual: null, direction: "" },
      ],
      ctx,
    );
    const issues = lintScript(bad, ctx).join(" | ");
    expect(issues).toMatch(/game changer/);
    expect(issues).toMatch(/personal-history claim/);
    expect(issues).toMatch(/"90%" is not in the product brief/);
    expect(issues).toMatch(/handle or name "dev"/);
    expect(issues).toMatch(/too fast/);
    expect(issues).toMatch(/5 beats vs the reference's 3/);
    expect(issues).toMatch(/product is never on screen/);
    expect(issues).toMatch(/total 11s vs the reference's 18s/);
  });

  it("lets a remake keep the reference's own wording and phrases", () => {
    const viral = { ...reference, transcript: `${reference.transcript} trust me`, beats: reference.beats.map((b, i) => (i === 0 ? { ...b, line: "Trust me, stop paying for twelve different API keys" } : b)) };
    const remake = normalizeScript(
      goodBeats.map((b, i) => ({ ...b, line: i === 0 ? "Trust me, stop paying for twelve different API keys" : b.line })),
      { ...ctx, reference: viral },
    );
    expect(lintScript(remake, { ...ctx, reference: viral })).toEqual([]);
  });

  it("aims for the reference's length, capped at 24 s with a face and 40 s without", () => {
    expect(targetSeconds({ duration: 19 })).toBe(19);
    expect(targetSeconds({ duration: 61 })).toBe(40);
    expect(targetSeconds({ duration: 61 }, "talking_head_broll")).toBe(24);
    expect(targetSeconds({ duration: 5 })).toBe(8);
  });
});

describe("the critic", () => {
  it("records an unavailable critic honestly instead of inventing a score", async () => {
    let calls = 0;
    const naive = {
      message: async () => {
        calls++;
        if (calls === 1) return { stop_reason: "tool_use", content: [{ type: "tool_use", name: "script", input: { beats: goodBeats.map((b) => ({ ...b })) } }] };
        return { stop_reason: "max_tokens", content: [{ type: "text", text: "{ cut off" }] };
      },
    } as unknown as Parameters<typeof writeScript>[0];
    const script = await writeScript(naive, ctx);
    expect(calls).toBe(3); // writer, critic, the critic's plain-JSON retry
    expect(script.review).toMatchObject({ score: 0, rounds: 1 });
    expect(script.review?.notes).toContain("critic unavailable: no review came back");
  });
});

describe("shot planning and the timeline", () => {
  const script: Script = normalizeScript(goodBeats.map((b) => ({ ...b })), ctx);

  it("packs beats into video-model shots of 4, 6 or 8 seconds", () => {
    expect(groupShots(script).map((shot) => shot.map((b) => b.n))).toEqual([[1], [2], [3], [4]]);
    expect([3, 4.2, 4.5, 5, 6, 7.9, 8].map(snapSeconds)).toEqual([4, 4, 6, 6, 6, 8, 8]);
  });

  it("sizes shots by how long the words take to say, so no line gets cut off", () => {
    const fast = normalizeScript(
      [
        { n: 1, job: "hook", seconds: 5, line: "Everybody's giving their AI agents tools right now, but the setup, it's a sign-up and an API key for every single one.", on_screen_text: "", visual: "creator", product_visual: null, direction: "" },
        { n: 2, job: "reveal", seconds: 2, line: "Give me one minute, and I'll show you all of it.", on_screen_text: "", visual: "creator", product_visual: null, direction: "" },
      ],
      ctx,
    );
    expect(speakSeconds(fast.beats[0])).toBeCloseTo(22 / 3.4);
    expect(groupShots(fast).map((shot) => shot.map((b) => b.n))).toEqual([[1], [2]]); // 6.5 s + 3.2 s would not fit one 8 s shot
    expect(planProduction(fast, brief, product).aroll.map((shot) => shot.seconds)).toEqual([8, 4]);
  });

  it("has the creator say every line on camera, with the product cut in over the voice", () => {
    const plan = planProduction(script, brief, product);
    expect(plan.aroll.map((shot) => shot.line).join(" ")).toBe(script.beats.map((b) => b.line).join(" "));
    expect(plan.aroll[0].video_prompt).toContain('She says');
    expect(plan.aroll[0].video_prompt).toContain("propped up");
    expect(plan.aroll[0].video_prompt).not.toMatch(/arm's length selfie video/i);
    expect(plan.broll).toEqual([
      { beat: 2, visual_id: "s2", motion: "zoom_in" },
      { beat: 3, visual_id: "s1", motion: "scroll_down" },
    ]);
    expect(plan.voiceover).toBeNull();
  });

  it("uses a voice-over and no creator for faceless formats", () => {
    const faceless = { ...brief, format: "voiceover_demo" as const };
    const plan = planProduction(normalizeScript(goodBeats.map((b) => ({ ...b })), { ...ctx, brief: faceless }), faceless, product);
    expect(plan.aroll).toEqual([]);
    expect(plan.voiceover?.text).toContain("nine sign-ups");
  });

  it("times beats from the real render lengths and cuts to product footage", () => {
    const plan = planProduction(script, brief, product);
    const assets = {
      aroll: [
        { path: "/a1.mp4", duration: 4 },
        { path: "/a2.mp4", duration: 6 },
        { path: "/a3.mp4", duration: 6 },
        { path: "/a4.mp4", duration: 4 },
      ],
      voiceover: null,
      visuals: new Map([
        ["s1", { path: "/s1.png", kind: "image" as const }],
        ["s2", { path: "/s2.png", kind: "image" as const }],
      ]),
    };
    const times = beatTimes(script, plan, assets);
    expect(times.map((t) => [t.start, t.end])).toEqual([
      [0, 4],
      [4, 10],
      [10, 16],
      [16, 20],
    ]);
    const timeline = buildTimeline(script, plan, assets);
    expect(timeline.duration).toBe(20);
    expect(timeline.audio).toBeNull();
    expect(timeline.segments).toEqual([
      { start: 4, end: 10, layer: "broll", broll: { path: "/s2.png", kind: "image", motion: "zoom_in" } },
      { start: 10, end: 16, layer: "broll", broll: { path: "/s1.png", kind: "image", motion: "scroll_down" } },
    ]);
    expect(timeline.overlays).toEqual([{ start: 0, end: 3.5, text: "9 sign-ups. For one agent." }]);
    expect(timeline.captions.map((c) => c.text)[0]).toBe("My agent needed nine sign-ups this week.");
  });

  it("spreads a voice-over across beats by how much each one says", () => {
    const faceless = { ...brief, format: "voiceover_demo" as const };
    const fScript = normalizeScript(goodBeats.map((b) => ({ ...b })), { ...ctx, brief: faceless });
    const plan = planProduction(fScript, faceless, product);
    const timeline = buildTimeline(fScript, plan, { aroll: [], voiceover: { path: "/vo.wav", duration: 15 }, visuals: new Map([["s2", { path: "/s2.png", kind: "image" as const }]]) });
    expect(timeline.audio).toEqual({ path: "/vo.wav" });
    expect(timeline.duration).toBe(15);
    expect(timeline.segments.every((s) => s.layer === "broll")).toBe(true);
    expect(timeline.segments.at(-1)?.end).toBeCloseTo(15);
  });

  it("builds the concept production and the UI read", () => {
    const plan = planProduction(script, brief, product);
    const concept = conceptFrom(brief, script, plan, reference, product);
    expect(concept.shots).toHaveLength(4);
    expect(concept.shots[0].dialogue).toBe("My agent needed nine sign-ups this week.");
    expect(concept.hook).toBe("9 sign-ups. For one agent. / My agent needed nine sign-ups this week.");
    expect(concept.reference_images).toEqual([]); // software: no product photo in the creator's frame
    expect(concept.reference).toMatchObject({ id: "ref_1", outlier: 75 });
  });
});

describe("the scout", () => {
  const video = (over: Partial<Video>): Video => ({
    platform: "tiktok",
    url: "u",
    caption: "",
    views: 1000,
    likes: 10,
    comments: 1,
    shares: 0,
    saves: 0,
    duration: 20,
    author: "a",
    followers: 1000,
    paid: false,
    thumbnail: null,
    media_url: null,
    source: "tiktok_0",
    ...over,
  });

  it("ranks breakouts above big accounts", () => {
    const breakout = video({ views: 400_000, followers: 3_000, likes: 40_000 });
    const celebrity = video({ views: 2_000_000, followers: 5_000_000, likes: 50_000 });
    expect(roughScore(breakout)).toBeGreaterThan(roughScore(celebrity));
    expect(scoutDigest([celebrity, breakout])[0].views_per_follower).toBe(133.3);
  });

  it("reads hashtags and drops repeat or empty searches", () => {
    expect(hashtags("ship it #BuildInPublic #ai #ai #x")).toEqual(["buildinpublic", "ai"]);
    const report = cleanReport(
      {
        notes: "n",
        searches: [
          { platform: "tiktok", query: "#buildinpublic", why: "3 breakouts share it" },
          { platform: "instagram", query: "AI agents", why: "dup" },
          { platform: "youtube", query: "  ", why: "" },
          { platform: "myspace" as "tiktok", query: "agent tools I use", why: "" },
        ],
      },
      ["ai agents"],
    );
    expect(report.searches.map((s) => [s.platform, s.query])).toEqual([
      ["tiktok", "buildinpublic"],
      ["tiktok", "agent tools I use"],
    ]);
    expect(scoutSpecs(report).map((spec) => [spec.key, spec.phase, spec.endpoint])).toEqual([
      ["scout_tiktok_0", "D", "/tiktok.search_keyword"],
      ["scout_tiktok_1", "D", "/tiktok.search_keyword"],
    ]);
    expect(platformOfRun("scout_reels_2")).toBe("instagram");
    expect(platformOfRun("shorts_1")).toBe("youtube");
  });
});

describe("research", () => {
  const plan: ResearchPlan = {
    brand_name: "Monid",
    category: "agent tools",
    audience: "devs",
    competitors: [{ name: "Composio" }, { name: "Smithery" }],
    content_queries: ["too many api keys", "build ai agent", "day in the life ai engineer", "agent tools", "tools i wish i knew"],
    ads_query: "api",
    reddit_query: "agent tools",
    aeo_prompts: ["best agent tool router?"],
  };

  it("searches every query, the competitors, and the top two queries on Reels and Shorts", () => {
    const keys = phaseCSpecs(plan).map((spec) => spec.key);
    expect(keys).toEqual(expect.arrayContaining(["tiktok_brand", "tiktok_0", "tiktok_4", "tiktok_comp_0", "tiktok_comp_1", "reels_0", "reels_1", "shorts_0", "shorts_1"]));
  });

  it("keeps competitor-search results only when they name the competitor", () => {
    const item = (caption: string, author: string) => ({ url: `https://x/${caption}`, caption, author, playCount: 1000, authorFollowers: 500 });
    const pack = compactResearch(
      "monid.ai",
      [
        { key: "tiktok_comp_0", status: "done", output: { videos: [item("Composio vs the rest", "dev1"), item("my composition homework", "kid")] } },
        { key: "scout_reels_0", status: "done", output: { videos: [item("agent stack", "dev2")] } },
      ],
      plan,
    );
    expect(pack.videos.map((v) => [v.platform, v.caption])).toEqual(
      expect.arrayContaining([
        ["tiktok", "Composio vs the rest"],
        ["instagram", "agent stack"],
      ]),
    );
    expect(pack.videos.some((v) => v.caption === "my composition homework")).toBe(false);
  });
});

describe("the product brief", () => {
  const pack = { domain: "monid.ai", brand: { name: "Monid", description: "Agent tool marketplace API", slogan: "", industry: "", images: ["https://monid.ai/a.png", "https://monid.ai/b.png"] }, site_excerpt: "An API for agents", seo: { keywords: [] }, reddit: [] } as unknown as ResearchPack;

  it("keeps only images that show the product, as visuals", () => {
    const brief = toBrief(
      { name: "Monid", kind: "software", images: [{ index: 0, shows_product: false, caption: "stock photo" }, { index: 1, shows_product: true, caption: "the dashboard" }] },
      pack,
      pack.brand.images,
    );
    expect(brief.visuals).toEqual([{ id: "p1", kind: "photo", url: "https://monid.ai/b.png", caption: "the dashboard", source: "site" }]);
  });

  it("falls back to a brief from the research", () => {
    expect(fallbackBrief(pack).kind).toBe("software");
  });
});

describe("presenter-only prompts", () => {
  it("drops edit directions a video model would draw as garbled text", async () => {
    const { presenterOnly } = await import("@/lib/creative/plan");
    expect(
      presenterOnly(
        "Top half: row of dark tool cards sliding sideways. Bottom half: bearded presenter looking straight at camera, small calm nod. Karaoke caption at the split line.",
      ),
    ).toBe("");
    expect(presenterOnly("Relaxed, confident look. Presenter in the bottom inset, small nod.")).toBe("Relaxed, confident look.");
    expect(presenterOnly("Very fast, confident and plain-spoken. Each sentence cues a new card change.")).toBe("Very fast, confident and plain-spoken.");
  });
});
