// OWNED BY THE PHONES TRACK (see docs/handoff-dylan.md). Written from the Mobilerun docs; not yet tested against the live API.
import { ApiError, requestJson } from "../http";
import { getSetting } from "../settings";

// Mobilerun cloud phones (https://docs.mobilerun.ai/cloud/quickstart.md): agents that drive real apps.

export type Device = { id: string; name?: string; state?: string; deviceType?: string; [key: string]: unknown };
export type TaskStatus = { status: string; succeeded?: boolean; message?: string; output?: unknown; steps?: number };

export const APP_PACKAGES: Record<string, string> = {
  tiktok: "com.zhiliaoapp.musically",
  instagram: "com.instagram.android",
  youtube: "com.google.android.youtube",
  x: "com.twitter.android",
  reddit: "com.reddit.frontpage",
};

export class MobilerunClient {
  constructor(
    private readonly key = getSetting("mobilerun_api_key"),
    private readonly base = getSetting("mobilerun_base_url"),
  ) {
    if (!key) throw new ApiError("mobilerun", 401, "not_configured", "no Mobilerun API key; add one in Settings");
  }

  private async call<T>(method: "GET" | "POST", path: string, body?: unknown) {
    const { data } = await requestJson<T>({ service: "mobilerun", url: `${this.base}${path}`, method, headers: { authorization: `Bearer ${this.key}` }, body, retries: method === "GET" ? 2 : 0 });
    return data;
  }

  async listDevices(): Promise<Device[]> {
    const data = await this.call<unknown>("GET", "/devices");
    if (Array.isArray(data)) return data as Device[];
    const record = data as Record<string, unknown>;
    for (const key of ["items", "data", "devices", "results"]) {
      if (Array.isArray(record[key])) return record[key] as Device[];
    }
    return [];
  }

  createTask(input: {
    task: string;
    deviceId: string;
    maxSteps?: number;
    executionTimeout?: number;
    apps?: string[];
    credentials?: Array<{ packageName: string; credentialNames: string[] }>;
    humanize?: boolean;
    vision?: boolean;
    llmModel?: string;
  }) {
    return this.call<{ id?: string; taskId?: string; [key: string]: unknown }>("POST", "/tasks", input);
  }

  taskStatus(id: string) {
    return this.call<TaskStatus>("GET", `/tasks/${id}/status`);
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
