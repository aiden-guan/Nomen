import { describe, expect, it } from "vitest";

import {
  chunkTakes,
  cornerColor,
  cornerTimes,
  estimateCost,
  fitChunk,
  growToRatio,
  layersOf,
  motionClipArgs,
  nearestRatio,
  padRect,
  parseQuads,
  piecewise,
  quadsUsable,
  regionDiff,
  shrinkToRatio,
  snapSegments,
  splitTakes,
  toReference,
  twinPrompt,
  voiceStats,
  warpKeys,
  warpOptions,
} from "@/lib/creative/clone";
import { bestRead, changedSpans, deliveryTags, emotionTags, fitSegments, parseWords, phrasesOf, soundArgs, timeOurBeats, timeOurWords, voiceMode, voiceRuns } from "@/lib/creative/dub";
import { ageOf, chooseVoice, cohostDescription, DEFAULT_VOICES, genderOf, pickVoice, readVoices } from "@/lib/creative/persona";
import { jobFile, klingMotion, klingMotionBody, klingNative, klingNativeBody, klingSeconds, naiveVideo, presenterFor, shotList, speakingPrompt } from "@/lib/creative/presenter";
import type { RemakeSegment, Stage } from "@/lib/creative/remake";
import type { Quad } from "@/lib/creative/types";
import { diffWords, numberWords, phraseSyllables, spoken, syllables, tokens } from "@/lib/creative/words";
import { outputLink, runError, waitRun } from "@/lib/monid";

const stage: Stage = { x: 0, y: 0, width: 1080, height: 1920, band: false };
const seg = (n: number, start: number, end: number, kind: RemakeSegment["kind"], inset: RemakeSegment["presenter"]["inset"] = null): RemakeSegment => ({ n, start, end, kind, shows: "", presenter: { box: null, inset, green: Boolean(inset) }, other: kind === "stitch" ? "young man, curly hair, white tee" : "", screen: kind === "screen_walkthrough" ? "a website builder" : "" });

describe("words", () => {
  it("matches words across punctuation, case and number formatting", () => {
    expect(tokens("We spent $400,000 — on these billboards, wow!")).toEqual(["We", "spent", "$400,000", "on", "these", "billboards,", "wow!"]);
    const diff = diffWords(tokens("We spent $400,000 on these billboards, and we saw, wow,"), tokens("we spent three dollars on agent tools, and we saw wow"));
    expect(diff.map((s) => [s.same, s.a, s.b])).toEqual([
      [true, [0, 2], [0, 2]],
      [false, [2, 3], [2, 4]],
      [true, [3, 4], [4, 5]],
      [false, [4, 6], [5, 7]],
      [true, [6, 10], [7, 11]],
    ]);
  });

  it("says numbers and counts syllables close enough to compare phrases", () => {
    expect(numberWords(400000)).toBe("four hundred thousand");
    expect(numberWords(2947)).toBe("two thousand nine hundred forty seven");
    expect(spoken("$400,000")).toBe("four hundred thousand dollars");
    expect(spoken("2,900+")).toBe("two thousand nine hundred plus");
    expect(spoken("3.5x")).toBe("three point five times");
    expect(["billboards", "everyone", "reposting", "cultural", "moment", "views", "priced", "the", "agent"].map(syllables)).toEqual([2, 3, 3, 3, 2, 1, 1, 1, 2]);
    expect(phraseSyllables("$400,000 on these billboards")).toBe(11);
    expect(phraseSyllables("three dollars on two thousand agent tools")).toBe(10);
  });
});

