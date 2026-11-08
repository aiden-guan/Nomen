// The footage clone: how each segment of a reference is re-performed for a one-to-one remake.
//
// The layout analysis (remake.ts) splits the reference into segments of five kinds, and each kind
// has its own strategy, as layers on the stage:
//
//   talking_head        the host, re-performed: a twin frame (the reference frame with our persona
//                       in the same pose, size and place, overlays removed) animated by Kling 3.0
//                       Motion Control with the reference's own footage as the motion
//   stitch              another creator's clip: the brand's co-host (a second persona) re-performs
//                       it the same way, and the host's cut-out inset is re-performed on green and
//                       keyed back in at the reference's box
//   screen_walkthrough  a phone filming a monitor: the original footage is kept and our product's
//                       screens are warped into the display, tracked from the vision model's corners
//                       per sampled frame (or, when the corners don't hold up, the filmed_screen plate
//                       with hand-held motion); the host's inset on green, keyed, as above
//   broll               footage with nobody in it: kept as it is
//   graphic             a full-stage graphic: the screen builder makes ours
//
// Takes split each cloned layer at its real cuts: a scene change inside that layer's own region.
// A graphic popping in elsewhere on the stage is not a cut (Kling needs one continuous take, 3-30 s).
//
// Pure planning helpers are exported and unit-tested; the runners take their providers as
// arguments, so the tests run them with fakes.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";

import { ApiError } from "../http";
import type { NaiveClient } from "../naive";
import { extractJson } from "../research";
import { editFfmpeg } from "./edit";
import type { Gender } from "./persona";
import { lookOnly } from "./plan";
import type { Box, RemakeLayout, RemakeSegment, Stage } from "./remake";
import type { Quad } from "./types";

const exec = promisify(execFile);

export type Rect = { x: number; y: number; width: number; height: number };

const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));
const round = (x: number, digits = 3) => Math.round(x * 10 ** digits) / 10 ** digits;
const even = (x: number) => Math.max(2, 2 * Math.round(x / 2));
const fmt = (x: number) => String(Math.round(x * 10000) / 10000);

// ---------- the price list ----------

/** What the rest of a remake costs, in USD (the presenter's own price is on the presenter). */
export const PRICES = {
  /** One Naive image (persona portrait, twin frame, plate). */
  image: 0.04,
  /** The emotional read (or the conversion), its timings and the phrases: one remake's audio. */
  audio: 0.15,
  /** One screen-builder graphic (a Sonnet page and its check). */
  graphic: 0.05,
  /** One vision call (layout, a gate, the screen corners, the final check). */
  vision: 0.02,
} as const;

/** Twin frames per take: the first plus remakes after the gate sends one back. */
export const TWIN_TRIES = 3;
/** Presenter renders per take before the segment falls back to our own equivalent. */
export const RENDER_TRIES = 2;

// ---------- crops ----------

/** Aspect ratios the image model makes (it clamps others to the nearest). */
export const IMAGE_RATIOS = ["9:16", "2:3", "3:4", "4:5", "1:1", "5:4", "4:3", "3:2", "16:9"] as const;
export const ratioValue = (ratio: string) => {
  const [w, h] = ratio.split(":").map(Number);
  return w / h;
};

/** The ratio closest to a width and height (by log distance, so 2:1 and 1:2 are equally far from 1:1). */
export function nearestRatio(width: number, height: number, ratios: readonly string[] = IMAGE_RATIOS): string {
  const want = Math.log(width / Math.max(1, height));
  return [...(ratios.length ? ratios : IMAGE_RATIOS)].sort((a, b) => Math.abs(Math.log(ratioValue(a)) - want) - Math.abs(Math.log(ratioValue(b)) - want))[0];
}

/** A box (fractions of the stage) in stage pixels. */
export function rectOf(box: Box, stage: Pick<Stage, "width" | "height">): Rect {
  return { x: Math.round(box.x * stage.width), y: Math.round(box.y * stage.height), width: Math.round(box.w * stage.width), height: Math.round(box.h * stage.height) };
}

/** The largest centred part of `rect` at `ratio` (the stage clone: the prototype cut the band to 5:4 this way). */
export function shrinkToRatio(rect: Rect, ratio: string): Rect {
  const r = ratioValue(ratio);
  const width = 2 * Math.floor(Math.min(rect.width, rect.height * r) / 2);
  const height = 2 * Math.floor(Math.min(rect.height, width / r) / 2);
  const at = (x: number) => 2 * Math.round(x / 2);
  return { x: at(rect.x + (rect.width - width) / 2), y: at(rect.y + (rect.height - height) / 2), width, height };
}

/**
 * `rect` grown to `ratio` around its centre, inside `bounds`; where it cannot grow far enough it is
 * trimmed instead. An inset's crop: the cut-out with a margin, at a ratio the image model makes.
 */
