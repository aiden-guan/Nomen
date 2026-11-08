// The remake's sound: the reference's own music and effects under our people's voices.
//
//   reference audio ─ stems: Demucs (local, `npm run setup:stems`) splits voice from music and
//     │               effects; without it, ElevenLabs audio isolation gives the voice and there is no bed
//     └─ word timings: ElevenLabs speech-to-text on the voice (what each render says, and when)
//          ├─ a presenter with its own voice (Kling 3.0, the default): each render's voice is the
//          │    soundtrack for its stretch; speech-to-text times its captions, and, when asked,
//          │    speech-to-speech brings every render to the persona's one voice (renderVoice)
//          └─ otherwise our voice, made before any video so an audio-driven presenter can lip-sync
//               to it (makeVoice): an emotional eleven_v4 read with each line's tag ([excited],
//               [smug], [laughs]...), the best of three by length, each phrase stretched onto the
//               reference phrase it replaces; or the original performance converted (speech-to-speech)
//                 └─ the soundtrack (soundArgs): the voices laid at their times over the bed, with the
//                    voice finish, room tone, the bed ducked under the voice, and -14 LUFS
//
// A stitched clip's words are said by someone else: those stretches are the co-host's. ElevenLabs
// runs on Monid; every paid result is kept by key, so a rerun pays nothing twice.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { promisify } from "node:util";

import { probe } from "../media";
import { type MonidRunner, outputLink, runCostMicro, runToEnd } from "../monid";
import type { NaiveClient } from "../naive";
import { ffmpeg, ffmpegBin } from "./clone";
import { BED_LEVEL, DUCK, LOUDNESS, roomTone, VOICE_CHAIN } from "./edit";
import type { Gender } from "./persona";
import type { Work } from "./remake";
import { diffWords, normWord, type TimedWord, tokens } from "./words";

const exec = promisify(execFile);
const round = (x: number, digits = 3) => Math.round(x * 10 ** digits) / 10 ** digits;
const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));
const fmt = (x: number) => String(Math.round(x * 10000) / 10000);
const hash = (value: unknown) => createHash("sha1").update(JSON.stringify(value)).digest("hex").slice(0, 10);

export const ELEVENLABS = {
  stt: "/v1/speech-to-text",
  sts: "/v1/speech-to-speech",
  tts: "/text-to-speech",
  isolation: "/v1/audio-isolation",
} as const;

/** eleven_v4 at the stability the top UGC tools use: loose enough that the tags steer the delivery, not so loose it wanders. */
export const TTS_MODEL = { model_id: "eleven_v4", voice_settings: { stability: 0.4, similarity_boost: 0.78 } } as const;

/**
 * Naive's own speech models, for when ElevenLabs on Monid is unavailable (an empty wallet):
 * OpenAI's voices for text to speech, stt/auto for speech to text. Emotion tags are not read
 * (the voice carries the delivery), and the transcript is timed by segment, not by word.
 */
export type NaiveSpeech = Pick<NaiveClient, "speak" | "fileUrl" | "uploadFile" | "transcribe" | "getTranscription">;
export const NAIVE_TTS_MODEL = "openai/gpt-audio";

/** A voice heard through a phone's speaker: the telephone band, a little presence. */
export const PHONE_EQ = "highpass=f=300,lowpass=f=3400,equalizer=f=1800:t=q:w=1:g=3";

/** Words over timed segments (Naive's speech to text times segments, not words): each segment's words spread by length. */
export function wordsFromSegments(segments: Array<{ start_seconds: number; end_seconds: number; text: string }>): TimedWord[] {
  return segments.flatMap((seg) => {
    const words = tokens(seg.text);
    const weights = words.map((w) => normWord(w).length + 1);
    const total = weights.reduce((a, b) => a + b, 0) || 1;
    const span = Math.max(0, seg.end_seconds - seg.start_seconds);
    let t = seg.start_seconds;
    return words.map((text, k) => {
      const len = (span * weights[k]) / total;
      const word = { text, start: round(t), end: round(t + len) };
      t += len;
      return word;
    });
  });
}

/** Reads tried per stretch: the one closest to the reference's length is kept (within 10% stops early). */
export const READ_TAKES = 3;

export type VoiceMode = "convert" | "fresh";

/** The voice option: the setting; "auto" converts within a gender and reads fresh across genders. */
export function voiceMode(setting: string, persona: Gender | null, reference: Gender | null): VoiceMode {
  if (setting === "convert" || setting === "fresh") return setting;
  if (setting === "auto") return persona && reference && persona !== reference ? "fresh" : "convert";
  return "fresh";
}

/**
 * A line's emotion as an eleven_v4 audio tag: "[excited]" from "[excited, smug]", "excited; smug"
 * or "[laughs]". One short tag per line (more reads as acting), letters only, so nothing else is
 * read out.
 */
export function emotionTags(raw: string | null | undefined): string {
  const tags = String(raw ?? "")
    .split(/[\],[;/]+|\band\b/i)
    .map((t) => t.replace(/[^\p{L}\s-]/gu, "").trim().toLowerCase())
    .filter((t) => t && t.length <= 20 && t.split(/\s+/).length <= 3)
    .slice(0, 1);
  return tags.map((t) => `[${t}]`).join(" ");
}

/** Tags from the reference's delivery notes, for lines the script gave no emotion ("deadpan-smug" → [deadpan] [smug]). */
export function deliveryTags(delivery: string): string {
  const at = (tag: string) => delivery.search(new RegExp(`\\b${tag.replace(/s$/, "")}`, "i"));
  const found = ["excited", "smug", "deadpan", "sarcastic", "playful", "confident", "energetic", "calm", "serious", "curious", "whispers", "laughs", "sighs"].filter((tag) => at(tag) >= 0).sort((a, b) => at(a) - at(b));
  return emotionTags(found.join(","));
}

