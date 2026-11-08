// OWNED BY THE PHONES TRACK (see docs/handoff-dylan.md).
// Mobilerun cloud phones: hosted Android devices driven by Mobilerun's own phone agent.
// Checked on 2026-11-07 against https://docs.mobilerun.ai (cloud/quickstart, agent, and the
// api-reference pages for devices, tasks, files and credentials); not yet run against the live API.
import { ApiError, requestJson } from "../http";
import { getSetting } from "../settings";

/** The phone agent's model, for warm-ups and posts. */
export const AGENT_MODEL = "mobilerun/mobile-agent-fast";

/** Device lifecycle states from `GET /devices` (DeviceInfo.state). */
export const DEVICE_STATES = ["creating", "assigned", "ready", "rebooting", "migrating", "resetting", "terminated", "maintenance", "stopped", "unknown"] as const;
export type DeviceState = (typeof DEVICE_STATES)[number];

/** `DeviceInfo` from the Devices API. Only the fields Nomen reads are typed. */
export type Device = {
  id: string;
  name: string;
  state: DeviceState | string;
  stateMessage?: string;
  type: string;
  platform?: "android" | "ios";
  activeTaskId?: string;
  taskCount?: number;
  createdAt?: string;
  terminatesAt?: string | null;
  billingStrategy?: string;
};

/** `TaskStatus` enum from the Tasks API. */
export type TaskState = "prepared" | "queued" | "created" | "running" | "cancelling" | "completed" | "failed" | "cancelled";
export const TERMINAL_TASK_STATES: ReadonlySet<string> = new Set(["completed", "failed", "cancelled"]);

/** `TaskStatusResponse` from `GET /tasks/{id}/status`. */
export type TaskStatus = {
  status: TaskState;
  succeeded?: boolean | null;
  message?: string | null;
  output?: Record<string, unknown> | null;
  steps?: number | null;
  recordingId?: string | null;
  execution?: { terminationReason?: "execution_timeout" | "worker_lost" | "cancelled" | "agent_failed"; checkpoint?: unknown } | null;
};

/** `TaskCreatedResponse` from `POST /tasks` (201). `streamUrl` is null while the task is queued. */
export type TaskCreated = { id: string; status: TaskState; streamUrl?: string | null };

export type TaskInput = {
  task: string;
  deviceId: string;
  llmModel?: string;
  maxSteps?: number;
  /** Seconds, 1 to 2700. */
  executionTimeout?: number;
  reasoning?: boolean;
  vision?: boolean;
  humanize?: boolean;
  recordingEnabled?: boolean;
  /** Keep the task queued when the device's previous task failed; otherwise Mobilerun cancels it. */
  continueOnFailure?: boolean;
  apps?: string[];
  credentials?: Array<{ packageName: string; credentialNames: string[] }>;
  vpnCountry?: string | null;
  /** A JSON Schema for the agent's report; it comes back as the task status's `output`. */
  outputSchema?: Record<string, unknown> | null;
};

/** `FileInfo` from `GET /devices/{id}/files`. Only the fields Nomen reads are typed. */
export type DeviceFile = { name: string; size: number; type: string; modifiedAt?: string };

/** A saved login in Mobilerun's credential store, without its field values. */
export type CredentialName = { packageName: string; credentialName: string };

export const APP_PACKAGES = {
  tiktok: "com.zhiliaoapp.musically",
  instagram: "com.instagram.android",
  youtube: "com.google.android.youtube",
  x: "com.twitter.android",
  reddit: "com.reddit.frontpage",
} as const;

export type Platform = keyof typeof APP_PACKAGES;
export const PLATFORMS = Object.keys(APP_PACKAGES) as Platform[];
export const PLATFORM_LABELS: Record<Platform, string> = { tiktok: "TikTok", instagram: "Instagram", youtube: "YouTube", x: "X", reddit: "Reddit" };

/** Countries `vpnCountry` accepts on `POST /tasks`. */
export const VPN_COUNTRIES = ["US", "BR", "FR", "DE", "IN", "JP", "KR", "ZA"] as const;

export class MobilerunClient {
  constructor(
    private readonly key = getSetting("mobilerun_api_key"),
    private readonly base = getSetting("mobilerun_base_url"),
  ) {
    if (!key) throw new ApiError("mobilerun", 401, "not_configured", "no Mobilerun API key; add one in Settings");
  }

  private async call<T>(method: "GET" | "POST" | "DELETE", path: string, options: { body?: unknown; query?: Record<string, string | undefined>; headers?: Record<string, string>; retries?: number } = {}) {
    const query = new URLSearchParams();
    for (const [name, value] of Object.entries(options.query ?? {})) if (value !== undefined && value !== "") query.set(name, value);
    const qs = query.toString() ? `?${query}` : "";
    const { data } = await requestJson<T>({
      service: "mobilerun",
      url: `${this.base.replace(/\/$/, "")}${path}${qs}`,
      method,
      headers: { authorization: `Bearer ${this.key}`, ...options.headers },
      body: options.body,
      timeoutMs: 30_000,
      // A retried POST could start a second paid task or phone; POSTs retry only with an idempotency key.
      retries: options.retries ?? (method === "GET" ? 2 : 0),
    });
    return data;
  }