export function growToRatio(rect: Rect, ratio: string, bounds: Rect): Rect {
  const r = ratioValue(ratio);
  let width = Math.max(rect.width, rect.height * r);
  let height = width / r;
  if (width > bounds.width) [width, height] = [bounds.width, bounds.width / r];
  if (height > bounds.height) [height, width] = [bounds.height, bounds.height * r];
  const w = 2 * Math.floor(width / 2);
  const h = 2 * Math.floor(height / 2);
  const x = clamp(rect.x + rect.width / 2 - w / 2, bounds.x, bounds.x + bounds.width - w);
  const y = clamp(rect.y + rect.height / 2 - h / 2, bounds.y, bounds.y + bounds.height - h);
  return { x: 2 * Math.floor(x / 2), y: 2 * Math.floor(y / 2), width: w, height: h };
}

/** `rect` pushed out by `by` (a share of its own size) on every side, inside `bounds`. */
export function padRect(rect: Rect, by: number, bounds: Rect): Rect {
  const dx = rect.width * by;
  const dy = rect.height * by;
  const x = Math.max(bounds.x, rect.x - dx);
  const y = Math.max(bounds.y, rect.y - dy);
  return { x: Math.round(x), y: Math.round(y), width: Math.round(Math.min(bounds.x + bounds.width, rect.x + rect.width + dx) - x), height: Math.round(Math.min(bounds.y + bounds.height, rect.y + rect.height + dy) - y) };
}

// ---------- layers ----------

export type Take = { n: number; start: number; end: number; frame_at: number };

/**
 * One thing the remake makes for a segment. `clone`: a person re-performed by Kling (the host, or
 * the co-host in a stitched clip; an inset is rendered on green and keyed). `keep`: the reference
 * footage itself. `screen`: the reference's filmed monitor with our product on it. `graphic`: a
 * full-stage graphic from the screen builder. Rects are in stage pixels.
 */
export type CloneLayer = {
  id: string;
  segment: number;
  kind: "clone" | "keep" | "screen" | "graphic";
  role: "host" | "cohost" | null;
  inset: boolean;
  start: number;
  end: number;
  /** What the layer covers on the stage (the whole stage, or the inset's crop). */
  crop: Rect;
  /** The image model's ratio for the twin frame and the motion clip (clone layers). */
  ratio: string;
  /** Stage areas blanked out of the motion clip so Kling sees one person (the host's inset over a stitch). */
  blank: Rect[];
  takes: Take[];
  /** The renders: takes grouped by what the presenter can do in one (chunkTakes). */
  chunks: Chunk[];
  /** Whether this person speaks here (the host's cut-out over a stitched clip listens). */
  speaks: boolean;
};

/** The host's cut-out on a segment: its box grown a little (hair, hands), at a ratio the presenter renders. */
function insetCrop(box: Box, stage: Stage, ratios: readonly string[]): { crop: Rect; ratio: string } {
  const bounds = { x: 0, y: 0, width: stage.width, height: stage.height };
  const padded = padRect(rectOf(box, stage), 0.08, bounds);
  const ratio = nearestRatio(padded.width, padded.height, ratios);
  return { crop: growToRatio(padded, ratio, bounds), ratio };
}

/**
 * The layers each segment needs, by its kind (takes are split later, once the cuts are known).
 * `ratios` are the aspect ratios the presenter renders: crops are cut to the nearest one.
 */
export function layersOf(layout: Pick<RemakeLayout, "segments">, stage: Stage, ratios: readonly string[] = IMAGE_RATIOS): CloneLayer[] {
  const whole = { x: 0, y: 0, width: stage.width, height: stage.height };
  const stageRatio = nearestRatio(stage.width, stage.height, ratios);
  const layers: CloneLayer[] = [];
  for (const segment of layout.segments) {
    const base = { segment: segment.n, start: segment.start, end: segment.end, inset: false, blank: [] as Rect[], takes: [] as Take[], chunks: [] as Chunk[], speaks: true };
    const inset = segment.presenter.inset ? insetCrop(segment.presenter.inset, stage, ratios) : null;
    if (segment.kind === "talking_head") {
      layers.push({ ...base, id: `s${segment.n}`, kind: "clone", role: "host", crop: shrinkToRatio(whole, stageRatio), ratio: stageRatio });
    } else if (segment.kind === "stitch") {
      const blank = segment.presenter.inset ? [padRect(rectOf(segment.presenter.inset, stage), 0.04, whole)] : [];
      layers.push({ ...base, id: `s${segment.n}`, kind: "clone", role: "cohost", crop: shrinkToRatio(whole, stageRatio), ratio: stageRatio, blank });
    } else if (segment.kind === "screen_walkthrough") {
      layers.push({ ...base, id: `s${segment.n}`, kind: "screen", role: null, crop: whole, ratio: stageRatio });
    } else if (segment.kind === "graphic") {
      layers.push({ ...base, id: `s${segment.n}`, kind: "graphic", role: null, crop: whole, ratio: stageRatio });
    } else {
      layers.push({ ...base, id: `s${segment.n}`, kind: "keep", role: null, crop: whole, ratio: stageRatio });
    }
    // The host as a cut-out over someone else's clip (listening) or a filmed screen (talking): on green.
    if (inset && segment.kind !== "talking_head") layers.push({ ...base, id: `s${segment.n}-inset`, kind: "clone", role: "host", inset: true, crop: inset.crop, ratio: inset.ratio, speaks: segment.kind !== "stitch" });
  }
  return layers;
}

