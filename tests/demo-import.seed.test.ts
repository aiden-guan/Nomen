// Adds finished videos from the side sessions (code ads, brainrot, faceless clones, organic) to a
// campaign, so its demo recording shows one video per genre. Each keeps the research reference it was
// built on, looked up in the campaign's own research pool. Opt-in, run from the main checkout (it
// writes data/nomen.db and data/media through the store):
//
//   NOMEN_IMPORT=/path/to/lineup.json npx vitest run tests/demo-import.seed.test.ts
//
// lineup.json is a list of { campaign, file, title, genre, hook, reference (the researched video's
// URL), caption?, poster?, cost_usd?, internal?, made_at?, replaces? }. With `replaces` (a creative
// id) the video becomes that one's next generation, its first version kept under `previous`, so the
// director's plan still lines up. Rerunning updates the same videos.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse, save, store } from "@/lib/db";
import type { CreativeRow } from "@/lib/production";

const manifest = process.env.NOMEN_IMPORT;

type Entry = {
  campaign: string;
  file: string;
  title: string;
  /** The genre as the camp shows it: "code ad", "brainrot", "faceless one-to-one clone", "organic". */
  genre: string;
  hook: string;
  /** The researched video it was built on: its URL in the campaign's research pool. */
  reference: string;
  caption?: string;
  poster?: string;
  cost_usd?: number;
  /** A one-to-one copy of a real creator's video: held from posting unless cleared. */
  internal?: boolean;
  /** When it was finished (ISO); defaults to now. */
  made_at?: string;
  /** A planned video this one remade: it becomes that video's next generation. */
  replaces?: string;
  /** A newer cut of an existing video (its id): only its file and poster change, its concept stays. */
  recut?: string;
  /** Why this video, in the research's words (the War tent shows it); defaults to its reference's numbers. */
  why?: string;
  /** A reference found outside the campaign's research (a style scrape): added to its research first, marked as hand-added. */
  reference_add?: { url: string; author: string; views: number; followers: number; caption: string; platform?: "tiktok" | "instagram" };
};

type Researched = { url: string; author?: string; views?: number; followers?: number | null; caption?: string; platform?: string };

