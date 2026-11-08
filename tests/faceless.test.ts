import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";

import { editFfmpeg } from "@/lib/creative/edit";
import { balanceLines, burnedInText, overlayLines, parseScreenPolicy, screenPolicy, screenPolicyPrompt, captionsAbsent, fitToVertical, labelCase, labelSaysLine, parseLayout, type RemakeGraphic, type RemakeLayout, referenceMoment, saysAnything, scaleRect, screenRequests, screenSegmentKind, screenStreamArgs, segmentElements, stageGraphic, stageOf, staticCaption, wordCaptions } from "@/lib/creative/remake";
import { readScreenCorners } from "@/lib/creative/clone";
import { beatsOfWords, fitSegments, freshVoiceArgs, PHONE_EQ, soundArgs, timeOurLines, timeOurWords, wordsFromSegments } from "@/lib/creative/dub";
import { referenceFrameNote } from "@/lib/creative/screens";
import { shotReadTimes, trackerPython, trackScreen, trackSpecJson } from "@/lib/creative/track";
import type { Quad, ReferenceBeat } from "@/lib/creative/types";

const exec = promisify(execFile);

const beat = (start: number, end: number, line = "", on_screen_text = ""): ReferenceBeat => ({ start, end, line, on_screen_text, visual: "", job: "body" }) as unknown as ReferenceBeat;

const layout = (over: Partial<RemakeLayout> = {}): RemakeLayout =>
  ({
    frame: { kind: "full" },
    set: "",
    presenter: "",
    beats: [],
    segments: [],
    graphics: [],
    texts: [{ id: "t1", lines: ["BEST WEBSITE"], box: { x: 0.1, y: 0.2, w: 0.8, h: 0.1 }, start: 0, end: 2, color: "#FFFFFF", outline: "heavy", shadow: true, background: null, size: 0.02 }],
    captions: { case: "upper", italic: false, color: "#FFFFFF", outline: "heavy", shadow: true, words: 2, center_y: 0.5, size: 0.03, badge: null },
    ...over,
  }) as RemakeLayout;

describe("faceless remakes: captions", () => {
  it("reads a caption note that says the spoken words are not captioned", () => {
    expect(captionsAbsent("No word-by-word speech captions. The only text is designed UI inside the graphics.")).toBe(true);
    expect(captionsAbsent("no captions")).toBe(true);
    expect(captionsAbsent("There are no captions; one static label sits in the middle.")).toBe(true);
  });

  it("does not mistake other notes for missing captions", () => {
    expect(captionsAbsent("Word-by-word burned-in captions in bold white uppercase sans-serif. No other designed on-screen text (titles, labels, stickers) appears.")).toBe(false);
    expect(captionsAbsent("Bold yellow captions with no outline, two words at a time.")).toBe(false);
    expect(captionsAbsent("")).toBe(false);
  });

  it("keeps the layout reader's answer, and falls back to the breakdown's note", () => {
    const context = { beats: [beat(0, 2, "hi")], until: 2 };
    expect(parseLayout({ captions: { present: false } }, { ...context, caption_style: "Bold word captions" }).captions.present).toBe(false);
    expect(parseLayout({ captions: { present: true } }, { ...context, caption_style: "No captions." }).captions.present).toBe(true);
    expect(parseLayout({ captions: {} }, { ...context, caption_style: "No word-by-word speech captions." }).captions.present).toBe(false);
    expect(parseLayout({ captions: {} }, { ...context, caption_style: "White word captions, three at a time." }).captions.present).toBe(true);
  });
});

