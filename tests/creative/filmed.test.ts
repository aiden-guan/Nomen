import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { chunkCaptions } from "@/lib/creative/captions";
import { editFfmpeg, OUTPUT, renderTimeline } from "@/lib/creative/edit";
import { decodeRgb, expandQuad, findScreenQuad, framePlate, makePlate, newPlateRecord, PLATE_TRIES, platePrompt, quadArea, quadEdges } from "@/lib/creative/plate";
import { findChrome, renderScreen } from "@/lib/creative/screens";
import type { Quad } from "@/lib/creative/types";
import { probe } from "@/lib/media";

const exec = promisify(execFile);
const ffmpeg = await editFfmpeg();

const quadOf = (...xy: number[]): Quad => [0, 1, 2, 3].map((i) => ({ x: xy[2 * i], y: xy[2 * i + 1] })) as Quad;
/** A point-in-quad test with the edges worked out once. */
const insideOf = (quad: Quad | null) => {
  if (!quad) return () => false;
  const edges = quadEdges(quad);
  return (x: number, y: number) => edges.every(({ a, b, c }) => a * x + b * y + c >= 0);
};

/** A grey photo with a dark bezel around a green display, as packed RGB. */
function photo(width: number, height: number, display: Quad | null, extra: (x: number, y: number) => number[] | null = () => null): Uint8Array {
  const rgb = new Uint8Array(width * height * 3);
  const inDisplay = insideOf(display);
  const inBezel = insideOf(display ? expandQuad(display, 16) : null);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      const px = extra(x, y) ?? (inDisplay(x, y) ? [18, 236 - Math.round((y / height) * 30), 34] : inBezel(x, y) ? [24, 24, 28] : [112, 106, 100]);
      rgb.set(px, i);
    }
  }
  return rgb;
}

