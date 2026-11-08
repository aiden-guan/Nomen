import { ApiError } from "../http";
import type { MonidRunner } from "../monid";
import { runCostMicro } from "../monid";
import type { NaiveClient } from "../naive";
import { QC_MODEL } from "../qc";
import { extractJson, type Video } from "../research";
import type { ProductBrief } from "./types";

// Real-creator mode: instead of rendering each brief with AI, the campaign casts it. For each of the
// director's briefs it finds creators who already make this kind of video (the authors in the
// campaign's own research first, then Monid's TikTok and Instagram people search), ranks their fit,
// writes the creator-facing briefing, and has the client-taste agent (the brand's taste, tone and
// red lines) approve or deny the brief and creator together, trying the next creator on a "no". An
// approved pair gets an outreach draft. Nothing is sent: outreach waits for a person.

export type Creator = {
  platform: "tiktok" | "instagram";
  handle: string;
  name: string;
  followers: number | null;
  bio: string;
  url: string;
  /** research: the author of a video in the campaign's research; search: Monid's people search. */
  source: "research" | "search";
  /** What they've made that is like this brief: a research video's numbers and caption. */
  evidence: string;
};

export type Briefing = {
  title: string;
  summary: string;
  hook: string;
  talking_points: string[];
  shots: string[];
  reference: { url: string; why: string };
  deliverables: string[];
  dos: string[];
  donts: string[];
  timeline: string;
  fee: string;
};

export type TasteReview = { round: number; creator: string; approve: boolean; score: number; reasons: string[]; changes: string[] };

export type Casting = {
  status: "searching" | "reviewing" | "approved" | "no_match";
  candidates: Creator[];
  ranked: Array<{ handle: string; fit: number; why: string }>;
  tried: string[];
  pick: Creator | null;
  briefing: Briefing | null;
  reviews: TasteReview[];
  outreach: { channel: "tiktok_dm" | "instagram_dm"; message: string } | null;
  cost_micro: number;
};

/** The brand the taste agent stands in for: who they are and how they talk. */
export type ClientTaste = { name: string; tone: string; audience: string; values: string[]; competitors: string[] };

/** How many creators the taste agent may turn down per brief before the brief is set aside. */
export const MAX_CREATORS = 3;
/** Rounds a briefing may be revised for one creator after a "change this" from the taste agent. */
export const MAX_REVISIONS = 1;

// ---------- finding creators ----------

const handleOf = (url: string) => url.match(/tiktok\.com\/@([^/?#]+)/i)?.[1] ?? url.match(/instagram\.com\/([^/?#]+)/i)?.[1] ?? "";
const count = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}K` : String(n));

/**
 * Creators from the campaign's research: the authors of its videos, each with the video that shows
 * they make this kind of content. Small to mid-size accounts (500-1M followers), the ones a brand
 * can brief and afford (a 758-follower account with a 597K-view video is a find); the brand's own
 * account and big media pages are left out. Best evidence first.
 */
export function creatorsFromResearch(videos: Video[], brand: { name: string; domain?: string }): Creator[] {
  const brandWords = [brand.name, brand.domain ?? ""].map((w) => w.toLowerCase().replace(/[^a-z0-9]/g, "")).filter((w) => w.length > 2);
  const byHandle = new Map<string, { video: Video; ratio: number }>();
  for (const video of videos) {
    if (video.platform !== "tiktok" && video.platform !== "instagram") continue;
    if (video.paid) continue;
    const handle = (video.author || handleOf(video.url)).replace(/^@/, "");
    if (!handle) continue;
    const followers = video.followers ?? null;
    if (followers !== null && (followers < 500 || followers > 1_000_000)) continue;
    if (brandWords.some((w) => handle.toLowerCase().replace(/[^a-z0-9]/g, "").includes(w))) continue;
    const ratio = followers ? video.views / followers : video.views / 50_000;
    const best = byHandle.get(handle);
    if (!best || ratio > best.ratio) byHandle.set(handle, { video, ratio });
  }
  return [...byHandle.entries()]
    .sort((a, b) => b[1].ratio - a[1].ratio)
    .map(([handle, { video }]) => ({
      platform: video.platform as "tiktok" | "instagram",
      handle,
      name: handle,
      followers: video.followers ?? null,
      bio: "",
      url: video.platform === "tiktok" ? `https://www.tiktok.com/@${handle}` : `https://www.instagram.com/${handle}`,
      source: "research" as const,
      evidence: `${count(video.views)} views${video.followers ? ` on ${count(video.followers)} followers` : ""}: "${video.caption.replace(/\s+/g, " ").slice(0, 140)}" (${video.url})`,
    }));
}

