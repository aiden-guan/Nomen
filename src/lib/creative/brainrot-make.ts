// The brainrot maker: one video from its script, each piece paid for once and kept by key, so a
// restart, a crash or a busy provider costs time, not money.
//
//   voice lines (ElevenLabs on Monid, cents) ─► shot lengths ─► music and sound effects (Monid, cents)
//   ─► characters and stills (Naive image model) ─► clips (a Naive video model, silent use)
//   ─► QC of every clip (vision; one re-render for a failed clip) ─► the cut ─► QC of the cut
//
// Video renders through Naive (Veo 3.1 Lite by default): Monid's wallet is shared and small, so it
// is only used for the audio. The cost guard compares what is spent plus what is left with the cap
// before every paid step; the video model's real price per second is measured on its first clip.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { ApiError } from "../http";
import { download, extractFrames, ffmpegPath, probe, scratchDir } from "../media";
import { type MonidRunner, outputLink, runCostMicro, runToEnd } from "../monid";
import type { NaiveClient } from "../naive";
import { QC_MODEL } from "../qc";
import { extractJson } from "../research";
import type { Files } from "../store/types";
import { type BrainrotScript, type BrainrotSfx, PRICES, planBrainrot, RECIPES, shotSeconds, videoSeconds } from "./brainrot";
import { buildCut, renderCut, shotDurations, SLOWEST } from "./brainrot-cut";
import { jobFile } from "./presenter";
import { OverBudget, patient } from "./remake";
import type { ProductBrief } from "./types";

const exec = promisify(execFile);

export { OverBudget, videoSeconds };

export type BrainrotDeps = {
  naive: Pick<NaiveClient, "message" | "generateImage" | "fileUrl" | "generateVideo" | "getMediaJob" | "speak" | "generateMusic" | "generateSoundEffect">;
  /**
   * ElevenLabs through Monid: the voice, the music and the sound effects, for cents. Without it, or
   * once its wallet refuses a call, Naive's own speech, music and sound-effect models make them.
   */
  monid: MonidRunner | null;
  files: Files;
  fetchUrl?: (url: string, path: string) => Promise<void>;
};

export type BrainrotInput = {
  /** Keys go under `<prefix>/brainrot/…`; the cut is `<prefix>/final.mp4` ("crv_…"). */
  prefix: string;
  script: BrainrotScript;
  product: ProductBrief;
  site: string;
  /** A Naive video model ("google/veo-3.1-lite"). */
  videoModel: string;
  /** A Naive image model for the stills; Naive's default when unset. */
  imageModel?: string;
  /** USD per second assumed for the video model until its first clip says what it really costs. */
  videoPerSecond?: number;
  maxUsd: number;
  /** Idempotency prefix for paid calls. */
  idem: string;
  /** Vision checks of the clips and the cut (default on). */
  qc?: boolean;
  /** Stop after the first clip, with the video model's measured price (the live test's probe). */
  probe?: boolean;
  /** Cut it again from the kept pieces (and check the new cut), after the cut itself changed. */
  recut?: boolean;
  /** The end card: the mascot with the site over it (default), or the product's own page. */
  endCard?: "mascot" | "page";
  pollMs?: number;
  onEvent?: (message: string) => void;
};

export type ClipCheck = { n: number; pass: boolean; issues: string[]; fix: string };
export type CutCheck = { score: number; safe: boolean; issues: string[] };

export type BrainrotShotView = { n: number; status: "pending" | "rendering" | "rendered" | "failed"; seconds: number; still_key: string | null; cost_micro: number; error: string | null };

export type BrainrotResult = {
  key: string | null;
  poster_key: string | null;
  path: string | null;
  duration: number;
  spend: { naive_micro: number; monid_micro: number };
  /** USD per second the video model was billed, measured on the clips. */
  per_second: number | null;
  qc: CutCheck | null;
  notes: string[];
  shots: BrainrotShotView[];
};

type ClipRecord = { job?: string; key?: string; renders?: number; seconds?: number; cost_micro?: number; error?: string; check?: ClipCheck; fixed?: boolean };

type Manifest = {
  version: 1;
  spend: { naive_micro: number; monid_micro: number };
  voice: Record<string, { key: string; seconds: number }>;
  music: { bed?: string; hype?: string };
  characters: Record<string, { key: string; file_id: string }>;
  stills: Record<string, { key: string; file_id: string }>;
  clips: Record<string, ClipRecord>;
  /** The video model's price per second, from its finished clips. */
  measured?: { per_second: number; seconds: number; micro: number };
  checked?: boolean;
  final?: { key: string; poster?: string; duration: number };
  qc?: CutCheck;
  notes: string[];
};

/** The sound effects every brainrot video can use, kept once for all of them. */
export const sfxKey = (name: BrainrotSfx) => `brainrot/sfx/${name}.mp3`;