async function png(rgb: Uint8Array, width: number, height: number, path: string) {
  const raw = `${path}.rgb`;
  await writeFile(raw, rgb);
  await exec(ffmpeg!, ["-hide_banner", "-loglevel", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", `${width}x${height}`, "-i", raw, "-frames:v", "1", path]);
  await rm(raw);
}

const near = (a: { x: number; y: number }, b: { x: number; y: number }, by: number) => Math.hypot(a.x - b.x, a.y - b.y) <= by;

describe("finding the green display", () => {
  const display = quadOf(100, 500, 800, 530, 790, 960, 110, 940);

  it("takes the corners of the largest green region, ignoring a smaller green thing elsewhere", () => {
    const plant = (x: number, y: number) => (Math.hypot(x - 450, y - 1400) < 60 ? [40, 170, 50] : null);
    const found = findScreenQuad(photo(900, 1600, display, plant), 900, 1600);
    expect(found.ok).toBe(true);
    if (!found.ok) return;
    found.quad.forEach((corner, i) => expect(near(corner, display[i], 1.5)).toBe(true));
    expect(found.cover).toBeCloseTo(quadArea(display) / (900 * 1600), 1);
    expect(found.fill).toBeGreaterThan(0.97);
  });

  it("still finds a display with a glare spot on it", () => {
    const glare = (x: number, y: number) => (Math.hypot(x - 300, y - 650) < 70 ? [210, 230, 205] : null);
    const found = findScreenQuad(photo(900, 1600, display, glare), 900, 1600);
    expect(found.ok).toBe(true);
  });

  it("rejects photos that are not a clean, whole monitor screen", () => {
    const reason = (rgb: Uint8Array) => {
      const found = findScreenQuad(rgb, 900, 1600);
      return found.ok ? "ok" : found.reason;
    };
    expect(reason(photo(900, 1600, null))).toMatch(/no green display/);
    expect(reason(photo(900, 1600, quadOf(300, 700, 500, 700, 500, 820, 300, 820)))).toMatch(/covers 2% of the photo/);
    expect(reason(photo(900, 1600, quadOf(-40, 500, 800, 530, 790, 960, -40, 940)))).toMatch(/runs off the edge/);
    expect(reason(photo(900, 1600, quadOf(250, 300, 650, 300, 650, 1300, 250, 1300)))).toMatch(/not a monitor's shape/); // a phone, upright
    expect(reason(photo(900, 1600, quadOf(250, 500, 650, 500, 850, 900, 50, 900)))).toMatch(/too steep/);
    expect(reason(photo(900, 1600, quadOf(100, 400, 800, 600, 760, 1040, 60, 840)))).toMatch(/tilted/);
    const disc = (x: number, y: number) => (Math.hypot(x - 450, y - 800) < 380 ? [20, 230, 30] : null);
    expect(reason(photo(900, 1600, null, disc))).not.toBe("ok");
    // A window drawn on the display: its corners still span the whole screen, but it no longer fills them.
    const window = (x: number, y: number) => (x > 300 && x < 600 && y > 620 && y < 820 ? [240, 240, 240] : null);
    expect(reason(photo(900, 1600, display, window))).toMatch(/not one flat screen/);
  }, 30_000);

  it("measures the signed distance to each edge, positive inside", () => {
    const edges = quadEdges(display);
    const d = (x: number, y: number) => Math.min(...edges.map(({ a, b, c }) => a * x + b * y + c));
    expect(d(450, 730)).toBeGreaterThan(100);
    expect(d(450, 400)).toBeLessThan(-100);
    expect(d(105, 720)).toBeCloseTo(0, -1);
  });
});

describe("framing the photo", () => {
  it("frames the display across 84% of the width with its centre at 42% of the height", () => {
    const quad = quadOf(150, 560, 950, 590, 930, 1080, 170, 1060);
    const { crop, quad: out } = framePlate({ width: 1080, height: 1920 }, quad, OUTPUT);
    expect(crop.width / crop.height).toBeCloseTo(9 / 16, 2);
    expect(crop.x).toBeGreaterThanOrEqual(0);
    expect(crop.x + crop.width).toBeLessThanOrEqual(1080);
    const xs = out.map((p) => p.x);
    const ys = out.map((p) => p.y);
    expect((Math.max(...xs) - Math.min(...xs) + 1) / 1080).toBeCloseTo(0.84, 2);
    expect((Math.max(...ys) + Math.min(...ys)) / 2 / 1920).toBeCloseTo(0.42, 2);
  });

  it("zooms into a small display by at most 1.5x and never past the photo's edges", () => {
    const small = quadOf(60, 1500, 460, 1500, 460, 1750, 60, 1750);
    const { crop, quad } = framePlate({ width: 1080, height: 1920 }, small, OUTPUT);
    expect(crop.width).toBe(720);
    expect(crop.x).toBe(0);
    expect(crop.y + crop.height).toBe(1920);
    expect(quad[1].x - quad[0].x).toBeCloseTo(600, 0);
  });

  it("frames a display that sits low in the photo a little closer, to lift it off the captions", () => {
    const low = quadOf(100, 660, 980, 660, 980, 1222, 100, 1222);
    const { quad } = framePlate({ width: 1080, height: 1920 }, low, OUTPUT);
    const width = quad[1].x - quad[0].x + 1;
    const centre = (quad[0].y + quad[3].y) / 2 / 1920;
    expect(width / 1080).toBeCloseTo(0.9, 2); // closer than the usual 84%, never past 90%
    expect(centre).toBeLessThan(0.45); // left where the photo had it, it would sit at 47%
  });
});

describe.skipIf(!ffmpeg)("making the plate", () => {
  let dir = "";
  const good = quadOf(120, 640, 960, 610, 980, 1150, 100, 1130);
  const images: Record<string, string> = {};
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "nomen-plate-"));
    await png(photo(1080, 1920, null), 1080, 1920, (images.blank = join(dir, "blank.png")));
    await png(photo(1080, 1920, good), 1080, 1920, (images.good = join(dir, "good.png")));
  }, 60_000);
  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  /** A Naive stand-in that hands out the given images in order. */
  const fake = (sequence: string[], calls: Array<{ prompt: string; aspect_ratio?: string; key: string }>) => ({
    generateImage: async (input: { prompt: string; aspect_ratio?: string }, key: string) => {
      calls.push({ ...input, key });
      return { model: "fake", files: [{ id: `fil_${calls.length}`, content_type: "image/png" }], cost_micro_usd: 30_000 };
    },
    fileUrl: async (id: string) => ({ url: images[sequence[Number(id.slice(4)) - 1]], expires_at: "" }),
  });

  it("tries again under a new key when the photo has no clean display, then keeps the good one", async () => {
    const out = join(dir, "video1");
    await mkdir(out);
    const calls: Array<{ prompt: string; aspect_ratio?: string; key: string }> = [];
    const record = await makePlate(fake(["blank", "good"], calls) as never, newPlateRecord(), { dir: out, key: "crv_x", setting: "a dim bedroom desk at night, warm lamp light", fetchTo: (url, path) => copyFile(url, path) });
    expect(record.status).toBe("ready");
    expect(calls.map((c) => c.key)).toEqual(["crv_x-plate-1", "crv_x-plate-2"]);
    expect(calls[0].aspect_ratio).toBe("9:16");
    expect(calls[0].prompt).toContain("#00FF00");
    expect(calls[0].prompt).toContain("a dim bedroom desk at night, warm lamp light");
    expect(record.tries).toBe(2);
    expect(record.cost_micro).toBe(60_000);
    expect(record.notes).toEqual(["image 1: no green display in the photo"]);
    expect(record.plate?.path).toBe(join(out, "plate.png"));
    expect(existsSync(join(out, "plate.png"))).toBe(true);
    expect([record.plate?.width, record.plate?.height]).toEqual([1080, 1920]);
    record.plate!.quad.forEach((corner, i) => expect(near(corner, good[i], 1.5)).toBe(true));
  });

  it("gives up after three photos without a clean display", async () => {
    const out = join(dir, "video2");
    await mkdir(out);
    const calls: Array<{ prompt: string; key: string }> = [];
    const record = await makePlate(fake(["blank", "blank", "blank", "good"], calls) as never, newPlateRecord(), { dir: out, key: "crv_y", fetchTo: (url, path) => copyFile(url, path) });
    expect(calls).toHaveLength(PLATE_TRIES);
    expect(record.status).toBe("fallback");
    expect(record.reason).toMatch(/no usable photo in 3 tries/);
    expect(existsSync(join(out, "plate.png"))).toBe(false);
  });

  it("asks for a whole monitor at a slight angle, in the brief's room or a plain one", () => {
    expect(platePrompt()).toMatch(/9:16 handheld smartphone photo/);
    expect(platePrompt()).toMatch(/slight angle/);
    expect(platePrompt()).toMatch(/home office/);
    expect(platePrompt()).not.toMatch(/\bhands?\b/i);
  });
});