/** Every object in a provider's answer that looks like a profile: a handle and a follower count. */
export function profilesIn(raw: unknown, platform: "tiktok" | "instagram"): Creator[] {
  const out: Creator[] = [];
  const seen = new Set<string>();
  const visit = (node: unknown, depth: number) => {
    if (!node || typeof node !== "object" || depth > 8) return;
    if (Array.isArray(node)) return node.forEach((child) => visit(child, depth + 1));
    const o = node as Record<string, unknown>;
    const handle = [o.unique_id, o.uniqueId, o.username, o.handle].find((v) => typeof v === "string" && v) as string | undefined;
    const followersRaw = [o.follower_count, o.followerCount, o.followers, o.followers_count].find((v) => typeof v === "number" || (typeof v === "string" && /^\d+$/.test(v)));
    if (handle && followersRaw !== undefined && !seen.has(handle.toLowerCase())) {
      seen.add(handle.toLowerCase());
      const followers = Number(followersRaw);
      const name = [o.nickname, o.full_name, o.name].find((v) => typeof v === "string" && v) as string | undefined;
      const bio = [o.signature, o.biography, o.bio].find((v) => typeof v === "string") as string | undefined;
      out.push({
        platform,
        handle: handle.replace(/^@/, ""),
        name: name ?? handle,
        followers: Number.isFinite(followers) ? followers : null,
        bio: (bio ?? "").replace(/\s+/g, " ").slice(0, 280),
        url: platform === "tiktok" ? `https://www.tiktok.com/@${handle.replace(/^@/, "")}` : `https://www.instagram.com/${handle.replace(/^@/, "")}`,
        source: "search",
        evidence: "",
      });
    }
    for (const value of Object.values(o)) visit(value, depth + 1);
  };
  visit(raw, 0);
  return out;
}

async function once(monid: MonidRunner, provider: string, endpoint: string, input: Parameters<MonidRunner["run"]>[2], pollMs = 1500) {
  let run = await monid.run(provider, endpoint, input);
  for (let i = 0; i < 40 && run.runId && !["COMPLETED", "FAILED", "BLOCKED", "STOPPED", "TIMED_OUT"].includes(String(run.status)); i++) {
    await new Promise((done) => setTimeout(done, pollMs));
    run = await monid.getRun(run.runId);
  }
  return run;
}

/**
 * Creators from Monid's people search (TikTok and Instagram) for a few keywords, in the 1K-1M range.
 * A search that fails is skipped: the research's creators are enough to cast from.
 */