/** The words of a speech-to-text answer, with times (spacing and audio events dropped). */
export function parseWords(output: unknown): TimedWord[] {
  const list = Array.isArray((output as { words?: unknown })?.words) ? ((output as { words: Array<Record<string, unknown>> }).words ?? []) : [];
  return list
    .filter((w) => (w.type === undefined || w.type === "word") && typeof w.text === "string" && normWord(String(w.text)) !== "")
    .map((w) => ({ text: String(w.text).trim(), start: Number(w.start), end: Number(w.end) }))
    .filter((w) => Number.isFinite(w.start) && Number.isFinite(w.end) && w.end >= w.start);
}

export type Span = { start: number; end: number; from: string; to: string };

/** Which of our words replace which reference words: each changed stretch as index ranges. */
function changes(ref: TimedWord[], ours: string[]) {
  const stretches = diffWords(
    ref.map((w) => w.text),
    ours,
  );
  const regions: Array<{ a: [number, number]; b: [number, number] }> = [];
  stretches.forEach((s, i) => {
    if (s.same) return;
    let a: [number, number] = [...s.a];
    let b: [number, number] = [...s.b];
    // An insertion has no time of its own: it borrows the word before it (or after, at the start).
    if (a[0] === a[1]) {
      const before = stretches[i - 1];
      const after = stretches[i + 1];
      if (before?.same && before.a[1] > before.a[0]) [a, b] = [[a[0] - 1, a[1]], [b[0] - 1, b[1]]];
      else if (after?.same && after.a[1] > after.a[0]) [a, b] = [[a[0], a[1] + 1], [b[0], b[1] + 1]];
      else return;
    }
    const last = regions[regions.length - 1];
    // Changes one word apart are one phrase: it reads better than two clipped ones.
    if (last && a[0] - last.a[1] <= 1) {
      last.a[1] = Math.max(last.a[1], a[1]);
      last.b[1] = Math.max(last.b[1], b[1]);
    } else regions.push({ a, b });
  });
  return regions;
}

/**
 * Where our words differ from what the reference says: each changed stretch with the time it takes
 * in the reference. A deletion has an empty `to` (that span is muted).
 */
export function changedSpans(ref: TimedWord[], ourText: string): Span[] {
  const ours = tokens(ourText);
  return changes(ref, ours).map(({ a, b }) => ({
    start: ref[a[0]].start,
    end: ref[a[1] - 1].end,
    from: ref
      .slice(a[0], a[1])
      .map((w) => w.text)
      .join(" "),
    to: ours.slice(b[0], b[1]).join(" "),
  }));
}

/**
 * Our words on the reference's clock, one per token of `ourText`: a kept word at its reference
 * time, the words of a changed stretch spread over the time they replace, by length. Captions and
 * who-says-what are timed from these. Empty when the reference has no words.
 */
export function timeOurWords(ref: TimedWord[], ourText: string): TimedWord[] {
  const ours = tokens(ourText);
  if (!ref.length) return [];
  const out: Array<TimedWord | null> = ours.map(() => null);
  for (const s of diffWords(
    ref.map((w) => w.text),
    ours,
  )) {
    if (s.same) {
      for (let k = 0; k < s.b[1] - s.b[0]; k++) out[s.b[0] + k] = { text: ours[s.b[0] + k], start: ref[s.a[0] + k].start, end: ref[s.a[0] + k].end };
      continue;
    }
    if (s.b[0] === s.b[1]) continue;
    const from = s.a[1] > s.a[0] ? ref[s.a[0]].start : (ref[s.a[0] - 1]?.end ?? ref[0].start);
    const to = s.a[1] > s.a[0] ? ref[s.a[1] - 1].end : (ref[s.a[0]]?.start ?? from + 0.3 * (s.b[1] - s.b[0]));
    const weights = ours.slice(s.b[0], s.b[1]).map((w) => normWord(w).length + 1);
    const total = weights.reduce((a, b) => a + b, 0);
    let t = from;
    weights.forEach((w, k) => {
      const len = (Math.max(to, from + 0.2) - from) * (w / total);
      out[s.b[0] + k] = { text: ours[s.b[0] + k], start: round(t), end: round(t + len) };
      t += len;
    });
  }
  // Every token is placed (same words by the reference, changed ones by their stretch).
  return out.map((w, i) => w ?? { text: ours[i], start: out[i - 1]?.end ?? 0, end: out[i - 1]?.end ?? 0 });
}

/**
 * Our words on the reference's clock, line by line: line i is timed only against the reference's
 * words in its own beat (start to end), so it is said inside that beat's shot. A faceless remake
 * cuts its footage on the reference's beats (one label or one step per shot), and a changed
 * stretch spread across two beats would put a word on the wrong shot. A beat whose reference says
 * nothing gets our words spread over it.
 */
export function timeOurLines(ref: TimedWord[], lines: Array<Pick<VoiceLine, "text" | "start" | "end">>): TimedWord[] {
  if (!ref.length) return [];
  return lines.flatMap((line) => {
    const words = tokens(line.text);
    if (!words.length) return [];
    const mine = ref.filter((w) => w.start >= line.start - 0.05 && w.start < line.end - 0.05);
    if (mine.length) return timeOurWords(mine, line.text);
    const step = Math.max(0.1, (line.end - line.start) / words.length);
    return words.map((text, k) => ({ text, start: round(line.start + k * step), end: round(line.start + (k + 1) * step) }));
  });
}

