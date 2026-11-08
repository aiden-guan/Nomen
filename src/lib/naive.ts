import { ApiError, requestJson } from "./http";
import { getSetting } from "./settings";

// Naive Managed Agents API (https://usenaive.ai/docs/api/overview). Money is integer micro-USD.

export type NaiveSession = {
  id: string;
  status: "queued" | "running" | "idle" | "completed" | "failed" | "cancelled";
  stop_reason: string | null;
  stop_code: string | null;
  consumed_micro_usd: number;
  structured_output: unknown;
  pending_actions: Array<{ kind?: string; tool_call_id: string; name: string }>;
  last_seq: number;
};

export type MediaJob = {
  id: string;
  status: "queued" | "processing" | "completed" | "failed";
  model: string | null;
  result: { files: Array<{ file_id: string; content_type: string }> } | null;
  error: { code: string; message: string } | null;
  cost_micro_usd: number | null;
};

export type ImageGeneration = {
  model: string;
  files: Array<{ id: string; content_type: string }>;
  cost_micro_usd: number;
};

export type MediaSkillBuild = {
  id: string;
  state: "setup" | "building" | "ready";
  rounds: Array<{
    n: number;
    state: "queued" | "authoring" | "rendering" | "ready" | "failed";
    skill_md: string | null;
    samples?: Array<{ url: string }>;
    spend_micro_usd: number;
    error: string | null;
  }>;
  skill: { id: string; slug: string; version: number } | null;
  spend_micro_usd: number;
};

export type SocialPost = { id: string; status: string; [key: string]: unknown };

type Page<T> = { data: T[]; has_more: boolean; next_cursor: string | null };

export class NaiveClient {
  constructor(
    private readonly key = getSetting("naive_api_key"),
    private readonly base = getSetting("naive_base_url"),
  ) {
    if (!key) throw new ApiError("naive", 401, "not_configured", "no Naive API key; add one in Settings");
  }

  private async call<T>(method: "GET" | "POST" | "PATCH" | "DELETE", path: string, body?: unknown, idempotencyKey?: string, timeoutMs?: number) {
    const headers: Record<string, string> = { authorization: `Bearer ${this.key}`, "vetta-version": "2026-09-30" };
    if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;
    // Writes are never retried here: the pipeline retries on a later tick with the same key.
    const { data } = await requestJson<T>({ service: "naive", url: `${this.base}${path}`, method, headers, body, timeoutMs, retries: method === "GET" ? 2 : 0 });
    return data;
  }

  me() {
    return this.call<{ organization: { id: string; name: string; mode: string } | null; scopes: string[] }>("GET", "/v1/me");
  }

  balance() {
    return this.call<{ balance_micro_usd: number }>("GET", "/v1/credits/balance");
  }

  async findAgent(name: string) {
    let after: string | null = null;
    do {
      const query: string = after ? `?limit=100&after=${encodeURIComponent(after)}` : "?limit=100";
      const page: Page<{ id: string; name: string }> = await this.call("GET", `/v1/agents${query}`);
      const found = page.data.find((agent) => agent.name === name);
      if (found) return found;
      after = page.has_more ? page.next_cursor : null;
    } while (after);
    return undefined;
  }

  createSession(input: { agent_id: string; message: string; output_schema?: object; structured_output_required?: boolean; budget_micro_usd?: number; metadata?: object }, idempotencyKey: string) {
    return this.call<NaiveSession>("POST", "/v1/sessions", input, idempotencyKey);
  }

  getSession(id: string) {
    return this.call<NaiveSession>("GET", `/v1/sessions/${id}`);
  }

  cancelSession(id: string) {
    return this.call<NaiveSession>("POST", `/v1/sessions/${id}/cancel`);
  }

  sendMessage(id: string, message: string, idempotencyKey: string) {
    return this.call<{ accepted_seq: number }>("POST", `/v1/sessions/${id}/messages`, { message }, idempotencyKey);
  }

