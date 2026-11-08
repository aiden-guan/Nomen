import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { editFfmpeg } from "@/lib/creative/edit";
import type { Persona } from "@/lib/creative/persona";
import type { Presenter } from "@/lib/creative/presenter";
import { OverBudget, type RemakeDeps, type RemakeInput, remakeVideo } from "@/lib/creative/remake";
import type { ProductBrief, ReferenceBeat, ReferenceBreakdown } from "@/lib/creative/types";
import { probe } from "@/lib/media";
import type { MonidRun } from "@/lib/monid";
import type { Files } from "@/lib/store/types";

// The whole one-to-one remake with fake providers and real ffmpeg: the layout, the cut detection,
// the cost guard, the twin frame, one multi-shot Kling render voicing itself, its speech fitted
// onto the reference's span, graphics and text overlays at the reference's places, word captions,
// the finish, and a rerun that pays for nothing again.

const exec = promisify(execFile);
const ffmpeg = await editFfmpeg();

const beats: ReferenceBeat[] = [
  { start: 0, end: 3, job: "hook", shot: "talking_head", visual: "presenter centred", on_screen_text: "Unethical ways to make money Part 67", line: "We spent four hundred dollars on billboards" },
  { start: 3, end: 6, job: "proof", shot: "talking_head", visual: "closer, leaning in", on_screen_text: "", line: "and everyone is reposting them now" },
];
const breakdown: ReferenceBreakdown = {
  id: "ref_test",
  url: "https://www.tiktok.com/@someone/video/1",
  platform: "tiktok",
  author: "someone",
  views: 100000,
  followers: 1000,
  outlier: 100,
  duration: 6,
  format: "talking head",
  hook: { line: beats[0].line, on_screen_text: beats[0].on_screen_text, visual: beats[0].visual, mechanic: "money figure" },
  beats,
  pacing: { cuts: 1, avg_shot_seconds: 3, words_per_minute: 180 },
  caption_style: "white lowercase, word by word, centred",
  delivery: "smug, fast",
  why_it_works: "",
  fit: { score: 7, reason: "" },
  transcript: beats.map((b) => b.line).join(" "),
};
const product: ProductBrief = { name: "Monid", one_liner: "One balance for every tool your agent uses", kind: "software", audience: "", problem: "", aha: "", features: [], claims: [], proof: [], objections: [], offer: "", voice: "", look: "", visuals: [] };

const layoutAnswer = {
  frame: { kind: "full" },
  set: "a bedroom wall",
  presenter: "young man, dark hair",
  beats: [
    { n: 1, visible: true, speaking: true, framing: "chest-up, centred", motion: "Gestures with one hand." },
    { n: 2, visible: true, speaking: true, framing: "close-up, centred", motion: "Leans in toward the lens." },
  ],
  segments: [{ start: 0, end: 6, kind: "talking_head", shows: "a man talking to the camera" }],
  graphics: [{ kind: "tweet", box: { x: 0.1, y: 0.55, w: 0.8, h: 0.25 }, start: 1, end: 2.5, shows: "a post about billboards", entrance: "pop" }],
  texts: [{ lines: ["Unethical ways to make", "money Part 67"], box: { x: 0.1, y: 0.06, w: 0.8, h: 0.1 }, start: 0, end: 3, color: "#FFFFFF", outline: "none", shadow: true, size: 0.02 }],
  captions: { case: "lower", italic: false, color: "#FFFFFF", outline: "thin", shadow: true, words: 1, center_y: 0.5, size: 0.025 },
};

let dir = "";
const make = (args: string[]) => exec(ffmpeg!, ["-hide_banner", "-loglevel", "error", "-y", ...args]);
const x264 = ["-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p"];

/** Files like the store's, kept in one folder by key. */
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
      return `https://files.example/${key}`;
    },
  };
}