/**
 * Segment edges moved onto the reference's own cuts: the vision pass sees a frame every second or
 * two, the scene detector sees every frame. An edge with no cut within `tolerance` stays put.
 */
export function snapSegments<T extends Pick<RemakeSegment, "start" | "end">>(segments: T[], cuts: number[], tolerance = 0.9): T[] {
  const out = segments.map((s) => ({ ...s }));
  for (let i = 1; i < out.length; i++) {
    const edge = out[i].start;
    const near = cuts.filter((c) => Math.abs(c - edge) <= tolerance && c > out[i - 1].start + 0.3 && c < out[i].end - 0.3).sort((a, b) => Math.abs(a - edge) - Math.abs(b - edge))[0];
    if (near !== undefined) {
      out[i - 1].end = round(near);
      out[i].start = round(near);
    }
  }
  return out;
}

/**
 * Mean absolute difference (0-255) between two grey frames over `keep` (fractions of the frame),
 * leaving out `drop`. A real cut changes the whole region; a graphic popping in changes only its box.
 */
export function regionDiff(a: Uint8Array, b: Uint8Array, width: number, height: number, keep: Box[], drop: Box[] = []): number {
  const inside = (boxes: Box[], x: number, y: number) => boxes.some((r) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h);
  let sum = 0;
  let count = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [fx, fy] = [(x + 0.5) / width, (y + 0.5) / height];
      if (!inside(keep, fx, fy) || inside(drop, fx, fy)) continue;
      sum += Math.abs(a[y * width + x] - b[y * width + x]);
      count++;
    }
  }
  return count ? sum / count : 0;
}

/** Above this mean difference over a layer's own region, a scene change is a cut in that layer. */
export const CUT_DIFF = 14;

/**
 * A layer's takes: its span cut at its real cuts, never a stub (a piece under `min` joins its
 * neighbour), and no take past what the presenter renders (longer stretches are split evenly).
 */
export function splitTakes(span: { start: number; end: number }, cuts: number[], min = 0.6, max = 30): Take[] {
  const points = [span.start];
  for (const cut of [...cuts].sort((a, b) => a - b)) {
    if (cut - points[points.length - 1] >= min && span.end - cut >= min) points.push(cut);
  }
  points.push(span.end);
  const takes: Take[] = [];
  for (let i = 0; i + 1 < points.length; i++) {
    const [a, b] = [points[i], points[i + 1]];
    const pieces = Math.max(1, Math.ceil((b - a) / max - 1e-9));
    for (let k = 0; k < pieces; k++) {
      const start = round(a + ((b - a) * k) / pieces);
      const end = round(a + ((b - a) * (k + 1)) / pieces);
      takes.push({ n: takes.length + 1, start, end, frame_at: round(start + Math.min(0.12, (end - start) / 4)) });
    }
  }
  return takes;
}

/** One render of a cloned layer: consecutive takes, each a shot of it (one take for a single-take presenter). */
export type Chunk = { n: number; start: number; end: number; takes: Take[] };

/**
 * A layer's takes grouped into renders of at most `max` seconds. A multi-shot presenter renders the
 * reference's cuts inside one render (one voice per render); otherwise every take is its own.
 */
export function chunkTakes(takes: Take[], max: number, multiShot: boolean): Chunk[] {
  const chunks: Chunk[] = [];
  for (const take of takes) {
    const last = chunks[chunks.length - 1];
    if (multiShot && last && take.end - last.start <= max + 1e-6) {
      last.takes.push(take);
      last.end = take.end;
    } else chunks.push({ n: chunks.length + 1, start: take.start, end: take.end, takes: [take] });
  }
  return chunks;
}

/**
 * Where a render that voices itself is cut onto the reference's span. Its lead-in silence is
 * skipped to start speaking when the reference does (at most 0.8 s), and a line that runs long is
 * played faster, picture and voice together so the lips still match, up to 1.25x; past that its
 * tail is cut (`cut`). `breath` is the time kept after the last word: a little mid-video, more for
 * the video's last take so the plug isn't clipped by the end. A render with no speech is used from
 * its start, at its own speed.
 */
export function fitChunk(clip: { duration: number; speech: { from: number; to: number } | null }, ref: { length: number; speechFrom: number | null }, breath = 0.12): { from: number; speed: number; cut: boolean } {
  if (!clip.speech || !(ref.length > 0)) return { from: 0, speed: 1, cut: false };
  const from = clamp(clip.speech.from - (ref.speechFrom ?? 0), 0, 0.8);
  const needed = clip.speech.to - from + breath;
  const ratio = needed / ref.length;
  return { from: round(from), speed: round(clamp(ratio, 1, 1.25), 3), cut: ratio > 1.25 + 1e-6 };
}

