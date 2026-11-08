// The narrator (ported from ED Studio's tools/narrate.py): one clip per beat, cached by a hash of the voice and the
// text, word times read from the audio, and the clips laid end to end into voice.wav. Build reels are carried by a fast
// narrator and show ONE word at a time, so every word needs a time.
//
// Voices: ElevenLabs through Monid (Adam, the narrator ED Studio's build videos use) or the free scratch voice (macOS
// `say`). Monid's text-to-speech returns audio without per-character times, so both are timed the way narrate.py times
// its scratch voice: phrase edges snap to the pauses found in the audio, words split each phrase by syllables.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { ApiError } from "../http";
import { download, ffmpegPath } from "../media";
import { type MonidRunner, outputLink, runCostMicro, runToEnd } from "../monid";
import type { NaiveClient } from "../naive";
import type { Files } from "../store/types";
import { TTS_MODEL } from "../creative/dub";
import { norm, untag } from "./layout";
import type { CodeAdBeat, Voiced } from "./types";

export const SR = 44100;

/**
 * ElevenLabs "Adam", ED Studio's narrator. The default is his crisp read (eleven_multilingual_v2 at speed 1.12, ED Studio's
 * first settings: about 3 words a second before any stretch); ADAM_V3 is the dramatic eleven_v3 read with audio tags
 * ([shouting]) that ED Studio's meme reels use, slower (about 2.1 words a second).
 */
export const ADAM = { voiceId: "pNInz6obpgDQGcFmaJgB", model: "eleven_multilingual_v2", settings: { stability: 0.35, similarity_boost: 0.8, style: 0.45, use_speaker_boost: true, speed: 1.12 } };
export const ADAM_V3 = { voiceId: "pNInz6obpgDQGcFmaJgB", model: "eleven_v3", settings: { stability: 0.0, similarity_boost: 0.8 } };
/** Models that read ElevenLabs audio tags ("[excited]"); any other reads them aloud, so they are dropped first. */
const TAG_MODELS = /^eleven_v[34]/;

/** Naive's own text-to-speech (OpenAI's gpt-audio models): the narrator when Monid cannot pay for ElevenLabs. */
export const NAIVE_VOICE = { model: "openai/gpt-audio", voice: "ash", speed: 1.12 };

export type Narrator =
  | { kind: "eleven"; monid: MonidRunner; voiceId?: string; model?: string; settings?: Record<string, number | boolean> }
  | { kind: "naive"; naive: Pick<NaiveClient, "speak" | "fileUrl">; model?: string; voice?: string; speed?: number }
  | { kind: "scratch"; voice?: string; rate?: number };

export type NarrateOptions = {
  narrator: Narrator;
  /** Where clips are kept between runs (the store's files): "<prefix>/voice/…". */
  files: Files;
  prefix: string;
  /** Scratch space for this run. */
  dir: string;
  /** The length the narration should come to (speech only); clips are sped up (pitch kept) by up to 1.3x to fit. */
  targetSeconds?: number;
  lead?: number;
  gap?: number;
  tail?: number;
  log?: (message: string) => void;
};

const hash = (value: unknown) => createHash("sha1").update(JSON.stringify(value)).digest("hex").slice(0, 10);

async function run(bin: string, args: string[], stdin?: Buffer): Promise<Buffer> {
  return new Promise((done, fail) => {
    const child = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    let err = "";
    child.stdout.on("data", (c: Buffer) => out.push(c));
    child.stderr.on("data", (c: Buffer) => (err = (err + c.toString("utf8")).slice(-800)));
    child.on("error", fail);
    child.on("close", (code) => (code === 0 ? done(Buffer.concat(out)) : fail(new Error(`${bin} failed (${code}): ${err.trim().slice(0, 300)}`))));
    if (stdin) child.stdin.end(stdin);
    else child.stdin.end();
  });
}

/** Any audio file as mono float samples at SR; tempo > 1 speeds speech up without changing its pitch. */
export async function decode(path: string, tempo = 1): Promise<Float32Array> {
  const ffmpeg = await ffmpegPath();
  if (!ffmpeg) throw new Error("ffmpeg is needed to time the narration");
  const af = Math.abs(tempo - 1) > 1e-3 ? ["-af", `atempo=${tempo.toFixed(4)}`] : [];
  const raw = await run(ffmpeg, ["-v", "error", "-i", path, ...af, "-ac", "1", "-ar", String(SR), "-f", "s16le", "-"]);
  const pcm = new Int16Array(raw.buffer, raw.byteOffset, Math.floor(raw.length / 2));
  return Float32Array.from(pcm, (v) => v / 32768);
}

