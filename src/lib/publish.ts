import { logEvent, newId, now, parse, save, store } from "./db";
import { ApiError } from "./http";
import { NaiveClient } from "./naive";
import { getBrand, getCampaign, listCreatives } from "./pipeline";
import type { CreativeRow } from "./production";
import { slug } from "./production";

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

export async function approveAll(campaignId: string) {
  await store().update("creatives", { campaign_id: campaignId, status: "ready", rejected: 0 }, { approved: 1 });
}

/**
 * Queues approved videos for posting. `now` posts each one right away; `daily` spaces them one per
 * day at 16:00 UTC (morning in the Americas, evening in Europe), starting with the next slot.
 */
export async function publishCampaign(campaignId: string, mode: "now" | "daily") {
  const campaign = await getCampaign(campaignId);
  if (!campaign) throw new Error("No such campaign");
  const accounts = await connectedAccounts(campaign.brand_id);
  const connected = new Set(accounts.map((account) => account.platform).filter((platform) => VIDEO_PLATFORMS.has(platform)));
  if (connected.size === 0) throw new Error("Connect at least one of the brand's accounts first.");

  const creatives = await listCreatives(campaignId);
  const existing = creatives.length ? await store().find<{ creative_id: string }>("posts", { creative_id: { in: creatives.map((c) => c.id) }, status: { ne: "failed" } }) : [];
  const posted = new Set(existing.map((row) => row.creative_id));
  const queue = creatives.filter((c) => c.approved && !c.rejected && c.status === "ready" && !posted.has(c.id));
  if (queue.length === 0) throw new Error("Approve at least one ready video first.");

  const skipped: string[] = [];
  let slot = nextSlot(new Date());
  for (const creative of queue) {
    const platforms = parse<string[]>(creative.platforms_json, []).filter((platform) => connected.has(platform));
    const targets = platforms.length ? platforms : [...connected];
    if (!creative.final_file_id && !creative.final_external_url) {
      skipped.push(creative.id);
      continue;
    }
    const id = newId("pst");
    await store().insert("posts", {
      id,
      creative_id: creative.id,
      brand_id: campaign.brand_id,
      idem: `${id}-publish`,
      platforms_json: JSON.stringify(targets),
      scheduled_at: mode === "now" ? null : slot.toISOString(),
      status: "pending",
      created_at: now(),
      updated_at: now(),
    });
    if (mode === "daily") slot = new Date(slot.getTime() + 24 * 3600 * 1000);
  }
  await save("campaigns", campaignId, { status: "publishing" });
  await logEvent({ brandId: campaign.brand_id, campaignId, message: `Queued ${queue.length - skipped.length} posts ${mode === "now" ? "to go out now" : "one per day"}` });
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
        await save("posts", post.id, { naive_post_id: result.id, status: normalizeStatus(result.status), result_json: JSON.stringify(result) });
        await logEvent({ brandId: brand.id, message: `Post ${post.scheduled_at ? `scheduled for ${post.scheduled_at.slice(0, 16).replace("T", " ")} UTC` : "submitted"}: ${parse<string[]>(post.platforms_json, []).join(", ")}` });
      } else if (post.naive_post_id && (post.status === "scheduled" || post.status === "processing")) {
        if (Date.now() - Date.parse(post.updated_at) < STATUS_EVERY_MS) continue;
        const result = await naive.getPost(brand.identity_id, post.naive_post_id);
        await save("posts", post.id, { status: normalizeStatus(result.status), result_json: JSON.stringify(result) });
      } else if (post.naive_post_id && post.status === "posted") {
        if (post.analytics_at && Date.now() - Date.parse(post.analytics_at) < ANALYTICS_EVERY_MS) continue;
        if (Date.now() - Date.parse(post.created_at) > 14 * 24 * 3600 * 1000) continue;
        const analytics = await naive.postAnalytics(brand.identity_id, post.naive_post_id);
        await save("posts", post.id, { analytics_json: JSON.stringify(analytics), analytics_at: now() });
      }
    } catch (error) {
      if (error instanceof ApiError && error.retryable) continue;
      await save("posts", post.id, { status: post.status === "pending" ? "failed" : post.status, error: error instanceof Error ? error.message : String(error), analytics_at: now() });
      if (post.status === "pending") await logEvent({ brandId: brand.id, level: "error", message: `A post failed: ${error instanceof Error ? error.message : String(error)}` });
    }
  }
  await settleCampaigns();
}

function normalizeStatus(status: string): PostRow["status"] {
  const value = (status ?? "").toLowerCase();
  if (["scheduled", "processing", "posted", "failed", "deleted"].includes(value)) return value as PostRow["status"];
  if (value === "published" || value === "success") return "posted";
  return "processing";
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