describe("faceless remakes: filmed screens, labels and captions", () => {
  it("treats b-roll of a computer's screen as a screen walkthrough (our product goes on it)", () => {
    expect(screenSegmentKind("broll", "The laptop shows Serum Browser with a search bar and bookmark tiles.")).toBe("screen_walkthrough");
    expect(screenSegmentKind("broll", "Head-on shot of the laptop home desktop with the wallpaper.")).toBe("screen_walkthrough");
    expect(screenSegmentKind("broll", "A desk phone rings on a white desk; a hand answers it.")).toBe("broll");
    expect(screenSegmentKind("talking_head", "a woman at her laptop")).toBe("talking_head");
    const parsed = parseLayout({ segments: [{ start: 0, end: 2, kind: "broll", shows: "A phone films a Chromebook's desktop." }] }, { beats: [beat(0, 2)], until: 2 });
    expect(parsed.segments[0].kind).toBe("screen_walkthrough");
  });

  it("keeps each caption chunk inside its own line", () => {
    const words = [
      { text: "Best", start: 0.1, end: 0.3 },
      { text: "website", start: 0.3, end: 0.6 },
      { text: "for", start: 0.6, end: 0.7 },
      { text: "agents.", start: 0.7, end: 1.1 },
      { text: "Has", start: 2.5, end: 2.7 },
      { text: "cool", start: 2.7, end: 2.9 },
      { text: "phones.", start: 2.9, end: 3.3 },
    ];
    expect(wordCaptions(words, 3, 5).map((c) => c.text)).toEqual(["Best website for", "agents Has cool", "phones"]);
    expect(wordCaptions(words, 3, 5, [2.4]).map((c) => c.text)).toEqual(["Best website for", "agents", "Has cool phones"]);
  });

  it("knows a label that just shows the spoken line, and writes ours in its case", () => {
    expect(labelSaysLine(["has cool desktop"], "Has cool desktop.")).toBe(true);
    expect(labelSaysLine(["BEST WEBSITE FOR SCHOOL!!"], "Best website for school.")).toBe(true);
    expect(labelSaysLine(["Part 67"], "Unethical ways to make money with AI")).toBe(false);
    expect(labelCase("Has cool phones.", ["has cool desktop"])).toBe("has cool phones");
    expect(labelCase("Best website for agents.", ["BEST WEBSITE FOR SCHOOL!!"])).toBe("BEST WEBSITE FOR AGENTS.");
    expect(labelCase("Monid Part 67", ["Unethical ways", "Part 67"])).toBe("Monid Part 67");
  });

  it("finds the reference's burned-in words to paint out of kept footage", () => {
    const stage = stageOf({ frame: { kind: "full" } });
    const boxes = burnedInText(layout({ texts: [{ id: "t1", lines: ["BEST"], box: { x: 0.1, y: 0.45, w: 0.8, h: 0.06 }, start: 0, end: 2.4, color: "#FFFFFF", outline: "heavy", shadow: false, background: null, size: 0.03 }] }), stage, { start: 0, end: 17.5 });
    expect(boxes).toHaveLength(2);
    expect(boxes[0]).toMatchObject({ start: 0, end: 2.4 });
    expect(boxes[0].x).toBeLessThanOrEqual(108);
    expect(boxes[0].y).toBeLessThanOrEqual(864);
    // The caption strip: around 50% of the height while captions show, the whole stretch.
    expect(boxes[1]).toMatchObject({ start: 0, end: 17.5 });
    expect(boxes[1].y + boxes[1].height / 2).toBeCloseTo(960, -1);
    const silent = burnedInText(layout({ texts: [], captions: { ...layout().captions, present: false } }), stage, { start: 0, end: 5 });
    expect(silent).toEqual([]);
  });
});

