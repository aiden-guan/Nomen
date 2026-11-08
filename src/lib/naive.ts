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
  message(input: { model: string; max_tokens: number; system?: string; messages: Array<{ role: "user" | "assistant"; content: unknown }>; tools?: object[] }, timeoutMs = 120_000) {
    return this.call<{
      content: Array<{ type: string; text?: string; name?: string; input?: unknown }>;
      stop_reason: string;
      usage?: { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number };
    }>("POST", "/v1/proxy/anthropic/v1/messages", input, undefined, timeoutMs);
  }

  /**
   * The same model call, streamed. Long answers (a vision study, a page of ad copy) outlive a
   * plain request at the proxy; a stream keeps the connection busy until the last token. Returns
   * the assembled message, with tool inputs parsed and every usage field summed.
   */
  async messageStream(input: { model: string; max_tokens: number; system?: string; messages: Array<{ role: "user" | "assistant"; content: unknown }>; tools?: object[] }, timeoutMs = 600_000) {
    let response: Response;
    try {
      response = await fetch(`${this.base}/v1/proxy/anthropic/v1/messages`, {
        method: "POST",
        headers: { authorization: `Bearer ${this.key}`, "vetta-version": "2026-09-30", "content-type": "application/json", accept: "text/event-stream" },
        body: JSON.stringify({ ...input, stream: true }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new ApiError("naive", 0, "network_error", error instanceof Error ? error.message : String(error));
    }
    if (!response.ok || !response.body) {
      const raw = await response.text();
      let envelope: Record<string, unknown> = {};
      try {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        envelope = (typeof parsed.error === "object" && parsed.error ? parsed.error : parsed) as Record<string, unknown>;
      } catch {
        envelope = { message: raw.slice(0, 300) };
      }
      throw new ApiError("naive", response.status, String(envelope.code ?? envelope.type ?? response.status), String(envelope.message ?? `HTTP ${response.status}`), String(envelope.request_id ?? "") || undefined);
    }
    const blocks: Array<{ type: string; text?: string; name?: string; json?: string; input?: unknown }> = [];
    // Usage counts are cumulative and can arrive in message_start, message_delta or both: Naive's
    // proxy sends zeros at the start and the real counts (input included) in the final delta. Keep
    // the highest value seen for each field.
    const seen = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 };
    const takeUsage = (u: Record<string, unknown> | undefined) => {
      const n = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
      if (!u) return;
      seen.input = Math.max(seen.input, n(u.input_tokens));
      seen.cacheWrite = Math.max(seen.cacheWrite, n(u.cache_creation_input_tokens));
      seen.cacheRead = Math.max(seen.cacheRead, n(u.cache_read_input_tokens));
      seen.output = Math.max(seen.output, n(u.output_tokens));
    };
    let stopReason = "";
    const decoder = new TextDecoder();
    let buffer = "";
    const handle = (data: string) => {
      const event = JSON.parse(data) as Record<string, unknown>;
      const type = event.type;
      if (type === "message_start") {
        takeUsage((event.message as Record<string, unknown> | undefined)?.usage as Record<string, unknown> | undefined);
      } else if (type === "content_block_start") {
        const block = event.content_block as Record<string, unknown>;
        blocks[Number(event.index)] = { type: String(block.type), text: typeof block.text === "string" ? block.text : "", name: typeof block.name === "string" ? block.name : undefined, json: "" };
      } else if (type === "content_block_delta") {
        const block = blocks[Number(event.index)];
        const delta = event.delta as Record<string, unknown>;
        if (block && delta.type === "text_delta") block.text = `${block.text ?? ""}${String(delta.text ?? "")}`;
        if (block && delta.type === "input_json_delta") block.json = `${block.json ?? ""}${String(delta.partial_json ?? "")}`;
      } else if (type === "message_delta") {
        takeUsage(event.usage as Record<string, unknown> | undefined);
        stopReason = String((event.delta as Record<string, unknown>)?.stop_reason ?? stopReason);
      } else if (type === "error") {
        const err = (event.error ?? {}) as Record<string, unknown>;
        throw new ApiError("naive", 502, String(err.type ?? "stream_error"), String(err.message ?? "the model stream failed"));
      }
    };
    const reader = response.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let cut: number;
        while ((cut = buffer.indexOf("\n\n")) >= 0) {
          const chunk = buffer.slice(0, cut);
          buffer = buffer.slice(cut + 2);
          const data = chunk
            .split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trim())
            .join("");
          if (data) handle(data);
        }
      }
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError("naive", 0, "network_error", `the model stream broke off: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!stopReason) throw new ApiError("naive", 0, "network_error", "the model stream ended early");
    // With prompt caching, input tokens are split across three fields: count them all.
    const usage = { input_tokens: seen.input + seen.cacheWrite + seen.cacheRead, output_tokens: seen.output };
    return {
      content: blocks.filter(Boolean).map((block) => {
        if (block.type !== "tool_use") return { type: block.type, text: block.text };
        let parsed: unknown = undefined;
        try {
          parsed = block.json ? JSON.parse(block.json) : {};
        } catch {
          parsed = undefined; // a cut-off tool call: the caller falls back to reading text
        }
        return { type: "tool_use", name: block.name, input: parsed };
      }),
      stop_reason: stopReason,
      usage,
    };
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
