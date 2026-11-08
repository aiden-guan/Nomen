// The presenter step of a remake: the model that re-performs one take on camera. It is one
// interface so the model can be swapped without touching the rest of the remake (segments, layout,
// graphics, captions, stems, the cost guard and the internal guardrail stay as they are):
//
//   renderPresenter(work, presenter, take input, record) → a clip of the take, kept by key
//
// What a presenter takes, it says in `needs`: the twin frame (our persona in the reference's
// composition), the reference's own footage of the take (motion-driven models), and our voice for
// the take (audio-driven models, which lip-sync to it). The voice is always made first, so an
// audio-driven model gets it as an input. `voice` says whose voice ends up in the clip: none (a
// silent clip under our soundtrack), ours (lip-synced to the audio it was given) or its own (it
// speaks the line itself, and the soundtrack uses the clip's audio for that take).
//
// Implementations here:
//   kling-native   Kling 3.0 image-to-video on Monid with its own voice (the default: it won the
//                  head-to-head). The twin frame is the first frame; the reference's cuts inside a
//                  render become its multi-shot list, so one render, one voice, covers up to 15 s.
//   kling-motion   Kling 3.0 Motion Control on Monid: the reference's own footage drives the motion,
//                  the clip is silent and the soundtrack is our voice.
//   naive:<model>  a Naive video model that animates the twin frame and speaks the line (Veo 3.1).
// A new one only needs `submit` and `poll`.

import { join } from "node:path";

import { ApiError } from "../http";
import { type MonidRunner, outputLink, providerFailed, runCostMicro, runError, TERMINAL } from "../monid";
import type { MediaJob, NaiveClient } from "../naive";
import type { Gender } from "./persona";
import { creatorDirection, emotionArc, NO_TEXT, SAFE } from "./plan";
import type { Work } from "./remake";

/** One of the reference's shots inside a render: how long it runs and what the person does in it. */
export type PresenterShot = { seconds: number; framing: string; action: string };

export type PresenterInput = {
  /** The take's length on the reference's clock; the clip is cut back to it. */
  seconds: number;
  /** The clip's aspect ratio, one of the presenter's `ratios`. */
  ratio: string;
  /** Rendered on flat green, to be keyed (a cut-out inset). */
  green: boolean;
  persona: { description: string; gender: Gender | null; portraitUrl: string };
  /** The twin frame: our persona in the reference's composition, pose and size (a public link). */
  frameUrl: string | null;
  /** The reference's own footage of the take, cropped like the frame (motion-driven presenters). */
  motionUrl: string | null;
  /** Our voice for the take alone, no music, on the take's clock (audio-driven presenters). */
  audioUrl: string | null;
  /** The words of the take and how they are said (presenters that speak for themselves); "" for a listener. */
  line: string;
  /** The line's audio tags, in order ("[excited] [smug]"), which become its emotion arc in words. */
  emotion: string;
  /** What the presenter does: the reference's motion in plain body terms. */
  action: string;
  /** The reference's shots inside this render (one for a single continuous take). */
  shots: PresenterShot[];
};

export type PresenterJob = { provider: "monid" | "naive"; id: string };
export type PresenterPoll = { status: "running" } | { status: "done"; url: string; cost_micro: number } | { status: "failed"; error: string; retryable: boolean; cost_micro: number };

export type Presenter = {
  name: string;
  needs: { frame: boolean; motion: boolean; audio: boolean };
  voice: "none" | "ours" | "own";
  /** Whether one render can span the reference's cuts as shots (otherwise one render per continuous take). */
  multiShot: boolean;
  /** Aspect ratios it renders; the remake cuts each take's crop to the nearest. */
  ratios: readonly string[];
  /** USD per billed second, and the shortest and longest clip it renders. */
  price: { perSecond: number; minSeconds: number; maxSeconds: number };
  submit(input: PresenterInput, idempotencyKey: string): Promise<PresenterJob>;
  poll(job: PresenterJob): Promise<PresenterPoll>;
};

const subject = (gender: Gender | null) => (gender === "female" ? "She" : gender === "male" ? "He" : "They");

// ---------- Kling 3.0 Motion Control (Monid) ----------

export const KLING_MOTION_ENDPOINT = "/v1/video/kling-3.0-motion-control";

export function klingMotionPrompt(gender: Gender | null, green: boolean): string {
  return `${subject(gender)} performs exactly the same motion, gestures, expressions and mouth movements as the person in the video, in the same framing, ${green ? "in front of the same flat green screen" : "on the same set"}.`;
}

/** The twin frame is who, the reference clip is how they move. */
export function klingMotionBody(input: Pick<PresenterInput, "frameUrl" | "motionUrl" | "persona" | "green">) {
  return {
    media: [
      { type: "image", url: input.frameUrl },
      { type: "video", url: input.motionUrl },
    ],
    character_orientation: "video",
    resolution: "1080p",
    audio: "off",
    prompt: klingMotionPrompt(input.persona.gender, input.green),
  };
}

