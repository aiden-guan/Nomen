import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { editFfmpeg, renderTimeline } from "@/lib/creative/edit";
import { extractFormulas, fallbackFormulas, type Formula, formulaDigest, normalizeFormulas } from "@/lib/creative/formulas";
import { lintOrganic, normalizeOrganic, type OrganicContext, organicConcept, organicTarget, PUNCH_IN, personaFor, planOrganic, readPersona, sayable, soundCues, takeSeconds, writeOrganicScript } from "@/lib/creative/organic";
import { buildTimeline, planProduction } from "@/lib/creative/plan";
import { normalizeScript } from "@/lib/creative/script";
import type { CreativeBrief, ProductBrief, ReferenceBreakdown, Script } from "@/lib/creative/types";
import { createBrand, listCreatives, startCampaign } from "@/lib/pipeline";
import { advanceCreative, insertCreative, type ProductionContext } from "@/lib/production";
import { peakLevel, probe } from "@/lib/media";
import type { ResearchPack } from "@/lib/research";
import { normalizeStrategy, ORGANIC_STRATEGY_SCHEMA, organicStrategyMessage } from "@/lib/strategy";

// Organic mode: original videos built from the winning formulas the research finds across many
// references, written for what AI video does well. The one-to-one remakes are untouched.

const exec = promisify(execFile);

const product: ProductBrief = {
  name: "Naïve",
  one_liner: "You pick a company template, deploy it, and a team of AI agents runs that business for you.",
  kind: "software",
  audience: "solo founders and creators",
  problem: "I can't do all the work myself or afford a team",
  aha: "click Deploy on a template and watch the first session run",
  features: [{ name: "Company templates", what_it_does: "pre-built agent teams for a whole business", how_to_show_it: "the Studio template list" }],
  claims: ["Pick a template, deploy it, watch the first session run.", "You approve anything that costs money."],
  proof: [],
  objections: ["will agents spend my money"],
  offer: "",
  voice: "terse",
  look: "black site, white monospace type",
  visuals: [
    { id: "s1", kind: "screenshot", url: "/tmp/s1.png", caption: "homepage", source: "capture", width: 430, height: 932 },
    { id: "s2", kind: "screenshot", url: "/tmp/s2.png", caption: "docs page", source: "capture", width: 430, height: 932 },
  ],
};

const beat = (start: number, end: number, job: ReferenceBreakdown["beats"][number]["job"], shot: ReferenceBreakdown["beats"][number]["shot"], line: string) => ({ start, end, job, shot, visual: "", on_screen_text: "", line });

const insiderA: ReferenceBreakdown = {
  id: "ref_a",
  url: "https://www.tiktok.com/@hustlewithmax37/video/1",
  platform: "tiktok",
  author: "hustlewithmax37",
  views: 438_932,
  followers: 1924,
  outlier: 228.1,
  duration: 50.4,
  format: "talking-head confession, then a 3-step screen walkthrough",
  hook: { line: "So I might have just found a way to make a lot of money with Claude.", on_screen_text: "Deleting this in 24H...", visual: "woman on a bed", mechanic: "a money promise plus forbidden-knowledge scarcity" },
  beats: [beat(0, 8, "hook", "talking_head", "So I might have just found a way"), beat(8, 23, "agitate", "talking_head", "I kinda don't wanna post this"), beat(23, 38, "demo", "screen", "First, head over"), beat(38, 50, "proof", "screen", "I can have it send emails")],
  pacing: { cuts: 6, avg_shot_seconds: 7.2, words_per_minute: 232 },
  caption_style: "small white",
  delivery: "fast, confessional",
  why_it_works: "scarcity plus an easy 3-step tutorial",
  fit: { score: 8, reason: "rebuilds cleanly" },
  transcript: "So I might have just found a way to make a lot of money with Claude.",
  origin: "adjacent",
  role: "convert",
  conversion: { score: 2.7, signals: ["saves per like 3.1x the pool's"] },
  anatomy: { role: "convert", structure: "tutorial", problem: "", proof: "dashboard demo", offer: "", cta: "", objection: "" },
};

const insiderB: ReferenceBreakdown = {
  ...insiderA,
  id: "ref_b",
  url: "https://www.tiktok.com/@ai.willv/video/2",
  author: "ai.willv",
  views: 243_333,
  followers: 452,
  outlier: 243.3,
  duration: 57.5,
  conversion: { score: 2.9, signals: ["saves per like 2.9x the pool's"] },
};

const story: ReferenceBreakdown = {
  ...insiderA,
  id: "ref_c",
  url: "https://www.tiktok.com/@mplentg/video/3",
  author: "mplentg",
  views: 643_977,
  followers: 1770,
  outlier: 363.8,
  duration: 53.9,
  format: "result-first story with rising numbers",
  hook: { line: "In six hours, it made $3,000.", on_screen_text: "AI makes $3000 in 6 hours.", visual: "a post screenshot", mechanic: "a big result and a short time window first" },
  beats: [beat(0, 3, "hook", "screen", "In six hours, it made $3,000."), beat(3, 30, "demo", "b_roll", "It started with the easiest money"), beat(30, 54, "payoff", "screen", "The AI made $1,300")],
  role: "reach",
  conversion: { score: 2.6, signals: ["saves per like 2.9x the pool's"] },
  anatomy: { role: "reach", structure: "story", problem: "", proof: "rising numbers", offer: "", cta: "", objection: "" },
};

