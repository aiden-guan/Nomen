#!/usr/bin/env node
// Records a finished Nomen campaign as a demo the camp can replay. See HELP below and docs/troy.md.

import { execFile } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";

const require = createRequire(import.meta.url);
const run = promisify(execFile);

const HELP = `Records a finished Nomen campaign as a demo the camp can replay.

  npm run demo:export -- <website or brand id> [options]

It reads the campaign from a running Nomen through the same HTTP API the camp uses, copies the
finished videos, and writes public/demo/<id>/ with an entry in public/demo/index.json. Commit
those files and deploy: /demo then replays this campaign when its website is typed (and when any
other website is typed, if it is the newest recording).

A site behind its password (SITE_PASSWORD) needs it in the environment, never on the command
line: NOMEN_SITE_PASSWORD=… npm run demo:export -- yourbrand.com --from https://your.site

Options
  --from <url>   the running Nomen to read from (default http://localhost:3000)
  --out <dir>    where recordings live (default public/demo)
  --id <slug>    the recording's folder name (default: from the domain, like monid-ai)
  --db <path>    the core's database, for the campaign's full event log
                 (default $NOMEN_DB_PATH or data/nomen.db, if present; else the API's latest 60)
  --campaign <id> record this campaign of the brand instead of its latest
  --only <ids>   record only these videos (creative ids, comma-separated). Lines about the others
                 are dropped or trimmed. A kept video remade after its first version (its concept's
                 \`previous\`) keeps its new production lines; the first version's are dropped.
`;

// --- Arguments --------------------------------------------------------------------------------

const flags = {};
const positional = [];
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (arg === "-h" || arg === "--help") {
    console.log(HELP);
    process.exit(0);
  }
  if (arg.startsWith("--")) {
    const [name, inline] = arg.slice(2).split("=", 2);
    flags[name] = inline ?? argv[++i];
  } else positional.push(arg);
}
const target = positional[0];
if (!target) {
  console.error(HELP);
  process.exit(1);
}
const from = (flags.from ?? "http://localhost:3000").replace(/\/+$/, "");
const outRoot = resolve(flags.out ?? "public/demo");

function fail(message) {
  console.error(`\n✗ ${message}\n`);
  process.exit(1);
}
const warn = (message) => console.warn(`  ! ${message}`);

// A site behind its password: sign in once and send the cookie with every request to it.
let cookie = "";
if (process.env.NOMEN_SITE_PASSWORD) {
  const response = await fetch(`${from}/api/gate`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: process.env.NOMEN_SITE_PASSWORD }) }).catch((error) =>
    fail(`Couldn't reach ${from} (${error.cause?.code ?? error.message}).`),
  );
  if (!response.ok) fail(`${from} didn't accept NOMEN_SITE_PASSWORD.`);
  cookie = (response.headers.get("set-cookie") ?? "").split(";")[0];
}
const onSite = (url) => !/^https?:/.test(url) || url.startsWith(from);

async function api(path) {
  let response;
  try {
    response = await fetch(from + path, { headers: cookie ? { cookie } : {} });
  } catch (error) {
    fail(`Couldn't reach ${from} (${error.cause?.code ?? error.message}). Start Nomen (npm run dev) or pass --from.`);
  }
  if (response.status === 401) fail(`${from} asks for its site password: set NOMEN_SITE_PASSWORD in the environment and run again.`);
  if (!response.ok) fail(`${from}${path} answered HTTP ${response.status}.`);
  return response.json();
}

// --- The campaign -----------------------------------------------------------------------------

