import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { editFfmpeg } from "@/lib/creative/edit";
import type { Persona } from "@/lib/creative/persona";
import { type RemakeDeps, type RemakeInput, remakeVideo } from "@/lib/creative/remake";
import type { ProductBrief, ReferenceBeat, ReferenceBreakdown } from "@/lib/creative/types";
import { probe } from "@/lib/media";
import type { MonidRun } from "@/lib/monid";
import type { Files } from "@/lib/store/types";

// A mixed reference, like hustle.jordan99's "Part 67": a talking head with a hook title, a stitched
// creator with the host's cut-out over it, then a phone filming a monitor with the host green-
// screened in. With fake providers and real ffmpeg: the co-host, the cut-outs on green keyed back in,
// our screens tracked into the filmed monitor (or the plate when the corners don't hold up).

const exec = promisify(execFile);
const ffmpeg = await editFfmpeg();

const beats: ReferenceBeat[] = [
  { start: 0, end: 3, job: "hook", shot: "talking_head", visual: "her in a car", on_screen_text: "Unethical ways to make money Part 67", line: "Guys check this guy out" },
  { start: 3, end: 6, job: "proof", shot: "split", visual: "a stitched creator talking, her cut-out at the bottom right", on_screen_text: "", line: "if the goal is money part sixty seven" },
  { start: 6, end: 9, job: "demo", shot: "screen", visual: "a phone filming a monitor, her green-screened at the bottom right", on_screen_text: "", line: "so you go to this website and build it" },
];
const breakdown: ReferenceBreakdown = {
  id: "ref_mixed",
  url: "https://www.tiktok.com/@jordan/video/1",
  platform: "tiktok",
  author: "jordan",
  views: 666000,
  followers: 10000,
  outlier: 66,
  duration: 9,
  format: "talking head, stitch, filmed monitor with a green-screen cut-out",
  hook: { line: beats[0].line, on_screen_text: beats[0].on_screen_text, visual: beats[0].visual, mechanic: "series" },
  beats,
  pacing: { cuts: 2, avg_shot_seconds: 3, words_per_minute: 170 },
  caption_style: "white lowercase, word by word, in the middle",
  delivery: "excited, casual",
  why_it_works: "",
  fit: { score: 7, reason: "" },
  transcript: beats.map((b) => b.line).join(" "),
};
const product: ProductBrief = { name: "Naive", one_liner: "Agents that run your company", kind: "software", audience: "", problem: "", aha: "", features: [], claims: [], proof: [], objections: [], offer: "", voice: "", look: "", visuals: [] };

const inset = { x: 0.55, y: 0.6, w: 0.4, h: 0.35 };
const layoutAnswer = {
  frame: { kind: "full" },
  set: "the inside of a car",
  presenter: "woman in her late twenties, wavy blonde hair",
  beats: [
    { n: 1, visible: true, speaking: true, framing: "chest-up, centred", motion: "Talks to the camera, leaning back." },
    { n: 2, visible: true, speaking: false, framing: "a cut-out at the bottom right", motion: "Listens, nods." },
    { n: 3, visible: true, speaking: true, framing: "a cut-out at the bottom right", motion: "Talks, holding a mug." },
  ],
  segments: [
    { start: 0, end: 3, kind: "talking_head", shows: "her talking in a car" },
    { start: 3, end: 6, kind: "stitch", shows: "a curly-haired guy talking", presenter_inset: inset, green_screen: true, other_person: "teenage boy, curly brown hair, white t-shirt" },
    { start: 6, end: 9, kind: "screen_walkthrough", shows: "a phone filming a monitor", presenter_inset: inset, green_screen: true, screen_shows: "a website builder: the home page, then a prompt box" },
  ],
  graphics: [],
  texts: [{ lines: ["Unethical ways to make", "money Part 67"], box: { x: 0.1, y: 0.06, w: 0.8, h: 0.1 }, start: 0, end: 3, color: "#FFFFFF", outline: "none", shadow: true, size: 0.02 }],
  captions: { case: "lower", italic: false, color: "#FFFFFF", outline: "none", shadow: true, words: 1, center_y: 0.5, size: 0.022 },
};

let dir = "";
const make = (args: string[]) => exec(ffmpeg!, ["-hide_banner", "-loglevel", "error", "-y", ...args]);
const x264 = ["-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p"];

