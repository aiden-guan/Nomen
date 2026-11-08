import { execFile } from "node:child_process";
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { toAss } from "@/lib/creative/captions";
import { editFfmpeg } from "@/lib/creative/edit";
import { planProduction } from "@/lib/creative/plan";
import {
  bandArgs,
  captionStyle,
  cleanFramePrompt,
  composeArgs,
  entrance,
  graphicKind,
  graphicRequest,
  jobFile,
  mapTime,
  modelAspect,
  parseLayout,
  placeShots,
  planRemake,
  readBox,
  remakeCaptions,
  remakeSpan,
  remakeVideo,
  type RemakeClient,
  type RemakeLayout,
  sampleTimes,
  shotPrompt,
  speechSpan,
  splitLine,
  splitSpan,
  stageOf,
} from "@/lib/creative/remake";
import { ensureReferenceVideo } from "@/lib/creative/remake-job";
import { screenSize, writerSystem } from "@/lib/creative/screens";
import { beatWordBudget, lintScript, normalizeScript, type ScriptContext, targetSeconds } from "@/lib/creative/script";
import type { CreativeBrief, ProductBrief, ReferenceBeat, ReferenceBreakdown } from "@/lib/creative/types";
import { probe } from "@/lib/media";
import { postingHold } from "@/lib/publish";

const exec = promisify(execFile);

// The first three beats of the Cluely billboard video, as its breakdown has them.
const beats: ReferenceBeat[] = [
  { start: 0, end: 3.7, job: "hook", shot: "talking_head", visual: "presenter at the left edge, gesturing", on_screen_text: "", line: "We spent $400,000 on these billboards, and we saw, wow," },
  { start: 3.7, end: 9, job: "proof", shot: "split", visual: "a framed photo of billboards appears on the board", on_screen_text: "", line: "these are getting millions of views. Everyone is reposting them." },
  { start: 9, end: 15.6, job: "payoff", shot: "talking_head", visual: "centred, leaning in", on_screen_text: "", line: "We created a cultural moment which can't even be priced, and so this was worth it. This was successful." },
  { start: 15.6, end: 22.6, job: "agitate", shot: "split", visual: "shrinks to the bottom left", on_screen_text: "", line: "And it's really funny seeing everybody analyze the thought process behind these billboards." },
];

const breakdown: ReferenceBreakdown = {
  id: "ref_39fbf885ae",
  url: "https://www.tiktok.com/@cluelyextras/video/7544005050146770189",
  platform: "tiktok",
  author: "cluelyextras",
  views: 628239,
  followers: 2969,
  outlier: 211.6,
  duration: 22.6,
  format: "green-screen presenter over a chalkboard in a centre band, blurred copies above and below",
  hook: { line: beats[0].line, on_screen_text: "", visual: beats[0].visual, mechanic: "big money figure" },
  beats,
  pacing: { cuts: 4, avg_shot_seconds: 5.6, words_per_minute: 251 },
  caption_style: "Bold white uppercase sans-serif with a heavy black outline, no box. 2-3 words at a time.",
  delivery: "Fast, casual, deadpan-smug founder voice at 251 wpm. His hands are always busy: pointing, miming.",
  why_it_works: "",
  fit: { score: 5, reason: "" },
  transcript: beats.map((b) => b.line).join(" "),
};

const product: ProductBrief = {
  name: "Monid",
  one_liner: "One balance and one skill file for every tool your agent uses",
  kind: "software",
  audience: "agent builders",
  problem: "a sign-up per tool",
  aha: "set up https://monid.ai/SKILL.md",
  features: [],
  claims: ["2900+ tools across 97+ providers", "Start with $1 in free credit."],
  proof: [],
  objections: [],
  offer: "$1 free credit",
  voice: "plain",
  look: "light minimal page",
  visuals: [],
};

