// filmed_screen's plate: one photo of a desktop monitor taken with a phone, its display a solid
// green, and where that display sits in the photo. The edit (edit.ts) warps each beat's desktop
// screen into the display, keys the green out of the photo and lays the photo back on top, so the
// bezel covers the screen's edges and the room around it is a real room.
//
//   platePrompt ─ Naive image model ─► plate-try1.png
//     └─ ffmpeg ─ raw RGB ─► findScreenQuad: the largest green region, its corners, sanity checks
//          └─ a clean display: plate.png + plate.json
//          └─ not one: a new image under a new key (PLATE_TRIES in all), then give up: the edit
//             shows the screens full frame instead
//
// One plate per video, cached in the video's media folder, so a re-edit never pays for it again.

import { execFile } from "node:child_process";
import { copyFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { download, ffmpegPath, probe } from "../media";
import type { NaiveClient } from "../naive";
import { lookOnly } from "./plan";
import type { FilmedPlate, Point, Quad } from "./types";

const exec = promisify(execFile);

/** Images paid for per video before falling back to full-frame screens. */
export const PLATE_TRIES = 3;

// ---------- the prompt ----------

/**
 * The photo to ask for. It names only what should be in the picture (image models draw what a
 * prompt names, even after "no"): the monitor seen at a slight angle, whole, filling most of the
 * width, and its display one flat chroma green so the screen can be found and replaced exactly.
 */
export function platePrompt(setting = ""): string {
  const room = lookOnly(setting);
  return [
    "Vertical 9:16 handheld smartphone photo of a desktop computer monitor on a desk, taken from a desk chair about 60 cm away, a little to one side and slightly above, so the monitor is seen at a slight angle.",
    "The monitor fills most of the frame's width, a little above the middle of the picture. The whole monitor is in the picture with its thin dark bezel and its stand, the wall above it and the desk and keyboard in the lower third.",
    "The display is switched on and shows one solid, flat, uniform pure green (#00FF00) from edge to edge, like a chroma-key screen, evenly lit and matte.",
    room ? `The room: ${room}.` : "A real home office in soft natural daylight: a desk lamp, a mug and a few books on a wooden desk, a plain wall behind.",
    "The display is the only green thing in the picture.",
    "Photorealistic, natural phone-camera look, realistic colours, the monitor in sharp focus. A plain photograph with no text, logos, stickers or brand names anywhere.",
  ].join(" ");
}

// ---------- finding the display ----------

/** What counts as the display's green: bright enough, and clearly greener than red and blue. */
const GREEN = { min: 80, margin: 50 };
/** The display must cover at least this share of the photo (the edit frames it closer when it is small). */
export const MIN_COVER = 0.12;

export type QuadResult = { ok: true; quad: Quad; cover: number; fill: number } | { ok: false; reason: string };

const dist = (a: Point, b: Point) => Math.hypot(b.x - a.x, b.y - a.y);
const pct = (x: number) => `${Math.round(x * 100)}%`;

/** Shoelace area of a polygon. */
export function quadArea(quad: Quad): number {
  let sum = 0;
  quad.forEach((p, i) => {
    const q = quad[(i + 1) % 4];
    sum += p.x * q.y - q.x * p.y;
  });
  return Math.abs(sum) / 2;
}

/**
 * Finds the green display in a photo given as packed RGB (3 bytes a pixel). Takes the largest
 * 4-connected region of green pixels (a stray green object elsewhere does not count), its corners
 * by extreme sums (top-left: least x+y, bottom-right: most x+y, top-right: most x-y, bottom-left:
 * least x-y), and checks that it is really a monitor's screen: big enough, not cut off by the
 * photo's edge, a convex quadrilateral that the region fills, with a monitor's proportions and only
 * a slight angle. Coordinates are pixel indices.
 */
export function findScreenQuad(rgb: Uint8Array, width: number, height: number): QuadResult {
  const n = width * height;
  if (!(width > 2 && height > 2) || rgb.length < n * 3) return { ok: false, reason: "the image could not be read" };
  // 1 = green and not yet visited, 2 = visited.
  const mask = new Uint8Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 3) {
    const g = rgb[j + 1];
    if (g >= GREEN.min && g - Math.max(rgb[j], rgb[j + 2]) >= GREEN.margin) mask[i] = 1;
  }

  const stack = new Int32Array(n);
  let depth = 0;
  const visit = (j: number) => {
    if (mask[j] !== 1) return;
    mask[j] = 2;
    stack[depth++] = j;
  };
  let best: { count: number; edge: boolean; corners: [number, number, number, number] } | null = null;
  for (let start = 0; start < n; start++) {
    if (mask[start] !== 1) continue;
    visit(start);
    let count = 0;
    let edge = false;
    // TL, TR, BR, BL as pixel indices, and the extreme each one holds.
    const corners: [number, number, number, number] = [start, start, start, start];
    const extreme = [Infinity, -Infinity, -Infinity, Infinity]; // least x+y, most x-y, most x+y, least x-y
    while (depth) {
      const i = stack[--depth];
      const x = i % width;
      const y = (i - x) / width;
      count++;
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) edge = true;
      const sum = x + y;
      const diff = x - y;
      if (sum < extreme[0]) {
        extreme[0] = sum;
        corners[0] = i;
      }
      if (diff > extreme[1]) {
        extreme[1] = diff;
        corners[1] = i;
      }
      if (sum > extreme[2]) {
        extreme[2] = sum;
        corners[2] = i;
      }
      if (diff < extreme[3]) {
        extreme[3] = diff;
        corners[3] = i;
      }
      if (x > 0) visit(i - 1);
      if (x < width - 1) visit(i + 1);
      if (y > 0) visit(i - width);
      if (y < height - 1) visit(i + width);
    }
    if (!best || count > best.count) best = { count, edge, corners };
  }
  if (!best) return { ok: false, reason: "no green display in the photo" };

  const cover = best.count / n;
  if (cover < MIN_COVER) return { ok: false, reason: `the green display covers ${pct(cover)} of the photo (at least ${pct(MIN_COVER)} needed)` };
  if (best.edge) return { ok: false, reason: "the green display runs off the edge of the photo" };
  const quad = best.corners.map((i) => ({ x: i % width, y: Math.floor(i / width) })) as Quad;

  // Convex and clockwise on screen (y down): every turn bends the same way.
  for (let i = 0; i < 4; i++) {
    const [a, b, c] = [quad[i], quad[(i + 1) % 4], quad[(i + 2) % 4]];
    if ((b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x) <= 0) return { ok: false, reason: "the green region is not a four-cornered screen" };
  }
  const [tl, tr, br, bl] = quad;
  const top = dist(tl, tr);
  const bottom = dist(bl, br);
  const left = dist(tl, bl);
  const right = dist(tr, br);
  const aspect = (top + bottom) / (left + right);
  if (aspect < 1.2 || aspect > 2.6) return { ok: false, reason: `the green region is ${aspect.toFixed(2)}:1, not a monitor's shape` };
  const skew = Math.max(top / bottom, bottom / top, left / right, right / left);
  if (skew > 1.33) return { ok: false, reason: "the monitor is seen at too steep an angle" };
  const tilt = Math.max(Math.abs(Math.atan2(tr.y - tl.y, tr.x - tl.x)), Math.abs(Math.atan2(br.y - bl.y, br.x - bl.x))) * (180 / Math.PI);
  if (tilt > 12) return { ok: false, reason: `the monitor is tilted ${Math.round(tilt)} degrees` };
  // A real screen fills the quad its corners span; a blob, a curved screen or a screen with a
  // window drawn on it does not.
  const fill = best.count / Math.max(1, quadArea(quad));
  if (fill < 0.85 || fill > 1.12) return { ok: false, reason: `the green region fills ${pct(fill)} of its corners' outline, so it is not one flat screen` };
  return { ok: true, quad, cover, fill };
}