beforeAll(async () => {
  if (!ffmpeg) return;
  dir = await mkdtemp(join(tmpdir(), "nomen-remake-run-"));
  // The reference: 6 s with a hard cut at 3 s (two different pictures), and sound.
  await make(["-f", "lavfi", "-i", "testsrc=size=576x1024:rate=30:duration=3", "-f", "lavfi", "-i", "smptebars=size=576x1024:rate=30:duration=3", "-f", "lavfi", "-i", "sine=frequency=330:duration=6", "-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0[v]", "-map", "[v]", "-map", "2:a", ...x264, "-c:a", "aac", "-shortest", join(dir, "reference.mp4")]);
  // Kling's render: 7 s, a face-like picture, speech-like sound from 0.5 s to 6.3 s.
  await make(["-f", "lavfi", "-i", "color=c=0x8a6f5a:size=720x1280:rate=30:duration=7", "-f", "lavfi", "-i", "sine=frequency=180:duration=7,volume=volume='between(t,0.5,6.3)':eval=frame", ...x264, "-c:a", "aac", "-shortest", join(dir, "kling.mp4")]);
  await make(["-f", "lavfi", "-i", "color=c=gray:s=576x1024", "-frames:v", "1", join(dir, "twin.png")]);
  await make(["-f", "lavfi", "-i", "color=c=0x996655:s=600x800", "-frames:v", "1", join(dir, "persona.png")]);
  await make(["-f", "lavfi", "-i", "sine=frequency=200:duration=3", join(dir, "tts.wav")]);
}, 60_000);

afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

function fakes(over: { presenter?: Presenter } = {}) {
  const calls = { layout: 0, gate: 0, qc: 0, images: 0, kling: [] as Array<Record<string, unknown>>, stt: [] as string[], tts: 0, sts: 0, order: [] as string[] };
  const naive: RemakeDeps["naive"] = {
    async message(input) {
      const tool = (input.tools?.[0] as { name?: string } | undefined)?.name;
      if (tool === "remake_layout") {
        calls.layout++;
        return { stop_reason: "tool_use", content: [{ type: "tool_use", name: "remake_layout", input: layoutAnswer }] };
      }
      const text = JSON.stringify(input.messages);
      if (text.includes("Pair 1")) {
        calls.qc++;
        return { stop_reason: "end_turn", content: [{ type: "text", text: '{"score": 8, "framing": true, "same_people": true, "original_visible": false, "mismatched_pairs": [], "issues": []}' }] };
      }
      calls.gate++;
      return { stop_reason: "end_turn", content: [{ type: "text", text: '{"pass": true, "issues": []}' }] };
    },
    async generateImage(input) {
      calls.images++;
      calls.order.push("image");
      expect(input.image_urls).toHaveLength(2);
      return { model: "fake", files: [{ id: `fil_twin${calls.images}`, content_type: "image/png" }], cost_micro_usd: 40_000 };
    },
    async fileUrl(id) {
      return { url: `https://files.invalid/${id}.png`, expires_at: "" };
    },
    async generateVideo() {
      throw new Error("no Naive video in this test");
    },
    async getMediaJob() {
      throw new Error("no Naive video in this test");
    },
  };
  const words = (list: string, from: number, step: number) => list.split(" ").map((text, i) => ({ text, start: from + i * step, end: from + i * step + step * 0.8, type: "word" }));
  const monid: RemakeDeps["monid"] = {
    async run(provider, endpoint, input) {
      const body = (input.body ?? {}) as Record<string, unknown>;
      if (provider === "kling") {
        calls.kling.push(body);
        calls.order.push("kling");
        return { runId: `k${calls.kling.length}`, status: "RUNNING" } as MonidRun;
      }
      if (endpoint === "/v1/speech-to-text") {
        const url = String(body.audio_url);
        calls.stt.push(url);
        // A render's own voice says our line (from 0.5 s); the reference says its own.
        const output = url.includes("-voice.wav") ? { words: words("We spent three dollars on agent tools and everyone is reposting them now", 0.5, 0.45) } : { words: [...words(beats[0].line, 0.1, 0.4), ...words(beats[1].line, 3.1, 0.45)] };
        return { runId: "stt", status: "COMPLETED", output, cost: { value: 0.01, currency: "USD" } } as MonidRun;
      }
      if (endpoint === "/text-to-speech") {
        calls.tts++;
        calls.order.push("tts");
        return { runId: "tts", status: "COMPLETED", output: { audio: { download_link: `https://audio.invalid/tts-${calls.tts}.wav` } }, cost: { value: 0.02, currency: "USD" } } as MonidRun;
      }
      if (endpoint === "/v1/speech-to-speech") {
        calls.sts++;
        return { runId: "sts", status: "COMPLETED", output: { audio: { download_link: "https://audio.invalid/sts.wav" } }, cost: { value: 0.03, currency: "USD" } } as MonidRun;
      }
      throw new Error(`unexpected run ${provider} ${endpoint}`);
    },
    async getRun(runId) {
      return { runId, status: "COMPLETED", output: { video: { download_link: `https://video.invalid/${runId}.mp4` } }, cost: { value: 1.176, currency: "USD" } } as MonidRun;
    },
  };
  const deps: RemakeDeps = {
    naive,
    monid,
    files: folderFiles(join(dir, "kept")),
    ...(over.presenter ? { presenter: over.presenter } : {}),
    host: async (path) => `https://host.invalid/${basename(path)}`,
    fetchUrl: async (url, path) => {
      await mkdir(dirname(path), { recursive: true });
      const source = url.includes("video.invalid") ? "kling.mp4" : url.includes("files.invalid") ? "twin.png" : "tts.wav";
      await copyFile(join(dir, source), path);
    },
    // Demucs stands in: the voice is the reference's sound, the bed a quiet hum.
    separate: async (input, outDir) => {
      await mkdir(outDir, { recursive: true });
      const voice = join(outDir, "vocals.wav");
      const bed = join(outDir, "no_vocals.wav");
      await copyFile(input, voice);
      await make(["-f", "lavfi", "-i", "sine=frequency=90:duration=6,volume=0.2", bed]);
      return { voice, bed };
    },
    buildGraphics: async (requests, workDir) => {
      const clips = [];
      for (const r of requests) {
        const size = r.box ?? (r.size === "desktop" ? { width: 1440, height: 900 } : { width: 1080, height: 1920 });
        const path = join(workDir, `${r.id}.mp4`);
        await make(["-f", "lavfi", "-i", `color=c=white:s=${size.width}x${size.height}:d=2:r=30`, ...x264, path]);
        clips.push({ id: r.id, kind: "video" as const, path, seconds: 2, html_path: "" });
      }
      return { clips, failures: [] };
    },
  };
  return { deps, calls };
}

