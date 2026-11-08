import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { ApiError } from "../http";
import { download, ffmpegPath, probe } from "../media";
import type { NaiveClient, TranscriptSegment } from "../naive";
import { QC_MODEL } from "../qc";
import { extractJson, type Video } from "../research";
import type { BeatJob, ReferenceBeat, ReferenceBreakdown, ReferenceCandidate, ShotKind } from "./types";

// The reference engine: find the public videos that outran their accounts, then take each one
// apart beat by beat (transcript, cuts, frames) so the writers can rebuild its structure, hook
// mechanic, pacing and delivery around our product, with new people and new words.

const exec = promisify(execFile);

// ---------- scoring ----------

export type ScoreOptions = {
  /** Most candidates kept per author (default 2). */
  maxPerAuthor?: number;
  /** Accounts above this many followers are penalized (default 1,000,000). */
  bigAccount?: number;
  /** The length a reference should have, in seconds (default 6-75). */
  minSeconds?: number;
  maxSeconds?: number;
};

/** A typical short video's engagement, and how many views it takes to trust a video's own rate over it. */
const PRIOR_ENGAGEMENT = 0.04;
const PRIOR_VIEWS = 2000;
/** Past 500x the account, more is noise: the video is a breakout either way. */
const OUTLIER_CAP = 500;
/** Followers unknown: assume a modestly good video, neither a flop nor a breakout. */
const UNKNOWN_OUTLIER = 1.5;
const PAID_PENALTY = 4;

/** (likes + comments + 2 x shares + 2 x saves) / views: shares and saves are the stronger signals. */
export function engagementOf(video: Pick<Video, "views" | "likes" | "comments" | "shares" | "saves">) {
  return interactionsOf(video) / Math.max(count(video.views), 1);
}

/** views / max(followers, 1000), or null when the follower count is unknown. */
export function outlierOf(video: Pick<Video, "views" | "followers">) {
  return video.followers === null || !Number.isFinite(video.followers) ? null : count(video.views) / Math.max(video.followers, 1000);
}

/**
 * One video's score. Every term is log-scaled so a single viral number cannot swamp the rest:
 *
 *   outlier     4 x log2(1 + min(outlier, 500)) x confidence   (unknown followers: outlier taken as 1.5)
 *   engagement  4 x log2(1 + min(smoothed, 0.5) / 0.04)        smoothed = (interactions + 0.04 x 2000) / (views + 2000)
 *   reach       1.5 x log10(views)
 *   big account -(3 + 3 x log10(followers / 1M)) above 1M followers
 *   paid        -4
 *   length      0 inside 6-75 s; -1 unknown; -3 shorter; -(2 + (s - 75) / 10), at most -15, longer
 *
 * confidence = clamp((log10(views) - 3) / 2, 0.25, 1): a 3x outlier on 3,000 views is weak evidence,
 * on 300,000 views it is not. Smoothing does the same for engagement on small view counts.
 */
export function scoreVideo(video: Video, options: ScoreOptions = {}): ReferenceCandidate["score"] {
  const big = options.bigAccount ?? 1_000_000;
  const views = count(video.views);
  const followers = video.followers !== null && Number.isFinite(video.followers) ? Math.max(0, video.followers) : null;
  const interactions = interactionsOf(video);
  const engagement = interactions / Math.max(views, 1);
  const outlier = outlierOf(video);

  const smoothed = (interactions + PRIOR_ENGAGEMENT * PRIOR_VIEWS) / (views + PRIOR_VIEWS);
  const engagementPoints = 4 * Math.log2(1 + Math.min(smoothed, 0.5) / PRIOR_ENGAGEMENT);
  const confidence = clamp((Math.log10(Math.max(views, 1)) - 3) / 2, 0.25, 1);
  const outlierPoints = 4 * Math.log2(1 + Math.min(outlier ?? UNKNOWN_OUTLIER, OUTLIER_CAP)) * confidence;
  const reachPoints = 1.5 * Math.log10(Math.max(views, 1));
  const bigPenalty = followers !== null && followers > big ? 3 + 3 * Math.log10(followers / big) : 0;
  const paidPenalty = video.paid ? PAID_PENALTY : 0;
  const lengthPoints = lengthScore(video.duration, options.minSeconds ?? 6, options.maxSeconds ?? 75);
  const total = outlierPoints + engagementPoints + reachPoints + lengthPoints - bigPenalty - paidPenalty;

  const why = [
    outlier !== null ? `${times(outlier)} the account's followers` : `${compact(views)} views, followers unknown`,
    `${percent(engagement)} engagement`,
    video.duration !== null && Number.isFinite(video.duration) ? `${Math.round(video.duration)} s` : "length unknown",
    ...(followers !== null && followers > big ? [`big account (${compact(followers)} followers)`] : []),
    ...(video.paid ? ["paid partnership"] : []),
  ].join(", ");

  return { outlier: outlier === null ? null : round(outlier, 2), engagement: round(engagement, 4), total: round(total, 2), why };
}