/**
 * A voice's fingerprint, to compare a render's voice with the next: the median pitch of its voiced
 * frames (autocorrelation, 70-400 Hz) and its level. Mono samples in -1..1.
 */
export function voiceStats(samples: Float32Array, rate: number): { pitch_hz: number | null; level_db: number } {
  const frame = Math.round(rate * 0.04);
  const pitches: number[] = [];
  let energy = 0;
  for (const s of samples) energy += s * s;
  const level = samples.length ? 10 * Math.log10(energy / samples.length + 1e-12) : -120;
  const [minLag, maxLag] = [Math.floor(rate / 400), Math.ceil(rate / 70)];
  for (let start = 0; start + frame + maxLag < samples.length; start += frame) {
    let e = 0;
    for (let i = 0; i < frame; i++) e += samples[start + i] ** 2;
    if (e / frame < 1e-4) continue; // silence
    let best = 0;
    let lag = 0;
    for (let l = minLag; l <= maxLag; l++) {
      let sum = 0;
      for (let i = 0; i < frame; i++) sum += samples[start + i] * samples[start + i + l];
      if (sum > best) [best, lag] = [sum, l];
    }
    if (lag && best / e > 0.5) pitches.push(rate / lag);
  }
  pitches.sort((a, b) => a - b);
  return { pitch_hz: pitches.length >= 5 ? Math.round(pitches[Math.floor(pitches.length / 2)]) : null, level_db: Math.round(level * 10) / 10 };
}

// ---------- the cost guard ----------

export type CostEstimate = { presenter: string; presenter_seconds: number; usd: { presenter: number; images: number; audio: number; graphics: number; vision: number; total: number } };

/**
 * What a remake will cost before anything is paid for: the presenter by billed seconds (each take
 * padded to its shortest clip), about 1.5 twin frames per take, the personas still to make,
 * filmed-screen plates, the audio, the graphics and the vision calls.
 */
export function estimateCost(layers: CloneLayer[], price: { name: string; perSecond: number; minSeconds: number }, extras: { personas: number; graphics: number; plates: number; padSeconds?: number }): CostEstimate {
  const clones = layers.filter((l) => l.kind === "clone");
  const takes = clones.flatMap((l) => l.takes);
  // Billed per render: a chunk (or a take, before chunking), padded to the shortest clip, plus the extra second asked for.
  const renders: Array<{ start: number; end: number }> = clones.flatMap((l): Array<{ start: number; end: number }> => (l.chunks.length ? l.chunks : l.takes));
  const presenter_seconds = round(renders.reduce((sum, r) => sum + Math.max(price.minSeconds, Math.ceil(r.end - r.start + (extras.padSeconds ?? 0))), 0), 2);
  const presenter = presenter_seconds * price.perSecond;
  const framed = renders.length || takes.length;
  const images = (framed * 1.5 + extras.personas + extras.plates * 2) * PRICES.image;
  const graphics = extras.graphics * PRICES.graphic;
  const vision = (2 + framed * 1.5 + layers.filter((l) => l.kind === "screen").length * 2) * PRICES.vision;
  const usd = { presenter, images, audio: PRICES.audio, graphics, vision, total: 0 };
  usd.total = presenter + images + usd.audio + graphics + vision;
  return { presenter: price.name, presenter_seconds, usd: Object.fromEntries(Object.entries(usd).map(([k, v]) => [k, Math.round(v * 100) / 100])) as CostEstimate["usd"] };
}

// ---------- prompts ----------

const noun = (gender: Gender | null) => (gender === "female" ? "woman" : gender === "male" ? "man" : "person");
const their = (gender: Gender | null) => (gender === "female" ? "her" : gender === "male" ? "his" : "their");

/** Flat chroma green the cut-outs are rendered on (the key samples the clip's own corners anyway). */
export const GREEN = "#00B140";

/**
 * The image edit that makes a twin frame: image 1 is the reference frame (cropped to the layer),
 * image 2 our persona. Same crop, pose, size and place; the persona instead of the person; every
 * edited-in overlay gone. A cut-out is made on flat green instead of its background.
 */
export function twinPrompt(input: { look: string; gender: Gender | null; set: string; green: boolean; blanked?: boolean; fix?: string }): string {
  const who = noun(input.gender);
  const look = lookOnly(input.look) || input.look;
  const pose = "exactly the same position, size, pose, gesture, expression and head angle, cut off by the frame's edges in the same way, holding the same objects";
  return [
    input.green
      ? `Recreate the person in image 1 exactly: the same crop and framing, and ${pose}.`
      : `Recreate image 1 exactly: the same crop and framing, ${input.set ? `the same background (${lookOnly(input.set) || input.set})` : "the same background"}, the same lighting and camera angle, and one person in ${pose}.`,
    `Replace that person with the ${who} from image 2: ${their(input.gender)} face, hair, skin and build (${look}), in plain clothes with no text or logo.`,
    input.green
      ? `Replace everything behind the ${who} with one flat, evenly lit chroma-key green (${GREEN}) from edge to edge, like a green screen: no room, no screen, no furniture, no shadow on the green, and nothing green on the ${who}.`
      : `Remove everything laid over the footage in editing: captions, words, stickers, emoji, cards and pictures${input.blanked ? ", and the small cut-out of another person in the corner" : ""}; where they were, the background continues.`,
    "Photorealistic, natural skin texture, nothing written anywhere.",
    input.fix ? `A reviewer rejected the previous version. Fix exactly this: ${input.fix}` : "",
  ]
    .filter(Boolean)
    .join(" ");
}

