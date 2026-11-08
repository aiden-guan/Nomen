import type { CampaignView } from "../api";
import { benchmarkOf } from "../scenes/battle";
import { STATION, type StationId } from "../scenes/layout";

// What changes hands when the courier carries work from one station to the next: the research to
// the oracle, the format study to the war tent, the plan to the workshop, a finished video to the
// theatre, the approved videos to the agora. Read from the campaign at the moment it is handed
// over, so the camp's little speech bubbles can say what the agents told each other.

export type Exchange = {
  from: StationId;
  to: StationId;
  /** "Scouts → Oracle". */
  title: string;
  /** What was handed over, a line each. */
  lines: string[];
};

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;
const count = (value: unknown) => (Array.isArray(value) ? value.length : 0);
const pct = (v: number) => `${(v * 100).toFixed(1)}%`;

/** What one station hands the next, from the campaign as it is now. */
export function exchangeOf(from: StationId, to: StationId, campaign: CampaignView | null): Exchange {
  const title = `${STATION[from].name} → ${STATION[to].name}`;
  return { from, to, title, lines: linesFor(from, to, campaign) };
}

function linesFor(from: StationId, to: StationId, campaign: CampaignView | null): string[] {
  if (!campaign) return [`${STATION[from].name} hand their work to ${STATION[to].name}.`];
  switch (from) {
    case "scouts":
      return research(campaign);
    case "oracle": {
      const style = campaign.style;
      const samples = count(style?.samples);
      return [
        samples ? `A format study of ${plural(samples, "viral reference")}, broken down beat by beat: transcript, cuts and frames.` : "The format study of the viral references.",
        ...(style?.slug ? [`Saved as the skill “${style.slug}”${style.version ? ` v${style.version}` : ""}.`] : []),
        ...research(campaign).slice(0, 1),
      ];
    }
    case "tent": {
      const concepts = campaign.strategy?.campaign.concepts ?? [];
      const briefs = campaign.strategy?.campaign.briefs ?? [];
      const videos = concepts.length ? concepts.map((c) => `${c.title} (${c.format})`) : briefs.map((b) => b.title);
      return [
        ...(campaign.strategy?.campaign.name ? [`The plan: ${campaign.strategy.campaign.name}.`] : []),
        ...(videos.length ? [`${plural(videos.length, "video")} to make:`, ...videos.slice(0, 5).map((v) => `· ${v}`)] : ["The plan, with a brief for each video."]),
      ];
    }
    case "workshop": {
      const ready = campaign.creatives.filter((c) => c.status === "ready");
      const latest = ready[ready.length - 1];
      if (!latest) return ["The finished videos, for your review."];
      return [
        `Finished: ${latest.concept?.title ?? `Video ${latest.idx + 1}`}${latest.concept?.format ? ` (${latest.concept.format})` : ""}.`,
        ...(latest.qcScore ? [`Passed quality control at ${latest.qcScore}/10.`] : []),
        `${ready.length} of ${campaign.creatives.length} videos ready for review.`,
      ];
    }
    case "theatre": {
      const approved = campaign.creatives.filter((c) => c.approved);
      const platforms = [...new Set(approved.flatMap((c) => c.platforms ?? []))];
      return approved.length
        ? [`${plural(approved.length, "approved video")} to post${platforms.length ? ` to ${platforms.join(", ")}` : ""}:`, ...approved.slice(0, 5).map((c) => `· ${c.concept?.title ?? `Video ${c.idx + 1}`}`)]
        : ["The approved videos, to post."];
    }
    default:
      return [`${STATION[from].name} hand their work to ${STATION[to].name}.`];
  }
}

/** The research in a few lines: what the scouts brought back, and the bar the videos must clear. */
function research(campaign: CampaignView): string[] {
  const r = campaign.research as { videos?: unknown[]; ads?: unknown[]; reddit?: unknown[]; seo?: { keywords?: unknown[]; domain_rating?: number | null } } | null;
  if (!r) return ["What the scouts brought back."];
  const found = [
    count(r.videos) && plural(count(r.videos), "top video"),
    count(r.ads) && plural(count(r.ads), "running ad"),
    count(r.reddit) && plural(count(r.reddit), "Reddit thread"),
    count(r.seo?.keywords) && plural(count(r.seo?.keywords), "search keyword"),
  ].filter(Boolean);
  const bench = benchmarkOf(campaign);
  const rivals = campaign.plan?.competitors?.map((c) => c.name).filter(Boolean) ?? [];
  return [
    found.length ? `Research: ${found.join(", ")}.` : "What the scouts brought back.",
    ...(bench ? [`The bar to clear: the top videos' median ${pct(bench.engagement)} likes per view.`] : []),
    ...(rivals.length ? [`Rivals: ${rivals.slice(0, 3).join(", ")}.`] : []),
  ];
}
