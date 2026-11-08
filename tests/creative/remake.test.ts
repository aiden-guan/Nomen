import { describe, expect, it } from "vitest";

import { toAss } from "@/lib/creative/captions";
import { planProduction } from "@/lib/creative/plan";
import {
  captionStyle,
  composeArgs,
  entrance,
  graphicKind,
  graphicRequest,
  lineAt,
  overlayBeat,
  overlayLines,
  parseLayout,
  patient,
  readBox,
  type RemakeLayout,
  remakeSpan,
  sampleTimes,
  segmentKind,
  stageArgs,
  stageGraphic,
  stageOf,
  textsAss,
  tileSegments,
  wordCaptions,
} from "@/lib/creative/remake";
import { screenSize, writerSystem } from "@/lib/creative/screens";
import { beatWordBudget, lintRemake, lintScript, normalizeScript, remakeBrief, type ScriptContext, targetSeconds } from "@/lib/creative/script";
import type { CreativeBrief, ProductBrief, ReferenceBeat, ReferenceBreakdown } from "@/lib/creative/types";
import { ApiError } from "@/lib/http";
import { isInternal, postingHold } from "@/lib/publish";

// The first three beats of the Cluely billboard video, as its breakdown has them.
export const beats: ReferenceBeat[] = [
  { start: 0, end: 3.7, job: "hook", shot: "talking_head", visual: "presenter at the left edge, gesturing", on_screen_text: "", line: "We spent $400,000 on these billboards, and we saw, wow," },
  { start: 3.7, end: 9, job: "proof", shot: "split", visual: "a framed photo of billboards appears on the board", on_screen_text: "", line: "these are getting millions of views. Everyone is reposting them." },
  { start: 9, end: 15.6, job: "payoff", shot: "talking_head", visual: "centred, leaning in", on_screen_text: "", line: "We created a cultural moment which can't even be priced, and so this was worth it. This was successful." },
  { start: 15.6, end: 22.6, job: "agitate", shot: "split", visual: "shrinks to the bottom left", on_screen_text: "", line: "And it's really funny seeing everybody analyze the thought process behind these billboards." },
];