/** What the gate is told when the frame is meant to be on green, not on the reference's background. */
export const GREEN_GATE = "This frame is a cut-out: its background is meant to be one flat chroma-key green instead of the reference's background. Judge the person's pose, position, size and crop against the reference, and fail any background that is not flat green.";

// ---------- ffmpeg ----------

export async function ffmpegBin(): Promise<string> {
  const bin = await editFfmpeg();
  if (!bin) throw new Error("No ffmpeg with libass found: install the ffmpeg-static package or set FFMPEG_PATH to an ffmpeg built with libass.");
  return bin;
}

export async function ffmpeg(args: string[], options: { cwd?: string } = {}) {
  try {
    await exec(await ffmpegBin(), args, { cwd: options.cwd, maxBuffer: 64 * 1024 * 1024 });
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr?.trim();
    throw new Error(`remake: ffmpeg failed${stderr ? `: ${stderr.slice(-1500)}` : ""}`);
  }
}

/** One frame of a video (or an image, `at` null) as a JPEG `width` px wide, optionally cropped first. */
export async function grabJpeg(path: string, at: number | null, width = 540, crop?: Rect): Promise<Buffer> {
  const args = ["-hide_banner", "-loglevel", "error"];
  if (at !== null) args.push("-ss", fmt(at));
  const vf = [crop ? `crop=${crop.width}:${crop.height}:${crop.x}:${crop.y}` : "", `scale=${width}:-2`].filter(Boolean).join(",");
  args.push("-i", path, "-frames:v", "1", "-vf", vf, "-q:v", "4", "-f", "mjpeg", "pipe:1");
  const { stdout } = await exec(await ffmpegBin(), args, { encoding: "buffer", maxBuffer: 32 * 1024 * 1024 });
  return stdout as unknown as Buffer;
}

/** One frame as raw grey pixels `width` px wide (cropped first), for the cut check. */
export async function grabGrey(path: string, at: number, width: number, height: number, crop: Rect): Promise<Uint8Array> {
  const { stdout } = await exec(
    await ffmpegBin(),
    ["-hide_banner", "-loglevel", "error", "-ss", fmt(Math.max(0, at)), "-i", path, "-frames:v", "1", "-vf", `crop=${crop.width}:${crop.height}:${crop.x}:${crop.y},scale=${width}:${height},format=gray`, "-f", "rawvideo", "pipe:1"],
    { encoding: "buffer", maxBuffer: 8 * 1024 * 1024 },
  );
  return new Uint8Array(stdout as unknown as Buffer);
}

/** A stage rect in the reference's own pixels. */
export function toReference(rect: Rect, stage: Stage, reference: { width: number; height: number }, out = { width: 1080, height: 1920 }): Rect {
  const sx = reference.width / out.width;
  const sy = reference.height / out.height;
  const x = Math.round((stage.x + rect.x) * sx);
  const y = Math.round((stage.y + rect.y) * sy);
  return { x, y, width: Math.min(reference.width - x, 2 * Math.round((rect.width * sx) / 2)), height: Math.min(reference.height - y, 2 * Math.round((rect.height * sy) / 2)) };
}

/** The reference frame a twin frame is made from: the layer's crop at `at`, as a PNG. */
export function frameArgs(input: { reference: string; at: number; crop: Rect; blank: Rect[]; out: string }): string[] {
  const blanks = input.blank.map((b) => `,drawbox=x=${b.x}:y=${b.y}:w=${b.width}:h=${b.height}:color=gray:t=fill`).join("");
  return ["-hide_banner", "-nostdin", "-loglevel", "error", "-y", "-ss", fmt(input.at), "-i", input.reference, "-frames:v", "1", "-vf", `crop=${input.crop.width}:${input.crop.height}:${input.crop.x}:${input.crop.y}${blanks},setsar=1`, input.out];
}

/**
 * The motion clip a motion-driven presenter copies: the take's footage, cropped like the twin
 * frame, with any second person blanked out, silent, held on its last frame up to `minSeconds`.
 */
