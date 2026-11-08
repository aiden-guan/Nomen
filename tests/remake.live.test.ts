import { execFile } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { getBrandKit } from "@/lib/creative/brandkit";
import { editFfmpeg } from "@/lib/creative/edit";
import { cohostDescription, ensurePersona, genderOf, loadPersona, type Persona, portraitKey } from "@/lib/creative/persona";
import { OverBudget, remakeSpan, remakeVideo } from "@/lib/creative/remake";
import { writeScript } from "@/lib/creative/script";
import type { CreativeBrief, ProductBrief, ReferenceBreakdown, Script } from "@/lib/creative/types";
import { MonidClient } from "@/lib/monid";
import { NaiveClient } from "@/lib/naive";
import type { Files } from "@/lib/store/types";
import type { Concept } from "@/lib/strategy";

// Live, paid runs of the one-to-one remake (footage clone, Kling 3.0 voicing itself). Internal
// only: results stay in data/media/remake-live/ and are never posted. Each reads its campaign
// read-only from data/nomen.db and writes nothing there.
//
//   NOMEN_REMAKE_LIVE=1 npx vitest run tests/remake.live.test.ts -t cluely    (run it)
//   NOMEN_REMAKE_LIVE=1 npx vitest run tests/remake.live.test.ts -t jordan
//   NOMEN_REMAKE_LIVE=plan npx vitest run tests/remake.live.test.ts           (the plan and estimate only)
//   NOMEN_REMAKE_LIVE=dry  npx vitest run tests/remake.live.test.ts           (checks the inputs, pays nothing)
//
// Run from the main checkout (it reads data/), or set NOMEN_DATA_DIR=/path/to/nomen/data. Keys come
// from NAIVE_API_KEY and MONID_API_KEY, or from .env.local next to data/. "plan" pays for the script
// (Naive, cached in script.json) and one vision call, then stops at the cost guard. A rerun resumes
// from the kept files without paying again; set NOMEN_REMAKE_TAG to something new for a fresh take.
//
// Options: NOMEN_REMAKE_MAX_USD (the cap), NOMEN_REMAKE_UNTIL (remake the reference up to this second), NOMEN_REMAKE_VOICE_MATCH=1 (speech-to-speech each render's
// voice into the persona's one voice), NOMEN_REMAKE_FINISH=0 (no picture and sound finish, to A/B),
// NOMEN_REMAKE_PRESENTER (kling-native, kling-motion or naive:<model>).

const mode = process.env.NOMEN_REMAKE_LIVE;
const live = mode === "1" || mode === "plan" || mode === "dry";
const exec = promisify(execFile);

type Case = {
  name: string;
  campaign: string;
  creative: string;
  reference: string;
  file: string;
  until: number;
  maxUsd: number;
  /** The persona: a portrait already on disk (no cost) with its description, or a description to make one from. */
  persona: { portrait?: string; description: string };
  product: string;
  /** Overrides for the earlier video's creative brief (the pitch the rewritten lines make). */
  brief?: Partial<CreativeBrief>;
};

const CASES: Case[] = [
  {
    // The Cluely billboard hook (one man, a band over a blurred fill, a LinkedIn post and a photo
    // popping in): the first two beats, 0-9 s, about $1.70 on Kling.
    name: "cluely",
    campaign: "cmp_f98819d8b08f46a7a422",
    creative: "crv_376762f3ac4741cda217",
    reference: "ref_39fbf885ae",
    file: "cluely-billboards-original.mp4",
    until: 8,
    maxUsd: 4,
    persona: { portrait: "media/clone3/persona.png", description: "A stylish East Asian woman in her early twenties with long sleek dark hair, glam makeup with winged liner and glossy lips, small gold hoops, in a plain oversized black hoodie" },
    product: "monid.ai",
  },
  {
    // hustle.jordan99's "Part 67" (a talking head with a hook title, a stitched creator with her
    // cut-out, then a phone filming a monitor with her green-screened in), the whole 26.8 s. Dylan:
    // copy the script one to one with our faces and swap only the tutorial at the end for Naive,
    // as an obviously exaggerated bait ad.
    name: "jordan",
    campaign: "cmp_70daa9e79a4b42008d74",
    creative: "crv_aae357b14a344728923c",
    reference: "ref_e30369e6df",
    file: "hustle-jordan99-original.mp4",
    until: 27,
    maxUsd: 12,
    persona: { description: "A woman in her late twenties with shoulder-length wavy brown hair and light makeup, in a plain cream sweater: a casual, upbeat creator" },
    product: "usenaive.ai",
    brief: {
      angle: "A bait ad in the reference's voice, obviously exaggerated: Naive runs a whole company for you, completely automated, so it prints money while you sleep. The tutorial keeps the reference's three-step shape: go to usenaive dot ai, pick a company template, click Deploy.",
      cta: "End on the over-the-top payoff (the company runs itself and prints money), the way the reference ends on 'for completely free'.",
    },
  },
];

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

