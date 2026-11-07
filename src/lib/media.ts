import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

/** Finished videos are kept here so review never depends on a provider's link still being valid. */
export const mediaDir = (creativeId: string) => join(process.cwd(), "data", "media", creativeId);

let ffmpeg: string | null | undefined;

/** System ffmpeg first, then the bundled ffmpeg-static binary, else null (no QC, no stitching). */
export async function ffmpegPath(): Promise<string | null> {
  if (ffmpeg !== undefined) return ffmpeg;
  for (const candidate of [process.env.FFMPEG_PATH, "ffmpeg"]) {
    if (!candidate) continue;
    try {
      await exec(candidate, ["-version"]);
      return (ffmpeg = candidate);
    } catch {
      // try the next one
    }
  }
  try {
    const mod = (await import("ffmpeg-static")) as unknown as { default?: string } | string;
    const path = typeof mod === "string" ? mod : mod.default;
    if (path && existsSync(path)) return (ffmpeg = path);
  } catch {
    // optional dependency not installed
  }
  return (ffmpeg = null);
}

export async function download(url: string, path: string) {
  const response = await fetch(url, { signal: AbortSignal.timeout(180_000) });
  if (!response.ok) throw new Error(`download failed: HTTP ${response.status}`);
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, Buffer.from(await response.arrayBuffer()));
  return path;
}

export async function probe(path: string): Promise<{ duration: number; hasAudio: boolean; width: number; height: number }> {
  const bin = await ffmpegPath();
  if (!bin) throw new Error("ffmpeg is not available");
  // `ffmpeg -i` with no output exits non-zero but prints the stream table on stderr.
  const stderr: string = await exec(bin, ["-hide_banner", "-i", path]).then(
    (r) => r.stderr,
    (error: { stderr?: string }) => error.stderr ?? "",
  );
  const d = stderr.match(/Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/);
  const size = stderr.match(/Video:.*?(\d{2,5})x(\d{2,5})/);
  return {
    duration: d ? Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]) : 0,
    hasAudio: /Stream #\d+:\d+.*Audio:/.test(stderr),
    width: size ? Number(size[1]) : 0,
    height: size ? Number(size[2]) : 0,
  };
}

/** Evenly spaced stills from a clip, as JPEG buffers small enough to send to a vision model. */
export async function extractFrames(path: string, count = 4): Promise<Buffer[]> {
  const bin = await ffmpegPath();
  if (!bin) throw new Error("ffmpeg is not available");
  const { duration } = await probe(path);
  const frames: Buffer[] = [];
  for (let i = 0; i < count; i++) {
    const at = Math.max(0, (duration || 8) * ((i + 0.5) / count));
    const out = `${path}.frame${i}.jpg`;
    await exec(bin, ["-hide_banner", "-loglevel", "error", "-y", "-ss", at.toFixed(2), "-i", path, "-frames:v", "1", "-vf", "scale=540:-2", "-q:v", "4", out]);
    frames.push(await readFile(out));
    await rm(out, { force: true });
  }
  return frames;
}

/** Joins shots into one vertical 1080x1920 MP4 with hard cuts; clips without audio get silence. */
export async function stitch(paths: string[], out: string) {
  const bin = await ffmpegPath();
  if (!bin) throw new Error("ffmpeg is not available");
  const info = await Promise.all(paths.map(probe));
  const args = ["-hide_banner", "-loglevel", "error", "-y"];
  paths.forEach((path) => args.push("-i", path));
  const silent: number[] = [];
  info.forEach((clip, i) => {
    if (!clip.hasAudio) {
      silent[i] = paths.length + silent.filter((x) => x !== undefined).length;
      args.push("-f", "lavfi", "-t", String(clip.duration || 8), "-i", "anullsrc=r=48000:cl=stereo");
    }
  });
  const parts = paths.map((_, i) => {
    const audio = silent[i] !== undefined ? `${silent[i]}:a` : `${i}:a`;
    return (
      `[${i}:v]scale=1080:1920:force_original_aspect_ratio=decrease:flags=lanczos,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,format=yuv420p[v${i}];` +
      `[${audio}]aresample=48000,aformat=channel_layouts=stereo[a${i}];`
    );
  });
  const concat = paths.map((_, i) => `[v${i}][a${i}]`).join("") + `concat=n=${paths.length}:v=1:a=1[v][a]`;
  args.push("-filter_complex", parts.join("") + concat, "-map", "[v]", "-map", "[a]");
  args.push("-c:v", "libx264", "-preset", "medium", "-crf", "18", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", out);
  await exec(bin, args, { maxBuffer: 16 * 1024 * 1024 });
  return out;
}

export async function fileSize(path: string) {
  return (await stat(path)).size;
}
