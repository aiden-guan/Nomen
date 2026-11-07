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