/** The reference's phrases: runs of words split at pauses of `gap` seconds or more, or at a sentence end. */
export function phrasesOf(words: TimedWord[], gap = 0.28): Array<{ from: number; to: number; start: number; end: number }> {
  const out: Array<{ from: number; to: number; start: number; end: number }> = [];
  words.forEach((w, i) => {
    const last = out[out.length - 1];
    const prev = words[i - 1];
    if (last && prev && w.start - prev.end < gap && !/[.!?]["')]*$/.test(prev.text)) {
      last.to = i + 1;
      last.end = w.end;
    } else out.push({ from: i, to: i + 1, start: w.start, end: w.end });
  });
  return out;
}

export type FitSegment = { from: number; to: number; at: number; tempo: number };

/** A phrase cut where the reference's beats change (a speaker who does not pause at a cut). */
function splitAtBeats(ref: TimedWord[], p: { from: number; to: number; start: number; end: number }, beatOf: (t: number) => number) {
  const out: Array<{ from: number; to: number; start: number; end: number }> = [];
  for (let i = p.from; i < p.to; i++) {
    const last = out[out.length - 1];
    if (last && beatOf(ref[i].start) === beatOf(ref[last.from].start)) {
      last.to = i + 1;
      last.end = ref[i].end;
    } else out.push({ from: i, to: i + 1, start: ref[i].start, end: ref[i].end });
  }
  return out;
}

/**
 * The fresh read's timing: the read cut at the reference's phrase boundaries, each piece stretched
 * (within 0.8-1.35x, so it still sounds like speech) onto the reference phrase it replaces, and
 * never overlapping the piece before. Null when too few of the read's words could be placed; the
 * caller then fits the whole read with one tempo.
 */
export function fitSegments(ref: TimedWord[], ourText: string, read: TimedWord[], lines?: Array<Pick<VoiceLine, "text" | "start" | "end">>): FitSegment[] | null {
  const ours = tokens(ourText);
  if (!ref.length || !ours.length || !read.length) return null;
  // With `lines`, a phrase never crosses a line's beat: our line i only replaces words of beat i.
  const beatOf = (t: number) => (lines ? lines.findIndex((l) => t >= l.start - 0.05 && t < l.end - 0.05) : 0);
  const phrases = lines ? phrasesOf(ref).flatMap((p) => splitAtBeats(ref, p, beatOf)) : phrasesOf(ref);
  const phraseOfRef = new Array<number>(ref.length);
  phrases.forEach((p, k) => {
    for (let i = p.from; i < p.to; i++) phraseOfRef[i] = k;
  });
  // Each of our words belongs to the reference phrase whose words it keeps or replaces.
  const phraseOf = new Array<number>(ours.length).fill(-1);
  const assign = (refIdx: number[], ourIdx: number[]) => {
    for (const s of diffWords(
      refIdx.map((i) => ref[i].text),
      ourIdx.map((j) => ours[j]),
    )) {
      const n = s.b[1] - s.b[0];
      for (let k = 0; k < n; k++) {
        const j = ourIdx[s.b[0] + k];
        if (s.same) phraseOf[j] = phraseOfRef[refIdx[s.a[0] + k]];
        else if (s.a[1] > s.a[0]) phraseOf[j] = phraseOfRef[refIdx[s.a[0] + Math.min(s.a[1] - s.a[0] - 1, Math.floor((k * (s.a[1] - s.a[0])) / n))]];
        else phraseOf[j] = phraseOfRef[refIdx[Math.max(0, s.a[0] - 1)]] ?? phraseOfRef[refIdx[0]] ?? 0;
      }
    }
  };
  if (lines) {
    // Line by line: our line's words against its own beat's reference words.
    let at = 0;
    lines.forEach((line, i) => {
      const count = tokens(line.text).length;
      const ourIdx = Array.from({ length: count }, (_, k) => at + k).filter((j) => j < ours.length);
      at += count;
      const refIdx = ref.map((_, r) => r).filter((r) => beatOf(ref[r].start) === i);
      if (ourIdx.length && refIdx.length) assign(refIdx, ourIdx);
    });
  } else {
    assign(
      ref.map((_, i) => i),
      ours.map((_, j) => j),
    );
  }
  // When each of our words is said in the read.
  const timeOf = new Array<TimedWord | null>(ours.length).fill(null);
  for (const s of diffWords(
    read.map((w) => w.text),
    ours,
  )) {
    if (s.same) for (let k = 0; k < s.b[1] - s.b[0]; k++) timeOf[s.b[0] + k] = read[s.a[0] + k];
  }
  if (timeOf.filter(Boolean).length < ours.length * 0.5) return null;
  const used = phrases
    .map((_, k) => {
      const timed = ours.map((_, j) => j).filter((j) => phraseOf[j] === k && timeOf[j]);
      return timed.length ? { k, start: timeOf[timed[0]]!.start, end: timeOf[timed[timed.length - 1]]!.end } : null;
    })
    .filter((s): s is { k: number; start: number; end: number } => Boolean(s));
  const out: FitSegment[] = [];
  let free = 0;
  used.forEach((s, i) => {
    // Cut halfway through the pause between phrases, so no breath or word end is clipped.
    const from = i === 0 ? Math.max(0, s.start - 0.05) : (used[i - 1].end + s.start) / 2;
    const to = i === used.length - 1 ? s.end + 0.12 : (s.end + used[i + 1].start) / 2;
    const target = phrases[s.k];
    const want = Math.max(0.2, target.end - target.start + (to - from - (s.end - s.start)));
    const tempo = clamp((to - from) / want, 0.8, 1.35);
    const at = Math.max(target.start - (s.start - from), free);
    out.push({ from: round(from), to: round(to), at: round(at), tempo: round(tempo, 3) });
    free = at + (to - from) / tempo;
  });
  return out;
}

/** One line of the script on the reference's clock, with how it is said. */
export type VoiceLine = { text: string; emotion: string; start: number; end: number };

/** A stretch of our words said by one voice, and what the read says (tags before each line). */
export type Run = { voiceId: string; from: number; to: number; say: string; plain: string };

/**
 * Who says what: our words in order, split where the voice changes (a stitched creator's stretch
 * is the co-host's), each run's text with every line's emotion tags in front of its first word.
 */
export function voiceRuns(lines: VoiceLine[], timed: TimedWord[], host: string, others: Array<{ start: number; end: number; voiceId: string }>, fallbackTags = ""): Run[] {
  const flat = lines.flatMap((line, beat) => tokens(line.text).map((word) => ({ word, beat })));
  const voiceAt = (i: number) => {
    const t = timed[i]?.start ?? lines[flat[i].beat].start;
    return others.find((o) => t >= o.start - 0.05 && t < o.end)?.voiceId ?? host;
  };
  const runs: Run[] = [];
  let lastBeat = -1;
  flat.forEach(({ word, beat }, i) => {
    const voiceId = voiceAt(i);
    let run = runs[runs.length - 1];
    if (!run || run.voiceId !== voiceId) {
      run = { voiceId, from: i, to: i, say: "", plain: "" };
      runs.push(run);
      lastBeat = -1;
    }
    const tags = beat !== lastBeat ? emotionTags(lines[beat].emotion) || (i === 0 ? fallbackTags : "") : "";
    lastBeat = beat;
    run.say = [run.say, tags, word].filter(Boolean).join(" ");
    run.plain = [run.plain, word].filter(Boolean).join(" ");
    run.to = i + 1;
  });
  return runs;
}

// ---------- ffmpeg ----------

/** The reference's sound, 0 to `end`, mono 44.1 kHz. */
export const extractArgs = (reference: string, end: number, out: string) => ["-hide_banner", "-nostdin", "-loglevel", "error", "-y", "-i", reference, "-t", fmt(end), "-vn", "-ac", "1", "-ar", "44100", out];

/** A spoken phrase without its leading and trailing silence. */
export const tightenArgs = (raw: string, out: string) => ["-hide_banner", "-nostdin", "-loglevel", "error", "-y", "-i", raw, "-af", "silenceremove=start_periods=1:start_threshold=-45dB:stop_periods=-1:stop_threshold=-45dB:stop_duration=0.15,aresample=44100", "-ac", "1", out];

export const tempoArgs = (input: string, tempo: number, out: string) => ["-hide_banner", "-nostdin", "-loglevel", "error", "-y", "-i", input, "-af", `atempo=${fmt(tempo)}`, out];

const mono = "aresample=44100,aformat=sample_fmts=fltp:channel_layouts=mono";
const between = (s: { start: number; end: number }, pad = 0) => `between(t,${fmt(Math.max(0, s.start - pad))},${fmt(s.end + pad)})`;

/**
 * The convert option's voice: each converted stream heard only where its voice speaks and outside
 * the changed spans, with the new phrases laid in.
 */
export function convertVoiceArgs(input: { converted: Array<{ path: string; ranges: Array<{ start: number; end: number }> | null }>; phrases: Array<{ path: string; at: number }>; mute: Array<{ start: number; end: number }>; duration: number; out: string }): string[] {
  const args = ["-hide_banner", "-nostdin", "-loglevel", "error", "-y"];
  const graph: string[] = [];
  const labels: string[] = [];
  const muted = input.mute.map((s) => between(s, 0.03)).join("+") || "0";
  input.converted.forEach((c, i) => {
    args.push("-i", c.path);
    const outside = c.ranges ? `lt(${c.ranges.map((r) => between(r)).join("+") || "0"},1)` : "0";
    graph.push(`[${i}:a]${mono},volume=enable='gt(${outside}+${muted},0)':volume=0[v${i}]`);
    labels.push(`[v${i}]`);
  });
  input.phrases.forEach((p, i) => {
    args.push("-i", p.path);
    graph.push(`[${input.converted.length + i}:a]${mono},adelay=${Math.round(p.at * 1000)}:all=1[p${i}]`);
    labels.push(`[p${i}]`);
  });
  graph.push(`${labels.join("")}amix=inputs=${labels.length}:normalize=0:duration=longest,apad,atrim=end=${fmt(input.duration)}[voice]`);
  return [...args, "-filter_complex", graph.join(";"), "-map", "[voice]", "-ar", "44100", input.out];
}

/** The fresh option's voice: each read cut into its pieces, each piece stretched and placed on its phrase. */
export function freshVoiceArgs(input: { reads: Array<{ path: string; segments: FitSegment[] }>; duration: number; out: string }): string[] {
  const args = ["-hide_banner", "-nostdin", "-loglevel", "error", "-y"];
  const graph: string[] = [];
  const labels: string[] = [];
  input.reads.forEach((read, r) => {
    args.push("-i", read.path);
    const n = read.segments.length;
    graph.push(`[${r}:a]${mono}${n > 1 ? `,asplit=${n}${read.segments.map((_, i) => `[r${r}_${i}]`).join("")}` : `[r${r}_0]`}`);
    read.segments.forEach((s, i) => {
      graph.push(`[r${r}_${i}]atrim=start=${fmt(s.from)}:end=${fmt(s.to)},asetpts=PTS-STARTPTS,atempo=${fmt(s.tempo)},adelay=${Math.round(s.at * 1000)}:all=1[s${r}_${i}]`);
      labels.push(`[s${r}_${i}]`);
    });
  });
  graph.push(`${labels.join("")}amix=inputs=${labels.length}:normalize=0:duration=longest,apad,atrim=end=${fmt(input.duration)}[voice]`);
  return [...args, "-filter_complex", graph.join(";"), "-map", "[voice]", "-ar", "44100", input.out];
}

/** A stretch of voice laid on the timeline: `seconds` of output from `from` in the file, played `speed` times as fast, at `at`. */
export type VoicePiece = { path: string; from: number; seconds: number; speed: number; at: number };

/**
 * The soundtrack: the voice pieces (Kling's own voice per render, or our read) laid at their
 * times, over the reference's bed. With `finish` (edit.ts): the voice chain, pink room tone at
 * about -50 dBFS, the bed at 0.35 ducked under the voice, and -14 LUFS; without it, a plain mix.
 */
export function soundArgs(input: { voices: VoicePiece[]; bed: string | null; duration: number; finish: boolean; out: string; voiceEq?: string }): string[] {
  const args = ["-hide_banner", "-nostdin", "-loglevel", "error", "-y"];
  const graph: string[] = [];
  const labels: string[] = [];
  const end = fmt(input.duration);
  input.voices.forEach((v, i) => {
    args.push("-i", v.path);
    const tempo = Math.abs(v.speed - 1) > 1e-3 ? `,atempo=${fmt(v.speed)}` : "";
    graph.push(`[${i}:a]${mono},atrim=start=${fmt(v.from)}:end=${fmt(v.from + v.seconds * v.speed)},asetpts=PTS-STARTPTS${tempo},adelay=${Math.round(v.at * 1000)}:all=1[p${i}]`);
    labels.push(`[p${i}]`);
  });
  if (!labels.length) {
    args.push("-f", "lavfi", "-t", end, "-i", "anullsrc=r=44100:cl=mono");
    labels.push(`[${input.voices.length}:a]`);
  }
  graph.push(`${labels.join("")}amix=inputs=${labels.length}:normalize=0:duration=longest,apad,atrim=end=${end}${input.voiceEq ? `,${input.voiceEq}` : ""}${input.finish ? `,${VOICE_CHAIN}` : ""}[vox]`);
  let voice = "[vox]";
  if (input.finish) {
    graph.push(`${roomTone(input.duration, 44100)}[room]`, `[vox][room]amix=inputs=2:normalize=0:duration=first[voice]`);
    voice = "[voice]";
  }
  if (input.bed) {
    const bedInput = args.filter((a) => a === "-i").length;
    args.push("-i", input.bed);
    if (input.finish) {
      graph.push(`${voice}asplit=2[v1][sc]`, `[${bedInput}:a]${mono},volume=${BED_LEVEL}[bed]`, `[bed][sc]${DUCK}[ducked]`, `[v1][ducked]amix=inputs=2:normalize=0:duration=first,${LOUDNESS}[mix]`);
    } else {
      graph.push(`[${bedInput}:a]${mono}[bed]`, `${voice}[bed]amix=inputs=2:normalize=0:duration=first[mix]`);
    }
  } else {
    graph.push(`${voice}${input.finish ? LOUDNESS : "anull"}[mix]`);
  }
  return [...args, "-filter_complex", graph.join(";"), "-map", "[mix]", "-ar", "44100", input.out];
}

/** The reference's bed alone would be the soundtrack's; this is the old plain mix of a voice over it. */
export const mixArgs = (input: { voice: string; bed: string | null; duration: number; out: string }) => soundArgs({ voices: [{ path: input.voice, from: 0, seconds: input.duration, speed: 1, at: 0 }], bed: input.bed, duration: input.duration, finish: false, out: input.out });

/** A take's slice of the voice, padded with silence to `seconds` (what an audio-driven presenter lip-syncs to). */
export const sliceArgs = (voice: string, start: number, length: number, seconds: number, out: string) => [
  "-hide_banner", "-nostdin", "-loglevel", "error", "-y", "-ss", fmt(start), "-t", fmt(length), "-i", voice, "-af", `${mono},apad,atrim=end=${fmt(Math.max(seconds, length))}`, "-ar", "44100", out,
];

// ---------- stems ----------

/** The Python with Demucs that `npm run setup:stems` makes (data/tools/stems), or NOMEN_STEMS_PYTHON. */
export function stemsPython(cwd = process.cwd()): string | null {
  const configured = process.env.NOMEN_STEMS_PYTHON;
  if (configured) return existsSync(configured) ? configured : null;
  const local = join(cwd, "data", "tools", "stems", "bin", "python");
  return existsSync(local) ? local : null;
}

/** Demucs' two stems (voice, and music with effects) of a WAV, in `outDir`. */
export async function demucs(python: string, input: string, outDir: string): Promise<{ voice: string; bed: string }> {
  await exec(python, ["-m", "demucs", "--two-stems=vocals", "-n", "htdemucs", "-o", outDir, input], { maxBuffer: 32 * 1024 * 1024, timeout: 15 * 60_000 });
  const model = join(outDir, "htdemucs");
  const [name] = await readdir(model);
  const voice = join(model, name, "vocals.wav");
  const bed = join(model, name, "no_vocals.wav");
  if (!existsSync(voice) || !existsSync(bed)) throw new Error("demucs wrote no stems");
  return { voice, bed };
}

// ---------- the soundtrack ----------

export type AudioRecord = {
  stems?: "demucs" | "isolation" | "none";
  voice_key?: string;
  bed_key?: string;
  words?: TimedWord[];
  mode?: VoiceMode;
  /** Converted performances by voice id (convert option). */
  converted?: Record<string, string>;
  /** Spoken phrases and reads by a hash of voice and text; reads keep their own word times. */
  phrases?: Record<string, string>;
  reads?: Record<string, { key: string; words?: TimedWord[] }>;
  ours_key?: string;
  mix_key?: string;
  made_hash?: string;
  notes?: string[];
};

export type VoiceInput = {
  reference: string;
  /** Seconds of the reference the remake covers (from 0). */
  end: number;
  /** The script, one entry per reference beat, on the reference's clock. */
  lines: VoiceLine[];
  host: string;
  /** Stretches someone else says (a stitched creator), in the co-host's voice. */
  others: Array<{ start: number; end: number; voiceId: string }>;
  mode: VoiceMode;
  /** The reference's delivery notes, for lines with no emotion of their own. */
  delivery: string;
  /** Splits voice from bed; null when Demucs is not set up. */
  separate: ((input: string, outDir: string) => Promise<{ voice: string; bed: string }>) | null;
  /** Each line timed only within its own beat (faceless remakes: one shot per line), not across the whole script. */
  byLine?: boolean;
  /** Speech through Naive's models instead of ElevenLabs on Monid; `host` is then one of its voices ("fable"). */
  naive?: NaiveSpeech;
};

export type Voice = {
  /** Our voice alone, on the reference's clock: what an audio-driven presenter lip-syncs to. */
  voice: string;
  /** The voice over the reference's bed: the soundtrack. */
  mix: string;
  bed: string | null;
  /** The reference's words, and ours, on its clock. */
  words: TimedWord[];
  ours: TimedWord[];
  notes: string[];
};


type Speaker = { run: (endpoint: string, body: Record<string, unknown>) => Promise<unknown>; transcribe: (path: string) => Promise<TimedWord[]> };

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** ElevenLabs calls through Monid, with their spend counted; with `naive`, speech to text goes through Naive instead. */
function speaker(work: Work, monid: MonidRunner, seconds: number, naive?: NaiveSpeech): Speaker {
  const minutes = round(Math.max(0.05, seconds / 60), 2);
  const run = async (endpoint: string, body: Record<string, unknown>) => {
    if (naive) throw new Error(`ElevenLabs ${endpoint} is not available while speech goes through Naive`);
    const done = await runToEnd(monid, "elevenlabs", endpoint, { body }, { pollMs: work.pollMs || 1, timeoutMs: 10 * 60_000 });
    work.spend("monid", runCostMicro(done));
    return done.output;
  };
  const transcribe = async (path: string) =>
    naive
      ? naiveTranscribe(naive, path, work.pollMs)
      : parseWords(await run(ELEVENLABS.stt, { audio_url: await work.host(path, contentType(path)), model_id: "scribe_v2", timestamps_granularity: "word", tag_audio_events: false, expected_duration_minutes: minutes }));
  return { run, transcribe };
}

/** Naive's speech to text on a local file: uploaded, transcribed (polled while it runs), words spread over its segments. */
async function naiveTranscribe(naive: NaiveSpeech, path: string, pollMs: number): Promise<TimedWord[]> {
  const bytes = await readFile(path);
  const id = await naive.uploadFile(basename(path), contentType(path), bytes);
  let job = await naive.transcribe({ file_id: id, model: "stt/auto", timestamps: true, language: "en" }, `nomen-stt-${hash([id])}`);
  for (let i = 0; (job.status === "queued" || job.status === "processing") && i < 90; i++) {
    await sleep(Math.max(1000, pollMs));
    job = await naive.getTranscription(job.id);
  }
  if (job.status !== "completed" || !job.result) throw new Error(`speech to text failed: ${job.error?.message ?? job.status}`);
  return wordsFromSegments(job.result.segments);
}

/** One read in a Naive voice, kept under `name` (as WAV). Emotion tags are dropped: the voice is not told how to act. */
async function naiveSpeak(work: Work, naive: NaiveSpeech, text: string, voice: string, name: string): Promise<string> {
  const plain = text.replace(/\[[^\]]*\]/g, " ").replace(/\s+/g, " ").trim();
  const made = await naive.speak({ text: plain, model: NAIVE_TTS_MODEL, voice, format: "wav" }, `nomen-tts-${hash([plain, voice, name])}`);
  work.spend("naive", made.cost_micro_usd ?? 0);
  const wav = name.replace(/\.mp3$/, ".wav");
  const local = join(work.dir, wav.replace(/\//g, "-"));
  await work.fetch((await naive.fileUrl(made.file.id)).url, local);
  return work.keep(wav, local, "audio/wav");
}

/**
 * The reference's sound, made once: the voice alone (Demucs, else ElevenLabs isolation), the bed
 * (Demucs only) and when each of its words is said. Every way of voicing a remake starts here.
 */
export async function referenceAudio(work: Work, monid: MonidRunner, record: AudioRecord, input: Pick<VoiceInput, "reference" | "end" | "separate" | "naive">): Promise<{ stem: string; bed: string | null; words: TimedWord[] }> {
  const notes = (record.notes ??= []);
  const { run, transcribe } = speaker(work, monid, input.end, input.naive);
  const original = join(work.dir, "original.wav");
  if (!existsSync(original)) await ffmpeg(extractArgs(input.reference, input.end, original));
  if (!record.voice_key || !(await work.local(record.voice_key))) {
    if (input.separate) {
      work.say("Splitting the reference's voice from its music and effects (Demucs)");
      const stems = await input.separate(original, join(work.dir, "stems"));
      record.voice_key = await work.keep("audio/voice-stem.wav", stems.voice, "audio/wav");
      record.bed_key = await work.keep("audio/bed.wav", stems.bed, "audio/wav");
      record.stems = "demucs";
    } else {
      work.say("No Demucs here: isolating the voice with ElevenLabs, without the music bed");
      try {
        record.voice_key = await keepLink(work, await run(ELEVENLABS.isolation, { audio_url: await work.host(original, "audio/wav"), expected_duration_minutes: round(Math.max(0.05, input.end / 60), 2) }), "audio/voice-stem.mp3");
        record.stems = "isolation";
      } catch (error) {
        record.voice_key = await work.keep("audio/original.wav", original, "audio/wav");
        record.stems = "none";
        notes.push(`voice isolation failed (${error instanceof Error ? error.message : String(error)}); the original sound was used for timings`);
      }
      record.bed_key = undefined;
      notes.push("no music bed: run `npm run setup:stems` to keep the reference's music and effects");
    }
    await work.save();
  }
  const stem = (await work.local(record.voice_key))!;
  if (!record.words) {
    record.words = (await transcribe(stem)).filter((w) => w.start < input.end);
    await work.save();
  }
  return { stem, bed: await work.local(record.bed_key), words: record.words };
}

/** The read closest to `target` seconds of speech among the kept takes (within 10% is good enough). */
export function bestRead(takes: Array<{ seconds: number }>, target: number): number {
  let best = 0;
  takes.forEach((take, i) => {
    if (Math.abs(take.seconds - target) < Math.abs(takes[best].seconds - target)) best = i;
  });
  return best;
}

/**
 * Makes (or finds) our voice: an emotional read (or the converted original) on the reference's
 * clock, alone and over the bed. `record` is the manifest's audio entry, updated as each paid step
 * lands, so a rerun pays for nothing twice.
 */
export async function makeVoice(work: Work, monid: MonidRunner, record: AudioRecord, input: VoiceInput): Promise<Voice> {
  const notes = (record.notes ??= []);
  const { run, transcribe } = speaker(work, monid, input.end, input.naive);
  const minutes = round(Math.max(0.05, input.end / 60), 2);
  const speak = async (text: string, voiceId: string, name: string) => (input.naive ? naiveSpeak(work, input.naive, text, voiceId, name) : keepLink(work, await run(ELEVENLABS.tts, { text, voice_id: voiceId, ...TTS_MODEL }), name));
  const text = input.lines.map((l) => l.text).join(" ");

  const { stem, bed, words } = await referenceAudio(work, monid, record, input);
  const ours = input.byLine ? timeOurLines(words, input.lines) : timeOurWords(words, text);
  // Converting needs the clean voice: without one it would convert the music too.
  const mode: VoiceMode = input.mode === "convert" && record.stems === "none" ? "fresh" : input.mode;
  if (mode !== input.mode && !notes.includes("no clean voice track, so the voice is a fresh read")) notes.push("no clean voice track, so the voice is a fresh read");
  record.mode = mode;

  const made = hash([mode, input.lines, input.host, input.others, record.voice_key, record.bed_key, input.end, ...(input.byLine ? ["by line"] : []), ...(input.naive ? ["naive"] : [])]);
  if (record.made_hash === made) {
    const [kept, mixed] = [await work.local(record.ours_key), await work.local(record.mix_key)];
    if (kept && mixed) return { voice: kept, mix: mixed, bed, words, ours, notes };
  }

  const voice = join(work.dir, "voice.wav");
  const runs = voiceRuns(input.lines, ours, input.host, input.others, deliveryTags(input.delivery));
  if (mode === "convert") {
    // The original performance in each speaker's voice, then the changed phrases laid in.
    record.converted ??= {};
    const converted: Array<{ path: string; ranges: Array<{ start: number; end: number }> | null }> = [];
    for (const voiceId of [...new Set(runs.map((r) => r.voiceId))]) {
      if (!record.converted[voiceId] || !(await work.local(record.converted[voiceId]))) {
        work.say("Converting the reference's voice to the persona's (speech-to-speech)");
        record.converted[voiceId] = await keepLink(work, await run(ELEVENLABS.sts, { audio_url: await work.host(stem, contentType(stem)), voice_id: voiceId, model_id: "eleven_multilingual_sts_v2", expected_duration_minutes: minutes }), `audio/converted-${hash(voiceId)}.mp3`);
        await work.save();
      }
      const mine = runs.filter((r) => r.voiceId === voiceId).map((r) => ({ start: ours[r.from]?.start ?? 0, end: ours[r.to - 1]?.end ?? input.end }));
      converted.push({ path: (await work.local(record.converted[voiceId]))!, ranges: runs.length > 1 ? mine : null });
    }
    const spans = changedSpans(words, text);
    const phrases: Array<{ path: string; at: number }> = [];
    record.phrases ??= {};
    for (const [i, span] of spans.entries()) {
      if (!span.to) continue;
      const at = ours.findIndex((w) => w.start >= span.start - 0.01);
      const runOf = runs.find((r) => at >= r.from && at < r.to) ?? runs[0];
      const beat = input.lines.findIndex((l) => span.start >= l.start - 0.01 && span.start < l.end);
      const say = `${emotionTags(input.lines[beat]?.emotion)} ${span.to}`.trim();
      const id = hash([runOf?.voiceId ?? input.host, say]);
      if (!record.phrases[id] || !(await work.local(record.phrases[id]))) {
        record.phrases[id] = await speak(say, runOf?.voiceId ?? input.host, `audio/phrase-${id}.mp3`);
        await work.save();
      }
      const tight = join(work.dir, `phrase${i}-tight.wav`);
      await ffmpeg(tightenArgs((await work.local(record.phrases[id]))!, tight));
      const have = (await probe(tight)).duration || span.end - span.start;
      const fitted = join(work.dir, `phrase${i}-fit.wav`);
      await ffmpeg(tempoArgs(tight, clamp(have / (span.end - span.start + 0.06), 0.7, 1.6), fitted));
      phrases.push({ path: fitted, at: span.start });
    }
    await ffmpeg(convertVoiceArgs({ converted, phrases, mute: spans, duration: input.end, out: voice }));
  } else {
    // An emotional read per speaker (the best of three, by length), each phrase put on the reference's timing.
    record.reads ??= {};
    const reads: Array<{ path: string; segments: FitSegment[] }> = [];
    for (const r of runs) {
      const first = ours[r.from];
      const last = ours[r.to - 1];
      const refRun = first && last ? words.filter((w) => w.start >= first.start - 0.02 && w.end <= last.end + 0.02) : [];
      const target = refRun.length ? refRun[refRun.length - 1].end - refRun[0].start : (last?.end ?? input.end) - (first?.start ?? 0);
      const takes: Array<{ key: string; words: TimedWord[]; seconds: number }> = [];
      for (let k = 0; k < READ_TAKES; k++) {
        const id = hash([r.voiceId, r.say, k]);
        let entry = record.reads[id];
        if (!entry || !(await work.local(entry.key))) {
          work.say(`Reading ${r.to - r.from} words in the persona's voice, with the reference's emotion (take ${k + 1})`);
          entry = record.reads[id] = { key: await speak(r.say, r.voiceId, `audio/read-${id}.mp3`) };
          await work.save();
        }
        if (!entry.words) {
          entry.words = await transcribe((await work.local(entry.key))!);
          await work.save();
        }
        const said = entry.words.length ? entry.words[entry.words.length - 1].end - entry.words[0].start : 0;
        takes.push({ key: entry.key, words: entry.words, seconds: said });
        if (target > 0 && Math.abs(said - target) <= target * 0.1) break;
      }
      const take = takes[bestRead(takes, target)];
      const path = (await work.local(take.key))!;
      // Line by line when one voice reads the whole script (a faceless remake's narrator).
      let segments = fitSegments(refRun, r.plain, take.words, input.byLine && runs.length === 1 ? input.lines.filter((l) => tokens(l.text).length) : undefined);
      if (!segments) {
        // The read could not be lined up word by word: one tempo for all of it, from the first word.
        const at = refRun[0]?.start ?? first?.start ?? input.lines.find((l) => l.text.trim())?.start ?? 0;
        const until = refRun[refRun.length - 1]?.end ?? last?.end ?? input.end;
        const readFrom = take.words[0]?.start ?? 0;
        const readTo = take.words[take.words.length - 1]?.end ?? (await probe(path)).duration;
        segments = [{ from: Math.max(0, readFrom - 0.05), to: readTo + 0.1, at, tempo: clamp((readTo - readFrom) / Math.max(0.5, until - at), 0.8, 1.35) }];
        notes.push(`a read of ${r.to - r.from} words was fitted with one tempo, not phrase by phrase`);
      }
      reads.push({ path, segments });
    }
    if (!reads.length) throw new Error("the script has no words to say");
    await ffmpeg(freshVoiceArgs({ reads, duration: input.end, out: voice }));
  }
  const mix = join(work.dir, "voice-mix.wav");
  await ffmpeg(mixArgs({ voice, bed, duration: input.end, out: mix }));
  record.ours_key = await work.keep("audio/voice.wav", voice, "audio/wav");
  record.mix_key = await work.keep("audio/voice-mix.wav", mix, "audio/wav");
  record.made_hash = made;
  await work.save();
  return { voice, mix, bed, words, ours, notes };
}

// ---------- a presenter's own voice ----------

/** What the manifest keeps for one render's own voice: its words, the matched copy, and its fingerprint. */
export type RenderVoice = { words?: TimedWord[]; matched_key?: string; matched_voice?: string; stats?: { pitch_hz: number | null; level_db: number }; matched_stats?: { pitch_hz: number | null; level_db: number } };

/** A clip's sound as mono 44.1 kHz WAV. */
export const clipAudioArgs = (clip: string, out: string) => ["-hide_banner", "-nostdin", "-loglevel", "error", "-y", "-i", clip, "-vn", "-ac", "1", "-ar", "44100", out];

/** Decoded mono samples of an audio file, for the voice fingerprint (16 kHz is plenty for pitch). */
export async function samplesOf(path: string, rate = 16000): Promise<Float32Array> {
  const { stdout } = await exec(await ffmpegBin(), ["-hide_banner", "-loglevel", "error", "-i", path, "-ac", "1", "-ar", String(rate), "-f", "f32le", "pipe:1"], { encoding: "buffer", maxBuffer: 64 * 1024 * 1024 });
  const bytes = stdout as unknown as Buffer;
  return new Float32Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.length / 4));
}