export async function searchCreators(monid: MonidRunner, keywords: string[], pollMs?: number): Promise<{ creators: Creator[]; cost_micro: number; notes: string[] }> {
  const creators: Creator[] = [];
  const notes: string[] = [];
  let cost = 0;
  for (const keyword of keywords.slice(0, 2)) {
    try {
      const run = await once(monid, "tikhub", "/api/v1/tiktok/web/fetch_search_user", { queryParams: { keyword, cursor: 0 } }, pollMs);
      cost += runCostMicro(run);
      creators.push(...profilesIn(run.output, "tiktok"));
    } catch (error) {
      notes.push(`TikTok people search for "${keyword}" failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (keywords[0]) {
    try {
      const run = await once(monid, "anyapi", "/instagram.search", { body: { query: keywords[0], type: "user", limit: 12 } }, pollMs);
      cost += runCostMicro(run);
      creators.push(...profilesIn(run.output, "instagram"));
    } catch (error) {
      notes.push(`Instagram people search for "${keywords[0]}" failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { creators: creators.filter((c) => c.followers === null || (c.followers >= 500 && c.followers <= 1_000_000)), cost_micro: cost, notes };
}

/** The people-search keywords for a brief: its angle's words and the product's category, short. */
export function searchKeywords(input: { category?: string; audience?: string; angle?: string }): string[] {
  const words = [input.category, input.angle, input.audience]
    .filter((s): s is string => Boolean(s))
    .map((s) => s.replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim().split(" ").slice(0, 3).join(" ").toLowerCase())
    .filter(Boolean);
  return [...new Set(words)].slice(0, 2);
}

// ---------- the model's parts ----------

type Message = (input: Parameters<NaiveClient["message"]>[0]) => ReturnType<NaiveClient["message"]>;

async function ask<T>(message: Message, system: string, user: string, tool: { name: string; description: string; input_schema: object }, maxTokens = 3000): Promise<T | null> {
  try {
    const reply = await message({ model: QC_MODEL, max_tokens: maxTokens, system, messages: [{ role: "user", content: user }], tools: [tool] });
    const call = reply.content.find((block) => block.type === "tool_use" && block.name === tool.name);
    return ((call?.input as T | undefined) ?? (extractJson(reply.content.map((block) => block.text ?? "").join("\n")) as T | null)) ?? null;
  } catch (error) {
    // The model now and then fumbles the tool call itself (the Monid run's briefing): ask for plain JSON instead.
    if (!(error instanceof ApiError) || !/malformed tool call/i.test(error.message)) throw error;
    const fields = Object.keys((tool.input_schema as { properties?: Record<string, unknown> }).properties ?? {}).join(", ");
    const reply = await message({ model: QC_MODEL, max_tokens: maxTokens, system, messages: [{ role: "user", content: `${user.replace(/Call \w+ once\.$/, "")}\n\nAnswer with only one JSON object with these fields: ${fields}.` }] });
    return extractJson(reply.content.map((block) => block.text ?? "").join("\n")) as T | null;
  }
}

const CASTING_SYSTEM =
  "You cast UGC creators for a brand's paid briefs. You favour creators who already make this kind of video (one person talking to the camera, the same format and energy as the brief's reference), whose audience is the product's buyer, who look like a real person rather than a brand or a reposting page, and who a startup can afford (micro and mid-size accounts). A creator whose evidence shows the exact format beats a bigger account that does something else.";

/** The candidates ranked for one brief, best first, each with a fit score (0-10) and one reason. */
export async function rankCreators(message: Message, brief: { title: string; hook: string; format: string; reference_url: string }, product: Pick<ProductBrief, "name" | "one_liner" | "audience">, candidates: Creator[]) {
  const tool = {
    name: "rank_creators",
    description: "Rank the candidates for this brief.",
    input_schema: {
      type: "object",
      required: ["ranked"],
      properties: { ranked: { type: "array", items: { type: "object", required: ["handle", "fit", "why"], properties: { handle: { type: "string" }, fit: { type: "number", description: "0-10" }, why: { type: "string", description: "One sentence: why they fit or don't." } } } } },
    },
  };
  const user = [
    `<brief>\n${JSON.stringify(brief)}\n</brief>`,
    `<product>\n${JSON.stringify(product)}\n</product>`,
    `<candidates>\n${JSON.stringify(candidates.slice(0, 24).map((c) => ({ handle: c.handle, platform: c.platform, followers: c.followers, bio: c.bio, evidence: c.evidence })))}\n</candidates>`,
    "Rank the eight best candidates for this brief, best first. Call rank_creators once.",
  ].join("\n\n");
  const out = await ask<{ ranked?: Array<{ handle?: unknown; fit?: unknown; why?: unknown }> }>(message, CASTING_SYSTEM, user, tool);
  const known = new Set(candidates.map((c) => c.handle.toLowerCase()));
  return (out?.ranked ?? [])
    .map((r) => ({ handle: String(r.handle ?? "").replace(/^@/, ""), fit: Math.max(0, Math.min(10, Number(r.fit) || 0)), why: String(r.why ?? "").slice(0, 300) }))
    .filter((r) => known.has(r.handle.toLowerCase()));
}

const BRIEFING_FIELDS = ["title", "summary", "hook", "talking_points", "shots", "reference", "deliverables", "dos", "donts", "timeline", "fee"];

/** The creator-facing briefing: what to film, the reference to follow, the claims they may make. */
export async function writeBriefing(
  message: Message,
  input: { concept: { title: string; hook: string; angle?: string; cta?: string; lines: string[] }; reference: { url: string; format: string }; product: ProductBrief; creator: Creator; fee: string; changes?: string[] },
): Promise<Briefing | null> {
  const tool = {
    name: "briefing",
    description: "The creator-facing briefing.",
    input_schema: {
      type: "object",
      required: BRIEFING_FIELDS,
      properties: {
        title: { type: "string" },
        summary: { type: "string", description: "Two sentences, written to the creator: what the video is and why it suits them." },
        hook: { type: "string", description: "The opening line, word for word." },
        talking_points: { type: "array", items: { type: "string" }, description: "3-5 points in the creator's own words, each true to the product brief." },
        shots: { type: "array", items: { type: "string" }, description: "Simple shots a creator can film alone on a phone." },
        reference: { type: "object", required: ["url", "why"], properties: { url: { type: "string" }, why: { type: "string", description: "What to take from the reference: format, pacing, energy." } } },
        deliverables: { type: "array", items: { type: "string" } },
        dos: { type: "array", items: { type: "string" } },
        donts: { type: "array", items: { type: "string" }, description: "Including: no claims beyond the product brief." },
        timeline: { type: "string" },
        fee: { type: "string" },
      },
    },
  };
  const user = [
    `<concept>\n${JSON.stringify(input.concept)}\n</concept>`,
    `<reference>\n${JSON.stringify(input.reference)}\n</reference>`,
    `<product_brief>\n${JSON.stringify({ ...input.product, visuals: undefined })}\n</product_brief>`,
    `<creator>\n${JSON.stringify({ handle: input.creator.handle, platform: input.creator.platform, followers: input.creator.followers, bio: input.creator.bio, evidence: input.creator.evidence })}\n</creator>`,
    `Fee: ${input.fee}.`,
    input.changes?.length ? `The client asked for these changes to the last version: ${input.changes.join("; ")}.` : "",
    "Write the briefing for this creator: one face-to-camera vertical video in their own style, following the reference's format. Every claim must be in the product brief. Call briefing once.",
  ]
    .filter(Boolean)
    .join("\n\n");
  const out = await ask<Partial<Briefing>>(message, "You write short, specific creator briefs that a creator can film from in one sitting. Plain words, no marketing fluff.", user, tool, 3500);
  if (!out?.hook || !out.title) return null;
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, 8) : []);
  return {
    title: String(out.title),
    summary: String(out.summary ?? ""),
    hook: String(out.hook),
    talking_points: list(out.talking_points),
    shots: list(out.shots),
    reference: { url: String(out.reference?.url ?? input.reference.url), why: String(out.reference?.why ?? "") },
    deliverables: list(out.deliverables),
    dos: list(out.dos),
    donts: list(out.donts),
    timeline: String(out.timeline ?? ""),
    fee: String(out.fee ?? input.fee),
  };
}

/**
 * The client-taste agent: the brand's founder reviewing a brief and the creator who would film it,
 * with the brand's tone, audience, values and competitors, and every earlier verdict. It approves
 * only what it would pay for; a "no" says whether to change the brief or the creator.
 */
export async function tasteReview(message: Message, input: { taste: ClientTaste; briefing: Briefing; creator: Creator; round: number; history: TasteReview[] }): Promise<TasteReview> {
  const tool = {
    name: "verdict",
    description: "Approve or deny this brief and creator.",
    input_schema: {
      type: "object",
      required: ["approve", "score", "reasons", "changes"],
      properties: {
        approve: { type: "boolean" },
        score: { type: "number", description: "0-10: how much you want this video made by this creator." },
        reasons: { type: "array", items: { type: "string" }, description: "1-3 reasons, in your voice." },
        changes: { type: "array", items: { type: "string" }, description: "If the brief (not the creator) is the problem: what to change. Empty if the creator is the problem or you approve." },
      },
    },
  };
  const system = [
    `You are the client: the founder of ${input.taste.name}, approving the UGC your agency proposes before any money goes out. Your brand's tone: ${input.taste.tone}. Your buyer: ${input.taste.audience}.`,
    input.taste.values.length ? `What you care about: ${input.taste.values.join("; ")}.` : "",
    input.taste.competitors.length ? `Competitors you never want to look like: ${input.taste.competitors.join(", ")}.` : "",
    "You approve only a brief you'd pay for, filmed by a creator whose audience is your buyer and whose content you'd be glad to be seen next to. You turn down claims you can't back, a hook that sounds like an ad, off-brand or low-effort creators, and audiences that aren't your buyer. Be decisive and consistent with your earlier verdicts.",
  ]
    .filter(Boolean)
    .join(" ");
  const user = [
    `<briefing>\n${JSON.stringify(input.briefing)}\n</briefing>`,
    `<creator>\n${JSON.stringify(input.creator)}\n</creator>`,
    input.history.length ? `<your_earlier_verdicts>\n${JSON.stringify(input.history.map((h) => ({ creator: h.creator, approve: h.approve, reasons: h.reasons })))}\n</your_earlier_verdicts>` : "",
    "Give your verdict. Call verdict once.",
  ]
    .filter(Boolean)
    .join("\n\n");
  const out = await ask<{ approve?: unknown; score?: unknown; reasons?: unknown; changes?: unknown }>(message, system, user, tool, 1500);
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, 4) : []);
  return { round: input.round, creator: input.creator.handle, approve: out?.approve === true, score: Math.max(0, Math.min(10, Number(out?.score) || 0)), reasons: list(out?.reasons), changes: list(out?.changes) };
}

