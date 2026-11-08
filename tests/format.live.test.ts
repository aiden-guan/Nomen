import { writeFileSync } from "node:fs";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { studyCandidates, studyFormat } from "@/lib/format";
import { NaiveClient } from "@/lib/naive";
import { compactResearch, type ResearchPlan } from "@/lib/research";

// Live check of the format study against a real campaign's research (costs a few cents on Naive):
// NOMEN_LIVE_CAMPAIGN=cmp_… NAIVE_API_KEY=… npx vitest run tests/format.live.test.ts
const campaignId = process.env.NOMEN_LIVE_CAMPAIGN ?? "";

describe.skipIf(!campaignId)("format study (live)", () => {
  it("studies the top videos frame by frame", async () => {
    const db = new Database("data/nomen.db", { readonly: true });
    const campaign = db.prepare("select c.plan_json, b.domain from campaigns c join brands b on b.id = c.brand_id where c.id = ?").get(campaignId) as { plan_json: string; domain: string };
    const runs = (db.prepare("select key, status, output_json from monid_runs where campaign_id = ?").all(campaignId) as Array<{ key: string; status: string; output_json: string | null }>).map((run) => ({
      key: run.key,
      status: run.status,
      output: JSON.parse(run.output_json ?? "null"),
    }));
    const pack = compactResearch(campaign.domain, runs, JSON.parse(campaign.plan_json) as ResearchPlan);
    expect(studyCandidates(pack).length).toBeGreaterThan(0);
    const study = await studyFormat(new NaiveClient(), pack, `${campaignId}-test`);
    expect(study?.markdown.length).toBeGreaterThan(500);
    if (process.env.NOMEN_LIVE_OUT) writeFileSync(process.env.NOMEN_LIVE_OUT, study!.markdown);
  }, 300_000);
});
