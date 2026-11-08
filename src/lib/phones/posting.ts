// OWNED BY THE PHONES TRACK (see docs/handoff-dylan.md). "Post through phone": the worker's steps
// for one finished video, posted by Mobilerun's phone agent in the TikTok app on the brand's phone.
//
// A post moves pending -> (waiting) -> starting (copy the cut onto the phone, then create the task)
// -> queued/running -> posted, failed or cancelled. It shares the phone with warm-up sessions, one
// task at a time, and its phone is parked once it is over. Copying the cut and creating the task
// are safe to repeat; the task itself runs once. A post that failed is never tried again by
// itself, because the video may have gone out: a person posts it again.
import { readFile } from "node:fs/promises";
import { logEvent, now, parse, store } from "../db";
import { ApiError } from "../http";
import { probe } from "../media";
import type { CreativeRow } from "../production";
import { postingHold } from "../publish";
import type { Concept } from "../strategy";
import { AGENT_MODEL, APP_PACKAGES, POST_OUTPUT_SCHEMA, TERMINAL_TASK_STATES, postTask, type Device, type MobilerunClient, type TaskInput, type TaskState } from "./mobilerun";
import { LIMITS, POLL, POST_LIMITS, describeApiError, describeDevice, isRecordingUnsupported, phoneAction, postOutcome, sessionStatusFor } from "./rules";
import {
  ACTIVE_STATUSES,
  claimPhonePost,
  deviceBusy,
  getBrand,
  getLink,
  listAccounts,
  requestPark,
  updateActivePhonePost,
  type PhonePostRow,
  type PhonePostStatus,
} from "./store";

/** Where the cut goes on the phone, best first: the camera's folder, else DCIM (every Android phone has one). */
const FOLDERS = ["/DCIM/Camera", "/DCIM"];
/** Earlier posts' cuts, cleared before a new one so the newest video in the gallery is the right one. */
const OUR_VIDEOS = /^nomen-.+\.mp4$/;

const later = (ms: number) => new Date(Date.now() + ms).toISOString();
const age = (iso: string | null) => (iso ? Date.now() - Date.parse(iso) : 0);
const cutKey = (creative: Pick<CreativeRow, "id" | "final_key">) => creative.final_key || `${creative.id}/final.mp4`;
const activeStatus = (state: TaskState): PhonePostStatus => (sessionStatusFor({ status: state, succeeded: null }) === "running" ? "running" : "queued");
const ACTIVE = ACTIVE_STATUSES as PhonePostStatus[];

/** One worker step for a post whose next check is due. */
export async function advancePost(client: MobilerunClient, post: PhonePostRow, device: (id: string) => Promise<Device>) {
  switch (post.status) {
    case "pending":
    case "waiting":
      return startWhenPhoneReady(client, post, device);
    case "starting":
      // Another tick is copying the cut or creating the task, or crashed doing it. Both are safe to repeat.
      if (age(post.updated_at) > LIMITS.staleStartMs) return copyAndCreate(client, post);
      return updateActivePhonePost(post.id, { next_check_at: later(POLL.running) });
    case "queued":
    case "running":
      return poll(client, post);
  }
}

/** Why a queued post must not go out any more, or null. Checked before the phone is woken. */
async function stopReason(post: PhonePostRow): Promise<{ status: "failed" | "cancelled"; message: string } | null> {
  const link = getLink(post.brand_id);
  if (!link || link.device_id !== post.device_id || !listAccounts(post.brand_id).some((account) => account.platform === "tiktok")) {
    return { status: "cancelled", message: "The brand's phone or TikTok account was unlinked before the post started." };
  }
  const [creative] = await store().find<CreativeRow>("creatives", { id: post.creative_id }, { limit: 1 });
  if (!creative) return { status: "failed", message: "Not posted: the video was deleted." };
  const hold = postingHold(parse<Concept | null>(creative.concept_json, null));
  if (hold) return { status: "failed", message: `Not posted: ${hold}.` };
  if (!creative.approved || creative.rejected) return { status: "failed", message: "Not posted: the video is no longer approved." };
  return null;
}

