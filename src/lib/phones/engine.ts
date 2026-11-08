// OWNED BY THE PHONES TRACK (see docs/handoff-dylan.md). The warm-up state machine the worker drives.
//
// Each worker tick: queue today's scheduled sessions, then look at the active sessions whose next
// check is due. A session moves pending -> (waiting) -> starting -> queued/running -> succeeded,
// failed or cancelled. Every step is one short API call, so a tick never blocks for long.
import { logEvent, now } from "../db";
import { getInt, secretStatus } from "../settings";
import { APP_PACKAGES, MobilerunClient, outreachTask, PLATFORM_LABELS, TERMINAL_TASK_STATES, warmupTask, type Device, type TaskInput } from "./mobilerun";
import {
  LIMITS,
  POLL,
  describeApiError,
  describeDevice,
  describeTaskOutcome,
  isRecordingUnsupported,
  phoneAction,
  scheduleDay,
  sessionStatusFor,
  taskLimits,
} from "./rules";
import {
  ACTIVE_STATUSES,
  claimSession,
  deviceBusy,
  dueSessions,
  getBrand,
  getLink,
  insertSession,
  linkTopics,
  listAccounts,
  listLinks,
  outreachOf,
  phonesDb,
  updateActive,
  type SessionRow,
  type SessionStatus,
} from "./store";

/** At most this many sessions are looked at per tick, so one tick stays a few API calls long. */
const SESSIONS_PER_TICK = 8;

export const AGENT_MODEL = "mobilerun/mobile-agent-fast";

const later = (ms: number) => new Date(Date.now() + ms).toISOString();
const age = (iso: string | null) => (iso ? Date.now() - Date.parse(iso) : 0);

export const warmupMinutes = () => taskLimits(getInt("warmup_minutes")).minutes;

let inFlight: Promise<void> | null = null;

/** One worker tick. Overlapping calls return at once instead of doubling the work. */
export function tick(): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = runTick().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function runTick() {
  phonesDb();
  if (!secretStatus("mobilerun_api_key").set) return;
  queueScheduledSessions(new Date());
  const due = dueSessions(now(), SESSIONS_PER_TICK);
  if (due.length === 0) return;
  const client = new MobilerunClient();
  const devices = new Map<string, Promise<Device>>();
  const device = (id: string) => {
    if (!devices.has(id)) devices.set(id, client.getDevice(id));
    return devices.get(id)!;
  };
  for (const session of due) {
    try {
      await step(client, session, device);
    } catch (error) {
      onError(session, error);
    }
  }
}

/** Adds today's session for every scheduled brand account that does not have one yet. */
export function queueScheduledSessions(at: Date) {
  const minutes = warmupMinutes();
  for (const link of listLinks()) {
    const day = scheduleDay({ enabled: link.schedule_enabled === 1, days: link.schedule_days, startedAt: link.schedule_started_at }, at);
    if (day === null) continue;
    for (const account of listAccounts(link.brand_id)) {
      const created = insertSession({ brandId: link.brand_id, deviceId: link.device_id, platform: account.platform, kind: "scheduled", dayIndex: day, minutes });
      if (created) logEvent({ brandId: link.brand_id, message: `Phones: day ${day + 1} of ${link.schedule_days} warm-up queued for ${PLATFORM_LABELS[account.platform]}.` });
    }
  }
}

async function step(client: MobilerunClient, session: SessionRow, device: (id: string) => Promise<Device>) {
  switch (session.status) {
    case "pending":
    case "waiting":
      return startWhenPhoneReady(client, session, device);
    case "starting":
      // Another tick is creating the task, or crashed while doing it. The idempotency key makes a retry safe.
      if (age(session.updated_at) > LIMITS.staleStartMs) return createTask(client, session);
      return updateActive(session.id, { next_check_at: later(POLL.running) });
    case "queued":
    case "running":
      return poll(client, session);
  }
}

async function startWhenPhoneReady(client: MobilerunClient, session: SessionRow, device: (id: string) => Promise<Device>) {
  if (deviceBusy(session.device_id, session.id)) {
    return updateActive(session.id, { message: "Waiting for the phone's current session to finish.", next_check_at: later(POLL.waitingForPhone) });
  }
  const phone = await device(session.device_id);
  const action = phoneAction(phone.state);
  const words = describeDevice(phone.state);
  if (action === "fail") return finish(session, "failed", words.detail);
  if (action === "run") {
    if (!claimSession(session.id, ["pending", "waiting"], "starting", { attempts: session.attempts + 1 })) return;
    return createTask(client, { ...session, status: "starting", attempts: session.attempts + 1 });
  }
  const waitingSince = session.waiting_since ?? now();
  if (age(waitingSince) > LIMITS.waitForPhoneMs) return finish(session, "failed", `The phone wasn't ready within an hour. ${words.detail}`);
  if (action === "resume") {
    await client.resumeDevice(session.device_id);
    if (session.status === "pending") logEvent({ brandId: session.brand_id, message: "Phones: waking up the parked phone for a warm-up session." });
  }
  updateActive(session.id, {
    status: "waiting",
    waiting_since: waitingSince,
    message: action === "resume" ? "Waking up the parked phone." : words.detail,
    next_check_at: later(POLL.waitingForPhone),
  });
}