/**
 * Ranks research videos as reference candidates: best first, one entry per video URL, at most
 * `maxPerAuthor` (2) per account so one creator cannot fill the list.
 */
export function scoreCandidates(videos: Video[], originOf: (video: Video) => ReferenceCandidate["origin"], options: ScoreOptions = {}): ReferenceCandidate[] {
  const maxPerAuthor = options.maxPerAuthor ?? 2;
  const scored: ReferenceCandidate[] = videos
    .filter((video) => typeof video.url === "string" && video.url.trim() !== "")
    .map((video) => ({ ...video, origin: originOf(video), score: scoreVideo(video, options) }))
    .sort((a, b) => b.score.total - a.score.total || count(b.views) - count(a.views));

  const seen = new Set<string>();
  const perAuthor = new Map<string, number>();
  return scored.filter((candidate) => {
    const key = canonicalUrl(candidate.url);
    if (seen.has(key)) return false;
    seen.add(key);
    const author = authorKey(candidate.author);
    if (!author) return true;
    const kept = perAuthor.get(author) ?? 0;
    if (kept >= maxPerAuthor) return false;
    perAuthor.set(author, kept + 1);
    return true;
  });
}

/**
 * The candidates worth a full breakdown: downloadable, a plausible length (5-90 s, or unknown and
 * checked after download), best first, with the best competitor post and the best category video
 * included whenever there is one, and one per author before anyone gets a second.
 */
export function pickForBreakdown(candidates: ReferenceCandidate[], n = 6, options: { minSeconds?: number; maxSeconds?: number } = {}): ReferenceCandidate[] {
  const min = options.minSeconds ?? 5;
  const max = options.maxSeconds ?? 90;
  const usable = candidates
    .filter((candidate) => Boolean(candidate.media_url))
    .filter((candidate) => candidate.duration === null || (candidate.duration >= min && candidate.duration <= max))
    .sort((a, b) => b.score.total - a.score.total);

  const picked: ReferenceCandidate[] = [];
  const authors = new Set<string>();
  const take = (candidate: ReferenceCandidate) => {
    picked.push(candidate);
    authors.add(authorKey(candidate.author));
  };
  for (const origin of ["competitor", "category"] as const) {
    const best = usable.find((candidate) => candidate.origin === origin);
    if (best && picked.length < n && !picked.includes(best)) take(best);
  }
  for (const distinctAuthors of [true, false]) {
    for (const candidate of usable) {
      if (picked.length >= n) break;
      if (picked.includes(candidate)) continue;
      const author = authorKey(candidate.author);
      if (distinctAuthors && author && authors.has(author)) continue;
      take(candidate);
    }
  }
  return picked.sort((a, b) => b.score.total - a.score.total);
}

// ---------- the breakdown ----------

/** The model that reads a reference: the vision model the QC step already uses. */
export const BREAKDOWN_MODEL = QC_MODEL;
/** Naive's model proxy takes at most 12 images per request; 10 leaves room. */
export const MAX_FRAMES = 10;

/** The NaiveClient methods a breakdown uses (a NaiveClient satisfies it). */
export type BreakdownClient = Pick<NaiveClient, "uploadFile" | "transcribe" | "getTranscription" | "message">;

export type BreakdownOptions = {
  /** Scratch space; each breakdown works in its own subfolder and removes it when done. */
  workDir: string;
  brand: { name: string; one_liner: string; kind: string };
  /** Defaults to BREAKDOWN_MODEL. */
  model?: string;
  /** ISO 639-1 hint for speech to text (default "en"); null lets the model detect it. */
  language?: string | null;
  /** ffmpeg scene-change threshold for a hard cut (default 0.3). */
  sceneThreshold?: number;
  /** Frames shown to the model, at most MAX_FRAMES (default 10). */
  maxFrames?: number;
  /** How long to wait for a queued transcription before giving up for now (default 3 minutes). */
  transcriptionTimeoutMs?: number;
  /** Poll interval for a queued transcription (default 3 s). */
  pollMs?: number;
};

/** The video itself could not be fetched or played. Not worth retrying: pick another reference. */
export class ReferenceUnavailableError extends Error {
  readonly retryable = false;
  constructor(
    readonly url: string,
    reason: string,
  ) {
    super(`reference ${url}: ${reason}`);
    this.name = "ReferenceUnavailableError";
  }
}

/** A stable id for a reference, from its URL: writers point at breakdowns by it. */
export function referenceId(url: string) {
  return `ref_${createHash("sha1").update(canonicalUrl(url)).digest("hex").slice(0, 10)}`;
}

