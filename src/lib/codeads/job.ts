// Makes a code ad from its story, and the production hook that runs it in the background.
//
//   story ─► narrate (ElevenLabs on Monid, or the free scratch voice) ─► layout (story.json) ─► cues + synth.py (audio.wav)
//         ─► render (headless Chrome, WebGL, 60 fps + motion blur) ─► mux (final.mp4) ─► frames + vision QC ─► kept by key
//
// Everything a later tick needs is kept in the store's files under the creative's id: the voice clips
// ("crv_…/voice/…", paid for once), the cut ("crv_…/final.mp4"), its poster and its frame sheet. The rest (the page's
// folder, frames, stems) is scratch for one run. Rendering needs Chrome with WebGL and ffmpeg on the machine: it runs
// where the worker runs locally, not on a serverless host (Vercel has neither).

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";

import { logEvent, save, store } from "../db";
import { ApiError } from "../http";
import { download, ffmpegPath, probe, scratchDir } from "../media";
import type { NaiveClient } from "../naive";
import type { CreativeRow, ProductionContext } from "../production";
import { QC_MODEL, type Verdict } from "../qc";
import { extractJson } from "../research";
import type { Files } from "../store/types";
import type { Concept } from "../strategy";
import { findChrome } from "../creative/screens";
import type { BrandKit, ProductBrief } from "../creative/types";
import { buildCues } from "./cues";
import { layoutStory, type StoryJson } from "./layout";
import { ADAM_V3, type Narrator, narrate } from "./narrate";
import { contactSheet, renderStills, renderVideo, runQc } from "./render";
import { type CodeAdBrand, type CodeAdStory, HEROES, type Hero } from "./types";

/** The developer a story plays with: its own pick, else a rotation keyed on the video (geek, mogger, geek…). */
export function heroFor(story: CodeAdStory, key: string): Hero {
  if (story.hero && HEROES.includes(story.hero)) return story.hero;
  let h = 0;
  for (const c of key) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return HEROES[h % HEROES.length];
}

const SYNTH = resolve(process.cwd(), "src/lib/codeads/synth.py");

// ---------- the brand as the page draws it ----------

