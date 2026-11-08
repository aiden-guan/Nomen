import { ApiError, requestJson } from "./http";
import { getSetting } from "./settings";

// Monid data layer (https://docs.monid.ai/api/overview.html). A run is sync (200) or async (202 + poll).

export type MonidInput = { body?: Record<string, unknown>; queryParams?: Record<string, unknown>; pathParams?: Record<string, unknown> };

export type MonidRun = {
  runId: string;
  status: "READY" | "RUNNING" | "STOPPING" | "COMPLETED" | "FAILED" | "BLOCKED" | "STOPPED" | "TIMED_OUT";
  output?: unknown;
  providerResponse?: { httpStatus?: number; error?: unknown };
  cost?: { value: number; currency: string };
  billing?: Record<string, { value: number; unit?: string } | undefined> | null;
};

export const TERMINAL = new Set(["COMPLETED", "FAILED", "BLOCKED", "STOPPED", "TIMED_OUT"]);

export class MonidClient {
  constructor(
    private readonly key = getSetting("monid_api_key"),
    private readonly base = getSetting("monid_base_url"),
  ) {
    if (!key) throw new ApiError("monid", 401, "not_configured", "no Monid API key; add one in Settings");
  }

  private async call<T>(method: "GET" | "POST", path: string, body?: unknown) {
    const { status, data } = await requestJson<T>({
      service: "monid",
      url: `${this.base}${path}`,
      method,
      headers: { authorization: `Bearer ${this.key}` },
      body,
      timeoutMs: 150_000,
      retries: method === "GET" ? 2 : 0, // a retried run is a second paid run
    });
    return { status, data };
  }

  async run(provider: string, endpoint: string, input: MonidInput) {
    return (await this.call<MonidRun>("POST", "/v1/run", { provider, endpoint, input })).data;
  }

  async getRun(runId: string) {
    return (await this.call<MonidRun>("GET", `/v1/runs/${runId}`)).data;
  }

  async balanceUsd() {
    const { data } = await this.call<{ balance: { value: number } }>("GET", "/v1/wallet/balance");
    return data.balance.value;
  }
}

/** What a run cost, in micro-USD: `cost` (USD) on a polled run, `billing` (micro-dollars) on a sync one. */
export function runCostMicro(run: MonidRun): number {
  if (run.cost && typeof run.cost.value === "number") return Math.round(run.cost.value * 1_000_000);
  const billing = run.billing ?? {};
  for (const key of ["actualCost", "reportedCost", "calculatedCost"]) {
    const entry = billing[key];
    if (entry && typeof entry.value === "number") return entry.unit === "MICRO_DOLLAR" || entry.value >= 1000 ? Math.round(entry.value) : Math.round(entry.value * 1_000_000);
  }
  return 0;
}

/** A finished run that the provider answered with an error (Monid does not bill those). */
export function providerFailed(run: MonidRun) {
  return (run.providerResponse?.httpStatus ?? 200) >= 400;
}

// ---------- media runs: Kling, ElevenLabs and file hosting (the one-to-one remake) ----------

export type MonidRunner = Pick<MonidClient, "run" | "getRun">;

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

/**
 * Starts a run and waits for it to finish. A run the provider refused or that failed throws an
 * ApiError: retryable when the provider was busy or timed out, so the caller can try again later.
 */
export async function runToEnd(monid: MonidRunner, provider: string, endpoint: string, input: MonidInput, options: { pollMs?: number; timeoutMs?: number } = {}): Promise<MonidRun> {
  return waitRun(monid, await monid.run(provider, endpoint, input), options, `${provider} ${endpoint}`);
}