/**
 * Downloads one reference, finds its cuts, transcribes it, pulls frames at each cut, and has a
 * vision model write the beat-by-beat breakdown. Provider problems throw ApiError (check
 * `.retryable`); a video that cannot be fetched throws ReferenceUnavailableError.
 */
export async function breakdownReference(naive: BreakdownClient, candidate: ReferenceCandidate, options: BreakdownOptions): Promise<ReferenceBreakdown> {
  if (!candidate.media_url) throw new ReferenceUnavailableError(candidate.url, "no downloadable video link");
  const bin = await ffmpegPath();
  if (!bin) throw new Error("ffmpeg is not available, so references cannot be broken down");

  const id = referenceId(candidate.url);
  const dir = join(options.workDir, id);
  await mkdir(dir, { recursive: true });
  try {
    const video = join(dir, "video.mp4");
    await fetchVideo(candidate.media_url, video, candidate.url);
    const info = await probe(video).catch(() => ({ duration: 0, hasAudio: false, width: 0, height: 0 }));
    if (!info.duration || !info.width) throw new ReferenceUnavailableError(candidate.url, "the downloaded file is not a playable video");
    const duration = round(info.duration, 1);

    const cuts = await detectCuts(video, options.sceneThreshold ?? 0.3, duration);
    const speech = info.hasAudio ? await transcribe(naive, video, dir, id, options) : { text: "", segments: [] };
    const wpm = wordsPerMinute(speech.text, speech.segments, duration);
    const frames = await grabFrames(bin, video, dir, frameTimes(duration, cuts, Math.min(options.maxFrames ?? MAX_FRAMES, MAX_FRAMES)));
    if (frames.length === 0) throw new ReferenceUnavailableError(candidate.url, "no frames could be read from the video");

    const raw = await askForBreakdown(naive, options.model ?? BREAKDOWN_MODEL, buildContent({ candidate, duration, cuts, speech, wpm, frames, brand: options.brand }));
    const read = readBreakdown(raw, { duration, transcript: speech.text, segments: speech.segments });
    return {
      id,
      url: candidate.url,
      platform: candidate.platform,
      author: candidate.author,
      views: candidate.views,
      followers: candidate.followers,
      outlier: candidate.score.outlier,
      duration,
      ...read,
      pacing: { cuts: cuts.length, avg_shot_seconds: round(duration / (cuts.length + 1), 1), words_per_minute: wpm },
      transcript: speech.text,
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export type BreakdownFailure = { candidate: ReferenceCandidate; error: string; retryable: boolean; cause: unknown };

/** Breaks down several references, three at a time. Failures are reported, never thrown. */
export async function breakdownAll(
  naive: BreakdownClient,
  candidates: ReferenceCandidate[],
  options: BreakdownOptions & { concurrency?: number },
): Promise<{ breakdowns: ReferenceBreakdown[]; failures: BreakdownFailure[] }> {
  const results: Array<{ ok: true; value: ReferenceBreakdown } | { ok: false; failure: BreakdownFailure }> = new Array(candidates.length);
  let next = 0;
  const worker = async () => {
    while (next < candidates.length) {
      const i = next++;
      const candidate = candidates[i];
      try {
        results[i] = { ok: true, value: await breakdownReference(naive, candidate, options) };
      } catch (error) {
        const retryable = error instanceof ApiError ? error.retryable : false;
        results[i] = { ok: false, failure: { candidate, error: error instanceof Error ? error.message : String(error), retryable, cause: error } };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(options.concurrency ?? 3, candidates.length)) }, worker));
  return {
    breakdowns: results.flatMap((result) => (result.ok ? [result.value] : [])),
    failures: results.flatMap((result) => (result.ok ? [] : [result.failure])),
  };
}

// ---------- video, audio and frames ----------

/** Copies a local file (an absolute path or file: URL) or downloads a remote one. */
async function fetchVideo(source: string, to: string, url: string) {
  try {
    if (source.startsWith("file:")) await copyFile(fileURLToPath(source), to);
    else if (source.startsWith("/")) await copyFile(source, to);
    else await download(source, to);
  } catch (error) {
    throw new ReferenceUnavailableError(url, `the video could not be downloaded (${error instanceof Error ? error.message : String(error)})`);
  }
}

/**
 * Hard cuts, in seconds, from ffmpeg's scene-change score. Cuts closer than 0.3 s are one cut
 * (a flash frame or a two-frame dissolve), and nothing in the first or last 0.2 s counts.
 */
export async function detectCuts(path: string, threshold = 0.3, duration?: number): Promise<number[]> {
  const bin = await ffmpegPath();
  if (!bin) throw new Error("ffmpeg is not available");
  const { stderr } = await exec(bin, ["-hide_banner", "-nostats", "-i", path, "-an", "-sn", "-dn", "-vf", `scale=320:-2,select='gt(scene,${threshold})',showinfo`, "-f", "null", "-"], {
    maxBuffer: 32 * 1024 * 1024,
  });
  const found = [...stderr.matchAll(/pts_time:\s*(-?[\d.]+)/g)].map((match) => Number(match[1])).filter(Number.isFinite);
  const end = duration ?? Number.POSITIVE_INFINITY;
  const cuts: number[] = [];
  for (const at of found.sort((a, b) => a - b)) {
    if (at < 0.2 || at > end - 0.2) continue;
    if (cuts.length && at - cuts[cuts.length - 1] < 0.3) continue;
    cuts.push(round(at, 2));
  }
  return cuts;
}

/**
 * When to take frames: the start of every shot (just after the cut), then the middle of the longest
 * stretch without a frame until there are `max` (fewer for a very short video). With more shots
 * than frames, shots are sampled evenly, always keeping the first and the last.
 */
export function frameTimes(duration: number, cuts: number[], max = MAX_FRAMES): Array<{ at: number; shot: number; opensShot: boolean }> {
  if (!(duration > 0)) return [{ at: 0, shot: 1, opensShot: true }];
  const starts = [0, ...cuts.filter((cut) => cut > 0 && cut < duration)];
  const shotOf = (at: number) => starts.filter((start) => start <= at).length;
  const target = Math.max(1, Math.min(max, Math.max(4, Math.round(duration / 1.5))));
  const last = Math.max(0, duration - 0.05);
  const opening = (i: number) => {
    const start = starts[i];
    const end = starts[i + 1] ?? duration;
    return Math.min(last, start + (i === 0 ? Math.min(0.2, (end - start) / 2) : Math.min(0.4, (end - start) / 3)));
  };

  let picks: number[];
  if (starts.length >= target) {
    const chosen = target === 1 ? [0] : Array.from({ length: target }, (_, i) => Math.round((i * (starts.length - 1)) / (target - 1)));
    picks = [...new Set(chosen)].map(opening);
  } else {
    picks = starts.map((_, i) => opening(i));
  }
  const openers = new Set(picks);

  // Fill: the middle of the longest gap between frames (or between the last frame and the end).
  while (picks.length < target) {
    const sorted = [...picks].sort((a, b) => a - b);
    let bestGap = 0;
    let bestAt = -1;
    for (let i = 0; i < sorted.length; i++) {
      const to = sorted[i + 1] ?? duration;
      if (to - sorted[i] > bestGap) {
        bestGap = to - sorted[i];
        bestAt = sorted[i] + (to - sorted[i]) / 2;
      }
    }
    if (bestAt < 0 || bestGap < 0.5) break;
    picks.push(Math.min(last, bestAt));
  }

  return picks
    .sort((a, b) => a - b)
    .map((at) => ({ at: round(at, 2), shot: shotOf(at), opensShot: openers.has(at) }));
}

async function grabFrames(bin: string, video: string, dir: string, times: Array<{ at: number; shot: number; opensShot: boolean }>) {
  const frames: Array<{ at: number; shot: number; opensShot: boolean; jpeg: Buffer }> = [];
  for (const [i, time] of times.entries()) {
    const out = join(dir, `frame${i}.jpg`);
    try {
      await exec(bin, ["-hide_banner", "-loglevel", "error", "-y", "-ss", time.at.toFixed(2), "-i", video, "-frames:v", "1", "-vf", "scale=540:-2", "-q:v", "4", out]);
      frames.push({ ...time, jpeg: await readFile(out) });
    } catch {
      // a seek past the last decodable frame: the other frames still tell the story
    }
  }
  return frames;
}

async function extractAudio(bin: string, video: string, dir: string): Promise<{ path: string; contentType: string; ext: string }> {
  const base = ["-hide_banner", "-loglevel", "error", "-y", "-i", video, "-vn", "-ac", "1", "-ar", "16000"];
  const mp3 = join(dir, "audio.mp3");
  try {
    await exec(bin, [...base, "-c:a", "libmp3lame", "-b:a", "48k", mp3]);
    return { path: mp3, contentType: "audio/mpeg", ext: "mp3" };
  } catch {
    // an ffmpeg without an MP3 encoder: plain WAV is still small at 16 kHz mono
    const wav = join(dir, "audio.wav");
    await exec(bin, [...base, "-c:a", "pcm_s16le", wav]);
    return { path: wav, contentType: "audio/wav", ext: "wav" };
  }
}

/** Speech to text on Naive: upload the audio, transcribe with timestamps, wait if it was queued. */
async function transcribe(naive: BreakdownClient, video: string, dir: string, id: string, options: BreakdownOptions): Promise<{ text: string; segments: TranscriptSegment[] }> {
  const bin = (await ffmpegPath())!;
  const audio = await extractAudio(bin, video, dir);
  const fileId = await naive.uploadFile(`${id}-audio.${audio.ext}`, audio.contentType, await readFile(audio.path));
  const language = options.language === undefined ? "en" : options.language;
  let job = await naive.transcribe({ file_id: fileId, model: "stt/auto", timestamps: true, ...(language ? { language } : {}) }, `nomen-ref-stt-${fileId}`);
  const deadline = Date.now() + (options.transcriptionTimeoutMs ?? 180_000);
  while (job.status === "queued" || job.status === "processing") {
    if (Date.now() > deadline) throw new ApiError("naive", 504, "transcription_timeout", `transcription ${job.id} is still ${job.status}; try again later`);
    await sleep(options.pollMs ?? 3000);
    job = await naive.getTranscription(job.id);
  }
  if (job.status !== "completed" || !job.result) {
    throw new ApiError("naive", 502, job.error?.code ?? "transcription_failed", job.error?.message ?? `transcription ${job.id} ended ${job.status}`);
  }
  const segments = (job.result.segments ?? [])
    .filter((segment) => Number.isFinite(segment.start_seconds) && Number.isFinite(segment.end_seconds) && typeof segment.text === "string")
    .map((segment) => ({ start_seconds: segment.start_seconds, end_seconds: segment.end_seconds, text: segment.text.trim() }))
    .filter((segment) => segment.text)
    .sort((a, b) => a.start_seconds - b.start_seconds);
  const text = (job.result.text ?? "").trim() || segments.map((segment) => segment.text).join(" ");
  return { text, segments };
}

/**
 * How fast the person talks: words per minute of time spent talking (the transcript's segments,
 * overlaps merged), so a silent B-roll stretch does not make a fast talker look slow. Without
 * timings, over the whole video.
 */
export function wordsPerMinute(text: string, segments: TranscriptSegment[], duration: number): number | null {
  const words = text.split(/\s+/).filter((word) => /[\p{L}\p{N}]/u.test(word)).length;
  if (words === 0) return null;
  let talking = 0;
  let reached = Number.NEGATIVE_INFINITY;
  for (const segment of [...segments].sort((a, b) => a.start_seconds - b.start_seconds)) {
    const start = Math.max(segment.start_seconds, reached);
    if (segment.end_seconds > start) talking += segment.end_seconds - start;
    reached = Math.max(reached, segment.end_seconds);
  }
  const span = segments.length ? talking : duration;
  return span >= 1 ? Math.round(words / (span / 60)) : null;
}

// ---------- the vision call ----------

const JOBS: BeatJob[] = ["hook", "problem", "agitate", "reveal", "demo", "proof", "objection", "payoff", "cta", "other"];
const SHOTS: ShotKind[] = ["talking_head", "product_closeup", "screen", "b_roll", "text_only", "reaction", "split"];

const BREAKDOWN_TOOL = {
  name: "reference_breakdown",
  description: "Record the beat-by-beat breakdown of this reference video.",
  input_schema: {
    type: "object",
    required: ["format", "hook", "beats", "caption_style", "delivery", "why_it_works", "fit"],
    properties: {
      format: {
        type: "string",
        description:
          "The format in plain words: who or what is on screen, framing and camera (handheld, propped-up phone, tripod, screen recording), how often it cuts and to what, on-screen text and captions, voice or music. E.g. 'talking head to a propped-up phone, jump cuts every 2-3 s, cuts to the app on each claim, bold word-by-word captions'.",
      },
      hook: {
        type: "object",
        required: ["line", "on_screen_text", "visual", "mechanic"],
        properties: {
          line: { type: "string", description: "What is said during the hook, copied word for word from the transcript, or '' if nothing is said." },
          on_screen_text: { type: "string", description: "Designed text on screen during the hook, exactly as written in the frames, or ''." },
          visual: { type: "string", description: "What the viewer sees in the first 1-2 seconds: framing, who or what is in shot, the action, any motion." },
          mechanic: {
            type: "string",
            description:
              "Why a viewer stops scrolling, as a reusable mechanism that would work for a different product: e.g. 'names a specific viewer, then makes a claim that sounds wrong' or 'shows the end result first, then rewinds'. Not the topic of this video.",
          },
        },
      },
      beats: {
        type: "array",
        description: "Consecutive beats from 0 s to the end of the video, no gaps or overlaps, usually 3-12. The first beat is the hook.",
        items: {
          type: "object",
          required: ["start", "end", "job", "shot", "visual", "on_screen_text", "line"],
          properties: {
            start: { type: "number", description: "Seconds, one decimal; equals the previous beat's end (0 for the first)." },
            end: { type: "number", description: "Seconds, one decimal; the last beat ends at the video's duration." },
            job: { type: "string", enum: JOBS, description: "The one job this beat does for the viewer." },
            shot: {
              type: "string",
              enum: SHOTS,
              description:
                "talking_head: a person speaking to camera; product_closeup: the product fills the frame; screen: a phone or computer screen or a screen recording; b_roll: other footage; text_only: text on a plain or still background; reaction: a face reacting; split: two pictures stacked or side by side.",
            },
            visual: { type: "string", description: "What the viewer sees during the beat and how it moves: 'she holds the bottle up to the lens, quick push-in', 'scrolls the pricing page'." },
            on_screen_text: { type: "string", description: "Designed text on screen during the beat, exactly as written in the frames (keep capitals and emoji), or ''. Not word-by-word speech captions." },
            line: { type: "string", description: "What is said during the beat, copied word for word from the transcript (filler words included), or '' if nothing is said." },
          },
        },
      },
      caption_style: {
        type: "string",
        description: "How the spoken words are captioned on screen: weight, colour, outline or box, position, words per chunk, highlighting. 'none' if there are no speech captions.",
      },
      delivery: {
        type: "string",
        description:
          "How the person talks: register, energy, pace (use the words-per-minute figure), sentence length, filler words, where they look, what their hands do. 'no voice' if nobody speaks; say so if the audio is a song rather than speech.",
      },
      why_it_works: {
        type: "string",
        description: "2-4 sentences: what earns the first two seconds, what keeps people watching to the end, and what drives comments, shares or saves, tied to the stats.",
      },
      fit: {
        type: "object",
        required: ["score", "reason"],
        properties: {
          score: { type: "integer", minimum: 0, maximum: 10, description: "How well this format would carry the brand's product." },
          reason: { type: "string", description: "One or two sentences: how the format would carry the product and what would have to change." },
        },
      },
    },
  },
};

const SYSTEM = [
  "You are the breakdown analyst on a team that makes short vertical video ads. You take apart one public video that clearly outperformed its account and write down exactly how it works, second by second, so a script writer can rebuild the same structure, hook mechanic, pacing and delivery for a different product.",
  "You are given frames from the video in order, each labelled with its timestamp and shot; the timestamped transcript of what is said; the hard cuts detected in it; its stats; and the brand that will borrow the format.",
  "Rules:",
  "- Report only what the frames and the transcript show. Never invent dialogue, on-screen text, products, numbers or events. You only see some frames: when you infer what happens between them, say so briefly ('between frames', 'likely'). If text in a frame is too small or blurred to read, write 'unreadable' rather than guessing.",
  "- Every line, including the hook's, is copied word for word from the transcript, filler words included. Split the transcript at beat boundaries using its timestamps; a beat with no speech has line ''. Never paraphrase, shorten or tidy a line.",
  "- on_screen_text is designed text (titles, labels, lists, stickers) copied exactly as it appears in the frames; '' if none. Word-by-word captions of the speech are not on-screen text: describe them once in caption_style.",
  "- Beats run in order from 0 to the end of the video with no gaps or overlaps: each beat starts where the previous one ends and the last ends at the video's duration. Times are seconds with one decimal. Put boundaries on detected cuts or transcript segment boundaries where they fit. One job per beat, usually 3-12 beats; the first beat is the hook and normally ends within 3 seconds.",
  "- Be exact about timing: when the product first appears, when text pops on, how long shots last. Take it from the frame and transcript timestamps.",
  "- hook.mechanic and why_it_works name mechanisms that would transfer to a different product, not the topic of this video.",
  "- You describe format and mechanics only. The team will make an original video with different people, footage, voice and words, and will never reuse this video's people, footage, voice, music or exact lines; do not suggest otherwise. Do not try to identify anyone: describe people by role and look ('a woman in her 20s talking to a propped-up phone').",
  "- Judge fit honestly for the brand given: 10 means the format carries its product almost unchanged, 5 means it works with real changes, 0 means it depends on something the brand cannot do (a celebrity, a physical stunt for an app, a product it does not have).",
].join("\n");

const JSON_SHAPE =
  '{"format": "...", "hook": {"line": "...", "on_screen_text": "...", "visual": "...", "mechanic": "..."}, "beats": [{"start": 0, "end": 2.1, "job": "hook|problem|agitate|reveal|demo|proof|objection|payoff|cta|other", "shot": "talking_head|product_closeup|screen|b_roll|text_only|reaction|split", "visual": "...", "on_screen_text": "...", "line": "..."}], "caption_style": "...", "delivery": "...", "why_it_works": "...", "fit": {"score": 0, "reason": "..."}}';

type ContentInput = {
  candidate: ReferenceCandidate;
  duration: number;
  cuts: number[];
  speech: { text: string; segments: TranscriptSegment[] };
  wpm: number | null;
  frames: Array<{ at: number; shot: number; opensShot: boolean; jpeg: Buffer }>;
  brand: BreakdownOptions["brand"];
};

const ORIGIN_LABEL: Record<ReferenceCandidate["origin"], string> = {
  competitor: "a competitor's own post",
  category: "from a search in the brand's category",
  adjacent: "from an adjacent category whose format may transfer",
  ad: "a paid ad",
};

function buildContent(input: ContentInput): unknown[] {
  const { candidate, duration, cuts, speech, wpm, frames, brand } = input;
  const shots = cuts.length + 1;
  const content: unknown[] = [];
  for (const [i, frame] of frames.entries()) {
    const note = frame.opensShot ? (frame.shot === 1 ? " (the opening frame)" : " (just after the cut that opens it)") : "";
    content.push({ type: "text", text: `Frame ${i + 1} of ${frames.length}: ${frame.at.toFixed(1)} s, shot ${frame.shot} of ${shots}${note}.` });
    content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: frame.jpeg.toString("base64") } });
  }

  const stats = [
    `${count(candidate.views).toLocaleString("en")} views`,
    candidate.followers !== null ? `${candidate.followers.toLocaleString("en")} followers (${times(candidate.score.outlier ?? 0)} the account's followers)` : "follower count unknown",
    `${count(candidate.likes).toLocaleString("en")} likes, ${count(candidate.comments).toLocaleString("en")} comments, ${count(candidate.shares).toLocaleString("en")} shares, ${count(candidate.saves).toLocaleString("en")} saves (${percent(candidate.score.engagement)} engagement)`,
    ...(candidate.paid ? ["paid partnership"] : []),
  ].join("; ");
  const transcript = speech.segments.length
    ? speech.segments.map((segment) => `[${segment.start_seconds.toFixed(1)}-${segment.end_seconds.toFixed(1)}] ${segment.text}`).join("\n")
    : speech.text
      ? `(no timings; the whole video) ${speech.text}`
      : "(no speech detected)";

  content.push({
    type: "text",
    text: [
      `The video: a ${candidate.platform} post by @${candidate.author || "unknown"}, ${ORIGIN_LABEL[candidate.origin]}.`,
      `Stats: ${stats}.`,
      `Caption: ${candidate.caption ? JSON.stringify(candidate.caption) : "(none)"}`,
      `Duration: ${duration.toFixed(1)} s.`,
      cuts.length
        ? `Hard cuts detected at: ${cuts.map((cut) => cut.toFixed(1)).join(", ")} s, so ${shots} shots, ${(duration / shots).toFixed(1)} s per shot on average. (Detected automatically: jump cuts count, slow fades may be missed.)`
        : "No hard cuts detected: one continuous shot, or only soft transitions.",
      wpm !== null ? `Speech pace: ${wpm} words per minute.` : "Speech pace: no speech.",
      `Transcript, timestamped in seconds:\n${transcript}`,
      "",
      `The brand that will borrow this format: ${brand.name}: ${brand.one_liner} (a ${brand.kind} product).`,
    ].join("\n"),
  });
  return content;
}