const count = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}K` : String(n));

describe.skipIf(!manifest)("import side-session videos into a campaign for its demo", () => {
  it("adds each video with its research reference and production lines", async () => {
    // The test config points every test at an in-memory database; this one writes the real one.
    process.env.NOMEN_DB_PATH = join(process.cwd(), "data", "nomen.db");
    const entries = JSON.parse(readFileSync(manifest!, "utf8")) as Entry[];
    for (const entry of entries) {
      expect(existsSync(entry.file), `missing ${entry.file}`).toBe(true);
      if (entry.recut) {
        const [row] = await store().find<CreativeRow>("creatives", { id: entry.recut }, { limit: 1 });
        expect(row, `no video ${entry.recut}`).toBeTruthy();
        await store().files.putFile(`${row.id}/final.mp4`, entry.file, "video/mp4");
        const frame = entry.poster ?? join(tmpdir(), `${row.id}-poster.png`);
        if (!entry.poster) execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-ss", "1", "-i", entry.file, "-frames:v", "1", "-vf", "scale=540:-2", frame]);
        await store().files.putFile(`${row.id}/shot0-frame.png`, frame, "image/png");
        await save("creatives", row.id, { final_key: `${row.id}/final.mp4`, poster_url: `/api/media/${row.id}/shot0-frame.png` });
        console.log(`${row.id}  new cut from ${entry.file}`);
        continue;
      }
      const [campaign] = await store().find<{ id: string; brand_id: string; research_json: string | null }>("campaigns", { id: entry.campaign }, { limit: 1 });
      expect(campaign, `no campaign ${entry.campaign}`).toBeTruthy();
      if (entry.reference_add) {
        const research = parse<Record<string, unknown> & { videos?: Researched[] }>(campaign.research_json, {});
        if (!(research.videos ?? []).some((v) => v.url === entry.reference_add!.url)) {
          const add = entry.reference_add;
          research.videos = [...(research.videos ?? []), { platform: add.platform ?? "tiktok", url: add.url, author: add.author, views: add.views, followers: add.followers, caption: add.caption, likes: 0, comments: 0, shares: 0, saves: 0, duration: null, paid: false, thumbnail: null, media_url: null, source: "format_evidence" } as unknown as Researched];
          await save("campaigns", entry.campaign, { research_json: JSON.stringify(research) });
          campaign.research_json = JSON.stringify(research);
        }
      }
      const pool = parse<{ videos?: Researched[] }>(campaign.research_json, {}).videos ?? [];
      const ref = pool.find((v) => v.url === entry.reference);
      expect(ref, `${entry.reference} is not in ${entry.campaign}'s research`).toBeTruthy();

      const id = entry.replaces ?? `crv_${createHash("sha1").update(`${entry.campaign}:${entry.title}`).digest("hex").slice(0, 20)}`;
      const existing = await store().find<CreativeRow>("creatives", { campaign_id: entry.campaign });
      const before = existing.find((c) => c.id === id);
      if (entry.replaces) expect(before, `no video ${entry.replaces} in ${entry.campaign}`).toBeTruthy();
      const idx = before?.idx ?? Math.max(-1, ...existing.map((c) => c.idx)) + 1;
      const old = entry.replaces && before ? parse<Record<string, unknown>>(before.concept_json, {}) : null;
      const seconds = Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", entry.file]).toString().trim());

      // The cut and its poster (a frame a second in, unless one is given).
      await store().files.putFile(`${id}/final.mp4`, entry.file, "video/mp4");
      let poster = entry.poster;
      if (!poster) {
        poster = join(tmpdir(), `${id}-poster.png`);
        execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-ss", "1", "-i", entry.file, "-frames:v", "1", "-vf", "scale=540:-2", poster]);
      }
      await store().files.putFile(`${id}/shot0-frame.png`, poster, "image/png");

      const at = entry.made_at ?? new Date().toISOString();
      const views = ref!.views ?? 0;
      const followers = ref!.followers ?? null;
      const author = ref!.author ?? "a creator";
      const evidence = `${count(views)} views${followers ? ` on ${count(followers)} followers` : ""}`;
      const concept = {
        title: entry.title,
        format: entry.genre,
        hook: entry.hook,
        caption: entry.caption ?? entry.hook,
        platforms: ["tiktok", "instagram", "youtube"],
        inspired_by: [ref!.url],
        why: entry.why ?? `Built on @${author}'s video from the scouts' research (${evidence}).`,
        reference: { id: `ref_${createHash("sha1").update(ref!.url).digest("hex").slice(0, 10)}`, url: ref!.url, author, views, followers, outlier: followers ? Math.round((views / followers) * 10) / 10 : null, format: entry.genre },
        brief: { ...((old?.brief as object) ?? {}), format: entry.genre, role: "reach" },
        script: { total_seconds: Math.round(seconds * 10) / 10, beats: [], review: null },
        ...(entry.internal ? { internal: true } : {}),
        ...(old ? { previous: old.previous ?? { title: old.title, format: old.format, hook: old.hook, note: "the first version, before this remake" } } : {}),
      };
      // save() only updates: a new video is inserted first.
      if (!before) await store().insert("creatives", { id, campaign_id: entry.campaign, idx, generation: 1, concept_json: "{}", shots_json: "[]", status: "ready", caption: "", platforms_json: "[]", created_at: at, updated_at: at });
      await save("creatives", id, {
        campaign_id: entry.campaign,
        idx,
        generation: before && entry.replaces ? Math.max(2, (before.generation ?? 1) + (old?.previous ? 0 : 1)) : 1,
        concept_json: JSON.stringify(concept),
        shots_json: "[]",
        status: "ready",
        final_key: `${id}/final.mp4`,
        poster_url: `/api/media/${id}/shot0-frame.png`,
        caption: entry.caption ?? entry.hook,
        platforms_json: JSON.stringify(concept.platforms),
        qc_score: null,
        approved: 0,
        rejected: 0,
        cost_micro: Math.round((entry.cost_usd ?? 0) * 1e6),
        error: null,
      });

      // Its production lines, once, worded as the production job logs them.
      const lines = [`"${entry.title}": made as a ${entry.genre} from @${author}'s video in the research (${evidence})`, `"${entry.title}" is ready`];
      const logged = new Set((await store().find<{ message: string }>("events", { campaign_id: entry.campaign })).map((e) => e.message));
      for (const [i, message] of lines.entries()) {
        if (!logged.has(message)) await store().insert("events", { brand_id: campaign.brand_id, campaign_id: entry.campaign, ts: new Date(Date.parse(at) + i * 1000).toISOString(), level: "info", message });
      }
      console.log(`${id}  ${entry.genre}: "${entry.title}" from @${author} (${evidence})`);
    }
  }, 300_000);
});
