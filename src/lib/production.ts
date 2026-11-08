import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { promisify } from "node:util";
import { logEvent, newId, now, parse, save, store } from "./db";
import { ApiError } from "./http";
import { chunkCaptions } from "./creative/captions";
import { renderTimeline } from "./creative/edit";
import { advanceRemake } from "./creative/remake-job";
import { buildTimeline, type RenderedAssets, screenVisualId } from "./creative/plan";
import { makePlate, newPlateRecord, type PlateRecord } from "./creative/plate";
import { buildScreens } from "./creative/screens";
import { trimSilence } from "./creative/trim";
import type { BrandKit, FilmedPlate, ProductBrief } from "./creative/types";
import { download, extractFrames, ffmpegPath, probe, scratchDir, stitch } from "./media";
import { type MonidClient, type MonidRun, providerFailed, runCostMicro, TERMINAL } from "./monid";
import type { NaiveClient } from "./naive";
import { type Continuity, reviewContinuity, reviewFrame, reviewShot, type Verdict } from "./qc";
import { getBool, getInt, getSetting } from "./settings";
import { captionFor, type Concept, type Strategy } from "./strategy";

// Production: every shot gets a product-faithful first frame, a render, and a QC pass; then the
// shots are cut into one ad. Naive renders first; Monid renders when Naive is out of credits.
//
// What must outlive a tick is kept in the store's files (data/media locally, Convex storage on
// serverless hosts), named by key: renders "crv_…/shot1-r1.mp4", frames "crv_…/shot1-frame.png", the
// screens and their manifest "crv_…/screens/…", the voice-over "crv_…/voiceover.wav", the cut
// "crv_…/final.mp4" and its poster. Everything else (trims, downloads, the edit's intermediates)
// lives in a scratch folder for one tick.

export type ShotState = {
  n: number;
  frame_prompt: string;
  prompt: string;
  /** The shot's one gentle action: a later shot's frame is shot 1's still re-posed to it (plan.ts). */
  pose?: string;
  seconds: number;
  status: "pending" | "framed" | "rendering" | "rendered" | "passed" | "failed";
  provider: "naive" | "monid" | null;
  renders: number;
  qc_rounds: number;
  qc_errors?: number;
  submit_errors: number;
  frame_idem: string;
  frame_file_id: string | null;
  frame_url: string | null;
  /** The stored copy of the first frame (signed provider links expire after seven days). */
  frame_key?: string | null;
  frame_skipped: boolean;
  /** Shot 1 only: a still from its render, uploaded to Naive, when it had no first frame. */
  identity_file_id?: string | null;
  identity_failed?: boolean;
  /** After a failed QC: the frame being replaced, and what was wrong with it. */
  previous_frame_file_id?: string | null;
  frame_fix?: string;
  /** The first-frame gate: whether this frame was checked, and how many times it was sent back. */
  frame_gated?: boolean;
  frame_checks?: number;
  /** When the provider first said this frame's request was still in flight, and how often it was re-keyed. */
  frame_inflight_since?: string | null;
  frame_rekeys?: number;
  /** A product photo the provider could not fetch: frames use the identity reference only. */
  drop_product_refs?: boolean;
  /** Provider trouble: do not try this shot again before this time. */
  retry_at?: string | null;
  text_only: boolean;
  force_monid: boolean;
  video_idem: string;
  job_id: string | null;
  monid_run_id: string | null;
  video_file_id: string | null;
  video_url: string | null;
  /** The stored render's file key (older local rows hold an absolute path, which still works). */
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
  /** The stored cut ("crv_…/final.mp4"), once there is one. */
  final_key?: string | null;
  poster_url: string | null;
  qc_score: number | null;
  continuity_json: string | null;
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
  markNaiveOut: () => Promise<void>;
  strategy: Strategy;
  /** The product analyst's brief, with the visuals the edit cuts to. */
  product?: ProductBrief;
  /** The brand's uploaded assets and code scan, for the screen builder. */
  kit?: BrandKit | null;
};

/** A creative's kept file, by name: "crv_…/shot1-frame.png". */
const fileKey = (creativeId: string, name: string) => `${creativeId}/${name}`;
/** A creative's scratch folder for one tick: downloads, trims and the edit's intermediates. */
const workDir = (creativeId: string) => join(scratchDir(), `cut-${creativeId}`);

type ScreenManifest = {
  /** `key` is the clip's file in the store; rows from before the store hold an absolute `path`. */
  clips: Array<{ id: string; kind: "video" | "image"; key?: string; path?: string }>;
  failures: Array<{ id: string; error: string }>;
  /** Busy-model failures so far per screen: retried on later ticks, up to SCREEN_TRIES. */
  attempts?: Record<string, number>;
};
const SCREEN_TRIES = 3;
const screenManifest = (creativeId: string) => fileKey(creativeId, "screens/manifest.json");
/** The screens built so far for this video, or null before the first build. */
async function readScreenManifest(creativeId: string): Promise<ScreenManifest | null> {
  const files = store().files;
  const key = screenManifest(creativeId);
  if (!(await files.exists(key))) return null;
  const raw = JSON.parse(await readFile(await files.localPath(key), "utf8").catch(() => "{}")) as Partial<ScreenManifest>;
  return { clips: Array.isArray(raw.clips) ? raw.clips : [], failures: Array.isArray(raw.failures) ? raw.failures : [], attempts: raw.attempts ?? {} };
}
async function writeScreenManifest(creativeId: string, manifest: ScreenManifest) {
  const dir = workDir(creativeId);
  await mkdir(dir, { recursive: true });
  const path = join(dir, "screens-manifest.json");
  await writeFile(path, JSON.stringify(manifest));
  await store().files.putFile(screenManifest(creativeId), path, "application/json");
}
/** A local copy of a manifest clip, or null when it is gone. */
async function clipPath(clip: ScreenManifest["clips"][number]): Promise<string | null> {
  const path = clip.key ? await store().files.localPath(clip.key).catch(() => null) : (clip.path ?? null);
  return path && existsSync(path) ? path : null;
}

/**
 * filmed_screen's monitor photo and how making it went (creative/plate.ts), kept like the screens
 * manifest: "crv_…/plate.json", and the photo itself "crv_…/plate.png" (record.plate.path holds
 * that key; rows from before the store hold an absolute path, which still works locally).
 */