export function motionClipArgs(input: { reference: string; start: number; seconds: number; crop: Rect; blank: Rect[]; minSeconds: number; out: string }): string[] {
  const pad = Math.max(0, input.minSeconds - input.seconds) + 0.05;
  const blanks = input.blank.map((b) => `,drawbox=x=${b.x}:y=${b.y}:w=${b.width}:h=${b.height}:color=gray:t=fill`).join("");
  const width = Math.min(1080, even(input.crop.width));
  return [
    "-hide_banner", "-nostdin", "-loglevel", "error", "-y", "-ss", fmt(input.start), "-t", fmt(input.seconds), "-i", input.reference,
    "-vf", `crop=${input.crop.width}:${input.crop.height}:${input.crop.x}:${input.crop.y}${blanks},scale=${width}:-2,setsar=1,fps=30,tpad=stop_mode=clone:stop_duration=${fmt(pad)},format=yuv420p`,
    "-an", "-c:v", "libx264", "-preset", "fast", "-crf", "16", input.out,
  ];
}

/** The key colour of a green-screen clip: the median of its four corners in the first frame, as 0xRRGGBB. */
export function cornerColor(rgb: Uint8Array, width: number, height: number, size = 6): string {
  const samples: Array<[number, number, number]> = [];
  for (const [cx, cy] of [
    [0, 0],
    [width - size, 0],
    [0, height - size],
    [width - size, height - size],
  ]) {
    for (let y = cy; y < cy + size; y++) for (let x = cx; x < cx + size; x++) samples.push([rgb[(y * width + x) * 3], rgb[(y * width + x) * 3 + 1], rgb[(y * width + x) * 3 + 2]]);
  }
  const median = (k: 0 | 1 | 2) => samples.map((s) => s[k]).sort((a, b) => a - b)[Math.floor(samples.length / 2)] ?? 0;
  const [r, g, b] = [median(0), median(1), median(2)];
  // Not green at all (the model ignored the instruction): key the house green and let QC say so.
  if (!(g > r + 30 && g > b + 30)) return `0x${GREEN.slice(1)}`;
  return `0x${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`.toUpperCase().replace("0X", "0x");
}

/**
 * The filter that cuts a green-screen clip out: chroma key tight around its own green, then a light
 * green-spill pull. Looser settings (similarity 0.16, blend 0.08, despill 0.6) made her cream sweater
 * half see-through and turned brown hair grey on the Jordan remake's screen walkthrough.
 */
export const keyFilter = (color: string) => `chromakey=color=${color}:similarity=0.10:blend=0.04,despill=type=green:mix=0.3:expand=0`;

// ---------- the filmed monitor ----------

export type QuadKey = { t: number; quad: Quad };

const QUAD_TOOL = {
  name: "screen_corners",
  description: "Record where the lit display of the computer monitor is in each frame.",
  input_schema: {
    type: "object",
    required: ["frames"],
    properties: {
      frames: {
        type: "array",
        items: {
          type: "object",
          required: ["t", "visible"],
          properties: {
            t: { type: "number", description: "The frame's time label, in seconds." },
            visible: { type: "boolean", description: "Whether the monitor's display is in the frame." },
            corners: {
              type: "array",
              description: "The display's four corners (the picture inside the bezel), clockwise from top-left: top-left, top-right, bottom-right, bottom-left, each [x, y] as fractions 0-1 of the frame. A corner outside the frame may go below 0 or above 1.",
              items: { type: "array", items: { type: "number" } },
            },
          },
        },
      },
    },
  },
};

/** The corners the vision model read, in stage pixels, keeping only plausible displays. */
export function parseQuads(raw: unknown, size: { width: number; height: number }): QuadKey[] {
  const frames = Array.isArray((raw as { frames?: unknown })?.frames) ? ((raw as { frames: unknown[] }).frames as Array<Record<string, unknown>>) : [];
  const keys: QuadKey[] = [];
  for (const f of frames) {
    const t = Number(f.t);
    const corners = Array.isArray(f.corners) ? (f.corners as unknown[]) : [];
    if (f.visible === false || !Number.isFinite(t) || corners.length !== 4) continue;
    const points = corners.map((c) => (Array.isArray(c) ? { x: Number(c[0]) * size.width, y: Number(c[1]) * size.height } : { x: NaN, y: NaN }));
    if (points.some((p) => !Number.isFinite(p.x) || !Number.isFinite(p.y))) continue;
    keys.push({ t: round(t, 3), quad: points as Quad });
  }
  return keys.sort((a, b) => a.t - b.t);
}

function quadArea(q: Quad): number {
  let sum = 0;
  q.forEach((p, i) => {
    const r = q[(i + 1) % 4];
    sum += p.x * r.y - r.x * p.y;
  });
  return sum / 2;
}

const centre = (q: Quad) => ({ x: q.reduce((s, p) => s + p.x, 0) / 4, y: q.reduce((s, p) => s + p.y, 0) / 4 });

/**
 * Whether the tracked corners can carry the warp: most sampled frames have a display, each one a
 * clockwise convex quad of a real size, and it moves like a hand-held phone between samples (no
 * jumps outside the reference's own cuts). When they cannot, the plate (filmed_screen) is used.
 */