const rawLayout = {
  frame: { kind: "band", band: { x: 0, y: 0.268, w: 1, h: 0.464 } },
  set: "green classroom chalkboard over a beige wooden wainscot, evenly lit",
  presenter: "young man, dark hair, black hoodie",
  beats: [
    { n: 1, visible: true, speaking: true, box: { x: 0, y: 0.15, w: 0.4, h: 0.85 }, framing: "waist-up at the left edge", motion: "Gestures with both hands, looks up and off to the side." },
    { n: 2, visible: true, speaking: true, box: { x: 0, y: 0.2, w: 0.38, h: 0.8 }, framing: "waist-up at the left", motion: "Mimes with both fists. The caption pops on." },
    { n: 3, visible: true, speaking: true, box: { x: 0.25, y: 0.05, w: 0.5, h: 0.95 }, framing: "chest-up, centred", motion: "Leans in, swings one arm." },
  ],
  graphics: [
    { kind: "LinkedIn post", box: { x: 43, y: 2, w: 53, h: 68 }, start: 1, end: 4.1, shows: "a LinkedIn post about billboards in Times Square", entrance: "pop" },
    { kind: "photo", box: { x: 0.45, y: 0.05, w: 0.5, h: 0.6 }, start: 4.1, end: 30, shows: "a phone video of billboards with a view count", entrance: "slide_up" },
    { kind: "tweet", box: { x: 0.5, y: 0.5, w: 0.001, h: 0.4 }, start: 2, end: 3, shows: "too thin", entrance: "pop" },
  ],
  captions: { case: "upper", italic: true, color: "#ffffff", outline: "heavy", shadow: true, words: 3, center_y: 0.69, size: 0.03, badge: { box: { x: 0.86, y: 0.67, w: 0.12, h: 0.06 }, color: "#FFD43B", accent: "#E5383B", looks_like: "alarm clock emoji" } },
};

const span = remakeSpan(beats, 15);
const layout: RemakeLayout = parseLayout(rawLayout, { beats: span.beats, until: span.end, caption_style: breakdown.caption_style });

describe("the layout", () => {
  it("reads boxes as fractions, percentages included, and drops slivers", () => {
    expect(readBox({ x: 0.1, y: 0.2, w: 0.5, h: 0.5 })).toEqual({ x: 0.1, y: 0.2, w: 0.5, h: 0.5 });
    expect(readBox({ x: 43, y: 2, w: 53, h: 68 })).toEqual({ x: 0.43, y: 0.02, w: 0.53, h: 0.68 });
    expect(readBox({ x: 0.8, y: 0.8, w: 0.5, h: 0.5 })).toEqual({ x: 0.8, y: 0.8, w: 0.2, h: 0.2 });
    expect(readBox({ x: 0.5, y: 0.5, w: 0.01, h: 0.4 })).toBeNull();
    expect(readBox("nope")).toBeNull();
  });

  it("maps a model's names for overlays onto the kinds we rebuild", () => {
    expect(graphicKind("LinkedIn post")).toBe("social_post");
    expect(graphicKind("X post screenshot")).toBe("tweet");
    expect(graphicKind("engagement bar chart")).toBe("chart");
    expect(graphicKind("webcam inset of a person")).toBe("webcam");
    expect(graphicKind("Mario-like level")).toBe("game_scene");
    expect(graphicKind("selfie")).toBe("photo");
    expect(graphicKind("??")).toBe("other");
  });

  it("covers whole beats up to `until`", () => {
    expect(span.beats.map((b) => b.start)).toEqual([0, 3.7, 9]);
    expect(span.end).toBe(15.6);
    expect(remakeSpan(beats).end).toBe(22.6);
  });

  it("keeps the band, one beat per reference beat timed by the reference, and graphics inside the span", () => {
    expect(layout.frame).toEqual({ kind: "band", band: { x: 0, y: 0.268, w: 1, h: 0.464 } });
    expect(layout.beats.map((b) => [b.n, b.start, b.end])).toEqual([
      [1, 0, 3.7],
      [2, 3.7, 9],
      [3, 9, 15.6],
    ]);
    expect(layout.graphics.map((g) => [g.id, g.kind, g.start, g.end])).toEqual([
      ["g1", "social_post", 1, 4.1],
      ["g2", "photo", 4.1, 15.6],
    ]);
    expect(layout.captions).toMatchObject({ upper: true, italic: true, color: "#FFFFFF", words: 3, center_y: 0.69 });
    expect(layout.captions.badge?.looks_like).toBe("alarm clock emoji");
  });

  it("falls back to a full frame and the breakdown's caption words when the answer is thin", () => {
    const thin = parseLayout({ frame: { kind: "band", band: { x: 0, y: 0, w: 1, h: 0.98 } } }, { beats: span.beats, until: span.end, caption_style: breakdown.caption_style });
    expect(thin.frame.kind).toBe("full");
    expect(thin.beats).toHaveLength(3);
    expect(thin.beats[0].presenter).toMatchObject({ visible: true, speaking: true });
    expect(thin.captions).toMatchObject({ upper: true, words: 3, outline: "heavy" });
    expect(thin.graphics).toEqual([]);
  });

  it("samples frames across the span and at every beat start", () => {
    const times = sampleTimes(span.beats, span.end);
    expect(times.length).toBeLessThanOrEqual(12); // Naive's image limit per request
    expect(times[0]).toBeGreaterThanOrEqual(0);
    expect(times[times.length - 1]).toBeLessThan(span.end);
    for (const beat of span.beats) expect(times.some((t) => Math.abs(t - beat.start - 0.25) < 0.4)).toBe(true);
  });
});

