// The edit engine: cuts an EditTimeline into a finished 1080x1920 vertical video in one ffmpeg pass.
//
//   A-roll clips ─ cover-fit, concat ──────────────┐ (the base track; black when there is no A-roll)
//   split segments ─ A-roll top half over the base ─┤
//   B-roll images/videos ─ motion, overlaid in time ┤
//   captions + overlays ─ ASS file, burned by libass ┴─► H.264 + AAC, +faststart
//
// The soundtrack (A-roll audio, or `timeline.audio`) runs untouched under every cutaway, so a
// B-roll segment is a classic J-cut: the creator keeps talking while the product fills the screen.
//
// Motion on still images is done with ffmpeg's `perspective` filter evaluated per frame. It
// samples the source at 1/256-pixel precision with bicubic interpolation, so slow Ken Burns zooms
// and drifts glide instead of stepping a whole pixel at a time the way `zoompan` (integer crop
// offsets) and `crop` with time expressions do. Zooms and pans run on a canvas supersampled 1.5x
// and are scaled down afterwards, which keeps them sharp; scrolls of tall screenshots crop to the
// current even pixel and use `perspective` only for the sub-pixel remainder, so they stay cheap.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

import { probe } from "../media";
import { parseFontMetrics, toAss, type FontMetrics } from "./captions";
import type { BRollClip, EditTimeline } from "./types";

const exec = promisify(execFile);

export const OUTPUT = { width: 1080, height: 1920, fps: 30 } as const;

/** The bundled caption font (SIL OFL, see assets/fonts/OFL.txt). */
export const DEFAULT_FONT = join(process.cwd(), "assets", "fonts", "Poppins-ExtraBold.ttf");

/** Ken Burns zoom amount (10%). */
const ZOOM = 0.1;
/** Supersampling for zooms and pans. */
const SUPERSAMPLE = 1.5;
/** Fastest scroll, in frame heights per second (0.36 x 1920 = about 690 px/s at full screen). */
const MAX_SCROLL = 0.36;
/** A screenshot must be at least this much taller than the frame to scroll; otherwise it zooms. */
const MIN_SCROLL_RATIO = 1.15;
/**
 * Cover-fit a wide image only if it keeps at least this share of its width; otherwise show it whole
 * across the width, over a blurred copy of itself. Full screen tolerates big crops (a square product
 * shot keeps 56%) because fitting would leave most of the frame blurred; the near-square split panel
 * fits instead, since the blurred bars stay thin and a cropped screenshot loses words.
 */
const minVisible = (split: boolean) => (split ? 0.75 : 0.5);
/**
 * Split screen: where the 960 px window into the A-roll starts, as a fraction of its height. Not a
 * true centre crop (0.25): in vertical talking-head footage the face sits at about 25-45% of the
 * height (see samples/monid), so a centre crop slices through the forehead; 12-62% keeps the face.
 */
const SPLIT_AROLL_TOP = 0.12;

// ---------- ffmpeg ----------

let editBinary: Promise<string | null> | undefined;

/**
 * The ffmpeg used for editing: the first of FFMPEG_PATH, the bundled ffmpeg-static binary and the
 * system `ffmpeg` that has libass (`subtitles`/`ass`) and `perspective`. Homebrew's default ffmpeg
 * lacks libass, which is why this differs from media.ts's ffmpegPath(). Cached; null if none has it.
 */
export function editFfmpeg(): Promise<string | null> {
  return (editBinary ??= findEditFfmpeg());
}

async function findEditFfmpeg(): Promise<string | null> {
  const candidates: string[] = [];
  if (process.env.FFMPEG_PATH) candidates.push(process.env.FFMPEG_PATH);
  try {
    const mod = (await import("ffmpeg-static")) as unknown as { default?: string } | string;
    const path = typeof mod === "string" ? mod : mod.default;
    if (path && existsSync(path)) candidates.push(path);
  } catch {
    // optional dependency not installed
  }
  candidates.push("ffmpeg");
  for (const bin of candidates) {
    try {
      const { stdout } = await exec(bin, ["-hide_banner", "-filters"], { maxBuffer: 16 * 1024 * 1024 });
      const has = (name: string) => new RegExp(`^\\s*\\S+\\s+${name}\\s`, "m").test(stdout);
      if (has("subtitles") && has("ass") && has("perspective")) return bin;
    } catch {
      // not runnable; try the next one
    }
  }
  return null;
}