async function startWhenPhoneReady(client: MobilerunClient, post: PhonePostRow, device: (id: string) => Promise<Device>) {
  const stop = await stopReason(post);
  if (stop) return finishPost(post, stop.status, stop.message);
  if (deviceBusy(post.device_id, post.id)) {
    return updateActivePhonePost(post.id, { message: "Waiting for the phone's current session to finish.", next_check_at: later(POLL.waitingForPhone) });
  }
  const phone = await device(post.device_id);
  const action = phoneAction(phone.state);
  const words = describeDevice(phone.state);
  if (action === "fail") return finishPost(post, "failed", words.detail);
  if (action === "run") {
    if (!claimPhonePost(post.id, ["pending", "waiting"], "starting", { attempts: post.attempts + 1, message: "Copying the video onto the phone." })) return;
    return copyAndCreate(client, { ...post, status: "starting", attempts: post.attempts + 1 });
  }
  const waitingSince = post.waiting_since ?? now();
  if (age(waitingSince) > LIMITS.waitForPhoneMs) return finishPost(post, "failed", `The phone wasn't ready within an hour. ${words.detail}`);
  if (action === "resume") {
    await client.resumeDevice(post.device_id);
    if (post.status === "pending") await logEvent({ brandId: post.brand_id, message: `Phones: waking up the parked phone to post “${post.title}”.` });
  }
  updateActivePhonePost(post.id, {
    status: "waiting",
    waiting_since: waitingSince,
    message: action === "resume" ? "Waking up the parked phone." : words.detail,
    next_check_at: later(POLL.waitingForPhone),
  });
}

async function copyAndCreate(client: MobilerunClient, post: PhonePostRow) {
  const stop = await stopReason(post);
  if (stop) return finishPost(post, stop.status, stop.message);
  const brand = getBrand(post.brand_id)!;
  const link = getLink(post.brand_id)!;
  const account = listAccounts(post.brand_id).find((row) => row.platform === "tiktok")!;

  let { folder, video_seconds: seconds } = post;
  if (!post.uploaded_at || !folder) {
    ({ folder, seconds } = await copyCut(client, post));
    updateActivePhonePost(post.id, { folder, video_seconds: seconds, uploaded_at: now(), message: "Starting the phone agent." });
  }

  const packageName = APP_PACKAGES.tiktok;
  const input: TaskInput = {
    task: postTask({
      brand: brand.name,
      fileName: post.file_name,
      folder: folder.split("/").filter(Boolean).pop() ?? folder,
      seconds,
      caption: post.caption,
      visibility: post.visibility,
      song: post.sound_request,
    }),
    deviceId: post.device_id,
    llmModel: AGENT_MODEL,
    maxSteps: POST_LIMITS.maxSteps,
    executionTimeout: POST_LIMITS.executionTimeout,
    reasoning: true,
    vision: true,
    humanize: true,
    recordingEnabled: true,
    apps: [packageName],
    credentials: account.credential_name ? [{ packageName, credentialNames: [account.credential_name] }] : [],
    outputSchema: POST_OUTPUT_SCHEMA,
    ...(link.vpn_country ? { vpnCountry: link.vpn_country } : {}),
  };

  // The post's id is the task's Idempotency-Key: a retried create returns the same task, never a second post.
  let created;
  try {
    created = await client.createTask(input, post.id);
  } catch (error) {
    if (!isRecordingUnsupported(error)) throw error;
    created = await client.createTask({ ...input, recordingEnabled: false }, `${post.id}-norec`);
  }

  const saved = updateActivePhonePost(post.id, {
    status: activeStatus(created.status),
    task_id: created.id,
    task_status: created.status,
    started_at: now(),
    message: created.status === "queued" ? "Queued behind another task on the phone." : "The phone agent is posting the video.",
    error: null,
    next_check_at: later(POLL.running),
  });
  if (!saved) {
    // The post was stopped while the task was being created: stop the task too.
    await client.cancelTask(created.id).catch(() => undefined);
    return;
  }
  await logEvent({ brandId: post.brand_id, message: `Phones: posting “${post.title}” on TikTok through the brand's phone.` });
}

/**
 * Copies the cut into the phone's camera folder, where TikTok's gallery finds it, after removing
 * earlier posts' cuts so the newest video there is this one. Checks it arrived whole.
 */
async function copyCut(client: MobilerunClient, post: PhonePostRow): Promise<{ folder: string; seconds: number | null }> {
  const [creative] = await store().find<CreativeRow>("creatives", { id: post.creative_id }, { limit: 1 });
  const key = cutKey(creative ?? { id: post.creative_id, final_key: null });
  if (!(await store().files.exists(key))) throw new Error("Not posted: the video has no finished file.");
  const path = await store().files.localPath(key);
  const bytes = await readFile(path);

  const { folder, files } = await videoFolder(client, post.device_id);
  for (const file of files) {
    if (OUR_VIDEOS.test(file.name) && file.name !== post.file_name) await client.deleteFile(post.device_id, `${folder}/${file.name}`).catch(() => undefined);
  }
  await client.uploadFile(post.device_id, { folder, name: post.file_name, bytes, contentType: "video/mp4" });
  const landed = (await client.listFiles(post.device_id, folder)).find((file) => file.name === post.file_name);
  if (landed?.size !== bytes.length) throw new ApiError("mobilerun", 0, "upload_incomplete", "the video didn't arrive whole on the phone");

  // Its length helps the agent pick the right video in the gallery.
  const seconds = await probe(path).then(
    (info) => info.duration || null,
    () => null,
  );
  return { folder, seconds };
}