const wanted = target.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/[/?#].*$/, "");
const listing = await api("/api/brands");
const brands = Array.isArray(listing) ? listing : (listing.brands ?? []);
const listed = brands.find((b) => b.id === target || b.domain === wanted);
if (!listed) fail(`No brand "${target}" on ${from}. Brands there: ${brands.map((b) => b.domain).join(", ") || "none"}.`);
const view = await api(`/api/brands/${encodeURIComponent(listed.id)}${flags.campaign ? `?campaign=${encodeURIComponent(flags.campaign)}` : ""}`);
if (flags.campaign && view.campaign?.id !== flags.campaign) fail(`--campaign: ${flags.campaign} is not one of ${listed.domain}'s campaigns.`);
const campaign = view.campaign;
if (!campaign) fail(`${listed.domain} has no campaign yet.`);
const only = flags.only ? new Set(String(flags.only).split(",").map((x) => x.trim()).filter(Boolean)) : null;
const finished = campaign.creatives.filter((c) => c.status === "ready" && (!only || only.has(c.id))).sort((a, b) => a.idx - b.idx);
if (only) for (const wantedId of only) if (!campaign.creatives.some((c) => c.id === wantedId)) fail(`--only: no video ${wantedId} in ${listed.domain}'s latest campaign.`);
if (!finished.length) fail(`${listed.domain}'s latest campaign has no finished videos yet (it is at ${campaign.stage}, ${campaign.status}).`);
const unfinished = campaign.creatives.filter((c) => (!only || only.has(c.id)) && c.status !== "ready").length;
if (unfinished) warn(`${unfinished} video(s) aren't finished; the recording keeps the ${finished.length} that are.`);

const id = (flags.id ?? view.brand.domain).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
if (!id) fail("Couldn't make a folder name; pass --id.");
const dir = join(outRoot, id);
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
console.log(`Recording ${view.brand.name} (${view.brand.domain}) from ${from} into ${relative(process.cwd(), dir)}/`);

// --- Media ------------------------------------------------------------------------------------

const EXT = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif", "image/svg+xml": "svg", "video/mp4": "mp4" };
const extFor = (type, fallback) => EXT[(type ?? "").split(";")[0].trim()] ?? fallback;

async function download(url, file) {
  // The cookie goes to this site only; its media may redirect to storage elsewhere.
  const response = await fetch(/^https?:/.test(url) ? url : from + url, { headers: cookie && onSite(url) ? { cookie } : {} });
  if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(file));
  return response.headers.get("content-type");
}

function ffmpegPath() {
  try {
    const bundled = require("ffmpeg-static");
    if (bundled && existsSync(bundled)) return bundled;
  } catch {
    // Not installed: try the one on PATH.
  }
  return "ffmpeg";
}

/** Saves an image URL (data:, http or a path on the source) as <name>.<ext>; returns the file name. */
async function saveImage(url, name) {
  if (url.startsWith("data:")) {
    const match = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(url);
    if (!match) return null;
    const file = `${name}.${extFor(match[1], "png")}`;
    writeFileSync(join(dir, file), match[2] ? Buffer.from(match[3], "base64") : decodeURIComponent(match[3]));
    return file;
  }
  const temp = join(dir, `${name}.download`);
  const type = await download(url, temp);
  const file = `${name}.${extFor(type, "jpg")}`;
  renameSync(temp, join(dir, file));
  return file;
}

/** A still for the theatre: the campaign's poster, else a frame a second into the video. */
async function savePoster(creative, n, video) {
  if (creative.posterUrl) {
    try {
      return await saveImage(creative.posterUrl, String(n));
    } catch (error) {
      warn(`video ${n}: couldn't fetch its poster (${error.message}); taking a frame from the video instead.`);
    }
  }
  const file = `${n}.jpg`;
  try {
    await run(ffmpegPath(), ["-loglevel", "error", "-y", "-ss", "1", "-i", join(dir, video), "-frames:v", "1", "-vf", "scale=480:-2", "-q:v", "4", join(dir, file)]);
    return file;
  } catch {
    warn(`video ${n}: no poster and no ffmpeg to take a frame; the camp will use the video itself.`);
    return null;
  }
}

const creatives = [];
for (const [i, creative] of finished.entries()) {
  const n = i + 1;
  const title = creative.concept?.title ?? `Video ${n}`;
  if (!creative.videoUrl) {
    warn(`"${title}" is ready but its video file is missing on the source; skipped.`);
    continue;
  }
  const video = `${n}.mp4`;
  try {
    await download(creative.videoUrl, join(dir, video));
  } catch (error) {
    warn(`"${title}": couldn't download the video (${error.message}); skipped.`);
    continue;
  }
  const poster = await savePoster(creative, n, video);
  const posted = campaign.posts.find((p) => p.creativeId === creative.id && p.analytics);
  const analytics = posted ? Object.fromEntries(Object.entries(posted.analytics).filter(([, v]) => typeof v === "number")) : null;
  creatives.push({
    idx: creative.idx,
    concept: creative.concept,
    caption: creative.caption ?? "",
    platforms: creative.platforms ?? [],
    qcScore: creative.qcScore ?? null,
    cost: creative.cost ?? 0,
    generation: creative.generation ?? 1,
    shots: creative.shots.map((s) => ({ n: s.n, provider: s.provider ?? null, renders: s.renders ?? 1, qc: s.qc ?? null })),
    video,
    poster,
    analytics: analytics && Object.keys(analytics).length ? analytics : null,
  });
  console.log(`  ✓ ${n}. ${title}`);
}
if (!creatives.length) fail("None of the finished videos could be copied.");

let profile = view.brand.profile ?? null;
if (profile?.logo && /^https?:/.test(profile.logo)) {
  try {
    profile = { ...profile, logo: await saveImage(profile.logo, "logo") };
  } catch {
    warn("couldn't copy the brand's logo; the replay links to it instead.");
  }
}

