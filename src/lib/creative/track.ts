// The filmed display, tracked frame by frame (faceless remakes: a phone filming a monitor or laptop).
//
// The remake's filmed-monitor step keeps the reference's own footage and lays our product's screens
// into its display. Without help it warps between the vision model's corner reads (about one every
// second or two), so on hand-held footage our screen swims against the bezel. When OpenCV is set up
// (`npm run setup:stems` installs it next to Demucs, in data/tools/stems), scripts/track-screen.py
// does it properly:
//
//   one corner read per shot (the vision model)
//     └─ snapped onto the display's edges ─ optical flow and a homography per frame through the shot
//          └─ our screens warped in, matched to how the phone saw the display ─ the clip
//
// Everything here is local (no paid calls). Without OpenCV, or when the tracker fails, the remake
// falls back to the vision-keyed warp, then to the filmed_screen plate.

import { execFile, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import type { Rect } from "./clone";
import { stemsPython } from "./dub";
import type { Quad } from "./types";

const exec = promisify(execFile);
const round = (x: number, digits = 3) => Math.round(x * 10 ** digits) / 10 ** digits;

let cached: { cwd: string; python: string | null } | null = null;

/** A Python with OpenCV: NOMEN_TRACK_PYTHON, else the stems venv when it has cv2; null without one. */
export function trackerPython(cwd = process.cwd()): string | null {
  if (process.env.NOMEN_TRACKER === "off") return null;
  if (cached?.cwd === cwd) return cached.python;
  const candidates = [process.env.NOMEN_TRACK_PYTHON, stemsPython(cwd)].filter((p): p is string => Boolean(p && existsSync(p)));
  let python: string | null = null;
  for (const candidate of candidates) {
    try {
      execFileSync(candidate, ["-c", "import cv2, numpy"], { stdio: "ignore", timeout: 30_000 });
      python = candidate;
      break;
    } catch {
      // no OpenCV here
    }
  }
  cached = { cwd, python };
  return python;
}

/** The tracker script, next to the app's other scripts. */
export const TRACKER_SCRIPT = join(process.cwd(), "scripts", "track-screen.py");

/**
 * When to read the display's corners for the tracker: one read in every shot (a little after its
 * middle, away from the cut's blur), and one more every ~4 s in a long shot, at most `max` in all
 * (the longest shots lose their extras first, never their one read).
 */
export function shotReadTimes(span: { start: number; end: number }, cuts: number[], max = 24): number[] {
  const edges = [span.start, ...cuts.filter((c) => c > span.start + 0.2 && c < span.end - 0.2).sort((a, b) => a - b), span.end];
  const shots = edges.slice(1).map((end, i) => ({ start: edges[i], end }));
  const firsts = shots.map((s) => round(s.start + (s.end - s.start) * 0.55, 2));
  const extras = shots.flatMap((s) => {
    const len = s.end - s.start;
    const n = Math.floor(len / 4);
    return Array.from({ length: n }, (_, k) => ({ t: round(s.start + (len * (k + 1)) / (n + 1) + 0.13, 2), len }));
  });
  const room = Math.max(0, max - firsts.length);
  const kept = extras.sort((a, b) => a.len - b.len || a.t - b.t).slice(0, room).map((e) => e.t);
  return [...new Set([...firsts.slice(0, max), ...kept])].filter((t) => t > span.start && t < span.end).sort((a, b) => a - b);
}

/** Cuts the scene detector's softer setting finds: a filmed screen often cuts between shots of the same room. */
export const SOFT_CUT_THRESHOLD = 0.12;

export type TrackSpec = {
  ffmpeg: string;
  reference: string;
  /** The segment, in the reference's seconds. */
  start: number;
  seconds: number;
  /** The stage in the reference's own pixels. */
  crop: Rect;
  /** The stage in output pixels: the clip's size. */
  size: { width: number; height: number };
  /** Our screens cut together for the segment, and their size. */
  screen: string;
  screen_size: { width: number; height: number };
  /** The reference's cuts inside the segment (absolute seconds). */
  cuts: number[];
  /** The vision model's corner reads, in stage pixels, clockwise from top-left. */
  anchors: Array<{ t: number; quad: Quad }>;
  out: string;
  /** Where the reference has burned-in captions or labels, painted out of its footage (stage pixels, absolute seconds). */
  erase?: Array<Rect & { start: number; end: number }>;
  /** How far our screen takes on the reference display's black level, white point and tint (0-1). */
  match?: number;
  quads_out?: string;
};

export type TrackShot = { from: number; to: number; anchors: number; anchor?: number; sides_snapped?: number; inliers?: number | null; fallback?: string; residual_px?: number[] };
export type TrackReport = { ok: boolean; frames: number; shots: TrackShot[] };

/** The spec as the script reads it (corner points as [x, y] pairs). */
export function trackSpecJson(spec: TrackSpec): string {
  return JSON.stringify({ ...spec, anchors: spec.anchors.map((a) => ({ t: round(a.t, 3), quad: a.quad.map((p) => [round(p.x, 2), round(p.y, 2)]) })) });
}

/** Runs the tracker: the clip lands at `spec.out`; the report says how each shot went. */
export async function trackScreen(python: string, spec: TrackSpec, workDir: string): Promise<TrackReport> {
  const specPath = join(workDir, `track-${Date.now().toString(36)}.json`);
  await writeFile(specPath, trackSpecJson(spec), "utf8");
  try {
    const { stdout } = await exec(python, ["-I", "-B", TRACKER_SCRIPT, specPath], { maxBuffer: 16 * 1024 * 1024, timeout: 20 * 60_000 });
    const line = stdout.trim().split("\n").pop() ?? "";
    const report = JSON.parse(line) as TrackReport;
    if (!report.ok || !existsSync(spec.out)) throw new Error("the tracker wrote no clip");
    return report;
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr?.trim();
    throw new Error(`screen tracking failed${stderr ? `: ${stderr.slice(-600)}` : error instanceof Error ? `: ${error.message}` : ""}`);
  }
}

/** Whether a tracked shot leaned on the fallback (no flow): such a clip still plays, but less steady. */
export const shakyShots = (report: TrackReport) => report.shots.filter((s) => s.fallback).length;