describe("the plan", () => {
  it("puts the band on the frame and renders it in the nearer model aspect", () => {
    const stage = stageOf(layout);
    expect(stage).toEqual({ x: 0, y: 514, width: 1080, height: 890, band: true });
    expect(modelAspect(stage)).toBe("16:9");
    expect(stageOf({ frame: { kind: "full" } })).toEqual({ x: 0, y: 0, width: 1080, height: 1920, band: false });
  });

  it("splits a beat at the reference's cuts and at 8 s, never leaving a stub", () => {
    expect(splitSpan({ start: 0, end: 3.7 }, [3.7, 9])).toEqual([{ start: 0, end: 3.7 }]);
    expect(splitSpan({ start: 9, end: 18 }, [])).toEqual([
      { start: 9, end: 13.5 },
      { start: 13.5, end: 18 },
    ]);
    expect(splitSpan({ start: 0, end: 10 }, [4, 4.5, 9.5])).toEqual([
      { start: 0, end: 4 },
      { start: 4, end: 10 },
    ]);
  });

  it("shares a line across shots by length, at a phrase end when one is near", () => {
    expect(splitLine("one two three", [3])).toEqual(["one two three"]);
    const [a, b] = splitLine("We gave an agent three dollars, and it found twelve tools for the job.", [3, 3]);
    expect(a).toBe("We gave an agent three dollars,");
    expect(b).toBe("and it found twelve tools for the job.");
  });

  it("plans one Veo shot per beat here, with render lengths that fit the line", () => {
    const lines = ["We gave an agent a $3 balance and one skill file, and we saw, wow,", "it found 12 candidates ranked by fit and price. Then it ran one.", "No sign-up. We killed the subscriptions, and so this was worth it."];
    const plan = planRemake(layout, { lines, cuts: [3.7, 9.03, 15.63], until: span.end, persona: "Man, 20s, dark tousled hair, plain black hoodie with no logo", delivery: breakdown.delivery, product });
    expect(plan.aspect).toBe("16:9");
    expect(plan.shots.map((s) => [s.beat, s.start, s.end, s.seconds, s.mode])).toEqual([
      [1, 0, 3.7, 6, "veo"],
      [2, 3.7, 9, 6, "veo"],
      [3, 9, 15.6, 8, "veo"],
    ]);
    const first = plan.shots[0];
    expect(first.frame_at).toBeCloseTo(0.15);
    expect(first.frame_prompt).toContain("Remove everything that was laid over the footage");
    expect(first.frame_prompt).toContain("blurred filler");
    expect(first.video_prompt).toContain(`"${lines[0]}"`);
    expect(first.video_prompt).toContain("No on-screen text");
    expect(first.video_prompt).toContain("with this delivery: Fast, casual, deadpan-smug founder voice");
    expect(first.video_prompt).not.toMatch(/pointing, miming|wpm|caption pops/i);
    expect(plan.graphics.map((g) => [g.id, g.px, g.request.box])).toEqual([
      ["g1", { x: 464, y: 18, width: 572, height: 606 }, { width: 572, height: 606 }],
      ["g2", { x: 486, y: 44, width: 540, height: 534 }, { width: 540, height: 534 }],
    ]);
    expect(plan.graphics[0].request.line).toBe(`${lines[0]} ${lines[1]}`);
  });

  it("swaps silent shots on the reference footage when asked, and keeps an empty set as a still", () => {
    const silent: RemakeLayout = { ...layout, beats: [layout.beats[0], { ...layout.beats[1], presenter: { ...layout.beats[1].presenter, visible: false } }, layout.beats[2]] };
    const plan = planRemake(silent, { lines: ["", "", "a line"], cuts: [], until: span.end, persona: "a woman, 30s", delivery: "", product, swapSilent: true });
    expect(plan.shots.map((s) => s.mode)).toEqual(["swap", "still", "veo"]);
    expect(plan.shots[1].frame_prompt).toContain("There is no one in it");
    expect(plan.shots[2].video_prompt).toContain('She says');
    const voiceOnly = shotPrompt({ persona: "a woman, 30s", set: "chalkboard", aspect: "16:9", motion: "", line: "so let's go", delivery: "", presenter: false });
    expect(voiceOnly).toContain('A woman\'s voice off camera says, fast and casual: "so let\'s go"');
    expect(voiceOnly).toContain("No one appears");
  });

  it("asks for the same kind of element about our product, at its box size", () => {
    const g = graphicRequest(layout.graphics[0], { stage: { width: 1080, height: 890 }, line: "it found 12 candidates", product });
    expect(g.request.brief).toMatch(/^a social post card/);
    expect(g.request.brief).toContain("about Monid");
    expect(g.request.brief).toContain('"it found 12 candidates"');
    expect(g.request.seconds).toBe(3.6);
    expect(g.request.reference_visual).toContain("social post: a LinkedIn post");
  });

  it("writes clean-frame prompts that name no overlay to draw", () => {
    const prompt = cleanFramePrompt({ persona: "Man, 20s, plain black hoodie with no logo", set: "green chalkboard", presenter: true, padded: false, fix: "a caption is left" });
    expect(prompt).toContain("plain black hoodie");
    expect(prompt).not.toMatch(/\b(tweet|chart|billboard|screenshot)\b/i);
    expect(prompt).toContain("Fix exactly this: a caption is left");
  });

  it("keeps the presenter's voice but drops gesture notes from the delivery", () => {
    const prompt = shotPrompt({ persona: "Man, 20s", set: "green chalkboard", aspect: "9:16", motion: "Walks to the centre. Points at the tweet card.", line: "hi", delivery: "Smug and fast. His hands are always busy: pointing." });
    expect(prompt).toContain("Vertical 9:16");
    expect(prompt).toContain("Walks to the centre");
    expect(prompt).not.toContain("tweet card");
    expect(prompt).toContain("Smug and fast");
    expect(prompt).not.toContain("always busy");
  });
});