const breakdowns = [insiderA, insiderB, story];

const rawFormulas = {
  formulas: [
    {
      name: "Result first",
      role: "reach",
      hook: { archetype: "result first", mechanic: "a big outcome and a short time window", template: "In [time], [the product] did [the outcome].", examples: [{ ref: "ref_c", line: "In six hours, it made $3,000.", text: "AI makes $3000 in 6 hours." }] },
      beats: [
        { job: "hook", share: 1, does: "the result", on_screen: "presenter" },
        { job: "demo", share: 2, does: "the stages", on_screen: "product" },
        { job: "payoff", share: 1, does: "the end state", on_screen: "product" },
      ],
      pacing: { seconds: 54, words_per_minute: 159, cut_every_seconds: 4.5, note: "short declarative sentences" },
      proof_device: "a number at every stage",
      cta_pattern: "none",
      why_it_works: "curiosity about how",
      ai_notes: "one presenter to camera, stages as screens",
      avoid: ["their dollar figures"],
      references: ["ref_c"],
    },
    {
      name: "The reluctant insider",
      role: "convert",
      hook: { archetype: "forbidden secret", mechanic: "says they shouldn't share it, then promises the payoff", template: "I almost didn't post this, because [the payoff].", examples: [{ ref: "ref_a", line: "So I might have just found a way", text: "Deleting this in 24H..." }] },
      beats: [
        { job: "cta", share: 1, does: "a soft ask", on_screen: "presenter" },
        { job: "hook", share: 2, does: "the confession", on_screen: "presenter" },
        { job: "demo", share: 5, does: "three steps on screen", on_screen: "product" },
        { job: "bogus", share: 2, does: "?", on_screen: "product" },
      ],
      pacing: { seconds: 0, words_per_minute: null, cut_every_seconds: 7, note: "long confession takes, fast screen steps" },
      proof_device: "the finished dashboard on screen",
      cta_pattern: "the steps are the ask",
      why_it_works: "insider trust and an easy recipe",
      ai_notes: "the confession is one person to camera",
      avoid: ["money promises"],
      references: ["ref_a", "ref_b", "ref_zzz"],
    },
    { name: "Ghost", role: "reach", hook: {}, beats: [], references: ["nope"] },
  ],
};

describe("formula extraction", () => {
  it("keeps formulas backed by known references and attaches their real numbers", () => {
    const formulas = normalizeFormulas(rawFormulas, breakdowns);
    expect(formulas.map((f) => f.name)).toEqual(["The reluctant insider", "Result first"]);
    const insider = formulas[0];
    expect(insider.id).toBe("f1");
    expect(insider.references).toEqual(["ref_a", "ref_b"]);
    expect(insider.evidence.total_views).toBe(438_932 + 243_333);
    expect(insider.evidence.best_outlier).toBeCloseTo(243.3);
    expect(insider.evidence.best_conversion).toBeCloseTo(2.9);
    expect(insider.evidence.summary).toContain("2 videos");
    expect(insider.evidence.summary).toContain("243x");
    expect(insider.evidence.references.map((r) => r.url)).toEqual([insiderA.url, insiderB.url]);
  });

  it("opens every formula on its hook, drops unknown jobs and makes the beat shares add up to one", () => {
    const [insider] = normalizeFormulas(rawFormulas, breakdowns);
    expect(insider.beats.map((b) => b.job)).toEqual(["hook", "demo", "cta"]);
    expect(insider.beats.reduce((sum, b) => sum + b.share, 0)).toBeCloseTo(1);
    // No length from the model: the references' median length; their talking speed likewise.
    expect(insider.pacing.seconds).toBeCloseTo(54);
    expect(insider.pacing.words_per_minute).toBe(232);
  });

  it("falls back to one formula per selling structure when the model gives nothing usable", async () => {
    const naive = { message: async () => ({ stop_reason: "end_turn", content: [{ type: "text", text: "Sorry, I can't." }] }) };
    const formulas = await extractFormulas(naive as never, breakdowns, product);
    expect(formulas.map((f) => f.references)).toEqual([["ref_a", "ref_b"], ["ref_c"]]);
    expect(formulas.every((f) => f.beats[0].job === "hook")).toBe(true);
    expect(fallbackFormulas(breakdowns)[0].hook.mechanic).toBe(insiderA.hook.mechanic);
  });

  it("asks the model once, with every reference's numbers and beats", async () => {
    const seen: Array<{ system?: string; messages: Array<{ content: unknown }> }> = [];
    const naive = {
      message: async (body: { system?: string; messages: Array<{ content: unknown }> }) => {
        seen.push(body);
        return { stop_reason: "tool_use", content: [{ type: "tool_use", name: "formulas", input: rawFormulas }] };
      },
    };
    const formulas = await extractFormulas(naive as never, breakdowns, product);
    expect(seen).toHaveLength(1);
    expect(String(seen[0].messages[0].content)).toContain("ref_a");
    expect(String(seen[0].messages[0].content)).toContain("228");
    expect(formulas).toHaveLength(2);
    // What the director sees: the formula, its backing and its numbers, without raw transcripts.
    const digest = JSON.stringify(formulaDigest(formulas));
    expect(digest).toContain("The reluctant insider");
    expect(digest).toContain("438932");
    expect(digest).not.toContain(insiderA.transcript);
  });
});

const formulas: Formula[] = normalizeFormulas(rawFormulas, breakdowns);
const insider = formulas[0];