export const breakdown: ReferenceBreakdown = {
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

export const product: ProductBrief = {
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
  segments: [{ start: 0, end: 15.6, kind: "talking head", shows: "a man talking in front of a chalkboard" }],
  graphics: [
    { kind: "LinkedIn post", box: { x: 43, y: 2, w: 53, h: 68 }, start: 1, end: 4.1, shows: "a LinkedIn post about billboards in Times Square", entrance: "pop" },
    { kind: "photo", box: { x: 0.45, y: 0.05, w: 0.5, h: 0.6 }, start: 4.1, end: 30, shows: "a phone video of billboards with a view count", entrance: "slide_up" },
    { kind: "tweet", box: { x: 0.5, y: 0.5, w: 0.001, h: 0.4 }, start: 2, end: 3, shows: "too thin", entrance: "pop" },
  ],
  texts: [],
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

  it("maps a model's names for overlays and segments onto the kinds we rebuild", () => {
    expect(graphicKind("LinkedIn post")).toBe("social_post");
    expect(graphicKind("X post screenshot")).toBe("tweet");
    expect(graphicKind("engagement bar chart")).toBe("chart");
    expect(graphicKind("webcam inset of a person")).toBe("webcam");
    expect(graphicKind("Mario-like level")).toBe("game_scene");
    expect(graphicKind("selfie")).toBe("photo");
    expect(graphicKind("??")).toBe("other");
    expect(segmentKind("talking head")).toBe("talking_head");
    expect(segmentKind("duet with another creator")).toBe("stitch");
    expect(segmentKind("phone filming a monitor")).toBe("screen_walkthrough");
    expect(segmentKind("b-roll")).toBe("broll");
    expect(segmentKind("full-screen slide")).toBe("graphic");
  });

  it("covers whole beats up to `until`", () => {
    expect(span.beats.map((b) => b.start)).toEqual([0, 3.7, 9]);
    expect(span.end).toBe(15.6);
    expect(remakeSpan(beats).end).toBe(22.6);
  });

  it("keeps the band, one beat per reference beat timed by the reference, segments, and graphics inside the span", () => {
    expect(layout.frame).toEqual({ kind: "band", band: { x: 0, y: 0.268, w: 1, h: 0.464 } });
    expect(layout.beats.map((b) => [b.n, b.start, b.end])).toEqual([
      [1, 0, 3.7],
      [2, 3.7, 9],
      [3, 9, 15.6],
    ]);
    expect(layout.segments).toEqual([{ n: 1, start: 0, end: 15.6, kind: "talking_head", shows: "a man talking in front of a chalkboard", presenter: { box: null, inset: null, green: false }, other: "", screen: "" }]);
    expect(layout.graphics.map((g) => [g.id, g.kind, g.start, g.end])).toEqual([
      ["g1", "social_post", 1, 4.1],
      ["g2", "photo", 4.1, 15.6],
    ]);
    expect(layout.captions).toMatchObject({ case: "upper", italic: true, color: "#FFFFFF", words: 3, center_y: 0.69 });
    expect(layout.captions.badge?.looks_like).toBe("alarm clock emoji");
  });

  it("falls back to a full frame, one talking head and the breakdown's caption words when the answer is thin", () => {
    const thin = parseLayout({ frame: { kind: "band", band: { x: 0, y: 0, w: 1, h: 0.98 } } }, { beats: span.beats, until: span.end, caption_style: breakdown.caption_style });
    expect(thin.frame.kind).toBe("full");
    expect(thin.beats).toHaveLength(3);
    expect(thin.beats[0].presenter).toMatchObject({ visible: true, speaking: true });
    expect(thin.segments.map((s) => [s.kind, s.start, s.end])).toEqual([["talking_head", 0, 15.6]]);
    expect(thin.captions).toMatchObject({ case: "upper", words: 3, outline: "heavy" });
    expect(thin.graphics).toEqual([]);
    expect(thin.texts).toEqual([]);
    const wordByWord = parseLayout({}, { beats: span.beats, until: span.end, caption_style: "white lowercase, word by word, centred" });
    expect(wordByWord.captions).toMatchObject({ case: "lower", words: 1 });
  });

  it("tiles the segments over the span: edges meet halfway, slivers merge, the ends reach 0 and the end", () => {
    const seg = (start: number, end: number, kind: "talking_head" | "stitch" | "screen_walkthrough") => ({ start, end, kind, shows: "", presenter: { box: null, inset: null, green: false }, other: "", screen: "" });
    const tiled = tileSegments([seg(0.4, 3.2, "talking_head"), seg(3, 6.4, "stitch"), seg(6.4, 6.5, "talking_head"), seg(6.6, 11, "screen_walkthrough")], 12);
    expect(tiled.map((s) => [s.n, s.kind, s.start, s.end])).toEqual([
      [1, "talking_head", 0, 3.1],
      [2, "stitch", 3.1, 6.5],
      [3, "screen_walkthrough", 6.5, 12],
    ]);
  });

  it("samples frames across the span and at every beat start", () => {
    const times = sampleTimes(span.beats, span.end);
    expect(times.length).toBeLessThanOrEqual(12); // Naive's image limit per request
    expect(times[0]).toBeGreaterThanOrEqual(0);
    expect(times[times.length - 1]).toBeLessThan(span.end);
    for (const beat of span.beats) expect(times.some((t) => Math.abs(t - beat.start - 0.25) < 0.4)).toBe(true);
  });
});