/** A finished Monid run, as a presenter poll. */
export function monidPoll(run: Parameters<typeof runCostMicro>[0], label: string): PresenterPoll {
  if (!TERMINAL.has(run.status)) return { status: "running" };
  const cost = runCostMicro(run);
  const url = run.status === "COMPLETED" && !providerFailed(run) ? outputLink(run.output, "video") : null;
  if (url) return { status: "done", url, cost_micro: cost };
  const error = run.status === "COMPLETED" ? new ApiError("monid", 502, "no_video", `${label}: finished without a video`) : runError(run, label);
  return { status: "failed", error: error.message, retryable: error.retryable, cost_micro: cost };
}

export function klingMotion(monid: MonidRunner): Presenter {
  return {
    name: "kling-motion",
    needs: { frame: true, motion: true, audio: false },
    voice: "none",
    multiShot: false,
    ratios: ["9:16", "2:3", "3:4", "4:5", "1:1", "5:4", "4:3", "3:2", "16:9"],
    // Measured on Monid at 1080p; it renders 3-30 s of motion.
    price: { perSecond: 0.168, minSeconds: 3, maxSeconds: 30 },
    async submit(input) {
      if (!input.frameUrl || !input.motionUrl) throw new Error("kling-motion needs the twin frame and the motion clip");
      const run = await monid.run("kling", KLING_MOTION_ENDPOINT, { body: klingMotionBody(input) });
      if (!run?.runId) throw new ApiError("monid", 502, "no_run", "Kling started no run");
      return { provider: "monid", id: run.runId };
    },
    async poll(job) {
      return monidPoll(await monid.getRun(job.id), "Kling motion control");
    },
  };
}

// ---------- Kling 3.0 with its own voice (Monid) ----------

export const KLING_I2V_ENDPOINT = "/v1/video/kling-3.0-i2v";

/**
 * The reference's cuts inside one render, as Kling 3.0's multi-shot list: "Shot 1, 4 s: chest-up at
 * the left; she leans in. Shot 2, 3 s: …". The first shot starts from the twin frame.
 */
export function shotList(shots: PresenterShot[]): string {
  return shots
    .map((shot, i) => `Shot ${i + 1}, ${Math.max(1, Math.round(shot.seconds))} s: ${[shot.framing, shot.action].filter(Boolean).join("; ").replace(/\.$/, "") || "the same framing, talking to the camera"}.`)
    .join(" ");
}

/**
 * The prompt for a model that animates the twin frame and says the line itself: the shots (when the
 * reference cuts inside the render), then the head-to-head's recipe for a real creator. Nothing
 * about the person's looks: the first frame carries the face.
 */
export function speakingPrompt(input: Pick<PresenterInput, "persona" | "action" | "line" | "emotion" | "green" | "shots">): string {
  const who = subject(input.persona.gender);
  const tags = input.emotion.match(/\[[^\]]+\]/g) ?? (input.emotion ? [input.emotion] : []);
  return [
    input.shots.length > 1 ? `${shotList(input.shots)} The first frame is shot 1; every shot keeps this person, outfit and place.` : "The first frame is exact: keep the set, the light, and the person's position and size as they are in it.",
    creatorDirection({ who, arc: emotionArc(tags), action: input.shots.length > 1 ? "" : input.action, line: input.line, listening: !input.line, green: input.green }),
    SAFE,
    NO_TEXT,
  ]
    .filter(Boolean)
    .join(" ");
}

/** Kling's clip length for a render: whole seconds, about one more than it needs (the edit trims to the best part), 3-15. */
export const klingSeconds = (seconds: number) => Math.max(3, Math.min(15, Math.ceil(seconds + 0.6)));

export function klingNativeBody(input: PresenterInput) {
  return {
    prompt: speakingPrompt(input).slice(0, 2500),
    media: [{ type: "first_frame", url: input.frameUrl }],
    resolution: "1080p",
    duration: klingSeconds(input.seconds),
    audio: "native",
    multi_shot: input.shots.length > 1,
  };
}

export function klingNative(monid: MonidRunner): Presenter {
  return {
    name: "kling-native",
    needs: { frame: true, motion: false, audio: false },
    voice: "own",
    multiShot: true,
    ratios: ["9:16", "2:3", "3:4", "4:5", "1:1", "5:4", "4:3", "3:2", "16:9"],
    // $0.168 a second at 1080p with audio, measured on Monid ($1.68 for 10 s); 3-15 s a render.
    price: { perSecond: 0.168, minSeconds: 3, maxSeconds: 14 },
    async submit(input) {
      if (!input.frameUrl) throw new Error("kling-native needs the twin frame as its first frame");
      const run = await monid.run("kling", KLING_I2V_ENDPOINT, { body: klingNativeBody(input) });
      if (!run?.runId) throw new ApiError("monid", 502, "no_run", "Kling started no run");
      return { provider: "monid", id: run.runId };
    },
    async poll(job) {
      return monidPoll(await monid.getRun(job.id), "Kling 3.0");
    },
  };
}

// ---------- a Naive video model that speaks the line (Veo 3.1 and the like) ----------

