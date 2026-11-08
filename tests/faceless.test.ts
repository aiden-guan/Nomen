import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";

import { editFfmpeg } from "@/lib/creative/edit";
import { burnedInText, captionsAbsent, fitToVertical, labelCase, labelSaysLine, parseLayout, type RemakeLayout, referenceMoment, saysAnything, scaleRect, screenSegmentKind, stageOf, wordCaptions } from "@/lib/creative/remake";
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
