import { readFile } from "node:fs/promises";
import { logEvent, newId, now, parse, save, store } from "./db";
import { ApiError } from "./http";
import { NaiveClient, type SocialPost } from "./naive";
import { getBrand, getCampaign, listCreatives } from "./pipeline";
import type { CreativeRow } from "./production";
import { slug } from "./production";
import type { Concept } from "./strategy";

// Publishing to the brand's own accounts through Naive's Social primitive. Every post is labeled
// AI-generated: Naive adds each network's AI-content label and an #AIgenerated line.

export type PostRow = {
  id: string;
  creative_id: string;
  brand_id: string;
  idem: string;
  naive_post_id: string | null;
  platforms_json: string;
  scheduled_at: string | null;
  status: "pending" | "scheduled" | "processing" | "posted" | "failed" | "deleted";
  /** Naive's post once submitted. Before that, the request's own options ({ request: { visibility } }). */
  result_json: string | null;
  analytics_json: string | null;
  analytics_at: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
};

export type SocialAccount = { platform: string; name: string; id: string };

/** Networks Naive can publish a video to today (Pinterest and Reddit need a per-post destination). */
const VIDEO_PLATFORMS = new Set(["tiktok", "instagram", "youtube", "x", "facebook", "linkedin", "threads", "bluesky"]);

/** Who sees a post. Naive takes it for YouTube (and Mastodon) only; other networks use the account's default. */
export type Visibility = "public" | "unlisted" | "private";
export const VISIBILITIES: readonly Visibility[] = ["public", "unlisted", "private"];
const VISIBILITY_PLATFORMS = new Set(["youtube"]);

/** Narrows a publish: which approved videos, to which connected networks, seen by whom. */
export type PublishChoice = { creativeIds?: string[]; platforms?: string[]; visibility?: Visibility };

const PLATFORM_NAMES: Record<string, string> = { tiktok: "TikTok", instagram: "Instagram", youtube: "YouTube", x: "X", facebook: "Facebook", linkedin: "LinkedIn", threads: "Threads", bluesky: "Bluesky" };
const platformName = (platform: string) => PLATFORM_NAMES[platform] ?? platform;

async function ensureIdentity(naive: NaiveClient, brandId: string) {
  const brand = await getBrand(brandId);
  if (!brand) throw new Error("No such brand");
  let identity = brand.identity_id;
  if (!identity) {
    identity = (await naive.ensureIdentity(`nomen-brand-${slug(brand.domain)}`, `Official social accounts of ${brand.name} (${brand.domain})`)).id;
    await save("brands", brand.id, { identity_id: identity });
  }
  if (!brand.social_activated) {
    await naive.activateSocial(identity);
    await save("brands", brand.id, { social_activated: 1 });
  }
  return identity;
}

/** A hosted link where the brand's owner connects its accounts (OAuth stays with the provider). */
export async function connectLink(brandId: string, returnTo?: string) {
  const naive = new NaiveClient();
  const identity = await ensureIdentity(naive, brandId);
  const portal = await naive.socialPortal(identity, returnTo ? { redirect_url: returnTo } : {});
  await logEvent({ brandId, message: "Opened the account connection page" });
  return portal.url;
}

export async function connectedAccounts(brandId: string): Promise<SocialAccount[]> {
  const brand = await getBrand(brandId);
  if (!brand?.identity_id || !brand.social_activated) return [];
  const raw = await new NaiveClient().socialAccounts(brand.identity_id);
  return raw.map((account) => ({
    platform: String(account.platform ?? account.provider ?? account.network ?? account.type ?? "").toLowerCase(),
    name: String(account.username ?? account.handle ?? account.name ?? account.display_name ?? account.id ?? ""),
    id: String(account.id ?? ""),
  }));
}

/**
 * Why a video may not be posted, or null. One-to-one remakes copy a real creator's video and are
 * for internal review only: they are held unless a person explicitly cleared them. A video whose
 * concept can't be read can't be checked, so it is held too.
 */
export function postingHold(concept: Partial<Pick<Concept, "internal" | "cleared" | "brief" | "format">> | null): string | null {
  if (!concept) return "the video's concept is unreadable, so it can't be checked for posting";
  if (!isInternal(concept) || concept.cleared?.at) return null;
  return concept.brief?.format === "brainrot" ? "brainrot ad: not cleared for posting" : "internal remake: not cleared for posting";
}