describe.skipIf(!live)("one-to-one remake, footage clone (live, paid)", () => {
  for (const c of CASES) {
    it(`remakes ${c.name} for ${c.product}`, async () => {
      const data = resolve(process.env.NOMEN_DATA_DIR ?? join(process.cwd(), "data"));
      for (const file of [join(process.cwd(), ".env.local"), join(dirname(data), ".env.local")]) {
        if ((!process.env.NAIVE_API_KEY || !process.env.MONID_API_KEY) && existsSync(file)) process.loadEnvFile(file);
      }
      process.env.NOMEN_BRANDKITS_DIR = join(data, "brandkits");
      const log = (message: string) => console.log(`[remake ${c.name}] ${message}`);

      // Read-only: the campaign's breakdown and product brief, and the earlier video's brief.
      const db = new Database(join(data, "nomen.db"), { readonly: true, fileMustExist: true });
      const campaign = db.prepare("select brand_id, style_json from campaigns where id = ?").get(c.campaign) as { brand_id: string; style_json: string };
      const row = db.prepare("select concept_json from creatives where id = ?").get(c.creative) as { concept_json: string } | undefined;
      db.close();
      const style = JSON.parse(campaign.style_json) as { breakdowns: ReferenceBreakdown[]; product: ProductBrief };
      const breakdown = style.breakdowns.find((b) => b.id === c.reference)!;
      expect(breakdown, `${c.reference} is not in ${c.campaign}`).toBeTruthy();
      const concept = row ? (JSON.parse(row.concept_json) as Concept) : null;
      // Captured screenshots are kept by key under data/media: the screen builder reads them there.
      const product: ProductBrief = { ...style.product, visuals: style.product.visuals.map((v) => (v.key && existsSync(join(data, "media", v.key)) ? { ...v, url: join(data, "media", v.key) } : v)) };
      const kit = getBrandKit(campaign.brand_id);
      const referencePath = join(data, "media", "references", c.file);
      expect(existsSync(referencePath), `save the reference as ${referencePath}`).toBe(true);
      const until = Number(process.env.NOMEN_REMAKE_UNTIL) || c.until;
      const span = remakeSpan(breakdown.beats, until);
      const tag = process.env.NOMEN_REMAKE_TAG ?? "v1";
      const out = join(data, "media", "remake-live", `${c.name}-${tag}`);
      const files = folderFiles(join(out, "kept"));
      mkdirSync(out, { recursive: true });

      if (mode === "dry") {
        log(`reference ${referencePath}; beats ${span.beats.map((b) => `${b.start}-${b.end}`).join(", ")} (to ${span.end} s)`);
        log(`product ${product.name}; kit ${kit.assets.length} assets${kit.repo ? " + repo scan" : ""}; keys: Naive ${process.env.NAIVE_API_KEY ? "found" : "MISSING"}, Monid ${process.env.MONID_API_KEY ? "found" : "MISSING"}`);
        log(`output ${out}; no paid calls in dry mode`);
        expect(span.beats.length).toBeGreaterThan(0);
        return;
      }
      expect(process.env.NAIVE_API_KEY, "NAIVE_API_KEY is not set and no .env.local was found").toBeTruthy();
      expect(process.env.MONID_API_KEY, "MONID_API_KEY is not set and no .env.local was found").toBeTruthy();
      const naive = new NaiveClient();
      const monid = new MonidClient();

      // The host: a portrait already made (no cost), kept as the brand's persona for this run.
      const brandId = `live-${c.name}`;
      if (c.persona.portrait && existsSync(join(data, c.persona.portrait)) && !(await loadPersona(files, brandId))) {
        mkdirSync(join(out, "kept", brandId), { recursive: true });
        copyFileSync(join(data, c.persona.portrait), join(out, "kept", portraitKey(brandId)));
        const gender = genderOf(c.persona.description);
        const { chooseVoice } = await import("@/lib/creative/persona");
        const persona: Persona = { brand_id: brandId, role: "host", description: c.persona.description, gender, voice: chooseVoice(gender, c.persona.description), portrait_key: portraitKey(brandId), cost_micro: 0, created_at: new Date().toISOString() };
        await writeFile(join(out, "kept", brandId, "persona.json"), JSON.stringify(persona, null, 1));
      }
      const host = await ensurePersona({ naive, files }, { brandId, role: "host", description: c.persona.description });
      log(`host: ${host.persona.description} (voice ${host.persona.voice.name})`);

      // Our lines, one per reference beat, with each beat's emotion (cached: edit script.json to change them).
      const scriptPath = join(out, "script.json");
      let script: Script;
      if (existsSync(scriptPath)) script = JSON.parse(await readFile(scriptPath, "utf8")) as Script;
      else {
        log("writing our lines (remake mode: the reference's words, its product beats rewritten into our pitch)");
        const brief: CreativeBrief = { ...(concept?.brief as CreativeBrief), ...c.brief, format: "remake", creator: host.persona.description };
        const reference: ReferenceBreakdown = { ...breakdown, beats: span.beats, duration: span.end, transcript: span.beats.map((b) => b.line).join(" ") };
        script = await writeScript(naive, { product, brief, reference, targetSeconds: Math.round(span.end) });
        await writeFile(scriptPath, JSON.stringify(script, null, 1));
      }
      for (const beat of script.beats) log(`beat ${beat.n} (${beat.seconds}s) ${beat.emotion ?? ""} ${beat.line}${beat.on_screen_text ? ` | on screen: ${beat.on_screen_text}` : ""}`);

      try {
        const result = await remakeVideo(
          { naive, monid, files },
          {
            prefix: `remake-${c.name}`,
            referencePath,
            breakdown,
            lines: script.beats.map((beat) => ({ line: beat.line, emotion: beat.emotion ?? "", on_screen_text: beat.on_screen_text })),
            host,
            cohost: async (other) => {
              const made = await ensurePersona({ naive, files }, { brandId, role: "cohost", description: cohostDescription(other) });
              log(`co-host: ${made.persona.description} (voice ${made.persona.voice.name})`);
              return made;
            },
            product,
            kit: kit.assets.length || kit.repo ? kit : null,
            until,
            maxUsd: mode === "plan" ? 0 : Number(process.env.NOMEN_REMAKE_MAX_USD ?? c.maxUsd),
            presenter: process.env.NOMEN_REMAKE_PRESENTER ?? "kling-native",
            voice: "fresh",
            voiceMatch: process.env.NOMEN_REMAKE_VOICE_MATCH === "1",
            finish: process.env.NOMEN_REMAKE_FINISH !== "0",
            idem: `remake-live-${c.name}-${tag}`,
            onEvent: log,
          },
        );

        // Contact sheets: ours, and the reference over ours at the same moments (one frame a second).
        const ffmpeg = (await editFfmpeg())!;
        const cols = Math.ceil(result.duration);
        const sheet = join(out, `${c.name}-frames.jpg`);
        const compare = join(out, `${c.name}-compare.jpg`);
        const final = join(out, `${c.name}-remake.mp4`);
        await copyFile(result.path, final);
        await exec(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-i", final, "-vf", `fps=1,scale=270:-2,tile=${cols}x1`, "-frames:v", "1", sheet]);
        await exec(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-t", String(result.duration), "-i", referencePath, "-i", final, "-filter_complex", `[0:v]fps=1,scale=270:480,tile=${cols}x1[a];[1:v]fps=1,scale=270:480,tile=${cols}x1[b];[a][b]vstack`, "-frames:v", "1", compare]);
        console.log(
          JSON.stringify(
            {
              video: final,
              frames: sheet,
              compare,
              seconds: result.duration,
              segments: result.layout.segments.map((s) => `${s.kind} ${s.start}-${s.end}`),
              estimate_usd: result.estimate.usd,
              spent_usd: { naive: result.spend.naive_micro / 1e6, monid: result.spend.monid_micro / 1e6 },
              // How the renders' own voices compare: median pitch and level per render (and after speech-to-speech).
              voices: result.voices,
              check: result.qc,
              notes: result.notes,
            },
            null,
            1,
          ),
        );
        expect(existsSync(final)).toBe(true);
      } catch (error) {
        if (mode === "plan" && error instanceof OverBudget) {
          log(`plan only: ${error.message}`);
          return;
        }
        throw error;
      }
    }, 90 * 60_000);
  }
});
