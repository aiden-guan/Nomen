// The core track's HTTP API, as this UI uses it. Shapes mirror `brandView()` and `brandList()` in
// src/lib/views.ts (core branch): only the fields read here are listed, so a new field there never
// breaks this side. Money arrives in dollars.

export type Stage = "research" | "style" | "strategy" | "production" | "review" | "live";
export type CampaignStatus = "running" | "review" | "publishing" | "live" | "failed";

export type RunView = {
  key: string;
  phase: string;
  provider: string;
  endpoint: string;
  status: "pending" | "running" | "done" | "failed";
  error: string | null;
  cost: number;
};

export type ShotView = {
  n: number;
  status: "pending" | "framed" | "rendering" | "rendered" | "passed" | "failed";
  provider: "naive" | "monid" | null;
  renders: number;
  frameUrl: string | null;
  qc: { score: number; pass: boolean; issues: string[] } | null;
  error: string | null;
};

export type ConceptView = {
  title: string;
  format: string;
  angle: string;
  hook: string;
  platforms: string[];
  caption: string;
  why: string;
};

export type CreativeView = {
  id: string;
  idx: number;
  generation: number;
  status: "queued" | "producing" | "ready" | "failed";
  concept: ConceptView | null;
  caption: string;
  platforms: string[];
  approved: boolean;
  videoUrl: string | null;
  posterUrl: string | null;
  qcScore: number | null;
  cost: number;
  error: string | null;
  shots: ShotView[];
};

export type PostView = {
  id: string;
  creativeId: string;
  platforms: string[];
  scheduledAt: string | null;
  status: "pending" | "scheduled" | "processing" | "posted" | "failed" | "deleted";
  error: string | null;
  analytics: Record<string, unknown> | null;
};

export type ResearchPlanView = { brand_name: string; category: string; audience: string; competitors: Array<{ name: string }>; content_queries: string[] };

export type StrategyView = {
  brand: { name: string; one_liner: string; category: string; tone: string };
  audience: Array<{ name: string; description: string }>;
  campaign: { name: string; objective: string; concepts: Array<{ title: string; angle: string; hook: string }>; posting_plan: { cadence: string } };
};

export type CampaignView = {
  id: string;
  status: CampaignStatus;
  stage: Stage;
  stageIndex: number;
  error: string | null;
  naiveOut: boolean;
  options: { concepts: number; shotsPerConcept: number; secondsPerShot: number; videoModel: string; learnStyle: boolean };
  estimateUsd: number | null;
  plan: ResearchPlanView | null;
  research: { videos: unknown[]; ads: unknown[]; reddit: unknown[]; seo: { keywords: unknown[] } } | null;
  style: { slug: string | null; version: number | null; samples: string[] } | null;
  strategy: StrategyView | null;
  runs: RunView[];
  creatives: CreativeView[];
  posts: PostView[];
  spend: { naive: number; monid: number; style: number; strategy: number };
  createdAt: string;
};

export type EventView = { ts: string; level: "info" | "warn" | "error" | string; message: string };

export type BrandView = {
  brand: { id: string; name: string; domain: string; url: string; profile: { logo: string | null; colors: string[]; description: string } | null; connected: boolean };
  campaign: CampaignView | null;
  campaigns: Array<{ id: string; status: string; stage: string; created_at: string }>;
  /** Newest first. */
  events: EventView[];
};

export type BrandListItem = {
  id: string;
  name: string;
  domain: string;
  logo: string | null;
  colors: string[];
  campaign: { id: string; status: CampaignStatus; stage: Stage; error: string | null } | null;
  ready: number;
  total: number;
};

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

/** The brand's connected social accounts (GET /api/brands/[id]/social). */
export async function socialAccounts(brandId: string) {
  return (await call<{ accounts: Array<{ platform: string; name: string; id: string }>; error?: string }>(`/api/brands/${encodeURIComponent(brandId)}/social`)).accounts;
}

/** A hosted page where the brand's owner connects its accounts; returns here afterwards. */
export async function connectLink(brandId: string, returnTo: string) {
  return (await call<{ url: string }>(`/api/brands/${encodeURIComponent(brandId)}/social`, { method: "POST", body: JSON.stringify({ returnTo }) })).url;
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
