import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { chunkCaptions } from "@/lib/creative/captions";
import { editFfmpeg, renderTimeline } from "@/lib/creative/edit";
import type { EditTimeline } from "@/lib/creative/types";
import { probe } from "@/lib/media";

const exec = promisify(execFile);
const ffmpeg = await editFfmpeg();
// Set NOMEN_EDIT_KEEP=/some/dir to keep the rendered videos for a look.
const keep = process.env.NOMEN_EDIT_KEEP;

let dir = "";
const file = (name: string) => join(dir, name);

async function make(args: string[]) {
  await exec(ffmpeg!, ["-hide_banner", "-loglevel", "error", "-y", ...args]);
}

/** One frame at `at` seconds, cropped to a band, as 8-bit grey pixels. */
async function band(video: string, at: number, y: number, height: number): Promise<Buffer> {
  const { stdout } = await exec(
    ffmpeg!,
    ["-hide_banner", "-loglevel", "error", "-ss", String(at), "-i", video, "-frames:v", "1", "-vf", `crop=1080:${height}:0:${y},format=gray`, "-f", "rawvideo", "pipe:1"],
    { encoding: "buffer", maxBuffer: 64 * 1024 * 1024 },
  );
  return stdout as unknown as Buffer;
}

const meanDiff = (a: Buffer, b: Buffer) => {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return sum / a.length;
};

async function kept(path: string) {
  if (!keep) return;
  await mkdir(keep, { recursive: true });
  await copyFile(path, join(keep, path.split("/").pop()!));
}