/** Polls a started run until it ends; throws as runToEnd does. */
export async function waitRun(monid: MonidRunner, started: MonidRun, options: { pollMs?: number; timeoutMs?: number } = {}, label = "run"): Promise<MonidRun> {
  let run = started;
  if (!run?.runId) throw new ApiError("monid", 502, "no_run", `${label}: Monid started no run`);
  const limit = options.timeoutMs ?? 15 * 60_000;
  const deadline = Date.now() + limit;
  while (!TERMINAL.has(run.status)) {
    if (Date.now() > deadline) throw new ApiError("monid", 504, "run_timeout", `${label}: still ${String(run.status).toLowerCase()} after ${Math.round(limit / 60_000)} min (run ${run.runId})`);
    await sleep(options.pollMs ?? 3000);
    run = { ...(await monid.getRun(run.runId)), runId: run.runId };
  }
  if (run.status === "COMPLETED" && !providerFailed(run)) return run;
  throw runError(run, label);
}

/** Why a finished run failed, as an ApiError: busy or timed-out providers are retryable, refusals are not. */
export function runError(run: MonidRun, label: string): ApiError {
  const http = run.providerResponse?.httpStatus;
  const status = http && http >= 400 ? http : run.status === "BLOCKED" ? 422 : run.status === "TIMED_OUT" ? 504 : 502;
  const detail = JSON.stringify(run.providerResponse?.error ?? "").slice(0, 300);
  return new ApiError("monid", status, `run_${run.status.toLowerCase()}`, `${label}: ${run.status.toLowerCase()}${detail && detail !== '""' ? ` (${detail})` : ""}`);
}

/**
 * The media link in a finished run's output. Kling answers `video_url` or `video.download_link`;
 * ElevenLabs on Monid answers `audio.download_link`. Falls back to the first https link of that kind.
 */
export function outputLink(output: unknown, kind: "video" | "audio"): string | null {
  const o = (output && typeof output === "object" ? output : {}) as Record<string, unknown>;
  const nested = o[kind] && typeof o[kind] === "object" ? (o[kind] as Record<string, unknown>) : null;
  const direct = [o[`${kind}_url`], nested?.download_link, nested?.url, o[kind], o.download_link].find((v): v is string => typeof v === "string" && /^https:\/\//.test(v));
  if (direct) return direct;
  const text = JSON.stringify(output ?? {});
  const pattern = kind === "video" ? /"(https:\/\/[^"]+?\.(?:mp4|mov|webm)[^"]*)"/ : /"(https:\/\/[^"]+?\.(?:mp3|wav|m4a|ogg|flac)[^"]*)"/;
  return text.match(pattern)?.[1] ?? text.match(/"download_link":"([^"]+)"/)?.[1] ?? null;
}

/**
 * A local file at a public link for a day, on Monid's own file store (`sfs`): /put mints an upload
 * link, the bytes are PUT there, and /cat gives the public link. Every link the remake hands to
 * Kling, ElevenLabs and the image model comes from here, so nothing waits on Naive's file links.
 */
export async function hostFile(monid: MonidRunner, bytes: Buffer, name: string, contentType: string, ttl = "1d"): Promise<string> {
  const path = `nomen/${name.replace(/[^\w.-]+/g, "-")}`;
  const put = (await runToEnd(monid, "sfs", "/put", { body: { path, sizeBytes: bytes.length } }, { pollMs: 1000, timeoutMs: 60_000 })).output as { uploadUrl?: string } | undefined;
  if (!put?.uploadUrl) throw new ApiError("monid", 502, "no_upload_url", "sfs /put returned no upload link");
  const response = await fetch(put.uploadUrl, { method: "PUT", headers: { "content-type": contentType, "content-length": String(bytes.length) }, body: new Uint8Array(bytes), signal: AbortSignal.timeout(180_000) });
  if (!response.ok) throw new ApiError("monid", response.status, "upload_failed", `sfs upload failed: HTTP ${response.status}`);
  const cat = (await runToEnd(monid, "sfs", "/cat", { body: { path, ttl } }, { pollMs: 1000, timeoutMs: 60_000 })).output as { url?: string } | undefined;
  if (!cat?.url) throw new ApiError("monid", 502, "no_public_url", "sfs /cat returned no link");
  return cat.url;
}