const plateKey = (creativeId: string) => fileKey(creativeId, "plate.json");
async function readPlate(creativeId: string): Promise<PlateRecord | null> {
  const files = store().files;
  try {
    if (!(await files.exists(plateKey(creativeId)))) return null;
    return JSON.parse(await readFile(await files.localPath(plateKey(creativeId)), "utf8")) as PlateRecord;
  } catch {
    return null;
  }
}
async function writePlate(creativeId: string, record: PlateRecord) {
  const dir = workDir(creativeId);
  await mkdir(dir, { recursive: true });
  const path = join(dir, "plate.json");
  await writeFile(path, JSON.stringify(record));
  await store().files.putFile(plateKey(creativeId), path, "application/json");
}
/** A local copy of the kept monitor photo, or null when it is gone. */
async function plateFile(keyOrPath: string): Promise<string | null> {
  const path = await store().files.localPath(keyOrPath).catch(() => null);
  return path && existsSync(path) ? path : null;
}
/** Provider hiccups waited out while making a plate before the video gives up on it. */
const PLATE_ERRORS = 8;

const MAX_RENDERS = 3;
/** A frame request still "in flight" after this long was most likely cut off (a server restart). */
const FRAME_INFLIGHT_MS = 10 * 60_000;
/** How many times the first-frame gate may send one shot's frame back before it is used anyway. */
const FRAME_CHECKS = 2;

/** QC issues about drawn-in text or interface, which an image model copies forward if shown the old frame. */
const TEXT_DEFECT = /\b(text|captions?|subtitles?|gibberish|garbled|letters|cards?|status bar|screen|monitor|logo|ui|graphics?|overlay|labels?)\b/i;

/** A QC complaint fit for an image prompt: quoted gibberish removed, so the model never draws it. */
export function cleanFix(issues: string[]) {
  return issues
    .join(" ")
    .replace(/(['"\u2018\u201C])[^'"\u2019\u201D]{0,200}(['"\u2019\u201D])/g, "")
    .replace(/\(e\.g\.[^)]*\)/gi, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}

/** Provider trouble (a 5xx, a rate limit) waits it out: 15 s, 30 s, 1 min… up to 5 min apart, 8 tries. */
const MAX_SUBMIT_ERRORS = 8;
function backoff(shot: ShotState) {
  shot.retry_at = new Date(Date.now() + Math.min(300, 15 * 2 ** shot.submit_errors) * 1000).toISOString();
  shot.submit_errors++;
}
const waiting = (shot: ShotState) => Boolean(shot.retry_at && Date.parse(shot.retry_at) > Date.now());