/** How each sound effect is asked for (ElevenLabs sound generation; the chant is a shouted voice line). */
export const SFX_PROMPTS: Record<BrainrotSfx, { text: string; seconds: number }> = {
  vine_boom: { text: "Vine boom meme sound effect: one huge deep bass boom with a short reverb tail", seconds: 1.5 },
  bass_drop: { text: "Massive distorted 808 bass drop hit, bass boosted meme sound", seconds: 2 },
  airhorn: { text: "MLG air horn blast, three quick loud stabs", seconds: 1.6 },
  record_scratch: { text: "Vinyl record scratch, the music stops", seconds: 1 },
  whoosh: { text: "Fast cinematic whoosh transition", seconds: 0.8 },
  ding: { text: "Bright notification ding", seconds: 0.8 },
  crowd_ohh: { text: "Small crowd going ooooh in surprise", seconds: 1.8 },
  sad_violin: { text: "Tiny sad violin sting, comedic and over the top", seconds: 2.5 },
  cash: { text: "Cash register ka-ching", seconds: 1 },
  explosion: { text: "Huge cartoon explosion boom with debris raining down", seconds: 1.8 },
  aura_up: { text: "Anime power-up aura whoosh with a rising shimmering synth", seconds: 1.6 },
  six_seven: { text: "SIX SEVEN!", seconds: 1.2 },
};
/** Naive's speech models, tried in order when Monid can't read a line, and how long each may take. */
export const NAIVE_SPEECH = ["openai/gpt-audio", "openai/gpt-audio-mini", "tts/auto"] as const;
export const SPEECH_TIMEOUT_MS = 60_000;