function folderFiles(root: string): Files {
  const at = (key: string) => join(root, key);
  return {
    async putFile(key, path) {
      await mkdir(dirname(at(key)), { recursive: true });
      if (path !== at(key)) await copyFile(path, at(key));
    },
    async saveUrl() {
      throw new Error("no network");
    },
    async exists(key) {
      return existsSync(at(key));
    },
    async localPath(key) {
      return at(key);
    },
    async url(key) {
      return at(key);
    },
  };
}

beforeAll(async () => {
  if (!ffmpeg) return;
  dir = await mkdtemp(join(tmpdir(), "nomen-remake-mixed-"));
  // Three different pictures, cut at 3 s and 6 s; the last is a dark room with a bright "monitor".
  await make([
    "-f", "lavfi", "-i", "testsrc=size=576x1024:rate=30:duration=3",
    "-f", "lavfi", "-i", "smptebars=size=576x1024:rate=30:duration=3",
    "-f", "lavfi", "-i", "color=c=0x202020:size=576x1024:rate=30:duration=3,drawbox=x=90:y=200:w=400:h=260:color=0xe8e8e8:t=fill",
    "-f", "lavfi", "-i", "sine=frequency=330:duration=9",
    "-filter_complex", "[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]", "-map", "[v]", "-map", "3:a", ...x264, "-c:a", "aac", "-shortest", join(dir, "reference.mp4"),
  ]);
  // A render on the set, and one on flat green (a cut-out), each 4 s with speech-like sound.
  await make(["-f", "lavfi", "-i", "color=c=0x8a6f5a:size=720x1280:rate=30:duration=4", "-f", "lavfi", "-i", "sine=frequency=190:duration=4,volume=volume='between(t,0.4,3.4)':eval=frame", ...x264, "-c:a", "aac", "-shortest", join(dir, "set.mp4")]);
  await make(["-f", "lavfi", "-i", "color=c=0x00b140:size=720x900:rate=30:duration=4,drawbox=x=220:y=200:w=280:h=700:color=0x8a6f5a:t=fill", "-f", "lavfi", "-i", "sine=frequency=210:duration=4,volume=volume='between(t,0.3,3.3)':eval=frame", ...x264, "-c:a", "aac", "-shortest", join(dir, "green.mp4")]);
  await make(["-f", "lavfi", "-i", "color=c=gray:s=576x1024", "-frames:v", "1", join(dir, "twin.png")]);
  await make(["-f", "lavfi", "-i", "color=c=0x996655:s=600x800", "-frames:v", "1", join(dir, "portrait.png")]);
  // The plate the image model would make: a grey room, a dark bezel, a green display.
  await make(["-f", "lavfi", "-i", "color=c=0x706a64:s=1080x1920,drawbox=x=100:y=600:w=880:h=560:color=0x18181c:t=fill,drawbox=x=116:y=616:w=848:h=528:color=0x12ec22:t=fill", "-frames:v", "1", join(dir, "plate.png")]);
}, 60_000);

afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

const persona = (role: "host" | "cohost", description: string, voice: string): Persona => ({ brand_id: "brd_m", role, description, gender: role === "host" ? "female" : "male", voice: { id: voice, name: voice, gender: null, source: "default" }, portrait_key: `brd_m/${role}.png`, cost_micro: 0, created_at: "" });

