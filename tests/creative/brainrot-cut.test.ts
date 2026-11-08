import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { BrainrotScript } from "@/lib/creative/brainrot";
import { brainrotAss, buildCut, type CutInput, cutArgs, renderCut, shotDurations, spreadWords, stampColor, zoomExpr } from "@/lib/creative/brainrot-cut";
import { editFfmpeg } from "@/lib/creative/edit";
import { probe } from "@/lib/media";

// The brainrot cut: the clock (shot lengths from the voice, stamps on the punchline, the melodrama's
// music turn, the end card), the text layer, and a real render of synthetic clips with ffmpeg.

const exec = promisify(execFile);
const ffmpeg = await editFfmpeg();

const script = (bit: BrainrotScript["bit"], over: Partial<BrainrotScript> = {}): BrainrotScript => ({
  bit,
  title: "Monidino",
  hook: "POV: your agent found one balance",
  characters: [{ id: "a", name: "Monidino Saldolino", look: "a piggy bank with octopus arms" }],
  music: { style: "goofy tarantella trap", hype: bit === "melodrama" ? "phonk" : "", turn: bit === "melodrama" ? 2 : 0 },
  narrator: "dramatic",
  shots: [
    { n: 1, cast: ["a"], frame: "Monidino leaps off a rooftop into a pool", motion: "it cannonballs into the pool", words: "Monidino Monidino Saldolino", keyword: "Saldolino", stamp: "", sfx: ["explosion"], fx: ["shake"], seconds: 3 },
    { n: 2, cast: ["a"], frame: "Monidino at a desk", motion: "it spins", words: "one balance for every tool", keyword: "balance", stamp: "MOGGED", sfx: ["vine_boom", "bass_drop"], fx: ["zoom_punch", "deep_fry"], seconds: 3 },
    { n: 3, cast: ["a"], frame: "Monidino on a beach", motion: "it waves", words: "", keyword: "", stamp: "6-7", sfx: ["airhorn"], fx: ["fisheye", "glitch"], seconds: 2.5 },
  ],
  end: { line: "Monid. One balance.", text: "monid.ai one balance" },
  caption: "",
  hashtags: [],
  review: null,
  ...over,
});

const input = (bit: BrainrotScript["bit"], paths: { clip: string; voice: string; image: string; music: string; sfx: string }): CutInput => ({
  script: script(bit),
  shots: [
    { clip: paths.clip, voice: { path: paths.voice, seconds: 1.4 } },
    { clip: paths.clip, voice: { path: paths.voice, seconds: 2.6 } },
    { clip: paths.clip, voice: null },
  ],
  endVoice: { path: paths.voice, seconds: 1.2 },
  endImage: paths.image,
  music: { bed: paths.music, hype: bit === "melodrama" ? paths.music : null },
  sfx: { explosion: paths.sfx, vine_boom: paths.sfx, bass_drop: paths.sfx, airhorn: paths.sfx, six_seven: paths.sfx, record_scratch: paths.sfx },
  site: "monid.ai",
});

const fake = { clip: "/c.mp4", voice: "/v.mp3", image: "/end.png", music: "/m.mp3", sfx: "/s.mp3" };