async function askForBreakdown(naive: BreakdownClient, model: string, content: unknown[]): Promise<Record<string, unknown>> {
  const ask = (text: string, tools?: object[]) => naive.message({ model, max_tokens: 4096, system: SYSTEM, messages: [{ role: "user", content: [...content, { type: "text", text }] }], tools });
  let raw: unknown = null;
  try {
    const reply = await ask("Call the reference_breakdown tool once.", [BREAKDOWN_TOOL]);
    raw = reply.content.find((block) => block.type === "tool_use" && block.name === BREAKDOWN_TOOL.name)?.input ?? null;
  } catch (error) {
    if (!(error instanceof ApiError) || !/tool/i.test(error.message)) throw error;
  }
  if (!isRecord(raw)) {
    // The model fumbled the tool call: ask for the same breakdown as plain JSON.
    const reply = await ask(`Answer with only a JSON object of this shape, following every rule above:\n${JSON_SHAPE}`);
    raw = extractJson(reply.content.map((block) => block.text ?? "").join("\n"));
    if (!isRecord(raw)) throw new ApiError("naive", 502, "breakdown_unreadable", "the breakdown model returned no breakdown");
  }
  return raw;
}

type ReadBreakdown = Pick<ReferenceBreakdown, "format" | "hook" | "beats" | "caption_style" | "delivery" | "why_it_works" | "fit">;

