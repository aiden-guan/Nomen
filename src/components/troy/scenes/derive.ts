import type { BrandView, CampaignView, CreativeView, RunView } from "../api";
import type { Act } from "../engine/jobs";
import type { StationId } from "./layout";
import { DESK_SLOTS, EDITOR_OFFSET, SPOTS, WATCH_DROP } from "./stations";

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
  /** Out of the camp (a scout on a run): walk to the edge and fade out. */
  away?: boolean;
  /** Bringing something back: arrives from the island's edge carrying a scroll. */
  returning?: "scroll" | "empty";
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

function stationState(campaign: CampaignView | null, index: number): StationState {
  if (!campaign) return "waiting";
  const current = Math.max(0, campaign.stageIndex);
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

  // Oracle.
  {
    const state = states[1];
    if (state === "working") set("oracle", "Studying the top videos");
    else if (state === "skipped") set("oracle", "Skipped this time");
    else if (state === "done") set("oracle", "Format learned", 1);
    else if (state === "failed") set("oracle", campaign?.error ?? "Stopped");
    else set("oracle", "Waiting for the scouts");
  }

  // War tent.
  {
    const state = states[2];
    const strategy = campaign?.strategy;
    if (state === "working") set("tent", `Writing ${plural(campaign?.options.concepts ?? 0, "concept")}`);
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
      const doing = rendering ? `${plural(rendering, "shot")} rendering` : checking ? `checking ${plural(checking, "shot")}` : "painting first frames";
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
    else if (campaign?.status === "live") set("agora", `${posted} posted · ${scheduled} scheduled`, posts.length ? posted / posts.length : 1);
    else set("agora", "Waiting for your approval");
    if (campaign?.status === "publishing" || campaign?.status === "live") stations.agora.state = "working";
  }

  // --- Agents --------------------------------------------------------------------------------
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
    sort: 1,
    state: scouting ? "working" : "idle",
  });
  let queued = 0;
  runs.forEach((run, i) => agents.push(scoutPlan(run, i, () => queued++)));

  const style = states[1];
  agents.push({
    id: "watcher",
    station: "oracle",
    role: "Oracle",
    task: style === "working" ? "Watching the best short videos in the category and writing down why they work" : style === "done" ? "Wrote the format study" : "Resting",
    look: 4,
    act: style === "working" ? "watch" : style === "done" ? "stand" : "sit",
    ...SPOTS.watcher,
    z: 0,
    state: style === "working" ? "working" : style === "done" ? "done" : "idle",
  });

  const strat = states[2];
  agents.push({
    id: "general",
    station: "tent",
    role: "Strategist",
    task: strat === "working" ? "Writing the brief, the search plan and the concepts" : strat === "done" ? "Signed off the battle plan" : "Waiting for the scouts",
    look: -1,
    act: strat === "working" ? "point" : "stand",
    ...SPOTS.general,
    z: 0,
    state: strat === "working" ? "working" : strat === "done" ? "done" : "idle",
  });
  agents.push({
    id: "scribe",
    station: "tent",
    role: "Scribe",
    task: strat === "working" ? "Taking down every shot" : "Standing by",
    look: 5,
    act: strat === "working" ? "read" : "stand",
    ...SPOTS.scribe,
    z: 0,
    state: strat === "working" ? "working" : "idle",
  });

  const desks: DeskPlan[] = [];
  creatives.slice(0, DESK_SLOTS.length).forEach((creative, slot) => {
    const state = creative.status === "producing" ? 1 : creative.status === "ready" ? 2 : creative.status === "failed" ? 3 : 0;
    desks.push({ slot, creativeId: creative.id, state, title: creative.concept?.title ?? `Video ${creative.idx + 1}` });
    const desk = DESK_SLOTS[slot];
    agents.push({
      id: `editor:${creative.idx}`,
      station: "workshop",
      role: "Editor",
      task: editorTask(creative),
      look: creative.idx % 6,
      act: state === 1 ? "type" : "sit",
      x: desk.x + EDITOR_OFFSET.x,
      y: desk.y + EDITOR_OFFSET.y,
      z: 0,
      dir: EDITOR_OFFSET.dir,
      state: state === 1 ? "working" : state === 2 ? "done" : state === 3 ? "failed" : "idle",
    });
  });
  const producing = creatives.filter((c) => c.status === "producing");
  const framing = producing.some((c) => c.shots.some((s) => s.status === "pending"));
  if (framing) {
    agents.push({ id: "painter", station: "workshop", role: "Painter", task: "Painting the first frame of each shot so the product looks right", look: 2, act: "paint", ...SPOTS.painter, z: 0, state: "working" });
  }
  const checkingIndex = creatives.findIndex((c) => c.shots.some((s) => s.status === "rendered"));
  if (checkingIndex >= 0 && checkingIndex < DESK_SLOTS.length) {
    const desk = DESK_SLOTS[checkingIndex];
    agents.push({ id: "inspector", station: "workshop", role: "Inspector", task: "Checking every frame for warped hands, wrong labels and garbled text", look: 3, act: "inspect", x: desk.x + 9, y: desk.y - 2, z: 0, dir: 3, state: "working" });
  }

  const reviewing = (campaign?.stageIndex ?? 0) >= 4 && ready.length > 0;
  if (reviewing) {
    SPOTS.audience.slice(0, Math.min(4, Math.max(2, ready.length))).forEach((spot, i) => {
      agents.push({ id: `audience:${i}`, station: "theatre", role: "Audience", task: "Watching the cut", look: (i + 2) % 6, act: "watch", x: spot.x, y: spot.y, z: (spot.z ?? 0) - WATCH_DROP + 1.2, dir: spot.dir, sort: 0, state: "working" });
    });
  }

  const posting = campaign?.status === "publishing" || campaign?.status === "live";
  agents.push({
    id: "herald",
    station: "agora",
    role: "Herald",
    task: posting ? "Announcing each video on the brand's own accounts" : "Waiting for approved videos",
    look: 1,
    act: posting ? "herald" : "stand",
    ...SPOTS.herald,
    sort: 1,
    state: posting ? "working" : "idle",
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
  };
}

