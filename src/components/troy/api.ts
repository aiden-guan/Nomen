import type { LoopView as CoreLoopView } from "@/lib/loop";
import type { phonePosts as corePhonePosts } from "@/lib/phones/service";
import type { BrandListItem as CoreBrandListItem, BrandView as CoreBrandView, CampaignView as CoreCampaignView, CreativeView as CoreCreativeView, ReferenceView as CoreReferenceView } from "@/lib/views";

// The core track's HTTP API, as this UI uses it. The shapes are the core's own view types
// (src/lib/views.ts), imported as types only, so a change there shows up here as a type error
// instead of a broken page. Money arrives in dollars.

export type BrandView = CoreBrandView;
export type CampaignView = CoreCampaignView;
export type CreativeView = CoreCreativeView;
export type BrandListItem = CoreBrandListItem;
/** A viral video the agents studied or set aside (the creative engine's reference study). */
export type ReferenceView = CoreReferenceView;
/** A brand's autopilot (the always-on loop, src/lib/loop.ts). */
export type LoopView = CoreLoopView;
export type RunView = CampaignView["runs"][number];
export type ShotView = CreativeView["shots"][number];
export type PostView = CampaignView["posts"][number];
export type EventView = BrandView["events"][number];
export type Stage = CampaignView["stage"];
export type CampaignStatus = CampaignView["status"];

export class ApiFailure extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
  } catch {
    throw new ApiFailure("Nomen's server can't be reached. Check your connection and try again.", 0);
  }
  let data: unknown = null;
  try {
    data = await response.json();
  } catch {
    // Not JSON: fall through to the status message.
  }
  if (!response.ok) {
    const message = (data as { error?: string } | null)?.error;
    throw new ApiFailure(message ?? `The server answered ${response.status}.`, response.status);
  }
  return data as T;
}

/** Creates (or finds) the brand and starts its campaign: POST /api/brands. */
export function startCampaign(url: string) {
  return call<{ brandId: string; campaignId: string }>("/api/brands", { method: "POST", body: JSON.stringify({ url }) });
}

export async function listBrands() {
  return (await call<{ brands: BrandListItem[] }>("/api/brands")).brands;
}

export function getBrand(id: string) {
  return call<BrandView>(`/api/brands/${encodeURIComponent(id)}`);
}

export function campaignAction(id: string, action: "retry" | "approve_all" | "publish", mode?: "now" | "daily") {
  return call<{ ok?: boolean; [key: string]: unknown }>(`/api/campaigns/${encodeURIComponent(id)}`, { method: "POST", body: JSON.stringify({ action, mode }) });
}

export function setApproved(creativeId: string, approved: boolean) {
  return call<{ ok: boolean }>(`/api/creatives/${encodeURIComponent(creativeId)}`, { method: "PATCH", body: JSON.stringify({ approved }) });
}

export function regenerate(creativeId: string, note?: string) {
  return call<{ id: string }>(`/api/creatives/${encodeURIComponent(creativeId)}`, { method: "POST", body: JSON.stringify({ note }) });
}

export type SocialAccountView = { platform: string; name: string; id: string };

/** "Post through phone" (src/lib/phones): whether it can run, what one post costs, and the brand's phone posts. */
export type PhonePostsView = Awaited<ReturnType<typeof corePhonePosts>>;
export type PhonePostView = PhonePostsView["posts"][number];

export function phonePosts(brandId: string) {
  return call<PhonePostsView>(`/api/phones/posts?brandId=${encodeURIComponent(brandId)}`, { cache: "no-store" });
}

/** Posts one finished, approved video on TikTok through the brand's phone (the worker runs it). */
export function postThroughPhone(creativeId: string) {
  return call<PhonePostsView>("/api/phones/posts", { method: "POST", body: JSON.stringify({ creativeId }) });
}

/** The brand's connected social accounts, read live from Naive (GET /api/brands/[id]/social), with why it failed if it did. */
export async function socialAccounts(brandId: string): Promise<{ accounts: SocialAccountView[]; error: string | null }> {
  const data = await call<{ accounts: SocialAccountView[]; error?: string }>(`/api/brands/${encodeURIComponent(brandId)}/social`, { cache: "no-store" });
  return { accounts: data.accounts ?? [], error: data.error ?? null };
}

/** A hosted page where the brand's owner connects its accounts; returns here afterwards. */
export async function connectLink(brandId: string, returnTo: string) {
  return (await call<{ url: string }>(`/api/brands/${encodeURIComponent(brandId)}/social`, { method: "POST", body: JSON.stringify({ returnTo }) })).url;
}

/** The brand's autopilot (GET /api/brands/[id]/loop): settings, the next decision and this week's spend. */
export function getAutopilot(brandId: string) {
  return call<LoopView>(`/api/brands/${encodeURIComponent(brandId)}/loop`, { cache: "no-store" });
}

/** Changes the brand's autopilot (POST /api/brands/[id]/loop). Turning it on needs a weekly budget. */
export function setAutopilot(brandId: string, patch: { enabled?: boolean; weeklyBudgetUsd?: number | string; cadenceDays?: number; autopost?: boolean; skipCampaignId?: string }) {
  return call<LoopView>(`/api/brands/${encodeURIComponent(brandId)}/loop`, { method: "POST", body: JSON.stringify(patch) });
}

/** The same check the server makes (src/lib/pipeline.ts normalizeDomain), for instant feedback. */
export function normalizeSite(input: string): { domain: string } | { error: string } {
  const trimmed = input.trim();
  if (!trimmed) return { error: "Type your company's website, like acme.com." };
  if (/\s/.test(trimmed)) return { error: "A website address has no spaces, like acme.com." };
  try {
    const url = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
    if (!url.hostname.includes(".")) return { error: "Enter a website address like acme.com." };
    return { domain: url.hostname.replace(/^www\./, "").toLowerCase() };
  } catch {
    return { error: "That doesn't look like a website address. Try something like acme.com." };
  }
}