const persona = readPersona(
  JSON.stringify({
    name: "baddie",
    look: "a woman in her mid-twenties with long sleek dark hair, winged liner and small gold hoops",
    voice: "a relaxed, slightly low young woman's voice, casual and warm",
    stills: [
      { setting: "bedroom", file_id: "fil_bedroom", place: "her bed in a lived-in bedroom, fairy lights behind her" },
      { setting: "kitchen", file_id: "fil_kitchen", place: "a small apartment kitchen in morning light" },
    ],
  }),
)!;

const brief: CreativeBrief = {
  title: "I almost didn't post this",
  reference_id: "",
  mode: "organic",
  formula_id: "f1",
  persona_setting: "bedroom",
  role: "convert",
  metric: "sign_ups",
  format: "talking_head_broll",
  angle: "a whole business you don't have to run yourself",
  audience: "solo founders",
  hook_plan: "the reluctant insider: I almost didn't post this",
  keep: [],
  change: [],
  visuals: ["s1"],
  creator: "",
  setting: "",
  platforms: ["tiktok"],
  caption: "",
  hashtags: [],
  cta: "Deploy the Short Form template, link in bio",
  why: "2 insider videos, 243x their followers",
};

const ctx: OrganicContext = { product, brief, formula: insider, examples: [insiderA, insiderB], targetSeconds: 18 };

const goodBeats = [
  { n: 1, job: "hook", seconds: 3, line: "Okay, I almost didn't post this one.", on_screen_text: "Deleting this in 24h", visual: "creator", product_visual: null, direction: "leans in a little", emotion: "[hushed]" },
  { n: 2, job: "agitate", seconds: 3, line: "Because it honestly feels like cheating a little.", on_screen_text: "", visual: "creator", product_visual: null, direction: "a small half-smile", emotion: "[deadpan]" },
  { n: 3, job: "demo", seconds: 4, line: "You pick a company template, like a short video channel, and hit Deploy.", on_screen_text: "", visual: "product", product_visual: "s1", screen: "The Studio template list, the cursor clicks Deploy on Naive Short Form v1.", direction: "", emotion: "[matter-of-fact]" },
  { n: 4, job: "proof", seconds: 5, line: "Then a team of agents runs it, and anything that costs money waits for you.", on_screen_text: "", visual: "product", product_visual: "s2", screen: "The first session running, then an approval card with Approve and Deny.", direction: "", emotion: "[calm]" },
  { n: 5, job: "cta", seconds: 3, line: "It's called Naïve. The link's in my bio.", on_screen_text: "", visual: "creator", product_visual: null, direction: "a small nod", emotion: "[warm]" },
];

const goodScript = (): Script => normalizeScript(goodBeats.map((b) => ({ ...b })) as never, ctx);

