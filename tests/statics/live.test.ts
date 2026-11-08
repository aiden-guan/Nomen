import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// NOMEN_LIVE_DB keeps the database in a file, so a run that stops can be resumed without paying
// for the research again: the latest campaign for the brand is reused and a failed pack retried.
if (process.env.NOMEN_LIVE_DB) process.env.NOMEN_DB_PATH = process.env.NOMEN_LIVE_DB;

const { store } = await import("@/lib/db");
const { advanceCampaign, createBrand, defaultOptions, getCampaign, startCampaign } = await import("@/lib/pipeline");
const { buildPackZip } = await import("@/lib/statics/pack");
const { advancePack, getPack, latestPack, listStaticAds, retryPack } = await import("@/lib/statics/pipeline");

// A real static-ads-only campaign, from research to a downloadable pack. It spends real money on
// Monid (research) and Naive (study, copy, checks): about $0.3 and $1-2. Run it with
//   NODE_USE_ENV_PROXY=1 NAIVE_API_KEY=… MONID_API_KEY=… NOMEN_LIVE_STATICS=monid.ai NOMEN_LIVE_OUT=/some/dir npx vitest run tests/statics/live.test.ts

const domain = process.env.NOMEN_LIVE_STATICS;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe.skipIf(!domain)("static ads, live", () => {
  it("researches, studies, writes, renders and zips a pack", { timeout: 45 * 60_000 }, async () => {
    const brandId = await createBrand(domain!);
    const campaigns = await store().find<{ id: string; research_json: string | null }>("campaigns", { brand_id: brandId }, { order: [["created_at", "desc"]] });
    const previous = campaigns.find((c) => c.research_json !== null);
    const campaignId = previous?.id ?? (await startCampaign(brandId, { ...defaultOptions(), concepts: 0, statics: true }));
    const failed = latestPack(campaignId);
    if (failed && (failed.status === "failed" || failed.status === "stopped")) await retryPack(failed.id);
    let seen = 0;
    const log = async () => {
      const events = (await store().events({ campaign_id: campaignId, limit: 10_000 })).reverse();
      for (const e of events.slice(seen)) console.log(`${e.ts.slice(11, 19)} ${e.level} ${e.message}`);
      seen = events.length;
    };
    for (let i = 0; i < 300 && (await getCampaign(campaignId))?.status === "running"; i++) {
      await advanceCampaign(campaignId);
      await log();
      await sleep(4000);
    }
    expect((await getCampaign(campaignId))?.status).toBe("review");
    const pack = latestPack(campaignId);
    expect(pack).toBeTruthy();
    for (let i = 0; i < 400 && getPack(pack!.id)?.status === "running"; i++) {
      await advancePack(pack!.id);
      await log();
      await sleep(3000);
    }
    await log();
    const done = getPack(pack!.id)!;
    console.log(`pack ${done.status} ${done.error ?? ""} tokens in ${done.tokens_in} out ${done.tokens_out} images $${done.image_cost_micro / 1e6}`);
    expect(done.status).toBe("ready");
    const ads = listStaticAds(pack!.id).filter((ad) => !ad.rejected);
    for (const ad of ads) console.log(`ad ${ad.idx} ${ad.status} qc ${ad.qc_json ?? "-"} ${ad.error ?? ""}`);
    const zip = await buildPackZip(pack!.id);
    const out = process.env.NOMEN_LIVE_OUT;
    if (out) {
      mkdirSync(out, { recursive: true });
      writeFileSync(join(out, zip.name), zip.bytes);
      writeFileSync(join(out, "pack.json"), JSON.stringify({ pack: done, ads }, null, 2));
      console.log(`wrote ${join(out, zip.name)} (${zip.bytes.length} bytes)`);
    }
    expect(zip.count).toBeGreaterThan(0);
  });
});