// ---------- fonts ----------

const metricsCache = new Map<string, Promise<FontMetrics>>();

/** Metrics of a font file (cached), used to size the overlay box. */
export function fontMetrics(path = DEFAULT_FONT): Promise<FontMetrics> {
  const key = resolve(path);
  let cached = metricsCache.get(key);
  if (!cached) {
    cached = readFile(key).then((bytes) => parseFontMetrics(bytes));
    cached.catch(() => metricsCache.delete(key));
    metricsCache.set(key, cached);
  }
  return cached;
}

// ---------- planning ----------

type Motion = BRollClip["motion"];
type Visual = { start: number; end: number; split: boolean; inset?: boolean; path: string; kind: "image" | "video"; motion: Motion };

/** The presenter window in inset segments: a rounded portrait window centred low, under the captions. */
export const INSET = { width: 380, height: 500, radius: 40, centerY: 0.775 } as const;

const fps = OUTPUT.fps;
const snap = (t: number) => Math.round(t * fps) / fps;
const num = (x: number) => String(Math.round(x * 10000) / 10000);
const even = (x: number) => Math.max(2, 2 * Math.round(x / 2));

/** What fills the screen over time, clamped to [0, duration] and snapped to the frame grid. */
function planVisuals(timeline: EditTimeline, duration: number, hasARoll: boolean): Visual[] {
  const visuals: Visual[] = [];
  for (const segment of timeline.segments) {
    if (segment.layer === "aroll" || !segment.broll) continue;
    const start = snap(Math.max(0, segment.start));
    const end = snap(Math.min(duration, segment.end));
    if (!(end > start)) continue;
    visuals.push({ start, end, split: segment.layer === "split" && hasARoll, inset: segment.layer === "inset" && hasARoll, ...segment.broll });
  }
  visuals.sort((a, b) => a.start - b.start);
  if (!hasARoll && visuals.length) {
    // No creator to cut back to: each visual holds (and keeps moving) until the next one starts,
    // and the first one starts at 0, so a voice-over never shows a black frame between visuals.
    visuals[0].start = 0;
    visuals.forEach((v, i) => {
      const next = visuals[i + 1];
      const until = next ? next.start : duration;
      if (until > v.end) v.end = until;
    });
  }
  return visuals;
}

/** Linear progress 0 -> 1 over a segment of `frames` frames, for `perspective` (`on` counts from 1). */
const progress = (frames: number) => `min(1,(on-1)/${Math.max(1, frames - 1)})`;
const smoothstep = (p: string) => `(${p})*(${p})*(3-2*(${p}))`;

/** perspective options mapping the viewport (x, y, w; height follows the canvas aspect) onto the canvas. */
function viewport(x: string, y: string, w: string): string {
  // Output pixel (u, v) samples source (x + u*w/W, y + v*w/W): a pure scale-and-translate. The
  // canvas keeps its size, so when the viewport is a different shape than the canvas, the wanted
  // picture is the top-left part of the result, cropped right after.
  const y2 = `(${y})+H*(${w})/W`;
  return [
    `x0='${x}'`,
    `y0='${y}'`,
    `x1='(${x})+(${w})'`,
    `y1='${y}'`,
    `x2='${x}'`,
    `y2='${y2}'`,
    `x3='(${x})+(${w})'`,
    `y3='${y2}'`,
    "interpolation=cubic",
    "eval=frame",
  ].join(":");
}

type ImageInfo = { width: number; height: number };

/**
 * Filter chains turning one decoded image (a single frame) into `frames` frames of `ow` x `oh` with
 * motion, timestamped from `startFrame`, ending in the label `out`. `id` keeps internal labels unique.
 */