/** A promise that gives up after `ms` (the call itself may still finish in the background). */
export function within<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ApiError("naive", 504, "timeout", `${label} took longer than ${Math.round(ms / 1000)} s`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** The voice that shouts the 6-7 chant (an intense, yelling voice on the account). */
export const CHANT_VOICE = "g4ucswVjPpazgbDDe327";

/** The end card's picture: the product's own home page as a phone shows it, else any screenshot or big photo. */
export function endVisual(product: ProductBrief): ProductBrief["visuals"][number] | null {
  const shots = product.visuals.filter((v) => v.kind === "screenshot");
  return shots.find((v) => /capture:mobile:\/$/.test(v.source)) ?? shots[0] ?? product.visuals.find((v) => v.kind === "photo" && (v.width ?? 0) >= 400) ?? null;
}

const VOICE_SETTINGS = { stability: 0.35, similarity_boost: 0.75 };

/** A voice line cut to the speech (ElevenLabs reads have air at both ends), played `tempo` times faster with its pitch kept. */
export async function tighten(input: string, out: string, tempo = 1) {
  const bin = await ffmpegPath();
  if (!bin) return input;
  const quiet = "silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.05";
  // Pauses inside the line are cut to 0.3 s: some voices read every full stop as a long beat.
  const pauses = "silenceremove=stop_periods=-1:stop_duration=0.3:stop_threshold=-42dB";
  const faster = Math.abs(tempo - 1) > 0.01 ? `,atempo=${Math.min(2, Math.max(0.5, tempo)).toFixed(3)}` : "";
  await exec(bin, ["-hide_banner", "-nostdin", "-loglevel", "error", "-y", "-i", input, "-af", `${quiet},areverse,${quiet},areverse,${pauses}${faster}`, "-ar", "44100", "-ac", "1", out]);
  return out;
}

/** A stand-in sound effect drawn by ffmpeg, when ElevenLabs can't make one. */
async function synthSfx(name: BrainrotSfx, out: string) {
  const bin = await ffmpegPath();
  if (!bin) throw new Error("ffmpeg is not available");
  const src: Partial<Record<BrainrotSfx, string>> = {
    vine_boom: "aevalsrc='0.9*sin(2*PI*55*t*(1-0.25*t))*exp(-3*t)':d=1.5",
    bass_drop: "aevalsrc='0.9*sin(2*PI*(95-40*t)*t)*exp(-1.1*t)':d=2",
    explosion: "anoisesrc=d=1.6:c=brown:a=0.9,afade=t=out:st=0.1:d=1.5",
    airhorn: "aevalsrc='0.3*(sin(2*PI*440*t)+sin(2*PI*554*t)+sin(2*PI*659*t))*lt(mod(t,0.5),0.38)':d=1.5",
    ding: "aevalsrc='0.6*sin(2*PI*1318*t)*exp(-6*t)':d=0.8",
  };
  await exec(bin, ["-hide_banner", "-nostdin", "-loglevel", "error", "-y", "-f", "lavfi", "-i", src[name] ?? "anoisesrc=d=0.8:c=pink:a=0.5,afade=t=in:d=0.3,afade=t=out:st=0.4:d=0.4", "-ac", "1", "-ar", "44100", out]);
}

const CHECK_TOOL = {
  name: "clip_checks",
  description: "Record the verdict for every clip.",
  input_schema: {
    type: "object",
    required: ["shots"],
    properties: {
      shots: {
        type: "array",
        items: {
          type: "object",
          required: ["n", "pass", "issues", "fix"],
          properties: { n: { type: "integer" }, pass: { type: "boolean" }, issues: { type: "array", items: { type: "string" } }, fix: { type: "string", description: "If it fails: one sentence to add to the clip's prompt that avoids the problem. Else ''." } },
        },
      },
    },
  },
};

const CUT_TOOL = {
  name: "cut_check",
  description: "Record the verdict on the finished video.",
  input_schema: {
    type: "object",
    required: ["score", "safe", "issues"],
    properties: { score: { type: "integer", description: "1-10" }, safe: { type: "boolean" }, issues: { type: "array", items: { type: "string" } } },
  },
};

/** What must never be on screen, for both checks. */
const OFF_LIMITS =
  "a real or recognizable person (a celebrity, streamer, politician or any real face); someone else's known character (Tung Tung Tung Sahur, Tralalero Tralala, Skibidi Toilet, cartoon, game or anime characters) or another brand's logo; anything sexual or nude; gore or injury; a stunt that reads as suicide, self-harm or a fatal fall";

/**
 * Makes one brainrot video. Resumable from its manifest; a busy provider throws a retryable
 * ApiError and the next run picks up where this one stopped.
 */
export async function makeBrainrot(deps: BrainrotDeps, input: BrainrotInput): Promise<BrainrotResult> {
  const naive = patient(deps.naive);
  const { files } = deps;
  const prefix = `${input.prefix}/brainrot`;
  const manifestKey = `${prefix}/manifest.json`;
  const dir = join(scratchDir(), `brainrot-${input.prefix.replace(/[^\w.-]+/g, "-")}`);
  await mkdir(dir, { recursive: true });
  const say = (message: string) => input.onEvent?.(message);
  const pollMs = input.pollMs ?? 8000;
  const fetchTo = deps.fetchUrl ?? download;
  const script = input.script;
  const recipe = RECIPES[script.bit];
  const plan = planBrainrot(script);
  const loaded = (await files.exists(manifestKey)) ? (JSON.parse(await readFile(await files.localPath(manifestKey), "utf8")) as Partial<Manifest>) : {};
  const manifest: Manifest = { version: 1, spend: { naive_micro: 0, monid_micro: 0 }, voice: {}, music: {}, characters: {}, stills: {}, clips: {}, notes: [], ...(loaded.version === 1 ? loaded : {}) };
  let saving = Promise.resolve();
  const persist = () =>
    (saving = saving.then(async () => {
      const path = join(dir, "manifest.json");
      await writeFile(path, JSON.stringify(manifest));
      await files.putFile(manifestKey, path, "application/json");
    }));
  const keep = async (name: string, path: string, type: string) => {
    const key = `${prefix}/${name}`;
    await files.putFile(key, path, type);
    return key;
  };
  const local = async (key: string | null | undefined) => {
    if (!key) return null;
    if (existsSync(key)) return key;
    if (!(await files.exists(key))) return null;
    const path = await files.localPath(key).catch(() => null);
    return path && existsSync(path) ? path : null;
  };
  const spent = () => (manifest.spend.naive_micro + manifest.spend.monid_micro) / 1e6;
  const note = (text: string) => {
    if (!manifest.notes.includes(text)) manifest.notes.push(text);
  };
  const perSecond = () => manifest.measured?.per_second ?? input.videoPerSecond ?? 0.15;

  // ---------- the cost guard ----------
  const planned = (n: number) => {
    const shot = script.shots[n - 1];
    const voice = manifest.voice[String(n)];
    return voice ? voice.seconds + 0.34 : shotSeconds(shot, recipe);
  };
  const left = () => {
    // A probe only pays for the voice, the characters and the first shot's still and clip.
    const probing = Boolean(input.probe && !manifest.measured);
    const shots = script.shots;
    const pictured = probing ? shots.slice(0, 1) : shots;
    const chars = shots.filter((s) => s.words && !manifest.voice[String(s.n)]).reduce((sum, s) => sum + s.words.length + recipe.voice.tags.length, 0) + (script.end.line && !manifest.voice.end ? script.end.line.length : 0);
    const total = shots.reduce((sum, s) => sum + planned(s.n), 0) + 3;
    const musicSeconds = probing ? 0 : (manifest.music.bed ? 0 : total + 2) + (script.music.turn && !manifest.music.hype ? total / 2 : 0);
    const images = plan.characters.filter((c) => !manifest.characters[c.id]).length + pictured.filter((s) => !manifest.stills[String(s.n)]).length;
    const clips = pictured.filter((s) => !manifest.clips[String(s.n)]?.key).reduce((sum, s) => sum + videoSeconds(input.videoModel, (planned(s.n) + 0.2) / SLOWEST), 0);
    const checks = input.qc === false || probing ? 0 : (manifest.checked ? 0 : 1) + (manifest.qc ? 0 : 1);
    return (chars / 1000) * PRICES.ttsPerK + (musicSeconds / 60) * PRICES.musicPerMin + images * PRICES.image + clips * perSecond() + checks * PRICES.call;
  };
  const guard = (step: string) => {
    const ahead = left();
    if (spent() + ahead > input.maxUsd + 1e-6) throw new OverBudget(`brainrot ${step}: $${spent().toFixed(2)} spent + about $${ahead.toFixed(2)} to go is over the $${input.maxUsd.toFixed(2)} cap`);
  };

  // ---------- audio: ElevenLabs on Monid, else Naive's own models ----------
  let monidOut = !deps.monid;
  const eleven = async (endpoint: string, body: Record<string, unknown>, name: string): Promise<string | null> => {
    if (monidOut || !deps.monid) return null;
    try {
      const done = await runToEnd(deps.monid, "elevenlabs", endpoint, { body }, { pollMs: Math.min(pollMs, 2000), timeoutMs: 6 * 60_000 });
      manifest.spend.monid_micro += runCostMicro(done);
      const link = outputLink(done.output, "audio");
      if (!link) throw new ApiError("monid", 502, "no_audio", `ElevenLabs ${endpoint} returned no audio for ${name}`);
      const raw = join(dir, `${name.replace(/\//g, "-")}-raw.mp3`);
      await fetchTo(link, raw);
      return raw;
    } catch (error) {
      // An empty wallet is not this video's fault: the rest of its audio comes from Naive.
      if (!(error instanceof ApiError && (error.outOfCredits || error.status === 402))) throw error;
      monidOut = true;
      note("Monid's wallet was empty, so some of the audio was made with Naive's models");
      return null;
    }
  };
  const naiveAudio = async (made: { file: { id: string; name?: string; content_type?: string }; cost_micro_usd: number | null }, name: string) => {
    manifest.spend.naive_micro += made.cost_micro_usd ?? 0;
    const ext = /wav/.test(made.file.content_type ?? made.file.name ?? "") ? "wav" : "mp3";
    const path = join(dir, `${name.replace(/\//g, "-")}-raw.${ext}`);
    await fetchTo((await naive.fileUrl(made.file.id)).url, path);
    return path;
  };
  // Naive's speech, model by model: a request that hangs is left after a minute for the next model
  // rather than retried for half an hour (two lines of the first funnel take hung that way).
  const naiveSpeech = async (text: string, name: string, voice: string) => {
    let last: unknown = null;
    for (const [i, model] of NAIVE_SPEECH.entries()) {
      try {
        const made = await within(deps.naive.speak({ text, model, ...(model.startsWith("openai/") ? { voice } : {}) }, `${input.idem}-${name}-m${i}`), SPEECH_TIMEOUT_MS, `${model} speech`);
        return await naiveAudio(made, name);
      } catch (error) {
        if (error instanceof ApiError && error.outOfCredits) throw error;
        last = error;
      }
    }
    throw last instanceof Error ? last : new Error(`no speech model could read ${name}`);
  };
  const speech = async (text: string, name: string, voice: { eleven: string; tags: string; naive: string; settings?: Record<string, number> }) =>
    (await eleven("/text-to-speech", { text: `${voice.tags} ${text}`.trim(), voice_id: voice.eleven, model_id: "eleven_v4", voice_settings: voice.settings ?? VOICE_SETTINGS }, name)) ?? naiveSpeech(text, name, voice.naive);
  const music = async (prompt: string, seconds: number, name: string) =>
    (await eleven("/v1/music", { prompt: `${prompt}. Instrumental, no vocals.`, music_length_ms: Math.round(seconds * 1000), model_id: "music_v1", force_instrumental: true }, name)) ??
    naiveAudio(await naive.generateMusic({ prompt: `${prompt}. Instrumental, no vocals.`, length_seconds: Math.round(seconds), instrumental: true }, `${input.idem}-${name}`), name);
  const effect = async (name: BrainrotSfx) => {
    const prompt = SFX_PROMPTS[name];
    if (name === "six_seven") return speech(prompt.text, `sfx-${name}`, { eleven: CHANT_VOICE, tags: "[shouting]", naive: "verse", settings: { stability: 0.2, similarity_boost: 0.7 } });
    return (
      (await eleven("/v1/sound-generation", { text: prompt.text, duration_seconds: prompt.seconds, prompt_influence: 0.6 }, `sfx-${name}`)) ??
      naiveAudio(await naive.generateSoundEffect({ prompt: prompt.text, duration_seconds: prompt.seconds }, `brainrot-sfx-${name}`), `sfx-${name}`)
    );
  };

  guard("before starting");

  // 1. The voice, one line per shot and the end line, so every shot is as long as what is said over it.
  const lines = [...script.shots.filter((s) => s.words).map((s) => ({ id: String(s.n), text: s.words })), ...(script.end.line ? [{ id: "end", text: script.end.line }] : [])];
  await pool(lines, 3, async ({ id, text }) => {
    if (manifest.voice[id] && (await local(manifest.voice[id].key))) return;
    const raw = await speech(text, `voice-${id}`, { eleven: recipe.voice.id, tags: recipe.voice.tags, naive: recipe.voice.naive });
    const tight = await tighten(raw, join(dir, `voice-${id}.wav`), recipe.voice.tempo);
    const seconds = (await probe(tight)).duration;
    manifest.voice[id] = { key: await keep(`voice-${id}${tight.endsWith(".wav") ? ".wav" : ".mp3"}`, tight, tight.endsWith(".wav") ? "audio/wav" : "audio/mpeg"), seconds };
    await persist();
  });
  say(`voice: ${lines.length} lines (${monidOut ? `Naive's ${recipe.voice.naive}, Monid was out` : recipe.voice.name})`);

  const voiceOf = async (id: string) => {
    const v = manifest.voice[id];
    const path = v ? await local(v.key) : null;
    return path ? { path, seconds: v!.seconds } : null;
  };
  const shotVoices = await Promise.all(script.shots.map((s) => (s.words ? voiceOf(String(s.n)) : Promise.resolve(null))));
  const durations = shotDurations({ script, shots: shotVoices.map((voice) => ({ clip: "", voice })) });

  // 2. Characters drawn once, then every shot's still from them (Naive's image model).
  const image = async (name: string, prompt: string, refs: string[], idem: string) => {
    const urls = await Promise.all(refs.map(async (fileId) => (await naive.fileUrl(fileId)).url));
    const made = await naive.generateImage({ prompt, aspect_ratio: "9:16", ...(input.imageModel ? { model: input.imageModel } : {}), ...(urls.length ? { image_urls: urls } : {}) }, idem);
    manifest.spend.naive_micro += made.cost_micro_usd ?? 0;
    const file = made.files[0];
    if (!file) throw new ApiError("naive", 502, "no_file", `the image for ${name} came back empty`);
    const path = join(dir, `${name}.png`);
    await fetchTo((await naive.fileUrl(file.id)).url, path);
    return { key: await keep(`${name}.png`, path, "image/png"), file_id: file.id };
  };
  guard("before the pictures");
  for (const c of plan.characters) {
    if (manifest.characters[c.id] && (await local(manifest.characters[c.id].key))) continue;
    manifest.characters[c.id] = await image(`character-${c.id}`, c.prompt, [], `${input.idem}-char-${c.id}`);
    await persist();
  }
  const wanted = input.probe ? plan.shots.slice(0, 1) : plan.shots;
  await pool(wanted, 3, async (shot) => {
    const id = String(shot.n);
    if (manifest.stills[id] && (await local(manifest.stills[id].key))) return;
    manifest.stills[id] = await image(`still-${id}`, shot.still, shot.refs.map((ref) => manifest.characters[ref]?.file_id).filter((f): f is string => Boolean(f)), `${input.idem}-still-${id}`);
    await persist();
  });
  say(`pictures: ${plan.characters.length} characters, ${wanted.length} stills`);

  // 3. The clips, on a Naive video model, from each still. The first one finished sets the price.
  const render = async (n: number, extra = "") => {
    const id = String(n);
    const rec = (manifest.clips[id] ??= {});
    // Clips may be slowed down to fill their shot (SLOWEST), so a 4.6 s shot takes a 4 s clip, not a 6 s one.
    const seconds = videoSeconds(input.videoModel, (durations[n - 1] + 0.2) / SLOWEST);
    if (!rec.job) {
      guard(`before clip ${n}`);
      const still = manifest.stills[id];
      const prompt = [plan.shots[n - 1].clip, extra].filter(Boolean).join(" ");
      const job = await naive.generateVideo({ model: input.videoModel, prompt, seconds, aspect_ratio: "9:16", image_urls: [(await naive.fileUrl(still.file_id)).url] }, `${input.idem}-clip-${id}-r${(rec.renders ?? 0) + 1}`);
      rec.job = job.id;
      rec.renders = (rec.renders ?? 0) + 1;
      rec.seconds = seconds;
      rec.error = undefined;
      await persist();
    }
    for (;;) {
      const job = await naive.getMediaJob(rec.job);
      const file = jobFile(job);
      if (job.status === "completed" && file) {
        const cost = job.cost_micro_usd ?? 0;
        manifest.spend.naive_micro += cost;
        rec.cost_micro = (rec.cost_micro ?? 0) + cost;
        if (cost > 0) {
          const m = manifest.measured ?? { per_second: 0, seconds: 0, micro: 0 };
          m.seconds += rec.seconds ?? seconds;
          m.micro += cost;
          m.per_second = m.micro / 1e6 / Math.max(1, m.seconds);
          manifest.measured = m;
        }
        const path = join(dir, `clip-${id}-r${rec.renders}.mp4`);
        await fetchTo((await naive.fileUrl(file)).url, path);
        rec.key = await keep(`clip-${id}.mp4`, path, "video/mp4");
        rec.job = undefined;
        await persist();
        return;
      }
      if (job.status === "failed" || job.status === "completed") {
        manifest.spend.naive_micro += job.cost_micro_usd ?? 0;
        rec.error = job.error?.message ?? "the render failed";
        rec.job = undefined;
        await persist();
        if ((rec.renders ?? 0) >= 2) throw new Error(`clip ${n}: ${rec.error}`);
        return render(n, extra);
      }
      await sleep(pollMs);
    }
  };
  const renderAll = async (shots: number[]) =>
    pool(shots, 3, async (n) => {
      if (!(await local(manifest.clips[String(n)]?.key))) await render(n);
    });
  // The first clip alone, so the guard knows the model's real price before the rest are paid for.
  if (!manifest.measured) await renderAll([1]);
  if (input.probe) return result(null, null, 0);
  guard("after pricing the video model");

  // 4. Music and sound effects (cents), while the clips render.
  const total = durations.reduce((a, b) => a + b, 0) + 3.5;
  const audio = (async () => {
    const audioType = (path: string) => (path.endsWith(".wav") ? "audio/wav" : "audio/mpeg");
    if (!(manifest.music.bed && (await local(manifest.music.bed)))) {
      const raw = await music(script.music.style || "dumb catchy meme beat", Math.min(60, Math.max(10, total + 1.5)), "music-bed");
      manifest.music.bed = await keep(`music-bed.${raw.split(".").pop()}`, raw, audioType(raw));
      await persist();
    }
    if (script.bit === "melodrama" && script.music.turn && script.music.hype && !(manifest.music.hype && (await local(manifest.music.hype)))) {
      const after = durations.slice(script.music.turn - 1).reduce((a, b) => a + b, 0) + 4;
      const raw = await music(script.music.hype, Math.min(60, Math.max(8, after)), "music-hype");
      manifest.music.hype = await keep(`music-hype.${raw.split(".").pop()}`, raw, audioType(raw));
      await persist();
    }
    for (const name of neededSfx(script)) {
      if (await files.exists(sfxKey(name))) continue;
      try {
        const raw = await effect(name);
        await files.putFile(sfxKey(name), raw, audioType(raw));
      } catch (error) {
        if (error instanceof ApiError && (error.retryable || error.outOfCredits)) throw error;
        const out = join(dir, `sfx-${name}.wav`);
        await synthSfx(name, out);
        await files.putFile(sfxKey(name), out, "audio/wav");
        note(`the ${name.replace(/_/g, " ")} sound is a stand-in (${error instanceof Error ? error.message : String(error)})`);
      }
    }
    await persist();
  })();
  await Promise.all([renderAll(script.shots.map((s) => s.n)), audio]);
  say(`clips: ${script.shots.length} on ${input.videoModel} (about $${perSecond().toFixed(3)} a second)`);

  // 5. Every clip checked once; a failed one is rendered again with the check's fix.
  if (input.qc !== false && !manifest.checked) {
    const checks = await checkClips(naive, script, input.product.name, await Promise.all(script.shots.map(async (s) => (await local(manifest.clips[String(s.n)]?.key))!)));
    manifest.spend.naive_micro += Math.round(PRICES.call * 1e6) * Math.ceil(script.shots.length / CLIPS_PER_CHECK);
    for (const check of checks) {
      const rec = manifest.clips[String(check.n)];
      if (rec) rec.check = check;
    }
    const failed = checks.filter((c) => !c.pass);
    for (const check of failed) {
      const rec = manifest.clips[String(check.n)];
      if (!rec || rec.fixed) continue;
      // The first render stays kept until a new one lands; the new one is paid for only if it fits.
      const again = videoSeconds(input.videoModel, (durations[check.n - 1] + 0.2) / SLOWEST) * perSecond();
      if (spent() + left() + again > input.maxUsd + 1e-6) {
        note(`clip ${check.n} failed its check (${check.issues.join("; ")}) and was kept: no budget left to render it again`);
        continue;
      }
      rec.fixed = true;
      await persist();
      say(`clip ${check.n} failed its check (${check.issues.join("; ")}); rendering it again`);
      try {
        await render(check.n, check.fix);
      } catch (error) {
        if (error instanceof ApiError && (error.retryable || error.outOfCredits)) throw error;
        note(`clip ${check.n}: its second render failed (${error instanceof Error ? error.message : String(error)}); the first is kept`);
      }
    }
    manifest.checked = true;
    await persist();
  }

  // 6. The cut, kept by key.
  const finalKey = `${input.prefix}/final.mp4`;
  if (input.recut && manifest.final) {
    manifest.final = undefined;
    manifest.qc = undefined;
  }
  let finalPath = manifest.final ? await local(manifest.final.key) : null;
  if (!finalPath) {
    // The mascot card keeps the brainrot energy at the punchline, and a site screenshot can carry
    // other companies' logos (monid.ai's "give this to your agent" row failed the final check).
    const mascot = script.characters.map((c) => manifest.characters[c.id]).find(Boolean) ?? manifest.stills[String(script.shots.length)];
    let endImage = input.endCard !== "page" && mascot ? await local(mascot.key) : null;
    const visual = endImage ? null : endVisual(input.product);
    if (visual) endImage = (await local(visual.key)) ?? (existsSync(visual.url) ? visual.url : null);
    if (visual && !endImage && /^https:\/\//.test(visual.url)) {
      endImage = join(dir, "end-card.png");
      await fetchTo(visual.url, endImage).catch(() => (endImage = null));
    }
    if (!endImage) note("no screenshot of the product for the end card: the video ends on its last shot");
    const sfx: Partial<Record<BrainrotSfx, string>> = {};
    for (const name of neededSfx(script)) {
      const path = await local(sfxKey(name));
      if (path) sfx[name] = path;
    }
    const cut = buildCut({
      script,
      shots: await Promise.all(
        script.shots.map(async (s, i) => {
          const clip = (await local(manifest.clips[String(s.n)]?.key))!;
          return { clip, voice: shotVoices[i], length: (await probe(clip)).duration || undefined };
        }),
      ),
      endVoice: await voiceOf("end"),
      endImage,
      endAnchor: visual ? "top" : "center",
      music: { bed: await local(manifest.music.bed), hype: await local(manifest.music.hype) },
      sfx,
      site: input.site,
    });
    const out = join(dir, "final.mp4");
    say(`cutting ${cut.duration.toFixed(1)} s: ${cut.texts.length} texts, ${cut.sounds.length} sounds, ${cut.fx.length} effects`);
    await renderCut(cut, out, { workDir: dir });
    say("cut done");
    await files.putFile(finalKey, out, "video/mp4");
    const poster = join(dir, "poster.jpg");
    const bin = await ffmpegPath();
    let posterKey: string | undefined;
    if (bin) {
      await exec(bin, ["-hide_banner", "-loglevel", "error", "-y", "-ss", String(Math.min(1, cut.duration / 3)), "-i", out, "-frames:v", "1", "-q:v", "3", poster]);
      posterKey = `${input.prefix}/poster.jpg`;
      await files.putFile(posterKey, poster, "image/jpeg");
    }
    manifest.final = { key: finalKey, poster: posterKey, duration: cut.duration };
    await persist();
    finalPath = out;
  }

  // 7. The cut checked as a viewer sees it.
  if (input.qc !== false && !manifest.qc) {
    manifest.qc = await checkCut(naive, script, input.product.name, input.site, finalPath);
    manifest.spend.naive_micro += Math.round(PRICES.call * 1e6);
    await persist();
  }
  return result(manifest.final?.key ?? null, finalPath, manifest.final?.duration ?? 0);

  function result(key: string | null, path: string | null, duration: number): BrainrotResult {
    return {
      key,
      poster_key: manifest.final?.poster ?? null,
      path,
      duration,
      spend: { ...manifest.spend },
      per_second: manifest.measured?.per_second ?? null,
      qc: manifest.qc ?? null,
      notes: [...manifest.notes, ...Object.entries(manifest.clips).flatMap(([n, c]) => (c.check && !c.check.pass ? [`clip ${n}: ${c.check.issues.join("; ")}`] : []))],
      shots: script.shots.map((s) => {
        const c = manifest.clips[String(s.n)];
        return {
          n: s.n,
          status: c?.key ? "rendered" : c?.job ? "rendering" : c?.error && (c.renders ?? 0) >= 2 ? "failed" : "pending",
          seconds: durations[s.n - 1],
          still_key: manifest.stills[String(s.n)]?.key ?? null,
          cost_micro: c?.cost_micro ?? 0,
          error: c?.error ?? null,
        };
      }),
    };
  }
}

/** The sound effects a script uses, plus the ones the cut always adds. */
export function neededSfx(script: BrainrotScript): BrainrotSfx[] {
  const set = new Set<BrainrotSfx>(script.shots.flatMap((s) => s.sfx));
  set.add("vine_boom");
  if (script.bit === "melodrama" && script.music.turn) set.add("record_scratch");
  if (script.shots.some((s) => /6\s*-\s*7|six\s+seven/i.test(`${s.stamp} ${s.words}`))) set.add("six_seven");
  return [...set];
}

/** Two frames of every clip to a vision model: fails only what breaks the rules or the shot. */
/** Clips per check: two frames each, and Naive takes at most 12 images in one request. */
export const CLIPS_PER_CHECK = 6;

/** Two frames of every clip to a vision model, six clips a call: fails only what breaks the rules or the shot. */
export async function checkClips(naive: Pick<NaiveClient, "message">, script: BrainrotScript, productName: string, clips: string[]): Promise<ClipCheck[]> {
  const out: ClipCheck[] = [];
  for (let first = 0; first < clips.length; first += CLIPS_PER_CHECK) {
    const batch = clips.slice(first, first + CLIPS_PER_CHECK);
    const content: unknown[] = [];
    for (const [k, clip] of batch.entries()) {
      const i = first + k;
      const frames = await extractFrames(clip, 2, 360);
      content.push({ type: "text", text: `Clip ${i + 1}: ${script.shots[i].frame} ${script.shots[i].motion}` });
      for (const frame of frames) content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: frame.toString("base64") } });
    }
    content.push({
      type: "text",
      text: [
        `These are two frames from each of ${batch.length} AI clips (numbered as above) for a deliberately absurd "brainrot" meme ad for ${productName}. Looking AI-made, cartoonish, ugly or unhinged is intended: do not fail anything for that.`,
        `Fail a clip only for: ${OFF_LIMITS}; readable or garbled text, letters, captions or logos drawn into the picture; a human being as a main character (characters are animals, food, objects and robots); a clip that does not show its scene at all, or is frozen, blank or melted beyond recognition.`,
        "Call clip_checks once with every clip, by its number.",
      ].join("\n"),
    });
    const reply = await naive.message({ model: QC_MODEL, max_tokens: 2500, messages: [{ role: "user", content }], tools: [CHECK_TOOL] });
    const raw = (reply.content.find((b) => b.type === "tool_use" && b.name === CHECK_TOOL.name)?.input ?? extractJson(reply.content.map((b) => b.text ?? "").join("\n"))) as { shots?: Array<Partial<ClipCheck>> } | null;
    out.push(
      ...(raw?.shots ?? [])
        .map((s) => ({ n: Number(s.n), pass: s.pass !== false, issues: Array.isArray(s.issues) ? s.issues.filter((x): x is string => typeof x === "string") : [], fix: typeof s.fix === "string" ? s.fix : "" }))
        .filter((s) => s.n > first && s.n <= first + batch.length),
    );
  }
  return out;
}