// ---------- framing ----------

/** Share of the frame's width the display spans after framing (before the camera's zoom). */
export const FILMED_FILL = 0.84;
/** Where the display's centre sits, as a share of the frame's height: above the spoken captions. */
const FILMED_CENTER_Y = 0.42;
/** The most the framing zooms into a photo whose display is small. */
const MAX_PLATE_ZOOM = 1.5;
/** The widest the display may get when the framing zooms in to lift it off the captions. */
const MAX_FILL = 0.9;

/**
 * How the edit frames the photo: the crop (in photo pixels) that, scaled to `out`, puts the display
 * across about 84% of the width and its centre at 42% of the height, so it sits above the
 * captions. A display low (or high) in the photo is framed a little closer, up to 90% of the
 * width, so the crop can reach that height without running past the photo. Never zooms in more
 * than 1.5x or past the photo's edges. Returns the crop and the display's corners in output pixels.
 */
export function framePlate(size: { width: number; height: number }, quad: Quad, out: { width: number; height: number }): { crop: { x: number; y: number; width: number; height: number }; quad: Quad } {
  const xs = quad.map((p) => p.x);
  const ys = quad.map((p) => p.y);
  const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const [cx, cy] = [(minX + maxX) / 2, (minY + maxY) / 2];
  const aspect = out.width / out.height;
  const widest = Math.min(size.width, size.height * aspect);
  const span = maxX - minX + 1;
  // Wide enough that the display spans FILMED_FILL of it and at most half its height...
  const wanted = Math.max(span / FILMED_FILL, ((maxY - minY + 1) / 0.5) * aspect);
  // ...or narrower, down to a MAX_FILL display, if that is what centring it at FILMED_CENTER_Y takes.
  const centred = Math.min((size.height - cy) / (1 - FILMED_CENTER_Y), cy / FILMED_CENTER_Y) * aspect;
  const floor = Math.max(widest / MAX_PLATE_ZOOM, span / MAX_FILL);
  const width = Math.round(Math.min(widest, Math.max(floor, Math.min(wanted, Math.max(centred, floor)))));
  const height = Math.min(size.height, Math.round(width / aspect));
  const clamp = (v: number, hi: number) => Math.round(Math.min(Math.max(0, v), Math.max(0, hi)));
  const x = clamp(cx - width / 2, size.width - width);
  const y = clamp(cy - FILMED_CENTER_Y * height, size.height - height);
  const sx = out.width / width;
  const sy = out.height / height;
  // Pixel centres map to pixel centres, the way ffmpeg's scale aligns them.
  return { crop: { x, y, width, height }, quad: quad.map((p) => ({ x: (p.x - x + 0.5) * sx - 0.5, y: (p.y - y + 0.5) * sy - 0.5 })) as Quad };
}