function imageChain(
  input: string,
  out: string,
  v: Visual,
  info: ImageInfo,
  ow: number,
  oh: number,
  frames: number,
  startFrame: number,
  id: string,
): string[] {
  const chains: string[] = [];
  // First frame only (an animated GIF would otherwise keep going), with transparency flattened
  // onto white at the image's own size (lutrgb makes an opaque white copy to overlay it on).
  chains.push(`[${input}]trim=end_frame=1,format=rgba,split[${id}a][${id}b]`, `[${id}a]lutrgb=r=255:g=255:b=255:a=255[${id}w]`);
  chains.push(`[${id}w][${id}b]overlay=format=rgb:shortest=1,format=yuv444p[${id}f]`);
  const loop = `loop=loop=${frames - 1}:size=1:start=0,settb=1/${fps},setpts=N+${startFrame}`;
  const aspect = info.width > 0 && info.height > 0 ? info.width / info.height : ow / oh;
  const target = ow / oh;
  let motion = v.motion;

  // Tall screenshot scrolling down: fit the width, scroll the visited part.
  if (motion === "scroll_down") {
    const scaledH = even((ow * info.height) / Math.max(1, info.width));
    const seconds = frames / fps;
    const travel = Math.min(scaledH - oh - 4, MAX_SCROLL * oh * seconds);
    if (info.width > 0 && scaledH >= oh * MIN_SCROLL_RATIO && travel >= 8) {
      const t = Math.floor(travel);
      // Crop to the even pixel row at or above the eased target (a cheap pointer offset), then
      // shift the remaining 0-2 px with perspective so the scroll follows the curve exactly.
      // crop's `n` counts frames from 0, perspective's `on` from 1.
      const yAt = (frame: string) => `${t}*${smoothstep(`min(1,(${frame})/${Math.max(1, frames - 1)})`)}`;
      const cropY = `2*floor(${yAt("n")}/2)`;
      const frac = `${yAt("on-1")}-2*floor(${yAt("on-1")}/2)`;
      chains.push(
        `[${id}f]scale=${ow}:${scaledH}:flags=lanczos,crop=${ow}:${t + oh + 4}:0:0,format=yuv420p,setsar=1,${loop},` +
          `crop=${ow}:${oh + 4}:0:'${cropY}',` +
          `perspective=${viewport("0", frac, "W")},crop=${ow}:${oh}:0:0[${out}]`,
      );
      return chains;
    }
    motion = "zoom_in";
  }

  const cw = even(ow * (motion === "none" ? 1 : SUPERSAMPLE));
  const ch = even(oh * (motion === "none" ? 1 : SUPERSAMPLE));
  const fit = aspect > target && target / aspect < minVisible(v.split);
  let zoom = ZOOM;
  if (fit) {
    // A wide image (a desktop screenshot, a banner) would lose most of its width to a cover crop:
    // show it whole across the width, over a heavily blurred, darkened cover-fit copy of itself.
    // A pan would push its edges off screen, so it gets a gentler zoom instead.
    chains.push(
      `[${id}f]split[${id}g][${id}h]`,
      `[${id}g]scale=${cw}:${ch}:force_original_aspect_ratio=increase,crop=${cw}:${ch},gblur=sigma=${Math.round(cw / 14)}:steps=2,eq=brightness=-0.12:saturation=1.1[${id}bg]`,
      `[${id}h]scale=${cw}:-2:flags=lanczos[${id}fg]`,
      `[${id}bg][${id}fg]overlay=(W-w)/2:(H-h)/2[${id}c]`,
    );
    if (motion === "pan_left" || motion === "pan_right") motion = "zoom_in";
    zoom = ZOOM / 2;
  } else {
    chains.push(`[${id}f]scale=${cw}:${ch}:force_original_aspect_ratio=increase:flags=lanczos,crop=${cw}:${ch}[${id}c]`);
  }

  const tail = `format=yuv420p,setsar=1,${loop}`;
  if (motion === "none") {
    chains.push(`[${id}c]${tail}[${out}]`);
    return chains;
  }
  const p = progress(frames);
  let persp: string;
  if (motion === "zoom_in" || motion === "zoom_out") {
    const z = motion === "zoom_in" ? `(1+${zoom}*${p})` : `(1+${zoom}*(1-${p}))`;
    persp = viewport(`(W-W/${z})/2`, `(H-H/${z})/2`, `W/${z}`);
  } else {
    // pan_left: the view travels toward the image's left edge (the picture slides right);
    // pan_right: the opposite. Zoomed in 10% so there is room to travel.
    const z = 1 + zoom;
    const along = motion === "pan_left" ? `(1-${p})` : p;
    persp = viewport(`(W-W/${z})*${along}`, `(H-H/${z})/2`, `W/${z}`);
  }
  chains.push(`[${id}c]${tail},perspective=${persp},scale=${ow}:${oh}:flags=bicubic[${out}]`);
  return chains;
}