describe("timing", () => {
  it("finds the speech between a render's leading and trailing silence", () => {
    expect(speechSpan([{ start: 0, end: 0.45 }, { start: 3.2, end: 4 }], 4)).toEqual({ from: 0.45, to: 3.2 });
    expect(speechSpan([], 4)).toEqual({ from: 0, to: 4 });
    expect(speechSpan([{ start: 0, end: 4 }], 4)).toBeNull();
  });

  it("keeps each shot's reference length, skips the opening silence and gives a long line more time", () => {
    const shots = [
      { n: 1, start: 0, end: 3.7, line: "a b c", mode: "veo" as const },
      { n: 2, start: 3.7, end: 9, line: "d e f", mode: "veo" as const },
      { n: 3, start: 9, end: 10, line: "", mode: "still" as const },
    ];
    const placed = placeShots(shots, [
      { duration: 6, speech: { from: 0.4, to: 4.6 } },
      { duration: 6, speech: { from: 0.2, to: 3 } },
      { duration: 1, speech: null },
    ]);
    expect(placed.map((p) => [p.out_start, p.out_end, p.from])).toEqual([
      [0, 4.43, 0.32],
      [4.43, 9.73, 0.12],
      [9.73, 10.73, 0],
    ]);
    expect(placed[0].speech).toEqual({ from: 0.08, to: 4.28 });
    expect(mapTime(placed, 1.85)).toBeCloseTo(2.215, 3);
    expect(mapTime(placed, 9)).toBeCloseTo(9.73, 3);
    expect(mapTime(placed, 99)).toBe(10.73);
    const captions = remakeCaptions(shots, placed, 3);
    expect(captions[0].start).toBeCloseTo(0.08, 2);
    expect(captions.every((c) => c.end <= 10.73)).toBe(true);
    expect(captions.map((c) => c.text).join(" ")).toBe("a b c d e f");
  });

  it("turns the caption look into the edit's caption style", () => {
    const style = captionStyle(layout.captions);
    expect(style).toMatchObject({ upper: true, italic: true, color: 0xffffff, outline: 8, shadow: true, em: 82 });
    expect(style.bottom).toBeCloseTo(0.709, 3);
    expect(style.badge).toMatchObject({ x: 994, y: 1344, size: 130, color: 0xffd43b, accent: 0xe5383b });
  });

  it("burns captions in the reference's look: uppercase, slanted, with its sticker", () => {
    const ass = toAss({ captions: [{ start: 0.1, end: 0.9, text: "we gave it" }], overlays: [] }, { caption: { ...captionStyle(layout.captions), shadow: false } });
    expect(ass).toMatch(/^Style: Caption,[^,]+,\d+,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,-1,/m);
    expect(ass).toContain("WE GAVE IT");
    expect(ass).not.toContain("CaptionShadow,,");
    expect(ass.match(/^Dialogue: [45],/gm)).toHaveLength(2);
    const plain = toAss({ captions: [{ start: 0.1, end: 0.9, text: "we gave it" }], overlays: [] });
    expect(plain).toContain("we gave it");
    expect(plain).toMatch(/^Style: Caption,[^,]+,\d+,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,/m);
  });
});