/** One pixel of a video at `at` seconds, as RGB. */
async function pixel(video: string, at: number, x: number, y: number): Promise<number[]> {
  const { stdout } = await exec(ffmpeg!, ["-hide_banner", "-loglevel", "error", "-ss", String(at), "-i", video, "-frames:v", "1", "-vf", `crop=2:2:${Math.round(x)}:${Math.round(y)},format=rgb24`, "-f", "rawvideo", "pipe:1"], {
    encoding: "buffer",
  });
  return [...(stdout as unknown as Buffer)].slice(0, 3);
}

describe.skipIf(!ffmpeg)("the filmed edit", () => {
  let dir = "";
  const display = quadOf(150, 560, 950, 590, 930, 1080, 170, 1060);
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "nomen-filmed-"));
    await png(photo(1080, 1920, display), 1080, 1920, join(dir, "plate.png"));
    await exec(ffmpeg!, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=c=0x1f3cff:s=1440x900:d=1", "-frames:v", "1", join(dir, "screen.png")]);
    await exec(ffmpeg!, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=f=220:d=2:sample_rate=48000", "-c:a", "aac", join(dir, "voice.m4a")]);
  }, 60_000);
  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("warps the screen into the photo's display, keys out the green and keeps the room", async () => {
    const out = join(dir, "filmed.mp4");
    const started = Date.now();
    await renderTimeline(
      {
        aroll: [],
        audio: { path: join(dir, "voice.m4a") },
        segments: [{ start: 0, end: 2, layer: "filmed", broll: { path: join(dir, "screen.png"), kind: "image", motion: "zoom_in" }, plate: { path: join(dir, "plate.png"), quad: display } }],
        captions: chunkCaptions([{ start: 0.2, end: 1.8, text: "paste one line into your agent" }], 3),
        overlays: [],
      },
      out,
      { workDir: dir },
    );
    console.log(`filmed: rendered 2 s in ${((Date.now() - started) / 1000).toFixed(1)} s`);
    const info = await probe(out);
    expect([info.width, info.height]).toEqual([1080, 1920]);
    expect(info.duration).toBeCloseTo(2, 1);

    // Where the display lands: framed, then zoomed 1.06x about the frame's centre; the hand-held
    // drift moves it at most ~15 px, far less than the margins used here.
    const { quad } = framePlate({ width: 1080, height: 1920 }, display, OUTPUT);
    const zoom = (p: { x: number; y: number }) => ({ x: 540 + (p.x - 540) * 1.06, y: 960 + (p.y - 960) * 1.06 });
    const centre = zoom({ x: quad.reduce((s, p) => s + p.x, 0) / 4, y: quad.reduce((s, p) => s + p.y, 0) / 4 });
    for (const at of [0.3, 1.0, 1.7]) {
      const [r, g, b] = await pixel(out, at, centre.x, centre.y);
      expect(b).toBeGreaterThan(170); // the screen's blue
      expect(r).toBeLessThan(110);
      expect(g).toBeLessThan(120);
    }
    // Just inside each edge of the display: the screen, never the photo's green.
    const mid = (a: { x: number; y: number }, b: { x: number; y: number }) => zoom({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
    for (const [a, b] of [[0, 1], [1, 2], [2, 3], [3, 0]] as const) {
      const m = mid(quad[a], quad[b]);
      const towards = { x: centre.x - m.x, y: centre.y - m.y };
      const len = Math.hypot(towards.x, towards.y);
      const [r, g, bl] = await pixel(out, 1.0, m.x + (towards.x / len) * 24, m.y + (towards.y / len) * 24);
      expect(g - Math.max(r, bl)).toBeLessThan(20);
    }
    // Above the monitor: the room's grey wall.
    const [r, g, b] = await pixel(out, 1.0, 540, 160);
    expect(Math.max(r, g, b) - Math.min(r, g, b)).toBeLessThan(20);
    expect(g).toBeGreaterThan(80);
    expect(g).toBeLessThan(140);
  }, 120_000);

  it("moves the camera: the same spot on screen drifts over time", async () => {
    const out = join(dir, "filmed.mp4");
    // The bezel's top edge, sampled in one column over time: its row changes as the camera drifts.
    const column = async (at: number) => {
      const { stdout } = await exec(ffmpeg!, ["-hide_banner", "-loglevel", "error", "-ss", String(at), "-i", out, "-frames:v", "1", "-vf", "crop=1:1920:540:0,format=gray", "-f", "rawvideo", "pipe:1"], { encoding: "buffer" });
      const values = [...(stdout as unknown as Buffer)];
      return values.findIndex((v, y) => y > 200 && v < 50); // first dark (bezel) row
    };
    const rows = await Promise.all([0.1, 0.9, 1.8].map(column));
    expect(new Set(rows).size).toBeGreaterThan(1);
    expect(Math.max(...rows) - Math.min(...rows)).toBeLessThan(30);
  }, 60_000);

  // To look at: NOMEN_FILMED_DEMO=<out.mp4> npx vitest run tests/creative/filmed.test.ts
  // (NOMEN_FILMED_SCREEN=<a screen clip> picks the second screen; default: the monid.ai run's b3).
  const demo = process.env.NOMEN_FILMED_DEMO;
  const clip = process.env.NOMEN_FILMED_SCREEN ?? join(process.cwd(), "data/media/crv_6e2e8596c38a4929bbc7/screens/b3.mp4");
  const chrome = findChrome();
  it.skipIf(!demo || !existsSync(clip))("renders the demo: a desktop terminal and an existing screen on a filmed monitor", async () => {
    const work = join(dir, "demo");
    await mkdir(work, { recursive: true });
    // A plate with a little life in it: a warm wall, a desk, a bezel and stand, soft noise.
    const monitor = quadOf(118, 690, 968, 660, 985, 1222, 104, 1196);
    const inMonitor = insideOf(monitor);
    const inBezel = insideOf(expandQuad(monitor, 20));
    const room = (x: number, y: number) => {
      const n = ((x * 7919 + y * 104729) % 23) - 11;
      if (inMonitor(x, y)) return [24 + n / 3, 222 - y / 40, 40];
      if (inBezel(x, y)) return [20 + n / 4, 20 + n / 4, 23 + n / 4];
      if (x > 480 && x < 600 && y > 1200 && y < 1420) return [38 + n / 3, 38 + n / 3, 42 + n / 3]; // stand
      if (y > 1380) return [128 - (y - 1380) / 12 + n, 92 - (y - 1380) / 16 + n, 60 + n]; // desk
      return [176 - y / 28 + n, 166 - y / 30 + n, 150 - y / 34 + n]; // wall
    };
    const plate = join(work, "plate.png");
    await png(photo(1080, 1920, null, (x, y) => room(x, y).map((v) => Math.max(0, Math.min(255, Math.round(v))))), 1080, 1920, plate);
    await exec(ffmpeg!, ["-hide_banner", "-loglevel", "error", "-y", "-i", plate, "-vf", "gblur=sigma=1.2", join(work, "plate-soft.png")]);
    const found = findScreenQuad((await decodeRgb(join(work, "plate-soft.png"))).rgb, 1080, 1920);
    expect(found.ok).toBe(true);
    if (!found.ok) return;

    const segments: Parameters<typeof renderTimeline>[0]["segments"] = [];
    let at = 0;
    if (chrome) {
      const terminal = await renderScreen(TERMINAL, [{ t: 0, label: "empty" }, { t: 2.4, label: "typed" }, { t: 3.2, label: "connected" }], { id: "demo-terminal", brief: "", line: "", seconds: 4, reference_visual: "", size: "desktop" }, { workDir: work, allow: [work] });
      segments.push({ start: 0, end: 4, layer: "filmed", broll: { path: terminal.path, kind: terminal.kind, motion: "none" }, plate: { path: join(work, "plate-soft.png"), quad: found.quad } });
      at = 4;
    }
    segments.push({ start: at, end: at + 4, layer: "filmed", broll: { path: resolve(clip), kind: "video", motion: "none" }, plate: { path: join(work, "plate-soft.png"), quad: found.quad } });
    await renderTimeline(
      {
        aroll: [],
        audio: null,
        segments,
        captions: chunkCaptions([{ start: 0, end: at + 4, text: "Open your terminal, paste one line, and your agent can use every tool on Monid." }], 3),
        overlays: [{ start: 0, end: 2.5, text: "the setup nobody shows you" }],
        duration: at + 4,
      },
      demo!,
      { workDir: work },
    );
    const sheet = demo!.replace(/\.mp4$/, "") + "-frames.jpg";
    await exec(ffmpeg!, ["-hide_banner", "-loglevel", "error", "-y", "-i", demo!, "-vf", `fps=${8 / (at + 4)},scale=360:-2,tile=8x1`, "-frames:v", "1", sheet]);
    console.log(`demo: ${demo} and ${sheet}`);
  }, 300_000);
});