export function quadsUsable(keys: QuadKey[], sampled: number, size: { width: number; height: number }, cuts: number[] = []): { ok: boolean; reason: string } {
  if (sampled === 0 || keys.length < Math.max(2, Math.ceil(sampled * 0.6))) return { ok: false, reason: `the display was found in ${keys.length} of ${sampled} frames` };
  const stage = size.width * size.height;
  for (const { t, quad } of keys) {
    const area = quadArea(quad);
    if (area <= 0) return { ok: false, reason: `the corners at ${t} s are not clockwise` };
    if (area < 0.05 * stage) return { ok: false, reason: `the display at ${t} s is too small to carry a screen` };
    const turns = quad.map((p, i) => {
      const a = quad[(i + 1) % 4];
      const b = quad[(i + 2) % 4];
      return (a.x - p.x) * (b.y - a.y) - (a.y - p.y) * (b.x - a.x);
    });
    if (turns.some((z) => z <= 0)) return { ok: false, reason: `the corners at ${t} s are not a convex screen` };
  }
  for (let i = 1; i < keys.length; i++) {
    const [a, b] = [keys[i - 1], keys[i]];
    if (cuts.some((c) => c > a.t && c <= b.t)) continue;
    const ratio = quadArea(b.quad) / quadArea(a.quad);
    const move = Math.hypot(centre(b.quad).x - centre(a.quad).x, centre(b.quad).y - centre(a.quad).y) / size.width;
    if (ratio < 0.6 || ratio > 1.65 || move > 0.25 * Math.max(0.5, b.t - a.t)) return { ok: false, reason: `the display jumps between ${a.t} s and ${b.t} s` };
  }
  return { ok: true, reason: "" };
}

/**
 * A piecewise-linear expression in ffmpeg's frame counter `on` (from 1) through `points`
 * (frame, value). Before the first point it holds the first value, after the last the last.
 */
export function piecewise(points: Array<{ frame: number; value: number }>): string {
  const p = [...points].sort((a, b) => a.frame - b.frame);
  if (!p.length) return "0";
  let expr = fmt(p[p.length - 1].value);
  for (let i = p.length - 2; i >= 0; i--) {
    const [a, b] = [p[i], p[i + 1]];
    const span = b.frame - a.frame;
    const piece = span <= 0 ? fmt(b.value) : `${fmt(a.value)}+${fmt(b.value - a.value)}*(on-${fmt(a.frame)})/${fmt(span)}`;
    expr = `if(lt(on,${fmt(b.frame)}),${piece},${expr})`;
  }
  return `if(lt(on,${fmt(p[0].frame)}),${fmt(p[0].value)},${expr})`;
}

/**
 * The corner keys a segment's warp follows, in its own frames: one per sample, and at each of the
 * reference's cuts the corners jump (the last key before and the first after sit one frame apart).
 */
export function warpKeys(keys: QuadKey[], segmentStart: number, fps = 30, cuts: number[] = []): Array<{ frame: number; quad: Quad }> {
  const frameOf = (t: number) => 1 + Math.round((t - segmentStart) * fps);
  const out: Array<{ frame: number; quad: Quad }> = [];
  keys.forEach((key, i) => {
    const next = keys[i + 1];
    out.push({ frame: frameOf(key.t), quad: key.quad });
    const cut = next ? cuts.find((c) => c > key.t && c <= next.t) : undefined;
    if (cut !== undefined) out.push({ frame: frameOf(cut) - 1, quad: key.quad });
  });
  return out.filter((k, i) => i === 0 || k.frame > out[i - 1].frame);
}

/** perspective options putting a full frame's corners on the tracked quad, per frame (sense=destination). */
export function warpOptions(keys: Array<{ frame: number; quad: Quad }>, grow = 2): string {
  // Order for perspective: top-left, top-right, bottom-left, bottom-right. Quads are TL, TR, BR, BL.
  const order = [0, 1, 3, 2];
  const parts: string[] = [];
  order.forEach((corner, i) => {
    for (const axis of ["x", "y"] as const) {
      const points = keys.map((k) => {
        const c = centre(k.quad);
        const p = k.quad[corner];
        const d = Math.hypot(p.x - c.x, p.y - c.y) || 1;
        return { frame: k.frame, value: p[axis] + ((p[axis] - c[axis]) / d) * grow };
      });
      parts.push(`${axis}${i}='${piecewise(points)}'`);
    }
  });
  return [...parts, "sense=destination", "interpolation=linear", "eval=frame"].join(":");
}

/**
 * The tracked filmed monitor for one segment (stage size, silent):
 *
 *   the reference footage ─ the host's old cut-out blurred in place (ours covers it)
 *     └─ our screens (cut together, stretched to the frame, a 2 px black border)
 *          ─ perspective per frame onto the tracked corners; a white frame warped the same way
 *            is the mask (the black border keeps everything outside the display at zero)
 *               └─ laid over the footage: the bezel and the room are the reference's own
 */
