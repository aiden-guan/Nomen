import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { extractFrames, ffmpegPath, probe, stitch } from "@/lib/media";

// Runs against a real rendered clip when NOMEN_SAMPLE_VIDEO points at one.
const sample = process.env.NOMEN_SAMPLE_VIDEO ?? "";

describe.skipIf(!sample || !existsSync(sample))("media helpers on a real clip", () => {
  it("finds ffmpeg", async () => {
    expect(await ffmpegPath()).toBeTruthy();
  });

  it("probes duration and audio", async () => {
    const info = await probe(sample);
    expect(info.duration).toBeGreaterThan(1);
    expect(info.hasAudio).toBe(true);
  });

  it("extracts small JPEG frames", async () => {
    const frames = await extractFrames(sample, 3);
    expect(frames).toHaveLength(3);
    for (const frame of frames) expect(frame.subarray(0, 2).toString("hex")).toBe("ffd8");
  });

  it("cuts shots into one 1080x1920 video with audio", async () => {
    const out = join(await mkdtemp(join(tmpdir(), "nomen-test-")), "final.mp4");
    await stitch([sample, sample], out);
    const info = await probe(out);
    expect(info.width).toBe(1080);
    expect(info.height).toBe(1920);
    expect(info.hasAudio).toBe(true);
    expect(info.duration).toBeGreaterThan(15);
  }, 120_000);
});