// --- The event log ------------------------------------------------------------------------------

// Lines that belong to the review and posting (the replay writes those as you act) or that report
// trouble the campaign recovered from.
const SKIP = /^(Stopped at|Retrying from|Opened the account connection page|Phones:|A post failed|Autopilot could not|Queued \d+ posts|Post (submitted|scheduled)|\d+ of \d+ videos are ready for review)/;

function eventsFromDatabase() {
  const path = flags.db ?? process.env.NOMEN_DB_PATH ?? (existsSync("data/nomen.db") ? "data/nomen.db" : null);
  if (!path) return null;
  try {
    const Database = require("better-sqlite3");
    const db = new Database(path, { readonly: true, fileMustExist: true });
    const rows = db.prepare("select ts, level, message from events where campaign_id = ? order by id").all(campaign.id);
    db.close();
    return rows.length ? rows : null;
  } catch (error) {
    warn(`couldn't read the event log from ${path} (${error.message}); using the API's latest 60 lines.`);
    return null;
  }
}

const start = Date.parse(campaign.createdAt);
const rows = eventsFromDatabase() ?? view.events.filter((e) => Date.parse(e.ts) >= start - 1000).reverse();
const events = recordedOnly(rows)
  .filter((e) => e.level !== "error" && !SKIP.test(e.message))
  .map((e) => ({ s: Math.max(0, Math.round((Date.parse(e.ts) - start) / 100) / 10), level: e.level, message: e.message }));

