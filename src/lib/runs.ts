import { db, logEvent, newId, now, update } from "./db";
import { ApiError } from "./http";
import { type MonidClient, providerFailed, runCostMicro, TERMINAL } from "./monid";
import type { MonidInput } from "./monid";

// Monid research runs, shared by the campaign research (phases A and C) and the static-ad research
// (phase S). A run is stored before it is submitted, so a restart never pays for it twice.

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

export const listRuns = (campaignId: string, phases: Phase[] = ["A", "C"]) =>
  (db().prepare("select * from monid_runs where campaign_id = ? order by created_at").all(campaignId) as RunRow[]).filter((run) => phases.includes(run.phase));

export function ensureRuns(campaignId: string, specs: RunSpec[]) {
  const insert = db().prepare(
    `insert into monid_runs (id, campaign_id, key, phase, provider, endpoint, input_json, status, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?) on conflict (campaign_id, key) do nothing`,
  );
  for (const spec of specs) insert.run(newId("run"), campaignId, spec.key, spec.phase, spec.provider, spec.endpoint, JSON.stringify(spec.input), now(), now());
}

/** Submits pending runs and polls running ones. Provider trouble waits for the next tick. */
export async function progressRuns(owner: { campaignId: string; brandId: string }, monid: MonidClient, phases: Phase[]) {
  const runs = listRuns(owner.campaignId, phases).filter((run) => run.status === "pending" || run.status === "running");
  await Promise.all(
    runs.map(async (run) => {
      try {
        if (run.status === "pending") {
          const result = await monid.run(run.provider, run.endpoint, JSON.parse(run.input_json));
          if (TERMINAL.has(result.status)) finishRun(owner, run, result);
          else update("monid_runs", run.id, { run_id: result.runId, status: "running" });
        } else if (run.run_id) {
          const result = await monid.getRun(run.run_id);
          if (TERMINAL.has(result.status)) finishRun(owner, run, result);
        }
      } catch (error) {
        if (error instanceof ApiError && error.retryable) return; // try again on the next tick
        update("monid_runs", run.id, { status: "failed", error: error instanceof Error ? error.message : String(error) });
        if (error instanceof ApiError && error.outOfCredits) {
          logEvent({ brandId: owner.brandId, campaignId: owner.campaignId, level: "warn", message: "Monid balance is too low for some research. Top up at app.monid.ai/wallet." });
        }
      }
    }),
  );
}

function finishRun(owner: { campaignId: string; brandId: string }, run: RunRow, result: Awaited<ReturnType<MonidClient["getRun"]>>) {
  const ok = result.status === "COMPLETED" && !providerFailed(result);
  update("monid_runs", run.id, {
    run_id: result.runId,
    status: ok ? "done" : "failed",
    output_json: ok ? JSON.stringify(result.output ?? null) : null,
    error: ok ? null : result.status === "BLOCKED" ? "blocked by a Monid wallet or budget control" : `${result.status.toLowerCase()}${providerFailed(result) ? ` (provider HTTP ${result.providerResponse?.httpStatus})` : ""}`,
    cost_micro: runCostMicro(result),
  });
  if (result.status === "BLOCKED") logEvent({ brandId: owner.brandId, campaignId: owner.campaignId, level: "warn", message: "A Monid run was blocked by a wallet or budget control. Top up at app.monid.ai/wallet." });
}
