// Stores the one-to-one Cluely remake as Monid's video, for the live camp and the demo recording.
// Opt-in, run once from the main checkout (it writes data/nomen.db and data/media through the store):
//
//   NOMEN_SEED_MONID=1 npx vitest run tests/monid-clone.seed.test.ts
//
// The Monid campaign's "We gave an agent $3 and one skill file" came out of the standard pipeline
// as a green-screen explainer that QC kept sending back. Its concept was then remade one to one from
// the @cluelyextras billboard video it was inspired by (tests/remake.live.test.ts, tag v3, Nov 7-8
// 2026). This makes that remake the video's second generation: its cut, first frames, script and
// takes, with the remake's production lines at the times they ran. The earlier version is kept in
// the concept under `previous`. Rerunning it changes nothing.

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Script } from "@/lib/creative/types";
import { parse, save, store } from "@/lib/db";
import type { CreativeRow, ShotState } from "@/lib/production";
import type { Concept } from "@/lib/strategy";

const run = process.env.NOMEN_SEED_MONID === "1";

const CAMPAIGN = "cmp_f98819d8b08f46a7a422";
const CREATIVE = "crv_376762f3ac4741cda217";
const TITLE = "We gave an agent $3 and one skill file";
const REMAKE = join(process.cwd(), "data", "media", "remake-live", "cluely-v3");

/** The remake's own lines, at the times the v3 take ran (UTC), worded as the production job logs them. */
const LINES: Array<[string, string]> = [
  ["2026-11-08T06:15:10Z", `"${TITLE}": remaking it one to one from @cluelyextras's billboard video (628K views on 3K followers): 3 shots on Kling 3.0 in her own voice`],
  ["2026-11-08T06:16:30Z", `"${TITLE}": remaking shot 2's first frame before rendering it (the original man was still in the frame)`],
  ["2026-11-08T06:17:40Z", `"${TITLE}": built 5 of 5 product cards in the original's places`],
  ["2026-11-08T06:21:50Z", `"${TITLE}": shot 3 of 3 rendered on Kling 3.0`],
  ["2026-11-08T06:23:20Z", `"${TITLE}": shot 2 of 3 rendered on Kling 3.0`],
  ["2026-11-08T06:24:40Z", `"${TITLE}": shot 1 of 3 rendered on Kling 3.0`],
  ["2026-11-08T06:26:40Z", `"${TITLE}": cut on the original's timing with its captions, closing on the site card`],
  ["2026-11-08T06:27:10Z", `"${TITLE}" is ready`],
];

describe.skipIf(!run)("store the Cluely remake as Monid's video", () => {
  it("makes the remake the second generation of the $3 video", async () => {
    // The test config points every test at an in-memory database; this one writes the real one.
    process.env.NOMEN_DB_PATH = join(process.cwd(), "data", "nomen.db");
    for (const name of ["cluely-remake.mp4", "script.json", "kept/remake-cluely/shot0-frame.png"]) expect(existsSync(join(REMAKE, name)), `missing ${name}`).toBe(true);
    const [creative] = await store().find<CreativeRow>("creatives", { id: CREATIVE }, { limit: 1 });
    expect(creative?.campaign_id).toBe(CAMPAIGN);
    const [campaign] = await store().find<{ id: string; brand_id: string }>("campaigns", { id: CAMPAIGN }, { limit: 1 });

    // The files: the cut, its poster and each take's first frame.
    const files = store().files;
    await files.putFile(`${CREATIVE}/final.mp4`, join(REMAKE, "cluely-remake.mp4"), "video/mp4");
    await files.putFile(`${CREATIVE}/shot0-frame.png`, join(REMAKE, "kept/remake-cluely/shot0-frame.png"), "image/png");
    for (const n of [1, 2, 3]) await files.putFile(`${CREATIVE}/shot${n}-frame.png`, join(REMAKE, `kept/remake-cluely/shot${n}-frame.png`), "image/png");

    // The concept: the remake's script and hook, the earlier version kept.
    const old = parse<Concept & { previous?: unknown }>(creative.concept_json, {} as Concept);
    const script = JSON.parse(await readFile(join(REMAKE, "script.json"), "utf8")) as Script;
    const concept = {
      ...old,
      title: TITLE,
      format: "one-to-one remake",
      hook: `${script.beats[0].on_screen_text ? `${script.beats[0].on_screen_text} / ` : ""}${script.beats[0].line}`,
      brief: { ...old.brief, format: "remake" },
      script,
      internal: true,
      previous: old.previous ?? { title: old.title, format: old.format, hook: old.hook, shots: parse(creative.shots_json, []), qc_score: creative.qc_score, note: "the standard pipeline's green-screen explainer, before the one-to-one remake" },
    } as unknown as Concept;
    const shots = script.beats.map((beat, i) => ({
      n: i + 1,
      frame_prompt: "",
      prompt: beat.line,
      seconds: beat.seconds,
      status: "passed",
      provider: "monid",
      renders: 1,
      qc_rounds: 0,
      submit_errors: 0,
      frame_idem: "",
      frame_file_id: null,
      frame_url: null,
      frame_key: `${CREATIVE}/shot${i + 1}-frame.png`,
      frame_skipped: false,
    })) as unknown as ShotState[];
    await save("creatives", CREATIVE, {
      concept_json: JSON.stringify(concept),
      shots_json: JSON.stringify(shots),
      status: "ready",
      generation: 2,
      final_key: `${CREATIVE}/final.mp4`,
      poster_url: `/api/media/${CREATIVE}/shot0-frame.png`,
      qc_score: null,
      cost_micro: 3_370_000,
      approved: 0,
      rejected: 0,
      error: null,
    });

    // The remake's lines in the campaign's log, once.
    const logged = new Set((await store().find<{ message: string }>("events", { campaign_id: CAMPAIGN })).map((e) => e.message));
    for (const [ts, message] of LINES) {
      if (!logged.has(message)) await store().insert("events", { brand_id: campaign.brand_id, campaign_id: CAMPAIGN, ts, level: "info", message });
    }

    const [after] = await store().find<CreativeRow>("creatives", { id: CREATIVE }, { limit: 1 });
    expect(after.final_key).toBe(`${CREATIVE}/final.mp4`);
    expect(parse<Concept>(after.concept_json, {} as Concept).title).toBe(TITLE);
  }, 120_000);
});
