import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { getBrandKit } from "@/lib/creative/brandkit";
import { editFfmpeg } from "@/lib/creative/edit";
import { remakeSpan, remakeVideo, ensurePersona } from "@/lib/creative/remake";
import { ensureReferenceVideo } from "@/lib/creative/remake-job";
import { writeScript } from "@/lib/creative/script";
import type { CreativeBrief, ProductBrief, ReferenceBreakdown, Script } from "@/lib/creative/types";
import { NaiveClient } from "@/lib/naive";
import type { Video } from "@/lib/research";
import type { Concept } from "@/lib/strategy";

// Live, paid run of the one-to-one remake: the first ~15 s (three beats) of Cluely's billboard video
// remade for monid.ai, from campaign cmp_f98819d8b08f46a7a422 (read-only). Internal only: the result
// stays in data/media/remake-live/ and is never posted.
//
//   NOMEN_REMAKE_LIVE=1 npx vitest run tests/remake.live.test.ts
//
// Run it from the main checkout (it reads data/nomen.db, data/brandkits and data/media), or set
// NOMEN_DATA_DIR=/path/to/nomen/data. The Naive key comes from NAIVE_API_KEY or, when that is unset,
// from .env.local next to data/. Spend: about $9-12 (20 s of Veo at ~$0.40/s, image edits, a few
// Sonnet calls); NOMEN_REMAKE_MAX_RENDER_SECONDS (default 24) refuses a bigger plan before any
// render. A rerun resumes from data/media/remake-live/work without paying again; delete that folder
// (or set NOMEN_REMAKE_TAG to something new) for a fresh take.

// NOMEN_REMAKE_LIVE=dry checks every input (database, brand kit, reference, persona) and stops before any paid call.
const mode = process.env.NOMEN_REMAKE_LIVE;
const live = mode === "1" || mode === "dry";
const exec = promisify(execFile);

const CAMPAIGN = "cmp_f98819d8b08f46a7a422";
const CREATIVE = "crv_376762f3ac4741cda217"; // the earlier split-screen Cluely remake: its brief and presenter
const REFERENCE = "ref_39fbf885ae";

