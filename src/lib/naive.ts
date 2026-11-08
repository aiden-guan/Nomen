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
      240_000, // a long breakdown or script can take a few minutes to write
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

  // ---------- audio (https://usenaive.ai/docs/api/audio.md) ----------

  /**
   * Speech to text with per-segment timestamps. Usually answers an already `completed` job on the
   * 202; a long recording comes back `processing` and is re-read with `getTranscription`. The
   * catalogue's default model returns text only, so this asks for the `stt/auto` alias unless told otherwise.
   */
  transcribe(input: TranscribeInput, idempotencyKey: string) {
    const body = { ...input, model: input.model ?? "stt/auto", timestamps: input.timestamps ?? true };
    return this.call<Transcription>("POST", "/v1/media/audio/transcriptions", body, idempotencyKey, 300_000);
  }

  getTranscription(id: string) {
    return this.call<Transcription>("GET", `/v1/media/audio/transcriptions/${id}`);
  }

  /** Text to speech, synchronous: the reply carries the stored file (`fil_`). Most models answer WAV whatever `format` asks. */
  speak(input: SpeakInput, idempotencyKey: string) {
    return this.call<SpeechGeneration>("POST", "/v1/media/audio/speech", input, idempotencyKey, 180_000);
  }

  // ---------- computers and their browser (https://usenaive.ai/docs/api/computers.md, /browser.md) ----------

  /** Provisioning is asynchronous: the 202 says `creating`; poll `getComputer` until `running`. */
  createComputer(input: CreateComputerInput, idempotencyKey?: string) {
    return this.call<Computer>("POST", "/v1/computers", input, idempotencyKey);
  }

  getComputer(id: string) {
    return this.call<Computer>("GET", `/v1/computers/${id}`);
  }

  /** Stops compute billing and keeps the disk. The rest of a paid 10-minute block is not refunded. */
  pauseComputer(id: string) {
    return this.call<{ id: string; status: Computer["status"] }>("POST", `/v1/computers/${id}/pause`);
  }

  /** Permanently destroys a computer you created (an agent's own computer answers 409). */
  deleteComputer(id: string) {
    return this.call<{ id: string; object: "computer"; deleted: boolean }>("DELETE", `/v1/computers/${id}`);
  }

  /**
   * One browser action; the first one opens the browser. `goto` and `act` require an
   * Idempotency-Key, and keys never expire, so use a fresh one per navigation (a reused key replays
   * the first answer instead of navigating again).
   */
  browserAction(computerId: string, action: BrowserAction, idempotencyKey?: string) {
    if ((action.action === "goto" || action.action === "act") && !idempotencyKey) {
      throw new Error(`browser ${action.action} needs an Idempotency-Key`);
    }
    return this.call<BrowserActionResult>("POST", `/v1/computers/${computerId}/browser/actions`, action, idempotencyKey, action.action === "act" || action.action === "extract" ? 120_000 : 60_000);
  }

  /** Closes the browser and settles its minutes. Idempotent: `null` when nothing was open (204). */
  closeBrowser(computerId: string) {
    return this.call<BrowserSession | null>("DELETE", `/v1/computers/${computerId}/browser`);
  }
}

// ---------- audio types ----------

export type TranscriptSegment = { start_seconds: number; end_seconds: number; text: string };

/** Exactly one of `file_id` (a stored `fil_`) or `url` (public http(s), at most 100 MiB). */
export type TranscribeInput = ({ file_id: string; url?: never } | { url: string; file_id?: never }) & {
  /** A `kind=stt` catalogue model or the `stt/auto` alias (sent when omitted). */
  model?: string;
  /** ISO 639-1 hint, e.g. "en". Omitted, the model detects it. */
  language?: string;
  /** Per-segment timestamps; true when omitted. */
  timestamps?: boolean;
};

/** A `media_job` of `kind: "transcription"`. */
export type Transcription = {
  id: string;
  object: "media_job";
  kind: "transcription";
  status: "queued" | "processing" | "completed" | "failed";
  model: string | null;
  input: Record<string, unknown>;
  result: {
    text: string;
    language: string | null;
    duration_seconds: number | null;
    /** Empty when `timestamps: false` or on a model that reports no timings. */
    segments: TranscriptSegment[];
  } | null;
  error: { code: string; message: string } | null;
  cost_micro_usd: number | null;
  session_id: string | null;
  created_at: string;
  completed_at: string | null;
};