/** An internal video: a one-to-one remake of a real creator's video (cleared or not). */
export function isInternal(concept: Partial<Pick<Concept, "internal" | "brief" | "format">> | null | undefined): boolean {
  return Boolean(concept && (concept.internal === true || (concept.format as string | undefined) === "remake" || concept.brief?.format === "remake" || concept.brief?.format === "brainrot"));
}

/** Clears one internal video for posting: an explicit decision by a named person, kept on the video and logged. */
export async function clearForPosting(creativeId: string, by: string, note: string) {
  if (!by.trim() || !note.trim()) throw new Error("Say who clears it and why.");
  const [creative] = await store().find<CreativeRow>("creatives", { id: creativeId }, { limit: 1 });
  if (!creative) throw new Error("No such video");
  const concept = parse<Concept | null>(creative.concept_json, null);
  if (!concept) throw new Error("The video's concept is unreadable");
  concept.cleared = { at: now(), by: by.trim(), note: note.trim() };
  await save("creatives", creativeId, { concept_json: JSON.stringify(concept) });
  const campaign = await getCampaign(creative.campaign_id);
  await logEvent({ brandId: campaign?.brand_id, campaignId: creative.campaign_id, level: "warn", message: `"${concept.title}" (internal) was cleared for posting by ${by.trim()}: ${note.trim()}` });
}

export async function approveAll(campaignId: string) {
  await store().update("creatives", { campaign_id: campaignId, status: "ready", rejected: 0 }, { approved: 1 });
}

/** The stored cut: recorded on the row, or where production keeps it ("crv_…/final.mp4"). */
const cutKey = (creative: CreativeRow) => creative.final_key || `${creative.id}/final.mp4`;

/** Whether there is something to post: the cut on Naive, the cut in the store, or a provider's link. */
async function hasMedia(creative: CreativeRow) {
  return Boolean(creative.final_file_id || creative.final_external_url) || (await store().files.exists(cutKey(creative)));
}

/**
 * Queues approved videos for posting. `now` posts each one right away; `daily` spaces them one per
 * day at 16:00 UTC (morning in the Americas, evening in Europe), starting with the next slot.
 * `choice` narrows it to some videos, some of the connected networks, or a visibility (YouTube).
 */
export async function publishCampaign(campaignId: string, mode: "now" | "daily", choice: PublishChoice = {}) {
  const campaign = await getCampaign(campaignId);
  if (!campaign) throw new Error("No such campaign");
  const accounts = await connectedAccounts(campaign.brand_id);
  const connected = new Set(accounts.map((account) => account.platform).filter((platform) => VIDEO_PLATFORMS.has(platform)));
  if (connected.size === 0) throw new Error("Connect at least one of the brand's accounts first.");
  const missing = (choice.platforms ?? []).filter((platform) => !connected.has(platform));
  if (missing.length) throw new Error(`Connect the brand's ${missing.map(platformName).join(" and ")} account first.`);
  if (choice.visibility) {
    const publicOnly = (choice.platforms ?? [...connected]).filter((platform) => !VISIBILITY_PLATFORMS.has(platform));
    if (publicOnly.length) throw new Error(`Only YouTube posts can be ${choice.visibility}; ${publicOnly.map(platformName).join(", ")} posts are public. Post to YouTube alone, or post publicly.`);
  }

  const creatives = await listCreatives(campaignId);
  const existing = creatives.length ? await store().find<{ creative_id: string }>("posts", { creative_id: { in: creatives.map((c) => c.id) }, status: { ne: "failed" } }) : [];
  const posted = new Set(existing.map((row) => row.creative_id));
  const approved = creatives.filter((c) => c.approved && !c.rejected && c.status === "ready" && !posted.has(c.id) && (!choice.creativeIds || choice.creativeIds.includes(c.id)));
  // Internal remakes never go out unless someone cleared them, even when approved or on autopilot.
  const held = approved.filter((c) => postingHold(parse<Concept | null>(c.concept_json, null)));
  const queue = approved.filter((c) => !held.includes(c));
  if (queue.length === 0) throw new Error(held.length ? "The approved videos are internal remakes, which are not posted unless cleared." : "Approve at least one ready video first.");
  if (held.length) await logEvent({ brandId: campaign.brand_id, campaignId, message: `Held back ${held.length} internal remake${held.length > 1 ? "s" : ""}: not cleared for posting` });

  const skipped: string[] = [];
  let queued = 0;
  let slot = nextSlot(new Date());
  for (const creative of queue) {
    if (!(await hasMedia(creative))) {
      skipped.push(creative.id);
      continue;
    }
    const platforms = choice.platforms ?? parse<string[]>(creative.platforms_json, []).filter((platform) => connected.has(platform));
    const id = newId("pst");
    await store().insert("posts", {
      id,
      creative_id: creative.id,
      brand_id: campaign.brand_id,
      idem: `${id}-publish`,
      platforms_json: JSON.stringify(platforms.length ? platforms : [...connected]),
      scheduled_at: mode === "now" ? null : slot.toISOString(),
      status: "pending",
      result_json: choice.visibility ? JSON.stringify({ request: { visibility: choice.visibility } }) : null,
      created_at: now(),
      updated_at: now(),
    });
    queued += 1;
    if (mode === "daily") slot = new Date(slot.getTime() + 24 * 3600 * 1000);
  }
  if (queued === 0) throw new Error("None of the approved videos has a finished file to post yet.");
  // A campaign still making its other videos keeps running; the worker only advances running ones.
  if (campaign.status !== "running") await save("campaigns", campaignId, { status: "publishing" });
  await logEvent({
    brandId: campaign.brand_id,
    campaignId,
    message: `Queued ${queued} post${queued === 1 ? "" : "s"} ${mode === "now" ? "to go out now" : "one per day"}${choice.visibility ? ` (${choice.visibility})` : ""}${skipped.length ? `; ${skipped.length} had no file to post` : ""}`,
  });
  return { queued, skipped };
}

