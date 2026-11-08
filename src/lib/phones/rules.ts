// OWNED BY THE PHONES TRACK (see docs/handoff-dylan.md). Pure rules: scheduling, limits, and the
// plain-language wording for phone and task states. No I/O, so the tests cover these directly.
import { ApiError } from "../http";
import type { DeviceState, TaskStatus } from "./mobilerun";
import type { SessionStatus } from "./store";

export const DAY_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_SCHEDULE_DAYS = 7;
export const MAX_SCHEDULE_DAYS = 30;

/** How often the worker re-checks a session, by what it is waiting for. */
export const POLL = {
  running: 10_000,
  waitingForPhone: 20_000,
  retryAfterError: 30_000,
};

/** Give up on a phone that never becomes ready, and on a task that never finishes. */
export const LIMITS = {
  waitForPhoneMs: 60 * 60 * 1000,
  /** Added to the session length before a still-running session is treated as stuck. */
  overrunMs: 30 * 60 * 1000,
  /** A `starting` session older than this crashed mid-create; the idempotency key makes a retry safe. */
  staleStartMs: 60 * 1000,
  maxAttempts: 5,
};

/**
 * Parking a phone once its work is done. A phone is left on when another session is due within
 * `graceMs` (parking and waking it again would only slow that session down). A failed park is
 * retried with a growing wait, at most `maxBackoffMs` apart, until the phone is parked.
 */
export const PARK = {
  graceMs: 5 * 60 * 1000,
  maxBackoffMs: 10 * 60 * 1000,
};

/** Step and time budget for one warm-up session of `minutes` minutes (Mobilerun caps the timeout at 2700 s). */
export function taskLimits(minutes: number) {
  const safeMinutes = Math.min(Math.max(Math.round(minutes) || 12, 1), 40);
  return {
    minutes: safeMinutes,
    maxSteps: Math.min(safeMinutes * 12, 480),
    executionTimeout: Math.min(safeMinutes * 60 + 300, 2700),
  };
}

/** Rough credit cost: Mobilerun bills about 0.5 credits ($0.005) per agent step. */
export const estimateCredits = (minutes: number) => Math.round(taskLimits(minutes).maxSteps * 0.5);

/** One post through a phone: enough steps and time to upload, caption, label, post and copy the link. */
export const POST_LIMITS = { maxSteps: 80, executionTimeout: 900, minutes: 15 };
export const estimatePostCredits = () => Math.round(POST_LIMITS.maxSteps * 0.5);

const CAPTION_MAX = 2200; // TikTok's caption limit
const AI_TAG = "#AIgenerated";

/**
 * The caption the phone agent types: one line, since typing line breaks into the app is
 * unreliable, and tagged #AIgenerated the way Naive tags the posts it makes.
 */