describe("faceless remakes: each line is said inside its own shot", () => {
  // The reference reads one label per shot: "Spotify," (6.2-7.8), "TPT," (7.8-9.2), "games," (9.2-11.1).
  const ref = [
    { text: "Spotify,", start: 6.4, end: 7.0 },
    { text: "TPT,", start: 8.0, end: 8.5 },
    { text: "games,", start: 9.4, end: 9.9 },
  ];
  const lines = [
    { text: "real iPhones,", start: 6.2, end: 7.8 },
    { text: "SMS,", start: 7.8, end: 9.2 },
    { text: "fleets,", start: 9.2, end: 11.1 },
  ];

  it("spreads a changed stretch across the shots when timed as one script", () => {
    const words = timeOurWords(ref, lines.map((l) => l.text).join(" "));
    const fleets = words.find((w) => w.text === "fleets,")!;
    // "fleets" lands before the cut to its own shot (9.2 s).
    expect(fleets.start).toBeLessThan(9.2);
  });

  it("keeps every line's words inside its own beat when timed line by line", () => {
    const words = timeOurLines(ref, lines);
    expect(words.map((w) => w.text)).toEqual(["real", "iPhones,", "SMS,", "fleets,"]);
    expect(words[0].start).toBeGreaterThanOrEqual(6.2);
    expect(words[1].end).toBeLessThanOrEqual(7.8);
    expect(words[2].start).toBeGreaterThanOrEqual(7.8);
    expect(words[2].end).toBeLessThanOrEqual(9.2);
    expect(words[3].start).toBeGreaterThanOrEqual(9.2);
  });

  it("places each line of the read on its own beat's phrase", () => {
    // The read says the three lines back to back.
    const read = [
      { text: "Real", start: 0.1, end: 0.3 },
      { text: "iPhones,", start: 0.3, end: 0.8 },
      { text: "SMS,", start: 1.0, end: 1.4 },
      { text: "fleets,", start: 1.6, end: 2.0 },
    ];
    const segments = fitSegments(ref, lines.map((l) => l.text).join(" "), read, lines)!;
    expect(segments).toHaveLength(3);
    // Each piece of the read starts inside its own beat.
    segments.forEach((seg, i) => {
      expect(seg.at).toBeGreaterThanOrEqual(lines[i].start - 0.1);
      expect(seg.at).toBeLessThan(lines[i].end);
    });
  });
});

describe("faceless remakes: lining a transcript up with the beats", () => {
  // The breakdown says beat 2 is "Claude Phone." (4.3-6.4) and beat 3 starts "Good news." at 6.4,
  // but the transcript times "Good news." at 5.4-6.1, inside beat 2's window.
  const ref = [
    { text: "Claude", start: 4.3, end: 4.72 },
    { text: "Phone.", start: 4.72, end: 5.08 },
    { text: "Good", start: 5.4, end: 5.74 },
    { text: "news.", start: 5.74, end: 6.08 },
    { text: "The", start: 6.42, end: 6.63 },
    { text: "release", start: 10.9, end: 11.3 },
  ];
  const lines = [
    { text: "", start: 0, end: 4.3, ref: "" },
    { text: "Mobilerun.", start: 4.3, end: 6.4, ref: "Claude Phone." },
    { text: "Good news. The suite passed.", start: 6.4, end: 10.6, ref: "Good news. The full test suite passed." },
    { text: "The release is ready.", start: 10.6, end: 16.7, ref: "The release is ready." },
  ];

  it("puts each transcribed word in the beat whose words it is, whatever its time", () => {
    expect(beatsOfWords(ref, lines)).toEqual([1, 1, 2, 2, 2, 3]);
    // Without the beats' words, by time: "Good news." falls into beat 2's window.
    expect(beatsOfWords(ref, lines.map(({ ref: _, ...l }) => l))).toEqual([1, 1, 1, 1, 2, 3]);
  });

  it("places a word the read's transcript spells differently between its neighbours", () => {
    // Our script says "Mobilerun."; the read's transcript heard "Mobile run."
    const read = [
      { text: "Mobile", start: 0.08, end: 0.47 },
      { text: "run.", start: 0.47, end: 0.7 },
      { text: "Good", start: 1.24, end: 1.52 },
      { text: "news.", start: 1.52, end: 1.8 },
      { text: "The", start: 2.1, end: 2.3 },
      { text: "suite", start: 2.3, end: 2.7 },
      { text: "passed.", start: 2.7, end: 3.2 },
      { text: "The", start: 3.6, end: 3.8 },
      { text: "release", start: 3.8, end: 4.2 },
      { text: "is", start: 4.2, end: 4.35 },
      { text: "ready.", start: 4.35, end: 4.8 },
    ];
    const ours = lines.map((l) => l.text).join(" ").trim();
    const segments = fitSegments(ref, ours, read, lines)!;
    // "Mobilerun." is in the voice, read from the transcript's "Mobile run." and laid where "Claude Phone." was.
    expect(segments[0].from).toBeLessThanOrEqual(0.08);
    expect(segments[0].to).toBeLessThan(1.24);
    expect(segments[0].at).toBeCloseTo(4.25, 1);
  });

  it("caps every padded audio output at its length (ffmpeg 6 can pad forever)", () => {
    expect(freshVoiceArgs({ reads: [{ path: "r.wav", segments: [{ from: 0, to: 1, at: 0, tempo: 1 }] }], duration: 16.7, out: "v.wav" }).join(" ")).toContain("-t 16.7");
    expect(soundArgs({ voices: [], bed: null, duration: 9, finish: false, out: "o.wav" }).join(" ")).toContain("-t 9");
  });
});