/**
 * The model's answer, made safe for the writers: beats sorted and stretched to cover the whole
 * video without gaps, unknown jobs and shots mapped to "other" and "b_roll", and any spoken line
 * that is not in the transcript replaced by the transcript's own words for that stretch.
 */
export function readBreakdown(raw: Record<string, unknown>, context: { duration: number; transcript: string; segments: TranscriptSegment[] }): ReadBreakdown {
  const { duration, segments } = context;
  const spoken = normalizeWords(context.transcript);
  const said = (start: number, end: number) =>
    segments
      .filter((segment) => {
        const middle = (segment.start_seconds + segment.end_seconds) / 2;
        return middle >= start && middle < end;
      })
      .map((segment) => segment.text)
      .join(" ");
  const verbatim = (line: string, fallback: () => string) => {
    if (!line || !spoken) return "";
    const words = normalizeWords(line);
    return words && spoken.includes(words) ? line : fallback();
  };

  const parsed = (Array.isArray(raw.beats) ? raw.beats : [])
    .filter(isRecord)
    .map((beat) => ({
      start: clamp(Number(beat.start), 0, duration),
      end: clamp(Number(beat.end), 0, duration),
      job: (JOBS as string[]).includes(text(beat.job)) ? (text(beat.job) as BeatJob) : "other",
      shot: (SHOTS as string[]).includes(text(beat.shot)) ? (text(beat.shot) as ShotKind) : "b_roll",
      visual: text(beat.visual),
      on_screen_text: text(beat.on_screen_text),
      line: text(beat.line),
    }))
    .filter((beat) => Number.isFinite(beat.start) && Number.isFinite(beat.end))
    .sort((a, b) => a.start - b.start || a.end - b.end);

  const beats: ReferenceBeat[] = [];
  for (const beat of parsed) {
    const start = beats.length ? beats[beats.length - 1].end : 0;
    const end = round(Math.max(beat.end, start), 1);
    if (end - start < 0.05) continue;
    beats.push({ ...beat, start, end });
  }
  if (beats.length === 0) throw new ApiError("naive", 502, "breakdown_unreadable", "the breakdown had no usable beats");
  beats[beats.length - 1].end = round(duration, 1);
  for (const beat of beats) beat.line = verbatim(beat.line, () => said(beat.start, beat.end));

  const hook = isRecord(raw.hook) ? raw.hook : {};
  const fit = isRecord(raw.fit) ? raw.fit : {};
  const score = Number(fit.score);
  return {
    format: text(raw.format),
    hook: {
      line: verbatim(text(hook.line), () => beats[0].line),
      on_screen_text: text(hook.on_screen_text),
      visual: text(hook.visual),
      mechanic: text(hook.mechanic),
    },
    beats,
    caption_style: text(raw.caption_style) || "none",
    delivery: text(raw.delivery),
    why_it_works: text(raw.why_it_works),
    fit: { score: Number.isFinite(score) ? clamp(Math.round(score), 0, 10) : 5, reason: text(fit.reason) },
  };
}