describe("the organic script room", () => {
  it("passes a clean script written for AI rendering", () => {
    expect(lintOrganic(goodScript(), ctx)).toEqual([]);
  });

  it("catches long takes, claims said to camera, a hook off camera, ad copy, invented numbers and the references' handles", () => {
    const bad = normalizeScript(
      [
        { n: 1, job: "hook", seconds: 4, line: "This is a total game changer.", on_screen_text: "", visual: "product", product_visual: "s1", direction: "" },
        { n: 2, job: "demo", seconds: 8, line: "So what you do is you pick one of the company templates, then you deploy it, then the agents run the whole business for you while you sleep and it costs nothing.", on_screen_text: "", visual: "creator", product_visual: null, direction: "" },
        { n: 3, job: "proof", seconds: 4, line: "It made 90% more than hustlewithmax37 did.", on_screen_text: "", visual: "creator", product_visual: null, direction: "" },
        { n: 4, job: "cta", seconds: 3, line: "Link in bio.", on_screen_text: "", visual: "creator", product_visual: null, direction: "" },
      ] as never,
      ctx,
    );
    const issues = lintOrganic(bad, ctx).join(" | ");
    expect(issues).toMatch(/game changer/);
    expect(issues).toMatch(/beat 2 runs 32 words: one take is one short sentence/);
    expect(issues).toMatch(/beat 2 makes a claim on camera/);
    expect(issues).toMatch(/hook \(beat 1\) belongs on camera/);
    expect(issues).toMatch(/"90%" is not in the product brief/);
    expect(issues).toMatch(/handle or name "hustlewithmax37"/);
    expect(issues).toMatch(/product is on screen for 13% of the video/);
  });

  it("holds the script to the words the target length can say, since every word is rendered", () => {
    const long = normalizeScript(
      [
        ...goodBeats.slice(0, 4).map((b) => ({ ...b })),
        { n: 5, job: "proof", seconds: 4, line: "And you approve anything that costs money, every single time, before it happens.", on_screen_text: "", visual: "product", product_visual: "s2", direction: "" },
        { n: 6, job: "proof", seconds: 4, line: "Each agent gets only what its role needs, and you can see all of it.", on_screen_text: "", visual: "product", product_visual: "s2", direction: "" },
        { n: 7, job: "cta", seconds: 3, line: "It's called Naïve. Go deploy one today, the link is in my bio.", on_screen_text: "", visual: "creator", product_visual: null, direction: "" },
      ] as never,
      ctx,
    );
    expect(lintOrganic(long, ctx).join(" | ")).toMatch(/runs 84 words, about 25 s spoken: cut it to 59 words/);
  });

  it("shows split and inset beats as plain product screens: the presenter is either on camera or not", () => {
    const script = normalizeOrganic([{ ...goodBeats[2], visual: "split" }, { ...goodBeats[3], visual: "inset" }] as never, ctx);
    expect(script.beats.map((b) => b.visual)).toEqual(["product", "product"]);
  });

  it("gives the ask to the presenter: a last beat that asks the viewer for something is said to camera", () => {
    const ask = { n: 3, job: "payoff", seconds: 3, line: "Send this to the friend who keeps saying they'll start a channel.", on_screen_text: "", visual: "product", product_visual: "s1", screen: "the queue", direction: "a warm smile" };
    const script = normalizeOrganic([{ ...goodBeats[0] }, { ...goodBeats[2] }, ask] as never, ctx);
    expect(script.beats[2]).toMatchObject({ visual: "creator", product_visual: null });
    expect(script.beats[2].screen).toBeUndefined();
    // A last beat that shows the result, and asks nothing, stays on the product.
    const result = normalizeOrganic([{ ...goodBeats[0] }, { ...goodBeats[3], n: 2, job: "payoff" }] as never, ctx);
    expect(result.beats[1].visual).toBe("product");
  });

  it("keeps large text to the presenter's beats: on a product beat it would sit on the screen's own UI", () => {
    const script = normalizeOrganic([{ ...goodBeats[0] }, { ...goodBeats[2], on_screen_text: "1. Pick 2. Deploy" }] as never, ctx);
    expect(script.beats.map((b) => b.on_screen_text)).toEqual(["Deleting this in 24h", ""]);
  });

  it("writes an original script from the formula, then has the critic check it", async () => {
    const calls: Array<{ system?: string; messages: Array<{ content: unknown }> }> = [];
    const naive = {
      message: async (body: { system?: string; messages: Array<{ content: unknown }> }) => {
        calls.push(body);
        if (calls.length === 1) return { stop_reason: "tool_use", content: [{ type: "tool_use", name: "script", input: { beats: goodBeats } }] };
        return { stop_reason: "tool_use", content: [{ type: "tool_use", name: "script_review", input: { scores: {}, score: 9, notes: ["tight"], revised_beats: [] } }] };
      },
    };
    const script = await writeOrganicScript(naive as never, ctx);
    expect(calls).toHaveLength(2);
    expect(calls[0].system).toMatch(/original/i);
    expect(calls[0].system).not.toMatch(/replicate/i);
    const content = String(calls[0].messages[0].content);
    expect(content).toContain("The reluctant insider");
    expect(content).toContain("forbidden secret");
    expect(content).toContain(insiderA.hook.line); // the backing videos' hooks, for their rhythm
    expect(script.beats).toHaveLength(5);
    expect(script.review).toMatchObject({ score: 9, rounds: 1 });
  });

  it("aims for a short video, since every presenter second is rendered", () => {
    expect(organicTarget(insider)).toBe(16);
    expect(organicTarget({ ...insider, pacing: { ...insider.pacing, seconds: 14 } })).toBe(14);
  });
});

