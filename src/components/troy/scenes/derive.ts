import type { BrandView, CampaignView, CreativeView, RunView } from "../api";
import type { Act } from "../engine/jobs";
import { LOOK } from "../engine/models/soldier";
import { type BattlePlan, deriveBattle, outcomeOf, shipsFor } from "./battle";
import { BERTH_DIR, homeBerth, inShip, LAND, type LandId, landFor, landRuns, SHORE_ENTRY, STATION, type StationId } from "./layout";
import { DESK_SLOTS, EDITOR_OFFSET, SPOTS, WATCH_DROP, type Waypoint } from "./stations";

// From the campaign the core track reports to what the camp shows: each station's state and
// status line, and every agent's post and activity. Pure, so it is easy to test.

export type StationState = "waiting" | "working" | "done" | "failed" | "skipped" | "yours";

export type StationPlan = {
  id: StationId;
  state: StationState;
  /** One short line about what the station is doing right now. */
  status: string;
  /** 0..1 when there is a measurable amount of work. */
  progress: number | null;
};

export type AgentPlan = {
  /** Stable across updates, so the scene can move one figure instead of replacing it. */
  id: string;
  station: StationId;
  role: string;
  /** What this agent is doing, in words (for the station panel). */
  task: string;
  look: number;
  act: Act;
  /** Post on the island, relative to the island centre. */
  x: number;
  y: number;
  z: number;
  dir: number;
  sort?: number;
  /** Points to pass on the way to the post (up a ladder, onto a step), relative to the island. */
  via?: Waypoint[];
  /** Out of the camp (a scout on a run): ride out to its land and gather there. */
  away?: boolean;
  /** Back from a run: rides in, and carries the scroll case to the basket (or comes back empty). */
  returning?: "scroll" | "empty";
  /** A soldier of the agora's army: his company (index into the battle's), his place in it, his arm. */
  army?: { company: number; rank: number; file: number; role: "hoplite" | "archer" };
  state: "idle" | "working" | "done" | "failed";
};

export type DeskPlan = { slot: number; creativeId: string; state: 0 | 1 | 2 | 3; title: string };

export type CampPlan = {
  stations: Record<StationId, StationPlan>;
  agents: AgentPlan[];
  desks: DeskPlan[];
  /** Variant overrides for props with a key in PROPS (basket fill, easel paint, reels, tv). */
  props: Record<string, number>;
  /** Finished videos to show on the theatre screen. */
  /** Finished videos for the theatre screen: a still if there is one, else the video itself. */
  posters: Array<{ creativeId: string; url: string | null; video: string | null; title: string }>;
  tvOn: boolean;
  /** The battle below the agora (scenes/battle.ts). */
  battle: BattlePlan;
};

const ORDER: StationId[] = ["scouts", "oracle", "tent", "workshop", "theatre", "agora"];

export const RUN_LABELS: Record<string, string> = {
  brand: "Brand profile",
  site: "Website",
  similar: "Similar sites",
  seo_rating: "Domain rating",
  seo_keywords: "Search keywords",
  tiktok_brand: "TikTok: the brand",
  tiktok_0: "TikTok: category",
  tiktok_1: "TikTok: category",
  reels: "Instagram Reels",
  shorts: "YouTube Shorts",
  tiktok_ads: "TikTok ads",
  meta_ads_brand: "Meta ads: the brand",
  meta_ads_0: "Meta ads: competitor",
  meta_ads_1: "Meta ads: competitor",
  reddit: "Reddit threads",
  aeo_chatgpt: "ChatGPT answer",
  aeo_perplexity: "Perplexity answer",
};