describe("graphics", () => {
  it("puts the band on the frame", () => {
    expect(stageOf(layout)).toEqual({ x: 0, y: 514, width: 1080, height: 890, band: true });
    expect(stageOf({ frame: { kind: "full" } })).toEqual({ x: 0, y: 0, width: 1080, height: 1920, band: false });
  });

  it("asks for the same kind of element about our product, at its box size", () => {
    const g = graphicRequest(layout.graphics[0], { stage: { width: 1080, height: 890 }, line: "it found 12 candidates", product });
    expect(g.px).toEqual({ x: 464, y: 18, width: 572, height: 606 });
    expect(g.request.box).toEqual({ width: 572, height: 606 });
    expect(g.request.brief).toMatch(/^a social post card/);
    expect(g.request.brief).toContain("about Monid");
    expect(g.request.brief).toContain('"it found 12 candidates"');
    expect(g.request.seconds).toBe(3.1); // its time on screen, so the animation finishes before it goes
    expect(g.request.reference_visual).toContain("social post: a LinkedIn post");
  });

  it("finds our words under a graphic, and asks for a full-stage graphic for a segment", () => {
    expect(lineAt(span.beats, ["one", "two", "three"], 1, 4.1)).toBe("one two");
    const g = stageGraphic("fb-s2", { stage: { width: 1080, height: 890 }, seconds: 3, line: "we spent three dollars", shows: "", product });
    expect(g.box).toEqual({ width: 1080, height: 890 });
    expect(g.brief).toContain('"we spent three dollars"');
  });

  it("builds a graphic at its exact box size, as one element", () => {
    expect(screenSize({ size: "full", box: { width: 571, height: 606 } })).toEqual({ width: 572, height: 606 });
    expect(screenSize({ size: "half" })).toEqual({ width: 1080, height: 960 });
    const system = writerSystem({ size: "full", seconds: 3, box: { width: 572, height: 606 } });
    expect(system).toContain("Exactly 572x606 CSS pixels: one element");
    expect(system).not.toContain("TikTok's top bar");
    expect(writerSystem({ size: "desktop", seconds: 3 })).toContain("a desktop monitor's display");
  });
});

describe("captions and text overlays", () => {
  it("turns the caption look into the edit's caption style", () => {
    const style = captionStyle(layout.captions);
    expect(style).toMatchObject({ upper: true, lower: false, italic: true, color: 0xffffff, outline: 8, shadow: true, em: 82 });
    expect(style.bottom).toBeCloseTo(0.709, 3);
    expect(style.badge).toMatchObject({ x: 994, y: 1344, size: 130, color: 0xffd43b, accent: 0xe5383b });
  });

  it("burns captions in the reference's look: uppercase or lowercase, slanted, with its sticker", () => {
    const ass = toAss({ captions: [{ start: 0.1, end: 0.9, text: "we gave it" }], overlays: [] }, { caption: { ...captionStyle(layout.captions), shadow: false } });
    expect(ass).toMatch(/^Style: Caption,[^,]+,\d+,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,-1,/m);
    expect(ass).toContain("WE GAVE IT");
    expect(ass.match(/^Dialogue: [45],/gm)).toHaveLength(2);
    const lower = toAss({ captions: [{ start: 0.1, end: 0.9, text: "We Gave It" }], overlays: [] }, { caption: captionStyle({ ...layout.captions, case: "lower", badge: null }) });
    expect(lower).toContain("we gave it");
    const plain = toAss({ captions: [{ start: 0.1, end: 0.9, text: "we gave it" }], overlays: [] });
    expect(plain).toContain("we gave it");
  });

  it("times captions word by word from our words on the reference's clock", () => {
    const words = [
      { text: "So", start: 0.1, end: 0.3 },
      { text: "money,", start: 0.35, end: 0.7 },
      { text: "me", start: 1.6, end: 1.8 },
    ];
    expect(wordCaptions(words, 1, 3)).toEqual([
      { start: 0.1, end: 0.35, text: "So" },
      { start: 0.35, end: 0.95, text: "money" },
      { start: 1.6, end: 2.05, text: "me" },
    ]);
    expect(wordCaptions(words, 2, 3).map((c) => c.text)).toEqual(["So money", "me"]);
  });

  it("keeps a text overlay's place and line shape with our words, emoji dropped", () => {
    const overlay = { id: "t1", lines: ["Unethical ways to make", "f*ck you money 💰", "Part 67"], box: { x: 0.1, y: 0.07, w: 0.8, h: 0.12 }, start: 0, end: 3, color: "#FFFFFF", outline: "none" as const, shadow: true, background: null, size: 0.02 };
    const lines = overlayLines("Unethical ways to ship f*ck you apps 💰 Part 67", overlay.lines);
    expect(lines).toEqual(["Unethical ways to ship", "f*ck you apps", "Part 67"]);
    expect(overlayLines("Ship faster with agents", ["One line", "and two"])).toEqual(["Ship faster", "with agents"]);
    expect(overlayBeat({ start: 3.8 }, beats)).toBe(1);
    const ass = textsAss([{ overlay, lines }]);
    expect(ass).toContain("\\an8\\pos(540,134)");
    expect(ass).toContain("Unethical ways to ship\\N");
    expect(ass).toMatch(/^Dialogue: 2,0:00:00\.00,0:00:03\.00,Text,/m);
  });
});