function nextSlot(from: Date) {
  const slot = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate(), 16, 0, 0));
  if (slot.getTime() - from.getTime() < 30 * 60 * 1000) slot.setUTCDate(slot.getUTCDate() + 1);
  return slot;
}

const ANALYTICS_EVERY_MS = 30 * 60 * 1000;
const STATUS_EVERY_MS = 60 * 1000;
/** After a busy answer (Naive at capacity, a network blip), a queued post waits this long before trying again. */
const BUSY_RETRY_MS = 60 * 1000;

/** Worker step: submit queued posts, follow their status, refresh analytics of posted ones. */
export async function advancePosts() {
  const rows = await store().find<PostRow>("posts", { status: { in: ["pending", "scheduled", "processing", "posted"] } }, { order: [["created_at", "asc"]] });
  if (rows.length === 0) return;
  let naive: NaiveClient;
  try {
    naive = new NaiveClient();
  } catch {
    return;
  }
  for (const post of rows) {
    const brand = await getBrand(post.brand_id);
    const [creative] = await store().find<CreativeRow>("creatives", { id: post.creative_id }, { limit: 1 });
    if (!brand?.identity_id || !creative) continue;
    try {
      if (post.status === "pending") {
        // Checked again here: a post queued before a video was held must not go out either.
        const hold = postingHold(parse<Concept | null>(creative.concept_json, null));
        if (hold) {
          await save("posts", post.id, { status: "failed", error: hold });
          await logEvent({ brandId: brand.id, level: "warn", message: `A post was stopped: ${hold}` });
          continue;
        }
        if (post.error && Date.now() - Date.parse(post.updated_at) < BUSY_RETRY_MS) continue;
        await submit(naive, brand.id, brand.identity_id, post, creative);
      } else if (post.naive_post_id && (post.status === "scheduled" || post.status === "processing")) {
        if (Date.now() - Date.parse(post.updated_at) < STATUS_EVERY_MS) continue;
        // Nothing changes before a scheduled post is due; asking every minute only loads a busy Naive.
        if (post.status === "scheduled" && post.scheduled_at && Date.parse(post.scheduled_at) > Date.now()) continue;
        const result = await naive.getPost(brand.identity_id, post.naive_post_id);
        const status = normalizeStatus(result.status);
        await save("posts", post.id, { status, result_json: JSON.stringify(result), error: postError(result) });
        if (status === "failed") await logEvent({ brandId: brand.id, level: "error", message: `A post failed: ${postError(result)}` });
        if (status === "posted") await logPosted(brand.id, post, result);
      } else if (post.naive_post_id && post.status === "posted") {
        if (post.analytics_at && Date.now() - Date.parse(post.analytics_at) < ANALYTICS_EVERY_MS) continue;
        if (Date.now() - Date.parse(post.created_at) > 14 * 24 * 3600 * 1000) continue;
        const analytics = await naive.postAnalytics(brand.identity_id, post.naive_post_id);
        await save("posts", post.id, { analytics_json: JSON.stringify(analytics), analytics_at: now() });
      }
    } catch (error) {
      if (error instanceof ApiError && error.retryable) {
        // Naive at capacity, or a network blip: nothing is lost. A queued post says why it waits.
        if (post.status === "pending") await save("posts", post.id, { error: `Waiting for Naive (${error.message.replace(/^naive: /, "")}); trying again in a minute` });
        continue;
      }
      await save("posts", post.id, { status: post.status === "pending" ? "failed" : post.status, error: error instanceof Error ? error.message : String(error), analytics_at: now() });
      if (post.status === "pending") await logEvent({ brandId: brand.id, level: "error", message: `A post failed: ${error instanceof Error ? error.message : String(error)}` });
    }
  }
  await settleCampaigns();
}