describe.skipIf(!live)("one-to-one remake (live, paid)", () => {
  it("remakes the first ~15 s of the Cluely billboard video for monid.ai", async () => {
    const data = resolve(process.env.NOMEN_DATA_DIR ?? join(process.cwd(), "data"));
    if (!process.env.NAIVE_API_KEY) {
      for (const file of [join(process.cwd(), ".env.local"), join(dirname(data), ".env.local")]) {
        if (existsSync(file)) {
          process.loadEnvFile(file);
          break;
        }
      }
    }
    if (mode !== "dry") expect(process.env.NAIVE_API_KEY, "NAIVE_API_KEY is not set and no .env.local was found").toBeTruthy();
    process.env.NOMEN_BRANDKITS_DIR = join(data, "brandkits");

    // Read-only: the campaign's research, breakdown, product brief and the earlier concept.
    const db = new Database(join(data, "nomen.db"), { readonly: true, fileMustExist: true });
    const campaign = db.prepare("select brand_id, style_json, research_json from campaigns where id = ?").get(CAMPAIGN) as { brand_id: string; style_json: string; research_json: string };
    const creative = db.prepare("select concept_json from creatives where id = ?").get(CREATIVE) as { concept_json: string };
    db.close();
    const style = JSON.parse(campaign.style_json) as { breakdowns: ReferenceBreakdown[]; product: ProductBrief };
    const breakdown = style.breakdowns.find((b) => b.id === REFERENCE)!;
    const videos = (JSON.parse(campaign.research_json) as { videos: Video[] }).videos;
    const mediaUrl = videos.find((v) => v.url.includes("7544005050146770189"))?.media_url ?? null;
    const concept = JSON.parse(creative.concept_json) as Concept;
    const product = style.product;
    const kit = getBrandKit(campaign.brand_id);

    const until = Number(process.env.NOMEN_REMAKE_UNTIL ?? 15);
    const tag = process.env.NOMEN_REMAKE_TAG ?? "v1";
    const out = join(data, "media", "remake-live");
    const workDir = join(out, `work-${tag}`);
    const handLabelled = join(data, "media", "references", "cluely-billboards-original.mp4");
    const referencePath = existsSync(handLabelled) ? handLabelled : mode === "dry" ? `(to download) ${mediaUrl}` : await ensureReferenceVideo(breakdown, mediaUrl, join(data, "media", "references"));
    const log = (message: string) => console.log(`[remake] ${message}`);
    const span = remakeSpan(breakdown.beats, until);
    const earlier = join(data, "media", CREATIVE, "shot1-frame.png");

    if (mode === "dry") {
      log(`reference ${referencePath}; beats ${span.beats.map((b) => `${b.start}-${b.end}`).join(", ")} (to ${span.end} s, ${breakdown.pacing.words_per_minute} wpm)`);
      log(`product ${product.name}; kit ${kit.assets.length} assets${kit.repo ? " + repo scan" : ""}; persona ${existsSync(earlier) ? earlier : "(will be generated)"}; key ${process.env.NAIVE_API_KEY ? "found" : "MISSING"}`);
      log(`output ${out}; no paid calls in dry mode`);
      expect(span.beats.length).toBeGreaterThan(0);
      return;
    }
    const naive = new NaiveClient();
    await mkdir(workDir, { recursive: true });

    // Our presenter: the persona the earlier remake used, else one made from the concept's description.
    const persona = existsSync(earlier) ? earlier : (await ensurePersona(naive, { persona: concept.creator, path: join(workDir, "persona.png"), idem: `remake-live-${tag}` })).path;

    // Our lines, one per reference beat, within each beat's word budget (cached: edit script.json to change them).
    const scriptPath = join(workDir, "script.json");
    let script: Script;
    if (existsSync(scriptPath)) script = JSON.parse(await readFile(scriptPath, "utf8")) as Script;
    else {
      log("writing our lines (remake mode, per-beat word budgets)");
      const brief: CreativeBrief = { ...concept.brief!, format: "remake" };
      const reference: ReferenceBreakdown = { ...breakdown, beats: span.beats, duration: span.end, transcript: span.beats.map((b) => b.line).join(" ") };
      script = await writeScript(naive, { product, brief, reference, targetSeconds: Math.round(span.end) });
      await writeFile(scriptPath, JSON.stringify(script, null, 1));
    }
    for (const beat of script.beats) log(`beat ${beat.n} (${beat.seconds}s): ${beat.line}`);

    const result = await remakeVideo(naive, {
      referencePath,
      breakdown,
      lines: script.beats.map((beat) => beat.line),
      personaPath: persona,
      persona: concept.creator,
      product,
      kit: kit.assets.length || kit.repo ? kit : null,
      workDir,
      outPath: join(out, `cluely-monid-remake-${tag}.mp4`),
      idem: `remake-live-cluely-monid-${tag}`,
      until,
      maxRenderSeconds: Number(process.env.NOMEN_REMAKE_MAX_RENDER_SECONDS ?? 24),
      onEvent: log,
    });

    // Contact sheets: ours, and the reference over ours at the same moments.
    const ffmpeg = (await editFfmpeg())!;
    const sheet = join(out, `cluely-monid-remake-${tag}-frames.jpg`);
    const compare = join(out, `cluely-monid-remake-${tag}-compare.jpg`);
    const cols = Math.ceil(result.duration);
    await exec(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-i", result.path, "-vf", `fps=1,scale=270:-2,tile=${cols}x1`, "-frames:v", "1", sheet]);
    await exec(ffmpeg, [
      "-hide_banner", "-loglevel", "error", "-y",
      "-t", String(result.duration), "-i", referencePath, "-i", result.path,
      "-filter_complex", `[0:v]fps=1,scale=270:480,tile=${cols}x1[a];[1:v]fps=1,scale=270:480,tile=${cols}x1[b];[a][b]vstack`,
      "-frames:v", "1", compare,
    ]);
    console.log(JSON.stringify({ video: result.path, frames: sheet, compare, seconds: result.duration, spent_usd_images_and_video: result.cost_micro / 1e6, notes: result.failures, work: workDir }, null, 1));
    expect(existsSync(result.path)).toBe(true);
  }, 60 * 60_000);
});
