import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { scout, scoutDigest } from "@/lib/creative/scout";
import { lintScript, normalizeScript, type ScriptContext, writeScript } from "@/lib/creative/script";
import type { BeatJob, CreativeBrief, ProductBrief, ReferenceBreakdown, ScriptBeat } from "@/lib/creative/types";
import { compactResearch, type Video } from "@/lib/research";
import { balanceRoles, conceptFrom, METRICS, normalizeStrategy, referenceDigest, STRATEGY_SCHEMA, strategyMessage } from "@/lib/strategy";

// Steering the agents toward return on investment, not just reach: every video has a funnel role,
// the director plans a mix, and convert videos keep their reference's selling beats.

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
  look: "a dark dashboard",
  visuals: [{ id: "s1", kind: "screenshot", url: "/tmp/s1.png", caption: "tools page", source: "capture", width: 430, height: 932 }],
};

const adReference: ReferenceBreakdown = {
  id: "ref_ad",
  url: "https://www.facebook.com/ads/library/?id=111",
  platform: "instagram",
  author: "Composio",
  views: 0,
  followers: null,
  outlier: null,
  duration: 12,
  format: "talking head, screen cutaways",
  hook: { line: "Your agent needs twelve API keys.", on_screen_text: "12 KEYS", visual: "creator to camera", mechanic: "absurd number" },
  beats: [
    { start: 0, end: 3, job: "hook", shot: "talking_head", visual: "creator", on_screen_text: "12 KEYS", line: "Your agent needs twelve API keys." },
    { start: 3, end: 8, job: "demo", shot: "screen", visual: "dashboard", on_screen_text: "", line: "Ours finds the tool and pays per call." },
    { start: 8, end: 12, job: "cta", shot: "talking_head", visual: "creator", on_screen_text: "", line: "Start free, link below." },
  ],
  pacing: { cuts: 3, avg_shot_seconds: 3, words_per_minute: 170 },
  caption_style: "white bold",
  delivery: "deadpan",
  why_it_works: "absurd number, then the fix",
  fit: { score: 8, reason: "same buyer" },
  transcript: "Your agent needs twelve API keys. Ours finds the tool and pays per call. Start free, link below.",
  origin: "ad",
  role: "convert",
  conversion: { score: 7, signals: ["Meta ad", "ran 94 days, still running", "4 ads use this creative"] },
  anatomy: { role: "convert", structure: "problem_solution", problem: "Your agent needs twelve API keys.", proof: "Ours finds the tool and pays per call.", offer: "Start free", cta: "Start free, link below.", objection: "" },
};

const brief: CreativeBrief = {
  title: "Twelve keys",
  reference_id: "ref_ad",
  role: "convert",
  metric: "sign_ups",
  format: "talking_head_broll",
  angle: "absurd number",
  audience: "agent builders",
  hook_plan: "absurd number of keys",
  keep: ["pacing"],
  change: ["their product"],
  visuals: ["s1"],
  creator: "A woman in her late 20s, grey hoodie",
  setting: "home office, evening",
  platforms: ["tiktok"],
  caption: "one balance",
  hashtags: ["#ai"],
  cta: "get the $1 free credit, link in bio",
  why: "ran 94 days",
};

const ctx: ScriptContext = { product, brief, reference: adReference, targetSeconds: 12 };

