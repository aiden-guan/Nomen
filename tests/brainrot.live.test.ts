import { execFile } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { type BrainrotBit, type BrainrotScript, estimateBrainrot, lintBrainrot, RECIPES, type Riff, writeBrainrot } from "@/lib/creative/brainrot";
import { makeBrainrot, OverBudget } from "@/lib/creative/brainrot-make";
import { patient } from "@/lib/creative/remake";
import { editFfmpeg } from "@/lib/creative/edit";
import type { ProductBrief } from "@/lib/creative/types";
import type { Video } from "@/lib/research";
import { MonidClient } from "@/lib/monid";
import { NaiveClient } from "@/lib/naive";
import type { Files } from "@/lib/store/types";

// Live, paid brainrot samples, one per sponsor. Nothing is posted: the videos stay in the output
// folder. Each reads its campaign's product brief read-only from data/nomen.db and writes nothing there.
//
//   NOMEN_BRAINROT_LIVE=dry    npx vitest run tests/brainrot.live.test.ts            (checks the inputs, pays nothing)
//   NOMEN_BRAINROT_LIVE=script npx vitest run tests/brainrot.live.test.ts            (writes the scripts, cached in script.json)
//   NOMEN_BRAINROT_LIVE=probe  npx vitest run tests/brainrot.live.test.ts -t monid   (the script and its first clip: the model's real price)
//   NOMEN_BRAINROT_LIVE=1      npx vitest run tests/brainrot.live.test.ts -t monid   (the whole video)
//
// Run from the main checkout, or set NOMEN_DATA_DIR=/path/to/nomen/data. Keys come from
// NAIVE_API_KEY and MONID_API_KEY, or from .env.local next to data/. Output goes to
// NOMEN_BRAINROT_OUT (default ./data/media/brainrot-live), so the app's own media is never touched;
// a rerun resumes from the kept files without paying again (NOMEN_BRAINROT_TAG for a fresh take).
// Options: NOMEN_BRAINROT_MAX_USD (the cap per video), NOMEN_BRAINROT_MODEL (a Naive video model),
// NOMEN_BRAINROT_RECUT=1 (cut a finished video again from its kept pieces, after the cut changed),
// NOMEN_BRAINROT_USD_PER_SECOND (its price until a clip measures it), NOMEN_BRAINROT_IMAGE_MODEL.

const mode = process.env.NOMEN_BRAINROT_LIVE;
const live = mode === "1" || mode === "dry" || mode === "script" || mode === "probe";
const exec = promisify(execFile);

/** `riff`: a video from the campaign's own research (its TikTok link) that the bit riffs on. */
type Case = { name: string; campaign: string; site: string; bit: BrainrotBit; maxUsd: number; riff?: string };

const CASES: Case[] = [
  { name: "monid", campaign: "cmp_f98819d8b08f46a7a422", site: "monid.ai", bit: "anthem", maxUsd: 3.6 },
  { name: "naive", campaign: "cmp_70daa9e79a4b42008d74", site: "usenaive.ai", bit: "melodrama", maxUsd: 3.6 },
  { name: "mobilerun", campaign: "cmp_8258fde751824aeba97f", site: "mobilerun.ai", bit: "aura", maxUsd: 3.6 },
  // A competitor's meme ad from the Monid campaign's research (Composio's agent-experiment funnel).
  { name: "monid-research", campaign: "cmp_f98819d8b08f46a7a422", site: "monid.ai", bit: "funnel", maxUsd: 2.9, riff: "https://www.tiktok.com/@phamhacks/video/7678518337311116557" },
];

/** A TikTok video's post date, from its id (the top 32 bits are the unix time). */
const postedOn = (url: string) => {
  const id = url.match(/video\/(\d+)/)?.[1];
  return id ? new Date(Number(BigInt(id) >> 32n) * 1000).toISOString().slice(0, 10) : "";
};

