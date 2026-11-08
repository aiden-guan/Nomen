// Live, paid run of real-creator mode on a campaign that already has its research and briefs:
// every brief is cast (creators from the research, ranked, briefed, judged by the client-taste
// agent, outreach drafted) with Naive's model. People search runs on Monid when its wallet has
// money; otherwise the research's creators are the pool. Reads data/nomen.db read-only and writes
// the result to data/media/casting-live/<campaign>.json; nothing is sent to anyone.
//
//   NOMEN_CASTING_LIVE=1 npx vitest run tests/casting.live.test.ts
//   NOMEN_CASTING_CAMPAIGN=cmp_… to pick the campaign (default: the Monid campaign)
//   NOMEN_CASTING_ONLY=crv_…,crv_… to cast only these briefs

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { clientTaste } from "@/lib/casting-job";
import { type Casting, type CastingDeps, searchKeywords, stepCasting } from "@/lib/creative/casting";
import type { ProductBrief } from "@/lib/creative/types";
import { ApiError } from "@/lib/http";
import { MonidClient } from "@/lib/monid";
import { NaiveClient } from "@/lib/naive";
import type { Video } from "@/lib/research";
import type { Concept, Strategy } from "@/lib/strategy";

const live = process.env.NOMEN_CASTING_LIVE === "1";
const CAMPAIGN = process.env.NOMEN_CASTING_CAMPAIGN ?? "cmp_f98819d8b08f46a7a422";

describe.skipIf(!live)("real-creator mode on a researched campaign (live, Naive)", () => {
  it("casts every brief to a creator the client approves", async () => {
    const data = join(process.cwd(), "data");
    if ((!process.env.NAIVE_API_KEY || !process.env.MONID_API_KEY) && existsSync(".env.local")) process.loadEnvFile(".env.local");
    const db = new Database(join(data, "nomen.db"), { readonly: true, fileMustExist: true });
    const campaign = db.prepare("select brand_id, strategy_json, research_json, style_json from campaigns where id = ?").get(CAMPAIGN) as { brand_id: string; strategy_json: string; research_json: string; style_json: string };
    const brand = db.prepare("select name, domain from brands where id = ?").get(campaign.brand_id) as { name: string; domain: string };
    const only = process.env.NOMEN_CASTING_ONLY?.split(",").map((id) => id.trim()).filter(Boolean);
    const rows = (db.prepare("select id, concept_json from creatives where campaign_id = ? and rejected = 0 order by idx").all(CAMPAIGN) as Array<{ id: string; concept_json: string }>).filter((row) => !only?.length || only.includes(row.id));
    db.close();
    const strategy = JSON.parse(campaign.strategy_json) as Strategy;
    const product = (JSON.parse(campaign.style_json) as { product: ProductBrief }).product;
    const research = (JSON.parse(campaign.research_json) as { videos?: Video[] }).videos ?? [];

    const naive = new NaiveClient();
    // Naive answers "at capacity" now and then: wait it out.
    const message: CastingDeps["message"] = async (input) => {
      for (let attempt = 0; ; attempt++) {
        try {
          return await naive.message(input);
        } catch (error) {
          if (!(error instanceof ApiError) || !error.retryable || attempt >= 8) throw error;
          await new Promise((done) => setTimeout(done, 15_000));
        }
      }
    };
    const monid = new MonidClient();
    const balance = await monid.balanceUsd().catch(() => 0);
    const deps: CastingDeps = { message, monid: balance > 0.05 ? monid : null, log: (line) => console.log(`[casting] ${line}`) };
    if (!deps.monid) console.log(`[casting] Monid has $${balance.toFixed(4)}: people search skipped, casting from the research's creators`);

    const results: Array<{ creative: string; title: string; casting: Casting }> = [];
    for (const row of rows) {
      const concept = JSON.parse(row.concept_json) as Concept;
      let casting: Casting | null = null;
      for (let step = 0; step < 10; step++) {
        casting = await stepCasting(
          deps,
          {
            concept: { title: concept.title, hook: concept.hook, angle: concept.brief?.angle, cta: concept.brief?.cta, lines: concept.script?.beats?.map((b) => b.line).filter(Boolean) ?? [], format: concept.format },
            reference: { url: concept.reference?.url ?? "", format: concept.reference?.format ?? concept.format },
            product,
            taste: clientTaste(strategy, product),
            research,
            brand: { name: brand.name, domain: brand.domain },
            keywords: searchKeywords({ category: strategy.brand.category, audience: product.audience, angle: concept.brief?.angle }),
            fee: "$150 flat for one video, with usage on the brand's own accounts",
          },
          casting,
        );
        if (casting.status === "approved" || casting.status === "no_match") break;
      }
      results.push({ creative: row.id, title: concept.title, casting: casting! });
      console.log(`[casting] ${concept.title}: ${casting!.status}${casting!.pick ? ` with @${casting!.pick.handle}` : ""}`);
    }
    const out = join(data, "media", "casting-live");
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, `${CAMPAIGN}.json`), JSON.stringify(results, null, 1));
    console.log(`[casting] wrote ${join(out, `${CAMPAIGN}.json`)}`);
    expect(results.some((r) => r.casting.status === "approved")).toBe(true);
  }, 1_800_000);
});