/** The first message to the creator: personal (one of their videos), the ask, the fee. Not sent. */
export async function draftOutreach(message: Message, input: { brand: string; creator: Creator; briefing: Briefing }): Promise<Casting["outreach"]> {
  const tool = { name: "outreach", description: "The DM.", input_schema: { type: "object", required: ["message"], properties: { message: { type: "string", description: "Under 600 characters, first person from the brand's founder." } } } };
  const user = [
    `Brand: ${input.brand}.`,
    `<creator>\n${JSON.stringify({ handle: input.creator.handle, platform: input.creator.platform, evidence: input.creator.evidence, bio: input.creator.bio })}\n</creator>`,
    `<briefing>\n${JSON.stringify({ title: input.briefing.title, summary: input.briefing.summary, hook: input.briefing.hook, fee: input.briefing.fee, timeline: input.briefing.timeline })}\n</briefing>`,
    "Write the first DM to this creator: name one specific video of theirs, say what you'd like them to film and why them, give the fee and timeline, and end with a simple question. Call outreach once.",
  ].join("\n\n");
  const out = await ask<{ message?: unknown }>(message, "You write short, warm, specific creator outreach that gets replies. No hype.", user, tool, 800);
  const text = typeof out?.message === "string" ? out.message.trim().slice(0, 900) : "";
  return text ? { channel: input.creator.platform === "instagram" ? "instagram_dm" : "tiktok_dm", message: text } : null;
}