function fakes(corners: "good" | "bad") {
  const calls = { kling: [] as Array<{ prompt: string; multi_shot: boolean }>, cohost: [] as string[], corners: 0, images: [] as string[], stt: [] as string[] };
  const words = (list: string, from: number, step: number) => list.split(" ").map((text, i) => ({ text, start: from + i * step, end: from + i * step + step * 0.8, type: "word" }));
  const naive: RemakeDeps["naive"] = {
    async message(input) {
      const tool = (input.tools?.[0] as { name?: string } | undefined)?.name;
      if (tool === "remake_layout") return { stop_reason: "tool_use", content: [{ type: "tool_use", name: "remake_layout", input: layoutAnswer }] };
      if (tool === "screen_corners") {
        calls.corners++;
        const times = JSON.stringify(input.messages).match(/t=(\d+\.\d+) s/g) ?? [];
        const frames = times.map((label, i) => ({
          t: Number(label.slice(2, -2)),
          visible: true,
          // The bright box in the reference: x 90-490 of 576, y 200-460 of 1024 (a hand-held drift for "good", a jump for "bad").
          corners: corners === "good" ? [[0.156 + i * 0.002, 0.195], [0.85 + i * 0.002, 0.195], [0.85 + i * 0.002, 0.449], [0.156 + i * 0.002, 0.449]] : [[0.1, 0.1], [0.12, 0.1], [0.12, 0.11], [0.1, 0.11]],
        }));
        return { stop_reason: "tool_use", content: [{ type: "tool_use", name: "screen_corners", input: { frames } }] };
      }
      const text = JSON.stringify(input.messages);
      if (text.includes("Pair 1")) return { stop_reason: "end_turn", content: [{ type: "text", text: '{"score": 7, "framing": true, "same_people": true, "original_visible": false, "mismatched_pairs": [], "issues": []}' }] };
      return { stop_reason: "end_turn", content: [{ type: "text", text: '{"pass": true, "issues": []}' }] };
    },
    async generateImage(input) {
      calls.images.push(input.prompt.slice(0, 40));
      const plate = /monitor on a desk/.test(input.prompt);
      return { model: "fake", files: [{ id: plate ? "fil_plate" : `fil_twin${calls.images.length}`, content_type: "image/png" }], cost_micro_usd: 40_000 };
    },
    async fileUrl(id) {
      return { url: `https://files.invalid/${id}.png`, expires_at: "" };
    },
    async generateVideo() {
      throw new Error("not used");
    },
    async getMediaJob() {
      throw new Error("not used");
    },
  };
  const monid: RemakeDeps["monid"] = {
    async run(provider, endpoint, input) {
      const body = (input.body ?? {}) as { prompt?: string; multi_shot?: boolean; audio_url?: string };
      if (provider === "kling") {
        calls.kling.push({ prompt: body.prompt ?? "", multi_shot: Boolean(body.multi_shot) });
        return { runId: `k${calls.kling.length}-${/green/.test(body.prompt ?? "") ? "green" : "set"}`, status: "RUNNING" } as MonidRun;
      }
      if (endpoint === "/v1/speech-to-text") {
        const url = String(body.audio_url);
        calls.stt.push(url);
        const output = url.includes("-voice.wav") ? { words: words("so you go to this website", 0.4, 0.4) } : { words: [...words(beats[0].line, 0.1, 0.5), ...words(beats[1].line, 3.1, 0.35), ...words(beats[2].line, 6.1, 0.3)] };
        return { runId: "stt", status: "COMPLETED", output, cost: { value: 0.01, currency: "USD" } } as MonidRun;
      }
      throw new Error(`unexpected run ${provider} ${endpoint}`);
    },
    async getRun(runId) {
      return { runId, status: "COMPLETED", output: { video: { download_link: `https://video.invalid/${runId}.mp4` } }, cost: { value: 0.672, currency: "USD" } } as MonidRun;
    },
  };
  const deps: RemakeDeps = {
    naive,
    monid,
    files: folderFiles(join(dir, `kept-${corners}`)),
    host: async (path) => `https://host.invalid/${basename(path)}`,
    fetchUrl: async (url, path) => {
      await mkdir(dirname(path), { recursive: true });
      const source = url.includes("video.invalid") ? (url.includes("green") ? "green.mp4" : "set.mp4") : url.includes("fil_plate") ? "plate.png" : "twin.png";
      await copyFile(join(dir, source), path);
    },
    separate: null,
    buildGraphics: async (requests, workDir) => {
      const clips = [];
      for (const r of requests) {
        const size = r.box ?? (r.size === "desktop" ? { width: 1440, height: 900 } : { width: 1080, height: 1920 });
        const path = join(workDir, `${r.id}.mp4`);
        await make(["-f", "lavfi", "-i", `color=c=0x2255ee:s=${size.width}x${size.height}:d=2:r=30`, ...x264, path]);
        clips.push({ id: r.id, kind: "video" as const, path, seconds: 2, html_path: "" });
      }
      return { clips, failures: [] };
    },
  };
  return { deps, calls };
}