/** The quad pushed out by `by` pixels from its centre, so a warped screen reaches under the bezel. */
export function expandQuad(quad: Quad, by: number): Quad {
  const cx = quad.reduce((s, p) => s + p.x, 0) / 4;
  const cy = quad.reduce((s, p) => s + p.y, 0) / 4;
  return quad.map((p) => {
    const d = Math.hypot(p.x - cx, p.y - cy) || 1;
    return { x: p.x + ((p.x - cx) / d) * by, y: p.y + ((p.y - cy) / d) * by };
  }) as Quad;
}

/** Each edge as a line a*x + b*y + c: the signed distance to it in pixels, positive inside the quad. */
export function quadEdges(quad: Quad): Array<{ a: number; b: number; c: number }> {
  return quad.map((p, i) => {
    const q = quad[(i + 1) % 4];
    const len = Math.hypot(q.x - p.x, q.y - p.y) || 1;
    // For clockwise corners (y down) the inside is to the right of each edge.
    const a = -(q.y - p.y) / len;
    const b = (q.x - p.x) / len;
    return { a, b, c: -(a * p.x + b * p.y) };
  });
}

// ---------- making one ----------

/**
 * What plate.json records: "pending" while images are still being tried (`tries` used so far,
 * `errors` provider hiccups), "ready" with the photo and its display, or "fallback" with the reason
 * no photo was usable. `notes` says what was wrong with each rejected image.
 */