describe("segments, layers and takes", () => {
  it("moves segment edges onto the reference's own cuts", () => {
    const snapped = snapSegments([seg(1, 0, 3.4, "talking_head"), seg(2, 3.4, 6.2, "stitch"), seg(3, 6.2, 12, "screen_walkthrough")], [2.1, 3.03, 6.9, 9.5]);
    expect(snapped.map((s) => [s.start, s.end])).toEqual([
      [0, 3.03],
      [3.03, 6.9],
      [6.9, 12],
    ]);
  });

  it("gives each kind of segment its layers: the host, the co-host with the host's cut-out blanked, a filmed monitor with a cut-out", () => {
    const inset = { x: 0.55, y: 0.55, w: 0.4, h: 0.4 };
    const layers = layersOf({ segments: [seg(1, 0, 3, "talking_head"), seg(2, 3, 6.3, "stitch", inset), seg(3, 6.3, 12, "screen_walkthrough", inset), seg(4, 12, 13, "broll"), seg(5, 13, 14, "graphic")] }, stage);
    expect(layers.map((l) => [l.id, l.kind, l.role, l.inset])).toEqual([
      ["s1", "clone", "host", false],
      ["s2", "clone", "cohost", false],
      ["s2-inset", "clone", "host", true],
      ["s3", "screen", null, false],
      ["s3-inset", "clone", "host", true],
      ["s4", "keep", null, false],
      ["s5", "graphic", null, false],
    ]);
    expect(layers[0].crop).toEqual({ x: 0, y: 0, width: 1080, height: 1920 });
    expect(layers[0].ratio).toBe("9:16");
    expect(layers[1].blank).toEqual([{ x: 577, y: 1025, width: 467, height: 829 }]);
    // The cut-out grown 8% a side, at the nearest image ratio, inside the stage.
    const cut = layers[2];
    expect(cut.ratio).toBe(nearestRatio(cut.crop.width, cut.crop.height));
    expect(cut.crop.x + cut.crop.width).toBeLessThanOrEqual(1080);
    expect(cut.crop.y + cut.crop.height).toBeLessThanOrEqual(1920);
    expect(cut.crop.x).toBeLessThanOrEqual(594);
    // A presenter that renders only 16:9 and 9:16 gets those ratios.
    expect(layersOf({ segments: [seg(1, 0, 3, "talking_head")] }, { ...stage, height: 890, band: true }, ["9:16", "16:9"])[0].ratio).toBe("16:9");
  });

  it("crops to image ratios: shrinking the stage, growing a cut-out", () => {
    expect(nearestRatio(1080, 890)).toBe("5:4");
    expect(shrinkToRatio({ x: 0, y: 0, width: 1080, height: 880 }, "5:4")).toEqual({ x: 0, y: 8, width: 1080, height: 864 });
    const grown = growToRatio({ x: 600, y: 1100, width: 300, height: 500 }, "2:3", { x: 0, y: 0, width: 1080, height: 1920 });
    expect(grown.width / grown.height).toBeCloseTo(2 / 3, 2);
    expect(grown.height).toBe(500);
    expect(padRect({ x: 100, y: 100, width: 100, height: 100 }, 0.1, { x: 0, y: 0, width: 1080, height: 1920 })).toEqual({ x: 90, y: 90, width: 120, height: 120 });
    expect(toReference({ x: 0, y: 8, width: 1080, height: 864 }, { x: 0, y: 524, width: 1080, height: 880, band: true }, { width: 576, height: 1024 })).toEqual({ x: 0, y: 284, width: 576, height: 460 });
  });

  it("calls a scene change a cut only where the layer's own region changes", () => {
    const [w, h] = [10, 10];
    const a = new Uint8Array(w * h).fill(100);
    const popIn = Uint8Array.from(a, (v, i) => (i % w >= 6 && Math.floor(i / w) < 4 ? 250 : v)); // a graphic in the top-right corner
    const cut = new Uint8Array(w * h).fill(20);
    const whole = [{ x: 0, y: 0, w: 1, h: 1 }];
    const graphic = { x: 0.6, y: 0, w: 0.4, h: 0.4 };
    expect(regionDiff(a, popIn, w, h, whole, [graphic])).toBe(0);
    expect(regionDiff(a, popIn, w, h, whole)).toBeGreaterThan(14);
    expect(regionDiff(a, cut, w, h, whole, [graphic])).toBe(80);
  });

  it("splits a layer at its cuts, never into stubs, never past the presenter's longest clip", () => {
    expect(splitTakes({ start: 0, end: 6 }, [3])).toEqual([
      { n: 1, start: 0, end: 3, frame_at: 0.12 },
      { n: 2, start: 3, end: 6, frame_at: 3.12 },
    ]);
    expect(splitTakes({ start: 0, end: 6 }, [0.3, 5.8]).map((t) => [t.start, t.end])).toEqual([[0, 6]]);
    expect(splitTakes({ start: 0, end: 20 }, [], 0.6, 8).map((t) => [t.start, t.end])).toEqual([
      [0, 6.667],
      [6.667, 13.333],
      [13.333, 20],
    ]);
  });

  it("estimates before paying: the presenter by billed seconds, a twin and a half per take, people, plates, audio, graphics", () => {
    const layers = layersOf({ segments: [seg(1, 0, 2, "talking_head"), seg(2, 2, 8, "screen_walkthrough", { x: 0.5, y: 0.5, w: 0.4, h: 0.4 })] }, stage);
    for (const l of layers) if (l.kind === "clone") l.takes = splitTakes(l, []);
    const estimate = estimateCost(layers, { name: "kling-motion", perSecond: 0.168, minSeconds: 3 }, { personas: 1, graphics: 3, plates: 1 });
    expect(estimate.presenter_seconds).toBe(9); // a 2 s take bills 3 s, the 6 s cut-out 6 s
    expect(estimate.usd.presenter).toBeCloseTo(1.51, 2);
    expect(estimate.usd).toMatchObject({ images: 0.24, audio: 0.15, graphics: 0.15 });
    expect(estimate.usd.total).toBeCloseTo(estimate.usd.presenter + 0.24 + 0.15 + 0.15 + estimate.usd.vision, 1);
  });
});