describe("ffmpeg arguments", () => {
  it("cover-fits every piece of the stage, crops the reference first, and cuts them together silently", () => {
    const args = stageArgs(
      [
        { path: "/take1.mp4", kind: "video", from: 0, seconds: 3.7 },
        { path: "/ref.mp4", kind: "video", from: 3.7, seconds: 2, crop: { x: 0, y: 274, width: 576, height: 476 } },
        { path: "/dark.png", kind: "image", from: 0, seconds: 1 },
      ],
      { width: 1080, height: 890 },
      "/stage.mp4",
    );
    const graph = args[args.indexOf("-filter_complex") + 1];
    expect(args.slice(5, 11)).toEqual(["-ss", "0", "-t", "4.2", "-i", "/take1.mp4"]);
    expect(graph).toContain("[1:v]crop=576:476:0:274,scale=1080:890:force_original_aspect_ratio=increase");
    expect(graph).toContain("trim=end_frame=111");
    expect(args).toContain("-loop");
    expect(graph).toContain("concat=n=3:v=1:a=0[v]");
  });

  it("keys the cut-outs, lays graphics with their entrances, the blurred fill, the overlays and captions, over our sound", () => {
    const args = composeArgs({
      stage: "stage.mp4",
      audio: "voice-mix.wav",
      place: { x: 0, y: 514, width: 1080, height: 890, band: true },
      duration: 10,
      insets: [{ path: "inset.mp4", start: 3, end: 6, x: 600, y: 500, width: 400, height: 320, key: "0x00B140" }],
      graphics: [{ path: "g1.mp4", kind: "video", start: 1, end: 4, x: 464, y: 18, width: 572, height: 606, entrance: "slide_up" }],
      ass: ["texts.ass", "captions.ass"],
      out: "out.mp4",
    });
    const graph = args[args.indexOf("-filter_complex") + 1];
    expect(args.slice(5, 9)).toEqual(["-i", "stage.mp4", "-i", "voice-mix.wav"]);
    expect(graph).toContain("chromakey=color=0x00B140");
    expect(graph).toContain("overlay=x=600:y=500:eof_action=pass:enable='between(t,3,6)'");
    expect(graph).toContain("scale=572:606");
    expect(graph).toContain("overlay=x='464':y='18+90*pow(1-min(1,max(0,(t-1)/0.3)),3)'");
    expect(graph).toContain("[bg][fg]overlay=0:514[full]");
    expect(graph).toContain("ass=filename=texts.ass:fontsdir=fonts,ass=filename=captions.ass:fontsdir=fonts");
    expect(graph).toContain("[1:a]aresample=48000");
    expect(entrance("cut", 1, 2, 0)).toEqual({ x: "1", y: "2", fade: 0 });
  });
});