export type PlateRecord = {
  status: "pending" | "ready" | "fallback";
  tries: number;
  errors: number;
  notes: string[];
  cost_micro: number;
  plate?: FilmedPlate & { width: number; height: number };
  reason?: string;
  /** Provider trouble: not before this time. */
  retry_at?: string | null;
  /** When the provider first said the current image was still in flight. */
  inflight_since?: string | null;
};

export const newPlateRecord = (): PlateRecord => ({ status: "pending", tries: 0, errors: 0, notes: [], cost_micro: 0 });

/** A photo as packed RGB, decoded by ffmpeg. */
export async function decodeRgb(path: string): Promise<{ rgb: Buffer; width: number; height: number }> {
  const bin = await ffmpegPath();
  if (!bin) throw new Error("ffmpeg is not available");
  const { width, height } = await probe(path);
  if (!(width > 0 && height > 0)) throw new Error(`could not read the size of ${path}`);
  const { stdout } = await exec(bin, ["-hide_banner", "-loglevel", "error", "-i", path, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], {
    encoding: "buffer",
    maxBuffer: width * height * 3 + 1024 * 1024,
  });
  return { rgb: stdout as unknown as Buffer, width, height };
}

const EXTENSIONS: Record<string, string> = { "image/png": ".png", "image/jpeg": ".jpg", "image/jpg": ".jpg", "image/webp": ".webp" };

export type PlateOptions = {
  /** The video's media folder: plate-tryN.* and plate.png go here. */
  dir: string;
  /** Idempotency key prefix, unique per video; try n uses `${key}-plate-${n}`. */
  key: string;
  /** The room around the monitor (the brief's setting), if the director gave one. */
  setting?: string;
  /** Saves a file link to a path (tests read local files). */
  fetchTo?: (url: string, path: string) => Promise<unknown>;
};

/**
 * Takes a plate record forward: renders images until one shows a clean green display or
 * PLATE_TRIES are used, then marks it "ready" (plate.png in `dir`) or "fallback". Provider errors
 * (busy, rate limits, out of credits) are thrown with the record updated so far; the caller keeps
 * it and decides when to try again.
 */
export async function makePlate(naive: Pick<NaiveClient, "generateImage" | "fileUrl">, record: PlateRecord, options: PlateOptions): Promise<PlateRecord> {
  const fetchTo = options.fetchTo ?? download;
  const prompt = platePrompt(options.setting);
  while (record.status === "pending" && record.tries < PLATE_TRIES) {
    const n = record.tries + 1;
    const result = await naive.generateImage({ prompt, aspect_ratio: "9:16" }, `${options.key}-plate-${n}`);
    record.tries = n;
    record.cost_micro += result.cost_micro_usd ?? 0;
    const file = result.files[0];
    if (!file) {
      record.notes.push(`image ${n}: the image model returned no file`);
      continue;
    }
    const raw = join(options.dir, `plate-try${n}${EXTENSIONS[file.content_type] ?? ".png"}`);
    await fetchTo((await naive.fileUrl(file.id)).url, raw);
    let found: QuadResult;
    let size = { width: 0, height: 0 };
    try {
      const image = await decodeRgb(raw);
      size = { width: image.width, height: image.height };
      found = findScreenQuad(image.rgb, image.width, image.height);
    } catch (error) {
      found = { ok: false, reason: `unreadable (${error instanceof Error ? error.message : String(error)})` };
    }
    if (!found.ok) {
      record.notes.push(`image ${n}: ${found.reason}`);
      continue;
    }
    const path = join(options.dir, "plate.png");
    if (raw.endsWith(".png")) await copyFile(raw, path);
    else await exec((await ffmpegPath())!, ["-hide_banner", "-loglevel", "error", "-y", "-i", raw, "-frames:v", "1", path]);
    record.plate = { path, quad: found.quad, ...size };
    record.status = "ready";
  }
  if (record.status === "pending") {
    record.status = "fallback";
    record.reason = `no usable photo in ${record.tries} tries (${record.notes.join("; ")})`;
  }
  return record;
}