/**
 * One render's own voice: what it says and when (speech-to-text, for the captions and the fit),
 * and, when asked, the same performance passed through speech-to-speech into the persona's one
 * voice, which keeps the render's timing so the lips still match. Returns the audio to use.
 */
export async function renderVoice(work: Work, monid: MonidRunner, record: RenderVoice, input: { clip: string; id: string; matchVoice: string | null; voiceStats: (samples: Float32Array, rate: number) => { pitch_hz: number | null; level_db: number } }): Promise<{ audio: string; words: TimedWord[] }> {
  const raw = join(work.dir, `${input.id}-voice.wav`);
  await ffmpeg(clipAudioArgs(input.clip, raw));
  const seconds = (await probe(raw)).duration || 10;
  const { run, transcribe } = speaker(work, monid, seconds);
  if (!record.words) {
    record.words = await transcribe(raw);
    await work.save();
  }
  record.stats ??= input.voiceStats(await samplesOf(raw), 16000);
  if (!input.matchVoice) return { audio: raw, words: record.words };
  if (record.matched_voice !== input.matchVoice || !(await work.local(record.matched_key))) {
    const output = await run(ELEVENLABS.sts, { audio_url: await work.host(raw, "audio/wav"), voice_id: input.matchVoice, model_id: "eleven_multilingual_sts_v2", expected_duration_minutes: round(Math.max(0.05, seconds / 60), 2) });
    record.matched_key = await keepLink(work, output, `audio/${input.id}-matched-${hash(input.matchVoice)}.mp3`);
    record.matched_voice = input.matchVoice;
    record.matched_stats = undefined;
    await work.save();
  }
  const matched = (await work.local(record.matched_key))!;
  record.matched_stats ??= input.voiceStats(await samplesOf(matched), 16000);
  return { audio: matched, words: record.words };
}

const contentType = (path: string) => (path.endsWith(".mp3") ? "audio/mpeg" : "audio/wav");

/** Downloads a run's audio link and keeps it under `name`; returns the key. */
async function keepLink(work: Work, output: unknown, name: string): Promise<string> {
  const link = outputLink(output, "audio");
  if (!link) throw new Error(`ElevenLabs returned no audio for ${name}`);
  const local = join(work.dir, name.replace(/\//g, "-"));
  await work.fetch(link, local);
  return work.keep(name, local, contentType(name));
}