  /** One model call through Naive's Messages-format proxy, billed to the organization. */
  message(input: { model: string; max_tokens: number; system?: string; messages: Array<{ role: "user" | "assistant"; content: unknown }>; tools?: object[] }) {
    return this.call<{ content: Array<{ type: string; text?: string; name?: string; input?: unknown }>; stop_reason: string }>(
      "POST",
      "/v1/proxy/anthropic/v1/messages",
      input,
      undefined,
      120_000,
    );
  }

  generateImage(input: { prompt: string; aspect_ratio?: string; image_urls?: string[]; model?: string; n?: number }, idempotencyKey: string) {
    return this.call<ImageGeneration>("POST", "/v1/media/images", input, idempotencyKey, 300_000);
  }

  generateVideo(input: { prompt: string; model?: string; seconds?: number; aspect_ratio?: string; image_urls?: string[] }, idempotencyKey: string) {
    return this.call<MediaJob>("POST", "/v1/media/videos", input, idempotencyKey);
  }

  async mediaModels(kind: "video" | "image") {
    const page = await this.call<Page<{ id: string }>>("GET", `/v1/media/models?kind=${kind}&limit=100`);
    return page.data.map((model) => model.id);
  }

  getMediaJob(id: string) {
    return this.call<MediaJob>("GET", `/v1/media/${id}`);
  }

  createMediaSkill(input: { urls: string[]; name: string; description?: string }, idempotencyKey: string) {
    return this.call<MediaSkillBuild>("POST", "/v1/media/skills", input, idempotencyKey);
  }

  getMediaSkill(id: string) {
    return this.call<MediaSkillBuild>("GET", `/v1/media/skills/${id}`);
  }

  fileUrl(fileId: string) {
    return this.call<{ url: string; expires_at: string }>("POST", `/v1/files/${fileId}/url`);
  }

  /** Two-step upload (mint a one-shot link, then PUT the bytes), up to 60 MiB. */
  async uploadFile(name: string, contentType: string, bytes: Buffer, folder = "Nomen") {
    const mint = await this.call<{ file_id: string; upload_url: string }>("POST", "/v1/files/uploads", { name, content_type: contentType, size_bytes: bytes.length, folder });
    const response = await fetch(mint.upload_url, {
      method: "PUT",
      headers: { "content-type": contentType, "content-length": String(bytes.length) },
      body: new Uint8Array(bytes),
      signal: AbortSignal.timeout(300_000),
    });
    if (!response.ok) throw new ApiError("naive", response.status, "upload_failed", (await response.text()).slice(0, 300));
    return mint.file_id;
  }

  async ensureIdentity(name: string, description: string) {
    let after: string | null = null;
    do {
      const query: string = after ? `?limit=100&after=${encodeURIComponent(after)}` : "?limit=100";
      const page: Page<{ id: string; name: string }> = await this.call("GET", `/v1/identities${query}`);
      const found = page.data.find((identity) => identity.name === name);
      if (found) return found;
      after = page.has_more ? page.next_cursor : null;
    } while (after);
    return this.call<{ id: string; name: string }>("POST", "/v1/identities", { name, description }, `identity-${name}`);
  }

  activateSocial(identity: string) {
    return this.call<unknown>("POST", `/v1/identities/${identity}/social/activate`);
  }

  socialPortal(identity: string, input: { platforms?: string[]; redirect_url?: string }) {
    return this.call<{ url: string }>("POST", `/v1/identities/${identity}/social/portal`, input);
  }

  async socialAccounts(identity: string) {
    const page = await this.call<Page<Record<string, unknown>>>("GET", `/v1/identities/${identity}/social/accounts?limit=50`);
    return page.data;
  }

  createPost(identity: string, input: { content: string; platforms: string[]; file_ids?: string[]; media_urls?: string[]; scheduled_at?: string; ai_generated: boolean; title?: string }, idempotencyKey: string) {
    return this.call<SocialPost>("POST", `/v1/identities/${identity}/social/posts`, input, idempotencyKey);
  }

  getPost(identity: string, post: string) {
    return this.call<SocialPost>("GET", `/v1/identities/${identity}/social/posts/${post}`);
  }

  postAnalytics(identity: string, post: string) {
    return this.call<Record<string, unknown>>("GET", `/v1/identities/${identity}/social/posts/${post}/analytics`);
  }
}
