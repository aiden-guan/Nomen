import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chunkCaptions } from "@/lib/creative/captions";
import { editFfmpeg, renderTimeline } from "@/lib/creative/edit";
import { probe } from "@/lib/media";

const exec = promisify(execFile);
const bin = await editFfmpeg();

describe.skipIf(!bin)("presenter inset layout", () => {
  let dir = "";
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "nomen-inset-"));
    await exec(bin!, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=720x1280:r=30:d=4", "-f", "lavfi", "-i", "sine=f=440:d=4", "-shortest", "-c:v", "libx264", "-c:a", "aac", join(dir, "aroll.mp4")]);
    await exec(bin!, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=c=0x1f3cff:s=1080x1920:d=1", "-frames:v", "1", join(dir, "screen.png")]);
  });
  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("puts the presenter in a rounded window over full-screen product graphics", async () => {
    const out = join(dir, "inset.mp4");
    await renderTimeline(
      {
        aroll: [{ path: join(dir, "aroll.mp4") }],
        audio: null,
        segments: [
          { start: 0, end: 1, layer: "aroll" },
          { start: 1, end: 4, layer: "inset", broll: { path: join(dir, "screen.png"), kind: "image", motion: "none" } },
        ],
        captions: chunkCaptions([{ start: 0, end: 4, text: "one link and your agent finds every tool" }], 3),
        overlays: [],
        duration: 4,
      },
      out,
      { workDir: dir },
    );
    const info = await probe(out);
    expect([info.width, info.height]).toEqual([1080, 1920]);
    expect(info.duration).toBeCloseTo(4, 0);
    // At 3 s: the corner is the blue screen, the window's centre is the presenter (not blue).
    const pixel = async (x: number, y: number) => {
      const { stdout } = await exec(bin!, ["-hide_banner", "-loglevel", "error", "-ss", "3", "-i", out, "-frames:v", "1", "-vf", `crop=2:2:${x}:${y},format=rgb24`, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { encoding: "buffer" });
      return [...(stdout as Buffer)].slice(0, 3);
    };
    const corner = await pixel(40, 300);
    const window = await pixel(540, Math.round(1920 * 0.8));
    expect(corner[2]).toBeGreaterThan(200); // blue screen
    expect(window.reduce((sum, c, i) => sum + Math.abs(c - corner[i]), 0)).toBeGreaterThan(30); // not the screen
  }, 60_000);

  // Real footage, to look at: NOMEN_INSET_DEMO=<out.mp4> npx vitest run tests/creative/inset.test.ts
  const demo = process.env.NOMEN_INSET_DEMO;
  const clip = join(process.cwd(), "data/media/crv_44f79b14e69040b88e6c/shot2-tight.mp4");
  const screen = join(process.cwd(), "data/media/visuals-cmp_0b0772d89e2d4fe49175/site-home.png");
  it.skipIf(!demo || !existsSync(clip) || !existsSync(screen))("renders the demo from campaign footage", async () => {
    await renderTimeline(
      {
        aroll: [{ path: clip }],
        audio: null,
        segments: [
          { start: 0, end: 1.6, layer: "aroll" },
          { start: 1.6, end: 7, layer: "inset", broll: { path: screen, kind: "image", motion: "zoom_in" } },
        ],
        captions: chunkCaptions([{ start: 0, end: 7, text: "Give me one minute, and I'll show you all of it. You don't install any of it yourself." }], 3),
        overlays: [{ start: 1.6, end: 4.5, text: "01 · Paste one line" }],
        duration: 7,
      },
      demo!,
      { workDir: dir },
    );
  }, 120_000);
});