// ---------- helpers ----------

function interactionsOf(video: Pick<Video, "likes" | "comments" | "shares" | "saves">) {
  return count(video.likes) + count(video.comments) + 2 * count(video.shares) + 2 * count(video.saves);
}

function lengthScore(duration: number | null, min: number, max: number) {
  if (duration === null || !Number.isFinite(duration)) return -1;
  if (duration < min) return -3;
  if (duration > max) return -Math.min(15, 2 + (duration - max) / 10);
  return 0;
}

/** Same video, different link: no query string or trailing slash, no www/m subdomain (YouTube keeps ?v=). */
export function canonicalUrl(url: string) {
  try {
    const parsed = new URL(url.trim());
    const host = parsed.hostname.toLowerCase().replace(/^(www|m|mobile)\./, "");
    const v = parsed.searchParams.get("v");
    return `${host}${parsed.pathname.replace(/\/+$/, "")}${v ? `?v=${v}` : ""}`;
  } catch {
    return url.trim().toLowerCase().replace(/[?#].*$/, "").replace(/\/+$/, "");
  }
}

function authorKey(author: string) {
  return (author ?? "").trim().toLowerCase().replace(/^@/, "");
}

function normalizeWords(value: string) {
  return value
    .toLowerCase()
    .replace(/['’‘`]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function count(value: number) {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function round(value: number, digits: number) {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function times(outlier: number) {
  if (outlier >= 10) return `${Math.round(outlier)}x`;
  if (outlier >= 1) return `${outlier.toFixed(1).replace(/\.0$/, "")}x`;
  return `${outlier.toFixed(2)}x`;
}

function percent(rate: number) {
  const value = rate * 100;
  return value < 1 ? `${value.toFixed(1)}%` : `${Math.round(value)}%`;
}

function compact(value: number) {
  return new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