describe("the director's plan is a funnel mix", () => {
  it("requires a role and a metric on every brief, and asks for at least one of each role", () => {
    const required = STRATEGY_SCHEMA.properties.campaign.properties.briefs.items.required as readonly string[];
    expect(required).toContain("role");
    expect(required).toContain("metric");
    const pack = compactResearch("monid.ai", [], null);
    const message = strategyMessage(pack, { product, breakdowns: [adReference] }, { concepts: 3, shotsPerConcept: 3, secondsPerShot: 8, videoModel: "veo" });
    expect(message).toContain("With 3 videos, include at least one of each role.");
    expect(message).toMatch(/one-to-one/);
    expect(strategyMessage(pack, { product, breakdowns: [adReference] }, { concepts: 1, shotsPerConcept: 3, secondsPerShot: 8, videoModel: "veo" })).toContain("With one video, pick the role the evidence supports best.");
  });

  it("shows the director each reference's role, conversion evidence and selling beats, and an ad's views as unknown", () => {
    const [digest] = referenceDigest([adReference]);
    expect(digest).toMatchObject({ views: "unknown (paid ad)", role: "convert", conversion_evidence: "7/10: Meta ad, ran 94 days, still running, 4 ads use this creative", how_it_sells: adReference.anatomy });
    const legacy = referenceDigest([{ ...adReference, origin: undefined, role: undefined, conversion: undefined, anatomy: undefined, views: 900_000 }])[0];
    expect(legacy).toMatchObject({ views: 900_000, role: "reach", conversion_evidence: "none recorded" });
    expect("how_it_sells" in legacy).toBe(false);
  });

  it("fills a missing or mismatched metric from the role, and infers a missing role from the call to action", () => {
    const raw = (briefs: Array<Partial<CreativeBrief>>) => ({ campaign: { name: "c", objective: "o", briefs, posting_plan: {} } });
    const options = { concepts: 3, shotsPerConcept: 3, secondsPerShot: 8, videoModel: "veo" };
    const strategy = normalizeStrategy(
      raw([
        { ...brief, role: "reach", metric: "sign_ups" },
        { ...brief, role: undefined, metric: undefined, cta: "follow for part 2" },
        { ...brief, role: undefined, metric: undefined, cta: "start free with the $1 credit" },
      ]),
      options,
      { referenceIds: ["ref_ad"], visualIds: ["s1"] },
    );
    expect(strategy.campaign.briefs!.map((b) => [b.role, b.metric])).toEqual([
      ["reach", "views"],
      ["reach", "views"],
      ["convert", "link_clicks"],
    ]);
  });

  it("switches one video when the director made them all the same role", () => {
    const allReach = balanceRoles([
      { ...brief, title: "a", role: "reach", metric: "views", cta: "follow for more" },
      { ...brief, title: "b", role: "reach", metric: "shares", cta: "try it free, link in bio" },
      { ...brief, title: "c", role: "reach", metric: "views", cta: "" },
    ]);
    expect(allReach.map((b) => [b.title, b.role, b.metric])).toEqual([
      ["a", "reach", "views"],
      ["b", "convert", "link_clicks"],
      ["c", "reach", "views"],
    ]);
    const allConvert = balanceRoles([
      { ...brief, title: "a", role: "convert", cta: "sign up free" },
      { ...brief, title: "b", role: "convert", cta: "follow along" },
    ]);
    expect(allConvert.map((b) => b.role)).toEqual(["convert", "reach"]);
    expect(balanceRoles([{ ...brief, role: "convert" }]).map((b) => b.role)).toEqual(["convert"]);
    expect(METRICS.convert[0]).toBe("link_clicks");
  });

  it("carries the role and metric onto the finished concept", () => {
    const script = normalizeScript([{ n: 1, job: "hook", seconds: 3, line: "x", on_screen_text: "", visual: "creator", product_visual: null, direction: "" }], ctx);
    const concept = conceptFrom(brief, script, { format: "talking_head_broll", aroll: [], broll: [], voiceover: null }, adReference, product);
    expect(concept).toMatchObject({ role: "convert", metric: "sign_ups" });
  });
});

describe("scripts for convert videos", () => {
  const beat = (n: number, job: BeatJob, line: string, seconds = 4): Partial<ScriptBeat> => ({ n, job, seconds, line, on_screen_text: "", visual: n === 2 ? "product" : "creator", product_visual: n === 2 ? "s1" : null, direction: "calm" });

  it("fail the linter when nothing asks the viewer to act", () => {
    const noAsk = normalizeScript([beat(1, "hook", "Your agent needs twelve API keys."), beat(2, "demo", "Monid finds the tool and pays per call."), beat(3, "payoff", "One balance for all of it.")], ctx);
    expect(lintScript(noAsk, ctx).join(" | ")).toMatch(/a convert video must end on a call to action/);
    const asks = normalizeScript([beat(1, "hook", "Your agent needs twelve API keys."), beat(2, "demo", "Monid finds the tool and pays per call."), beat(3, "payoff", "There's a dollar of free credit, link below.")], ctx);
    expect(lintScript(asks, ctx).join(" | ")).not.toMatch(/call to action/);
    // A reach video is not held to it.
    expect(lintScript(noAsk, { ...ctx, brief: { ...brief, role: "reach", metric: "views" } }).join(" | ")).not.toMatch(/call to action/);
    // Nor is a brief from before roles existed.
    expect(lintScript(noAsk, { ...ctx, brief: { ...brief, role: undefined, metric: undefined } }).join(" | ")).not.toMatch(/call to action/);
  });

  it("tell the writer and the critic the video's job and the reference's selling beats", async () => {
    const requests: Array<{ system: string; messages: Array<{ content: string }>; tools?: Array<{ input_schema: { properties: Record<string, { required?: string[] }> } }> }> = [];
    const naive = {
      message: async (request: (typeof requests)[number]) => {
        requests.push(request);
        if (requests.length === 1) return { stop_reason: "tool_use", content: [{ type: "tool_use", name: "script", input: { beats: [beat(1, "hook", "Your agent needs twelve API keys."), beat(2, "cta", "Get the free credit, link below.")] } }] };
        return { stop_reason: "tool_use", content: [{ type: "tool_use", name: "script_review", input: { scores: {}, score: 9, notes: [], revised_beats: [] } }] };
      },
    } as unknown as Parameters<typeof writeScript>[0];
    await writeScript(naive, ctx);
    expect(requests[0].system).toMatch(/convert: this video is judged on clicks and sign-ups/);
    expect(requests[0].messages[0].content).toContain("Role: convert (judged on sign ups)");
    expect(requests[0].messages[0].content).toContain('"how_it_sells"');
    expect(requests[1].system).toMatch(/ends without one clear call to action, fails/);
    expect(requests[1].tools?.[0].input_schema.properties.scores.required).toContain("does_its_job");
  });
});