export function trackedScreenArgs(input: {
  reference: string;
  start: number;
  seconds: number;
  crop: Rect;
  size: { width: number; height: number };
  screen: string;
  keys: Array<{ frame: number; quad: Quad }>;
  cover: Rect[];
  out: string;
}): string[] {
  const { width: W, height: H } = input.size;
  const frames = Math.max(1, Math.round(input.seconds * 30));
  const warp = warpOptions(input.keys);
  const graph = [
    `[0:v]crop=${input.crop.width}:${input.crop.height}:${input.crop.x}:${input.crop.y},scale=${W}:${H}:flags=lanczos,setsar=1,fps=30,trim=end_frame=${frames},setpts=PTS-STARTPTS[f0]`,
  ];
  input.cover.forEach((r, i) => {
    // Blurred in place (no colour change, which shows as a box): our cut-out covers the middle.
    graph.push(`[f${i}]split[f${i}a][f${i}b]`, `[f${i}b]crop=${r.width}:${r.height}:${r.x}:${r.y},boxblur=28:3[c${i}]`, `[f${i}a][c${i}]overlay=${r.x}:${r.y}[f${i + 1}]`);
  });
  const base = `f${input.cover.length}`;
  graph.push(
    `[1:v]scale=${W - 4}:${H - 4}:flags=lanczos,setsar=1,fps=30,pad=${W}:${H}:2:2:black,tpad=stop_mode=clone:stop_duration=${fmt(input.seconds + 1)},trim=end_frame=${frames},setpts=PTS-STARTPTS,perspective=${warp},format=yuv420p[scr]`,
    `color=c=white:s=${W - 4}x${H - 4}:r=30:d=${fmt(input.seconds + 0.5)},pad=${W}:${H}:2:2:black,trim=end_frame=${frames},setpts=PTS-STARTPTS,perspective=${warp},format=gray[mask]`,
    `[scr][mask]alphamerge[warped]`,
    `[${base}][warped]overlay=0:0:format=auto,format=yuv420p[out]`,
  );
  return [
    "-hide_banner", "-nostdin", "-loglevel", "error", "-y",
    "-ss", fmt(input.start), "-t", fmt(input.seconds + 0.2), "-i", input.reference,
    "-i", input.screen,
    "-filter_complex", graph.join(";"), "-map", "[out]", "-an", "-c:v", "libx264", "-preset", "medium", "-crf", "17", "-pix_fmt", "yuv420p", input.out,
  ];
}

/** Asks the vision model for the display's corners in sampled frames of a filmed-monitor segment. */
export async function readScreenCorners(naive: Pick<NaiveClient, "message">, frames: Array<{ t: number; jpeg: Buffer }>, model: string): Promise<unknown> {
  const content = [
    ...frames.flatMap(({ t, jpeg }) => [
      { type: "text", text: `t=${t.toFixed(2)} s` },
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: jpeg.toString("base64") } },
    ]),
    {
      type: "text",
      text: [
        "These frames are from a phone filming a computer monitor, each labelled with its time. For every frame, give the four corners of the monitor's lit display: the picture area inside the bezel, not the bezel or the stand.",
        "Corners clockwise from top-left (top-left, top-right, bottom-right, bottom-left), as [x, y] fractions of the frame, as exactly as you can: the screen content will be replaced by warping a new picture onto these corners. Ignore any person, caption or sticker laid over the footage; give the display's true corners even where something covers them.",
        "Call the screen_corners tool once.",
      ].join("\n"),
    },
  ];
  const reply = await naive.message({ model, max_tokens: 3000, messages: [{ role: "user", content }], tools: [QUAD_TOOL] });
  const call = reply.content.find((block) => block.type === "tool_use" && block.name === QUAD_TOOL.name);
  const raw = call?.input ?? extractJson(reply.content.map((block) => block.text ?? "").join("\n"));
  if (!raw) throw new ApiError("naive", 502, "corners_unreadable", "the screen-corner check returned nothing");
  return raw;
}

/** Times to read the corners at: about every half second, plus just either side of each cut, at most `max`. */
export function cornerTimes(span: { start: number; end: number }, cuts: number[], max = 12): number[] {
  const times = new Set<number>();
  const len = span.end - span.start;
  const step = Math.max(0.5, len / Math.max(1, max - 2 * cuts.length - 1));
  for (let t = span.start + 0.05; t < span.end - 0.02; t += step) times.add(round(t, 2));
  times.add(round(span.end - 0.06, 2));
  for (const c of cuts) {
    if (c <= span.start || c >= span.end) continue;
    times.add(round(c - 0.07, 2));
    times.add(round(c + 0.05, 2));
  }
  const sorted = [...times].filter((t) => t >= span.start && t < span.end).sort((a, b) => a - b);
  if (sorted.length <= max) return sorted;
  return Array.from({ length: max }, (_, i) => sorted[Math.round((i * (sorted.length - 1)) / (max - 1))]);
}

/** Whether a file is there. */
export const present = (path: string | null | undefined): path is string => Boolean(path && existsSync(path));