describe("twin frames and the presenter", () => {
  it("asks for the same composition with our person, overlays removed, or on flat green for a cut-out", () => {
    const stagePrompt = twinPrompt({ look: "A woman in her late twenties, wavy brown hair, plain cream sweater with no logo", gender: "female", set: "a car interior", green: false, blanked: true });
    expect(stagePrompt).toContain("Recreate image 1 exactly");
    expect(stagePrompt).toContain("the woman from image 2");
    expect(stagePrompt).toContain("the small cut-out of another person in the corner");
    expect(stagePrompt).toContain("holding the same objects");
    const green = twinPrompt({ look: "a man", gender: "male", set: "", green: true, fix: "the mug is missing" });
    expect(green).toContain("chroma-key green (#00B140)");
    expect(green).not.toContain("captions, words");
    expect(green).toContain("Fix exactly this: the mug is missing");
  });

  it("drives Kling with the twin frame and the reference's motion, silent", () => {
    const body = klingMotionBody({ frameUrl: "https://f/twin.png", motionUrl: "https://f/motion.mp4", green: true, persona: { description: "", gender: "female", portraitUrl: "" } });
    expect(body).toMatchObject({ media: [{ type: "image", url: "https://f/twin.png" }, { type: "video", url: "https://f/motion.mp4" }], character_orientation: "video", resolution: "1080p", audio: "off" });
    expect(body.prompt).toMatch(/^She performs exactly the same motion.*flat green screen/);
    const args = motionClipArgs({ reference: "/ref.mp4", start: 3, seconds: 1.5, crop: { x: 300, y: 600, width: 270, height: 338 }, blank: [{ x: 10, y: 10, width: 50, height: 60 }], minSeconds: 3, out: "/m.mp4" });
    expect(args.join(" ")).toContain("crop=270:338:300:600,drawbox=x=10:y=10:w=50:h=60:color=gray:t=fill");
    expect(args.join(" ")).toContain("tpad=stop_mode=clone:stop_duration=1.55");
  });

  it("picks presenters by name, with what each needs and whose voice it leaves", () => {
    const monid = { run: async () => ({ runId: "r1", status: "RUNNING" as const }), getRun: async () => ({ runId: "r1", status: "COMPLETED" as const, output: { video: { download_link: "https://v/out.mp4" } }, cost: { value: 0.5, currency: "USD" } }) };
    const naive = { generateVideo: async () => ({ id: "med_1", status: "queued" as const, model: "m", result: null, error: null, cost_micro_usd: null }), getMediaJob: async () => ({ id: "med_1", status: "completed" as const, model: "m", result: { files: [{ file_id: "fil_v", content_type: "video/mp4" }] }, error: null, cost_micro_usd: 3_200_000 }), fileUrl: async (id: string) => ({ url: `https://n/${id}`, expires_at: "" }) };
    expect(presenterFor("", { naive, monid })).toMatchObject({ name: "kling-native", voice: "own", multiShot: true, needs: { frame: true, motion: false, audio: false } });
    const kling = presenterFor("kling-motion", { naive, monid });
    expect(kling).toMatchObject({ name: "kling-motion", voice: "none", multiShot: false, needs: { frame: true, motion: true, audio: false } });
    const veo = presenterFor("naive:google/veo-3.1", { naive, monid });
    expect(veo).toMatchObject({ name: "naive:google/veo-3.1", voice: "own", ratios: ["9:16", "16:9"] });
    expect(() => presenterFor("heygen", { naive, monid })).toThrow(/unknown presenter/);
    expect(jobFile({ result: { files: [{ file_id: "fil_a" }] } })).toBe("fil_a");
    expect(klingMotion(monid).price).toEqual({ perSecond: 0.168, minSeconds: 3, maxSeconds: 30 });
    expect(naiveVideo(naive, "google/veo-3.1").price.minSeconds).toBe(4);
  });

  it("asks Kling 3.0 to voice the take itself, mirroring the reference's cuts as shots", async () => {
    const input = {
      seconds: 6.2,
      ratio: "5:4",
      green: false,
      persona: { description: "A woman in her twenties, long dark hair", gender: "female" as const, portraitUrl: "https://p/persona.png" },
      frameUrl: "https://f/twin.png",
      motionUrl: null,
      audioUrl: null,
      line: "We spent three dollars on agent tools, and we saw, wow,",
      emotion: "[excited] [smug]",
      action: "Gestures with both hands",
      shots: [
        { seconds: 3.7, framing: "waist-up at the left edge", action: "Gestures with both hands" },
        { seconds: 2.5, framing: "chest-up, centred", action: "Leans in" },
      ],
    };
    expect(shotList(input.shots)).toBe("Shot 1, 4 s: waist-up at the left edge; Gestures with both hands. Shot 2, 3 s: chest-up, centred; Leans in.");
    const body = klingNativeBody(input);
    expect(body).toMatchObject({ media: [{ type: "first_frame", url: "https://f/twin.png" }], resolution: "1080p", duration: 7, audio: "native", multi_shot: true });
    expect(body.prompt).toMatch(/^Shot 1, 4 s: waist-up at the left edge/);
    expect(body.prompt).toContain("She talks straight into the camera like a real TikTok creator: excited at the start, then smug at the end.");
    expect(body.prompt).toContain('She says: "We spent three dollars on agent tools, and we saw, wow,"');
    expect(body.prompt).not.toContain("long dark hair");
    expect(body.prompt.endsWith("No subtitles, no on-screen text.")).toBe(true);
    const single = speakingPrompt({ ...input, shots: input.shots.slice(0, 1), line: "", green: true });
    expect(single).toContain("She listens and reacts like a real creator watching a clip");
    expect(single).toContain("The background stays one flat chroma-key green.");
    expect(klingSeconds(14)).toBe(15);
    expect(klingSeconds(1.2)).toBe(3);
    const runs: Array<{ endpoint: string; body: unknown }> = [];
    const monid = { run: async (_p: string, endpoint: string, i: { body?: unknown }) => (runs.push({ endpoint, body: i.body }), { runId: "r9", status: "RUNNING" as const }), getRun: async () => ({ runId: "r9", status: "COMPLETED" as const, output: { video_url: "https://v/k.mp4" }, cost: { value: 1.18, currency: "USD" } }) };
    const presenter = klingNative(monid);
    expect(await presenter.submit(input, "idem")).toEqual({ provider: "monid", id: "r9" });
    expect(runs[0].endpoint).toBe("/v1/video/kling-3.0-i2v");
    expect(await presenter.poll({ provider: "monid", id: "r9" })).toEqual({ status: "done", url: "https://v/k.mp4", cost_micro: 1_180_000 });
  });

  it("groups takes into renders, fits a render's speech onto its span, and fingerprints its voice", () => {
    const takes = splitTakes({ start: 0, end: 20 }, [3.7, 9, 12.5]);
    expect(chunkTakes(takes, 14, true).map((c) => [c.start, c.end, c.takes.length])).toEqual([
      [0, 12.5, 3],
      [12.5, 20, 1],
    ]);
    expect(chunkTakes(takes, 14, false)).toHaveLength(4);
    // Kling starts talking 0.5 s in where the reference starts at 0.1 s, and runs 0.6 s long.
    expect(fitChunk({ duration: 7, speech: { from: 0.5, to: 6.6 } }, { length: 6, speechFrom: 0.1 })).toEqual({ from: 0.4, speed: 1.053, cut: false });
    expect(fitChunk({ duration: 9, speech: { from: 0.2, to: 8.8 } }, { length: 6, speechFrom: 0 })).toMatchObject({ speed: 1.25, cut: true });
    expect(fitChunk({ duration: 7, speech: null }, { length: 6, speechFrom: 0 })).toEqual({ from: 0, speed: 1, cut: false });
    const rate = 16000;
    const tone = Float32Array.from({ length: rate }, (_, i) => 0.3 * Math.sin((2 * Math.PI * 200 * i) / rate));
    const stats = voiceStats(tone, rate);
    expect(stats.pitch_hz).toBeGreaterThan(190);
    expect(stats.pitch_hz).toBeLessThan(210);
    expect(stats.level_db).toBeCloseTo(-13.5, 0);
    expect(voiceStats(new Float32Array(rate), rate).pitch_hz).toBeNull();
  });

  it("reads keyed clips' green from their corners", () => {
    const [w, h] = [20, 20];
    const rgb = new Uint8Array(w * h * 3);
    for (let i = 0; i < w * h; i++) rgb.set([12, 170, 70], i * 3);
    expect(cornerColor(rgb, w, h)).toBe("0x0CAA46");
    expect(cornerColor(new Uint8Array(w * h * 3).fill(128), w, h)).toBe("0x00B140");
  });
});