describe("the brainrot clock", () => {
  it("lasts each shot's line and a breath, opens on a stunt long enough to land, and holds silent shots", () => {
    const d = shotDurations(input("anthem", fake));
    expect(d[0]).toBeGreaterThanOrEqual(1.8);
    expect(d[1]).toBeCloseTo(2.6 + 0.12 + 0.22, 3);
    expect(d[2]).toBeCloseTo(2.5, 3);
  });

  it("puts the voice, the stamp, its effects and the end card on one clock", () => {
    const cut = buildCut(input("anthem", fake));
    const [s1, s2, s3] = cut.starts;
    expect(s1).toBe(0);
    expect(cut.duration).toBeGreaterThan(s3 + 2.5 + 2.5);
    expect(cut.end?.seconds).toBeGreaterThanOrEqual(2.6);
    // The stamp lands a beat after its cut, with the shot's second sound on it.
    const stamp = cut.texts.find((t) => t.kind === "stamp" && t.text === "MOGGED")!;
    expect(stamp.start).toBeGreaterThan(s2);
    expect(cut.sounds.filter((s) => s.bus === "sfx" && s.at === stamp.start)).toHaveLength(1);
    // The 6-7 stamp on a silent shot gets its chant.
    const six = cut.texts.find((t) => t.kind === "stamp" && t.text === "6-7")!;
    expect(cut.sounds.some((s) => s.bus === "sfx" && s.at === six.start && s.gain === 0.8)).toBe(true);
    // Karaoke: every sung shot has its lyric with the keyword.
    expect(cut.texts.filter((t) => t.kind === "lyric").map((t) => (t as { keyword: string }).keyword)).toEqual(["Saldolino", "balance"]);
    // The end card shows the site big and the rest of the end text under it, with a vine boom.
    const end = cut.texts.find((t) => t.kind === "end")! as { text: string; sub: string; start: number };
    expect(end.text).toBe("monid.ai");
    expect(end.sub).toBe("one balance");
    expect(cut.sounds.some((s) => s.at === s3 + 2.5 && s.bus === "sfx")).toBe(true);
    // Bass-boosted on the drop and on the end card.
    expect(cut.boosts.length).toBeGreaterThanOrEqual(2);
    // The opener always flashes and shakes.
    expect(cut.fx.some((f) => f.fx === "flash" && f.start === 0)).toBe(true);
  });

  it("shows the funnel's rows from their shots to the end card, and keeps its stamps below them", () => {
    const base = input("anthem", fake);
    const cut = buildCut({ ...base, script: script("funnel", { funnel: [{ shot: 2, value: "2,900+", label: "tools" }, { shot: 3, value: "0", label: "sign-ups" }] }) });
    const rows = cut.texts.filter((t) => t.kind === "row") as Array<{ start: number; end: number; index: number; count: number; value: string }>;
    expect(rows.map((r) => [r.index, r.count, r.value])).toEqual([[0, 2, "2,900+"], [1, 2, "0"]]);
    expect(rows[0].start).toBeCloseTo(cut.starts[1] + 0.25, 3);
    expect(rows[0].end).toBeCloseTo(cut.starts[2] + 2.5, 3);
    const stamp = cut.texts.find((t) => t.kind === "stamp") as { y?: number };
    expect(stamp.y).toBe(0.6);
    const ass = brainrotAss(cut);
    expect(ass).toContain("2,900+");
    expect(ass).toMatch(/\\p1.*\\fscx0\\t\(0,260,\\fscx100\)/);
  });

  it("turns the melodrama's music at its turn shot, with a record scratch", () => {
    const cut = buildCut(input("melodrama", fake));
    const music = cut.sounds.filter((s) => s.bus === "music");
    expect(music).toHaveLength(2);
    expect(music[0].seconds).toBeCloseTo(cut.starts[1], 3);
    expect(music[1].at).toBeCloseTo(cut.starts[1], 3);
    expect(cut.sounds.some((s) => s.bus === "sfx" && s.at === Math.max(0, cut.starts[1] - 0.25))).toBe(true);
    // One huge word at a time.
    const words = cut.texts.filter((t) => t.kind === "word");
    expect(words.map((w) => w.text)).toEqual(["Monidino", "Monidino", "Saldolino", "one", "balance", "for", "every", "tool"]);
  });

  it("evens out caption chunks so no word is left alone", () => {
    expect(spreadWords("Twenty phones. Thirty-one seconds.", 0, 2, 3).map((c) => c.text)).toEqual(["Twenty phones.", "Thirty-one seconds."]);
    expect(spreadWords("a b c d e f g", 0, 2, 3).map((c) => c.text)).toEqual(["a b c", "d e", "f g"]);
  });

  it("spreads words over a line by their length", () => {
    const parts = spreadWords("a bigword ok", 1, 3);
    expect(parts[0].start).toBe(1);
    expect(parts.at(-1)!.end).toBeCloseTo(4, 3);
    expect(parts[1].end - parts[1].start).toBeGreaterThan(parts[0].end - parts[0].start);
  });

  it("colours stamps by what they say", () => {
    expect(stampColor("+1000 AURA", 0)).toBe(0xb44cff);
    expect(stampColor("MOGGED", 0)).toBe(0xff2d2d);
    expect(stampColor("6-7", 0)).toBe(0xffe600);
  });

  it("zooms only in its windows", () => {
    expect(zoomExpr([])).toBe("1");
    expect(zoomExpr([{ start: 1, end: 2, fx: "zoom_punch" }])).toMatch(/^1\+between\(\(on\/30\),1,2\)/);
  });

  it("writes every text as a placed event, the keyword in its colour, no emoji", () => {
    const cut = buildCut(input("anthem", fake));
    cut.texts.push({ kind: "hook", start: 0, end: 1, text: "chat is this real 💀" });
    const ass = brainrotAss(cut);
    expect(ass).toContain("PlayResY: 1920");
    expect(ass).toMatch(/\\c&H0000E6FF&\}Saldolino/);
    expect(ass).toContain("MOGGED");
    expect(ass).not.toContain("💀");
    expect(ass.split("\n").filter((l) => l.startsWith("Dialogue:")).length).toBeGreaterThan(6);
  });

  it("builds one ffmpeg graph with the effects, the ducked beat and the boosts", () => {
    const args = cutArgs(buildCut(input("anthem", fake)), "/out.mp4");
    const graph = args[args.indexOf("-filter_complex") + 1];
    for (const part of ["zoompan=", "crop=w=", "eq=saturation=2.6", "rgbashift=", "lenscorrection=", "ass=filename=brainrot.ass", "sidechaincompress", "asoftclip", "loudnorm"]) expect(graph).toContain(part);
  });
});

describe.skipIf(!ffmpeg)("rendering a brainrot cut (real ffmpeg)", () => {
  let dir = "";
  const paths = { clip: "", voice: "", image: "", music: "", sfx: "" };
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "brainrot-cut-"));
    const make = (...a: string[]) => exec(ffmpeg!, ["-hide_banner", "-loglevel", "error", "-y", ...a]);
    paths.clip = join(dir, "clip.mp4");
    paths.voice = join(dir, "voice.wav");
    paths.image = join(dir, "end.png");
    paths.music = join(dir, "music.wav");
    paths.sfx = join(dir, "sfx.wav");
    await make("-f", "lavfi", "-i", "testsrc2=s=720x1280:r=24:d=4", "-c:v", "libx264", "-pix_fmt", "yuv420p", paths.clip);
    await make("-f", "lavfi", "-i", "sine=f=220:d=3", paths.voice);
    await make("-f", "lavfi", "-i", "sine=f=110:d=20", paths.music);
    await make("-f", "lavfi", "-i", "sine=f=55:d=1", paths.sfx);
    await make("-f", "lavfi", "-i", "color=c=white:s=430x932", "-frames:v", "1", paths.image);
  }, 60_000);
  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("renders 1080x1920 with sound, as long as the clock says", async () => {
    const cut = buildCut(input("melodrama", paths));
    const out = join(dir, "cut.mp4");
    await renderCut(cut, out, { workDir: dir });
    const info = await probe(out);
    expect(info.width).toBe(1080);
    expect(info.height).toBe(1920);
    expect(info.hasAudio).toBe(true);
    expect(Math.abs(info.duration - cut.duration)).toBeLessThan(0.15);
  }, 180_000);
});