export function syllables(token: string): number {
  const w = norm(token);
  if (!w) return 0.5;
  if (/^\d+$/.test(w)) return 1.6 * w.length + (w.length > 2 ? 1 : 0);   // "625" ~ "six hundred twenty five"
  let n = (w.match(/[aeiouy]+/g) ?? []).length;
  if (w.endsWith("e") && n > 1 && !w.endsWith("le")) n--;
  return Math.max(1, n);
}

/** Word times for a clip: phrase edges snap to the pauses found in the audio; words split each phrase by syllables. */
export function estimateWords(text: string, x: Float32Array): Array<{ w: string; t0: number; t1: number }> {
  const toks = text.split(/\s+/).filter(Boolean);
  const n = x.length;
  if (!toks.length || !n) return [];
  const win = Math.round(0.01 * SR);
  const csum = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) csum[i + 1] = csum[i] + x[i] * x[i];
  const quiet = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - (win >> 1)), b = Math.min(n, i + (win >> 1) + 1);
    const e = Math.sqrt((csum[b] - csum[a]) / win) + 1e-9;
    quiet[i] = 20 * Math.log10(e) < -38 ? 1 : 0;
  }
  // quiet runs >= 70 ms = candidate pauses (their middles)
  const runs: Array<[number, number, number]> = [];
  for (let i = 0; i < n; ) {
    if (!quiet[i]) { i++; continue; }
    let j = i;
    while (j < n && quiet[j]) j++;
    if ((j - i) / SR >= 0.07 && i > 0 && j < n) runs.push([(i + j) / 2 / SR, i / SR, j / SR]);
    i = j;
  }
  const floor = 10 ** (-46 / 20);
  let first = -1, last = -1;
  for (let i = 0; i < n; i++) if (Math.abs(x[i]) > floor) { if (first < 0) first = i; last = i; }
  const s0 = first >= 0 ? first / SR : 0, dur = first >= 0 ? last / SR : n / SR;
  const pauses = runs.filter((r) => s0 < r[0] && r[0] < dur);
  const phrases: number[][] = [];
  let cur: number[] = [];
  toks.forEach((tok, k) => {
    cur.push(k);
    if (/[,.;:!?]$/.test(tok) && k < toks.length - 1) (phrases.push(cur), (cur = []));
  });
  if (cur.length) phrases.push(cur);
  const weights = phrases.map((p) => p.reduce((s, k) => s + syllables(toks[k]), 0));
  const total = weights.reduce((a, b) => a + b, 0);
  const bounds: Array<[number, number]> = [];
  const used = new Set<number>();
  let acc = 0;
  for (const w of weights.slice(0, -1)) {
    acc += w;
    const guess = s0 + (acc / total) * (dur - s0);
    let best = -1;
    pauses.forEach((r, k) => { if (!used.has(k) && (best < 0 || Math.abs(r[0] - guess) < Math.abs(pauses[best][0] - guess))) best = k; });
    if (best >= 0 && Math.abs(pauses[best][0] - guess) < 0.9) (used.add(best), bounds.push([pauses[best][1], pauses[best][2]]));
    else bounds.push([guess, guess]);
  }
  const spans: Array<[number, number]> = [];
  let start = s0;
  for (const b of bounds) (spans.push([start, b[0]]), (start = b[1]));
  spans.push([start, dur]);
  const out: Array<{ w: string; t0: number; t1: number }> = [];
  phrases.forEach((p, i) => {
    const [a, b] = spans[i];
    const sw = p.map((k) => syllables(toks[k]));
    const tot = sw.reduce((s, v) => s + v, 0);
    let t = a;
    p.forEach((k, j) => {
      const d = ((b - a) * sw[j]) / tot;
      out.push({ w: toks[k], t0: Math.round(t * 1000) / 1000, t1: Math.round((t + d) * 1000) / 1000 });
      t += d;
    });
  });
  return out;
}

/** Cuts a clip's leading and trailing silence and shifts its word times to match. */
export function trimClip(x: Float32Array, words: Array<{ w: string; t0: number; t1: number }>, pad = 0.04) {
  const floor = 10 ** (-46 / 20);
  let first = -1, last = -1;
  for (let i = 0; i < x.length; i++) if (Math.abs(x[i]) > floor) { if (first < 0) first = i; last = i; }
  if (first < 0) return { x, words };
  const a = Math.max(0, first - Math.round(pad * SR)), b = Math.min(x.length, last + Math.round(pad * SR));
  const off = a / SR;
  return { x: x.subarray(a, b), words: words.map((w) => ({ w: w.w, t0: Math.max(0, w.t0 - off), t1: Math.max(0, w.t1 - off) })) };
}

/**
 * Shortens the pauses inside a clip (a breath between two sentences) to `keep` seconds: pauses longer than `longer`
 * seconds, quieter than -40 dBFS over 10 ms, never at the clip's edges. A slow voice reads faster without a harder stretch.
 */
