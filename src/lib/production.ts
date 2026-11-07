import { copyFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { db, logEvent, newId, now, parse, update } from "./db";
import { ApiError } from "./http";
import { download, extractFrames, ffmpegPath, mediaDir, stitch } from "./media";
import { type MonidClient, type MonidRun, providerFailed, runCostMicro, TERMINAL } from "./monid";
import type { NaiveClient } from "./naive";
import { reviewShot, type Verdict } from "./qc";
import { getBool, getInt, getSetting } from "./settings";
import { captionFor, type Concept, type Strategy } from "./strategy";

// Production: every shot gets a product-faithful first frame, a render, and a QC pass; then the
// shots are cut into one ad. Naive renders first; Monid renders when Naive is out of credits.

export type ShotState = {
  n: number;
  frame_prompt: string;
  prompt: string;
  seconds: number;
  status: "pending" | "framed" | "rendering" | "rendered" | "passed" | "failed";
  provider: "naive" | "monid" | null;
  renders: number;
  qc_rounds: number;
  submit_errors: number;
  frame_idem: string;
  frame_file_id: string | null;
  frame_url: string | null;
  frame_skipped: boolean;
  text_only: boolean;
  force_monid: boolean;
  video_idem: string;
  job_id: string | null;
  monid_run_id: string | null;
  video_file_id: string | null;
  video_url: string | null;
  local_path: string | null;
  qc: Verdict | null;
  naive_cost: number;
  monid_cost: number;
  error: string | null;
};

export type CreativeRow = {
  id: string;
  campaign_id: string;
  idx: number;
  generation: number;
  concept_json: string;
  shots_json: string;
  status: "queued" | "producing" | "ready" | "failed";
  final_file_id: string | null;
  final_url: string | null;
  final_url_expires_at: string | null;
  final_external_url: string | null;
  poster_url: string | null;
  qc_score: number | null;
  caption: string;
  platforms_json: string;
  approved: number;
  rejected: number;
  cost_micro: number;
  error: string | null;
};

export type ProductionContext = {
  campaignId: string;
  brandId: string;
  naive: NaiveClient | null;
  monid: MonidClient | null;
  naiveOut: () => boolean;
  markNaiveOut: () => void;
  strategy: Strategy;
};

const MAX_RENDERS = 3;

export function insertCreative(campaignId: string, idx: number, concept: Concept, generation = 1) {
  const id = newId("crv");
  const shots: ShotState[] = concept.shots.map((shot, i) => ({
    n: i + 1,
    frame_prompt: shot.frame_prompt,
    prompt: shot.video_prompt,
    seconds: shot.seconds,
    status: "pending",
    provider: null,
    renders: 0,
    qc_rounds: 0,
    submit_errors: 0,
    frame_idem: `${id}-shot${i + 1}-frame`,
    frame_file_id: null,
    frame_url: null,
    frame_skipped: false,
    text_only: false,
    force_monid: false,
    video_idem: `${id}-shot${i + 1}-render1`,
    job_id: null,
    monid_run_id: null,
    video_file_id: null,
    video_url: null,
    local_path: null,
    qc: null,
    naive_cost: 0,
    monid_cost: 0,
    error: null,
  }));
  db()
    .prepare(
      `insert into creatives (id, campaign_id, idx, generation, concept_json, shots_json, status, caption, platforms_json, created_at, updated_at)
       values (?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?)`,
    )
    .run(id, campaignId, idx, generation, JSON.stringify(concept), JSON.stringify(shots), captionFor(concept), JSON.stringify(concept.platforms), now(), now());
  return id;
}

export async function advanceCreative(ctx: ProductionContext, creative: CreativeRow) {
  if (creative.status === "ready" || creative.status === "failed") return;
  const concept = parse<Concept | null>(creative.concept_json, null);
  if (!concept) return update("creatives", creative.id, { status: "failed", error: "concept is unreadable" });
  const shots = parse<ShotState[]>(creative.shots_json, []);
  const save = (fields: Record<string, unknown> = {}) =>
    update("creatives", creative.id, {
      shots_json: JSON.stringify(shots),
      cost_micro: shots.reduce((sum, shot) => sum + shot.naive_cost + shot.monid_cost, 0),
      ...fields,
    });
  if (creative.status === "queued") save({ status: "producing" });

  for (const shot of shots) {
    if (shot.status !== "pending") continue;
    // Later shots take the first shot's frame as their identity reference, so wait for it.
    if (shot.n > 1 && shots[0].status === "pending") break;
    await makeFrame(ctx, concept, shots, shot);
    save();
  }
  for (const shot of shots) {
    if (shot.status === "framed") await submitRender(ctx, shot);
    else if (shot.status === "rendering") await pollRender(ctx, creative.id, shot);
    else if (shot.status === "rendered") await checkQuality(ctx, concept, shot);
    save();
  }

  const failed = shots.find((shot) => shot.status === "failed");
  if (failed) {
    save({ status: "failed", error: `Shot ${failed.n}: ${failed.error ?? "could not be rendered"}` });
    logEvent({ brandId: ctx.brandId, campaignId: ctx.campaignId, level: "error", message: `"${concept.title}" failed at shot ${failed.n}: ${failed.error}` });
    return;
  }
  if (shots.every((shot) => shot.status === "passed")) {
    await finalize(ctx, creative, concept, shots);
    save();
  }
}

async function makeFrame(ctx: ProductionContext, concept: Concept, shots: ShotState[], shot: ShotState) {
  if (!ctx.naive || ctx.naiveOut()) {
    shot.frame_skipped = true;
    shot.status = "framed";
    return;
  }
  const first = shots[0];
  const references = shot.n === 1 ? concept.reference_images.slice(0, 3) : [first.frame_file_id, ...concept.reference_images.slice(0, 2)].filter((ref): ref is string => Boolean(ref));
  const prompt =
    shot.n === 1 || !first.frame_file_id
      ? shot.frame_prompt
      : `${shot.frame_prompt}\nThe first reference image is the same video: keep the exact same person, face, hair, outfit, location and lighting.`;
  try {
    const result = await ctx.naive.generateImage({ prompt, aspect_ratio: "9:16", image_urls: references.length ? references : undefined }, shot.frame_idem);
    const file = result.files[0];
    if (!file) throw new ApiError("naive", 500, "no_file", "the image render returned no file");
    shot.naive_cost += result.cost_micro_usd ?? 0;
    shot.frame_file_id = file.id;
    shot.frame_url = (await ctx.naive.fileUrl(file.id)).url;
    shot.status = "framed";
  } catch (error) {
    if (error instanceof ApiError && error.outOfCredits) {
      ctx.markNaiveOut();
      shot.frame_skipped = true;
      shot.status = "framed";
    } else if (error instanceof ApiError && error.retryable && shot.submit_errors < 4) {
      shot.submit_errors++;
    } else if (references.length && !shot.frame_idem.endsWith("-plain")) {
      // A reference image the provider cannot fetch: render the frame from the prompt alone.
      shot.frame_idem = `${shot.frame_idem}-plain`;
      concept.reference_images = [];
    } else {
      shot.frame_skipped = true;
      shot.status = "framed";
      shot.error = `first frame skipped: ${message(error)}`;
    }
  }
}

async function submitRender(ctx: ProductionContext, shot: ShotState) {
  if (shot.renders >= MAX_RENDERS) {
    shot.status = "failed";
    shot.error ??= "render failed repeatedly";
    return;
  }
  if (ctx.naive && !ctx.naiveOut() && !shot.force_monid) {
    try {
      const job = await ctx.naive.generateVideo(
        {
          model: getSetting("video_model"),
          prompt: shot.prompt,
          seconds: shot.seconds,
          aspect_ratio: "9:16",
          image_urls: shot.frame_file_id && !shot.text_only ? [shot.frame_file_id] : undefined,
        },
        shot.video_idem,
      );
      Object.assign(shot, { job_id: job.id, monid_run_id: null, provider: "naive", status: "rendering", renders: shot.renders + 1, submit_errors: 0 });
      return;
    } catch (error) {
      if (error instanceof ApiError && error.outOfCredits) {
        ctx.markNaiveOut();
      } else if (error instanceof ApiError && error.code === "validation_failed" && shot.frame_file_id && !shot.text_only) {
        shot.text_only = true; // this model does not animate a first frame: render from the prompt
        shot.video_idem = `${shot.video_idem}-t2v`;
        return;
      } else if (error instanceof ApiError && error.retryable && shot.submit_errors < 5) {
        shot.submit_errors++;
        return;
      } else if (!monidVideoEnabled(ctx)) {
        shot.status = "failed";
        shot.error = message(error);
        return;
      }
    }
  }
  if (!monidVideoEnabled(ctx)) {
    shot.status = "failed";
    shot.error = "Naive is out of credits and the Monid video fallback is off";
    return;
  }
  const resolution = getSetting("monid_video_resolution");
  const duration = Math.max(3, Math.min(15, shot.seconds));
  const prompt = shot.prompt.slice(0, 3000);
  const firstFrame = shot.frame_url && !shot.text_only;
  try {
    const run = await ctx.monid!.run(
      "kling",
      firstFrame ? "/v1/video/kling-3.0-i2v" : "/v1/video/kling-3.0-t2v",
      { body: firstFrame ? { prompt, media: [{ type: "first_frame", url: shot.frame_url }], resolution, duration, audio: "native" } : { prompt, resolution, aspect_ratio: "9:16", duration, audio: "native" } },
    );
    Object.assign(shot, { monid_run_id: run.runId, job_id: null, provider: "monid", status: "rendering", renders: shot.renders + 1, submit_errors: 0 });
    logEvent({ brandId: ctx.brandId, campaignId: ctx.campaignId, message: `Shot ${shot.n} is rendering on Monid (Kling 3.0) because Naive is unavailable` });
    if (TERMINAL.has(run.status)) await finishMonid(run, shot);
  } catch (error) {
    if (error instanceof ApiError && error.retryable && shot.submit_errors < 5) shot.submit_errors++;
    else {
      shot.status = "failed";
      shot.error = message(error);
    }
  }
}

async function pollRender(ctx: ProductionContext, creativeId: string, shot: ShotState) {
  if (shot.provider === "naive" && shot.job_id && ctx.naive) {
    const job = await ctx.naive.getMediaJob(shot.job_id);
    if (job.status === "completed" && job.result?.files[0]) {
      shot.naive_cost += job.cost_micro_usd ?? 0;
      shot.video_file_id = job.result.files[0].file_id;
      shot.video_url = (await ctx.naive.fileUrl(shot.video_file_id)).url;
      shot.status = "rendered";
    } else if (job.status === "failed") {
      shot.error = job.error?.message ?? "the render failed";
      shot.video_idem = `${creativeId}-shot${shot.n}-render${shot.renders + 1}`;
      shot.status = "framed";
      if (shot.renders >= 2 && monidVideoEnabled(ctx)) shot.force_monid = true;
    }
  } else if (shot.provider === "monid" && shot.monid_run_id && ctx.monid) {
    const run = await ctx.monid.getRun(shot.monid_run_id);
    if (TERMINAL.has(run.status)) await finishMonid(run, shot);
  }
  if (shot.status === "rendered") {
    const dir = mediaDir(creativeId);
    await mkdir(dir, { recursive: true });
    shot.local_path = await download(shot.video_url!, join(dir, `shot${shot.n}-r${shot.renders}.mp4`));
  }
}

async function finishMonid(run: MonidRun, shot: ShotState) {
  shot.monid_cost += runCostMicro(run);
  const url = run.status === "COMPLETED" && !providerFailed(run) ? firstVideoUrl(run.output) : null;
  if (url) {
    shot.video_url = url;
    shot.status = "rendered";
  } else {
    shot.error = `Monid render ${run.status.toLowerCase()}${providerFailed(run) ? ` (provider HTTP ${run.providerResponse?.httpStatus})` : ""}`;
    shot.status = shot.renders < MAX_RENDERS ? "framed" : "failed";
  }
}

async function checkQuality(ctx: ProductionContext, concept: Concept, shot: ShotState) {
  const canReview = ctx.naive && !ctx.naiveOut() && shot.local_path && (await ffmpegPath());
  if (!canReview) {
    shot.status = "passed";
    return;
  }
  try {
    const frames = await extractFrames(shot.local_path!, 4);
    const verdict = await reviewShot(ctx.naive!, { frames, brand: ctx.strategy.brand, concept, shot: concept.shots[shot.n - 1], shotNumber: shot.n, prompt: shot.prompt });
    shot.qc = verdict;
    shot.qc_rounds++;
    const retries = getInt("qc_max_retries");
    if (verdict.pass || shot.qc_rounds > retries || !verdict.fix_prompt || shot.renders >= MAX_RENDERS) {
      shot.status = "passed";
      if (!verdict.pass) logEvent({ brandId: ctx.brandId, campaignId: ctx.campaignId, level: "warn", message: `"${concept.title}" shot ${shot.n} scored ${verdict.score}/10 after its re-render: ${verdict.issues[0] ?? "see QC notes"}` });
    } else {
      logEvent({ brandId: ctx.brandId, campaignId: ctx.campaignId, message: `QC sent "${concept.title}" shot ${shot.n} back (${verdict.score}/10): ${verdict.issues[0] ?? "quality"}` });
      shot.prompt = verdict.fix_prompt;
      shot.video_idem = `${shot.video_idem.replace(/-qc\d+$/, "")}-qc${shot.qc_rounds}`;
      Object.assign(shot, { status: "framed", job_id: null, monid_run_id: null, video_file_id: null, video_url: null });
    }
  } catch (error) {
    if (error instanceof ApiError && error.outOfCredits) ctx.markNaiveOut();
    shot.status = "passed"; // QC is a gate for quality, not a reason to lose a finished render
    shot.error = `quality check skipped: ${message(error)}`;
  }
}

async function finalize(ctx: ProductionContext, creative: CreativeRow, concept: Concept, shots: ShotState[]) {
  const dir = mediaDir(creative.id);
  await mkdir(dir, { recursive: true });
  const finalPath = join(dir, "final.mp4");
  const scores = shots.map((shot) => shot.qc?.score).filter((score): score is number => typeof score === "number");
  const fields: Record<string, unknown> = { qc_score: scores.length ? Math.min(...scores) : null, poster_url: shots[0].frame_url, error: null };

  if (shots.length === 1) {
    await copyFile(shots[0].local_path!, finalPath);
    fields.final_file_id = shots[0].video_file_id;
    fields.final_url = shots[0].video_url;
    fields.final_external_url = shots[0].provider === "monid" ? shots[0].video_url : null;
  } else {
    if (!(await ffmpegPath())) {
      update("creatives", creative.id, { status: "failed", error: "ffmpeg is needed to cut shots together; install it or run npm install" });
      return;
    }
    await stitch(shots.map((shot) => shot.local_path!), finalPath);
  }
  if (!fields.final_file_id && ctx.naive) {
    try {
      const fileId = await ctx.naive.uploadFile(`${slug(concept.title)}.mp4`, "video/mp4", await readFile(finalPath));
      const link = await ctx.naive.fileUrl(fileId);
      Object.assign(fields, { final_file_id: fileId, final_url: link.url, final_url_expires_at: link.expires_at });
    } catch (error) {
      logEvent({ brandId: ctx.brandId, campaignId: ctx.campaignId, level: "warn", message: `"${concept.title}" is ready but could not be uploaded to Naive for posting: ${message(error)}` });
    }
  }
  update("creatives", creative.id, { ...fields, status: "ready" });
  logEvent({ brandId: ctx.brandId, campaignId: ctx.campaignId, message: `"${concept.title}" is ready${scores.length ? ` (QC ${Math.min(...scores)}/10)` : ""}` });
}

function monidVideoEnabled(ctx: ProductionContext) {
  return Boolean(ctx.monid) && getBool("monid_video_fallback");
}

function firstVideoUrl(output: unknown): string | null {
  const found: string[] = [];
  const walk = (value: unknown, depth: number) => {
    if (depth > 6 || found.length) return;
    if (typeof value === "string" && /^https:\/\/\S+/.test(value) && /\.mp4|video|output/i.test(value)) found.push(value);
    else if (Array.isArray(value)) value.forEach((entry) => walk(entry, depth + 1));
    else if (value && typeof value === "object") {
      const obj = value as Record<string, unknown>;
      if (typeof obj.url === "string") walk(obj.url, depth + 1);
      Object.values(obj).forEach((entry) => walk(entry, depth + 1));
    }
  };
  walk(output, 0);
  return found[0] ?? null;
}

export function slug(text: string) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "video";
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
