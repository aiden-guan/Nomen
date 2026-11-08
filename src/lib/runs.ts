import { logEvent, newId, now, save, store } from "./db";
import { ApiError } from "./http";
import { type MonidClient, providerFailed, runCostMicro, TERMINAL } from "./monid";
import type { MonidInput } from "./monid";

// Monid research runs, shared by the campaign research (phases A and C) and the static-ad research
// (phase S). A run is stored before it is submitted, so a restart never pays for it twice. Rows live
// in the store (SQLite or Convex), so every read and write is awaited.

export type Phase = "A" | "C" | "S";

export type RunSpec = { key: string; phase: Phase; label: string; provider: string; endpoint: string; input: MonidInput };

export type RunRow = {
  id: string;
  campaign_id: string;
  key: string;
  phase: Phase;
  provider: string;
  endpoint: string;
  input_json: string;
  run_id: string | null;
  status: "pending" | "running" | "done" | "failed";
  output_json: string | null;
  error: string | null;
  cost_micro: number;
};

export const listRuns = async (campaignId: string, phases: Phase[] = ["A", "C"]) =>
  (await store().find<RunRow>("monid_runs", { campaign_id: campaignId }, { order: [["created_at", "asc"]] })).filter((run) => phases.includes(run.phase));

export async function ensureRuns(campaignId: string, specs: RunSpec[]) {
  for (const spec of specs) {
    const row = { id: newId("run"), campaign_id: campaignId, key: spec.key, phase: spec.phase, provider: spec.provider, endpoint: spec.endpoint, input_json: JSON.stringify(spec.input), status: "pending", created_at: now(), updated_at: now() };
    await store().insert("monid_runs", row, { unique: ["campaign_id", "key"] });
  }
}

/** Puts failed runs of these phases back in the queue. */
export async function requeueFailedRuns(campaignId: string, phases: Phase[]) {
  for (const run of (await listRuns(campaignId, phases)).filter((r) => r.status === "failed")) await save("monid_runs", run.id, { status: "pending", run_id: null, error: null });
}

/** Submits pending runs and polls running ones. Provider trouble waits for the next tick. */
export async function progressRuns(owner: { campaignId: string; brandId: string }, monid: MonidClient, phases: Phase[]) {
  const runs = (await listRuns(owner.campaignId, phases)).filter((run) => run.status === "pending" || run.status === "running");
  await Promise.all(
    runs.map(async (run) => {
      try {
        if (run.status === "pending") {
          const result = await monid.run(run.provider, run.endpoint, JSON.parse(run.input_json));
          if (TERMINAL.has(result.status)) await finishRun(owner, run, result);
          else await save("monid_runs", run.id, { run_id: result.runId, status: "running" });
        } else if (run.run_id) {
          const result = await monid.getRun(run.run_id);
          if (TERMINAL.has(result.status)) await finishRun(owner, run, result);
        }
      } catch (error) {
        if (error instanceof ApiError && error.retryable) return; // try again on the next tick
        await save("monid_runs", run.id, { status: "failed", error: error instanceof Error ? error.message : String(error) });
        if (error instanceof ApiError && error.outOfCredits) {
          await logEvent({ brandId: owner.brandId, campaignId: owner.campaignId, level: "warn", message: "Monid balance is too low for some research. Top up at app.monid.ai/wallet." });
        }
      }
    }),
  );
}

async function finishRun(owner: { campaignId: string; brandId: string }, run: RunRow, result: Awaited<ReturnType<MonidClient["getRun"]>>) {
  const ok = result.status === "COMPLETED" && !providerFailed(result);
  await save("monid_runs", run.id, {
    run_id: result.runId,
    status: ok ? "done" : "failed",
    output_json: ok ? JSON.stringify(result.output ?? null) : null,
    error: ok ? null : result.status === "BLOCKED" ? "blocked by a Monid wallet or budget control" : `${result.status.toLowerCase()}${providerFailed(result) ? ` (provider HTTP ${result.providerResponse?.httpStatus})` : ""}`,
    cost_micro: runCostMicro(result),
  });
  if (result.status === "BLOCKED") await logEvent({ brandId: owner.brandId, campaignId: owner.campaignId, level: "warn", message: "A Monid run was blocked by a wallet or budget control. Top up at app.monid.ai/wallet." });
}