describe("ffmpeg arguments", () => {
  it("crops every shot to the stage's aspect and keeps or pads its sound", () => {
    const args = bandArgs(
      [
        { path: "/a.mp4", kind: "video", from: 0.3, seconds: 3.7, hasAudio: true },
        { path: "/b.png", kind: "image", from: 0, seconds: 2, hasAudio: false },
      ],
      { width: 1080, height: 890 },
      "/out.mp4",
    );
    const graph = args[args.indexOf("-filter_complex") + 1];
    expect(args.slice(5, 11)).toEqual(["-ss", "0.3", "-t", "4.2", "-i", "/a.mp4"]);
    expect(args).toContain("-loop");
    expect(graph).toContain("crop='min(iw,ih*1.2135)':'min(ih,iw/1.2135)',scale=1080:890");
    expect(graph).toContain("trim=end_frame=111");
    expect(args).toContain("anullsrc=r=48000:cl=stereo");
    expect(graph).toContain("[2:a]aformat");
    expect(graph).toContain("concat=n=2:v=1:a=1[v][a]");
  });

  it("lays graphics over the band with their entrances, then the blurred fill and captions", () => {
    const args = composeArgs({
      band: "band.mp4",
      stage: { x: 0, y: 514, width: 1080, height: 890, band: true },
      duration: 10,
      graphics: [{ path: "g1.mp4", kind: "video", start: 1, end: 4, x: 464, y: 18, width: 572, height: 606, entrance: "slide_up" }],
      ass: "captions.ass",
      out: "out.mp4",
    });
    const graph = args[args.indexOf("-filter_complex") + 1];
    expect(graph).toContain("scale=572:606");
    expect(graph).toContain("setpts=PTS-STARTPTS+1/TB");
    expect(graph).toContain("overlay=x='464':y='18+90*pow(1-min(1,max(0,(t-1)/0.3)),3)'");
    expect(graph).toContain("enable='between(t,1,4)'");
    expect(graph).toContain("gblur=sigma=30");
    expect(graph).toContain("[bg][fg]overlay=0:514[full]");
    expect(graph).toContain("ass=filename=captions.ass:fontsdir=fonts");
    expect(entrance("cut", 1, 2, 0)).toEqual({ x: "1", y: "2", fade: 0 });
  });

  it("reads a finished job's file in every shape the API answers", () => {
    expect(jobFile({ result: { files: [{ file_id: "fil_a" }] } })).toBe("fil_a");
    expect(jobFile({ result: { file_id: "fil_b" } })).toBe("fil_b");
    expect(jobFile({ result: null })).toBeNull();
  });
});