/**
 * Filters turning a video B-roll input into `frames` frames of `ow` x `oh`, cover-fit. A clip shorter
 * than its segment holds its last frame: built screens end on their finished state, and a demo that
 * jumps back to its first frame mid-sentence looks broken.
 */
function videoChain(
  input: string,
  out: string,
  v: Visual,
  info: ImageInfo,
  ow: number,
  oh: number,
  frames: number,
  startFrame: number,
  id: string,
): string[] {
  const aspect = info.width > 0 && info.height > 0 ? info.width / info.height : ow / oh;
  const target = ow / oh;
  const head = `[${input}]setpts=PTS-STARTPTS,fps=${fps},tpad=stop_mode=clone:stop_duration=${num(frames / fps + 1)}`;
  const tail = `format=yuv420p,setsar=1,trim=end_frame=${frames},setpts=PTS-STARTPTS+${startFrame}[${out}]`;
  if (aspect > target && target / aspect < minVisible(v.split)) {
    return [
      `${head},split[${id}g][${id}h]`,
      `[${id}g]scale=${ow}:${oh}:force_original_aspect_ratio=increase,crop=${ow}:${oh},boxblur=24:2,eq=brightness=-0.08[${id}bg]`,
      `[${id}h]scale=${ow}:-2[${id}fg]`,
      `[${id}bg][${id}fg]overlay=(W-w)/2:(H-h)/2,${tail}`,
    ];
  }
  return [`${head},scale=${ow}:${oh}:force_original_aspect_ratio=increase:flags=lanczos,crop=${ow}:${oh},${tail}`];
}

// ---------- render ----------

export type RenderOptions = {
  /** Where temporary files go (a fresh subdirectory is made and removed). Defaults to the OS temp dir. */
  workDir?: string;
  /** A TTF/OTF to use for captions and overlays instead of the bundled Poppins ExtraBold. */
  fontPath?: string;
};

/**
 * Renders a timeline to `outPath`: 1080x1920, 30 fps, H.264 (crf 18, yuv420p) + AAC 48 kHz stereo
 * 192k, +faststart. Returns the output path.
 *
 * - Duration: `timeline.duration`, else the soundtrack's length (`audio`, else the A-roll's), else
 *   the last segment, caption or overlay. Audio is padded with silence or cut to match; the A-roll
 *   picture holds its last frame if the timeline runs longer than the clips.
 * - Gaps between segments show the A-roll. With no A-roll, each visual holds (still moving) until
 *   the next starts and the first starts at 0; a timeline with no visuals at all is black.
 * - `split` segments need A-roll; without it they are drawn full screen like `broll`.
 * - Images are cover-fit, except wide ones that would lose too much width (see minVisible), which
 *   are shown whole over a blurred copy. Transparent images are flattened onto white. `scroll_down`
 *   on an image that is not tall enough to scroll falls back to `zoom_in`.
 * - B-roll videos are cover-fit and hold their last frame when shorter than their segment; their
 *   `motion` is ignored and their own audio is never used.
 */