/** The file a finished media job produced, whatever shape its result has. */
export function jobFile(job: unknown): string | null {
  const r = (job ?? {}) as { result?: { files?: Array<{ file_id?: string; id?: string }>; file_id?: string } | null; file_id?: string };
  return r.result?.files?.[0]?.file_id ?? r.result?.files?.[0]?.id ?? r.result?.file_id ?? r.file_id ?? null;
}

export function naiveVideo(naive: Pick<NaiveClient, "generateVideo" | "getMediaJob" | "fileUrl">, model: string): Presenter {
  return {
    name: `naive:${model}`,
    needs: { frame: true, motion: false, audio: false },
    voice: "own",
    multiShot: false,
    ratios: ["9:16", "16:9"],
    // Veo 3.1 on Naive cost $3.20 for 8 s; it renders 4, 6 or 8 s.
    price: { perSecond: 0.4, minSeconds: 4, maxSeconds: 8 },
    async submit(input, idempotencyKey) {
      const seconds = input.seconds <= 4 ? 4 : input.seconds <= 6 ? 6 : 8;
      const job = await naive.generateVideo({ model, prompt: speakingPrompt(input), seconds, aspect_ratio: input.ratio, image_urls: input.frameUrl ? [input.frameUrl] : undefined }, idempotencyKey);
      return { provider: "naive", id: job.id };
    },
    async poll(job) {
      const media: MediaJob = await naive.getMediaJob(job.id);
      const cost = media.cost_micro_usd ?? 0;
      const file = jobFile(media);
      if (media.status === "completed" && file) return { status: "done", url: (await naive.fileUrl(file)).url, cost_micro: cost };
      if (media.status === "failed" || media.status === "completed") return { status: "failed", error: media.error?.message ?? "the render failed", retryable: false, cost_micro: cost };
      return { status: "running" };
    },
  };
}

/** The presenter a setting names: "kling-native" (default), "kling-motion" or "naive:<video model id>". */
export function presenterFor(name: string, clients: { naive: Pick<NaiveClient, "generateVideo" | "getMediaJob" | "fileUrl">; monid: MonidRunner }): Presenter {
  if (name.startsWith("naive:") && name.length > 6) return naiveVideo(clients.naive, name.slice(6));
  if (name === "kling-motion") return klingMotion(clients.monid);
  if (name && name !== "kling-native") throw new Error(`unknown presenter "${name}": use kling-native, kling-motion or naive:<video model>`);
  return klingNative(clients.monid);
}

// ---------- rendering one take ----------

/** What the manifest keeps per take for the presenter: its job, how many renders, and the kept clip. */
export type RenderRecord = { job?: PresenterJob; renders?: number; clip_key?: string; cost_micro?: number; error?: string };

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

/**
 * One take through the presenter: submitted once (the job is recorded before any wait, so a
 * restart polls it instead of paying again), polled to the end, downloaded and kept by key. A
 * failed render is tried again under a new key, `tries` in all; then this throws, and the remake
 * falls back to its own equivalent for the segment.
 */
export async function renderPresenter(work: Work, presenter: Presenter, input: PresenterInput, record: RenderRecord, options: { key: string; idem: string; tries?: number; timeoutMs?: number }): Promise<string> {
  const kept = await work.local(record.clip_key);
  if (kept) return kept;
  const tries = options.tries ?? 2;
  const deadline = Date.now() + (options.timeoutMs ?? 40 * 60_000);
  for (;;) {
    if (!record.job) {
      if ((record.renders ?? 0) >= tries) throw new Error(`${presenter.name}: ${record.error ?? "the render failed"} (${record.renders} tries)`);
      const n = (record.renders ?? 0) + 1;
      record.job = await presenter.submit(input, `${options.idem}${n > 1 ? `-r${n}` : ""}`);
      record.renders = n;
      await work.save();
    }
    const poll = await presenter.poll(record.job);
    if (poll.status === "done") {
      work.spend(record.job.provider, poll.cost_micro);
      record.cost_micro = (record.cost_micro ?? 0) + poll.cost_micro;
      const local = join(work.dir, `${options.key.replace(/\//g, "-")}.mp4`);
      await work.fetch(poll.url, local);
      record.clip_key = await work.keep(options.key, local, "video/mp4");
      record.error = undefined;
      await work.save();
      return local;
    }
    if (poll.status === "failed") {
      const provider = record.job.provider;
      work.spend(provider, poll.cost_micro);
      record.error = poll.error;
      record.job = undefined;
      // A busy provider is not the take's fault: that render does not count, and the remake pauses.
      if (poll.retryable) record.renders = Math.max(0, (record.renders ?? 1) - 1);
      await work.save();
      if (poll.retryable) throw new ApiError(provider, 503, "render_busy", `${presenter.name}: ${poll.error}`);
      continue;
    }
    if (Date.now() > deadline) throw new ApiError("monid", 504, "render_timeout", `${presenter.name}: a render is still running; the remake picks it up on its next run`);
    await sleep(work.pollMs);
  }
}