describe("the script, screens and publishing for remakes", () => {
  const brief: CreativeBrief = {
    title: "Remake",
    reference_id: breakdown.id,
    format: "remake",
    angle: "",
    audience: "",
    hook_plan: "",
    keep: [],
    change: [],
    visuals: [],
    creator: "Man, 20s",
    setting: "",
    platforms: ["tiktok"],
    caption: "",
    hashtags: [],
    cta: "",
    why: "",
  };
  const ctx: ScriptContext = { product, brief, reference: { ...breakdown, beats: span.beats, duration: span.end }, targetSeconds: targetSeconds({ duration: span.end }, "remake") };

  it("budgets each beat's words at the reference's pace and keeps its length", () => {
    expect(beatWordBudget(3.7, 251)).toBe(15);
    expect(beatWordBudget(3.7, null)).toBe(10);
    expect(targetSeconds({ duration: 62 }, "remake")).toBe(62);
    expect(targetSeconds({ duration: 62 }, "split_screen")).toBe(24);
  });

  it("normalizes a remake to one presenter beat per reference beat, timed like it", () => {
    const script = normalizeScript([{ n: 1, line: "one", visual: "split", seconds: 8 }, { n: 3, line: "three" }], ctx);
    expect(script.beats.map((b) => [b.n, b.seconds, b.line, b.visual])).toEqual([
      [1, 3.7, "one", "creator"],
      [2, 5.3, "", "creator"],
      [3, 6.6, "three", "creator"],
    ]);
    expect(script.total_seconds).toBe(15.6);
    const issues = lintScript(script, ctx);
    expect(issues).toContain("a remake needs a line for every reference beat that has one");
    const long = normalizeScript([{ n: 1, line: Array.from({ length: 20 }, () => "word").join(" ") }, { n: 2, line: "two" }, { n: 3, line: "three" }], ctx);
    expect(lintScript(long, ctx)).toContain("beat 1 is 20 words; the reference fits 15 in its 3.7s");
  });

  it("plans nothing for the standard production path", () => {
    const plan = planProduction({ beats: [], total_seconds: 0, review: null }, brief, product);
    expect(plan).toEqual({ format: "remake", aroll: [], broll: [], voiceover: null, screens: [] });
  });

  it("builds a graphic at its exact box size, as one element", () => {
    expect(screenSize({ size: "full", box: { width: 571, height: 606 } })).toEqual({ width: 572, height: 606 });
    expect(screenSize({ size: "half" })).toEqual({ width: 1080, height: 960 });
    const system = writerSystem({ size: "full", seconds: 3, box: { width: 572, height: 606 } });
    expect(system).toContain("Exactly 572x606 CSS pixels: one element");
    expect(system).not.toContain("TikTok's top bar");
  });

  it("holds internal remakes back from posting unless cleared", () => {
    expect(postingHold({ internal: true })).toBe("internal remake: not cleared for posting");
    expect(postingHold({ brief })).toBe("internal remake: not cleared for posting");
    expect(postingHold({ internal: true, cleared: { at: "2026-11-07T00:00:00Z", by: "Dylan", note: "consent on file" } })).toBeNull();
    expect(postingHold({})).toBeNull();
    expect(postingHold(null)).toBeNull();
  });
});

