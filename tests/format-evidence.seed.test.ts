// The research behind the two non-clone styles, for the demo: proof that 3D "what if" simulation
// shorts (the ED Studio code ads) and brainrot memes pull huge views. Added by hand next to the
// automatic research, with real numbers: the simulation side was scraped on Nov 8 2026 at 00:25 PT
// (Monid: TikTok search, @wemakebuild's reels and profile, @ed._.studios' videos) into
// data/media/format-evidence/; the brainrot side comes from each campaign's own research pool.
// Opt-in, run from the main checkout (it writes data/nomen.db):
//
//   NOMEN_SEED_EVIDENCE=1 npx vitest run tests/format-evidence.seed.test.ts
//
// Each campaign gets research.format_evidence and two scout lines placed just after its first
// scout line, so a replay shows them in the research. Rerunning changes nothing.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse, save, store } from "@/lib/db";
import type { Video } from "@/lib/research";

const run = process.env.NOMEN_SEED_EVIDENCE === "1";
const CAMPAIGNS = ["cmp_f98819d8b08f46a7a422", "cmp_70daa9e79a4b42008d74"]; // Monid, Naive
const DIR = join(process.cwd(), "data", "media", "format-evidence");

type Example = { url: string; author: string; views: number; followers: number | null; caption: string };
const count = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}K` : String(n));

function objectsWith(node: unknown, keys: string[], out: Record<string, unknown>[] = [], depth = 0): Record<string, unknown>[] {
  if (!node || typeof node !== "object" || depth > 8) return out;
  if (Array.isArray(node)) node.forEach((child) => objectsWith(child, keys, out, depth + 1));
  else {
    const o = node as Record<string, unknown>;
    if (keys.some((k) => k in o)) out.push(o);
    Object.values(o).forEach((child) => objectsWith(child, keys, out, depth + 1));
  }
  return out;
}

/** The simulation-style evidence from the scrapes: top search videos, @wemakebuild, @ed._.studios. */
function simulationEvidence() {
  const raw = JSON.parse(readFileSync(join(DIR, "raw.json"), "utf8"));
  const search = JSON.parse(readFileSync(join(DIR, "simulation-search.json"), "utf8"));
  const handleOf = (o: Record<string, unknown>) => {
    const a = o.author as Record<string, unknown> | string | undefined;
    return String((typeof a === "object" ? (a?.handle ?? a?.uniqueId) : a) ?? o.authorHandle ?? "").replace(/^@/, "");
  };
  const top = objectsWith(search, ["views", "playCount"])
    .filter((o) => o.caption || o.description)
    .map((o) => ({ url: String(o.url ?? ""), author: handleOf(o), views: Number(o.views ?? o.playCount ?? 0), followers: null, caption: String(o.caption ?? o.description ?? "").slice(0, 120) }))
    .sort((a, b) => b.views - a.views)
    .slice(0, 3);
  const profile = objectsWith(raw.wemakebuild_profile.output, ["followersCount"])[0] ?? {};
  const followers = Number(profile.followersCount ?? 0) || null;
  const reels = objectsWith(raw.wemakebuild_reels.output, ["plays", "playCount", "views"])
    .filter((o) => o.shortcode || o.code)
    .map((o) => ({ url: `https://www.instagram.com/reel/${String(o.shortcode ?? o.code ?? "")}`, author: "wemakebuild", views: Number(o.views ?? o.plays ?? o.playCount ?? 0), followers, caption: String(o.caption ?? o.text ?? "").replace(/#\S+/g, "").replace(/🤔/g, "").trim().slice(0, 120) }))
    .sort((a, b) => b.views - a.views)
    .slice(0, 2);
  const ours = objectsWith(raw.edstudio_tiktok.output, ["views", "playCount"])
    .map((o) => ({ url: String(o.url ?? ""), author: "ed._.studios", views: Number(o.views ?? o.playCount ?? 0), followers: null, caption: String(o.caption ?? o.description ?? "").slice(0, 120) }))
    .sort((a, b) => b.views - a.views)
    .slice(0, 1);
  return { search: top, wemakebuild: { followers, posts: Number(profile.postsCount ?? 0) || null, reels }, edstudio: ours };
}

/** A campaign's own meme breakouts: memes with the most views per follower. */
function memeEvidence(videos: Video[]): Example[] {
  return videos
    .filter((v) => v.followers && /meme|duolingo|😭|💀|brainrot|crashout|sigma|rizz/i.test(v.caption))
    .sort((a, b) => b.views / b.followers! - a.views / a.followers!)
    .slice(0, 2)
    .map((v) => ({ url: v.url, author: v.author, views: v.views, followers: v.followers, caption: v.caption.slice(0, 120) }));
}

describe.skipIf(!run)("format evidence for the demo's research", () => {
  it("adds the simulation and brainrot evidence to each campaign's research and log", async () => {
    process.env.NOMEN_DB_PATH = join(process.cwd(), "data", "nomen.db");
    expect(existsSync(join(DIR, "raw.json"))).toBe(true);
    const sim = simulationEvidence();
    expect(sim.search.length).toBeGreaterThan(0);
    for (const id of CAMPAIGNS) {
      const [campaign] = await store().find<{ id: string; brand_id: string; research_json: string | null }>("campaigns", { id }, { limit: 1 });
      const research = parse<Record<string, unknown> & { videos?: Video[] }>(campaign.research_json, {});
      const memes = memeEvidence(research.videos ?? []);
      await save("campaigns", id, { research_json: JSON.stringify({ ...research, format_evidence: { fetched_at: "2026-11-08T08:25:00Z", simulation: sim, brainrot: memes } }) });

      const lines = [
        `Scout: format check, 3D "what if" simulation shorts are breaking out: ${sim.search.map((v) => `@${v.author} ${count(v.views)} views`).join(", ")}; on Instagram @wemakebuild's "${sim.wemakebuild.reels[0]?.caption ?? ""}" has ${count(sim.wemakebuild.reels[0]?.views ?? 0)} plays on ${count(sim.wemakebuild.followers ?? 0)} followers. A code-made animation ad fits this campaign.`,
        memes.length
          ? `Scout: format check, brainrot memes break out on tiny accounts: ${memes.map((m) => `@${m.author} ${count(m.views)} views on ${count(m.followers!)} followers (${Math.round(m.views / m.followers!)}x)`).join(", ")}. A meme ad fits too.`
          : null,
      ].filter((l): l is string => Boolean(l));
      const events = await store().find<{ ts: string; message: string }>("events", { campaign_id: id });
      const scout = events.filter((e) => e.message.startsWith("Scout:")).sort((a, b) => a.ts.localeCompare(b.ts))[0];
      const logged = new Set(events.map((e) => e.message));
      for (const [i, message] of lines.entries()) {
        if (logged.has(message)) continue;
        const ts = new Date(Date.parse(scout?.ts ?? new Date().toISOString()) + (i + 1) * 1000).toISOString();
        await store().insert("events", { brand_id: campaign.brand_id, campaign_id: id, ts, level: "info", message });
        console.log(`${id}: ${message}`);
      }
    }
  }, 120_000);
});