describe("the scout's view", () => {
  it("leaves ads out (no views to compare) and shows saves per like", () => {
    const base: Video = { platform: "tiktok", url: "u", caption: "", views: 100_000, likes: 1_000, comments: 10, shares: 5, saves: 400, duration: 20, author: "a", followers: 1_000, paid: false, thumbnail: null, media_url: null, source: "tiktok_0" };
    const ad: Video = { ...base, url: "ad", views: 0, source: "meta_ads_comp_0", ad: { network: "meta", days: 90, active: true, variants: 1, cta: "", objective: "" } };
    const digest = scoutDigest([ad, base]);
    expect(digest).toHaveLength(1);
    expect(digest[0].saves_per_like).toBe(0.4);
  });

  it("shows each video's cloneability guess and sends the scout after face-to-camera UGC", async () => {
    const base: Video = { platform: "tiktok", url: "u", caption: "storytime: my agent bill", views: 100_000, likes: 1_000, comments: 10, shares: 5, saves: 400, duration: 20, author: "a", followers: 1_000, paid: false, thumbnail: null, media_url: null, source: "tiktok_0" };
    expect(scoutDigest([base, { ...base, url: "v", caption: "duet with @x" }]).map((v) => v.clones)).toEqual([7, 2.5]);

    let request: { system: string; messages: Array<{ content: string }> } | null = null;
    const naive = {
      message: async (sent: typeof request) => {
        request = sent;
        return { content: [{ type: "tool_use", name: "scout_report", input: { notes: "n", searches: [{ platform: "tiktok", query: "storytime api bill", why: "" }, { platform: "tiktok", query: "POV agent pays", why: "" }] } }] };
      },
    };
    const plan = { brand_name: "Monid", category: "agent tools", audience: "devs", competitors: [], content_queries: [], conversion_queries: [], face_queries: ["storytime api bill"], ads_query: "", reddit_query: "", aeo_prompts: [] };
    const report = await scout(naive as never, { plan, videos: [base], brand: { name: "Monid", description: "" }, alreadySearched: [] });
    // The face search already ran in the first wave, so the scout's repeat of it is dropped.
    expect(report.searches.map((s) => s.query)).toEqual(["POV agent pays"]);
    expect(request!.system).toMatch(/Make at least one search find that face-to-camera UGC in this niche/);
    expect(request!.messages[0].content).toContain('"clones":7');
  });
});

describe("the director picks what the footage clone can reproduce", () => {
  const cloned: ReferenceBreakdown = {
    ...adReference,
    footage: { people: 2, face_to_camera: 0.4, camera: "handheld", set: "location", product: "none", overlays: "separable", audio: "dialogue", script: "template", hardest: "Two people talk to each other on a street." },
    cloneability: { score: 3.1, basis: "breakdown", parts: [{ name: "people", points: 0.5, signal: "two people on camera (the clone performs one)" }] },
  };

  it("shows each reference's cloneability, its reasons and its hardest part", () => {
    const [digest] = referenceDigest([cloned]);
    expect(digest).toMatchObject({ cloneability: "3.1/10 from its frames: two people on camera (the clone performs one) +0.5", hardest_to_clone: "Two people talk to each other on a street." });
    const legacy = referenceDigest([adReference])[0];
    expect(legacy.cloneability).toBe("not recorded");
    expect("hardest_to_clone" in legacy).toBe(false);
  });

  it("tells the director to favour face-to-camera UGC, prefer cloneability 6+, and say why when it picks a harder one", () => {
    const pack = compactResearch("monid.ai", [], null);
    const message = strategyMessage(pack, { product, breakdowns: [cloned] }, { concepts: 3, shotsPerConcept: 3, secondsPerShot: 8, videoModel: "veo" });
    expect(message).toMatch(/a lookalike AI presenter performs the original's exact motion \(it needs one person, in continuous takes\)/);
    expect(message).toMatch(/Face-to-camera UGC \(one person talking to the lens: a talking-head testimonial, "I tried X", storytime, a POV reaction, green-screen commentary\)/);
    expect(message).toContain("Prefer references with cloneability 6 or more.");
    expect(message).toContain("When you pick a reference below 6, say in its brief's why what makes it worth the risk.");
    const why = STRATEGY_SCHEMA.properties.campaign.properties.briefs.items.properties.why.description;
    expect(why).toMatch(/when its cloneability is below 6, what makes it worth the harder remake/);
  });

  it("carries the same rules in the director agent's own instructions", () => {
    const director = readFileSync(new URL("../../naive/agents/director.md", import.meta.url), "utf8");
    expect(director).toMatch(/\*\*Face-to-camera UGC is the core format\.\*\*/);
    expect(director).toMatch(/Prefer references with `cloneability` 6 or more/);
    expect(director).toMatch(/When you pick a reference below 6, say in `why` what makes it worth the harder remake/);
  });
});
