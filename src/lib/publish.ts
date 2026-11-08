import { db, logEvent, newId, now, parse, update } from "./db";
import { ApiError } from "./http";
import { NaiveClient } from "./naive";
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

async function ensureIdentity(naive: NaiveClient, brandId: string) {
  const brand = getBrand(brandId);
  if (!brand) throw new Error("No such brand");
  let identity = brand.identity_id;
  if (!identity) {
    identity = (await naive.ensureIdentity(`nomen-brand-${slug(brand.domain)}`, `Official social accounts of ${brand.name} (${brand.domain})`)).id;
    update("brands", brand.id, { identity_id: identity });
  }
  if (!brand.social_activated) {
    await naive.activateSocial(identity);
    update("brands", brand.id, { social_activated: 1 });
  }
  return identity;
}

/** A hosted link where the brand's owner connects its accounts (OAuth stays with the provider). */
export async function connectLink(brandId: string, returnTo?: string) {
  const naive = new NaiveClient();
  const identity = await ensureIdentity(naive, brandId);
  const portal = await naive.socialPortal(identity, returnTo ? { redirect_url: returnTo } : {});
  logEvent({ brandId, message: "Opened the account connection page" });
  return portal.url;
}

export async function connectedAccounts(brandId: string): Promise<SocialAccount[]> {
  const brand = getBrand(brandId);
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
 * for internal review only: they are held unless a person explicitly cleared them.
 */
export function postingHold(concept: Pick<Concept, "internal" | "cleared" | "brief"> | null): string | null {
  if (!concept) return null;
  const internal = concept.internal === true || concept.brief?.format === "remake";
  return internal && !concept.cleared?.at ? "internal remake: not cleared for posting" : null;
}

/** Clears one internal video for posting: an explicit decision by a named person, kept on the video and logged. */
export function clearForPosting(creativeId: string, by: string, note: string) {
  if (!by.trim() || !note.trim()) throw new Error("Say who clears it and why.");
  const creative = db().prepare("select * from creatives where id = ?").get(creativeId) as CreativeRow | undefined;
  if (!creative) throw new Error("No such video");
  const concept = parse<Concept | null>(creative.concept_json, null);
  if (!concept) throw new Error("The video's concept is unreadable");
  concept.cleared = { at: now(), by: by.trim(), note: note.trim() };
  update("creatives", creativeId, { concept_json: JSON.stringify(concept) });
  const campaign = getCampaign(creative.campaign_id);
  logEvent({ brandId: campaign?.brand_id, campaignId: creative.campaign_id, level: "warn", message: `"${concept.title}" (internal) was cleared for posting by ${by.trim()}: ${note.trim()}` });
}

export function approveAll(campaignId: string) {
  db().prepare("update creatives set approved = 1, updated_at = ? where campaign_id = ? and status = 'ready' and rejected = 0").run(now(), campaignId);
}

/**
 * Queues approved videos for posting. `now` posts each one right away; `daily` spaces them one per
 * day at 16:00 UTC (morning in the Americas, evening in Europe), starting with the next slot.
 */
export async function publishCampaign(campaignId: string, mode: "now" | "daily") {
  const campaign = getCampaign(campaignId);
  if (!campaign) throw new Error("No such campaign");
  const accounts = await connectedAccounts(campaign.brand_id);
  const connected = new Set(accounts.map((account) => account.platform).filter((platform) => VIDEO_PLATFORMS.has(platform)));
  if (connected.size === 0) throw new Error("Connect at least one of the brand's accounts first.");

  const posted = new Set((db().prepare("select creative_id from posts where status != 'failed'").all() as Array<{ creative_id: string }>).map((row) => row.creative_id));
  const approved = listCreatives(campaignId).filter((c) => c.approved && !c.rejected && c.status === "ready" && !posted.has(c.id));
  // Internal remakes never go out unless someone cleared them, even when approved or on autopilot.
  const held = approved.filter((c) => postingHold(parse<Concept | null>(c.concept_json, null)));
  const queue = approved.filter((c) => !held.includes(c));
  if (queue.length === 0) throw new Error(held.length ? "The approved videos are internal remakes, which are not posted unless cleared." : "Approve at least one ready video first.");
  if (held.length) logEvent({ brandId: campaign.brand_id, campaignId, message: `Held back ${held.length} internal remake${held.length > 1 ? "s" : ""}: not cleared for posting` });

  const skipped: string[] = [];
  let slot = nextSlot(new Date());
  const insert = db().prepare(
    `insert into posts (id, creative_id, brand_id, idem, platforms_json, scheduled_at, status, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
  );
  for (const creative of queue) {
    const platforms = parse<string[]>(creative.platforms_json, []).filter((platform) => connected.has(platform));
    const targets = platforms.length ? platforms : [...connected];
    if (!creative.final_file_id && !creative.final_external_url) {
      skipped.push(creative.id);
      continue;
    }
    const id = newId("pst");
    insert.run(id, creative.id, campaign.brand_id, `${id}-publish`, JSON.stringify(targets), mode === "now" ? null : slot.toISOString(), now(), now());
    if (mode === "daily") slot = new Date(slot.getTime() + 24 * 3600 * 1000);
  }
  update("campaigns", campaignId, { status: "publishing" });
  logEvent({ brandId: campaign.brand_id, campaignId, message: `Queued ${queue.length - skipped.length} posts ${mode === "now" ? "to go out now" : "one per day"}` });
  return { queued: queue.length - skipped.length, skipped };
}

function nextSlot(from: Date) {
  const slot = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate(), 16, 0, 0));
  if (slot.getTime() - from.getTime() < 30 * 60 * 1000) slot.setUTCDate(slot.getUTCDate() + 1);
  return slot;
}

const ANALYTICS_EVERY_MS = 30 * 60 * 1000;
const STATUS_EVERY_MS = 60 * 1000;

/** Worker step: submit queued posts, follow their status, refresh analytics of posted ones. */
export async function advancePosts() {
  const rows = db().prepare("select * from posts where status in ('pending', 'scheduled', 'processing', 'posted') order by created_at").all() as PostRow[];
  if (rows.length === 0) return;
  let naive: NaiveClient;
  try {
    naive = new NaiveClient();
  } catch {
    return;
  }
  for (const post of rows) {
    const brand = getBrand(post.brand_id);
    const creative = db().prepare("select * from creatives where id = ?").get(post.creative_id) as CreativeRow | undefined;
    if (!brand?.identity_id || !creative) continue;
    try {
      const hold = post.status === "pending" ? postingHold(parse<Concept | null>(creative.concept_json, null)) : null;
      if (hold) {
        update("posts", post.id, { status: "failed", error: hold });
        logEvent({ brandId: brand.id, level: "warn", message: `A post was stopped: ${hold}` });
      } else if (post.status === "pending") {
        const result = await naive.createPost(
          brand.identity_id,
          {
            content: creative.caption,
            title: parse<{ title?: string }>(creative.concept_json, {}).title,
            platforms: parse<string[]>(post.platforms_json, []),
            ...(creative.final_file_id ? { file_ids: [creative.final_file_id] } : { media_urls: [creative.final_external_url!] }),
            ...(post.scheduled_at && Date.parse(post.scheduled_at) > Date.now() + 5 * 60 * 1000 ? { scheduled_at: post.scheduled_at } : {}),
            ai_generated: true,
          },
          post.idem,
        );
        update("posts", post.id, { naive_post_id: result.id, status: normalizeStatus(result.status), result_json: JSON.stringify(result) });
        logEvent({ brandId: brand.id, message: `Post ${post.scheduled_at ? `scheduled for ${post.scheduled_at.slice(0, 16).replace("T", " ")} UTC` : "submitted"}: ${parse<string[]>(post.platforms_json, []).join(", ")}` });
      } else if (post.naive_post_id && (post.status === "scheduled" || post.status === "processing")) {
        if (Date.now() - Date.parse(post.updated_at) < STATUS_EVERY_MS) continue;
        const result = await naive.getPost(brand.identity_id, post.naive_post_id);
        update("posts", post.id, { status: normalizeStatus(result.status), result_json: JSON.stringify(result) });
      } else if (post.naive_post_id && post.status === "posted") {
        if (post.analytics_at && Date.now() - Date.parse(post.analytics_at) < ANALYTICS_EVERY_MS) continue;
        if (Date.now() - Date.parse(post.created_at) > 14 * 24 * 3600 * 1000) continue;
        const analytics = await naive.postAnalytics(brand.identity_id, post.naive_post_id);
        update("posts", post.id, { analytics_json: JSON.stringify(analytics), analytics_at: now() });
      }
    } catch (error) {
      if (error instanceof ApiError && error.retryable) continue;
      update("posts", post.id, { status: post.status === "pending" ? "failed" : post.status, error: error instanceof Error ? error.message : String(error), analytics_at: now() });
      if (post.status === "pending") logEvent({ brandId: brand.id, level: "error", message: `A post failed: ${error instanceof Error ? error.message : String(error)}` });
    }
  }
  settleCampaigns();
}

function normalizeStatus(status: string): PostRow["status"] {
  const value = (status ?? "").toLowerCase();
  if (["scheduled", "processing", "posted", "failed", "deleted"].includes(value)) return value as PostRow["status"];
  if (value === "published" || value === "success") return "posted";
  return "processing";
}

/** A publishing campaign goes live once none of its posts is still on its way. */
function settleCampaigns() {
  const publishing = db().prepare("select id from campaigns where status = 'publishing'").all() as Array<{ id: string }>;
  for (const { id } of publishing) {
    const open = db()
      .prepare("select count(*) n from posts p join creatives c on c.id = p.creative_id where c.campaign_id = ? and p.status in ('pending', 'processing')")
      .get(id) as { n: number };
    if (open.n === 0) update("campaigns", id, { status: "live", stage: "live" });
  }
}