const input = (prefix: string, calls: { cohost: string[] }): RemakeInput => ({
  prefix,
  referencePath: join(dir, "reference.mp4"),
  breakdown,
  lines: [
    { line: "Guys check this guy out", emotion: "[excited]", on_screen_text: "Unethical ways to ship apps Part 67" },
    { line: "if the goal is money part sixty seven", emotion: "[deadpan]", on_screen_text: "" },
    { line: "so you go to this website and build it", emotion: "[curious]", on_screen_text: "" },
  ],
  host: { persona: persona("host", "A woman in her late twenties, wavy brown hair", "roYauZ4bOLAKvVZTPLre"), portrait: join(dir, "portrait.png") },
  cohost: async (other) => {
    calls.cohost.push(other);
    return { persona: persona("cohost", `${other}; a different person`, "3iY0r3RaYmOh6WfIwMIH"), portrait: join(dir, "portrait.png"), cost_micro: 40_000 };
  },
  product,
  kit: null,
  maxUsd: 10,
  voice: "fresh",
  idem: prefix,
  pollMs: 0,
});

describe.skipIf(!ffmpeg)("a mixed reference (fake providers, real ffmpeg)", () => {
  it("clones the talking head, the stitch with a co-host and a green cut-out, and tracks our screens into the filmed monitor", async () => {
    const { deps, calls } = fakes("good");
    const result = await remakeVideo(deps, input("crv_mixed", calls));
    expect(result.layers.map((l) => [l.id, l.kind, l.role, l.inset, l.speaks])).toEqual([
      ["s1", "clone", "host", false, true],
      ["s2", "clone", "cohost", false, true],
      ["s2-inset", "clone", "host", true, false],
      ["s3", "screen", null, false, true],
      ["s3-inset", "clone", "host", true, true],
    ]);
    expect(calls.cohost).toEqual(["teenage boy, curly brown hair, white t-shirt"]);
    expect(calls.kling).toHaveLength(4);
    // Renders run three at a time, so find each by what it says.
    const prompts = calls.kling.map((k) => k.prompt);
    const said = (line: string) => prompts.find((p) => p.includes(line)) ?? "";
    expect(said('She says: "Guys check this guy out"')).not.toContain("green");
    expect(said('He says: "if the goal is money part sixty seven"')).not.toContain("green");
    const listening = said("She listens and reacts like a real creator watching a clip");
    expect(listening).toContain("flat chroma-key green");
    expect(said('She says: "so you go to this website and build it"')).toContain("flat chroma-key green");
    expect(prompts.every((p) => p.endsWith("No subtitles, no on-screen text."))).toBe(true);
    // The filmed monitor was tracked from the corners, not replaced by a plate.
    expect(calls.corners).toBe(1);
    const manifest = JSON.parse(await readFile(join(dir, "kept-good", "crv_mixed", "remake", "manifest.json"), "utf8"));
    expect(manifest.screens.s3).toMatchObject({ mode: "track", clip_key: "crv_mixed/remake/screens/s3.mp4" });
    expect(Object.keys(manifest.fallbacks)).toEqual([]);
    // The renders that speak: the host, the co-host, the host's walkthrough cut-out.
    expect(result.voices.map((v) => [v.render, v.role])).toEqual([
      ["s1-c1", "host"],
      ["s2-c1", "cohost"],
      ["s3-inset-c1", "host"],
    ]);
    expect(result.notes.some((n) => n.includes("no music bed"))).toBe(true);
    const out = await probe(result.path);
    expect(out).toMatchObject({ width: 1080, height: 1920, hasAudio: true });
    expect(out.duration).toBeCloseTo(9, 0);
    // Set NOMEN_REMAKE_KEEP=/some/dir to keep the cut for a look.
    if (process.env.NOMEN_REMAKE_KEEP) await copyFile(result.path, join(process.env.NOMEN_REMAKE_KEEP, "remake-mixed.mp4"));
  }, 300_000);

  it("films our screens on the plate when the monitor's corners don't hold up", async () => {
    const { deps, calls } = fakes("bad");
    const result = await remakeVideo(deps, input("crv_plate", calls));
    const manifest = JSON.parse(await readFile(join(dir, "kept-bad", "crv_plate", "remake", "manifest.json"), "utf8"));
    expect(manifest.screens.s3.mode).toBe("plate");
    expect(manifest.screens.s3.reason).toMatch(/too small to carry a screen/);
    expect(manifest.screens.s3.plate).toMatchObject({ status: "ready", tries: 1 });
    expect(calls.images.some((p) => /monitor on a desk/.test(p) || p.startsWith("Vertical 9:16 handheld smartphone photo"))).toBe(true);
    expect((await probe(result.path)).width).toBe(1080);
  }, 300_000);
});