export async function renderTimeline(timeline: EditTimeline, outPath: string, options: RenderOptions = {}): Promise<string> {
  const bin = await editFfmpeg();
  if (!bin) throw new Error("No ffmpeg with libass found: install the ffmpeg-static package or set FFMPEG_PATH to an ffmpeg built with libass.");

  const out = resolve(outPath);
  const fontPath = resolve(options.fontPath ?? DEFAULT_FONT);
  const files = [...timeline.aroll.map((c) => c.path), ...(timeline.audio ? [timeline.audio.path] : []), fontPath];
  for (const segment of timeline.segments) if (segment.layer !== "aroll" && segment.broll) files.push(segment.broll.path);
  for (const file of files) if (!existsSync(resolve(file))) throw new Error(`edit: missing file ${file}`);

  const W = OUTPUT.width;
  const H = OUTPUT.height;
  const aroll = await Promise.all(timeline.aroll.map(async (clip) => ({ path: resolve(clip.path), ...(await probe(resolve(clip.path))) })));
  const audio = timeline.audio ? { path: resolve(timeline.audio.path), ...(await probe(resolve(timeline.audio.path))) } : null;
  const arollSeconds = aroll.reduce((sum, clip) => sum + clip.duration, 0);
  const soundtrack = audio ? audio.duration : arollSeconds;
  const content = Math.max(
    0,
    ...timeline.segments.map((s) => s.end),
    ...timeline.captions.map((c) => c.end),
    ...timeline.overlays.map((o) => o.end),
  );
  const wanted = timeline.duration ?? (soundtrack > 0 ? soundtrack : content);
  if (!(wanted > 0)) throw new Error("edit: the timeline has no duration (no soundtrack and nothing on it)");
  const frames = Math.max(1, Math.round(wanted * fps));
  const duration = frames / fps;
  const hasARoll = aroll.length > 0;
  const visuals = planVisuals(timeline, duration, hasARoll);
  const infos = await Promise.all(visuals.map((v) => probe(resolve(v.path))));

  const args = ["-hide_banner", "-nostdin", "-loglevel", "error", "-y"];
  let inputs = 0;
  const input = (...a: string[]) => {
    args.push(...a);
    return inputs++;
  };
  const graph: string[] = [];

  // A-roll: cover-fit each clip, concat (with its audio unless a separate soundtrack replaces it).
  const useARollAudio = hasARoll && !audio;
  if (hasARoll) {
    const parts: string[] = [];
    aroll.forEach((clip, i) => {
      const v = input("-i", clip.path);
      graph.push(`[${v}:v]scale=${W}:${H}:force_original_aspect_ratio=increase:flags=lanczos,crop=${W}:${H},setsar=1,fps=${fps},format=yuv420p[av${i}]`);
      if (useARollAudio) {
        const a = clip.hasAudio ? v : input("-f", "lavfi", "-t", String(clip.duration || 8), "-i", "anullsrc=r=48000:cl=stereo");
        graph.push(`[${a}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[aa${i}]`);
        parts.push(`[av${i}][aa${i}]`);
      } else parts.push(`[av${i}]`);
    });
    graph.push(`${parts.join("")}concat=n=${aroll.length}:v=1:a=${useARollAudio ? 1 : 0}${useARollAudio ? "[acv][aca]" : "[acv]"}`);
    graph.push(`[acv]fps=${fps},tpad=stop_mode=clone:stop_duration=${num(duration + 1)},trim=end_frame=${frames},setpts=PTS-STARTPTS[base0]`);
  } else {
    graph.push(`color=c=black:s=${W}x${H}:r=${fps}:d=${num(duration + 1)},format=yuv420p,setsar=1,trim=end_frame=${frames},setpts=PTS-STARTPTS[base0]`);
  }

  // Soundtrack.
  if (audio) {
    const a = input("-i", audio.path);
    graph.push(`[${a}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,apad,atrim=end=${num(duration)},asetpts=PTS-STARTPTS[aout]`);
  } else if (useARollAudio) {
    graph.push(`[aca]apad,atrim=end=${num(duration)},asetpts=PTS-STARTPTS[aout]`);
  } else {
    graph.push(`anullsrc=r=48000:cl=stereo,atrim=end=${num(duration)}[aout]`);
  }

  // Inset: keep a copy of the A-roll before any B-roll covers it, for the presenter window.
  const half = H / 2;
  let base = "base0";
  const insets = visuals.filter((v) => v.inset);
  if (insets.length) {
    graph.push(`[base0]split[base0x][ainsetsrc]`);
    base = "base0x";
  }
  const splits = visuals.filter((v) => v.split);
  if (splits.length) {
    const top = Math.round((H * SPLIT_AROLL_TOP) / 2) * 2;
    const enable = splits.map((v) => `between(t,${num(v.start - 0.5 / fps)},${num(v.end - 0.5 / fps)})`).join("+");
    graph.push(`[${base}]split[base0m][base0s]`, `[base0s]crop=${W}:${half}:0:${top}[atop]`);
    graph.push(`[base0m][atop]overlay=0:0:eof_action=pass:enable='${enable}'[base1]`);
    base = "base1";
  }

  // B-roll: each visual becomes a stream that starts at its segment and is overlaid while it lasts.
  visuals.forEach((v, k) => {
    const ow = W;
    const oh = v.split ? half : H;
    const n = Math.max(1, Math.round((v.end - v.start) * fps));
    const startFrame = Math.round(v.start * fps);
    const id = `b${k}`;
    if (v.kind === "video") {
      const i = input("-t", num(v.end - v.start + 1), "-i", resolve(v.path));
      graph.push(...videoChain(`${i}:v`, `${id}v`, v, infos[k], ow, oh, n, startFrame, id));
    } else {
      const i = input("-i", resolve(v.path));
      graph.push(...imageChain(`${i}:v`, `${id}v`, v, infos[k], ow, oh, n, startFrame, id));
    }
    const enable = `between(t,${num(v.start - 0.5 / fps)},${num(v.end - 0.5 / fps)})`;
    const next = `base${k + 2}`;
    graph.push(`[${base}][${id}v]overlay=0:${v.split ? half : 0}:eof_action=pass:enable='${enable}'[${next}]`);
    base = next;
  });

  // Presenter window: the face band of the A-roll, rounded, over the product graphics.
  if (insets.length) {
    const { width: iw, height: ih, radius: r } = INSET;
    const enable = insets.map((v) => `between(t,${num(v.start - 0.5 / fps)},${num(v.end - 0.5 / fps)})`).join("+");
    const cropH = even((W * ih) / iw);
    const cropTop = even(H * 0.08);
    graph.push(
      `[ainsetsrc]crop=${W}:${cropH}:0:${cropTop},scale=${iw}:${ih}:flags=lanczos,format=rgba[ainsetrgb]`,
      // A rounded-rectangle alpha mask, computed once per frame size (cheap at this size).
      `color=c=white:s=${iw}x${ih}:r=${fps}:d=${num(duration + 1)},format=gray,geq=lum='255*lte(hypot(max(0,abs(X-${iw / 2})-${iw / 2 - r}),max(0,abs(Y-${ih / 2})-${ih / 2 - r})),${r})'[insetmask]`,
      `[ainsetrgb][insetmask]alphamerge[ainset]`,
      `[${base}][ainset]overlay=(W-w)/2:${Math.round(H * INSET.centerY - ih / 2)}:eof_action=pass:enable='${enable}'[baseinset]`,
    );
    base = "baseinset";
  }

  const scratch = options.workDir ? resolve(options.workDir) : tmpdir();
  await mkdir(scratch, { recursive: true });
  await mkdir(dirname(out), { recursive: true });
  const work = await mkdtemp(join(scratch, "nomen-edit-"));
  try {
    // Captions and overlays: an ASS file and the font next to it, referenced by relative names
    // (ffmpeg runs in the work dir) so no path ever needs filtergraph escaping.
    const subtitles = timeline.captions.length > 0 || timeline.overlays.length > 0;
    if (subtitles) {
      const metrics = await fontMetrics(fontPath);
      await mkdir(join(work, "fonts"));
      await copyFile(fontPath, join(work, "fonts", basename(fontPath)));
      const ass = toAss(timeline, { width: W, height: H, metrics, splits: splits.map(({ start, end }) => ({ start, end })) });
      await writeFile(join(work, "captions.ass"), ass, "utf8");
      graph.push(`[${base}]ass=filename=captions.ass:fontsdir=fonts,format=yuv420p[vout]`);
    } else {
      graph.push(`[${base}]format=yuv420p[vout]`);
    }

    args.push("-filter_complex", graph.join(";"), "-map", "[vout]", "-map", "[aout]");
    args.push("-r", String(fps), "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p");
    args.push("-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2", "-movflags", "+faststart", out);
    try {
      await exec(bin, args, { cwd: work, maxBuffer: 64 * 1024 * 1024 });
    } catch (error) {
      const stderr = (error as { stderr?: string }).stderr?.trim();
      throw new Error(`edit: ffmpeg failed${stderr ? `: ${stderr.slice(-2000)}` : ""}`);
    }
    return out;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