/** The first of FOLDERS the phone has, and what is in it. A missing folder answers 404. */
async function videoFolder(client: MobilerunClient, deviceId: string) {
  for (const [i, folder] of FOLDERS.entries()) {
    try {
      return { folder, files: await client.listFiles(deviceId, folder) };
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 404) || i === FOLDERS.length - 1) throw error;
    }
  }
  throw new Error("unreachable");
}

async function poll(client: MobilerunClient, post: PhonePostRow) {
  if (!post.task_id) {
    // Should not happen: an active post past `starting` always has a task. Start over; the cut stays on the phone.
    return updateActivePhonePost(post.id, { status: "waiting", next_check_at: now() });
  }
  if (post.started_at && age(post.started_at) > POST_LIMITS.executionTimeout * 1000 + LIMITS.overrunMs) {
    await client.cancelTask(post.task_id).catch(() => undefined);
    return finishPost(post, "failed", "The post ran far longer than planned, so it was stopped. Check the brand's TikTok profile before posting it again: the video may have gone out.");
  }
  const task = await client.taskStatus(post.task_id);
  const fields = { task_status: task.status, steps: task.steps ?? post.steps, recording_id: task.recordingId ?? post.recording_id };
  if (TERMINAL_TASK_STATES.has(task.status)) {
    const outcome = postOutcome(task, post.visibility);
    const { sound } = outcome;
    return finishPost(
      post,
      outcome.status,
      outcome.message,
      {
        ...fields,
        post_url: outcome.url,
        sound_title: sound?.title ?? null,
        sound_artist: sound?.artist ?? null,
        sound_volume: sound?.volume ?? null,
        sound_commercial: sound?.commercial == null ? null : Number(sound.commercial),
        account_type: sound?.accountType ?? null,
      },
      outcome.warn,
    );
  }
  updateActivePhonePost(post.id, {
    ...fields,
    status: activeStatus(task.status),
    message: task.status === "queued" ? "Queued behind another task on the phone." : "The phone agent is posting the video.",
    next_check_at: later(POLL.running),
  });
}

/** Ends a post once, then parks its phone (unless another session or post needs it soon). */
async function finishPost(post: PhonePostRow, status: Extract<PhonePostStatus, "posted" | "failed" | "cancelled">, message: string, fields: Record<string, unknown> = {}, warn = status === "failed") {
  if (!claimPhonePost(post.id, ACTIVE, status, { message, finished_at: now(), ...fields })) return;
  requestPark(post.device_id, post.brand_id);
  const url = typeof fields.post_url === "string" ? fields.post_url : null;
  const notes = message.replace(/^Posted on TikTok[^.]*\.\s*/, "");
  const what = `“${post.title}”${post.visibility === "private" ? " as a private test" : ""}`;
  const song = typeof fields.sound_title === "string" ? `, with “${fields.sound_title}”${typeof fields.sound_artist === "string" ? ` by ${fields.sound_artist}` : ""}` : "";
  const line =
    status !== "posted"
      ? `Phones: ${what} wasn't posted on TikTok${status === "cancelled" ? " (stopped)" : ""}. ${message.replace(/^Not posted: /, "")}`
      : notes
        ? `Phones: posted ${what} on TikTok through the brand's phone${song}. ${notes}${url ? ` Link: ${url}` : ""}`
        : `Phones: posted ${what} on TikTok through the brand's phone${song}${url ? `: ${url}` : "."}`;
  await logEvent({ brandId: post.brand_id, level: warn ? "warn" : "info", message: line.slice(0, 500) });
}

/** A failed step: try again later while nothing can have gone out yet, else end the post. */
export async function onPostError(post: PhonePostRow, error: unknown) {
  const { message, retry } = describeApiError(error);
  const attempts = post.attempts + 1;
  if (retry && attempts < LIMITS.maxAttempts) {
    updateActivePhonePost(post.id, {
      // Without a task nothing was posted: wait for the phone again and repeat the copy and the create.
      ...(post.task_id ? {} : { status: "waiting" as const }),
      attempts,
      error: message,
      next_check_at: later(POLL.retryAfterError * attempts),
    });
    return;
  }
  await finishPost(post, "failed", message, { error: message, attempts });
}