describe.skipIf(!ffmpeg)("renderTimeline", () => {
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "nomen-edit-test-"));
    const x264 = ["-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p"];
    // A-roll: a vertical clip with a tone, then a landscape clip with no audio at all.
    await make(["-f", "lavfi", "-i", "testsrc2=s=720x1280:r=30:d=3", "-f", "lavfi", "-i", "sine=f=440:d=3:sample_rate=48000", ...x264, "-c:a", "aac", "-shortest", file("a1.mp4")]);
    await make(["-f", "lavfi", "-i", "testsrc2=s=640x360:r=25:d=2.5", ...x264, file("a2.mp4")]);
    // B-roll: a square product shot, a tall page screenshot, a wide desktop screenshot and a 1 s clip.
    await make(["-f", "lavfi", "-i", "testsrc2=s=800x800", "-frames:v", "1", file("square.png")]);
    await make(["-f", "lavfi", "-i", "testsrc2=s=1080x3000", "-frames:v", "1", file("tall.png")]);
    await make(["-f", "lavfi", "-i", "smptehdbars=s=1440x900", "-frames:v", "1", file("wide.png")]);
    await make(["-f", "lavfi", "-i", "testsrc2=s=480x480:r=30:d=1", ...x264, file("clip.mp4")]);
    // Voice-over soundtrack.
    await make(["-f", "lavfi", "-i", "sine=f=220:d=3:sample_rate=44100", "-c:a", "aac", file("voice.m4a")]);
  }, 60_000);

  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("cuts A-roll, B-roll cutaways, a split screen, captions and a hook into a 1080x1920 video", async () => {
    const timeline: EditTimeline = {
      aroll: [{ path: file("a1.mp4") }, { path: file("a2.mp4") }],
      audio: null,
      segments: [
        { start: 0, end: 0.6, layer: "aroll" },
        { start: 0.6, end: 1.6, layer: "broll", broll: { path: file("square.png"), kind: "image", motion: "zoom_in" } },
        { start: 1.6, end: 3.2, layer: "broll", broll: { path: file("tall.png"), kind: "image", motion: "scroll_down" } },
        { start: 3.2, end: 4.2, layer: "split", broll: { path: file("wide.png"), kind: "image", motion: "pan_right" } },
        { start: 4.2, end: 5.5, layer: "broll", broll: { path: file("clip.mp4"), kind: "video", motion: "none" } },
      ],
      captions: chunkCaptions([
        { start: 0, end: 2.5, text: "So I finally tried the thing everyone keeps posting about." },
        { start: 2.6, end: 5.4, text: "[pause] And honestly? It's kind of wild!" },
      ]),
      overlays: [{ start: 0, end: 2, text: "I tried the viral app so you don't have to" }],
    };
    const out = file("full.mp4");
    const started = Date.now();
    await renderTimeline(timeline, out, { workDir: dir });
    const elapsed = (Date.now() - started) / 1000;
    const info = await probe(out);
    expect(info.width).toBe(1080);
    expect(info.height).toBe(1920);
    expect(info.hasAudio).toBe(true);
    expect(Math.abs(info.duration - 5.5)).toBeLessThan(0.15);
    // the work directory is cleaned up
    expect((await readdir(dir)).filter((name) => name.startsWith("nomen-edit-"))).toEqual([]);
    console.log(`rendered 5.5 s in ${elapsed.toFixed(1)} s`);
    await kept(out);
  }, 180_000);

  it("renders a voice-over with B-roll only, holding each visual until the next and burning in captions", async () => {
    const timeline: EditTimeline = {
      aroll: [],
      audio: { path: file("voice.m4a") },
      segments: [
        // starts late: the first visual is pulled back to 0 so nothing is black
        { start: 0.2, end: 1.4, layer: "broll", broll: { path: file("square.png"), kind: "image", motion: "none" } },
        { start: 1.8, end: 3, layer: "split", broll: { path: file("tall.png"), kind: "image", motion: "zoom_out" } },
      ],
      captions: [{ start: 0.3, end: 0.9, text: "look at this" }],
      overlays: [],
    };
    const out = file("voiceover.mp4");
    await renderTimeline(timeline, out);
    const info = await probe(out);
    expect(info.width).toBe(1080);
    expect(info.height).toBe(1920);
    expect(info.hasAudio).toBe(true);
    expect(Math.abs(info.duration - 3)).toBeLessThan(0.15);

    // The first visual is static, so a frame with the caption and one without differ only where
    // the caption is drawn (around 62-68% of the height).
    const captionY = 1100;
    const withCaption = await band(out, 0.6, captionY, 260);
    const without = await band(out, 1.2, captionY, 260);
    expect(meanDiff(withCaption, without)).toBeGreaterThan(3);
    expect(meanDiff(await band(out, 0.6, 100, 400), await band(out, 1.2, 100, 400))).toBeLessThan(1.5);
    // The first frame is the image, not black (the gap before 0.2 s holds the first visual).
    const first = await band(out, 0, 600, 400);
    expect(first.reduce((s, v) => s + v, 0) / first.length).toBeGreaterThan(40);
    await kept(out);
  }, 180_000);

  it("holds a short clip's last frame instead of looping it", async () => {
    const out = file("hold.mp4");
    await renderTimeline(
      {
        aroll: [],
        audio: { path: file("voice.m4a") },
        segments: [{ start: 0, end: 3, layer: "broll", broll: { path: file("clip.mp4"), kind: "video", motion: "none" } }],
        captions: [],
        overlays: [],
        duration: 3,
      },
      out,
      { workDir: dir },
    );
    // The 1 s clip is over by 1.2 s: from then on every frame is the same (a loop would keep moving).
    const [a, b, start] = await Promise.all([band(out, 1.6, 600, 400), band(out, 2.6, 600, 400), band(out, 0.2, 600, 400)]);
    expect(meanDiff(a, b)).toBeLessThan(1);
    expect(meanDiff(a, start)).toBeGreaterThan(3);
  }, 60_000);

  it("rejects a timeline that points at a missing file", async () => {
    await expect(
      renderTimeline({ aroll: [{ path: file("nope.mp4") }], audio: null, segments: [], captions: [], overlays: [] }, file("x.mp4")),
    ).rejects.toThrow(/missing file/);
  });
});