export async function insertCreative(campaignId: string, idx: number, concept: Concept, generation = 1) {
  const id = newId("crv");
  const shots: ShotState[] = concept.shots.map((shot, i) => ({
    n: i + 1,
    frame_prompt: shot.frame_prompt,
    prompt: shot.video_prompt,
    ...(shot.pose !== undefined ? { pose: shot.pose } : {}),
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
  await store().insert("creatives", {
    id,
    campaign_id: campaignId,
    idx,
    generation,
    concept_json: JSON.stringify(concept),
    shots_json: JSON.stringify(shots),
    status: "queued",
    caption: captionFor(concept),
    platforms_json: JSON.stringify(concept.platforms),
    created_at: now(),
    updated_at: now(),
  });
  return id;
}

export async function advanceCreative(ctx: ProductionContext, creative: CreativeRow) {
  if (creative.status === "ready" || creative.status === "failed") return;
  const concept = parse<Concept | null>(creative.concept_json, null);
  if (!concept) return save("creatives", creative.id, { status: "failed", error: "concept is unreadable" });
  // One-to-one remakes rebuild the reference in their own module (creative/remake-job.ts).
  if (concept.brief?.format === "remake") return advanceRemake(ctx, creative, concept);
  const shots = parse<ShotState[]>(creative.shots_json, []);
  // Spend outside the shots: filmed_screen's monitor photos.
  let otherCost = concept.plan?.format === "filmed_screen" ? ((await readPlate(creative.id))?.cost_micro ?? 0) : 0;
  const persist = (fields: Record<string, unknown> = {}) =>
    save("creatives", creative.id, {
      shots_json: JSON.stringify(shots),
      cost_micro: shots.reduce((sum, shot) => sum + shot.naive_cost + shot.monid_cost, 0) + otherCost,
      ...fields,
    });
  if (creative.status === "queued") await persist({ status: "producing" });

  await ensureIdentity(ctx, creative.id, shots);
  for (const shot of shots) {
    if (shot.status !== "pending" || waiting(shot)) continue;
    // Later shots take the first shot's look as their identity reference, so wait for it.
    if (shot.n > 1 && !identityReady(ctx, shots[0])) break;
    await makeFrame(ctx, creative.id, concept, shots, shot);
    // makeFrame moves the shot on; read its status fresh rather than as the loop narrowed it.
    const status = (): ShotState["status"] => shot.status;
    if (status() === "framed") await gateFrame(ctx, creative.id, concept, shot);
    await persist();
    // Shot 1's frame was sent back: later shots must wait for the new one to copy.
    if (shot.n === 1 && status() === "pending") break;
  }
  for (const shot of shots) {
    if (waiting(shot)) continue;
    if (shot.status === "framed" && shot.frame_gated === false) continue; // its frame is being remade
    if (shot.status === "framed") await submitRender(ctx, shot);
    else if (shot.status === "rendering") await pollRender(ctx, creative.id, shot);
    else if (shot.status === "rendered") await checkQuality(ctx, concept, shot);
    await persist();
  }

  // Product screens (and a filmed screen's monitor photo) build while the presenter renders on the
  // video model, so the edit rarely waits.
  const [screensPending, plate] = await Promise.all([ensureScreens(ctx, creative.id, concept), ensurePlate(ctx, creative.id, concept)]);
  otherCost = plate.cost_micro;

  const failed = shots.find((shot) => shot.status === "failed");
  if (failed) {
    await persist({ status: "failed", error: `Shot ${failed.n}: ${failed.error ?? "could not be rendered"}` });
    await logEvent({ brandId: ctx.brandId, campaignId: ctx.campaignId, level: "error", message: `"${concept.title}" failed at shot ${failed.n}: ${failed.error}` });
    return;
  }
  if (shots.every((shot) => shot.status === "passed")) {
    if (screensPending || plate.pending) return persist();
    if (!(await checkContinuity(ctx, creative, concept, shots))) return persist();
    await finalize(ctx, creative, concept, shots);
    await persist();
  }
}

/** The person and place every later shot must match: shot 1's frame, or a still from its render. */
const identityOf = (first: ShotState) => first.frame_file_id ?? first.identity_file_id ?? null;

function identityReady(ctx: ProductionContext, first: ShotState) {
  if (identityOf(first) || first.identity_failed || first.status === "failed") return true;
  // Without Naive there is nothing to render a reference with; later shots go ahead on their own.
  return first.frame_skipped && (!ctx.naive || ctx.naiveOut());
}

/** When shot 1 had to render without a frame, take a still from its video as everyone's reference. */
async function ensureIdentity(ctx: ProductionContext, creativeId: string, shots: ShotState[]) {
  const first = shots[0];
  if (!first) return; // a faceless video renders no A-roll
  if (identityOf(first) || !first.frame_skipped || !first.local_path || !ctx.naive || ctx.naiveOut()) return;
  try {
    const [still] = await extractFrames(await store().files.localPath(first.local_path), 1, 1080);
    first.identity_file_id = await ctx.naive.uploadFile(`${creativeId}-identity.jpg`, "image/jpeg", still);
  } catch (error) {
    if (error instanceof ApiError && error.retryable) return;
    first.identity_failed = true; // later shots go ahead without a reference; the cut check still runs
    first.error = `could not take an identity still: ${message(error)}`;
  }
}

/**
 * Before the cut: are all shots the same person in the same place? A mismatched shot is reset and
 * re-rendered from shot 1's identity once; a second mismatch is flagged on the video instead.
 */
async function checkContinuity(ctx: ProductionContext, creative: CreativeRow, concept: Concept, shots: ShotState[]): Promise<boolean> {
  const previous = parse<Continuity | null>(creative.continuity_json, null);
  if (previous?.checked || shots.length < 2 || !ctx.naive || ctx.naiveOut() || !(await ffmpegPath())) return true;
  const rounds = (previous?.rounds ?? 0) + 1;
  try {
    const frames = await Promise.all(shots.map(async (shot) => (await extractFrames(await store().files.localPath(shot.local_path!), 1))[0]));
    const verdict = await reviewContinuity(ctx.naive, { frames, concept });
    const redo = verdict.mismatched.map((n) => shots[n - 1]).filter((shot) => shot && shot.renders < MAX_RENDERS);
    if (verdict.consistent || rounds > 1 || redo.length === 0) {
      await save("creatives", creative.id, { continuity_json: JSON.stringify({ checked: true, consistent: verdict.consistent, mismatched: verdict.mismatched, note: verdict.note, rounds }) });
      if (!verdict.consistent) await logEvent({ brandId: ctx.brandId, campaignId: ctx.campaignId, level: "warn", message: `"${concept.title}" still changes between shots: ${verdict.note}` });
      return true;
    }
    for (const shot of redo) {
      Object.assign(shot, {
        status: "pending",
        frame_idem: `${creative.id}-shot${shot.n}-frame-c${rounds}`,
        frame_file_id: null,
        frame_url: null,
        frame_skipped: false,
        text_only: false,
        video_idem: `${creative.id}-shot${shot.n}-cut${rounds}`,
        job_id: null,
        monid_run_id: null,
        video_file_id: null,
        video_url: null,
        local_path: null,
        qc: null,
        qc_rounds: 0,
        error: null,
      });
    }
    await save("creatives", creative.id, { continuity_json: JSON.stringify({ checked: false, consistent: false, mismatched: verdict.mismatched, note: verdict.note, rounds }) });
    await logEvent({ brandId: ctx.brandId, campaignId: ctx.campaignId, message: `"${concept.title}": shot ${verdict.mismatched.join(", ")} shows a different person or place (${verdict.note}); re-rendering from shot 1` });
    return false;
  } catch (error) {
    if (error instanceof ApiError && error.retryable) return false;
    await save("creatives", creative.id, { continuity_json: JSON.stringify({ checked: true, consistent: false, mismatched: [], note: `not checked: ${message(error)}`, rounds }) });
    return true;
  }
}

async function makeFrame(ctx: ProductionContext, creativeId: string, concept: Concept, shots: ShotState[], shot: ShotState) {
  if (!ctx.naive || ctx.naiveOut()) {
    shot.frame_skipped = true;
    shot.status = "framed";
    return;
  }
  const first = shots[0];
  const identity = shot.previous_frame_file_id ?? (shot.n === 1 ? null : identityOf(first));
  const products = shot.drop_product_refs ? [] : concept.reference_images;
  const references = (identity ? [identity, ...products.slice(0, 2)] : products.slice(0, 3)).filter((ref): ref is string => Boolean(ref));
  // A later shot is shot 1's still re-posed: the edit names only the new pose, never a new place,
  // so the set never changes between takes (concepts from before poses re-describe the frame).
  const repose = identity && shot.n > 1 && shot.pose !== undefined && !shot.previous_frame_file_id;
  let prompt = repose
    ? `The first reference image is shot 1 of this video. Make the same photo again: the same person (face, hair, skin, outfit), the same place, the same light and the same camera framing, with nothing new in the room. Only the pose and expression change: ${shot.pose || "a natural mid-sentence expression, looking into the lens"}.`
    : identity
      ? `${shot.frame_prompt}\nThe first reference image is the same video: keep the exact same person, face, hair, outfit, location and lighting.`
      : shot.frame_prompt;
  if (shot.frame_fix) prompt += `\nA reviewer rejected the previous version of this frame. Fix exactly this: ${shot.frame_fix}`;
  // House rules for every frame, whatever the concept says: these are what make AI video look fake.
  prompt +=
    "\nPhotorealistic. No readable text anywhere, no captions, subtitles, cards, labels or graphics, no phone interface or status bar, no monitors or screens facing the camera, no logos except the product's own label.";
  try {
    const result = await ctx.naive.generateImage({ prompt, aspect_ratio: "9:16", image_urls: references.length ? references : undefined }, shot.frame_idem);
    const file = result.files[0];
    if (!file) throw new ApiError("naive", 500, "no_file", "the image render returned no file");
    shot.naive_cost += result.cost_micro_usd ?? 0;
    shot.frame_file_id = file.id;
    shot.frame_inflight_since = null;
    shot.frame_url = (await ctx.naive.fileUrl(file.id)).url;
    // Keep a copy for the review page and the first-frame gate: signed links expire after seven days.
    const key = fileKey(creativeId, `shot${shot.n}-frame.png`);
    shot.frame_key = await store()
      .files.saveUrl(key, shot.frame_url, "image/png")
      .then(() => key)
      .catch(() => null);
    shot.status = "framed";
  } catch (error) {
    if (error instanceof ApiError && error.inFlight) {
      onFrameInFlight(shot); // usually still rendering under this key: ask again next tick
      return;
    } else if (error instanceof ApiError && error.outOfCredits) {
      await ctx.markNaiveOut();
      shot.frame_skipped = true;
      shot.status = "framed";
    } else if (error instanceof ApiError && error.keyConflict) {
      shot.frame_idem = `${shot.frame_idem}-k${shot.submit_errors + 1}`; // same key, new body: a fresh key
      shot.submit_errors++;
    } else if (error instanceof ApiError && error.retryable && shot.submit_errors < MAX_SUBMIT_ERRORS) {
      backoff(shot);
    } else if (!shot.drop_product_refs && concept.reference_images.length && !(error instanceof ApiError && error.retryable)) {
      // A product photo the provider cannot fetch: keep the identity reference, drop the photos.
      shot.drop_product_refs = true;
      shot.frame_idem = `${shot.frame_idem}-noproduct`;
    } else {
      shot.frame_skipped = true;
      shot.status = "framed";
      shot.error = `first frame skipped: ${message(error)}`;
    }
  }
}

/**
 * The first-frame gate: a vision check of the still before the video model animates it. A new still
 * costs cents, a render dollars, and shot 1's still becomes every later shot's identity. A check that
 * cannot run never holds the video up.
 */
async function gateFrame(ctx: ProductionContext, creativeId: string, concept: Concept, shot: ShotState) {
  shot.frame_gated = true;
  if (shot.frame_skipped || !ctx.naive || ctx.naiveOut() || (shot.frame_checks ?? 0) >= FRAME_CHECKS) return;
  const image = await frameJpeg(await storedFrame(creativeId, shot.n));
  if (!image) return;
  const identity = shot.n > 1 ? await frameJpeg(await storedFrame(creativeId, 1)) : null;
  let verdict: { pass: boolean; issues: string[] };
  try {
    verdict = await reviewFrame(ctx.naive, { image, identity, creator: concept.creator, setting: concept.setting, prompt: shot.frame_prompt });
  } catch {
    return;
  }
  if (verdict.pass) return;
  shot.frame_checks = (shot.frame_checks ?? 0) + 1;
  const textDefect = TEXT_DEFECT.test(verdict.issues.join(" "));
  Object.assign(shot, {
    previous_frame_file_id: textDefect ? null : shot.frame_file_id,
    frame_fix: cleanFix(verdict.issues.slice(0, 3)),
    frame_file_id: null,
    frame_url: null,
    frame_idem: `${shot.frame_idem.replace(/-gate\d+$/, "")}-gate${shot.frame_checks}`,
    frame_gated: false,
    status: "pending",
  } satisfies Partial<ShotState>);
  await logEvent({ brandId: ctx.brandId, campaignId: ctx.campaignId, message: `"${concept.title}": remaking shot ${shot.n}'s first frame before rendering it (${verdict.issues.join("; ").slice(0, 300)})` });
}

/** A local copy of a shot's stored first frame, or null when there is none. */
async function storedFrame(creativeId: string, n: number): Promise<string | null> {
  const files = store().files;
  const key = fileKey(creativeId, `shot${n}-frame.png`);
  try {
    return (await files.exists(key)) ? await files.localPath(key) : null;
  } catch {
    return null;
  }
}

/** A frame as a JPEG small enough for the vision model, or null when it is not on disk. */
async function frameJpeg(path: string | null): Promise<Buffer | null> {
  const bin = await ffmpegPath();
  if (!bin || !path || !existsSync(path)) return null;
  const out = `${path}.check.jpg`;
  try {
    await execAsync(bin, ["-hide_banner", "-loglevel", "error", "-y", "-i", path, "-frames:v", "1", "-vf", "scale=540:-2", "-q:v", "4", out]);
    return await readFile(out);
  } catch {
    return null;
  } finally {
    await rm(out, { force: true }).catch(() => undefined);
  }
}

/**
 * The same key normally returns the finished frame a little later, so we wait. A request cut off
 * mid-way (the server restarted while the provider was at capacity) can stay "in flight" at the
 * provider for good: after FRAME_INFLIGHT_MS, ask again under a fresh key. At worst one extra still.
 */
export function onFrameInFlight(shot: Pick<ShotState, "frame_idem" | "frame_inflight_since" | "frame_rekeys">, now = Date.now()) {
  if (!shot.frame_inflight_since) {
    shot.frame_inflight_since = new Date(now).toISOString();
    return;
  }
  if (now - Date.parse(shot.frame_inflight_since) < FRAME_INFLIGHT_MS) return;
  shot.frame_rekeys = (shot.frame_rekeys ?? 0) + 1;
  shot.frame_idem = `${shot.frame_idem.replace(/-r\d+$/, "")}-r${shot.frame_rekeys}`;
  shot.frame_inflight_since = null;
}

async function submitRender(ctx: ProductionContext, shot: ShotState) {
  if (shot.renders >= MAX_RENDERS) {
    shot.status = "failed";
    shot.error ??= "render failed repeatedly";
    return;
  }
  // Kling 3.0 voicing the line itself is the presenter engine (it won the head-to-head); the Naive
  // video model is the alternative (presenter_engine "naive"), and Kling stays its fallback.
  const kling = getSetting("presenter_engine") !== "naive" && Boolean(ctx.monid);
  if (ctx.naive && !ctx.naiveOut() && !shot.force_monid && !kling) {
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
      if (error instanceof ApiError && error.inFlight) {
        return;
      } else if (error instanceof ApiError && error.outOfCredits) {
        await ctx.markNaiveOut();
      } else if (error instanceof ApiError && error.code === "validation_failed" && shot.frame_file_id && !shot.text_only) {
        shot.text_only = true; // this model does not animate a first frame: render from the prompt
        shot.video_idem = `${shot.video_idem}-t2v`;
        return;
      } else if (error instanceof ApiError && error.keyConflict) {
        shot.video_idem = `${shot.video_idem}-k${shot.submit_errors + 1}`;
        shot.submit_errors++;
        return;
      } else if (error instanceof ApiError && error.retryable && shot.submit_errors < MAX_SUBMIT_ERRORS) {
        backoff(shot);
        return;
      } else if (!monidVideoEnabled(ctx)) {
        shot.status = "failed";
        shot.error = message(error);
        return;
      }
    }
  }
  if (!kling && !monidVideoEnabled(ctx)) {
    shot.status = "failed";
    shot.error = "Naive is out of credits and the Monid video fallback is off";
    return;
  }
  const resolution = getSetting("monid_video_resolution");
  // About a second longer than the line needs: the edit trims each take to its best part.
  const duration = Math.max(3, Math.min(15, Math.ceil(shot.seconds + (kling ? 1 : 0))));
  const prompt = shot.prompt.slice(0, 3000);
  const firstFrame = shot.frame_url && !shot.text_only;
  try {
    const run = await ctx.monid!.run(
      "kling",
      firstFrame ? "/v1/video/kling-3.0-i2v" : "/v1/video/kling-3.0-t2v",
      { body: firstFrame ? { prompt, media: [{ type: "first_frame", url: shot.frame_url }], resolution, duration, audio: "native", multi_shot: false } : { prompt, resolution, aspect_ratio: "9:16", duration, audio: "native" } },
    );
    Object.assign(shot, { monid_run_id: run.runId, job_id: null, provider: "monid", status: "rendering", renders: shot.renders + 1, submit_errors: 0 });
    if (!kling) await logEvent({ brandId: ctx.brandId, campaignId: ctx.campaignId, message: `Shot ${shot.n} is rendering on Monid (Kling 3.0) because Naive is unavailable` });
    if (TERMINAL.has(run.status)) await finishMonid(run, shot);
  } catch (error) {
    if (error instanceof ApiError && error.retryable && shot.submit_errors < MAX_SUBMIT_ERRORS) backoff(shot);
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
    const key = fileKey(creativeId, `shot${shot.n}-r${shot.renders}.mp4`);
    await store().files.saveUrl(key, shot.video_url!, "video/mp4");
    shot.local_path = key;
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
    const frames = await extractFrames(await store().files.localPath(shot.local_path!), 4);
    const verdict = await reviewShot(ctx.naive!, { frames, brand: ctx.strategy.brand, concept, shot: concept.shots[shot.n - 1], shotNumber: shot.n, prompt: shot.prompt });
    shot.qc = verdict;
    shot.qc_rounds++;
    const retries = getInt("qc_max_retries");
    if (verdict.pass || shot.qc_rounds > retries || !verdict.fix_prompt || shot.renders >= MAX_RENDERS) {
      shot.status = "passed";
      if (!verdict.pass) await logEvent({ brandId: ctx.brandId, campaignId: ctx.campaignId, level: "warn", message: `"${concept.title}" shot ${shot.n} scored ${verdict.score}/10 after its re-render: ${verdict.issues[0] ?? "see QC notes"}` });
    } else {
      await logEvent({ brandId: ctx.brandId, campaignId: ctx.campaignId, message: `QC sent "${concept.title}" shot ${shot.n} back (${verdict.score}/10): ${verdict.issues[0] ?? "quality"}` });
      shot.prompt = verdict.fix_prompt;
      shot.video_idem = `${shot.video_idem.replace(/-qc\d+$/, "")}-qc${shot.qc_rounds}`;
      Object.assign(shot, { job_id: null, monid_run_id: null, video_file_id: null, video_url: null });
      if (shot.frame_file_id && ctx.naive && !ctx.naiveOut()) {
        // The first frame sets the composition, so a defect is often already in it: rebuild the
        // frame from the old one with the fixes, keeping the same person and room, then re-render.
        // Drawn-in text, cards or UI live in the old frame itself, so those rebuild from the
        // presenter's identity instead of copying the defect forward.
        const textDefect = TEXT_DEFECT.test(verdict.issues.join(" "));
        Object.assign(shot, {
          status: "pending",
          previous_frame_file_id: textDefect ? null : shot.frame_file_id,
          frame_fix: cleanFix(verdict.issues.slice(0, 3)),
          frame_file_id: null,
          frame_url: null,
          frame_idem: `${shot.frame_idem.replace(/-fix\d+$/, "")}-fix${shot.qc_rounds}`,
        });
      } else {
        shot.status = "framed";
      }
    }
  } catch (error) {
    if (error instanceof ApiError && error.retryable && (shot.qc_errors ?? 0) < 3) {
      shot.qc_errors = (shot.qc_errors ?? 0) + 1; // a busy or fumbling model: check again next tick
      return;
    }
    if (error instanceof ApiError && error.outOfCredits) await ctx.markNaiveOut();
    shot.status = "passed"; // QC is a gate for quality, not a reason to lose a finished render
    shot.error = `quality check skipped: ${message(error)}`;
  }
}

async function finalize(ctx: ProductionContext, creative: CreativeRow, concept: Concept, shots: ShotState[]) {
  const files = store().files;
  // The cut is made in scratch space, then kept under its key; the scratch folder goes either way.
  const dir = workDir(creative.id);
  await mkdir(dir, { recursive: true });
  try {
    await cutFinal(ctx, creative, concept, shots, dir, files);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function cutFinal(ctx: ProductionContext, creative: CreativeRow, concept: Concept, shots: ShotState[], dir: string, files: ReturnType<typeof store>["files"]) {
  const finalPath = join(dir, "final.mp4");
  const finalKey = fileKey(creative.id, "final.mp4");
  const scores = shots.map((shot) => shot.qc?.score).filter((score): score is number => typeof score === "number");
  const fields: Record<string, unknown> = { qc_score: scores.length ? Math.min(...scores) : null, poster_url: shots[0]?.frame_key || shots[0]?.frame_url ? `/api/media/${creative.id}/shot1-frame.png` : null, error: null };

  let edited = false;
  if (concept.script && concept.plan) {
    // The creative engine's cut: product cutaways over the creator's voice, captions, hook text.
    try {
      await editFinal(ctx, creative.id, concept, shots, finalPath);
      edited = true;
      const poster = join(dir, "shot0-frame.png");
      if (!fields.poster_url && (await savePoster(finalPath, poster))) {
        await files.putFile(fileKey(creative.id, "shot0-frame.png"), poster, "image/png");
        fields.poster_url = `/api/media/${creative.id}/shot0-frame.png`;
      }
    } catch (error) {
      if (error instanceof ApiError && error.retryable) return; // the voice-over is still coming: next tick
      await logEvent({ brandId: ctx.brandId, campaignId: ctx.campaignId, level: "warn", message: `"${concept.title}": the edit failed (${message(error)}); ${shots.length ? "falling back to a plain cut" : "no footage to fall back on"}` });
      if (!shots.length) {
        await save("creatives", creative.id, { status: "failed", error: `edit failed: ${message(error)}` });
        return;
      }
    }
  }
  if (!edited) {
    const sources = await Promise.all(shots.map((shot) => files.localPath(shot.local_path!)));
    if (await ffmpegPath()) {
      // Every ad, one shot or several, comes out as 1080x1920 at 30 fps with clean AAC audio.
      await stitch(sources, finalPath);
    } else if (shots.length === 1) {
      await copyFile(sources[0], finalPath);
      fields.final_file_id = shots[0].video_file_id;
      fields.final_url = shots[0].video_url;
    } else {
      await save("creatives", creative.id, { status: "failed", error: "ffmpeg is needed to cut shots together; install it or run npm install" });
      return;
    }
    if (shots.length === 1 && shots[0].provider === "monid") fields.final_external_url = shots[0].video_url;
  }
  await files.putFile(finalKey, finalPath, "video/mp4");
  fields.final_key = finalKey;
  if (!fields.final_file_id && ctx.naive) {
    try {
      const fileId = await ctx.naive.uploadFile(`${slug(concept.title)}.mp4`, "video/mp4", await readFile(finalPath));
      const link = await ctx.naive.fileUrl(fileId);
      Object.assign(fields, { final_file_id: fileId, final_url: link.url, final_url_expires_at: link.expires_at });
    } catch (error) {
      // Not lost: posting uploads the stored cut itself (publish.ts), waiting out a busy Naive.
      await logEvent({ brandId: ctx.brandId, campaignId: ctx.campaignId, level: "warn", message: `"${concept.title}" is ready; its upload to Naive failed (${message(error)}) and is retried when it is posted` });
    }
  }
  await save("creatives", creative.id, { ...fields, status: "ready" });
  await logEvent({ brandId: ctx.brandId, campaignId: ctx.campaignId, message: `"${concept.title}" is ready${scores.length ? ` (QC ${Math.min(...scores)}/10)` : ""}` });
}

/**
 * The screen builder's clips for this video (terminal, step cards, results, in the brand's look),
 * built once and recorded in a manifest. A screen that fails falls back to the beat's real visual;
 * one that failed only because the model was busy is tried again on a later tick. Returns true while
 * screens are still to come, so the edit waits for them.
 */
/**
 * A provider's "busy" answer, from its text: the screen builder reports some failures as text only
 * (the first Naive run lost 3 of 6 screens to "at capacity" that way).
 */
export const busyError = (error: string) => /at capacity|rate.?limit|too many requests|timed? ?out/i.test(error);

async function ensureScreens(ctx: ProductionContext, creativeId: string, concept: Concept): Promise<boolean> {
  // Only the screens the manifest has no answer for yet, so a re-planned video builds just its new ones.
  const done: ScreenManifest = (await readScreenManifest(creativeId)) ?? { clips: [], failures: [], attempts: {} };
  // A failure that was only a busy model is tried again, up to SCREEN_TRIES, recorded ones included.
  const retryLater = (f: { id: string; error: string }) => busyError(f.error) && (done.attempts?.[f.id] ?? 0) < SCREEN_TRIES;
  const known = new Set([...done.clips, ...done.failures.filter((f) => !retryLater(f))].map((entry) => entry.id));
  const requests = (concept.plan?.screens ?? []).filter((request) => !known.has(request.id));
  if (!requests.length || !ctx.product || !ctx.naive || ctx.naiveOut()) return false;
  // Built in scratch space; the finished clips are kept under "crv_…/screens/<name>".
  const workDir = join(scratchDir(), `screens-${creativeId}`);
  await mkdir(workDir, { recursive: true });
  try {
    // Headless Chrome renders the screens. Where there is none (a serverless host), buildScreens
    // fails and every beat falls back to its real visual, as for any screen that can't be built.
    const product = await withLocalVisuals(ctx.product);
    const result = await buildScreens(ctx.naive, requests, { product, kit: ctx.kit ?? null, style: concept.reference?.format }, { workDir });
    const attempts = { ...done.attempts };
    const later = result.failures.filter((f) => (f.retryable || busyError(f.error)) && (attempts[f.id] = (attempts[f.id] ?? 0) + 1) < SCREEN_TRIES);
    const rebuilt = new Set(requests.map((request) => request.id));
    const kept = await Promise.all(
      result.clips.map(async ({ id, kind, path }) => {
        const key = fileKey(creativeId, `screens/${basename(path)}`);
        await store().files.putFile(key, path, kind === "video" ? "video/mp4" : "image/png");
        return { id, kind, key };
      }),
    );
    const manifest: ScreenManifest = {
      clips: [...done.clips, ...kept],
      failures: [...done.failures.filter((f) => !rebuilt.has(f.id)), ...result.failures.filter((f) => !later.includes(f)).map(({ id, error }) => ({ id, error }))],
      attempts,
    };
    await writeScreenManifest(creativeId, manifest);
    await logEvent({
      brandId: ctx.brandId,
      campaignId: ctx.campaignId,
      level: result.failures.length ? "warn" : "info",
      message: `"${concept.title}": built ${result.clips.length} of ${requests.length} product screens${result.failures.length ? ` (${result.failures.map((f) => f.error).join("; ").slice(0, 300)})` : ""}${later.length ? `; trying ${later.length} again` : ""}`,
    });
    return later.length > 0;
  } catch (error) {
    if (error instanceof ApiError && error.retryable) return true; // try again next tick
    await writeScreenManifest(creativeId, { clips: done.clips, failures: [...done.failures, ...requests.map((r) => ({ id: r.id, error: message(error) }))] });
    await logEvent({ brandId: ctx.brandId, campaignId: ctx.campaignId, level: "warn", message: `"${concept.title}": product screens could not be built (${message(error)}); using the real visuals instead` });
    return false;
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * The product with every captured visual on this machine's disk. A screenshot kept by an earlier
 * tick is fetched again by its key when its local copy is gone (a serverless host).
 */
async function withLocalVisuals(product: ProductBrief): Promise<ProductBrief> {
  const files = store().files;
  const visuals = await Promise.all(
    product.visuals.map(async (visual) => {
      if (!visual.key || /^https?:/.test(visual.url) || existsSync(visual.url)) return visual;
      return { ...visual, url: await files.localPath(visual.key).catch(() => visual.url) };
    }),
  );
  return { ...product, visuals };
}

/**
 * filmed_screen's monitor photo, made once alongside the screens and recorded in plate.json.
 * Returns whether it is still coming (so the edit waits) and what it has cost. Provider trouble is
 * waited out like a shot's (15 s, 30 s, 1 min... apart); a video whose photos never show a clean
 * screen, or that runs out of patience or credits, is cut with its screens full frame instead.
 */
export async function ensurePlate(ctx: ProductionContext, creativeId: string, concept: Concept): Promise<{ pending: boolean; cost_micro: number }> {
  if (concept.plan?.format !== "filmed_screen") return { pending: false, cost_micro: 0 };
  const record = (await readPlate(creativeId)) ?? newPlateRecord();
  const done = { pending: false, cost_micro: record.cost_micro };
  if (record.status !== "pending") return done;
  // Without Naive the edit cannot voice the video either; if it still can, it shows the screens full frame.
  if (!ctx.naive || ctx.naiveOut()) return done;
  if (record.retry_at && Date.parse(record.retry_at) > Date.now()) return { pending: true, cost_micro: record.cost_micro };
  // The tries are scratch; the photo that passes is kept under "crv_…/plate.png".
  const dir = join(scratchDir(), `plate-${creativeId}`);
  await mkdir(dir, { recursive: true });
  try {
    record.retry_at = null;
    await makePlate(ctx.naive, record, { dir, key: creativeId, setting: concept.setting });
    record.inflight_since = null;
    if ((record.status as PlateRecord["status"]) === "ready" && record.plate) {
      const key = fileKey(creativeId, "plate.png");
      await store().files.putFile(key, record.plate.path, "image/png");
      record.plate.path = key; // a file key from here on (see plateFile)
    }
  } catch (error) {
    if (onPlateError(record, error)) await ctx.markNaiveOut();
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
  await writePlate(creativeId, record);
  // makePlate moves the record on; read its status fresh rather than as the check above narrowed it.
  const status = (): PlateRecord["status"] => record.status;
  if (status() === "ready") {
    const rejected = record.notes.length ? ` (after rejecting ${record.notes.join("; ").slice(0, 300)})` : "";
    await logEvent({ brandId: ctx.brandId, campaignId: ctx.campaignId, message: `"${concept.title}": the monitor photo for the filmed screens is ready${rejected}` });
  } else if (status() === "fallback") {
    await logEvent({ brandId: ctx.brandId, campaignId: ctx.campaignId, level: "warn", message: `"${concept.title}": no usable monitor photo (${(record.reason ?? "").slice(0, 400)}); showing the screens full frame instead` });
  }
  return { pending: status() === "pending", cost_micro: record.cost_micro };
}

/**
 * What provider trouble does to a plate in the making. A request still in flight is waited for,
 * and asked anew under the next key after FRAME_INFLIGHT_MS; a reused key moves to the next one;
 * busy or failing providers are waited out with growing pauses, PLATE_ERRORS times; anything
 * else, or no credits, gives up on the plate. Returns true when Naive is out of credits.
 */
export function onPlateError(record: PlateRecord, error: unknown, now = Date.now()): boolean {
  if (error instanceof ApiError && error.inFlight) {
    record.inflight_since ??= new Date(now).toISOString();
    if (now - Date.parse(record.inflight_since) >= FRAME_INFLIGHT_MS) {
      record.tries++;
      record.notes.push(`image ${record.tries}: never came back`);
      record.inflight_since = null;
    }
  } else if (error instanceof ApiError && error.outOfCredits) {
    Object.assign(record, { status: "fallback", reason: "Naive is out of credits" });
    return true;
  } else if (error instanceof ApiError && error.keyConflict) {
    record.tries++; // the key was used for another prompt: the next try gets a fresh one
  } else if (error instanceof ApiError && error.retryable && record.errors < PLATE_ERRORS) {
    record.retry_at = new Date(now + Math.min(300, 15 * 2 ** record.errors) * 1000).toISOString();
    record.errors++;
  } else {
    Object.assign(record, { status: "fallback", reason: message(error) });
  }
  return false;
}

/** Builds the edit timeline from the rendered A-roll (or a voice-over) and the product visuals, and renders it. */
async function editFinal(ctx: ProductionContext, creativeId: string, concept: Concept, shots: ShotState[], finalPath: string) {
  const script = concept.script!;
  const plan = concept.plan!;
  const files = store().files;
  const dir = workDir(creativeId);
  // Cut the dead air a 4/6/8 s render leaves around the line, so the edit is as tight as the reference.
  const aroll = await Promise.all(
    shots.map(async (shot) => {
      const source = await files.localPath(shot.local_path!);
      return trimSilence(source, join(dir, `shot${shot.n}-tight.mp4`)).catch(async () => ({ path: source, duration: (await probe(source)).duration }));
    }),
  );

  let voiceover: RenderedAssets["voiceover"] = null;
  if (!plan.aroll.length && plan.voiceover) {
    // Kept between ticks: speech costs money, and a busy provider means trying again next tick.
    const key = fileKey(creativeId, "voiceover.wav");
    if (!(await files.exists(key))) {
      if (!ctx.naive || ctx.naiveOut()) throw new Error("the voice-over needs Naive");
      const target = script.beats.reduce((sum, beat) => sum + beat.seconds, 0);
      const speed = voiceSpeed(plan.voiceover.text, target);
      const rawKey = fileKey(creativeId, "voiceover-raw.wav");
      if (!(await files.exists(rawKey))) {
        const raw = join(dir, "voiceover-raw.wav");
        await speakTo(ctx.naive, plan.voiceover, speed, `${creativeId}-voiceover-${speed}`, raw);
        await files.putFile(rawKey, raw, "audio/wav");
      }
      const paced = join(dir, "voiceover.wav");
      await paceVoice(await files.localPath(rawKey), target, paced);
      await files.putFile(key, paced, "audio/wav");
    }
    const path = await files.localPath(key);
    voiceover = { path, duration: (await probe(path)).duration };
  }

  const visuals: RenderedAssets["visuals"] = new Map();
  const wanted = new Set([...plan.broll.map((clip) => clip.visual_id), ...script.beats.map((beat) => beat.product_visual).filter((id): id is string => Boolean(id))]);
  const product = ctx.product ? await withLocalVisuals(ctx.product) : undefined;
  for (const visual of product?.visuals ?? []) {
    if (!wanted.has(visual.id)) continue;
    try {
      let path = visual.url;
      if (/^https?:/.test(visual.url)) {
        path = join(dir, "visuals", `${visual.id}${extname(new URL(visual.url).pathname).slice(0, 6) || ".jpg"}`);
        if (!existsSync(path)) await download(visual.url, path);
      }
      if (existsSync(path)) visuals.set(visual.id, { path, kind: visual.kind === "video" ? "video" : "image" });
    } catch {
      // an image that will not download: the beat falls back to the creator
    }
  }

  const manifest = await readScreenManifest(creativeId);
  for (const clip of manifest?.clips ?? []) {
    const path = await clipPath(clip);
    if (path) visuals.set(screenVisualId(clip.id), { path, kind: clip.kind });
  }

  // filmed_screen: the monitor photo the screens are filmed on (none: they fill the frame instead).
  let plate: FilmedPlate | null = null;
  if (plan.format === "filmed_screen") {
    const record = await readPlate(creativeId);
    const path = record?.status === "ready" && record.plate ? await plateFile(record.plate.path) : null;
    if (path && record?.plate) plate = { path, quad: record.plate.quad };
  }

  const timeline = buildTimeline(script, plan, { aroll, voiceover, visuals, plate }, (segments) => chunkCaptions(segments, 3));
  await renderTimeline(timeline, finalPath, { workDir: join(dir, "edit"), finish: getSetting("finish") !== "off" });
}

/** Text-to-speech through Naive, saved as a local file for the edit. */
/** Words per second the text-to-speech voice reads at speed 1 (measured: 150 words in 48.4 s). */
const TTS_WPS = 3.1;

/**
 * The speed that reads the script in the time it was written for: the references talk fast (230-250
 * wpm), the default voice does not. Never slower than normal, never past 1.5x.
 */
export function voiceSpeed(text: string, seconds: number): number {
  const words = text.split(/\s+/).filter(Boolean).length;
  if (!words || seconds <= 0) return 1;
  return Math.round(Math.min(1.5, Math.max(1, words / seconds / TTS_WPS)) * 100) / 100;
}

/**
 * The speech API treats speed as a hint, so the voice can still run long. Time-stretch it (pitch
 * kept) to the script's length when it is more than 6% over, by at most 1.3x.
 */
export async function paceVoice(raw: string, target: number, out: string) {
  const bin = await ffmpegPath();
  const { duration } = await probe(raw);
  const factor = target > 0 ? Math.min(1.3, duration / target) : 1;
  if (!bin || factor < 1.06) return copyFile(raw, out);
  await execAsync(bin, ["-hide_banner", "-loglevel", "error", "-y", "-i", raw, "-af", `atempo=${factor.toFixed(3)}`, out]);
}

async function speakTo(naive: NonNullable<ProductionContext["naive"]>, voiceover: { text: string; voice: string }, speed: number, idempotencyKey: string, path: string) {
  const speech = await naive.speak({ text: voiceover.text.slice(0, 4000), ...(voiceover.voice ? { voice: voiceover.voice } : {}), ...(speed !== 1 ? { speed } : {}) }, idempotencyKey);
  const fileId = speechFileId(speech);
  if (!fileId) throw new ApiError("naive", 502, "no_file", "text-to-speech returned no file");
  await download((await naive.fileUrl(fileId)).url, path);
}

function speechFileId(speech: unknown): string | null {
  const record = (speech ?? {}) as Record<string, unknown>;
  const file = (record.file ?? record.result ?? null) as Record<string, unknown> | null;
  const candidates = [record.file_id, file?.id, file?.file_id, record.id];
  return (candidates.find((value) => typeof value === "string" && value.startsWith("fil_")) as string | undefined) ?? null;
}

const execAsync = promisify(execFile);

/** A still from the finished video, for formats that have no first frame to show. */
async function savePoster(videoPath: string, out: string) {
  const bin = await ffmpegPath();
  if (!bin) return false;
  try {
    await execAsync(bin, ["-hide_banner", "-loglevel", "error", "-y", "-ss", "1.0", "-i", videoPath, "-frames:v", "1", "-vf", "scale=540:-2", out]);
    return existsSync(out);
  } catch {
    return false;
  }
}

function monidVideoEnabled(ctx: ProductionContext) {
  return Boolean(ctx.monid) && getBool("monid_video_fallback");
}

export function firstVideoUrl(output: unknown): string | null {
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