export type SpeakInput = {
  /** 1-4096 characters. */
  text: string;
  /** A `kind=tts` model or `tts/auto`; omitted, the catalogue's default. */
  model?: string;
  /** One of the model's voices; omitted, the model's default. */
  voice?: string;
  /** A preference; the stored file's content_type says what came back. */
  format?: "mp3" | "wav" | "ogg";
  /** 0.5-2. */
  speed?: number;
};

export type NaiveFile = {
  id: string;
  object: "file";
  name: string;
  content_type: string;
  size_bytes: number;
  scope: string;
  session_id: string | null;
  sha256: string;
  created_at: string;
};

export type SpeechGeneration = { object: "speech_generation"; model: string; file: NaiveFile; duration_seconds: number | null; cost_micro_usd: number | null };

// ---------- computer and browser types ----------

export type BrowserOptions = {
  /** Defaults to ["*"]; an explicit [] is refused. Wildcards like "*.example.com" work. */
  allowed_domains?: string[];
  /** 1-360, default 15. */
  timeout_minutes?: number;
  region?: "us-west" | "us-east" | "eu-central" | "ap-southeast";
  keep_alive?: boolean;
  /** Viewport in pixels, e.g. { width: 430, height: 932 } for a phone. */
  viewport?: { width: number; height: number };
  /** The device the browser presents as. */
  os?: "windows" | "mac" | "linux" | "mobile" | "tablet";
  block_ads?: boolean;
  solve_captchas?: boolean;
  stealth?: boolean;
  allow_writes?: boolean;
  allow_extract?: boolean;
  context_name?: string;
  persist_context?: boolean;
  human_login?: boolean;
  proxy?: boolean;
};

export type CreateComputerInput = {
  name?: string;
  /** 1-16, default 2. */
  vcpu?: number;
  /** 128-65536, default 4096. */
  memory_mb?: number;
  /** Default 5. */
  disk_gb?: number;
  /** `{}` enables a browser on the open web; null (the default) disables it. */
  browser?: BrowserOptions | null;
  snapshot_id?: string;
};

export type Computer = {
  id: string;
  object: "computer";
  name: string;
  vcpu: number;
  memory_mb: number;
  disk_gb: number;
  status: "creating" | "running" | "paused" | "failed" | "destroyed";
  browser: BrowserOptions | null;
  volume: null;
  snapshot_id: string | null;
  agent_id: string | null;
  created_at: string;
};

/** One action per request, discriminated on `action`. */
export type BrowserAction =
  | { action: "goto"; url: string }
  | { action: "click"; selector: string }
  | { action: "type"; selector: string; text: string }
  | { action: "extract"; instruction?: string; selector?: string; schema?: Record<string, unknown> }
  | { action: "act"; instruction: string; variables?: Record<string, string> }
  | { action: "observe"; instruction: string }
  /** `limit` defaults to 50, max 200. */
  | { action: "links"; contains?: string; limit?: number }
  | { action: "screenshot" };

export type BrowserActionResult = {
  object: "browser_action";
  action: BrowserAction["action"];
  /** The page URL after the action. */
  url: string;
  /** `extract` without a schema. */
  text: string | null;
  /** `extract` with a schema. */
  data: unknown;
  links: Array<{ href: string; text: string }> | null;
  elements: Array<{ selector: string; description: string }> | null;
  /** `screenshot`: the PNG's `fil_` id, never the bytes. */
  file_id: string | null;
  performed: boolean;
};

export type BrowserSession = {
  id: string;
  object: "browser_session";
  computer_id: string | null;
  session_id: string | null;
  status: "creating" | "active" | "closed" | "error";
  allowed_domains: string[];
  region: string;
  context_id: string | null;
  context_backed: boolean;
  timeout_at: string;
  opened_at: string;
  closed_at: string | null;
  created_at: string;
};
