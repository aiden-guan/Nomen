// Puts a live casting run's results (tests/casting.live.test.ts writes them to
// data/media/casting-live/<campaign>.json) on each brief's concept, so the camp's theatre and the
// demo recording show the creators beside the videos. Opt-in; it writes the core's database
// (NOMEN_SEED_ROOT's data/nomen.db, default this checkout's):
//
//   NOMEN_SEED_CASTING=cmp_… NOMEN_SEED_ROOT=/path/to/main/checkout npx vitest run tests/casting-import.seed.test.ts
//
// Rerunning writes the same castings again.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Casting } from "@/lib/creative/casting";
import { parse, save, store } from "@/lib/db";

const campaign = process.env.NOMEN_SEED_CASTING;

describe.skipIf(!campaign)("a live casting run's results on its briefs", () => {
  it("saves each brief's casting into its concept", async () => {
    const root = process.env.NOMEN_SEED_ROOT ?? process.cwd();
    process.env.NOMEN_DB_PATH = join(root, "data", "nomen.db");
    const file = join(root, "data", "media", "casting-live", `${campaign}.json`);
    expect(existsSync(file), file).toBe(true);
    const results = JSON.parse(readFileSync(file, "utf8")) as Array<{ creative: string; title: string; casting: Casting }>;
    for (const result of results) {
      const [row] = await store().find<{ id: string; campaign_id: string; concept_json: string | null }>("creatives", { id: result.creative }, { limit: 1 });
      expect(row?.campaign_id, result.creative).toBe(campaign);
      const concept = parse<Record<string, unknown>>(row.concept_json, {});
      await save("creatives", row.id, { concept_json: JSON.stringify({ ...concept, casting: result.casting }) });
      console.log(`${result.title}: ${result.casting.status}${result.casting.pick ? ` with @${result.casting.pick.handle}` : ""}`);
    }
  });
});