export function compressPauses(x: Float32Array, longer = 0.22, keep = 0.12): Float32Array {
  const win = Math.round(0.01 * SR), floor = 10 ** (-40 / 20);
  const loud = new Uint8Array(Math.ceil(x.length / win));
  for (let w = 0; w < loud.length; w++) {
    let peak = 0;
    for (let i = w * win; i < Math.min(x.length, (w + 1) * win); i++) peak = Math.max(peak, Math.abs(x[i]));
    loud[w] = peak > floor ? 1 : 0;
  }
  const first = loud.indexOf(1), last = loud.lastIndexOf(1);
  if (first < 0) return x;
  const cuts: Array<[number, number]> = [];
  for (let w = first; w <= last; ) {
    if (loud[w]) { w++; continue; }
    let e = w;
    while (e <= last && !loud[e]) e++;
    if ((e - w) * win >= longer * SR) cuts.push([(w * win) + Math.round(keep * SR / 2), (e * win) - Math.round(keep * SR / 2)]);
    w = e;
  }
  if (!cuts.length) return x;
  const parts: Float32Array[] = [];
  let at = 0;
  for (const [a, b] of cuts) (parts.push(x.subarray(at, a)), (at = b));
  parts.push(x.subarray(at));
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) (out.set(p, o), (o += p.length));
  return out;
}

export function wavBytes(x: Float32Array, rate = SR): Buffer {
  const data = Buffer.alloc(x.length * 2);
  for (let i = 0; i < x.length; i++) data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, x[i])) * 32767), i * 2);
  const head = Buffer.alloc(44);
  head.write("RIFF", 0);
  head.writeUInt32LE(36 + data.length, 4);
  head.write("WAVE", 8);
  head.write("fmt ", 12);
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(1, 22);
  head.writeUInt32LE(rate, 24);
  head.writeUInt32LE(rate * 2, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write("data", 36);
  head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}

/** One beat's clip on this machine, made (and paid for) once: kept as "<prefix>/voice/<provider>-<id>-<hash>.<ext>". */
async function clip(beat: CodeAdBeat, options: NarrateOptions): Promise<{ path: string; text: string; spend: number; fresh: boolean }> {
  const { narrator, files, prefix, dir } = options;
  if (narrator.kind === "eleven") {
    const voiceId = narrator.voiceId ?? ADAM.voiceId, model = narrator.model ?? ADAM.model, settings = narrator.settings ?? (model === ADAM_V3.model ? ADAM_V3.settings : ADAM.settings);
    const text = TAG_MODELS.test(model) ? beat.say.trim() : untag(beat.say);
    const key = `${prefix}/voice/eleven-${beat.id}-${hash([voiceId, model, settings, text])}.mp3`;
    if (await files.exists(key)) return { path: await files.localPath(key), text, spend: 0, fresh: false };
    const speak = (body: Record<string, unknown>) => runToEnd(narrator.monid, "elevenlabs", "/text-to-speech", { body }, { pollMs: 1000, timeoutMs: 5 * 60_000 });
    // eleven_v3 is ED Studio's dramatic Adam; when the provider refuses it, Nomen's own model (dub.ts) reads instead.
    const done = await speak({ text, voice_id: voiceId, model_id: model, voice_settings: settings }).catch((error: unknown) => {
      if (model === TTS_MODEL.model_id || (error instanceof ApiError && error.retryable)) throw error;
      options.log?.(`ElevenLabs refused ${model} (${error instanceof Error ? error.message : String(error)}); reading with ${TTS_MODEL.model_id}`);
      return speak({ text, voice_id: voiceId, ...TTS_MODEL });
    });
    const link = outputLink(done.output, "audio");
    if (!link) throw new Error(`ElevenLabs returned no audio for beat "${beat.id}"`);
    const local = join(dir, `eleven-${beat.id}.mp3`);
    await download(link, local);
    await files.putFile(key, local, "audio/mpeg");
    return { path: await files.localPath(key), text, spend: runCostMicro(done), fresh: true };
  }
  if (narrator.kind === "naive") {
    const model = narrator.model ?? NAIVE_VOICE.model, voice = narrator.voice ?? NAIVE_VOICE.voice, speed = narrator.speed ?? NAIVE_VOICE.speed;
    const text = untag(beat.say);
    const key = `${prefix}/voice/naive-${beat.id}-${hash([model, voice, speed, text])}.wav`;
    if (await files.exists(key)) return { path: await files.localPath(key), text, spend: 0, fresh: false };
    const speech = (await narrator.naive.speak({ text, model, voice, speed }, `${prefix}-${beat.id}-${hash([model, voice, speed, text])}`)) as { file?: { id?: string }; cost_micro_usd?: number | null };
    const fileId = speech.file?.id;
    if (!fileId) throw new ApiError("naive", 502, "no_file", `text-to-speech returned no file for beat "${beat.id}"`);
    const local = join(dir, `naive-${beat.id}.wav`);
    await download((await narrator.naive.fileUrl(fileId)).url, local);
    await files.putFile(key, local, "audio/wav");
    return { path: await files.localPath(key), text, spend: speech.cost_micro_usd ?? 0, fresh: true };
  }
  const text = beat.say.trim();
  const voice = narrator.voice ?? "Eddy (English (US))", rate = narrator.rate ?? 240;
  const spoken = untag(text);
  const key = `${prefix}/voice/scratch-${beat.id}-${hash([voice, rate, spoken])}.aiff`;
  if (await files.exists(key)) return { path: await files.localPath(key), text, spend: 0, fresh: false };
  const local = join(dir, `scratch-${beat.id}.aiff`);
  await run("say", ["-v", voice, "-r", String(rate), "-o", local, spoken]);
  await files.putFile(key, local, "audio/aiff");
  return { path: await files.localPath(key), text, spend: 0, fresh: true };
}