/** Sends a queued post to Naive: the cut, the caption and the title, labeled AI-generated. */
async function submit(naive: NaiveClient, brandId: string, identity: string, post: PostRow, creative: CreativeRow) {
  const platforms = parse<string[]>(post.platforms_json, []);
  const request = parse<{ request?: { visibility?: Visibility } }>(post.result_json, {}).request ?? {};
  const result = await naive.createPost(
    identity,
    {
      content: creative.caption,
      title: parse<{ title?: string }>(creative.concept_json, {}).title,
      platforms,
      ...(await postMedia(naive, creative)),
      ...(post.scheduled_at && Date.parse(post.scheduled_at) > Date.now() + 5 * 60 * 1000 ? { scheduled_at: post.scheduled_at } : {}),
      ...(request.visibility ? { visibility: request.visibility } : {}),
      ai_generated: true,
    },
    post.idem,
  );
  const status = normalizeStatus(result.status);
  await save("posts", post.id, { naive_post_id: result.id, status, result_json: JSON.stringify(result), error: postError(result) });
  await logEvent({
    brandId,
    message: `Post ${post.scheduled_at ? `scheduled for ${post.scheduled_at.slice(0, 16).replace("T", " ")} UTC` : "submitted"}: ${platforms.map(platformName).join(", ")}${request.visibility ? ` (${request.visibility})` : ""}`,
  });
  if (status === "posted") await logPosted(brandId, post, result);
}

/** One line in the activity log when a post is out, with its link when Naive has one. */
async function logPosted(brandId: string, post: PostRow, result: SocialPost) {
  const url = typeof result.url === "string" && result.url ? `: ${result.url}` : "";
  await logEvent({ brandId, message: `Posted to ${parse<string[]>(post.platforms_json, []).map(platformName).join(", ")}${url}` });
}

/**
 * The file a post carries: the cut on Naive. When production could not upload the cut (Naive was
 * at capacity), it goes up from the store now and is kept on the video, so it is uploaded once.
 */
async function postMedia(naive: NaiveClient, creative: CreativeRow): Promise<{ file_ids: string[] } | { media_urls: string[] }> {
  if (creative.final_file_id) return { file_ids: [creative.final_file_id] };
  const key = cutKey(creative);
  if (await store().files.exists(key)) {
    const name = `${slug(parse<{ title?: string }>(creative.concept_json, {}).title ?? creative.id)}.mp4`;
    const fileId = await naive.uploadFile(name, "video/mp4", await readFile(await store().files.localPath(key)));
    await save("creatives", creative.id, { final_file_id: fileId });
    return { file_ids: [fileId] };
  }
  if (creative.final_external_url) return { media_urls: [creative.final_external_url] };
  throw new Error("The video has no finished file to post.");
}

function normalizeStatus(status: string): PostRow["status"] {
  const value = (status ?? "").toLowerCase();
  if (["scheduled", "processing", "posted", "failed", "deleted"].includes(value)) return value as PostRow["status"];
  if (value === "published" || value === "success") return "posted";
  return "processing";
}

/** The network's reason, when Naive says a post failed; null otherwise. */
function postError(result: SocialPost): string | null {
  if (normalizeStatus(result.status) !== "failed") return null;
  const error = result.error;
  if (typeof error === "string" && error) return error;
  if (error && typeof error === "object") return String((error as { message?: unknown }).message ?? JSON.stringify(error));
  return "the network refused the post";
}

/** A publishing campaign goes live once none of its posts is still on its way. */
async function settleCampaigns() {
  const publishing = await store().find<{ id: string }>("campaigns", { status: "publishing" });
  for (const { id } of publishing) {
    const creatives = await listCreatives(id);
    const open = creatives.length ? await store().find("posts", { creative_id: { in: creatives.map((c) => c.id) }, status: { in: ["pending", "processing"] } }, { limit: 1 }) : [];
    if (open.length === 0) await save("campaigns", id, { status: "live", stage: "live" });
  }
}