describe("faceless remakes: a small device's display and Naive's voice", () => {
  const phone = { describe: "the desk phone's small backlit display", width: 960, height: 720 };

  it("builds a device display's screens at its own size, as that device's screen", () => {
    const [request] = screenRequests({ id: "s1", start: 0, end: 16.7 }, { screen: "Ringing, caller Claude, softkeys Answer and Reject", shows: "a desk phone" }, [{ start: 0, end: 4.3 }], [""], { name: "Mobilerun" }, phone);
    expect(request.box).toEqual({ width: 960, height: 720 });
    expect(request.brief).toMatch(/^What the desk phone's small backlit display shows/);
    expect(request.brief).toContain("Ringing, caller Claude");
    const [monitor] = screenRequests({ id: "s1", start: 0, end: 4 }, { screen: "", shows: "" }, [{ start: 0, end: 4 }], ["hi"], { name: "Monid" });
    expect(monitor.box).toBeUndefined();
    expect(monitor.brief).toMatch(/^What a computer monitor shows/);
  });

  it("cuts the screens together at the display's size, not a monitor's", () => {
    const args = screenStreamArgs([{ path: "a.mp4", kind: "video", seconds: 2 }], "out.mp4", { width: 960, height: 720 }).join(" ");
    expect(args).toContain("scale=960:720");
    expect(screenStreamArgs([{ path: "a.mp4", kind: "video", seconds: 2 }], "out.mp4").join(" ")).toContain("scale=1440:900");
  });

  it("asks the corner reader for the named display", async () => {
    let prompt = "";
    const naive = {
      async message(input: { messages: Array<{ content: Array<{ type: string; text?: string }> }> }) {
        prompt = input.messages[0].content.map((c) => c.text ?? "").join(" ");
        return { content: [{ type: "tool_use", name: "screen_corners", input: { frames: [] } }] };
      },
    } as unknown as Parameters<typeof readScreenCorners>[0];
    await readScreenCorners(naive, [{ t: 1, jpeg: Buffer.from("x") }], "m", phone.describe);
    expect(prompt).toContain("a phone filming the desk phone's small backlit display");
    expect(prompt).toContain("not any other screen in the shot");
  });

  it("spreads Naive's segment-timed transcript over its words", () => {
    const words = wordsFromSegments([{ start_seconds: 6.4, end_seconds: 7.4, text: "Good news." }, { start_seconds: 7.6, end_seconds: 10.6, text: "All twenty passed." }]);
    expect(words.map((w) => w.text)).toEqual(["Good", "news.", "All", "twenty", "passed."]);
    expect(words[0].start).toBe(6.4);
    expect(words[1].end).toBeCloseTo(7.4, 2);
    expect(words[2].start).toBe(7.6);
    expect(words[4].end).toBeCloseTo(10.6, 2);
  });

  it("puts a voice heard through a phone through the phone's band", () => {
    const graph = soundArgs({ voices: [{ path: "v.wav", from: 0, seconds: 3, speed: 1, at: 0 }], bed: null, duration: 3, finish: true, out: "o.wav", voiceEq: PHONE_EQ }).join(" ");
    expect(graph).toContain("highpass=f=300,lowpass=f=3400");
    expect(soundArgs({ voices: [], bed: null, duration: 3, finish: true, out: "o.wav" }).join(" ")).not.toContain("lowpass=f=3400");
  });
});

describe("faceless remakes: motion graphics", () => {
  const graphic = (id: string, start: number, end: number, shows: string): RemakeGraphic => ({ id, kind: "other", box: { x: 0.17, y: 0.48, w: 0.66, h: 0.11 }, start, end, shows, entrance: "fade" });

  it("draws the elements laid over a graphic segment inside that segment's own graphic", () => {
    const elements = segmentElements({ start: 20.7, end: 25.7 }, [graphic("g5", 20.95, 25.7, "a chat pill revealing the agent's reply"), graphic("g6", 25.95, 28.1, "five channel icons")]);
    expect(elements).toEqual([{ at: 0.25, until: 5, box: { x: 0.17, y: 0.48, w: 0.66, h: 0.11 }, shows: "a chat pill revealing the agent's reply", entrance: "fade" }]);
    const request = stageGraphic("s4", { stage: { width: 1080, height: 1080 }, seconds: 5, line: "I've queued your video.", shows: "A frosted chat pill on a green gradient", product: { name: "Naïve", one_liner: "AI agents run your company" }, elements });
    expect(request.brief).toContain("0.3-5.0 s, centre, 66% wide and 11% tall, fade: a chat pill revealing the agent's reply");
    expect(request.box).toEqual({ width: 1080, height: 1080 });
  });

  it("keeps a plain graphic's brief as it was", () => {
    const request = stageGraphic("fb-s2", { stage: { width: 1080, height: 890 }, seconds: 3, line: "we spent three dollars", shows: "", product: { name: "Monid", one_liner: "one balance" } });
    expect(request.brief).not.toContain("appear on it in turn");
  });
});

describe("faceless remakes: keep the reference's screen, or put ours on it", () => {
  const segments = [
    { n: 1, shows: "A desk phone ringing; a hand answers it", screen: "Ringing, caller Claude, softkeys Answer and Reject" },
    { n: 2, shows: "A laptop showing a school website's desktop", screen: "Serum Browser, Spotify, games: the website being shown off" },
  ];

  it("asks to keep a generic screen and replace one that sells another product", () => {
    const prompt = screenPolicyPrompt(segments, { name: "Mobilerun", one_liner: "real phones for AI agents" });
    expect(prompt).toContain("a phone ringing or a call screen");
    expect(prompt).toContain("When unsure, keep: false");
    expect(prompt).toContain("Serum Browser");
  });

  it("reads the model's verdicts, and leaves out what it did not decide as not kept", () => {
    const policy = parseScreenPolicy({ segments: [{ n: 1, keep: true, why: "a ringing phone looks the same for any product" }] }, segments);
    expect(policy[1]).toEqual({ keep: true, why: "a ringing phone looks the same for any product" });
    expect(policy[2]).toEqual({ keep: false, why: "" });
    expect(parseScreenPolicy(null, segments)[1].keep).toBe(false);
  });

  it("asks once with the tool and reads its answer", async () => {
    const naive = {
      async message() {
        return { content: [{ type: "tool_use", name: "screen_policy", input: { segments: [{ n: 1, keep: true, why: "generic" }, { n: 2, keep: false, why: "sells the school site" }] } }] };
      },
    } as unknown as Parameters<typeof screenPolicy>[0];
    const policy = await screenPolicy(naive, segments, { name: "Mobilerun", one_liner: "real phones for AI agents" });
    expect(policy[1].keep).toBe(true);
    expect(policy[2].keep).toBe(false);
  });
});

describe("faceless remakes: a static premise caption", () => {
  const premise = "claude now calls me from terminal if it has a question or if it needs me for something";
  const style = "No word-by-word captions. One static caption in black text on white boxes, centred in the middle of the screen, 3 lines, stated as the premise.";
  const read = layout({ texts: [], captions: { case: "lower", italic: false, color: "#000000", outline: "none", shadow: false, words: 5, center_y: 0.52, size: 0.022, badge: null, present: true } });

  it("turns a caption the reader took for spoken words into the overlay it is", () => {
    const fixed = staticCaption(read, { caption_style: style }, [premise, premise, premise, premise].map((t) => ({ on_screen_text: t })), 16.7);
    expect(fixed.captions.present).toBe(false);
    expect(fixed.texts).toHaveLength(1);
    const [overlay] = fixed.texts;
    expect(overlay.lines).toHaveLength(3);
    expect(overlay.lines.join(" ")).toBe(premise);
    expect(overlay).toMatchObject({ start: 0, end: 16.7, color: "#000000", background: "#FFFFFF", size: 0.022 });
    expect(overlay.box.y + overlay.box.h / 2).toBeCloseTo(0.52, 2);
  });

  it("leaves videos with word captions, or with overlays already read, as they were", () => {
    const captioned = staticCaption(read, { caption_style: "Word-by-word burned-in captions in bold white uppercase." }, [{ on_screen_text: premise }], 16.7);
    expect(captioned).toBe(read);
    // A voice-over ad with no captions and different text per beat: captions off, nothing added.
    const ad = staticCaption(read, { caption_style: "No word-by-word speech captions." }, [{ on_screen_text: "1. As" }, { on_screen_text: "" }], 60);
    expect(ad.captions.present).toBe(false);
    expect(ad.texts).toEqual([]);
  });

  it("keeps a reworded caption on as many lines as the original", () => {
    const lines = overlayLines("my agent calls me when the tests on real phones are done", balanceLines(premise, 3));
    expect(lines).toHaveLength(3);
    expect(lines.join(" ")).toBe("my agent calls me when the tests on real phones are done");
  });

  it("balances a line into a given number of lines", () => {
    expect(balanceLines("one two three four five six", 3)).toEqual(["one two", "three four", "five six"]);
    expect(balanceLines("single", 3)).toEqual(["single"]);
  });
});

describe("faceless remakes: a square reference keeps its shape", () => {
  it("puts a square ad in a band across the middle, texts and captions moved into it", () => {
    const { layout: fitted, stageRef } = fitToVertical(layout(), { width: 720, height: 720 });
    expect(fitted.frame).toEqual({ kind: "band", band: { x: 0, y: 0.2188, w: 1, h: 0.5625 } });
    expect(stageRef).toEqual({ x: 0, y: 0, width: 720, height: 720 });
    // A text at 20% of the square's height sits 20% into the band.
    expect(fitted.texts[0].box.y).toBeCloseTo(0.2188 + 0.2 * 0.5625, 3);
    expect(fitted.texts[0].box.h).toBeCloseTo(0.1 * 0.5625, 3);
    expect(fitted.texts[0].size).toBeCloseTo(0.02 * 0.5625, 3);
    expect(fitted.captions.center_y).toBeCloseTo(0.2188 + 0.5 * 0.5625, 3);
  });

  it("leaves a vertical reference as it is", () => {
    const original = layout();
    const { layout: fitted, stageRef } = fitToVertical(original, { width: 576, height: 1024 });
    expect(fitted).toBe(original);
    expect(stageRef).toBeNull();
  });

  it("maps stage pixels onto the reference's own frame", () => {
    expect(scaleRect({ x: 540, y: 270, width: 540, height: 540 }, { width: 1080, height: 1080 }, { x: 0, y: 0, width: 720, height: 720 })).toEqual({ x: 360, y: 180, width: 360, height: 360 });
  });
});

describe("faceless remakes: sound and reference stills", () => {
  it("knows when the script says nothing (a music video with labels)", () => {
    expect(saysAnything(["", "  ", ""])).toBe(false);
    expect(saysAnything(["", "type mobilerun in comments"])).toBe(true);
  });

  it("finds the reference moment each graphic or screen stands for", () => {
    const o = { planned: [{ id: "g1", start: 2, end: 6 }], layers: [{ id: "s1", start: 0, end: 9 }, { id: "s2", start: 9, end: 12 }], beats: [beat(0, 4), beat(4, 10), beat(10, 12)], end: 12 };
    expect(referenceMoment("g1", o)).toBe(4);
    expect(referenceMoment("s2", o)).toBe(10);
    // A filmed screen's beat 2 is cut to its layer (4-9 inside s1).
    expect(referenceMoment("s1-b2", o)).toBe(6.5);
    expect(referenceMoment("fb-s1", o)).toBeNull();
    expect(referenceMoment("s9-b1", o)).toBeNull();
  });

  it("tells the designer to copy the reference still, as a monitor's screen or as a graphic", () => {
    expect(referenceFrameNote({ size: "desktop" }, true)).toMatch(/^The last image .*filming a monitor/);
    expect(referenceFrameNote({ size: "full", box: { width: 1080, height: 1080 } }, false)).toMatch(/^The image .*one to one/);
  });
});

describe("faceless remakes: when to read a filmed screen's corners", () => {
  it("reads every shot once, away from its cuts", () => {
    const times = shotReadTimes({ start: 0, end: 17.5 }, [2.4, 4.6, 6.2, 7.8, 9.2, 11.1, 13.2, 14.8]);
    expect(times).toHaveLength(9);
    const edges = [0, 2.4, 4.6, 6.2, 7.8, 9.2, 11.1, 13.2, 14.8, 17.5];
    edges.slice(1).forEach((end, i) => expect(times.filter((t) => t > edges[i] && t < end)).toHaveLength(1));
  });

  it("adds reads in long shots and never drops a shot's only read for them", () => {
    const long = shotReadTimes({ start: 0, end: 63 }, [7.4, 15, 22.3, 45.2]);
    expect(long.length).toBeGreaterThan(5);
    expect(long.filter((t) => t > 22.3 && t < 45.2).length).toBeGreaterThanOrEqual(4);
    const capped = shotReadTimes({ start: 0, end: 63 }, [7.4, 15, 22.3, 45.2], 5);
    expect(capped).toHaveLength(5);
  });

  it("writes the tracker's spec with corners as [x, y] pairs", () => {
    const spec = JSON.parse(trackSpecJson({ ffmpeg: "ffmpeg", reference: "r.mp4", start: 0, seconds: 1, crop: { x: 0, y: 0, width: 10, height: 10 }, size: { width: 10, height: 10 }, screen: "s.mp4", screen_size: { width: 1440, height: 900 }, cuts: [], out: "o.mp4", anchors: [{ t: 0.5, quad: [{ x: 1.234, y: 2 }, { x: 9, y: 2 }, { x: 9, y: 8 }, { x: 1, y: 8 }] }] }));
    expect(spec.anchors[0].quad).toEqual([[1.23, 2], [9, 2], [9, 8], [1, 8]]);
  });
});

// The tracker itself, on a synthetic hand-held shot: a lit display (a bright card) inside a textured
// room, the camera drifting. Runs where OpenCV is set up (`npm run setup:stems`).
const python = trackerPython();
describe.skipIf(!python)("faceless remakes: the screen tracker (OpenCV)", () => {
  let dir = "";
  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("paints out outlined caption letters but leaves a lit display alone", async () => {
    // A dark strip with a lit display on the left and an outlined white word (ten strokes) on the right.
    const script = [
      "import importlib.util, sys",
      "import numpy as np",
      "spec = importlib.util.spec_from_file_location('track', sys.argv[1]); track = importlib.util.module_from_spec(spec); spec.loader.exec_module(track)",
      "roi = np.full((120, 400, 3), 40, np.uint8)",
      "roi[10:110, 10:150] = 235",
      "roi[40:80, 220:380] = 0",
      "for i in range(10): roi[46:74, 226 + 15 * i:232 + 15 * i] = 250",
      "mask = track.text_mask(roi) > 0",
      "strokes = np.zeros(mask.shape, bool)",
      "for i in range(10): strokes[46:74, 226 + 15 * i:232 + 15 * i] = True",
      "print(round(float(mask[15:105, 20:140].mean()), 3), round(float(mask[strokes].mean()), 3))",
    ].join("\n");
    const { stdout } = await exec(python!, ["-I", "-B", "-c", script, join(process.cwd(), "scripts", "track-screen.py")]);
    const [display, word] = stdout.trim().split(" ").map(Number);
    expect(display).toBeLessThan(0.05);
    expect(word).toBeGreaterThan(0.95);
  }, 60_000);

  it("paints out black-on-white caption boxes with their letters, and nothing around them", async () => {
    // A dark keypad strip with a white caption box holding black strokes.
    const script = [
      "import importlib.util, sys",
      "import numpy as np",
      "spec = importlib.util.spec_from_file_location('track', sys.argv[1]); track = importlib.util.module_from_spec(spec); spec.loader.exec_module(track)",
      "roi = np.full((120, 400, 3), 35, np.uint8)",
      "roi[40:80, 60:340] = 255",
      "for i in range(12): roi[48:72, 70 + 22 * i:76 + 22 * i] = 10",
      "mask = track.box_mask(roi, '#FFFFFF') > 0",
      "print(round(float(mask[42:78, 62:338].mean()), 3), round(float(mask[0:20, :].mean()), 3), round(float(mask[100:, :].mean()), 3))",
    ].join("\n");
    const { stdout } = await exec(python!, ["-I", "-B", "-c", script, join(process.cwd(), "scripts", "track-screen.py")]);
    const [box, above, below] = stdout.trim().split(" ").map(Number);
    expect(box).toBeGreaterThan(0.97);
    expect(above).toBe(0);
    expect(below).toBe(0);
  }, 60_000);

  it("follows a drifting display from one rough corner read and lays our screen into it", async () => {
    const ffmpeg = (await editFfmpeg())!;
    dir = await mkdtemp(join(tmpdir(), "nomen-track-"));
    const room = join(dir, "room.png");
    const reference = join(dir, "reference.mp4");
    const screen = join(dir, "screen.mp4");
    // A textured room (a test card) with a lit display: a bright card with some UI-like texture.
    await exec(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=800x1200:r=1", "-f", "lavfi", "-i", "testsrc=s=400x250:r=1", "-filter_complex", "[1:v]eq=brightness=0.25[d];[0:v]drawbox=x=188:y=438:w=424:h=274:color=black:t=fill[b];[b][d]overlay=200:450", "-frames:v", "1", room]);
    // The phone drifts: a moving 540x960 window over the room, 3 s at 30 fps.
    const x = (t: number) => 100 + 40 * Math.sin(t * 2);
    const y = (t: number) => 80 + 30 * Math.cos(t * 1.5);
    await exec(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-loop", "1", "-t", "3", "-i", room, "-vf", "fps=30,crop=540:960:x='100+40*sin(t*2)':y='80+30*cos(t*1.5)',format=yuv420p", "-c:v", "libx264", "-crf", "12", reference]);
    await exec(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=c=red:s=1440x900:r=30:d=3", "-c:v", "libx264", "-crf", "18", screen]);
    const truth = (t: number) => {
      const [dx, dy] = [200 - x(t), 450 - y(t)];
      return [{ x: dx, y: dy }, { x: dx + 400, y: dy }, { x: dx + 400, y: dy + 250 }, { x: dx, y: dy + 250 }];
    };
    // One corner read at 1.5 s, a few pixels off, as a vision model gives them.
    const read = truth(1.5).map((p, i) => ({ x: p.x + [3, -2, 2, -3][i], y: p.y + [-2, 3, -3, 2][i] })) as Quad;
    const out = join(dir, "tracked.mp4");
    const quadsOut = join(dir, "quads.json");
    const report = await trackScreen(python!, { ffmpeg, reference, start: 0, seconds: 3, crop: { x: 0, y: 0, width: 540, height: 960 }, size: { width: 540, height: 960 }, screen, screen_size: { width: 1440, height: 900 }, cuts: [], anchors: [{ t: 1.5, quad: read }], out, quads_out: quadsOut }, dir);
    expect(report.ok).toBe(true);
    expect(report.shots).toHaveLength(1);
    expect(report.shots[0].fallback).toBeUndefined();
    expect(existsSync(out)).toBe(true);
    // The corners follow the drift to within a few pixels across the whole shot.
    const quads = JSON.parse(await readFile(quadsOut, "utf8")) as number[][][];
    expect(quads.length).toBeGreaterThanOrEqual(88);
    let worst = 0;
    for (const f of [0, 20, 45, 70, quads.length - 1]) {
      const want = truth(f / 30);
      quads[f].forEach(([qx, qy], i) => (worst = Math.max(worst, Math.hypot(qx - want[i].x, qy - want[i].y))));
    }
    expect(worst).toBeLessThan(4.5);
  }, 120_000);
});