// ---------- the whole remake, with a fake Naive ----------

const ffmpeg = await editFfmpeg();

describe.skipIf(!ffmpeg)("remakeVideo (fake Naive)", () => {
  let dir = "";
  const make = (args: string[]) => exec(ffmpeg!, ["-hide_banner", "-loglevel", "error", "-y", ...args]);
  const x264 = ["-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p"];

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "nomen-remake-test-"));
    // A 6 s 576x1024 "reference" with sound, a 16:9 "render" that speaks from 0.4 s to 3 s, a still and a persona.
    await make(["-f", "lavfi", "-i", "testsrc=size=576x1024:rate=30:duration=6", "-f", "lavfi", "-i", "sine=frequency=440:duration=6", ...x264, "-c:a", "aac", "-shortest", join(dir, "reference.mp4")]);
    await make(["-f", "lavfi", "-i", "testsrc=size=640x360:rate=30:duration=4", "-f", "lavfi", "-i", "sine=frequency=300:duration=4,volume=volume='between(t,0.4,3.0)':eval=frame", ...x264, "-c:a", "aac", "-shortest", join(dir, "render.mp4")]);
    await make(["-f", "lavfi", "-i", "color=c=green:s=1344x756", "-frames:v", "1", join(dir, "clean.png")]);
    await make(["-f", "lavfi", "-i", "color=c=gray:s=360x640", "-frames:v", "1", join(dir, "persona.png")]);
  }, 60_000);

  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  function fakeNaive() {
    const calls = { images: 0, videos: 0, uploads: 0, analysis: 0, gate: 0 };
    const client: RemakeClient = {
      async message(input) {
        if (input.tools?.length) {
          calls.analysis++;
          return {
            stop_reason: "tool_use",
            content: [
              {
                type: "tool_use",
                name: "remake_layout",
                input: {
                  ...rawLayout,
                  beats: rawLayout.beats.slice(0, 2),
                  graphics: [{ kind: "tweet", box: { x: 0.5, y: 0.1, w: 0.4, h: 0.5 }, start: 1, end: 3, shows: "a post", entrance: "pop" }],
                },
              },
            ],
          };
        }
        calls.gate++;
        // The first clean frame is sent back once; every other one passes.
        const verdict = calls.gate === 1 ? { pass: false, issues: ['a caption "WE SPENT" is still there'] } : { pass: true, issues: [] };
        return { stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(verdict) }] };
      },
      async generateImage() {
        calls.images++;
        return { model: "fake", files: [{ id: `fil_img${calls.images}`, content_type: "image/png" }], cost_micro_usd: 40_000 };
      },
      async generateVideo() {
        calls.videos++;
        return { id: `job_${calls.videos}`, status: "queued", model: "fake", result: null, error: null, cost_micro_usd: null };
      },
      async getMediaJob(id) {
        return { id, status: "completed", model: "fake", result: { files: [{ file_id: `fil_vid_${id}`, content_type: "video/mp4" }] }, error: null, cost_micro_usd: 1_600_000 };
      },
      async uploadFile() {
        calls.uploads++;
        return `fil_up${calls.uploads}`;
      },
      async fileUrl(id) {
        return { url: `https://files.invalid/${id}`, expires_at: "" };
      },
    };
    return { client, calls };
  }

  const shortBreakdown: ReferenceBreakdown = { ...breakdown, duration: 6, beats: [{ ...beats[0], end: 2.5 }, { ...beats[1], start: 2.5, end: 6 }] };
  const fetchFile = async (fileId: string, path: string) => copyFile(join(dir, fileId.startsWith("fil_img") ? "clean.png" : "render.mp4"), path);
  const buildGraphics = async (requests: Array<{ id: string; box?: { width: number; height: number } }>, workDir: string) => {
    const clips = [];
    for (const r of requests) {
      const path = join(workDir, `${r.id}.mp4`);
      await make(["-f", "lavfi", "-i", `color=c=white:s=${r.box!.width}x${r.box!.height}:d=2:r=30`, ...x264, path]);
      clips.push({ id: r.id, kind: "video" as const, path, seconds: 2, html_path: "" });
    }
    return { clips, failures: [] };
  };

  it("analyzes, plans, cleans, renders, builds graphics and cuts a 1080x1920 remake, then resumes for free", async () => {
    const { client, calls } = fakeNaive();
    const input = {
      referencePath: join(dir, "reference.mp4"),
      breakdown: shortBreakdown,
      lines: ["We gave an agent three dollars,", "and it found twelve tools."],
      personaPath: join(dir, "persona.png"),
      persona: "Man, 20s, plain black hoodie",
      product,
      kit: null,
      workDir: join(dir, "work"),
      outPath: join(dir, "out", "final.mp4"),
      idem: "crv_test",
      pollMs: 0,
      fetchFile,
      buildGraphics,
    };
    const result = await remakeVideo(client, input);
    expect(calls.analysis).toBe(1);
    expect(result.plan.shots).toHaveLength(2);
    expect(calls.images).toBe(3); // shot 1 remade once after the gate
    expect(calls.videos).toBe(2);
    expect(result.cost_micro).toBe(3 * 40_000 + 2 * 1_600_000);
    const out = await probe(result.path);
    expect(out.width).toBe(1080);
    expect(out.height).toBe(1920);
    expect(out.hasAudio).toBe(true);
    // Shot 1 runs 2.5 s in the reference but its line runs to 3 s in the render, from 0.4 s.
    expect(result.duration).toBeGreaterThan(5.9);
    expect(out.duration).toBeCloseTo(result.duration, 0);
    const manifest = JSON.parse(await readFile(join(dir, "work", "manifest.json"), "utf8"));
    expect(manifest.shots["1"]).toMatchObject({ frame_tries: 2, frame_done: true, renders: 1 });
    expect(manifest.graphics.clips).toHaveLength(1);

    // Set NOMEN_REMAKE_KEEP=/some/dir to keep the cut for a look.
    if (process.env.NOMEN_REMAKE_KEEP) await copyFile(result.path, join(process.env.NOMEN_REMAKE_KEEP, "remake-fake.mp4"));

    const again = fakeNaive();
    await remakeVideo(again.client, input);
    expect(again.calls).toMatchObject({ images: 0, videos: 0, analysis: 0, gate: 0 });
  }, 180_000);

  it("finds a reference video already on disk without downloading it", async () => {
    await copyFile(join(dir, "reference.mp4"), join(dir, "ref_x.mp4"));
    expect(await ensureReferenceVideo({ id: "ref_x", url: "https://example.invalid" }, null, dir)).toBe(join(dir, "ref_x.mp4"));
    await expect(ensureReferenceVideo({ id: "ref_missing", url: "https://example.invalid" }, null, dir)).rejects.toThrow(/save it as/);
  });
});