// ---------- what a post did ----------

export type PostStats = { views?: number; likes?: number; comments?: number; shares?: number; saves?: number };
type Metric = keyof PostStats;

const METRIC_KEYS: Record<Metric, string[]> = {
  views: ["views", "viewcount", "videoviews", "videoviewcount", "plays", "playcount", "totalplays"],
  likes: ["likes", "likecount", "favorites", "favoritecount", "reactions", "reactioncount"],
  comments: ["comments", "commentcount", "commentscount"],
  shares: ["shares", "sharecount", "reposts", "repostcount", "retweets", "retweetcount"],
  saves: ["saves", "savecount", "saved", "bookmarks", "bookmarkcount"],
};
const METRIC_OF = new Map(Object.entries(METRIC_KEYS).flatMap(([metric, keys]) => keys.map((key) => [key, metric as Metric] as const)));

/**
 * A post's link and its numbers. Naive passes each network's analytics through as the provider
 * shapes them (under `data`, one block per network), so this reads the usual names (videoViews,
 * like_count, comments…) wherever they sit. A number at one level wins over the breakdown under it
 * (a total and its days are not added up); separate branches, like two networks, are added up.
 * Without analytics yet, the post's own `metrics` are used.
 */
export function postStats(post: Pick<PostRow, "analytics_json" | "result_json">): PostStats & { url: string | null } {
  const result = parse<{ url?: unknown; metrics?: unknown } | null>(post.result_json, null);
  const fromAnalytics = collectStats(parse<unknown>(post.analytics_json, null));
  const stats = Object.keys(fromAnalytics).length ? fromAnalytics : collectStats(result?.metrics ?? null);
  return { url: typeof result?.url === "string" && result.url ? result.url : null, ...stats };
}

function collectStats(node: unknown): PostStats {
  if (Array.isArray(node)) return collectList(node);
  if (!node || typeof node !== "object") return {};
  const here: PostStats = {};
  let below: PostStats = {};
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    const metric = METRIC_OF.get(key.toLowerCase().replace(/[^a-z]/g, ""));
    if (metric) {
      const n = count(value);
      if (n !== null && here[metric] === undefined) here[metric] = n;
      continue; // a metric's own value (a list of comments, say) holds no other metric
    }
    if (value && typeof value === "object") below = addStats(below, collectStats(value));
  }
  return { ...below, ...here };
}

const TIME_KEYS = ["createdAt", "created_at", "updatedAt", "updated_at", "measuredAt", "measured_at", "date", "timestamp"];
const SERIES_KEYS = ["profilePostId", "profile_post_id", "socialAccountId", "social_account_id", "accountId", "account_id", "platform", "platformType", "network"];

/**
 * A list of entries. Snapshots of running totals, each stamped with its time (Naive's provider,
 * bundle.social, keeps one per refresh), count once: the latest of each series (one per network
 * or account). Entries without a time, like one per network, add up.
 */
function collectList(items: unknown[]): PostStats {
  const latest = new Map<string, { at: number; item: unknown }>();
  let sum: PostStats = {};
  for (const item of items) {
    const record = item && typeof item === "object" && !Array.isArray(item) ? (item as Record<string, unknown>) : null;
    const at = record ? TIME_KEYS.map((key) => (typeof record[key] === "string" ? Date.parse(record[key] as string) : NaN)).find((t) => Number.isFinite(t)) : undefined;
    if (at === undefined) {
      sum = addStats(sum, collectStats(item));
      continue;
    }
    const series = SERIES_KEYS.map((key) => record![key]).find((value) => typeof value === "string" && value) ?? "#series";
    const seen = latest.get(String(series));
    if (!seen || at > seen.at) latest.set(String(series), { at, item });
  }
  for (const { item } of latest.values()) sum = addStats(sum, collectStats(item));
  return sum;
}

/** 12, "12", or { count: 12 } (some networks wrap their numbers). */
function count(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && /^\d+(\.\d+)?$/.test(value.trim())) return Number(value);
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const inner = value as Record<string, unknown>;
    for (const key of ["count", "total", "value"]) if (typeof inner[key] === "number") return inner[key] as number;
  }
  return null;
}

function addStats(a: PostStats, b: PostStats): PostStats {
  const sum: PostStats = { ...a };
  for (const [metric, n] of Object.entries(b) as Array<[Metric, number]>) sum[metric] = (sum[metric] ?? 0) + n;
  return sum;
}