/**
 * Voices every beat (cached), times its words, fits the whole read to `targetSeconds` (a faster tempo, pitch kept) and
 * lays the clips end to end: lead + clip + gap + clip … + tail. Writes voice.wav into `dir`.
 */
export async function narrate(beats: CodeAdBeat[], options: NarrateOptions): Promise<{ voiced: Voiced; voicePath: string; spendMicro: number; tempo: number; fresh: number }> {
  await mkdir(options.dir, { recursive: true });
  // tight joins between beats keep the pace up; the tail holds the ending (the url on the wall screen) to read
  const lead = options.lead ?? 0.04, gap = options.gap ?? 0.03, tail = options.tail ?? 1.25;
  const clips = [];
  let spendMicro = 0, fresh = 0;
  for (const beat of beats) {
    const c = await clip(beat, options);
    spendMicro += c.spend;
    fresh += c.fresh ? 1 : 0;
    clips.push({ beat, ...c });
  }
  // How fast: as read, unless the read runs past the target (ElevenLabs' Adam reads ~2.9 words/s; ED Studio speeds him up 1.15-1.3x).
  // Pauses inside a line are shortened first; then the read is sped up (pitch kept) to fit, at most 1.3x (1.38x for
  // Naive's voice, which reads about 2 words a second whatever speed it is asked for).
  const plain = await Promise.all(clips.map(async (c) => trimClip(compressPauses(await decode(c.path)), []).x.length / SR));
  const speech = plain.reduce((a, b) => a + b, 0);
  const room = (options.targetSeconds ?? speech) - lead - tail - gap * Math.max(0, clips.length - 1);
  const cap = options.narrator.kind === "naive" ? 1.38 : 1.3;
  const tempo = Math.round(Math.min(cap, Math.max(1, speech / Math.max(1, room))) * 1000) / 1000;
  let t = lead;
  const chunks: Float32Array[] = [new Float32Array(Math.round(lead * SR))];
  const out: Voiced["beats"] = [];
  for (const [i, c] of clips.entries()) {
    const x0 = compressPauses(await decode(c.path, tempo));
    const spoken = untag(c.text);
    const { x, words } = trimClip(x0, estimateWords(spoken, x0));
    const L = x.length / SR;
    out.push({ id: c.beat.id, t0: Math.round(t * 1000) / 1000, t1: Math.round((t + L) * 1000) / 1000, words: words.map((w) => ({ w: w.w, t0: Math.round((t + w.t0) * 1000) / 1000, t1: Math.round((t + w.t1) * 1000) / 1000 })) });
    chunks.push(x, new Float32Array(Math.round((i + 1 < clips.length ? gap : tail) * SR)));
    t += L + (i + 1 < clips.length ? gap : tail);
  }
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const audio = new Float32Array(total);
  let at = 0;
  for (const c of chunks) (audio.set(c, at), (at += c.length));
  const voicePath = join(options.dir, "voice.wav");
  await writeFile(voicePath, wavBytes(audio));
  options.log?.(`narration: ${options.narrator.kind === "eleven" ? "ElevenLabs" : options.narrator.kind === "naive" ? "Naive text-to-speech" : "scratch voice"}, ${clips.length} beats (${fresh} newly voiced), tempo ${tempo}x, ${(total / SR).toFixed(1)} s`);
  return { voiced: { provider: options.narrator.kind, duration: Math.round((total / SR) * 1000) / 1000, beats: out }, voicePath, spendMicro, tempo, fresh };
}

/** A kept narration (words.json) read back, so a restart does not voice or pay again. */
export async function readVoiced(path: string): Promise<Voiced | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as Voiced;
  } catch {
    return null;
  }
}