function scoutPlan(run: RunView, i: number, nextQueueSlot: () => number): AgentPlan {
  const label = runLabel(run.key);
  const base = { id: `scout:${run.key}`, station: "scouts" as const, role: "Scout", look: (i + 1) % 6, z: 0, sort: 0 };
  const exit = SPOTS.exits[i % SPOTS.exits.length];
  if (run.status === "pending") {
    const spot = SPOTS.queue(nextQueueSlot());
    return { ...base, task: `${label}: waiting to set out`, act: "stand", x: spot.x, y: spot.y, dir: spot.dir, state: "idle" };
  }
  if (run.status === "running") {
    return { ...base, task: `${label}: out gathering`, act: "march", x: exit.x, y: exit.y, dir: exit.dir, away: true, state: "working" };
  }
  const delivered = run.status === "done";
  const angle = i * 2.39996;
  return {
    ...base,
    task: delivered ? `${label}: brought it back` : `${label}: came back empty-handed${run.error ? ` (${run.error})` : ""}`,
    act: "stand",
    x: SPOTS.basket.x + Math.cos(angle) * (7 + (i % 3) * 3),
    y: SPOTS.basket.y + Math.sin(angle) * (5 + (i % 3) * 2),
    dir: 5,
    returning: delivered ? "scroll" : "empty",
    state: delivered ? "done" : "failed",
  };
}

function editorTask(creative: CreativeView) {
  const title = creative.concept?.title ? `“${creative.concept.title}”` : `Video ${creative.idx + 1}`;
  if (creative.status === "ready") return `${title} is cut and ready${creative.qcScore ? ` (QC ${creative.qcScore}/10)` : ""}`;
  if (creative.status === "failed") return `${title} failed: ${creative.error ?? "a shot could not be rendered"}`;
  if (creative.status === "queued") return `${title}: waiting for a desk`;
  const shot = creative.shots.find((s) => s.status !== "passed") ?? creative.shots[creative.shots.length - 1];
  if (!shot) return `${title}: starting`;
  const verb = { pending: "framing", framed: "queuing", rendering: shot.provider === "monid" ? "rendering on Kling" : "rendering on Veo", rendered: "in quality check", passed: "approved", failed: "failed" }[shot.status];
  return `${title}: shot ${shot.n} of ${creative.shots.length} ${verb}`;
}

/** Which station a core event line is about (see the logEvent calls in the core's pipeline). */
export function stationForEvent(message: string, stage: string): StationId {
  const m = message.toLowerCase();
  if (m.startsWith("campaign started")) return "scouts";
  // Rendering talk first: Monid is also the video fallback, so "monid" alone can't mean research.
  if (/\bshot\b|render|\bqc\b|kling|veo|naive is out/.test(m) && !/ready for review/.test(m)) return "workshop";
  if (/ready for review|approved/.test(m)) return "theatre";
  if (/research|monid|scout|sources/.test(m)) return "scouts";
  if (/format study|studying the format|format of/.test(m)) return "oracle";
  if (/strategist|concepts, now producing|^campaign "/.test(m)) return "tent";
  if (/post|publish|account|autopilot/.test(m)) return "agora";
  if (/is ready/.test(m)) return "workshop";
  return stationOf(stage);
}