  /** `GET /devices`. Without `states`, Mobilerun lists every device except terminated and unknown ones. */
  async listDevices(states?: DeviceState[]): Promise<Device[]> {
    const data = await this.call<{ items: Device[] | null }>("GET", "/devices", { query: { state: states?.join(","), pageSize: "100", orderBy: "createdAt", orderByDirection: "desc" } });
    return data?.items ?? [];
  }

  /** `GET /devices/{id}`. */
  getDevice(deviceId: string) {
    return this.call<Device>("GET", `/devices/${encodeURIComponent(deviceId)}`);
  }

  /**
   * `POST /devices?deviceType=android_cloud_phone&billing=minute`. Billed per minute while it runs.
   * The idempotency key makes a retried request return the same phone instead of a second one.
   */
  provisionAndroidPhone(input: { idempotencyKey: string; name?: string; country?: string }) {
    return this.call<Device>("POST", "/devices", {
      query: { deviceType: "android_cloud_phone", billing: "minute", country: input.country },
      body: input.name ? { name: input.name } : {},
      headers: { "idempotency-key": input.idempotencyKey },
      retries: 2,
    });
  }

  /** `POST /devices/{id}/resume` (204). Does nothing on a device that is not parked. */
  async resumeDevice(deviceId: string): Promise<void> {
    await this.call<null>("POST", `/devices/${encodeURIComponent(deviceId)}/resume`);
  }

  /**
   * `POST /devices/{id}/stop` (204): parks the phone. Its apps, logins and identity are kept, and
   * nothing is billed until it is resumed. A phone whose capabilities lack `stop` answers 404.
   */
  async stopDevice(deviceId: string): Promise<void> {
    await this.call<null>("POST", `/devices/${encodeURIComponent(deviceId)}/stop`);
  }

  /**
   * `POST /devices/{id}/files?path=<folder>` (204, Android phones only): writes `bytes` into the
   * folder on the phone's shared storage ("/" is its root), under `name`. The body is multipart
   * form data with a `file` field, so this is a plain fetch rather than `requestJson`, and it is
   * not retried here: the worker tries a failed upload again on a later tick.
   */
  async uploadFile(deviceId: string, input: { folder: string; name: string; bytes: Uint8Array; contentType: string }): Promise<void> {
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(input.bytes)], { type: input.contentType }), input.name);
    const url = `${this.base.replace(/\/$/, "")}/devices/${encodeURIComponent(deviceId)}/files?${new URLSearchParams({ path: input.folder })}`;
    let response: Response;
    try {
      response = await fetch(url, { method: "POST", headers: { authorization: `Bearer ${this.key}`, accept: "application/json" }, body: form, signal: AbortSignal.timeout(180_000) });
    } catch (error) {
      throw new ApiError("mobilerun", 0, "network_error", error instanceof Error ? error.message : String(error));
    }
    if (!response.ok) throw await problemError(response);
  }

  /** `GET /devices/{id}/files?path=<folder>`: the files in a folder on the phone. A missing folder answers 404. */
  async listFiles(deviceId: string, folder: string): Promise<DeviceFile[]> {
    const data = await this.call<{ files?: DeviceFile[] | null }>("GET", `/devices/${encodeURIComponent(deviceId)}/files`, { query: { path: folder } });
    return data?.files ?? [];
  }

  /** `DELETE /devices/{id}/files?path=<file>` (204): removes one file from the phone, for good. */
  async deleteFile(deviceId: string, path: string): Promise<void> {
    await this.call<null>("DELETE", `/devices/${encodeURIComponent(deviceId)}/files`, { query: { path } });
  }

  /** `POST /tasks` (201). The idempotency key (1-128 chars) makes a retried create return the same task. */
  createTask(input: TaskInput, idempotencyKey: string) {
    return this.call<TaskCreated>("POST", "/tasks", { body: input, headers: { "idempotency-key": idempotencyKey.slice(0, 128) }, retries: 2 });
  }

  /** `GET /tasks/{id}/status`: the outcome without the full trajectory. */
  taskStatus(taskId: string) {
    return this.call<TaskStatus>("GET", `/tasks/${encodeURIComponent(taskId)}/status`);
  }

  /** `POST /tasks/{id}/cancel`. Mobilerun answers an error if the task already finished. */
  cancelTask(taskId: string) {
    return this.call<{ cancelled: boolean }>("POST", `/tasks/${encodeURIComponent(taskId)}/cancel`);
  }

  /**
   * `GET /credentials`. The response carries each login's field values; only the package and
   * credential names leave this function.
   */
  async listCredentialNames(): Promise<CredentialName[]> {
    const data = await this.call<{ items?: Array<{ packageName?: string; credentialName?: string }> | null }>("GET", "/credentials", { query: { pageSize: "100" } });
    return (data?.items ?? [])
      .filter((item): item is { packageName: string; credentialName: string } => typeof item.packageName === "string" && typeof item.credentialName === "string")
      .map(({ packageName, credentialName }) => ({ packageName, credentialName }));
  }
}