describe("the filmed monitor", () => {
  const quad = (x: number): Quad => [
    { x: 160 + x, y: 380 },
    { x: 920 + x, y: 400 },
    { x: 900 + x, y: 860 },
    { x: 180 + x, y: 840 },
  ];

  it("reads the corners as stage pixels and keeps only plausible screens", () => {
    const keys = parseQuads({ frames: [{ t: 3.1, visible: true, corners: [[0.148, 0.198], [0.852, 0.208], [0.833, 0.448], [0.167, 0.4375]] }, { t: 3.6, visible: false }, { t: 4.1, visible: true, corners: [[0.1, 0.1]] }] }, { width: 1080, height: 1920 });
    expect(keys).toHaveLength(1);
    expect(keys[0].quad[0]).toEqual({ x: 159.84, y: 380.16 });
    const moving = [3, 3.5, 4, 4.5].map((t, i) => ({ t, quad: quad(i * 6) }));
    expect(quadsUsable(moving, 4, { width: 1080, height: 1920 })).toEqual({ ok: true, reason: "" });
    expect(quadsUsable(moving.slice(0, 1), 4, { width: 1080, height: 1920 }).ok).toBe(false);
    const jump = [...moving.slice(0, 2), { t: 4, quad: quad(500) }];
    expect(quadsUsable(jump, 3, { width: 1080, height: 1920 }).reason).toMatch(/jumps between 3.5 s and 4 s/);
    expect(quadsUsable(jump, 3, { width: 1080, height: 1920 }, [3.8]).ok).toBe(true);
    const flipped = [{ t: 3, quad: [quad(0)[1], quad(0)[0], quad(0)[3], quad(0)[2]] as Quad }, ...moving.slice(1)];
    expect(quadsUsable(flipped, 4, { width: 1080, height: 1920 }).ok).toBe(false);
  });

  it("follows the corners frame by frame, jumping at cuts", () => {
    expect(piecewise([{ frame: 1, value: 10 }, { frame: 31, value: 40 }])).toBe("if(lt(on,1),10,if(lt(on,31),10+30*(on-1)/30,40))");
    const keys = warpKeys([{ t: 3, quad: quad(0) }, { t: 4, quad: quad(30) }, { t: 5, quad: quad(30) }], 3, 30, [4.5]);
    expect(keys.map((k) => k.frame)).toEqual([1, 31, 45, 61]);
    const options = warpOptions(keys);
    expect(options).toContain("sense=destination");
    expect(options).toContain("eval=frame");
    expect(options.match(/x0='/g)).toHaveLength(1);
    expect(cornerTimes({ start: 3, end: 6 }, [4.5])).toEqual(expect.arrayContaining([4.43, 4.55]));
    expect(cornerTimes({ start: 0, end: 30 }, []).length).toBeLessThanOrEqual(12);
  });
});

describe("the voice", () => {
  const ref = [
    { text: "We", start: 0, end: 0.08 },
    { text: "spent", start: 0.16, end: 0.42 },
    { text: "$400,000", start: 0.44, end: 1.76 },
    { text: "on", start: 1.8, end: 1.88 },
    { text: "these", start: 1.92, end: 2.02 },
    { text: "billboards,", start: 2.1, end: 2.48 },
    { text: "and", start: 2.56, end: 2.62 },
    { text: "we", start: 2.66, end: 2.76 },
    { text: "saw,", start: 2.82, end: 3.02 },
    { text: "wow,", start: 3.38, end: 3.66 },
  ];
  const ours = "We spent three dollars on these agent tools, and we saw, wow,";

  it("chooses the voice option and turns delivery notes into eleven_v4 tags", () => {
    expect(voiceMode("fresh", "female", "male")).toBe("fresh");
    expect(voiceMode("auto", "female", "male")).toBe("fresh");
    expect(voiceMode("auto", "male", "male")).toBe("convert");
    expect(voiceMode("", null, null)).toBe("fresh");
    expect(emotionTags("[excited, smug]")).toBe("[excited]");
    expect(emotionTags("laughs; sighs; whispers")).toBe("[laughs]");
    expect(emotionTags("<script>")).toBe("[script]");
    expect(deliveryTags("Fast, casual, deadpan-smug founder voice")).toBe("[deadpan]");
  });

  it("finds the changed spans and puts our words on the reference's clock", () => {
    expect(parseWords({ words: [{ text: "We", start: 0, end: 0.1, type: "word" }, { text: " ", start: 0.1, end: 0.2, type: "spacing" }, { text: "(laughs)", start: 0.2, end: 0.3, type: "audio_event" }] })).toEqual([{ text: "We", start: 0, end: 0.1 }]);
    expect(changedSpans(ref, ours)).toEqual([
      { start: 0.44, end: 1.76, from: "$400,000", to: "three dollars" },
      { start: 2.1, end: 2.48, from: "billboards,", to: "agent tools," },
    ]);
    // A deleted stretch is muted.
    expect(changedSpans(ref, "We spent on these billboards, and we saw, wow,")).toEqual([{ start: 0.44, end: 1.76, from: "$400,000", to: "" }]);
    const timed = timeOurWords(ref, ours);
    expect(timed).toHaveLength(tokens(ours).length);
    // "three dollars" shares the 1.32 s "$400,000" took, by length.
    expect(timed[2]).toEqual({ text: "three", start: 0.44, end: 1.006 });
    expect(timed[3].end).toBeCloseTo(1.76, 2);
    expect(timed[timed.length - 1]).toEqual({ text: "wow,", start: 3.38, end: 3.66 });
  });

  it("leaves the video's last take a breath after its last word", async () => {
    const { fitChunk } = await import("@/lib/creative/clone");
    const clip = { duration: 8.04, speech: { from: 0.3, to: 7.2 } };
    const mid = fitChunk(clip, { length: 6.6, speechFrom: 0.2 });
    const last = fitChunk(clip, { length: 6.6, speechFrom: 0.2 }, 0.7);
    expect(mid.speed).toBeCloseTo((7.2 - 0.1 + 0.12) / 6.6, 3);
    expect(last.speed).toBeCloseTo((7.2 - 0.1 + 0.7) / 6.6, 3);
    expect(last.cut).toBe(false);
  });

  it("keeps each beat's words inside its own beat, however much the line was rewritten", () => {
    // The Cluely remake: beat 2 shares no words with the reference, beat 3 shares "and so this was
    // worth it". Timed as one script, beat 3's opening slid into beat 2's window and take 3 was silent.
    const said = (text: string, start: number, end: number) => {
      const words = text.split(" ");
      const step = (end - start) / words.length;
      return words.map((w, i) => ({ text: w, start: start + i * step, end: start + (i + 1) * step }));
    };
    const reference = [
      ...said("We spent $400,000 on these billboards, and we saw, wow,", 0, 3.7),
      ...said("these are getting millions of views. Everyone is reposting them.", 3.7, 9),
      ...said("We created a cultural moment which can't even be priced, and so this was worth it. This was successful.", 9, 15.6),
    ];
    const beats = [
      { line: "We gave an agent a three dollar balance and one skill file, and we saw, wow,", start: 0, end: 3.7 },
      { line: "it found twelve tools ranked by fit and price, and ran one. No sign-up.", start: 3.7, end: 9 },
      { line: "The setup was one line, and so this was worth it. We killed the subscriptions.", start: 9, end: 15.6 },
    ];
    const timed = timeOurBeats(reference, beats);
    expect(timed).toHaveLength(beats.reduce((n, b) => n + tokens(b.line).length, 0));
    let at = 0;
    for (const beat of beats) {
      const mine = timed.slice(at, (at += tokens(beat.line).length));
      expect(mine.map((w) => w.text).join(" ")).toBe(tokens(beat.line).join(" "));
      for (const w of mine) {
        expect(w.start).toBeGreaterThanOrEqual(beat.start);
        expect(w.start).toBeLessThanOrEqual(beat.end - 0.1);
        expect(w.end).toBeLessThanOrEqual(beat.end);
      }
    }
    // A beat the reference says nothing in: our words spread over it.
    const quiet = timeOurBeats(said("Hello there", 0, 1), [{ line: "and now the payoff", start: 4, end: 6 }]);
    expect(quiet[0].start).toBeCloseTo(4.15, 2);
    expect(quiet[3].end).toBeCloseTo(6, 2);
  });

  it("fits the emotional read onto the reference's phrases, within a natural tempo", () => {
    // A comma with no pause is not a phrase break; the 0.36 s before "wow" is.
    expect(phrasesOf(ref).map((p) => [p.from, p.to])).toEqual([
      [0, 9],
      [9, 10],
    ]);
    // Our read: the same words, a bit slower, starting after 0.2 s of silence.
    const read = tokens(ours).map((text, i) => ({ text, start: 0.2 + i * 0.32, end: 0.2 + i * 0.32 + 0.25 }));
    const segments = fitSegments(ref, ours, read)!;
    expect(segments).toHaveLength(2);
    expect(segments[0].from).toBeCloseTo(0.15, 2);
    expect(segments.every((s) => s.tempo >= 0.8 && s.tempo <= 1.35)).toBe(true);
    for (let i = 1; i < segments.length; i++) expect(segments[i].at).toBeGreaterThanOrEqual(segments[i - 1].at + (segments[i - 1].to - segments[i - 1].from) / segments[i - 1].tempo - 1e-6);
    expect(fitSegments(ref, ours, [{ text: "something", start: 0, end: 1 }])).toBeNull();
  });

  it("keeps the read closest to the reference's length, and lays the voices over the ducked bed", () => {
    expect(bestRead([{ seconds: 4.8 }, { seconds: 3.1 }, { seconds: 3.6 }], 3.4)).toBe(2);
    const args = soundArgs({
      voices: [
        { path: "c1.wav", from: 0.4, seconds: 6, speed: 1.05, at: 0 },
        { path: "c2.wav", from: 0.2, seconds: 3, speed: 1, at: 6 },
      ],
      bed: "bed.wav",
      duration: 9,
      finish: true,
      out: "mix.wav",
    });
    const graph = args[args.indexOf("-filter_complex") + 1];
    expect(graph).toContain("[0:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=mono,atrim=start=0.4:end=6.7,asetpts=PTS-STARTPTS,atempo=1.05,adelay=0:all=1[p0]");
    expect(graph).toContain("adelay=6000:all=1[p1]");
    expect(graph).toContain("highpass=f=90,lowpass=f=14000");
    expect(graph).toContain("anoisesrc=color=pink:amplitude=0.0032");
    expect(graph).toContain("volume=0.35[bed]");
    expect(graph).toContain("[bed][sc]sidechaincompress=threshold=0.03:ratio=8:attack=20:release=400[ducked]");
    expect(graph).toContain("loudnorm=I=-14:TP=-1.5:LRA=11[mix]");
    const plain = soundArgs({ voices: [], bed: null, duration: 2, finish: false, out: "x.wav" });
    expect(plain.join(" ")).toContain("anullsrc=r=44100:cl=mono");
  });

  it("splits the read by speaker, with every line's tags before its first word", () => {
    const lines = [
      { text: "Guys, check this out.", emotion: "[excited]", start: 0, end: 3 },
      { text: "Money, part sixty-seven.", emotion: "[deadpan]", start: 3, end: 6 },
    ];
    const timed = timeOurWords(
      tokens("Guys, check this out. Money, part sixty-seven.").map((text, i) => ({ text, start: i * 0.7, end: i * 0.7 + 0.5 })),
      "Guys, check this out. Money, part sixty-seven.",
    );
    const runs = voiceRuns(lines, timed, "host", [{ start: 3, end: 6, voiceId: "cohost" }]);
    expect(runs.map((r) => [r.voiceId, r.say])).toEqual([
      ["host", "[excited] Guys, check this out. [deadpan] Money,"],
      ["cohost", "[deadpan] part sixty-seven."],
    ]);
    expect(voiceRuns(lines, timed, "host", [], "[smug]")[0].say).toBe("[excited] Guys, check this out. [deadpan] Money, part sixty-seven.");
  });
});

describe("the brand's people", () => {
  it("reads gender, age and the co-host's type from descriptions", () => {
    expect(genderOf("A woman in her mid-twenties")).toBe("female");
    expect(genderOf("Man, 20s, dark hair; his hoodie")).toBe("male");
    expect(genderOf("A creator")).toBeNull();
    expect(ageOf("a woman in her fifties")).toBe("middle_aged");
    expect(ageOf("college student")).toBe("young");
    expect(cohostDescription("teenage boy, curly brown hair, white tee")).toBe("teenage boy, curly brown hair, white tee; a different person of the same type, not anyone real");
  });

  it("picks a voice of the persona's gender, age, accent and vibe", () => {
    const voices = readVoices({
      voices: [
        { voice_id: "v1", name: "Grandpa", labels: { gender: "male", age: "old", accent: "british" } },
        { voice_id: "v2", name: "Liam", labels: { gender: "male", age: "young", accent: "american", use_case: "social media" } },
        { voice_id: "v3", name: "Brielle", labels: { gender: "female", age: "young", accent: "american", description: "confident" }, category: "premade" },
        { voice_id: "v4", name: "Nora", labels: { gender: "female", age: "middle aged", accent: "american", description: "calm" } },
        { name: "no id" },
      ],
    });
    expect(voices).toHaveLength(4);
    expect(pickVoice(voices, "male")?.voice_id).toBe("v2");
    expect(pickVoice(voices, "female", "a confident woman in her twenties")?.voice_id).toBe("v3");
    expect(pickVoice(voices, "female", "a calm woman in her forties")?.voice_id).toBe("v4");
    expect(pickVoice([], "female")).toBeNull();
    // Without a list, the UGC voices: Lena for a woman, Matt for a man.
    expect(chooseVoice("female", "a casual woman in her twenties")).toMatchObject({ id: "roYauZ4bOLAKvVZTPLre", name: "Lena", gender: "female" });
    expect(chooseVoice("male", "a guy in his twenties")).toMatchObject({ id: "3iY0r3RaYmOh6WfIwMIH", name: "Matt" });
    expect(DEFAULT_VOICES).toEqual({ female: { id: "roYauZ4bOLAKvVZTPLre", name: "Lena" }, male: { id: "3iY0r3RaYmOh6WfIwMIH", name: "Matt" } });
  });
});

describe("Monid's media runs", () => {
  it("finds the media link in every shape the runs answer", () => {
    expect(outputLink({ video: { download_link: "https://v/a.mp4" } }, "video")).toBe("https://v/a.mp4");
    expect(outputLink({ video_url: "https://v/b.mp4" }, "video")).toBe("https://v/b.mp4");
    expect(outputLink({ audio: { download_link: "https://a/c.mp3" } }, "audio")).toBe("https://a/c.mp3");
    expect(outputLink({ result: [{ file: "https://a/d.wav?sig=1" }] }, "audio")).toBe("https://a/d.wav?sig=1");
    expect(outputLink({ nothing: true }, "video")).toBeNull();
  });

  it("waits for a run, and says whether a failure is worth retrying", async () => {
    let polls = 0;
    const monid = { run: async () => ({ runId: "r", status: "RUNNING" as const }), getRun: async () => (++polls < 2 ? { runId: "r", status: "RUNNING" as const } : { runId: "r", status: "COMPLETED" as const, output: { ok: 1 } }) };
    expect((await waitRun(monid, { runId: "r", status: "RUNNING" }, { pollMs: 1 })).output).toEqual({ ok: 1 });
    expect(runError({ runId: "r", status: "FAILED", providerResponse: { httpStatus: 429 } }, "kling").retryable).toBe(true);
    expect(runError({ runId: "r", status: "BLOCKED" }, "kling").retryable).toBe(false);
    expect(runError({ runId: "r", status: "TIMED_OUT" }, "kling").retryable).toBe(true);
  });
});

describe("syllables in words that mix letters and numbers", () => {
  it("counts them without looping forever", () => {
    expect(syllables("v1")).toBe(2); // "v" + "one"
    expect(syllables("Part67")).toBe(5); // "part" + "sixty seven"
    expect(syllables("$400,000")).toBe(7); // "four hundred thousand dollars"
    expect(phraseSyllables("Click Deploy on Naive Short Form v1")).toBeGreaterThan(8);
  });
});