describe("the organic plan shape", () => {
  const still = personaFor(persona, "bedroom")!;

  it("gives each on-camera sentence its own short take and the screen-covered run one take, all from the persona's still", () => {
    const plan = planOrganic(goodScript(), brief, product, still);
    // The hook and the reaction are separate takes (a jump cut between them); the two claims under
    // the screens are one take, only heard; the ask is its own take.
    expect(plan.aroll.map((shot) => shot.beats)).toEqual([[1], [2], [3, 4], [5]]);
    expect(plan.aroll.map((shot) => Boolean(shot.covered))).toEqual([false, false, true, false]);
    expect(plan.aroll.map((shot) => shot.duration)).toEqual([3, 3, 9, 3]);
    expect(plan.aroll[2].line).toBe(`${goodBeats[2].line} ${goodBeats[3].line}`);
    for (const shot of plan.aroll) {
      expect(shot.video_prompt).toContain(`Her voice: ${persona.voice}.`);
      expect(shot.video_prompt).toContain(`She says: "${shot.line}"`);
      expect(shot.video_prompt).toContain("Hands relaxed and mostly below the frame");
    }
    expect(plan.punch_in).toBe(PUNCH_IN);
  });

  it("plays the persona calm and keeps her still's own framing", () => {
    const plan = planOrganic(goodScript(), brief, product, still);
    const hook = plan.aroll[0].video_prompt;
    // Her stills are phone selfies: the prompt keeps that framing instead of asking for a propped-up camera.
    expect(hook).toContain("keeps the first frame's framing");
    expect(hook).not.toMatch(/propped up|never an arm's-length selfie/);
    // Kling plays big emotions as mugging: the arc is calmed and the face kept understated.
    expect(hook).toContain("Calm, understated expressions");
    expect(hook).not.toMatch(/eyebrow raises|whisper/);
    expect(hook).toContain("low and confiding");
    // A remake's presenter is unchanged.
    const remake = planProduction(goodScript(), { ...brief, mode: undefined, creator: "a woman in her twenties" }, product);
    expect(remake.aroll[0].video_prompt).toContain("propped up");
  });

  it("respells the brand's name when the product says how it is said", () => {
    expect(sayable("Go to usenaive.ai and open Naïve Studio.", "Naïve", "nah-eev")).toBe("Go to use nah-eev dot A I and open nah-eev Studio.");
    expect(sayable("NAIVE runs it.", "Naïve", "nah-eev")).toBe("nah-eev runs it.");
    // The written name stays when no respelling is given.
    expect(sayable("Open Naïve Studio.", "Naïve")).toBe("Open Naive Studio.");
  });

  it("has her say the brand and its address the way they are spoken, while the captions keep them written", () => {
    expect(sayable("Sign up at usenaive.ai, then open Naïve Studio.", "Naïve")).toBe("Sign up at use naive dot A I, then open Naive Studio.");
    expect(sayable("Go to monid.ai/skill and read docs.monid.com", "Monid")).toBe("Go to monid dot A I slash skill and read docs dot monid dot com");
    const script = normalizeScript([{ ...goodBeats[0] }, { ...goodBeats[4], line: "It's called Naïve. Sign up at usenaive.ai." }] as never, ctx);
    const plan = planOrganic(script, brief, product, still);
    expect(plan.aroll[1].video_prompt).toContain('She says: "It\'s called Naive. Sign up at use naive dot A I."');
    const timeline = buildTimeline(script, plan, { aroll: plan.aroll.map((shot) => ({ path: `/tmp/t${shot.n}.mp4`, duration: 3 })), voiceover: null, visuals: new Map() });
    expect(timeline.captions.map((c) => c.text).join(" ")).toContain("usenaive.ai");
  });

  it("sizes a take to its words at a fast natural pace, between Kling's shortest and ten seconds", () => {
    expect(takeSeconds("Okay, I almost didn't post this one.")).toBe(3); // 7 words: about 2 s of speech
    expect(takeSeconds("one two")).toBe(3);
    expect(takeSeconds(Array(20).fill("word").join(" "))).toBe(7);
    expect(takeSeconds(Array(40).fill("word").join(" "))).toBe(10);
  });

  it("splits a covered run that would not fit one take", () => {
    const long = normalizeScript(
      [
        goodBeats[0],
        { ...goodBeats[2], line: "You pick a company template, like a short video channel or an online store, and you hit Deploy." },
        { ...goodBeats[3], line: "Then a team of agents runs it for you, and anything that costs money waits for your yes first." },
        goodBeats[4],
      ].map((b, i) => ({ ...b, n: i + 1 })) as never,
      ctx,
    );
    expect(planOrganic(long, brief, product, still).aroll.map((shot) => shot.beats)).toEqual([[1], [2], [3], [4]]);
  });

  it("asks for small sound effects and no music of its own: the song is picked in the app when posting", () => {
    const plan = planOrganic(goodScript(), brief, product, still);
    expect(plan.sound).toEqual({ sfx: true });
    expect(planProduction(goodScript(), { ...brief, mode: undefined }, product).sound).toBeUndefined();
  });

  it("places a pop on the hook's text and a whoosh into and out of each run of screens", () => {
    const cues = soundCues({
      duration: 16,
      overlays: [{ start: 0, end: 3, text: "hook" }],
      segments: [
        { start: 4, end: 6, layer: "broll" },
        { start: 6, end: 9, layer: "broll" },
        { start: 9, end: 12, layer: "broll" },
      ],
    });
    expect(cues).toEqual([
      { at: 0.05, kind: "pop" },
      { at: 3.85, kind: "whoosh" },
      { at: 11.85, kind: "whoosh" },
    ]);
    // A screen that runs to the end has no way back to the presenter: no exit whoosh.
    expect(soundCues({ duration: 10, overlays: [], segments: [{ start: 2, end: 10, layer: "broll" }] })).toEqual([{ at: 1.85, kind: "whoosh" }]);
  });

  it("builds screens for the claims, captioned by the edit", () => {
    const plan = planOrganic(goodScript(), brief, product, still);
    expect(plan.screens?.map((s) => s.id)).toEqual(["b3", "b4"]);
    expect(plan.screens?.every((s) => s.captioned)).toBe(true);
    expect(plan.broll.map((clip) => clip.visual_id)).toEqual(["screen:b3", "screen:b4"]);
  });

  it("jump-cuts between the takes on camera, alternating the full frame and a punch-in; a remake's cut is unchanged", () => {
    const script = goodScript();
    const plan = planOrganic(script, brief, product, still);
    const aroll = plan.aroll.map((shot) => ({ path: `/tmp/take${shot.n}.mp4`, duration: 3 }));
    const timeline = buildTimeline(script, plan, { aroll, voiceover: null, visuals: new Map() });
    expect(timeline.aroll.map((clip) => clip.zoom ?? 1)).toEqual([1, PUNCH_IN, 1, 1]);
    const remake = buildTimeline(script, planProduction(script, { ...brief, mode: undefined }, product), { aroll: [{ path: "/tmp/a.mp4", duration: 12 }], voiceover: null, visuals: new Map() });
    expect(remake.aroll).toEqual([{ path: "/tmp/a.mp4" }]);
  });

  it("writes the concept with its formula, its backing videos and its persona", async () => {
    let call = 0;
    const naive = {
      message: async () => {
        call++;
        if (call === 1) return { stop_reason: "tool_use", content: [{ type: "tool_use", name: "script", input: { beats: goodBeats } }] };
        return { stop_reason: "tool_use", content: [{ type: "tool_use", name: "script_review", input: { scores: {}, score: 9, notes: [], revised_beats: [] } }] };
      },
    };
    const concept = await organicConcept(naive as never, { product, brief, formulas, breakdowns, persona });
    expect(concept.formula).toMatchObject({ id: "f1", name: "The reluctant insider" });
    expect(concept.formula?.references.map((r) => r.url)).toEqual([insiderA.url, insiderB.url]);
    expect(concept.inspired_by).toEqual([insiderA.url, insiderB.url]);
    expect(concept.persona).toMatchObject({ name: "baddie", setting: "bedroom", file_id: "fil_bedroom" });
    expect(concept.shots.map((shot) => shot.duration)).toEqual([3, 3, 9, 3]);
    expect(concept.reference).toBeUndefined();
  });
});

describe("the organic director", () => {
  const pack = { domain: "usenaive.ai", brand: { name: "Naïve" }, site_excerpt: "", similar_sites: [], seo: null, ads: [], reddit: [], aeo: null } as unknown as ResearchPack;
  const options = { concepts: 3, shotsPerConcept: 2, secondsPerShot: 8, videoModel: "veo" };

  it("briefs original videos built on the formulas, in the persona's settings", () => {
    const message = organicStrategyMessage(pack, { product, formulas, breakdowns }, options, [], persona);
    expect(message).toContain("organic mode");
    expect(message).toContain('"id":"f1"');
    expect(message).toContain("The reluctant insider");
    expect(message).toContain("bedroom");
    expect(message).toContain("kitchen");
    expect(message).not.toMatch(/Each brief remakes one of the proven reference videos/);
    const items = ORGANIC_STRATEGY_SCHEMA.properties.campaign.properties.briefs.items;
    expect(items.required).toContain("formula_id");
    expect(items.required).toContain("persona_setting");
    expect(items.required).not.toContain("reference_id");
  });

  it("keeps each brief's formula and setting, and marks it organic", () => {
    const raw = {
      brand: {},
      audience: [],
      competitors: [],
      content_patterns: [],
      search: {},
      campaign: {
        name: "c",
        objective: "o",
        posting_plan: { cadence: "", best_times: [], notes: "" },
        briefs: [
          { title: "One", formula_id: "f2", persona_setting: "kitchen", role: "reach", metric: "views", format: "talking_head_broll", cta: "follow for more" },
          { title: "Two", formula_id: "f9", persona_setting: "the moon", role: "convert", metric: "sign_ups", format: "voiceover_demo", cta: "link in bio" },
        ],
      },
    };
    const strategy = normalizeStrategy(raw, options, { referenceIds: ["ref_a"], visualIds: ["s1"], formulaIds: ["f1", "f2"], settings: ["bedroom", "kitchen"] });
    const [one, two] = strategy.campaign.briefs!;
    expect(one).toMatchObject({ mode: "organic", formula_id: "f2", persona_setting: "kitchen", reference_id: "" });
    // An unknown formula or setting falls back to one that exists; organic videos keep the presenter.
    expect(two).toMatchObject({ mode: "organic", formula_id: "f2", persona_setting: "bedroom", format: "talking_head_broll" });
  });
});

describe("organic videos in production", () => {
  it("uses the persona's still as every take's first frame, renders covered takes cheaper and each take at its own length", async () => {
    const brandId = await createBrand("organic.example");
    const campaignId = await startCampaign(brandId, { concepts: 1, shotsPerConcept: 2, secondsPerShot: 4, videoModel: "google/veo-3.1", learnStyle: false });
    const script = goodScript();
    const plan = planOrganic(script, brief, product, personaFor(persona, "bedroom"));
    const { conceptFrom } = await import("@/lib/strategy");
    const concept = conceptFrom(brief, script, plan, undefined, product, { formula: insider, persona: personaFor(persona, "bedroom") });
    await insertCreative(campaignId, 0, concept);

    const images: unknown[] = [];
    const runs: Array<{ endpoint: string; body: Record<string, unknown> }> = [];
    let links = 0;
    const naive = {
      generateImage: async (input: unknown) => {
        images.push(input);
        throw new Error("an organic video with a persona never generates a frame");
      },
      fileUrl: async (fileId: string) => (links++, { url: `https://files.invalid/${fileId}.png`, expires_at: "" }),
      generateVideo: async () => {
        throw new Error("the Naive video model is not the engine");
      },
      message: async () => ({ stop_reason: "end_turn", content: [{ type: "text", text: '{"pass": true, "issues": []}' }] }),
    };
    const monid = {
      run: async (_provider: string, endpoint: string, input: { body?: Record<string, unknown> }) => {
        runs.push({ endpoint, body: input.body ?? {} });
        return { runId: `run_${runs.length}`, status: "RUNNING" as const };
      },
      getRun: async (runId: string) => ({ runId, status: "RUNNING" as const }),
    };
    const ctx = { campaignId, brandId, naive, monid, naiveOut: () => false, markNaiveOut: async () => undefined, strategy: { brand: {} } } as unknown as ProductionContext;
    for (let tick = 0; tick < 2; tick++) {
      const [row] = await listCreatives(campaignId);
      await advanceCreative(ctx, row);
    }
    expect(images).toEqual([]);
    // One link to the still serves every take: a busy Naive is asked once, not once per take.
    expect(links).toBe(1);
    expect(runs).toHaveLength(4);
    expect(runs.map((r) => (r.body.media as Array<{ url: string }>)[0].url)).toEqual(Array(4).fill("https://files.invalid/fil_bedroom.png"));
    expect(runs.map((r) => r.body.resolution)).toEqual(["1080p", "1080p", "720p", "1080p"]);
    expect(runs.map((r) => r.body.duration)).toEqual(plan.aroll.map((shot) => shot.duration));
  });

  it("renders a take at its planned length on Naive's video models too (Naive's Kling 3.0, when Monid is empty)", async () => {
    const { setSetting, deleteSetting } = await import("@/lib/settings");
    const brandId = await createBrand("organic-naive.example");
    const campaignId = await startCampaign(brandId, { concepts: 1, shotsPerConcept: 2, secondsPerShot: 4, videoModel: "kwaivgi/kling-v3.0-pro", learnStyle: false });
    const script = goodScript();
    const plan = planOrganic(script, brief, product, personaFor(persona, "bedroom"));
    const { conceptFrom } = await import("@/lib/strategy");
    await insertCreative(campaignId, 0, conceptFrom(brief, script, plan, undefined, product, { formula: insider, persona: personaFor(persona, "bedroom") }));
    const videos: Array<{ model: string; seconds: number; image_urls?: string[] }> = [];
    const naive = {
      generateImage: async () => {
        throw new Error("no frames for a persona");
      },
      fileUrl: async (fileId: string) => ({ url: `https://files.invalid/${fileId}.png`, expires_at: "" }),
      generateVideo: async (input: { model: string; seconds: number; image_urls?: string[] }) => (videos.push(input), { id: `med_${videos.length}`, status: "queued", model: input.model, result: null, error: null, cost_micro_usd: null }),
      getMediaJob: async (id: string) => ({ id, status: "processing", model: "kwaivgi/kling-v3.0-pro", result: null, error: null, cost_micro_usd: null }),
      message: async () => ({ stop_reason: "end_turn", content: [{ type: "text", text: '{"pass": true, "issues": []}' }] }),
    };
    const ctx = { campaignId, brandId, naive, monid: null, naiveOut: () => false, markNaiveOut: async () => undefined, strategy: { brand: {} } } as unknown as ProductionContext;
    await setSetting("presenter_engine", "naive");
    await setSetting("video_model", "kwaivgi/kling-v3.0-pro");
    try {
      for (let tick = 0; tick < 2; tick++) {
        const [row] = await listCreatives(campaignId);
        await advanceCreative(ctx, row);
      }
    } finally {
      await deleteSetting("presenter_engine");
      await deleteSetting("video_model");
    }
    expect(videos.map((v) => v.model)).toEqual(Array(4).fill("kwaivgi/kling-v3.0-pro"));
    expect(videos.map((v) => v.seconds)).toEqual(plan.aroll.map((shot) => shot.duration));
    expect(videos.every((v) => v.image_urls?.[0] === "fil_bedroom")).toBe(true);
  });

  it("never renders a persona's take without her still: a refused request fails the take instead of changing her face", async () => {
    const { setSetting, deleteSetting } = await import("@/lib/settings");
    const { ApiError } = await import("@/lib/http");
    const brandId = await createBrand("organic-refused.example");
    const campaignId = await startCampaign(brandId, { concepts: 1, shotsPerConcept: 2, secondsPerShot: 4, videoModel: "kwaivgi/kling-v3.0-pro", learnStyle: false });
    const script = goodScript();
    const plan = planOrganic(script, brief, product, personaFor(persona, "bedroom"));
    const { conceptFrom } = await import("@/lib/strategy");
    await insertCreative(campaignId, 0, conceptFrom(brief, script, plan, undefined, product, { formula: insider, persona: personaFor(persona, "bedroom") }));
    const asked: Array<{ image_urls?: string[] }> = [];
    const naive = {
      generateImage: async () => {
        throw new Error("no frames for a persona");
      },
      fileUrl: async (fileId: string) => ({ url: `https://files.invalid/${fileId}.png`, expires_at: "" }),
      generateVideo: async (input: { image_urls?: string[] }) => {
        asked.push(input);
        throw new ApiError("naive", 400, "validation_failed", "this model does not take that length");
      },
      message: async () => ({ stop_reason: "end_turn", content: [{ type: "text", text: '{"pass": true, "issues": []}' }] }),
    };
    const ctx = { campaignId, brandId, naive, monid: null, naiveOut: () => false, markNaiveOut: async () => undefined, strategy: { brand: {} } } as unknown as ProductionContext;
    await setSetting("presenter_engine", "naive");
    await setSetting("video_model", "kwaivgi/kling-v3.0-pro");
    try {
      for (let tick = 0; tick < 3; tick++) {
        const [row] = await listCreatives(campaignId);
        await advanceCreative(ctx, row);
      }
    } finally {
      await deleteSetting("presenter_engine");
      await deleteSetting("video_model");
    }
    // Every request carried her still; none went out as text alone.
    expect(asked.length).toBeGreaterThan(0);
    expect(asked.every((input) => input.image_urls?.[0] === "fil_bedroom")).toBe(true);
    const [row] = await listCreatives(campaignId);
    expect(row.status).toBe("failed");
  });
});

const ffmpeg = await editFfmpeg();

describe.skipIf(!ffmpeg)("the punch-in", () => {
  let dir = "";
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "nomen-punch-"));
    await exec(ffmpeg!, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=540x960:rate=30:duration=1", "-f", "lavfi", "-i", "sine=frequency=220:duration=1", "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", join(dir, "take.mp4")]);
  }, 60_000);
  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("lays a ducked music bed and sound effects under the voice", async () => {
    // A "voice" that speaks for the first second and is silent for the second.
    const voice = join(dir, "voice.mp4");
    await exec(ffmpeg!, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=540x960:rate=30:duration=2", "-f", "lavfi", "-i", "aevalsrc='if(lt(t,1),0.5*sin(2*PI*440*t),0)':s=48000:d=2", "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", voice]);
    const bed = join(dir, "bed.wav");
    await exec(ffmpeg!, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=220:duration=1.5:sample_rate=48000", bed]);
    const pop = join(dir, "pop.wav");
    await exec(ffmpeg!, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=1000:duration=0.1:sample_rate=48000", pop]);
    // RMS of the second half (the voice's pause), from the rendered file's audio.
    const pauseLevel = async (file: string) => {
      const { stderr } = await exec(ffmpeg!, ["-hide_banner", "-nostats", "-ss", "1.2", "-t", "0.6", "-i", file, "-af", "astats=measure_overall=RMS_level:measure_perchannel=none", "-f", "null", "-"]);
      const level = /RMS level dB: (\S+)/.exec(stderr)?.[1];
      return level === undefined || level === "-inf" ? -200 : Number(level);
    };
    const plain = join(dir, "plain-sound.mp4");
    const scored = join(dir, "scored.mp4");
    const base = { aroll: [{ path: voice }], audio: null, segments: [], captions: [], overlays: [] };
    await renderTimeline(base, plain, { workDir: dir });
    await renderTimeline({ ...base, music: { path: bed }, sfx: [{ at: 1.4, path: pop }] }, scored, { workDir: dir });
    const info = await probe(scored);
    expect(info).toMatchObject({ width: 1080, height: 1920, hasAudio: true });
    expect(info.duration).toBeCloseTo(2, 0);
    // In the pause there is music (and the pop) where the plain cut is silent.
    expect(await pauseLevel(scored)).toBeGreaterThan((await pauseLevel(plain)) + 20);
  }, 120_000);

  it("lays sound effects over the finished, normalized voice at their own level, so loudness never pumps them", async () => {
    // A quiet voice (Kling renders around -30 dB) that starts late, and a full-scale pop before it.
    const voice = join(dir, "late-voice.mp4");
    await exec(ffmpeg!, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=540x960:rate=30:duration=3", "-f", "lavfi", "-i", "aevalsrc='if(gt(t,1),0.04*sin(2*PI*300*t),0)':s=48000:d=3", "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", voice]);
    const pop = join(dir, "loud-pop.wav");
    await exec(ffmpeg!, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "aevalsrc='sin(2*PI*1000*t)':s=48000:d=0.1", pop]);
    const out = join(dir, "finished-pop.mp4");
    await renderTimeline({ aroll: [{ path: voice }], audio: null, segments: [], captions: [], overlays: [], sfx: [{ at: 0.2, path: pop, level: 0.15 }] }, out, { workDir: dir, finish: true });
    const { stderr } = await exec(ffmpeg!, ["-hide_banner", "-nostats", "-ss", "0.1", "-t", "0.4", "-i", out, "-vn", "-af", "astats=measure_perchannel=none", "-f", "null", "-"]);
    const peak = Number(/Peak level dB: (\S+)/.exec(stderr)?.[1]);
    // 0.15 of full scale is about -16.5 dB; mixed before the normalizer it came out near 0 dB.
    expect(peak).toBeLessThan(-10);
    expect(peak).toBeGreaterThan(-24);
  }, 120_000);

  it("hears whether a generated sound effect is audible: a near-silent one is not used", async () => {
    const tone = join(dir, "tone.wav");
    const hush = join(dir, "hush.wav");
    await exec(ffmpeg!, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=500:duration=0.5:sample_rate=48000", tone]);
    await exec(ffmpeg!, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "anoisesrc=color=pink:amplitude=0.003:duration=0.5:sample_rate=48000", hush]);
    expect(await peakLevel(tone)).toBeGreaterThan(-24); // the sine source plays at 1/8 scale, -18 dB
    expect(await peakLevel(hush)).toBeLessThan(-40);
  });

  it("crops into the take when a clip asks for a zoom", async () => {
    const still = async (zoom: number | undefined, name: string) => {
      const out = join(dir, `${name}.mp4`);
      await renderTimeline({ aroll: [{ path: join(dir, "take.mp4"), ...(zoom ? { zoom } : {}) }], audio: null, segments: [], captions: [], overlays: [] }, out, { workDir: dir });
      const frame = join(dir, `${name}.png`);
      await exec(ffmpeg!, ["-hide_banner", "-loglevel", "error", "-y", "-ss", "0.5", "-i", out, "-frames:v", "1", frame]);
      return readFile(frame);
    };
    const full = await still(undefined, "full");
    const punched = await still(1.3, "punched");
    expect(full.equals(punched)).toBe(false);
  }, 120_000);
});

describe("the creative_mode setting", () => {
  it("starts campaigns as remakes by default, and as organic videos with the persona when set", async () => {
    const { defaultOptions } = await import("@/lib/pipeline");
    const { setSetting, deleteSetting } = await import("@/lib/settings");
    expect(defaultOptions().mode ?? "remake").toBe("remake");
    expect(defaultOptions().persona).toBeUndefined();
    await setSetting("creative_mode", "organic");
    await setSetting("persona", JSON.stringify(persona));
    try {
      const options = defaultOptions();
      expect(options.mode).toBe("organic");
      expect(options.persona?.stills.map((s) => s.setting)).toEqual(["bedroom", "kitchen"]);
    } finally {
      await deleteSetting("creative_mode");
      await deleteSetting("persona");
    }
  });
});
