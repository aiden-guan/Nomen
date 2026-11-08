import { LANDS, landFor, type StationId } from "../scenes/layout";
import { type DemoScript, timeline } from "./demo";

// The presenter's tour of a replayed campaign: one step per part of the work, from the website
// going in to the posts coming back. Each step moves the demo clock to its part, opens the station
// that does it (or plays one of the finished videos) and says in a sentence or two what happens
// there, every number read from the recording. → and ← walk it (see Camp.tsx).

export type TourStep = {
  key: string;
  title: string;
  body: string;
  /** The clock goes to here when the step opens (forward only; going back rewinds to it). Unset: it stays. */
  at?: number;
  /** And runs until here, then waits for the next step. "end": it runs to the end of the replay. */
  hold: number | "end";
  /** Seconds the clock runs after the step opens, for a step whose time depends on when it opens. */
  run?: number;
  /** The station whose panel opens; null closes any. */
  station: StationId | null;
  /** "world" pulls the camera back to the camp and every land the scouts ride to. */
  camera?: "world";
  /** A part of the open panel to scroll to: "concepts" (the war tent's, with their reasons). */
  focus?: string;
  /** A finished video to play, by its index in the campaign. */
  video?: number;
  /** Approve every video and post them when the step opens. */
  post?: boolean;
};

/** Seconds past a stage's end that a step waits at, so what the stage made is on screen. */
const SHOWN = 0.4;

const count = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1).replace(/\.0$/, "")}M` : n >= 1e3 ? `${Math.round(n / 1e3)}K` : String(n));
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** "a, b and c". */
function list(items: string[]) {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** "a code ad", "an ad", "a one-to-one clone": the article for a format's name. */
const article = (format: string) => (/^[aeiou]/i.test(format) && !/^one\b/i.test(format) ? `an ${format}` : `a ${format}`);

const NUMBER = ["", "one", "two", "three", "four", "five", "six"];

/** "a code ad (3D animation) and three brainrot meme videos": the formats, each counted once. */
function formatList(formats: string[]) {
  const counts = new Map<string, number>();
  for (const format of formats) counts.set(format, (counts.get(format) ?? 0) + 1);
  return list([...counts].map(([format, n]) => (n === 1 ? article(format) : `${NUMBER[n] ?? n} ${format} videos`)));
}

/** How a video of this format is made, in a phrase. */
function making(format: string, brand: string) {
  if (/code ad|3d|animation/i.test(format)) return "the 3D ad is animated in code";
  if (/brainrot|meme/i.test(format)) return "the meme is generated shot by shot and cut";
  if (/faceless/i.test(format)) return `the faceless clone keeps its original's footage and sound, with ${brand} in the caption`;
  if (/remake|clone/i.test(format)) return "the remake is filmed again with an AI presenter, line for line";
  return `the ${format} is filmed and cut`;
}

/** The research's format checks ("3D simulation shorts are breaking out"), from the scouts' lines. */
function formatChecks(script: DemoScript) {
  return script.events
    .map((e) => /^Scout: format check, ([^:]+):/.exec(e.message)?.[1]?.trim())
    .filter((found): found is string => Boolean(found));
}

export function tourSteps(script: DemoScript): TourStep[] {
  const tl = timeline(script);
  const brand = script.brand.name;
  const steps: TourStep[] = [];

  steps.push({
    key: "start",
    title: `${script.brand.domain} goes in`,
    body: "A website is the only input. From here the agents run the whole campaign themselves: research, strategy, scripts, videos and posting.",
    at: 0,
    hold: 3,
    station: null,
  });

  const lands = [...new Set(script.runs.map((run) => landFor(run.key)))];
  const named = LANDS.filter((land) => lands.includes(land.id)).map((land) => (land.id === "site" ? "the brand's own site" : land.id === "metaads" ? "the Meta Ad Library" : land.name));
  steps.push({
    key: "scouts",
    title: "The scouts fan out",
    body: `They ride to ${plural(lands.length, "source")} at once: ${list(named)}. ${plural(script.runs.length, "research run")} in all.`,
    at: 3,
    hold: tl.research[1] - 1,
    station: null,
    camera: "world",
  });

  const research = script.research;
  if (research) {
    const checks = formatChecks(script);
    steps.push({
      key: "findings",
      title: "What they brought back",
      body: `${count(research.videos)} top videos, ${plural(research.ads, "live ad")}, ${plural(research.reddit, "Reddit thread")} and ${plural(research.keywords, "keyword")}.${checks.length ? ` Format checks found that ${list(checks)}.` : ""}`,
      at: tl.research[1],
      hold: tl.research[1] + SHOWN,
      station: "scouts",
    });
  }

  if (tl.style && script.style) {
    steps.push({
      key: "oracle",
      title: "The format study",
      body: `The oracle breaks the ${plural(script.style.samples, "best outlier video")} down beat by beat (transcript, cuts and frames), so each new video copies what made its original work.`,
      at: tl.style[0],
      hold: tl.style[1] + SHOWN,
      station: "oracle",
    });
  }

  const videos = script.creatives.slice().sort((a, b) => a.idx - b.idx);
  const formats = videos.map((c) => c.concept?.format ?? "video");
  steps.push({
    key: "tent",
    title: "The creative director's plan",
    body: `The director picks ${plural(videos.length, "video")}, each one backed by evidence from the research: ${formatList(formats)}.`,
    at: tl.strategy[0],
    hold: tl.strategy[1] + SHOWN,
    station: "tent",
    focus: "concepts",
  });

  steps.push({
    key: "workshop",
    title: "The workshop",
    body: `Each video is made its own way: ${list([...new Set(formats.map((f) => making(f, brand)))])}. Quality control checks every one.`,
    at: tl.production[0],
    hold: tl.review - 0.5,
    station: "workshop",
  });

  videos.forEach((creative, i) => {
    const concept = creative.concept;
    const why = concept?.why?.trim();
    steps.push({
      key: `video-${creative.idx}`,
      title: `Video ${i + 1}: ${concept?.title ?? "untitled"}`,
      body: `${capital(concept?.format ?? "video")}.${why ? ` ${why}` : ""}`,
      at: tl.review,
      hold: tl.review,
      station: "theatre",
      video: creative.idx,
    });
  });

  const platforms = [...new Set(videos.flatMap((c) => c.platforms ?? []))].map((p) => ({ tiktok: "TikTok", instagram: "Instagram", youtube: "YouTube" })[p] ?? capital(p));
  steps.push({
    key: "post",
    title: "Approve and post",
    body: `One click approves them all, and they go out to the brand's own ${platforms.length ? list(platforms) : "accounts"}, labeled AI-generated: all at once, or one a day.`,
    hold: 0,
    run: 6,
    station: "agora",
    post: true,
  });

  const bench = research?.benchmark;
  steps.push({
    key: "battle",
    title: "Into battle",
    body: `Every video sails as a company against ${script.plan?.competitors?.[0]?.name ?? "the rival"}'s city. Once its posts have numbers, it fights the category's top videos${bench ? ` (${count(bench.views)} median views, ${((bench.likes / Math.max(1, bench.views)) * 100).toFixed(1)}% likes per view)` : ""}: scored on its real likes per view, never made up.`,
    hold: "end",
    station: null,
  });

  steps.push({
    key: "loop",
    title: "Then it goes again",
    body: "With autopilot on, the next campaign starts on its own cadence and weekly budget, and the director plans it from how these posts did.",
    hold: "end",
    station: null,
  });

  return steps;
}