export function phoneCaption(caption: string) {
  const text = caption.replace(/\s+/g, " ").trim();
  if (/#aigenerated\b/i.test(text)) return text.slice(0, CAPTION_MAX);
  return `${text.slice(0, CAPTION_MAX - AI_TAG.length - 1).trimEnd()} ${AI_TAG}`.trim();
}

const sentence = (text: string) => (/[.!?]$/.test(text) ? text : `${text}.`);
const MAY_BE_OUT = "Check the brand's TikTok profile before posting it again: the video may have gone out.";

/**
 * What a finished posting task did, from the report its output schema asks for
 * (`POST_OUTPUT_SCHEMA`). A video the agent says it posted counts as posted even when the task
 * failed afterwards, so nobody posts it twice; a task that ended without a report may have posted.
 */
export function postOutcome(task: Pick<TaskStatus, "status" | "succeeded" | "message" | "execution" | "output">): {
  status: "posted" | "failed" | "cancelled";
  url: string | null;
  /** Worth a warning in the activity log. */
  warn: boolean;
  message: string;
} {
  const report = (task.output ?? {}) as { posted?: unknown; postUrl?: unknown; aiLabel?: unknown; reason?: unknown };
  const link = typeof report.postUrl === "string" ? report.postUrl.trim() : "";
  const url = /^https?:\/\/\S+$/i.test(link) ? link : null;
  if (report.posted === true) {
    const notes = [
      url ? null : "The agent couldn't copy the post's link; the video is on the brand's TikTok profile.",
      report.aiLabel === false ? "TikTok's AI-generated label may be off: check the post and turn it on." : null,
    ].filter(Boolean);
    return { status: "posted", url, warn: report.aiLabel === false, message: ["Posted on TikTok.", ...notes].join(" ") };
  }
  if (sessionStatusFor(task) === "cancelled") return { status: "cancelled", url: null, warn: false, message: `Stopped before it finished. ${MAY_BE_OUT}` };
  const reason = typeof report.reason === "string" ? report.reason.trim() : "";
  if (report.posted === false) return { status: "failed", url: null, warn: true, message: `Not posted: ${sentence(reason || "the phone agent gave no reason")}` };
  const why =
    task.execution?.terminationReason === "execution_timeout"
      ? "The phone agent ran out of time."
      : task.execution?.terminationReason === "worker_lost"
        ? "Mobilerun lost contact with the phone partway through."
        : task.message?.trim()
          ? `The phone agent couldn't finish: ${sentence(task.message.trim())}`
          : "The task failed without a reason from Mobilerun.";
  return { status: "failed", url: null, warn: true, message: `${why} ${MAY_BE_OUT}` };
}

/** Which day of the schedule `at` falls in (0-based), or null outside it. */
export function scheduleDay(schedule: { enabled: boolean; days: number; startedAt: string | null }, at: Date): number | null {
  if (!schedule.enabled || !schedule.startedAt) return null;
  const elapsed = at.getTime() - Date.parse(schedule.startedAt);
  if (!Number.isFinite(elapsed) || elapsed < 0) return null;
  const day = Math.floor(elapsed / DAY_MS);
  return day < schedule.days ? day : null;
}

export function scheduleSummary(schedule: { enabled: boolean; days: number; startedAt: string | null }, at: Date) {
  if (!schedule.enabled || !schedule.startedAt) return { state: "off" as const, day: null, days: schedule.days, nextAt: null, endsAt: null };
  const start = Date.parse(schedule.startedAt);
  const endsAt = new Date(start + schedule.days * DAY_MS).toISOString();
  const day = scheduleDay(schedule, at);
  if (day === null) return { state: at.getTime() < start ? ("scheduled" as const) : ("finished" as const), day: null, days: schedule.days, nextAt: null, endsAt };
  const next = day + 1 < schedule.days ? new Date(start + (day + 1) * DAY_MS).toISOString() : null;
  return { state: "running" as const, day: day + 1, days: schedule.days, nextAt: next, endsAt };
}

export function clampDays(days: unknown) {
  const value = Math.round(Number(days));
  return Number.isFinite(value) ? Math.min(Math.max(value, 1), MAX_SCHEDULE_DAYS) : DEFAULT_SCHEDULE_DAYS;
}

/** Maps Mobilerun's task status onto a session status. */
export function sessionStatusFor(task: Pick<TaskStatus, "status" | "succeeded">): SessionStatus {
  switch (task.status) {
    case "prepared":
    case "queued":
    case "created":
      return "queued";
    case "running":
    case "cancelling":
      return "running";
    case "completed":
      return task.succeeded === false ? "failed" : "succeeded";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    default:
      return "running";
  }
}

const DEVICE_WORDS: Record<DeviceState, { label: string; detail: string; tone: "good" | "warn" | "bad" | "info" | "neutral" }> = {
  ready: { label: "Ready", detail: "The phone is on and can run a session.", tone: "good" },
  creating: { label: "Setting up", detail: "Mobilerun is setting up this phone. This usually takes a few minutes.", tone: "info" },
  assigned: { label: "Starting", detail: "The phone has been assigned and is starting up.", tone: "info" },
  rebooting: { label: "Restarting", detail: "The phone is restarting and will be ready shortly.", tone: "info" },
  migrating: { label: "Moving", detail: "Mobilerun is moving this phone to new hardware. Its apps and logins are kept.", tone: "info" },
  resetting: { label: "Resetting", detail: "The phone is being reset.", tone: "warn" },
  maintenance: { label: "Maintenance", detail: "Mobilerun is doing maintenance on this phone. Sessions wait until it is back.", tone: "warn" },
  stopped: { label: "Parked", detail: "The phone is parked: it keeps its apps and logins and is not billed. A session wakes it up first.", tone: "neutral" },
  terminated: { label: "Deleted", detail: "This phone was deleted in Mobilerun. Link a different phone.", tone: "bad" },
  unknown: { label: "Unreachable", detail: "Mobilerun can't reach this phone right now.", tone: "bad" },
};

export function describeDevice(state: string | undefined) {
  const words = DEVICE_WORDS[(state ?? "unknown") as DeviceState] ?? { label: state ?? "Unknown", detail: `Mobilerun reports the phone as "${state}".`, tone: "neutral" as const };
  return {
    ...words,
    canRun: state === "ready",
    canResume: state === "stopped",
    /** The phone will never become ready on its own. */
    gone: state === "terminated",
  };
}

/** What happens to a session whose phone is in `state`. */
export function phoneAction(state: string | undefined): "run" | "resume" | "wait" | "fail" {
  if (state === "ready") return "run";
  if (state === "stopped") return "resume";
  if (state === "terminated") return "fail";
  return "wait";
}

/** A finished task's outcome in plain language. */
export function describeTaskOutcome(task: Pick<TaskStatus, "status" | "succeeded" | "message" | "execution">, minutes: number): string {
  const message = task.message?.trim();
  if (sessionStatusFor(task) === "succeeded") return message || "Finished.";
  switch (task.execution?.terminationReason) {
    case "execution_timeout":
      return `Ran out of time before finishing (the limit was about ${minutes + 5} minutes).${message ? ` ${message}` : ""}`;
    case "worker_lost":
      return "Mobilerun lost contact with the phone partway through. The next session starts fresh.";
    case "cancelled":
      return "Stopped before it finished.";
    case "agent_failed":
      return `The phone agent couldn't finish: ${message || "no reason given"}.`;
  }
  if (task.status === "cancelled") return "Stopped before it finished.";
  return message ? `The phone agent couldn't finish: ${message}` : "The session failed without a reason from Mobilerun.";
}

/** A Mobilerun API error in plain language, plus whether trying again later can help. */
export function describeApiError(error: unknown): { message: string; retry: boolean } {
  if (!(error instanceof ApiError)) return { message: error instanceof Error ? error.message : String(error), retry: false };
  const text = `${error.code} ${error.message}`;
  if (error.code === "not_configured") return { message: "No Mobilerun API key. Add one in Settings.", retry: false };
  if (error.status === 401 || error.status === 403) return { message: "Mobilerun rejected the API key. Check it in Settings.", retry: false };
  if (/MINUTE_BALANCE_EXHAUSTED/i.test(text)) return { message: "The Mobilerun plan's phone minutes are used up. Add minutes or upgrade the plan.", retry: false };
  if (error.status === 402) return { message: "The Mobilerun account is out of credits or phone minutes.", retry: false };
  if (/DEVICE_TYPE_UNAVAILABLE/i.test(text)) return { message: "Mobilerun can't create Android cloud phones on this account right now.", retry: false };
  if (/DEVICE_RECORDING_UNSUPPORTED/i.test(text)) return { message: "This phone can't record its screen.", retry: false };
  if (error.status === 404) return { message: "Mobilerun doesn't know this phone or task. It may have been deleted.", retry: false };
  if (error.status === 409) return { message: "The phone is busy with another task. Trying again shortly.", retry: true };
  if (error.status === 429) return { message: "Mobilerun is rate limiting requests. Trying again shortly.", retry: true };
  if (error.retryable) return { message: "Couldn't reach Mobilerun. Trying again shortly.", retry: true };
  return { message: `Mobilerun refused the request: ${error.message.replace(/^mobilerun: /, "")}`, retry: false };
}

export const isRecordingUnsupported = (error: unknown) => error instanceof ApiError && /RECORDING_UNSUPPORTED/i.test(`${error.code} ${error.message}`);