/** A Mobilerun error answer (`application/problem+json`) as an ApiError, read the way `requestJson` reads one. */
async function problemError(response: Response) {
  const text = await response.text().catch(() => "");
  let body: Record<string, unknown> = {};
  try {
    body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    body = { detail: text.slice(0, 300) };
  }
  const code = String(body.code ?? body.type ?? response.status);
  const message = String(body.message ?? body.detail ?? body.title ?? `HTTP ${response.status}`);
  return new ApiError("mobilerun", response.status, code, message, response.headers.get("x-request-id") ?? undefined);
}

/**
 * The warm-up brief for a brand-owned account: behave like the brand's social manager browsing its
 * niche. Deliberately passive: no posting, commenting, messaging, or engaging with the brand's own posts.
 */
export function warmupTask(input: { platform: string; brand: string; niche: string[]; minutes: number }) {
  const topics = input.niche.slice(0, 6).join(", ");
  return [
    `You are the social media manager for ${input.brand}, using the brand's own official ${input.platform} account on this phone.`,
    `Open the ${input.platform} app. If it asks you to log in, use the saved credential for this app; if it asks for a code you do not have, stop and report it.`,
    `For about ${input.minutes} minutes, browse content about: ${topics}. Use search for these topics and watch videos fully when they are relevant.`,
    "Like at most 8 videos that are genuinely relevant to those topics. Follow at most 2 creators who post consistently about them.",
    `Never post, comment, send messages, buy anything, change account settings, or interact with ${input.brand}'s own posts.`,
    "When finished, return to the home feed and report how many videos you watched, liked and which creators you followed.",
  ].join("\n");
}

/** The posting task's report (`outputSchema`). Mobilerun returns it as the task status's `output`. */
export const POST_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    posted: { type: "boolean", description: "True only if you tapped Post and TikTok took the video (posted, uploading or under review)." },
    postUrl: { type: "string", description: "The video's link from Share, then Copy link, or an empty string if you couldn't get it." },
    aiLabel: { type: "boolean", description: "True if the AI-generated content setting was on when you posted." },
    onlyYou: { type: "boolean", description: 'True if "Who can watch this video" was set to "Only you" when you posted.' },
    reason: { type: "string", description: "If posted is false, what stopped you, in one sentence; otherwise an empty string." },
  },
  required: ["posted", "postUrl", "aiLabel", "onlyYou", "reason"],
  additionalProperties: false,
};

/**
 * The posting brief: one finished video, already copied onto the phone, posted once from the
 * brand's own TikTok account with its caption and TikTok's AI-generated label. It runs only when a
 * person clicks "Post through phone" for that video; the warm-up brief above never posts.
 * "private" is a test post that only the brand's account can see ("Only you"). TikTok keeps the
 * last post's audience, so a public post sets "Everyone" explicitly.
 */
export function postTask(input: { brand: string; fileName: string; folder: string; seconds: number | null; caption: string; visibility: "public" | "private" }) {
  const length = input.seconds ? `, about ${Math.round(input.seconds)} seconds long` : "";
  const audience =
    input.visibility === "private"
      ? 'This is a private test post. Set "Who can watch this video" to "Only you" (some versions say "Only me"); if you can\'t set it to "Only you", do not post: stop and report it. Check it still says "Only you" right before you tap Post.'
      : 'Set "Who can watch this video" to "Everyone".';
  const disclosure = input.visibility === "private" ? "" : ' If there is a "Disclose post content" setting, turn it on and choose "Your brand".';
  return [
    `You are the social media manager for ${input.brand}, posting one finished video from the brand's own official TikTok account on this phone. Post it exactly once.`,
    "1. Open TikTok. If it asks you to log in, use the saved credential for this app; if it asks for a code you do not have, stop and report it.",
    "2. Tap the + (create) button at the bottom of the screen, then Upload. If TikTok asks for access to photos and videos, allow it.",
    `3. Select only the newest video in the gallery: the file ${input.fileName} in the phone's ${input.folder} folder${length}. Tap Next until you reach the screen with the caption. Do not add sounds, effects, text, stickers or filters, and do not trim the video.`,
    `4. Replace everything in the caption field with exactly this text:\n${input.caption}`,
    `5. Open "More options" and turn on "AI-generated content". If you can't find it or can't turn it on, do not post: stop and report it.${disclosure} ${audience}`,
    "6. Tap Post once. Wait until TikTok shows the video as posted, uploading or under review, for up to 3 minutes.",
    "7. Open the new video on the brand's profile, tap Share, then Copy link. To read the link, paste it into TikTok's search field without searching, note it, then clear the field.",
    "Never post anything else, comment, send messages, like, follow, buy anything, change account settings, or edit or delete other posts. If anything goes wrong before you tap Post, do not post. If you are not sure whether the video went out, do not post it again: check the brand's profile instead.",
    'Report whether the video was posted, its link, whether the AI-generated label was on, whether "Who can watch this video" was "Only you", and what stopped you if it was not posted.',
  ].join("\n");
}
