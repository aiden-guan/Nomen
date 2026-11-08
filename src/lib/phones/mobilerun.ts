// OWNED BY THE PHONES TRACK (see docs/handoff-dylan.md).
// Mobilerun cloud phones: hosted Android devices driven by Mobilerun's own phone agent.
// Checked on 2026-11-07 against https://docs.mobilerun.ai (cloud/quickstart, agent, and the
// api-reference pages for devices, tasks and credentials); not yet run against the live API.
import { ApiError, requestJson } from "../http";
import { getSetting } from "../settings";

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
};

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

  private async call<T>(method: "GET" | "POST", path: string, options: { body?: unknown; query?: Record<string, string | undefined>; headers?: Record<string, string>; retries?: number } = {}) {
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