// With --only, the battle plan is the recorded videos: each a brief with its format and the
// research it rests on (its concept's `why`), and one director line naming them, in the strategy.
let strategy = campaign.strategy;
if (only && strategy?.campaign) {
  const briefs = finished.map((c) => ({
    title: c.concept?.title ?? "",
    format: c.concept?.format ?? "video",
    reference_id: c.concept?.reference?.id ?? null,
    angle: c.concept?.why ?? c.concept?.brief?.angle ?? "",
    hook_plan: c.concept?.why ?? c.concept?.hook ?? "",
    audience: c.concept?.brief?.audience ?? "",
    role: c.concept?.brief?.role ?? null,
    metric: c.concept?.brief?.metric ?? null,
  }));
  const concepts = finished.map((c) => ({ ...(c.concept ?? {}), brief: { ...(c.concept?.brief ?? {}), title: c.concept?.title ?? "" } }));
  // The objective names the formats it tests: the recorded ones, not the first plan's.
  const formats = [...new Set(finished.map((c) => c.concept?.format).filter(Boolean))];
  const goal = String(strategy.campaign.objective ?? "").split(/,?\s+by testing\b/)[0].replace(/\.$/, "");
  const objective = goal ? `${goal}, by testing ${formats.length} formats the research backs: ${formats.join(", ")}.` : strategy.campaign.objective;
  strategy = { ...strategy, campaign: { ...strategy.campaign, objective, briefs, concepts } };
  const plan = events.find((e) => /^Campaign "/.test(e.message)) ?? events.find((e) => /creative director is choosing/i.test(e.message)) ?? events.find((e) => /^Reference study ready|^Research done/.test(e.message));
  // The first sentence of each reason ("211.6x" and "1.8K" are not sentence ends).
  const reason = (c) => (c.concept?.why ?? "").split(/\.\s/)[0].replace(/\.$/, "").trim();
  const line = `The creative director chose ${finished.length} video${finished.length === 1 ? "" : "s"}, each on what the research found: ${finished.map((c) => `"${c.concept?.title}" (${c.concept?.format ?? "video"}${reason(c) ? `: ${reason(c)}` : ""})`).join("; ")}`;
  if (plan) events.push({ s: Math.round((plan.s + 0.5) * 10) / 10, level: "info", message: line });
  events.sort((a, b) => a.s - b.s);
}

/**
 * With --only, the log as if the campaign had made just those videos: a line about other videos
 * loses their part (or goes, if that was all of it). A kept video's first version (its concept's
 * `previous`, before a remake) is renamed in the plan and script lines, and its own production
 * lines (everything about it after the scripts were ready) are dropped for the remake's.
 */
function recordedOnly(lines) {
  if (!only) return lines;
  const kept = campaign.creatives.filter((c) => only.has(c.id));
  // A left-out video goes by its title and, if it was remade, by its first version's title too.
  const dropped = campaign.creatives.filter((c) => !only.has(c.id)).flatMap((c) => [c.concept?.title, c.concept?.previous?.title]).filter(Boolean);
  const scriptsAt = lines.find((l) => /^Scripts ready/.test(l.message))?.ts ?? null;
  const out = [];
  for (const line of lines) {
    let message = line.message;
    let firstVersion = false;
    for (const c of kept) {
      const before = c.concept?.previous?.title;
      if (before && before !== c.concept?.title && message.includes(`"${before}"`)) {
        if (scriptsAt && Date.parse(line.ts) > Date.parse(scriptsAt)) firstVersion = true;
        message = message.split(`"${before}"`).join(`"${c.concept.title}"`);
      }
    }
    if (firstVersion) continue;
    // The plan and script lines describe the first version: give them the remake's format and script.
    for (const c of kept) {
      const title = c.concept?.title;
      if (!c.concept?.previous || !title || !message.includes(`"${title}"`)) continue;
      if (c.concept.previous.format && c.concept.format) message = message.split(`"${title}" (${c.concept.previous.format})`).join(`"${title}" (${c.concept.format})`);
      const script = c.concept.script;
      if (/^Scripts ready/.test(message) && script?.total_seconds) {
        const critic = script.review?.score ? `, critic ${script.review.score}/10` : "";
        message = message.replace(new RegExp(`"${title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}" [\\d.]+s(, critic \\d+/10)?`), `"${title}" ${script.total_seconds}s${critic}`);
      }
    }
    // The opening line counts the videos the recording has.
    message = message.replace(/^Campaign started: \d+ videos?/, `Campaign started: ${kept.length} video${kept.length === 1 ? "" : "s"}`);
    const names = (title) => message.includes(`"${title}"`);
    const keeps = kept.some((c) => c.concept?.title && names(c.concept.title));
    const others = dropped.filter(names);
    if (others.length && !keeps) continue;
    for (const title of others) message = withoutTitle(message, title);
    out.push({ ...line, message });
  }
  return out;
}

/** A line listing videos (`"A" (format), "B" (format)` or `"A" …; "B" …`) without one of them. */
export function withoutTitle(message, title) {
  const quoted = `"${title}"`;
  const at = message.indexOf(quoted);
  if (at < 0) return message;
  const rest = message.slice(at + quoted.length);
  const next = rest.search(/[,;] "/);
  if (next >= 0) return message.slice(0, at) + rest.slice(next + 2);
  return message.slice(0, at).replace(/[,;]\s*$/, "").trimEnd();
}

// --- Write it ---------------------------------------------------------------------------------

const research = campaign.research;
const script = {
  version: 1,
  recorded: true,
  recordedAt: new Date().toISOString(),
  brand: { name: view.brand.name, domain: view.brand.domain, url: view.brand.url, profile },
  options: only && campaign.options ? { ...campaign.options, concepts: finished.length } : campaign.options,
  estimateUsd: campaign.estimateUsd ?? null,
  plan: campaign.plan,
  research: research
    ? { videos: research.videos?.length ?? 0, ads: research.ads?.length ?? 0, reddit: research.reddit?.length ?? 0, keywords: research.seo?.keywords?.length ?? 0, domainRating: research.seo?.domain_rating ?? null }
    : null,
  runs: campaign.runs.map((r) => ({ key: r.key, phase: r.phase, provider: r.provider, status: r.status === "done" ? "done" : "failed", error: r.status === "done" ? null : (r.error ?? "no result"), cost: r.cost ?? 0 })),
  style: campaign.style ? { slug: campaign.style.slug ?? null, version: campaign.style.version ?? null, samples: campaign.style.samples?.length ?? 0 } : null,
  strategy,
  creatives,
  events,
  spend: campaign.spend,
};
writeFileSync(join(dir, "script.json"), `${JSON.stringify(script, null, 2)}\n`);

const indexFile = join(outRoot, "index.json");
const index = existsSync(indexFile) ? JSON.parse(readFileSync(indexFile, "utf8")) : { version: 1, scripts: [] };
index.scripts = [{ id, domain: view.brand.domain, name: view.brand.name }, ...(index.scripts ?? []).filter((s) => s.id !== id && s.domain !== view.brand.domain)];
writeFileSync(indexFile, `${JSON.stringify(index, null, 2)}\n`);

const bytes = creatives.reduce((sum, c) => sum + statSync(join(dir, c.video)).size + (c.poster ? statSync(join(dir, c.poster)).size : 0), 0);
console.log(`\nWrote ${creatives.length} videos (${(bytes / 1e6).toFixed(1)} MB), ${events.length} event lines and script.json.`);
if (bytes > 60e6) warn("that's a lot to commit; consider shorter or smaller renders.");
console.log(`Typing ${view.brand.domain} on /demo now replays this campaign. Commit public/demo and deploy to publish it.\n`);