/** Eight frames of the cut to a vision model: is it safe, is the product readable, does the bit land. */
export async function checkCut(naive: Pick<NaiveClient, "message">, script: BrainrotScript, productName: string, site: string, path: string): Promise<CutCheck> {
  const frames = await extractFrames(path, 8, 360);
  const reply = await naive.message({
    model: QC_MODEL,
    max_tokens: 1500,
    messages: [
      {
        role: "user",
        content: [
          ...frames.map((frame) => ({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: frame.toString("base64") } })),
          {
            type: "text",
            text: [
              `Eight frames, in order, of a finished deliberately-terrible "brainrot" meme ad for ${productName} (${site}), the ${RECIPES[script.bit].name} format. Absurd, cringe and AI-looking is the point.`,
              `safe is false if any frame shows: ${OFF_LIMITS}.`,
              `Score 1-10: does it read as a real brainrot meme a viewer would watch to the end, is the meme text readable, and is ${productName} clearly the punchline with ${site} readable at the end? List the concrete problems.`,
              "Call cut_check once.",
            ].join("\n"),
          },
        ],
      },
    ],
    tools: [CUT_TOOL],
  });
  const raw = (reply.content.find((b) => b.type === "tool_use" && b.name === CUT_TOOL.name)?.input ?? extractJson(reply.content.map((b) => b.text ?? "").join("\n"))) as Partial<CutCheck> | null;
  const score = Number(raw?.score);
  return { score: score >= 1 && score <= 10 ? Math.round(score) : 0, safe: raw?.safe !== false, issues: Array.isArray(raw?.issues) ? raw.issues.filter((x): x is string => typeof x === "string").slice(0, 8) : [] };
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** Runs `task` over `items`, `limit` at a time; the first busy-provider error (else the first error) is thrown once all settle. */
async function pool<T>(items: T[], limit: number, task: (item: T) => Promise<void>) {
  let next = 0;
  const errors: unknown[] = [];
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++];
      await task(item).catch((error: unknown) => void errors.push(error));
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  if (errors.length) throw errors.find((error) => error instanceof ApiError && error.retryable) ?? errors[0];
}