const hexOf = (value: string) => (/^#[0-9a-f]{6}$/i.test(value.trim()) ? value.trim().toLowerCase() : null);
const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
const luma = (hex: string) => { const [r, g, b] = rgb(hex); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const chroma = (hex: string) => { const c = rgb(hex); return Math.max(...c) - Math.min(...c); };

/** The colour an SVG logo is drawn in (its most used fill), or null. */
export function svgInk(svg: string): string | null {
  const counts = new Map<string, number>();
  for (const m of svg.matchAll(/fill="(#[0-9a-fA-F]{6})"/g)) counts.set(m[1].toLowerCase(), (counts.get(m[1].toLowerCase()) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

/**
 * The brand's colours, logo (one for dark backgrounds, one for light) and font, copied into the ad's folder and named as
 * the page loads them (/ad/...). Colours come from the brand kit's code scan; the defaults are the build genre's.
 */
export async function brandFor(input: { name: string; site: string; kit: BrandKit | null; product: ProductBrief; dir: string; logoPath?: string | null }): Promise<CodeAdBrand> {
  const colors = (input.kit?.repo?.colors ?? []).map((c) => ({ name: c.name.toLowerCase(), hex: hexOf(c.hex) })).filter((c): c is { name: string; hex: string } => Boolean(c.hex));
  const named = (re: RegExp, ok: (hex: string) => boolean) => colors.find((c) => re.test(c.name) && ok(c.hex))?.hex ?? null;
  const screenBg = named(/background|^bg|surface|card/, (h) => luma(h) < 0.3) ?? colors.find((c) => luma(c.hex) < 0.18)?.hex ?? "#1d2433";
  const screenFg = named(/foreground|^fg|text/, (h) => luma(h) > 0.6) ?? "#ececec";
  const accent = named(/primary|brand|accent|amber|orange|yellow|blue|green|emerald|purple|pink/, (h) => chroma(h) > 0.3) ?? colors.find((c) => chroma(c.hex) > 0.3)?.hex ?? "#ffc21a";
  const primary = named(/primary|brand|logo/, () => true) ?? accent;

  // logos: an SVG's own ink says which background it is for; a raster logo is taken as drawn for light backgrounds
  const logos = (input.kit?.assets ?? []).filter((a) => a.kind === "logo" || a.kind === "icon").filter((a) => existsSync(a.path) && /\.(svg|png|jpe?g|webp)$/i.test(a.path));
  let onDark: string | null = null, onLight: string | null = null;
  for (const logo of logos) {
    const ext = extname(logo.path).toLowerCase();
    const ink = ext === ".svg" ? svgInk(await readFile(logo.path, "utf8").catch(() => "")) : null;
    const forDark = ink ? luma(ink) > 0.5 : false;
    const target = `logo-${forDark ? "dark" : "light"}${ext}`;
    if (forDark && !onDark) (await copyFile(logo.path, join(input.dir, target)), (onDark = `/ad/${target}`));
    if (!forDark && !onLight) (await copyFile(logo.path, join(input.dir, target)), (onLight = `/ad/${target}`));
  }
  // no logo in the kit: a product visual that is the logo (the analyst captions them "… logo …"), downloaded if remote
  const logoVisual = input.product.visuals.find((v) => v.kind === "photo" && /\blogo\b/i.test(v.caption));
  const fallback = input.logoPath ?? logoVisual?.url ?? null;
  if (!onDark && !onLight && fallback) {
    try {
      const ext = (extname(/^https?:/.test(fallback) ? new URL(fallback).pathname : fallback).toLowerCase() || ".png").slice(0, 5);
      const target = `logo${ext}`;
      if (/^https?:/.test(fallback)) await download(fallback, join(input.dir, target));
      else if (existsSync(fallback)) await copyFile(fallback, join(input.dir, target));
      if (existsSync(join(input.dir, target))) onLight = `/ad/${target}`;
    } catch {
      // no logo: the brand card shows the name and the url
    }
  }
  const font = (input.kit?.assets ?? []).find((a) => a.kind === "font" && /\.(woff2?|ttf|otf)$/i.test(a.path) && existsSync(a.path));
  let fontUrl: string | null = null;
  if (font) {
    const target = `brand-font${extname(font.path).toLowerCase()}`;
    await copyFile(font.path, join(input.dir, target));
    fontUrl = `/ad/${target}`;
  }
  return {
    name: input.name,
    url: input.site,
    logo: onDark ?? onLight,
    logoOnLight: onLight ?? onDark,
    font: fontUrl,
    fontFamily: fontUrl ? "BrandSans" : null,
    colors: { screenBg, screenFg, accent, crate: primary, robot: "#1f2228", eye: chroma(accent) > 0.3 ? accent : "#8ef0ff", sign: accent, wall: "#3a414d" },
  };
}

/** The product visuals the story puts on the wall screen, copied into the ad's folder: id → /ad/visual-<id>.<ext>. */
async function visualFiles(story: CodeAdStory, product: ProductBrief, dir: string, files: Files): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const id of new Set(story.beats.map((b) => b.screen.visual_id).filter((v): v is string => Boolean(v)))) {
    const visual = product.visuals.find((v) => v.id === id);
    if (!visual) continue;
    try {
      let path = visual.url;
      if (visual.key && !existsSync(path)) path = await files.localPath(visual.key).catch(() => path);
      const ext = (extname(/^https?:/.test(path) ? new URL(path).pathname : path).toLowerCase() || ".png").slice(0, 6);
      const target = join(dir, `visual-${id}${ext}`);
      if (/^https?:/.test(path)) await download(path, target);
      else if (existsSync(path)) await copyFile(path, target);
      else continue;
      out[id] = `/ad/visual-${id}${ext}`;
    } catch {
      // a visual that will not download: that beat shows the logo card instead
    }
  }
  return out;
}

// ---------- sound, picture, check ----------

async function exec(bin: string, args: string[], cwd?: string): Promise<string> {
  return new Promise((done, fail) => {
    const child = spawn(bin, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    child.stdout.on("data", (c: Buffer) => (out = (out + c.toString("utf8")).slice(-4000)));
    child.stderr.on("data", (c: Buffer) => (err = (err + c.toString("utf8")).slice(-2000)));
    child.on("error", fail);
    child.on("close", (code) => (code === 0 ? done(out) : fail(new Error(`${bin} ${args[0] ?? ""} failed (${code}): ${(err || out).trim().slice(-400)}`))));
  });
}

/** Music, foley and the narrator mixed to -14 LUFS by the vendored synth (numpy + scipy). Returns its log. */
export async function synthesize(dir: string): Promise<string> {
  const python = process.env.NOMEN_PYTHON || "python3";
  return exec(python, ["-I", SYNTH, "--cues", join(dir, "cues.json"), "--out", dir, "--no-pack"]);
}

/** H.264 + AAC 1080x1920, capped so a 30 s ad stays well under any platform's limit. */
export async function mux(silent: string, audio: string, out: string) {
  const ffmpeg = await ffmpegPath();
  if (!ffmpeg) throw new Error("ffmpeg is needed to finish a code ad");
  await exec(ffmpeg, ["-y", "-loglevel", "error", "-i", silent, "-i", audio, "-c:v", "libx264", "-preset", "slow", "-crf", "20", "-maxrate", "8000k", "-bufsize", "16000k", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-shortest", "-movflags", "+faststart", out]);
}

/** The moments worth a still: each beat's hit and the middle of its speech, plus the ending. */
export function sheetTimes(story: StoryJson, count = 14): number[] {
  const marks = story.codead.beats.flatMap((b) => [b.hit + 0.35, (b.s0 + b.s1) / 2]).concat([story.duration - 0.6]);
  const sorted = [...new Set(marks.map((t) => Math.round(Math.min(story.duration - 0.05, Math.max(0.2, t)) * 10) / 10))].sort((a, b) => a - b);
  while (sorted.length > count) sorted.splice(Math.floor(sorted.length / 2), 1);
  return sorted;
}

const VERDICT_TOOL = {
  name: "qc_verdict",
  description: "Record the quality verdict for this code ad.",
  input_schema: {
    type: "object",
    required: ["score", "pass", "issues", "fix_prompt"],
    properties: {
      score: { type: "integer", description: "1-10. 9-10 a polished ad a brand would post today; 7-8 strong, minor flaws; 5-6 visibly broken or off-brief somewhere; 1-4 broken." },
      pass: { type: "boolean", description: "true only if score >= 7 and nothing is broken." },
      issues: { type: "array", items: { type: "string" }, description: "Concrete defects seen in the frames, most severe first, with the frame's time. Empty if none." },
      fix_prompt: { type: "string", description: "What to change in the story or the scene to fix them, or empty." },
    },
  },
};

/** The QC pass every video gets, for a code ad: a vision model reads a frame sheet against the story. */
export async function reviewCodeAd(naive: Pick<NaiveClient, "message">, input: { sheet: Buffer; times: number[]; story: CodeAdStory; brand: string }): Promise<Verdict> {
  const rubric = [
    `This is a frame sheet (left to right, top to bottom, at ${input.times.map((t) => `${t.toFixed(1)} s`).join(", ")}) from a 3D cartoon ad for ${input.brand}, made in code: a narrator, a big-headed cartoon software developer in a 3D office with a wall screen, one spoken word at a time in the middle of the frame, coloured callouts.`,
    `The story, beat by beat: ${JSON.stringify(input.story.beats.map((b) => ({ say: b.say, gag: b.gag, screen: b.screen, callouts: b.callouts.map((c) => c.text) })))}`,
    "Fail it for: broken rendering (black or blank frames, objects through the developer or the desk, things floating), text a viewer cannot read (the caption or a callout over the developer's face, cut off, illegible wall screen when it matters), the product's name or logo wrong or missing, a frame where nothing shows what the line says, anything off-brand or crude.",
    "By design: the callouts sit in the lower third, over the desk; banknotes, boxes or confetti may cover the developer for a moment during their gag. Do not fail it for its cartoon style, the robots or the jokes: they are the format. Call the qc_verdict tool once.",
  ].join("\n");
  const content = [{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: input.sheet.toString("base64") } }, { type: "text", text: rubric }];
  const reply = await naive.message({ model: QC_MODEL, max_tokens: 1500, messages: [{ role: "user", content }], tools: [VERDICT_TOOL] });
  const raw = (reply.content.find((block) => block.type === "tool_use" && block.name === VERDICT_TOOL.name)?.input ?? extractJson(reply.content.map((block) => block.text ?? "").join("\n"))) as Partial<Verdict> | null;
  if (!raw || typeof raw.score !== "number") throw new ApiError("naive", 502, "qc_unreadable", "the code-ad check returned no verdict");
  const score = Math.max(1, Math.min(10, Math.round(raw.score)));
  return { score, pass: Boolean(raw.pass) && score >= 7, issues: Array.isArray(raw.issues) ? raw.issues.filter((i): i is string => typeof i === "string").slice(0, 8) : [], fix_prompt: typeof raw.fix_prompt === "string" ? raw.fix_prompt : "" };
}

export type MakeCodeAdInput = {
  /** The store keys' prefix: the creative's id. */
  prefix: string;
  story: CodeAdStory;
  product: ProductBrief;
  kit: BrandKit | null;
  brandName: string;
  site: string;
  narrator: Narrator;
  /** Reads the ad when the narrator cannot (ElevenLabs refused or out of credits): Naive's own text-to-speech. */
  fallbackNarrator?: Narrator | null;
  files: Files;
  /** Scratch space for this run (removed by the caller). */
  dir: string;
  chrome: string;
  targetSeconds: number;
  naive?: Pick<NaiveClient, "message"> | null;
  fps?: number;
  blur?: number;
  logoPath?: string | null;
  log?: (message: string) => void;
};

export type MadeCodeAd = { key: string; posterKey: string; sheetKey: string; path: string; sheet: string; duration: number; spendMicro: number; qc: Verdict | null; notes: string[]; story: StoryJson };

/** The ad's folder, ready to render: the brand's files, the narration (voice.wav), story.json and cues.json. */
export async function prepareAd(input: MakeCodeAdInput): Promise<{ story: StoryJson; notes: string[]; spendMicro: number }> {
  const { dir, files, prefix } = input;
  await mkdir(dir, { recursive: true });
  const brand = await brandFor({ name: input.brandName, site: input.site, kit: input.kit, product: input.product, dir, logoPath: input.logoPath });
  const images = await visualFiles(input.story, input.product, dir, files);
  const read = (narrator: Narrator) => narrate(input.story.beats, { narrator, files, prefix, dir, targetSeconds: input.targetSeconds, log: input.log });
  const voice = await read(input.narrator).catch((error: unknown) => {
    // a busy provider is waited out (the next tick tries again); a refusal or an empty wallet hands over to the fallback
    if (!input.fallbackNarrator || (error instanceof ApiError && error.retryable)) throw error;
    input.log?.(`the narrator could not read it (${error instanceof Error ? error.message : String(error)}); ${input.fallbackNarrator.kind === "naive" ? "Naive's text-to-speech" : "the scratch voice"} reads it instead`);
    return read(input.fallbackNarrator);
  });
  const { story, notes } = layoutStory({ ...input.story, hero: heroFor(input.story, prefix) }, voice.voiced, brand, images, { fps: input.fps ?? 60, motionBlur: input.blur ?? 2 });
  await writeFile(join(dir, "story.json"), JSON.stringify(story));
  await writeFile(join(dir, "cues.json"), JSON.stringify(buildCues(story, input.brandName)));
  return { story, notes, spendMicro: voice.spendMicro };
}

/** Makes the whole ad and keeps it: "<prefix>/final.mp4", its poster and its frame sheet. */
export async function makeCodeAd(input: MakeCodeAdInput): Promise<MadeCodeAd> {
  const { dir, files, prefix } = input;
  const log = input.log ?? (() => undefined);
  const { story, notes, spendMicro } = await prepareAd(input);
  const synthLog = await synthesize(dir);
  const dropouts = synthLog.match(/music dropouts: ([^\n]*)/)?.[1];
  if (dropouts && !/none/.test(dropouts)) notes.push(`music dropouts: ${dropouts}`);
  log(`sound: ${synthLog.match(/integrated[^\n]*/i)?.[0]?.trim() ?? "mixed"}`);

  const qcLines = await runQc(dir, input.chrome).catch((error: unknown) => [`(the face check did not run: ${error instanceof Error ? error.message : String(error)})`]);
  if (qcLines.length) notes.push(`${qcLines.length} moments with the developer's face under text (first: ${qcLines[0]})`);
  const silent = join(dir, "silent.mp4");
  const started = Date.now();
  const warnings = await renderVideo(dir, input.chrome, silent, { fps: input.fps ?? 60, blur: input.blur ?? 2, to: story.duration });
  log(`rendered ${story.duration.toFixed(1)} s at ${input.fps ?? 60} fps in ${Math.round((Date.now() - started) / 1000)} s${warnings.length ? ` (${warnings.length} page warnings: ${warnings.slice(0, 2).join(" | ").slice(0, 300)})` : ""}`);
  const final = join(dir, "final.mp4");
  await mux(silent, join(dir, "audio.wav"), final);

  const times = sheetTimes(story);
  const stills = await renderStills(dir, input.chrome, times, join(dir, "stills"), 0.5);
  const sheet = await contactSheet(stills, join(dir, "frames.jpg"), 7);
  let qc: Verdict | null = null;
  if (input.naive) {
    try {
      qc = await reviewCodeAd(input.naive, { sheet: await readFile(sheet), times, story: input.story, brand: input.brandName });
    } catch (error) {
      if (error instanceof ApiError && error.outOfCredits) throw error;
      notes.push(`the frame check did not run: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  // the poster is kept where the camp's media route serves a faceless video's poster ("crv_…/shot0-frame.png")
  const key = `${prefix}/final.mp4`, posterKey = `${prefix}/shot0-frame.png`, sheetKey = `${prefix}/frames.jpg`;
  await files.putFile(key, final, "video/mp4");
  const poster = join(dir, "poster.png");
  await exec((await ffmpegPath())!, ["-y", "-loglevel", "error", "-i", stills[Math.min(stills.length - 1, Math.floor(stills.length / 3))], poster]);
  await files.putFile(posterKey, poster, "image/png");
  await files.putFile(sheetKey, sheet, "image/jpeg");
  const duration = (await probe(final)).duration;
  return { key, posterKey, sheetKey, path: final, sheet, duration, spendMicro, qc, notes, story };
}

// ---------- the production hook ----------

declare global {
  var __nomenCodeAds: Map<string, Promise<void>> | undefined;
}
/** Code ads rendering in this process (on globalThis, so a hot reload does not start a second); one GPU, one at a time. */
const running = () => (globalThis.__nomenCodeAds ??= new Map());
let queue: Promise<void> = Promise.resolve();

/** Why this machine cannot render a code ad, or null when it can. */
export function cannotRender(): string | null {
  if (process.env.VERCEL) return "code ads render in headless Chrome with WebGL on a machine with a GPU; this serverless host has neither, so run the worker locally to make them";
  if (!findChrome()) return "code ads render in headless Chrome with WebGL: install Google Chrome or set CHROME_PATH";
  return null;
}

/**
 * Called by production for a code_ad concept on every tick: starts the job once, and otherwise returns at once. The
 * creative turns ready (or failed) when it ends. The video then goes through review and posting like any other.
 */
export async function advanceCodeAd(ctx: ProductionContext, creative: CreativeRow, concept: Concept): Promise<void> {
  if (running().has(creative.id) || creative.status === "ready" || creative.status === "failed") return;
  const story = concept.script?.code_ad;
  if (!story?.beats.length) {
    await save("creatives", creative.id, { status: "failed", error: "the code ad has no story (script.code_ad)" });
    return;
  }
  const why = cannotRender();
  if (why) {
    await save("creatives", creative.id, { status: "failed", error: why });
    return;
  }
  if (creative.status === "queued") await save("creatives", creative.id, { status: "producing" });
  const log = (message: string, level: "info" | "warn" | "error" = "info") => logEvent({ brandId: ctx.brandId, campaignId: ctx.campaignId, level, message: `"${concept.title}" (code ad): ${message}` }).catch(() => undefined);
  const run = queue.then(() => runCodeAd(ctx, creative, concept, story, (m) => void log(m)));
  queue = run.catch(() => undefined);   // the next ad waits for this one, whatever happens to it
  const job = run
    .catch(async (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof ApiError && error.retryable) {
        await log(`paused (${message}); resuming on the next tick`, "warn");
        return;
      }
      await save("creatives", creative.id, { status: "failed", error: `code ad failed: ${message.slice(0, 500)}` });
      await log(`failed: ${message}`, "error");
    })
    .finally(() => running().delete(creative.id));
  running().set(creative.id, job);
}

async function runCodeAd(ctx: ProductionContext, creative: CreativeRow, concept: Concept, story: CodeAdStory, log: (message: string) => void) {
  if (!ctx.product) throw new Error("the campaign has no product brief");
  const [brand] = await store().find<{ name: string; domain: string; url: string }>("brands", { id: ctx.brandId }, { limit: 1 });
  const site = story.url || brand?.domain || "";
  const dir = join(scratchDir(), `codead-${creative.id}`);
  // ElevenLabs' Adam on Monid by default (NOMEN_CODEAD_NARRATOR=v3: ED Studio's dramatic read), Naive's text-to-speech when
  // Monid cannot pay for it; NOMEN_CODEAD_VOICE=naive|scratch picks one outright
  const naiveVoice: Narrator | null = ctx.naive && !ctx.naiveOut() ? { kind: "naive", naive: ctx.naive } : null;
  const want = process.env.NOMEN_CODEAD_VOICE;
  const narrator: Narrator =
    want === "scratch" ? { kind: "scratch" }
    : want === "naive" && naiveVoice ? naiveVoice
    : ctx.monid ? { kind: "eleven", monid: ctx.monid, ...(process.env.NOMEN_CODEAD_NARRATOR === "v3" ? { model: ADAM_V3.model, settings: ADAM_V3.settings } : {}) }
    : (naiveVoice ?? { kind: "scratch" });
  log(`making it: ${story.beats.length} beats, ${narrator.kind === "eleven" ? "ElevenLabs narrator" : narrator.kind === "naive" ? "Naive's text-to-speech" : "scratch narrator"}, rendering locally`);
  try {
    const made = await makeCodeAd({
      prefix: creative.id,
      story,
      product: ctx.product,
      kit: ctx.kit ?? null,
      brandName: ctx.product.name || brand?.name || "",
      site,
      narrator,
      fallbackNarrator: narrator.kind === "eleven" ? naiveVoice : null,
      files: store().files,
      dir,
      chrome: findChrome()!,
      // the format's promise: fast, 15-25 s; the narrator is sped up (at most 1.3x) toward it
      targetSeconds: Math.min(24, Math.max(15, concept.script?.total_seconds ?? 22)),
      naive: ctx.naive && !ctx.naiveOut() ? ctx.naive : null,
      log,
    });
    const fields: Record<string, unknown> = {
      status: "ready",
      final_key: made.key,
      poster_url: `/api/media/${made.posterKey}`,
      qc_score: made.qc?.score ?? null,
      cost_micro: made.spendMicro,
      error: made.notes.length || made.qc?.issues.length ? `notes: ${[...(made.qc?.issues ?? []), ...made.notes].join("; ").slice(0, 600)}` : null,
    };
    // Uploaded for posting like every other cut (production.ts cutFinal); posting retries the upload when Naive is busy.
    if (ctx.naive) {
      try {
        const fileId = await ctx.naive.uploadFile(`${creative.id}.mp4`, "video/mp4", await readFile(made.path));
        const link = await ctx.naive.fileUrl(fileId);
        Object.assign(fields, { final_file_id: fileId, final_url: link.url, final_url_expires_at: link.expires_at });
      } catch (error) {
        log(`ready; its upload to Naive failed (${error instanceof Error ? error.message : String(error)}) and is retried when it is posted`);
      }
    }
    await save("creatives", creative.id, fields);
    log(`ready, ${made.duration.toFixed(1)} s${made.qc ? `, QC ${made.qc.score}/10` : ""}, $${(made.spendMicro / 1e6).toFixed(2)} for the narrator`);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