const TERMINAL = `<!doctype html><html><head><style>
body{background:linear-gradient(135deg,#1d2a44,#0b1020);font-family:-apple-system,"Helvetica Neue",Arial,sans-serif}
.win{position:absolute;left:70px;top:60px;width:1300px;height:780px;border-radius:18px;background:#0d1117;box-shadow:0 20px 60px rgba(0,0,0,.5);overflow:hidden}
.bar{height:64px;background:#1b2130;display:flex;align-items:center;gap:14px;padding-left:24px;color:#8b94a7;font-size:30px}
.dot{width:22px;height:22px;border-radius:50%}
.body{padding:40px 48px;font:500 52px/1.35 Menlo,"DejaVu Sans Mono",monospace;color:#e6edf3;white-space:pre}
.p{color:#7ee787}.ok{color:#79c0ff}.cur{display:inline-block;width:28px;height:58px;background:#e6edf3;vertical-align:-10px}
</style></head><body><div class="win"><div class="bar"><span class="dot" style="background:#ff5f57"></span><span class="dot" style="background:#febc2e"></span><span class="dot" style="background:#28c840"></span><span style="margin-left:20px">zsh — agent</span></div>
<div class="body"><span class="p">~ $</span> <span id="cmd"></span><span class="cur" id="cur"></span>
<span id="out" class="ok"></span></div></div>
<script>
function render(){
  document.getElementById('cmd').textContent = typed('set up https://monid.ai/SKILL.md', 0.3, 15);
  var done = T >= 2.6;
  document.getElementById('out').textContent = done ? '✓ connected: 2900+ tools' : '';
  document.getElementById('cur').style.visibility = done ? 'hidden' : 'visible';
}
render();
</script></body></html>`;