async function createTask(client: MobilerunClient, session: SessionRow) {
  const link = getLink(session.brand_id);
  const brand = getBrand(session.brand_id);
  const account = listAccounts(session.brand_id).find((row) => row.platform === session.platform);
  if (!link || !brand || !account || link.device_id !== session.device_id) {
    return finish(session, "cancelled", "The phone or this account was unlinked before the session started.");
  }
  const outreach = outreachOf(session);
  if (session.task === "outreach" && !outreach) return finish(session, "failed", "The outreach message was missing.");
  const topics = linkTopics(link);
  if (!outreach && topics.length === 0) return finish(session, "failed", "The brand has no niche topics to browse. Add some in the phones panel.");

  const limits = taskLimits(session.minutes);
  const packageName = APP_PACKAGES[session.platform];
  const label = PLATFORM_LABELS[session.platform];
  const input: TaskInput = {
    task: outreach
      ? outreachTask({ platform: label, brand: brand.name, handle: outreach.handle, message: outreach.message })
      : warmupTask({ platform: label, brand: brand.name, niche: topics, minutes: limits.minutes }),
    deviceId: session.device_id,
    llmModel: AGENT_MODEL,
    maxSteps: limits.maxSteps,
    executionTimeout: limits.executionTimeout,
    reasoning: true,
    vision: true,
    humanize: true,
    recordingEnabled: true,
    apps: [packageName],
    credentials: account.credential_name ? [{ packageName, credentialNames: [account.credential_name] }] : [],
    ...(link.vpn_country ? { vpnCountry: link.vpn_country } : {}),
  };

  let created;
  try {
    created = await client.createTask(input, session.id);
  } catch (error) {
    if (!isRecordingUnsupported(error)) throw error;
    created = await client.createTask({ ...input, recordingEnabled: false }, `${session.id}-norec`);
  }

  const saved = updateActive(session.id, {
    status: sessionStatusFor({ status: created.status, succeeded: null }),
    task_id: created.id,
    task_status: created.status,
    started_at: now(),
    message: created.status === "queued" ? "Queued behind another task on the phone." : null,
    error: null,
    next_check_at: later(POLL.running),
  });
  if (!saved) {
    // The user stopped the session while the task was being created: stop the task too.
    await client.cancelTask(created.id).catch(() => undefined);
    return;
  }
  logEvent({
    brandId: session.brand_id,
    message: outreach ? `Phones: sending the outreach DM to @${outreach.handle} on ${label}.` : `Phones: ${label} warm-up started (about ${limits.minutes} minutes).`,
  });
}

async function poll(client: MobilerunClient, session: SessionRow) {
  if (!session.task_id) {
    // Should not happen: an active session past `starting` always has a task. Start over.
    return updateActive(session.id, { status: "pending", next_check_at: now() });
  }
  if (session.started_at && age(session.started_at) > session.minutes * 60_000 + LIMITS.overrunMs) {
    await client.cancelTask(session.task_id).catch(() => undefined);
    return finish(session, "failed", "The session ran far longer than planned, so it was stopped.");
  }
  const task = await client.taskStatus(session.task_id);
  const fields = { task_status: task.status, steps: task.steps ?? session.steps, recording_id: task.recordingId ?? session.recording_id };
  const next = sessionStatusFor(task);
  if (next === "succeeded" || next === "failed" || next === "cancelled") {
    return finish(session, next, describeTaskOutcome(task, session.minutes), {
      ...fields,
      succeeded: task.succeeded == null ? null : Number(task.succeeded),
    });
  }
  updateActive(session.id, { ...fields, status: sessionStatusFor(task), message: task.status === "queued" ? "Queued behind another task on the phone." : null, next_check_at: later(POLL.running) });
}

/** Ends a session once; a session the user already stopped keeps its status. */
export function finish(session: SessionRow, status: Extract<SessionStatus, "succeeded" | "failed" | "cancelled">, message: string, fields: Record<string, unknown> = {}) {
  const changed = claimSession(session.id, ACTIVE_STATUSES, status, { message, finished_at: now(), ...fields });
  if (!changed) return;
  const label = PLATFORM_LABELS[session.platform];
  const outreach = outreachOf(session);
  const what = outreach ? `outreach DM to @${outreach.handle} on ${label}` : `${label} warm-up`;
  const done = outreach ? "sent" : "finished";
  logEvent({
    brandId: session.brand_id,
    level: status === "failed" ? "warn" : "info",
    message: `Phones: ${what} ${status === "succeeded" ? done : status === "failed" ? "failed" : "stopped"}. ${message}`.slice(0, 500),
  });
}

function onError(session: SessionRow, error: unknown) {
  const { message, retry } = describeApiError(error);
  const attempts = session.attempts + 1;
  if (retry && attempts < LIMITS.maxAttempts) {
    updateActive(session.id, {
      // A create that failed in flight goes back to waiting; its idempotency key covers the retry.
      ...(session.status === "starting" || session.status === "pending" ? { status: "waiting" as const } : {}),
      attempts,
      error: message,
      next_check_at: later(POLL.retryAfterError * attempts),
    });
    return;
  }
  finish(session, "failed", message, { error: message, attempts });
}

/** Stops a session now. Used by the panel's Stop button and when a brand's phone is unlinked. */
export async function stopSession(session: SessionRow, reason: string, client?: MobilerunClient) {
  if (!ACTIVE_STATUSES.includes(session.status)) return false;
  if (session.task_id && !TERMINAL_TASK_STATES.has(session.task_status ?? "")) {
    try {
      await (client ?? new MobilerunClient()).cancelTask(session.task_id);
    } catch {
      // Already finished on Mobilerun's side, or unreachable; the session is stopped here either way.
    }
  }
  finish(session, "cancelled", reason);
  return true;
}
