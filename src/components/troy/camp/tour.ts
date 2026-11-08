import { runLabel } from "../scenes/derive";
import { LAND, LANDS, type LandId, landFor, type StationId } from "../scenes/layout";
import { against, type DemoScript, illustrativeNumbers, roundLesson, scoutWindow, timeline } from "./demo";

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
  /** A soldier to follow: the camera rides along with him and his card opens. */
  agent?: string;
  /** The step plays autopilot's next campaign (the loop's second round); its times are that campaign's. */
  round?: boolean;
};

/** The scout the tour rides along with: TikTok's if he rides, else the busiest land's. */
const FOLLOW_LANDS: LandId[] = ["tiktok", "instagram", "youtube", "reddit"];

function followScout(script: DemoScript) {
  const lands = [...new Set(script.runs.map((run) => landFor(run.key)))];
  const busiest = [...lands].sort((a, b) => script.runs.filter((r) => landFor(r.key) === b).length - script.runs.filter((r) => landFor(r.key) === a).length);
  const land = FOLLOW_LANDS.find((l) => lands.includes(l)) ?? busiest.find((l) => l !== "site");
  const window = land ? scoutWindow(script, land) : null;
  return land && window ? { land, ...window } : null;
}

/** Seconds past a stage's end that a step waits at, so what the stage made is on screen. */
const SHOWN = 0.4;

const count = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1).replace(/\.0$/, "")}M` : n >= 1e3 ? `${Math.round(n / 1e3)}K` : String(n));
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const plural = (n: number, word: string, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;

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
  if (/brainrot|meme/i.test(format)) return "the meme is generated shot by shot";
  if (/faceless/i.test(format)) return `the faceless clone keeps its original's footage and sound, with ${brand} in the caption`;
  if (/remake|clone/i.test(format)) return "the remake is filmed again with an AI presenter, line for line";
  if (/organic|talking head/i.test(format)) return "the organic one is an original on the research's best formula, with an AI creator";
  return `the ${format} is filmed and cut`;
}

/** A brief's real-creator casting, when it has one (creative/casting.ts, in the concept). */
type Cast = { pick?: { handle: string } | null; reviews: Array<{ creator: string; approve: boolean; score?: number }> };
const castOf = (concept: unknown) => {
  const cast = (concept as { casting?: Cast } | null)?.casting;
  return cast?.pick ? (cast as Cast & { pick: { handle: string } }) : null;
};

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
  // One scout, followed all the way: out to his land and back with the case.
  const scout = followScout(script);
  const rideAt = scout ? Math.max(3.5, scout.start - 0.3) : null;
  steps.push({
    key: "scouts",
    title: "The scouts fan out",
    body: `They ride to ${plural(lands.length, "source")} at once: ${list(named)}. ${plural(script.runs.length, "research run")} in all.`,
    at: 3,
    hold: rideAt ?? tl.research[1] - 1,
    station: null,
    camera: "world",
  });

  if (scout && rideAt !== null) {
    const name = LAND[scout.land].name;
    const labels = [...new Set(scout.runs.map((key) => runLabel(key)))];
    steps.push({
      key: "agent",
      title: `Ride along with the ${name} scout`,
      body: `Every soldier here is an agent with one job. This one rides to ${name} for ${plural(scout.runs.length, "search", "searches")} (${list(labels.slice(0, 4).map((label) => label.replace(new RegExp(`^${name}: `), "")))}${labels.length > 4 ? " and more" : ""}) and brings them back in a scroll case for the strategist. His card says what he is doing right now; click any soldier to follow it the same way.`,
      at: rideAt,
      hold: Math.min(scout.back + 1, tl.research[1] - 1),
      station: null,
      agent: `scout:${scout.land}`,
    });
  }

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
      title: "Studying the viral references",
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
    body: `Each video is made its own way: ${[...new Set(formats.map((f) => making(f, brand)))].join("; ")}. Quality control checks every one.`,
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

  // The same briefs cast to real creators, when the recording has their castings.
  const cast = videos.map((c) => castOf(c.concept)).filter((c): c is NonNullable<ReturnType<typeof castOf>> => c !== null);
  if (cast.length) {
    const byCreator = new Map<string, number[]>();
    for (const c of cast) {
      const score = c.reviews.filter((r) => r.creator === c.pick.handle).at(-1)?.score;
      byCreator.set(c.pick.handle, [...(byCreator.get(c.pick.handle) ?? []), ...(score ? [score] : [])]);
    }
    const briefsFor = (n: number) => (n > 1 ? ` for ${NUMBER[n] ?? n} briefs` : "");
    const picks = [...byCreator].map(([handle, scores]) => {
      const counted = cast.filter((c) => c.pick.handle === handle).length;
      const same = scores.length > 0 && scores.every((s) => s === scores[0]);
      return `@${handle}${scores.length ? ` (${same ? scores[0] : scores.join(", ")}/10)` : ""}${briefsFor(counted)}`;
    });
    const turnedDown = cast.reduce((n, c) => n + c.reviews.filter((r) => !r.approve).length, 0);
    steps.push({
      key: "creators",
      title: "Or hand them to real creators",
      body: `The same briefs can go to people who already make these videos. A client-taste agent playing ${brand} vets each creator${turnedDown ? `, turned down ${plural(turnedDown, "of them", "of them")}` : ""} and approved ${list(picks)}. Their outreach messages are drafted and wait for you to send.`,
      at: tl.review,
      hold: tl.review,
      station: "theatre",
      focus: "creators",
    });
  }

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
  const scored = illustrativeNumbers(script)
    ? "In a live campaign it is scored on its real likes per view; this replay's videos weren't posted, so the numbers here are illustrative."
    : "Scored on its real likes per view, never made up.";
  steps.push({
    key: "battle",
    title: "Into battle",
    body: `Every video sails as a company against ${script.plan?.competitors?.[0]?.name ?? "the rival"}'s city. Once its posts have numbers, it fights the category's top videos${bench ? ` (${count(bench.views)} median views, ${((bench.likes / Math.max(1, bench.views)) * 100).toFixed(1)}% likes per view)` : ""}. ${scored}`,
    hold: "end",
    station: null,
  });

  // The loop closes: autopilot starts the next campaign from these posts, and the scouts ride again.
  const lesson = roundLesson(script);
  steps.push({
    key: "loop",
    title: "Then it goes again: campaign 2",
    body: `With autopilot on, the next campaign starts on its own cadence and weekly budget, and the director plans it from how these posts did${
      lesson ? `: "${lesson.best.title}" led, ${against(lesson.best.ratio)} the top videos, and "${lesson.worst.title}" trailed, so more ${lesson.best.format}${lesson.illustrative ? " (illustrative numbers)" : ""}` : ""
    }. The army comes home and the scouts are already riding out again: research, plan, videos, posts, numbers, and round again.`,
    hold: tl.research[1] - 1,
    station: null,
    camera: "world",
    round: true,
  });

  return steps;
}