// ---------- the casting of one brief ----------

export type CastingInput = {
  concept: { title: string; hook: string; angle?: string; cta?: string; lines: string[]; format: string };
  reference: { url: string; format: string };
  product: ProductBrief;
  taste: ClientTaste;
  research: Video[];
  brand: { name: string; domain?: string };
  keywords: string[];
  fee: string;
};

export type CastingDeps = { message: Message; monid: MonidRunner | null; log: (message: string, level?: "info" | "warn") => Promise<void> | void; pollMs?: number };

/**
 * One step of casting a brief; call it until the status is "approved" or "no_match". Each step
 * returns the casting to save: candidates found, then for each creator in rank order a briefing,
 * the client's verdict (one revision of the brief if the client asks for changes), and on a yes the
 * outreach draft.
 */
export async function stepCasting(deps: CastingDeps, input: CastingInput, casting: Casting | null): Promise<Casting> {
  const title = input.concept.title;
  if (!casting) {
    const fromResearch = creatorsFromResearch(input.research, input.brand);
    let found: Creator[] = [];
    let cost = 0;
    if (deps.monid && input.keywords.length) {
      const search = await searchCreators(deps.monid, input.keywords, deps.pollMs);
      found = search.creators;
      cost = search.cost_micro;
      for (const note of search.notes) await deps.log(`"${title}": ${note}`, "warn");
    }
    const seen = new Set(fromResearch.map((c) => c.handle.toLowerCase()));
    // The best of the research's creators and the searched ones, interleaved, so both get a look.
    const searched = found.filter((c) => !seen.has(c.handle.toLowerCase()));
    const candidates = [...fromResearch.slice(0, 20), ...searched.slice(0, 10), ...fromResearch.slice(20)].slice(0, 30);
    const fromResearchUsed = candidates.filter((c) => c.source === "research").length;
    await deps.log(`"${title}": casting from ${candidates.length} creators (${fromResearchUsed} from the research's videos, ${candidates.length - fromResearchUsed} from people search)`);
    if (!candidates.length) return { status: "no_match", candidates, ranked: [], tried: [], pick: null, briefing: null, reviews: [], outreach: null, cost_micro: cost };
    const ranked = await rankCreators(deps.message, { title, hook: input.concept.hook, format: input.concept.format, reference_url: input.reference.url }, input.product, candidates);
    const top = ranked[0];
    if (top) await deps.log(`"${title}": best fit @${top.handle} (${top.fit}/10): ${top.why}`);
    return { status: ranked.length ? "reviewing" : "no_match", candidates, ranked, tried: [], pick: null, briefing: null, reviews: [], outreach: null, cost_micro: cost };
  }
  if (casting.status !== "reviewing") return casting;

  // The next creator, or another round with the same one after the client asked for changes.
  const last = casting.reviews[casting.reviews.length - 1];
  const sameCreator = last && !last.approve && last.changes.length > 0 && casting.pick && last.creator === casting.pick.handle && casting.reviews.filter((r) => r.creator === last.creator).length <= MAX_REVISIONS;
  let pick = casting.pick;
  let tried = casting.tried;
  if (!sameCreator) {
    if (tried.length >= MAX_CREATORS) {
      await deps.log(`"${title}": the client turned down ${tried.length} creators; set aside (${last?.reasons[0] ?? "no reason given"})`, "warn");
      return { ...casting, status: "no_match" };
    }
    const next = casting.ranked.find((r) => !tried.includes(r.handle));
    pick = next ? (casting.candidates.find((c) => c.handle.toLowerCase() === next.handle.toLowerCase()) ?? null) : null;
    if (!pick) {
      await deps.log(`"${title}": no creator left to propose; set aside`, "warn");
      return { ...casting, status: "no_match" };
    }
    tried = [...tried, pick.handle];
  }
  const briefing = await writeBriefing(deps.message, { concept: input.concept, reference: input.reference, product: input.product, creator: pick!, fee: input.fee, changes: sameCreator ? last.changes : undefined });
  if (!briefing) throw new Error(`the briefing for @${pick!.handle} came back empty`);
  const review = await tasteReview(deps.message, { taste: input.taste, briefing, creator: pick!, round: casting.reviews.length + 1, history: casting.reviews });
  await deps.log(`Client taste ${review.approve ? "approved" : "turned down"} "${title}" with @${pick!.handle} (${review.score}/10): ${review.reasons[0] ?? ""}`);
  const reviews = [...casting.reviews, review];
  if (!review.approve) return { ...casting, tried, pick, briefing, reviews };
  const outreach = await draftOutreach(deps.message, { brand: input.brand.name, creator: pick!, briefing });
  await deps.log(`"${title}": outreach to @${pick!.handle} drafted, waiting for you to send it`);
  return { ...casting, status: "approved", tried, pick, briefing, reviews, outreach };
}