const host = (): RemakeInput["host"] => ({
  persona: { brand_id: "brd_x", role: "host", description: "A woman in her twenties, long dark hair", gender: "female", voice: { id: "roYauZ4bOLAKvVZTPLre", name: "Lena", gender: "female", source: "default" }, portrait_key: "brd_x/persona.png", cost_micro: 0, created_at: "" } as Persona,
  portrait: join(dir, "persona.png"),
});

const input = (prefix: string, over: Partial<RemakeInput> = {}): RemakeInput => ({
  prefix,
  referencePath: join(dir, "reference.mp4"),
  breakdown,
  lines: [
    { line: "We spent three dollars on agent tools", emotion: "[smug]", on_screen_text: "Unethical ways to ship apps Part 67" },
    { line: "and everyone is reposting them now", emotion: "[excited]", on_screen_text: "" },
  ],
  host: host(),
  product,
  kit: null,
  maxUsd: 5,
  voice: "fresh",
  idem: prefix,
  pollMs: 0,
  ...over,
});

describe.skipIf(!ffmpeg)("remakeVideo with Kling voicing itself (fake providers, real ffmpeg)", () => {
  it("re-performs the reference in one multi-shot render and cuts it on the reference's timing, then resumes for free", async () => {
    const { deps, calls } = fakes();
    const events: string[] = [];
    const result = await remakeVideo(deps, input("crv_run", { voiceMatch: true, onEvent: (m) => events.push(m) }));

    expect(calls.layout).toBe(1);
    expect(result.layout.segments.map((s) => s.kind)).toEqual(["talking_head"]);
    // The cut at 3 s is a real cut: two takes, one multi-shot render.
    expect(result.layers[0].takes.map((t) => [t.start, t.end])).toEqual([
      [0, 3],
      [3, 6],
    ]);
    expect(calls.kling).toHaveLength(1);
    const body = calls.kling[0] as { prompt: string; multi_shot: boolean; duration: number; audio: string; media: Array<{ url: string }> };
    expect(body).toMatchObject({ multi_shot: true, duration: 7, audio: "native", resolution: "1080p" });
    expect(body.media[0].url).toBe("https://host.invalid/shot1-frame-twin.png");
    expect(body.prompt).toMatch(/^Shot 1, 3 s: chest-up, centred; Gestures with one hand\. Shot 2, 3 s: close-up, centred; Leans in toward the lens\./);
    expect(body.prompt).toContain('She says: "We spent three dollars on agent tools and everyone is reposting them now"');
    expect(body.prompt).toContain("smug at the start, then excited at the end");
    expect(calls.images).toBe(1);
    expect(calls.gate).toBe(1);
    // Speech-to-text on the reference and on the render's own voice; the voice evened out once.
    expect(calls.stt).toHaveLength(2);
    expect(calls.sts).toBe(1);
    expect(calls.tts).toBe(0); // Kling voices every word: no read of ours
    expect(result.voices).toHaveLength(1);
    expect(result.voices[0]).toMatchObject({ render: "s1-c1", role: "host", words: 13, cut: false });
    expect(result.voices[0].pitch_hz).toBeGreaterThan(170);
    expect(result.estimate.presenter_seconds).toBe(7);
    expect(result.spend.monid_micro).toBeGreaterThanOrEqual(1_176_000);
    expect(result.qc).toMatchObject({ score: 8, pass: true });
    const out = await probe(result.path);
    expect(out).toMatchObject({ width: 1080, height: 1920, hasAudio: true });
    expect(out.duration).toBeCloseTo(6, 0);
    const manifest = JSON.parse(await readFile(join(dir, "kept", "crv_run", "remake", "manifest.json"), "utf8"));
    expect(manifest.takes["s1-c1"].render).toMatchObject({ renders: 1, clip_key: "crv_run/remake/takes/s1-c1.mp4" });
    expect(Object.keys(manifest.graphics.clips)).toHaveLength(1);
    expect(events.some((e) => e.startsWith("Plan: talking head 0.0-6.0 s; 1 renders on kling-native"))).toBe(true);

    // A rerun pays for nothing again: no images, no renders, no speech.
    const again = fakes();
    await remakeVideo(again.deps, input("crv_run", { voiceMatch: true }));
    expect(again.calls).toMatchObject({ layout: 0, images: 0, kling: [], stt: [], sts: 0, tts: 0 });
  }, 240_000);

  it("refuses a remake over its cap before paying for anything", async () => {
    const { deps, calls } = fakes();
    await expect(remakeVideo(deps, input("crv_cap", { maxUsd: 0.5 }))).rejects.toBeInstanceOf(OverBudget);
    expect(calls).toMatchObject({ images: 0, kling: [], stt: [], tts: 0 });
  }, 120_000);

  it("makes our voice first for an audio-driven presenter and hands it each render's slice", async () => {
    const seen: Array<{ audioUrl: string | null; line: string }> = [];
    const audioDriven: Presenter = {
      name: "fake-lipsync",
      needs: { frame: true, motion: false, audio: true },
      voice: "ours",
      multiShot: true,
      ratios: ["9:16"],
      price: { perSecond: 0.1, minSeconds: 3, maxSeconds: 10 },
      async submit(i) {
        seen.push({ audioUrl: i.audioUrl, line: i.line });
        calls.order.push("render");
        return { provider: "monid", id: "lip1" };
      },
      async poll() {
        return { status: "done", url: "https://video.invalid/lip1.mp4", cost_micro: 600_000 };
      },
    };
    const { deps, calls } = fakes({ presenter: audioDriven });
    const result = await remakeVideo(deps, input("crv_lip"));
    expect(seen).toHaveLength(1);
    expect(seen[0].audioUrl).toBe("https://host.invalid/s1-c1-voice.wav");
    // Three reads of our line were tried before any video (the best by length is kept).
    expect(calls.order.indexOf("tts")).toBeLessThan(calls.order.indexOf("render"));
    expect(calls.tts).toBeGreaterThanOrEqual(1);
    expect((await probe(result.path)).hasAudio).toBe(true);
  }, 240_000);
});
