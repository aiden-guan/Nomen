import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ffmpegPath, probe } from "../media";

const exec = promisify(execFile);

// Video models render 4, 6 or 8 seconds, so a 6.5 s line arrives in an 8 s clip with dead air at
// the end (and often a beat of silence at the start). Real UGC is cut tight: trim it off.

const NOISE = "-32dB";
const MIN_SILENCE = 0.35;
/** Breathing room kept around the speech. */
const LEAD = 0.12;
const TAIL = 0.3;

/** Silent stretches in a clip's audio, from ffmpeg's silencedetect. */
export function parseSilences(stderr: string, duration: number): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = [];
  let open: number | null = null;
  for (const line of stderr.split("\n")) {
    const start = line.match(/silence_start: (-?[\d.]+)/);
    const end = line.match(/silence_end: ([\d.]+)/);
    if (start) open = Math.max(0, Number(start[1]));
    if (end && open !== null) {
      out.push({ start: open, end: Number(end[1]) });
      open = null;
    }
  }
  if (open !== null) out.push({ start: open, end: duration });
  return out;
}

/** Where the speech starts and ends, or null when the clip has no clear speech to trim around. */
export function speechWindow(silences: Array<{ start: number; end: number }>, duration: number): { from: number; to: number } | null {
  if (duration <= 0) return null;
  const leading = silences.find((s) => s.start <= 0.05);
  const trailing = [...silences].reverse().find((s) => s.end >= duration - 0.05);
  const from = leading ? Math.max(0, leading.end - LEAD) : 0;
  const to = trailing ? Math.min(duration, trailing.start + TAIL) : duration;
  if (to - from < 1) return null; // all silence, or nothing worth keeping: leave the clip alone
  if (from < 0.2 && duration - to < 0.25) return null; // already tight
  return { from, to };
}

/**
 * A copy of the clip with the silence before and after the speech cut off. Returns the original
 * path (and length) when there is nothing to trim or ffmpeg is unavailable.
 */
export async function trimSilence(path: string, out: string): Promise<{ path: string; duration: number }> {
  const bin = await ffmpegPath();
  const { duration, hasAudio } = await probe(path);
  if (!bin || !hasAudio) return { path, duration };
  const { stderr } = await exec(bin, ["-hide_banner", "-nostats", "-i", path, "-af", `silencedetect=noise=${NOISE}:d=${MIN_SILENCE}`, "-f", "null", "-"], { maxBuffer: 8 * 1024 * 1024 }).catch(
    (error: { stderr?: string }) => ({ stderr: error.stderr ?? "" }),
  );
  const window = speechWindow(parseSilences(stderr, duration), duration);
  if (!window) return { path, duration };
  await exec(bin, [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-ss",
    window.from.toFixed(3),
    "-i",
    path,
    "-t",
    (window.to - window.from).toFixed(3),
    "-c:v",
    "libx264",
    "-preset",
    "fast",
    "-crf",
    "16",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    out,
  ]);
  return { path: out, duration: (await probe(out)).duration };
}