export function runLabel(key: string) {
  return RUN_LABELS[key] ?? key.replace(/_/g, " ");
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Which station a pipeline stage belongs to. */
export function stationOf(stage: string): StationId {
  const index = ["research", "style", "strategy", "production", "review", "live"].indexOf(stage);
  return ORDER[Math.max(0, index)];
}

/**
 * The station that has the work now. While posts go out the core keeps the stage at "review", but
 * the review is over by then: the agora has the work.
 */
function currentIndex(campaign: CampaignView) {
  return campaign.status === "publishing" ? 5 : Math.max(0, campaign.stageIndex);
}

/** The station the campaign is at (for the top bar and for following it on narrow screens). */
export function activeStation(campaign: CampaignView | null): StationId {
  return campaign ? ORDER[currentIndex(campaign)] : "scouts";
}

function stationState(campaign: CampaignView | null, index: number): StationState {
  if (!campaign) return "waiting";
  const current = currentIndex(campaign);
  if (index === 1 && current > 1 && !campaign.style) return "skipped";
  if (index < current) return "done";
  if (index > current) return "waiting";
  if (campaign.status === "failed") return "failed";
  if (campaign.status === "review") return "yours";
  if (campaign.status === "live") return index === 5 ? "working" : "done";
  return "working";
}

export function derive(view: BrandView | null): CampPlan {
  const campaign = view?.campaign ?? null;
  const states = ORDER.map((_, i) => stationState(campaign, i));
  const creatives = (campaign?.creatives ?? []).slice().sort((a, b) => a.idx - b.idx);
  const ready = creatives.filter((c) => c.status === "ready");
  const approved = ready.filter((c) => c.approved);
  const runs = campaign?.runs ?? [];
  const runsDone = runs.filter((r) => r.status === "done").length;
  const runsOver = runs.filter((r) => r.status === "done" || r.status === "failed").length;

  const stations = {} as Record<StationId, StationPlan>;
  const set = (id: StationId, status: string, progress: number | null = null) => {
    stations[id] = { id, state: states[ORDER.indexOf(id)], status, progress };
  };

  // Scouts.
  {
    const state = states[0];
    const pack = campaign?.research;
    if (state === "waiting") set("scouts", "Waiting for orders");
    else if (state === "failed") set("scouts", campaign?.error ?? "Research stopped");
    else if (state === "working") {
      const planning = runs.length > 0 && runs.every((r) => r.phase === "A") && runsOver === runs.length;
      set("scouts", runs.length === 0 ? "Setting out" : planning ? "Planning the next sweep" : `${runsDone} of ${plural(runs.length, "source")} in`, runs.length ? runsOver / runs.length : 0);
    } else {
      const parts = pack ? [plural(pack.videos.length, "video"), plural(pack.ads.length, "ad"), plural(pack.reddit.length, "thread")] : [plural(runsDone, "source")];
      set("scouts", parts.join(" · "), 1);
    }
  }

  // Oracle: the reference study (product brief, site screenshots, relevance screen, breakdowns).
  const study = studyStep(campaign);
  {
    const state = states[1];
    if (state === "working") set("oracle", study?.status ?? "Studying the top videos", study?.progress ?? null);
    else if (state === "skipped") set("oracle", "Skipped this time");
    else if (state === "done") set("oracle", campaign?.study?.studied ? `${plural(campaign.study.studied, "viral video")} broken down` : "Format learned", 1);
    else if (state === "failed") set("oracle", campaign?.error ?? "Stopped");
    else set("oracle", "Waiting for the scouts");
  }

  // War tent: the creative director's briefs, then the script room writes each video.
  const room = scriptRoom(campaign);
  {
    const state = states[2];
    const strategy = campaign?.strategy;
    if (state === "working") set("tent", room ? `Script room: ${room.written} of ${plural(room.total, "script")}` : `Writing ${plural(campaign?.options.concepts ?? 0, "concept")}`, room ? room.written / Math.max(1, room.total) : null);
    else if (state === "done" && strategy) set("tent", `“${strategy.campaign.name}”`, 1);
    else if (state === "failed") set("tent", campaign?.error ?? "Stopped");
    else set("tent", "Waiting for the research");
  }

  // Workshop.
  {
    const state = states[3];
    const total = creatives.length || campaign?.options.concepts || 0;
    if (state === "working" || state === "failed") {
      const shots = creatives.flatMap((c) => c.shots);
      const rendering = shots.filter((s) => s.status === "rendering").length;
      const checking = shots.filter((s) => s.status === "rendered").length;
      const framing = shots.some((s) => s.status === "pending");
      // Faceless videos and finished shots: the screens, the voice-over and the edit are left.
      const doing = rendering ? `${plural(rendering, "shot")} rendering` : checking ? `checking ${plural(checking, "shot")}` : framing ? "painting first frames" : "building screens and cutting";
      set("workshop", state === "failed" ? campaign?.error ?? "Stopped" : `${ready.length} of ${total} ready · ${doing}`, total ? ready.length / total : 0);
    } else if (state === "done" || state === "yours") set("workshop", `${plural(ready.length, "video")} ready`, 1);
    else set("workshop", "Waiting for the strategy");
  }

  // Theatre.
  {
    const state = states[4];
    if (state === "yours") set("theatre", `${ready.length} to review · ${approved.length} approved`, ready.length ? approved.length / ready.length : 0);
    else if (state === "done") set("theatre", `${plural(approved.length, "video")} approved`, 1);
    else if (state === "failed") set("theatre", campaign?.error ?? "Stopped");
    else set("theatre", ready.length ? `${plural(ready.length, "video")} ready` : "Waiting for the cut");
  }

  // Agora.
  {
    const posts = campaign?.posts ?? [];
    const posted = posts.filter((p) => p.status === "posted").length;
    const scheduled = posts.filter((p) => p.status === "scheduled" || p.status === "pending" || p.status === "processing").length;
    if (campaign?.status === "publishing") set("agora", `Posting · ${posted} out, ${scheduled} queued`, posts.length ? posted / posts.length : 0);
    else if (campaign?.status === "live") set("agora", scheduled ? `${posted} posted · ${scheduled} scheduled` : `${plural(posted, "video")} posted`, posts.length ? posted / posts.length : 1);
    else set("agora", "Waiting for your approval");
    // Live with posts still on the calendar is still work; everything out is done.
    if (campaign?.status === "publishing" || campaign?.status === "live") stations.agora.state = campaign.status === "live" && !scheduled ? "done" : "working";
  }

  // --- Agents --------------------------------------------------------------------------------
  // Everyone the campaign will need is in the camp from the start (they march in with the column)
  // and stays: they walk between their posts and their places at rest, so nobody pops in or out.
  // Only scouts come and go, one per research source.
  const agents: AgentPlan[] = [];
  const scouting = states[0] === "working";
  agents.push({
    id: "lookout",
    station: "scouts",
    role: "Lookout",
    task: scouting ? "Watching the scouts come and go" : "On watch",
    look: 0,
    act: scouting ? "lookout" : "stand",
    ...SPOTS.lookout,
    via: SPOTS.lookoutClimb,
    sort: 1,
    state: scouting ? "working" : "idle",
  });
  agents.push({
    id: "courier",
    station: "scouts",
    role: "Courier",
    task: "Rides each finished piece of work on to the next station",
    look: 3,
    act: "stand",
    ...SPOTS.courier,
    z: 0,
    state: "idle",
  });
  // One scout per land: the website or API its sources are fetched from (TikTok, Reddit...).
  let queued = 0;
  const lands = [...new Set(runs.map((run) => landFor(run.key)))];
  lands.forEach((land, i) => agents.push(scoutPlan(land, landRuns(runs, land), i, () => queued++)));

  const battle = deriveBattle(view);
  agents.push(...armyPlans(battle));

  const style = states[1];
  agents.push({
    id: "watcher",
    station: "oracle",
    role: "Oracle",
    task:
      style === "working"
        ? (study?.task ?? "Watching the best short videos in the category and writing down why they work")
        : style === "done"
          ? campaign?.study?.studied
            ? `Broke down ${plural(campaign.study.studied, "viral video")} beat by beat`
            : "Wrote the format study"
          : "Resting",
    look: 4,
    act: style === "working" ? "watch" : style === "done" ? "stand" : "sit",
    ...SPOTS.watcher,
    via: SPOTS.watcherSteps,
    state: style === "working" ? "working" : style === "done" ? "done" : "idle",
  });

  const strat = states[2];
  // With the creative engine the strategist is the creative director, and the scribe the script room.
  const directing = strat === "working" && !room;
  agents.push({
    id: "general",
    station: "tent",
    role: campaign?.study ? "Director" : "Strategist",
    task:
      strat === "working"
        ? room
          ? "Picked which viral video each of ours remakes; the script room has the briefs"
          : campaign?.study
            ? "Choosing which viral video each of ours remakes, and how"
            : "Writing the brief, the search plan and the concepts"
        : strat === "done"
          ? "Signed off the battle plan"
          : "Waiting for the scouts",
    look: -1,
    act: directing ? "point" : "stand",
    ...SPOTS.general,
    z: 0,
    state: strat === "working" ? "working" : strat === "done" ? "done" : "idle",
  });
  agents.push({
    id: "scribe",
    station: "tent",
    role: room ? "Script room" : "Scribe",
    task: strat === "working" ? (room ? `Writing the remakes line by line; a critic scores each (${room.written} of ${room.total} done)` : "Taking down every shot") : "Standing by",
    look: 5,
    act: strat === "working" ? "read" : "stand",
    ...SPOTS.scribe,
    z: 0,
    state: strat === "working" ? "working" : "idle",
  });

  // One desk and one editor per planned video, set up before the concepts arrive.
  const desks: DeskPlan[] = [];
  const planned = campaign ? Math.min(DESK_SLOTS.length, Math.max(creatives.length, campaign.options.concepts ?? 0)) : 0;
  for (let slot = 0; slot < planned; slot++) {
    const creative = creatives[slot] as CreativeView | undefined;
    const state = !creative ? 0 : creative.status === "producing" ? 1 : creative.status === "ready" ? 2 : creative.status === "failed" ? 3 : 0;
    desks.push({ slot, creativeId: creative?.id ?? "", state, title: creative?.concept?.title ?? `Video ${slot + 1}` });
    const desk = DESK_SLOTS[slot];
    agents.push({
      id: `editor:${slot}`,
      station: "workshop",
      role: "Editor",
      task: creative ? editorTask(creative) : "Waiting at the desk for a concept from the war tent",
      look: slot % 6,
      act: state === 1 ? "type" : "sit",
      x: desk.x + EDITOR_OFFSET.x,
      y: desk.y + EDITOR_OFFSET.y,
      z: 0,
      dir: EDITOR_OFFSET.dir,
      state: state === 1 ? "working" : state === 2 ? "done" : state === 3 ? "failed" : "idle",
    });
  }
  const producing = creatives.filter((c) => c.status === "producing");
  const framing = producing.some((c) => c.shots.some((s) => s.status === "pending"));
  agents.push({
    id: "painter",
    station: "workshop",
    role: "Painter",
    task: framing ? "Painting the first frame of each shot so the product looks right" : "Waiting at the easel for shots to paint",
    look: 2,
    act: framing ? "paint" : "stand",
    ...SPOTS.painter,
    z: 0,
    state: framing ? "working" : "idle",
  });
  const checkingIndex = creatives.findIndex((c) => c.shots.some((s) => s.status === "rendered"));
  const checked = checkingIndex >= 0 && checkingIndex < DESK_SLOTS.length ? DESK_SLOTS[checkingIndex] : null;
  agents.push({
    id: "inspector",
    station: "workshop",
    role: "Inspector",
    task: checked ? "Checking every frame for warped hands, wrong labels and garbled text" : "Waiting for a rendered shot to check",
    look: 3,
    act: checked ? "inspect" : "stand",
    ...(checked ? { x: checked.x + 9, y: checked.y - 2, dir: 3 } : SPOTS.inspector),
    z: 0,
    state: checked ? "working" : "idle",
  });

  // The audience waits by the theatre and takes its seats when there is a cut to watch.
  const reviewing = (campaign?.stageIndex ?? 0) >= 4 && ready.length > 0;
  const seated = reviewing ? Math.min(SPOTS.audience.length, Math.max(2, ready.length)) : 0;
  SPOTS.audience.forEach((spot, i) => {
    const base = { id: `audience:${i}`, station: "theatre" as const, role: "Audience", look: (i + 2) % 6 };
    if (i < seated) {
      agents.push({ ...base, task: "Watching the cut", act: "watch", x: spot.x, y: spot.y, z: (spot.z ?? 0) - WATCH_DROP + 1.2, dir: spot.dir, sort: 0, via: [{ x: spot.x + 7, y: spot.y + 7, z: 0 }], state: "working" });
    } else {
      const rest = SPOTS.audienceRest[i];
      agents.push({ ...base, task: reviewing ? "Saving a seat" : "Waiting for the first cut", act: "stand", x: rest.x, y: rest.y, z: 0, dir: rest.dir, state: "idle" });
    }
  });

  const posts = campaign?.posts ?? [];
  const onTheWay = posts.some((p) => p.status === "scheduled" || p.status === "pending" || p.status === "processing");
  const posting = campaign?.status === "publishing" || (campaign?.status === "live" && onTheWay);
  const allOut = campaign?.status === "live" && !onTheWay;
  agents.push({
    id: "herald",
    station: "agora",
    role: "Herald",
    task: posting ? "Announcing each video on the brand's own accounts" : allOut ? "Announced every video" : "Waiting for approved videos",
    look: 1,
    act: posting ? "herald" : "stand",
    ...SPOTS.herald,
    via: SPOTS.heraldSteps,
    sort: 1,
    state: posting ? "working" : allOut ? "done" : "idle",
  });

  // --- Props ---------------------------------------------------------------------------------
  const totalShots = producing.reduce((n, c) => n + c.shots.length, 0);
  const framed = producing.reduce((n, c) => n + c.shots.filter((s) => s.status !== "pending").length, 0);
  const props: Record<string, number> = {
    basket: runs.length ? Math.round((runsDone / runs.length) * 7) : 0,
    easel: framing ? Math.max(1, Math.min(3, Math.round((framed / Math.max(1, totalShots)) * 4))) : ready.length ? 4 : 0,
    reels: Math.min(9, ready.length),
  };

  return {
    stations,
    agents,
    desks,
    props,
    posters: ready.map((c) => ({ creativeId: c.id, url: c.posterUrl ?? c.shots.find((s) => s.frameUrl)?.frameUrl ?? null, video: c.videoUrl, title: c.concept?.title ?? "Video" })),
    tvOn: style === "working",
    battle,
  };
}

/**
 * The agora's army: a company for each finished video, hoplites and an archer, mustered on the
 * quay below the agora beside the ship that will carry them (scenes/expedition.ts takes them from
 * there: aboard, across the sea, into the rival's city). Six hoplites a company, four once there
 * are more companies than ships and two companies share a ship.
 */
function armyPlans(battle: BattlePlan): AgentPlan[] {
  if (battle.phase === "none") return [];
  const agora = STATION.agora;
  const count = battle.companies.length;
  const ships = shipsFor(count);
  const hoplites = count > 4 ? 4 : 6;
  const agents: AgentPlan[] = [];
  const via = SHORE_ENTRY.map((w) => ({ ...w }));
  battle.companies.forEach((company, k) => {
    const ship = ships[k];
    const berth = homeBerth(ship);
    // The second company on a ship musters further along the quay.
    const shift = count > 4 && k >= 4 ? 34 : 0;
    const at = (along: number, across: number) => {
      const p = inShip(berth, BERTH_DIR, along + shift, across);
      return { x: p.x - agora.x, y: p.y - agora.y, z: 0 };
    };
    const outcome = outcomeOf(company);
    const title = `“${company.title}”`;
    const video = `video ${company.idx + 1}, ${title}`;
    const task =
      outcome === "won"
        ? `Took the rival's city: ${video} beats the top videos`
        : outcome === "held"
          ? `Holding the forum: ${video} is level with the top videos`
          : outcome === "repulsed"
            ? `Thrown back to the quay: ${video} trails the top videos`
            : company.state === "engaged"
              ? `Landed in the rival's city with ${video}, waiting for its numbers`
              : company.state === "sent"
                ? `Sailing for the rival's city while ${video} goes out`
                : company.state === "failed"
                  ? `Held back on the quay: video ${company.idx + 1}'s post failed`
                  : `Mustered on the quay for ${video}`;
    const state = outcome === "won" ? "done" : company.state === "failed" ? "failed" : company.state === "sent" || company.state === "engaged" ? "working" : "idle";
    const files = hoplites === 6 ? 3 : 2;
    for (let i = 0; i < hoplites; i++) {
      const file = (i % files) - (files - 1) / 2;
      const rank = Math.floor(i / files);
      agents.push({
        id: `hoplite:${company.idx}:${i}`,
        station: "agora",
        role: "Hoplite",
        task,
        look: (company.idx * 2 + i) % 6,
        act: "stand",
        ...at(-24 + file * 9, -19 - rank * 7.5),
        dir: 1,
        via,
        state,
        army: { company: k, rank, file, role: "hoplite" },
      });
    }
    agents.push({
      id: `archer:${company.idx}`,
      station: "agora",
      role: "Archer",
      task: outcome ? task : company.state === "sent" || company.state === "engaged" ? `With the fleet: ${task.charAt(0).toLowerCase()}${task.slice(1)}` : `Bow strung, mustered with the hoplites for ${video}`,
      look: LOOK.archer + (k % 3),
      act: "stand",
      ...at(-5, -22),
      dir: 1,
      via,
      state,
      army: { company: k, rank: 2, file: 0, role: "archer" },
    });
  });
  return agents;
}

/**
 * The scout for one land and every source fetched there. It sets out when the first one starts,
 * stays at the land until the last one is in, and brings back a scroll case if any came back.
 */
function scoutPlan(land: LandId, runs: RunView[], i: number, nextQueueSlot: () => number): AgentPlan {
  const name = LAND[land].name;
  const base = { id: `scout:${land}`, station: "scouts" as const, role: "Scout", look: (i + 1) % 6, z: 0, sort: 0 };
  const exit = SPOTS.exits[i % SPOTS.exits.length];
  const over = runs.filter((run) => run.status === "done" || run.status === "failed");
  const started = over.length > 0 || runs.some((run) => run.status === "running");
  if (!started) {
    const spot = SPOTS.queue(nextQueueSlot());
    return { ...base, task: `${name}: waiting to set out`, act: "stand", x: spot.x, y: spot.y, dir: spot.dir, state: "idle" };
  }
  if (over.length < runs.length) {
    const sources = runs.length === 1 ? quoteLabel(runs[0].key) : `${over.length} of ${runs.length} sources in`;
    return { ...base, task: `${name}: out gathering, ${sources}`, act: "march", x: exit.x, y: exit.y, dir: exit.dir, away: true, state: "working" };
  }
  const fetched = over.filter((run) => run.status === "done").length;
  const error = over.find((run) => run.error)?.error;
  const angle = i * 2.39996;
  return {
    ...base,
    task: fetched
      ? `${name}: brought back ${runs.length === 1 ? quoteLabel(runs[0].key) : `${fetched} of ${runs.length} sources`}`
      : `${name}: came back empty-handed${error ? ` (${error})` : ""}`,
    act: "stand",
    x: SPOTS.basket.x + Math.cos(angle) * (7 + (i % 3) * 3),
    y: SPOTS.basket.y + Math.sin(angle) * (5 + (i % 3) * 2),
    dir: 5,
    returning: fetched ? "scroll" : "empty",
    state: fetched ? "done" : "failed",
  };
}

const quoteLabel = (key: string) => `“${runLabel(key)}”`;

function editorTask(creative: CreativeView) {
  const title = creative.concept?.title ? `“${creative.concept.title}”` : `Video ${creative.idx + 1}`;
  if (creative.status === "ready") return `${title} is cut and ready${creative.qcScore ? ` (QC ${creative.qcScore}/10)` : ""}`;
  if (creative.status === "failed") return `${title} failed: ${creative.error ?? "a shot could not be rendered"}`;
  if (creative.status === "queued") return `${title}: waiting for a desk`;
  const shot = creative.shots.find((s) => s.status !== "passed");
  // No presenter to film (a faceless format), or every shot passed: screens, voice-over, the edit.
  if (!shot) return creative.shots.length ? `${title}: cutting the edit` : `${title}: building screens, the voice-over and the edit`;
  const verb = { pending: "framing", framed: "queuing", rendering: shot.provider === "monid" ? "rendering on Kling" : "rendering on Veo", rendered: "in quality check", passed: "approved", failed: "failed" }[shot.status];
  return `${title}: shot ${shot.n} of ${creative.shots.length} ${verb}`;
}

/** Which station a core event line is about (see the logEvent calls in the core's pipeline). */
export function stationForEvent(message: string, stage: string): StationId {
  const m = message.toLowerCase();
  if (m.startsWith("campaign started")) return "scouts";
  // The director's picks quote the research ("one silent desk shot…"): they are the war tent's.
  if (m.startsWith("the creative director")) return "tent";
  // Real-creator mode: the client's verdicts belong to the review, the casting to the workshop.
  if (/^client taste /.test(m)) return "theatre";
  if (/casting from \d+ creators|best fit @|outreach to @|people search for/.test(m)) return "workshop";
  // Rendering talk first: Monid is also the video fallback, so "monid" alone can't mean research.
  if (/\bshot\b|render|\bqc\b|kling|veo|naive is out|product screens|the edit failed|first frame/.test(m) && !/ready for review/.test(m)) return "workshop";
  if (/ready for review|approved/.test(m)) return "theatre";
  // The creative engine's director and script room, before "reference" sends a line to the oracle.
  if (/strategist|creative director|script room|scripts ready|concepts, now producing|^campaign "/.test(m)) return "tent";
  if (/^research (done|plan)|^scout:|sources\)/.test(m)) return "scouts";
  // The reference study (before the generic "monid": a brand can be called monid.ai).
  if (/format study|studying the format|format of|product brief|screenshots? of|screenshot |relevance screen|breaking down|reference|broken down/.test(m)) return "oracle";
  if (/research|monid|scout|sources/.test(m)) return "scouts";
  if (/post|publish|account|autopilot/.test(m)) return "agora";
  if (/is ready/.test(m)) return "workshop";
  return stationOf(stage);
}

/**
 * Where the reference study is (the core's campaign.study): reading the product, screenshotting
 * the site, screening the viral videos, breaking the best down. Null before it starts, and for
 * campaigns from before the creative engine.
 */
export function studyStep(campaign: CampaignView | null): { status: string; task: string; progress: number } | null {
  const study = campaign?.study;
  // A replayed demo (or an older core) sends no study at all: keep the generic line.
  if (!campaign || campaign.stage !== "style" || study === undefined) return null;
  if (!study?.product) return { status: "Reading the product", task: "Reading the site to learn what the product is, who it's for and what to show", progress: 0.1 };
  if (!study.captured) return { status: "Screenshotting the site", task: `Taking phone-size screenshots of ${study.product.name} to cut to in the videos`, progress: 0.25 };
  if (!study.picked && !study.studied) return { status: "Screening the viral videos", task: "Ranking the viral videos the scouts found and setting aside the ones that wouldn't make sense to remake", progress: 0.4 };
  const picked = Math.max(study.picked, study.studied);
  if (!study.done) {
    return { status: `Breaking down ${plural(picked, "viral video")}`, task: "Breaking each reference down second by second: the hook, every beat, the lines, the cuts and why it works", progress: 0.5 + 0.45 * (study.studied / Math.max(1, picked)) };
  }
  return { status: `${plural(study.studied, "viral video")} broken down`, task: "Handing the breakdowns to the director", progress: 1 };
}

/** The script room's progress: briefs from the director, and the scripts written so far. */
export function scriptRoom(campaign: CampaignView | null): { total: number; written: number } | null {
  const briefs = campaign?.strategy?.campaign.briefs;
  if (!briefs?.length) return null;
  return { total: briefs.length, written: Math.min(briefs.length, campaign?.strategy?.campaign.concepts?.length ?? 0) };
}