/** The store's files in a folder of their own, so a live run never touches the app's media. */
function folderFiles(root: string): Files {
  const at = (key: string) => join(root, key);
  return {
    async putFile(key, path) {
      await mkdir(dirname(at(key)), { recursive: true });
      if (resolve(path) !== resolve(at(key))) await copyFile(path, at(key));
    },
    async saveUrl() {
      throw new Error("not used");
    },
    async exists(key) {
      return existsSync(at(key));
    },
    async localPath(key) {
      return at(key);
    },
    async url(key) {
      return at(key);
    },
  };
}

describe.skipIf(!live)("brainrot ads (live, paid)", () => {
  for (const c of CASES) {
    it(`makes the ${RECIPES[c.bit].name} for ${c.site}`, async () => {
      const data = resolve(process.env.NOMEN_DATA_DIR ?? join(process.cwd(), "data"));
      for (const file of [join(process.cwd(), ".env.local"), join(dirname(data), ".env.local")]) {
        if ((!process.env.NAIVE_API_KEY || !process.env.MONID_API_KEY) && existsSync(file)) process.loadEnvFile(file);
      }
      const log = (message: string) => console.log(`[brainrot ${c.name}] ${message}`);

      // Read-only: the campaign's product brief, and its captured screenshots by path.
      const db = new Database(join(data, "nomen.db"), { readonly: true, fileMustExist: true });
      const row = db.prepare("select style_json, research_json from campaigns where id = ?").get(c.campaign) as { style_json: string; research_json: string | null } | undefined;
      db.close();
      expect(row, `${c.campaign} is not in ${data}/nomen.db`).toBeTruthy();
      const style = JSON.parse(row!.style_json) as { product: ProductBrief };
      const product: ProductBrief = {
        ...style.product,
        visuals: style.product.visuals.map((v) => (v.key && existsSync(join(data, "media", v.key)) ? { ...v, url: join(data, "media", v.key), key: undefined } : { ...v, key: undefined })),
      };
      const tag = process.env.NOMEN_BRAINROT_TAG ?? "v1";
      const root = resolve(process.env.NOMEN_BRAINROT_OUT ?? join(process.cwd(), "data", "media", "brainrot-live"));
      const out = join(root, `${c.name}-${tag}`);
      mkdirSync(out, { recursive: true });
      const files = folderFiles(join(root, "kept"));

      if (mode === "dry") {
        log(`product ${product.name}; ${product.visuals.length} visuals (${product.visuals.filter((v) => existsSync(v.url)).length} on disk); keys: Naive ${process.env.NAIVE_API_KEY ? "found" : "MISSING"}, Monid ${process.env.MONID_API_KEY ? "found" : "MISSING"}`);
        log(`output ${out}; no paid calls in dry mode`);
        return;
      }
      expect(process.env.NAIVE_API_KEY, "NAIVE_API_KEY is not set and no .env.local was found").toBeTruthy();
      expect(process.env.MONID_API_KEY, "MONID_API_KEY is not set and no .env.local was found").toBeTruthy();
      // Naive answers "at capacity" in bursts: every call waits it out and tries again.
      const naive = patient(new NaiveClient(), [10, 20, 30, 45, 60, 60, 60, 60, 60, 60].map((s) => s * 1000));
      const monid = new MonidClient();

      // The researched video to riff on, with its words (transcribed once on Naive, cached in riff.json).
      let riff: Riff | null = null;
      if (c.riff) {
        const riffPath = join(out, "riff.json");
        if (existsSync(riffPath)) riff = JSON.parse(await readFile(riffPath, "utf8")) as Riff;
        else {
          const videos = (JSON.parse(row!.research_json ?? "{}") as { videos?: Video[] }).videos ?? [];
          const video = videos.find((v) => v.url === c.riff);
          expect(video, `${c.riff} is not in ${c.campaign}'s research`).toBeTruthy();
          const v = video!;
          let transcript = "";
          if (v.media_url) {
            const job = await naive.transcribe({ url: v.media_url }, `brainrot-riff-${c.riff.match(/\d+$/)?.[0]}`).catch(() => null);
            transcript = job?.result?.text ?? "";
          }
          riff = {
            url: v.url,
            author: v.author,
            title: v.caption.replace(/#\S+/g, "").replace(/\s+/g, " ").trim(),
            views: v.views,
            likes: v.likes,
            shares: v.shares,
            saves: v.saves,
            followers: v.followers ?? 0,
            outlier: Math.round(v.views / Math.max(v.followers ?? 0, 1000)),
            seconds: Math.round(v.duration ?? 0),
            posted: postedOn(v.url),
            caption: v.caption,
            transcript,
          };
          await writeFile(riffPath, JSON.stringify(riff, null, 1));
        }
        log(`riffing on ${riff.url} (${riff.views} views, ${riff.outlier}x): ${riff.title}${riff.transcript ? ` | transcript ${riff.transcript.length} chars` : ""}`);
      }

      // The bit (cached: edit script.json to change it).
      const scriptPath = join(out, "script.json");
      let script: BrainrotScript;
      if (existsSync(scriptPath)) script = JSON.parse(await readFile(scriptPath, "utf8")) as BrainrotScript;
      else {
        log(`writing the ${RECIPES[c.bit].name}`);
        script = await writeBrainrot(naive, { product, site: c.site, bit: c.bit, riff });
        await writeFile(scriptPath, JSON.stringify(script, null, 1));
      }
      log(`"${script.title}" hook: ${script.hook} | critic ${script.review?.score ?? "?"}/10 ${(script.review?.notes ?? []).join(" / ")}`);
      for (const shot of script.shots) log(`shot ${shot.n}: ${shot.frame} | ${shot.motion} | "${shot.words}" | ${shot.stamp} | ${shot.sfx.join(",")} | ${shot.fx.join(",")}`);
      log(`end: "${script.end.line}" / ${script.end.text} | caption: ${script.caption}`);
      const lint = lintBrainrot(script, { product, site: c.site });
      if (lint.length) log(`lint: ${lint.join("; ")}`);
      const model = process.env.NOMEN_BRAINROT_MODEL ?? "google/veo-3.1-lite";
      const perSecond = Number(process.env.NOMEN_BRAINROT_USD_PER_SECOND) || 0.15;
      log(`estimate with ${model} at $${perSecond}/s: ${JSON.stringify(estimateBrainrot(script, { model, perSecond }).usd)}`);
      if (mode === "script") return;

      try {
        const result = await makeBrainrot(
          { naive, monid, files },
          {
            prefix: `${c.name}-${tag}`,
            script,
            product,
            site: c.site,
            videoModel: model,
            videoPerSecond: perSecond,
            imageModel: process.env.NOMEN_BRAINROT_IMAGE_MODEL || undefined,
            maxUsd: Number(process.env.NOMEN_BRAINROT_MAX_USD ?? c.maxUsd),
            idem: `brainrot-live-${c.name}-${tag}`,
            probe: mode === "probe",
            recut: process.env.NOMEN_BRAINROT_RECUT === "1",
            pollMs: 6000,
            onEvent: log,
          },
        );
        const summary = { spent_usd: { naive: result.spend.naive_micro / 1e6, monid: result.spend.monid_micro / 1e6 }, per_second: result.per_second, qc: result.qc, notes: result.notes, shots: result.shots };
        if (mode === "probe" || !result.path) {
          console.log(JSON.stringify(summary, null, 1));
          return;
        }
        const ffmpeg = (await editFfmpeg())!;
        const final = join(out, `${c.name}-brainrot.mp4`);
        const sheet = join(out, `${c.name}-frames.jpg`);
        copyFileSync(result.path, final);
        const cols = Math.ceil(result.duration);
        await exec(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-i", final, "-vf", `fps=1,scale=240:-2,tile=${Math.min(cols, 12)}x${Math.ceil(cols / 12)}`, "-frames:v", "1", sheet]);
        console.log(JSON.stringify({ video: final, frames: sheet, seconds: result.duration, reference: script.reference ?? RECIPES[c.bit].reference, ...summary }, null, 1));
        expect(existsSync(final)).toBe(true);
      } catch (error) {
        if (error instanceof OverBudget) log(`stopped by the cost guard: ${error.message}`);
        throw error;
      }
    }, 90 * 60_000);
  }
});