describe("the script and publishing for remakes", () => {
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

  it("normalizes a remake to one presenter beat per reference beat, timed like it, with its emotion", () => {
    const script = normalizeScript([{ n: 1, line: "one", visual: "split", seconds: 8, emotion: "[excited]" }, { n: 3, line: "three" }], ctx);
    expect(script.beats.map((b) => [b.n, b.seconds, b.line, b.visual, b.emotion])).toEqual([
      [1, 3.7, "one", "creator", "[excited]"],
      [2, 5.3, "", "creator", ""],
      [3, 6.6, "three", "creator", ""],
    ]);
    expect(script.total_seconds).toBe(15.6);
    const issues = lintScript(script, ctx);
    expect(issues).toContain("a remake needs a line for every reference beat that has one");
    const long = normalizeScript([{ n: 1, line: Array.from({ length: 20 }, () => "word").join(" ") }, { n: 2, line: "two" }, { n: 3, line: "three" }], ctx);
    expect(lintScript(long, ctx)).toContain("beat 1 is 20 words; the reference fits 15 in its 3.7s");
  });

  it("lints a remake: the hook keeps the reference's words, later lines may be rewritten, emotion and the series line stay", () => {
    const script = normalizeScript(
      [
        { n: 1, line: "We spent four thousand dollars on these agent tools, and we saw, wow,", emotion: "[smug]" },
        { n: 2, line: "Monid is a balance for every tool your agent uses and a skill file to set it up.", emotion: "[excited]" },
        { n: 3, line: "We created a cultural moment which can't even be priced, and so this was worth it. This was successful." },
      ],
      ctx,
    );
    const issues = lintRemake(script, ctx.reference);
    expect(issues.some((i) => i.startsWith("the hook"))).toBe(false); // the hook keeps the reference's words
    expect(issues.some((i) => i.startsWith("beat 2"))).toBe(false); // a later beat rewritten to make sense for us is fine
    expect(issues).toContain("beat 3 has no emotion tags for its line");
    const rewrittenHook = lintRemake({ beats: [{ ...script.beats[0], line: "Monid gives your agent a wallet for every tool it calls." }], total_seconds: 3, review: null }, ctx.reference);
    expect(rewrittenHook).toContainEqual(expect.stringMatching(/^the hook rewrites the reference's words/));
    const series = lintRemake({ beats: [{ ...script.beats[0], on_screen_text: "Unethical ways to ship apps" }], total_seconds: 3, review: null }, { beats: [{ ...beats[0], on_screen_text: "Unethical ways to make money Part 67" }] });
    expect(series).toContain('beat 1\'s on-screen text loses the series line "Part 67"');
  });

  it("shows a remake's writer only the pitch from the brief, not an older concept's hook plan", () => {
    const view = remakeBrief({ ...brief, hook_plan: "Guys, check this out. This one actually runs a company for you.", keep: ["the energy"], change: ["drop Part 67"], angle: "bait", cta: "link in bio" });
    expect(view).toMatchObject({ format: brief.format, angle: "bait", cta: "link in bio" });
    expect(Object.keys(view)).not.toContain("hook_plan");
    expect(Object.keys(view)).not.toContain("keep");
    expect(Object.keys(view)).not.toContain("change");
  });

  it("asks for a last line short enough to breathe before the video ends", () => {
    const script = normalizeScript(
      [
        { n: 1, line: "We spent four thousand dollars on these agent tools, and we saw, wow,", emotion: "[smug]" },
        { n: 2, line: "Monid is a balance for every tool your agent uses and a skill file to set it up.", emotion: "[excited]" },
        { n: 3, line: "The charge was about a tenth of a cent, and so this was worth it. We killed the subscriptions. This was successful. Monid dot ai.", emotion: "[smug]" },
      ],
      ctx,
    );
    const issues = lintRemake(script, ctx.reference);
    expect(issues).toContainEqual(expect.stringMatching(/^the last beat runs \d+ words: keep it to \d+/));
    const short = lintRemake({ ...script, beats: [...script.beats.slice(0, 2), { ...script.beats[2], line: "Worth it. Monid dot ai." }] }, ctx.reference);
    expect(short.some((i) => i.startsWith("the last beat"))).toBe(false);
  });

  it("plans nothing for the standard production path", () => {
    const plan = planProduction({ beats: [], total_seconds: 0, review: null }, brief, product);
    expect(plan).toEqual({ format: "remake", aroll: [], broll: [], voiceover: null, screens: [] });
  });

  it("holds internal remakes back from posting unless cleared", () => {
    expect(postingHold({ internal: true })).toBe("internal remake: not cleared for posting");
    expect(postingHold({ brief })).toBe("internal remake: not cleared for posting");
    expect(postingHold({ internal: true, cleared: { at: "2026-11-07T00:00:00Z", by: "Dylan", note: "consent on file" } })).toBeNull();
    expect(postingHold({})).toBeNull();
    expect(postingHold(null)).toBe("the video's concept is unreadable, so it can't be checked for posting");
    expect(isInternal({ brief })).toBe(true);
    expect(isInternal({})).toBe(false);
  });
});

describe("a remake's calls when a provider is busy", () => {
  it("wait out busy answers, and give up on anything else at once", async () => {
    let calls = 0;
    const flaky = { fileUrl: async () => (++calls < 3 ? Promise.reject(new ApiError("naive", 429, "rate_limited", "the service is at capacity")) : { url: "https://x" }) };
    expect(await patient(flaky, [1, 1, 1]).fileUrl()).toEqual({ url: "https://x" });
    expect(calls).toBe(3);
    const broken = { fileUrl: async () => Promise.reject(new ApiError("naive", 400, "invalid", "bad request")) };
    await expect(patient(broken, [1, 1]).fileUrl()).rejects.toThrow(/bad request/);
    const busy = { fileUrl: async () => Promise.reject(new ApiError("naive", 429, "rate_limited", "the service is at capacity")) };
    await expect(patient(busy, [1, 1]).fileUrl()).rejects.toThrow(/capacity/);
  });
});

describe("graphics at the end of a remade span", () => {
  it("end with the video and drop one that would only flash on before the cut", async () => {
    const { fitGraphics } = await import("@/lib/creative/remake");
    const fitted = fitGraphics(
      [
        { id: "g1", start: 1, end: 3.6 },
        { id: "g2", start: 6.6, end: 12 },
        { id: "g3", start: 8.2, end: 11 },
      ],
      9,
    );
    expect(fitted.map((g) => [g.id, g.end])).toEqual([
      ["g1", 3.6],
      ["g2", 9],
    ]);
  });
});

describe("the ending", () => {
  it("closes on the product's site: the homepage capture first, the address under it", async () => {
    const { endCardArgs, endCardVisual } = await import("@/lib/creative/remake");
    const visuals = [
      { id: "p1", kind: "photo", url: "https://x/logo.png" },
      { id: "s2", kind: "screenshot", url: "/v/site-docs.png", caption: "docs page" },
      { id: "s1", kind: "screenshot", url: "/v/site-home.png", caption: "homepage, as a phone shows it" },
    ] as ProductBrief["visuals"];
    expect(endCardVisual({ visuals })).toEqual({ url: "/v/site-home.png" });
    expect(endCardVisual({ visuals: visuals.slice(0, 2) })).toEqual({ url: "/v/site-docs.png" });
    expect(endCardVisual({ visuals: visuals.slice(0, 1) })).toEqual({ url: "https://x/logo.png" });
    expect(endCardVisual({ visuals: [] })).toBeNull();
    const args = endCardArgs({ image: "in.png", site: "monid.ai", font: "/f.ttf", width: 1080, height: 1920, out: "out.png" });
    const graph = args[args.indexOf("-filter_complex") + 1];
    expect(graph).toContain("text='monid.ai'");
    expect(graph).toContain("scale=908:998[card]"); // a tall frame: the card is about square
    const band = endCardArgs({ image: "in.png", site: "monid.ai", font: "/f.ttf", width: 1080, height: 880, out: "o.png" });
    expect(band[band.indexOf("-filter_complex") + 1]).toContain("scale=908:484[card]"); // a short band: a wide card
    expect(endCardArgs({ image: "in.png", site: "a:b's", font: "/f.ttf", width: 1080, height: 1920, out: "o.png" }).join(" ")).toContain("text='a\\:b\u2019s'");
    expect(endCardArgs({ image: "in.png", site: null, font: "/f.ttf", width: 1080, height: 1920, out: "o.png" }).join(" ")).not.toContain("drawtext");
  });

});

describe("where a take's first frame is grabbed", () => {
  it("moves past a cut the layout's segment time missed, and stays put otherwise", async () => {
    const { afterCut } = await import("@/lib/creative/remake");
    // Jordan's stitch: planned at 3.12 s, but the cut from her talking head is at 3.23 s.
    const stitch = { start: 3, end: 8.5, frame_at: 3.12 };
    expect(afterCut(stitch, [3.23])).toBe(3.35);
    expect(afterCut(stitch, [])).toBe(3.12);
    expect(afterCut(stitch, [2.9])).toBe(3.12); // the cut came before the take: already past it
    expect(afterCut(stitch, [6])).toBe(3.12); // a cut deep inside the take is a later shot, not this one
    // A short take never moves past its own end.
    expect(afterCut({ start: 13, end: 13.8, frame_at: 13.12 }, [13.5])).toBe(13.62);
    expect(afterCut({ start: 13, end: 13.8, frame_at: 13.12 }, [13.6])).toBe(13.7);
  });
});
