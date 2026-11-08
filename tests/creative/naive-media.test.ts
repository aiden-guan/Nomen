import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/http";
import { NaiveClient } from "@/lib/naive";

// Request and response shapes of the NaiveClient audio, computer and browser methods, against
// the docs (usenaive.ai/docs/api/audio.md, computers.md, browser.md), behind a stubbed fetch.

type Call = { method: string; url: string; headers: Record<string, string>; body: unknown };

let calls: Call[];
let replies: Array<{ status: number; body?: unknown }>;

beforeEach(() => {
  calls = [];
  replies = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
      calls.push({ method: init?.method ?? "GET", url, headers, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const reply = replies.shift() ?? { status: 200, body: {} };
      return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), { status: reply.status, headers: { "content-type": "application/json" } });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const client = () => new NaiveClient("sk_test_example", "https://naive.test");

const transcriptionJob = {
  id: "med_01j9x3c2g8h4k5m6n7p8q9r0s1",
  object: "media_job",
  kind: "transcription",
  status: "completed",
  model: "stt/auto",
  input: { file_id: "fil_audio", language: "en", timestamps: true },
  result: {
    text: "Good morning, and thank you for joining us.",
    language: "en",
    duration_seconds: 3.4,
    segments: [{ start_seconds: 0, end_seconds: 3.4, text: "Good morning, and thank you for joining us." }],
  },
  error: null,
  cost_micro_usd: 184,
  session_id: null,
  created_at: "2026-09-06T10:00:00Z",
  completed_at: "2026-09-06T10:00:00Z",
};

describe("speech to text", () => {
  it("posts a stored file with stt/auto, timestamps and the Idempotency-Key", async () => {
    replies.push({ status: 202, body: transcriptionJob });
    const job = await client().transcribe({ file_id: "fil_audio", language: "en" }, "nomen-ref-stt-fil_audio");
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call.method).toBe("POST");
    expect(call.url).toBe("https://naive.test/v1/media/audio/transcriptions");
    expect(call.headers["idempotency-key"]).toBe("nomen-ref-stt-fil_audio");
    expect(call.headers.authorization).toBe("Bearer sk_test_example");
    expect(call.headers["vetta-version"]).toBe("2026-09-30");
    expect(call.body).toEqual({ file_id: "fil_audio", language: "en", model: "stt/auto", timestamps: true });
    expect(job.status).toBe("completed");
    expect(job.result?.segments[0]).toEqual({ start_seconds: 0, end_seconds: 3.4, text: "Good morning, and thank you for joining us." });
  });

  it("takes a public URL and an explicit model instead", async () => {
    replies.push({ status: 202, body: { ...transcriptionJob, status: "processing", result: null, cost_micro_usd: null } });
    const job = await client().transcribe({ url: "https://cdn.example.com/call.mp3", model: "openai/whisper-1", timestamps: false }, "k1");
    expect(calls[0].body).toEqual({ url: "https://cdn.example.com/call.mp3", model: "openai/whisper-1", timestamps: false });
    expect(job.status).toBe("processing");
    expect(job.result).toBeNull();
  });

  it("re-reads a queued transcription by id", async () => {
    replies.push({ status: 200, body: transcriptionJob });
    await client().getTranscription("med_01j9x3c2g8h4k5m6n7p8q9r0s1");
    expect(calls[0].method).toBe("GET");
    expect(calls[0].url).toBe("https://naive.test/v1/media/audio/transcriptions/med_01j9x3c2g8h4k5m6n7p8q9r0s1");
    expect(calls[0].body).toBeUndefined();
  });

  it("surfaces provider errors as ApiError with the code", async () => {
    replies.push({ status: 400, body: { error: { code: "validation_failed", message: "the file is not an audio or video recording", param: "file_id" } } });
    const error = await client()
      .transcribe({ file_id: "fil_image" }, "k2")
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe("validation_failed");
    expect((error as ApiError).retryable).toBe(false);
  });
});

describe("text to speech", () => {
  it("posts the text, voice, model and format and returns the stored file", async () => {
    const speech = {
      object: "speech_generation",
      model: "openai/gpt-audio-mini",
      file: {
        id: "fil_01j9x3d7k2m4n6p8q0r2s4t6u8",
        object: "file",
        name: "fil_01j9x3d7k2m4n6p8q0r2s4t6u8.wav",
        content_type: "audio/wav",
        size_bytes: 134444,
        scope: "published",
        session_id: null,
        sha256: "3f",
        created_at: "2026-09-06T10:00:01Z",
      },
      duration_seconds: 2.8,
      cost_micro_usd: 640,
    };
    replies.push({ status: 200, body: speech });
    const result = await client().speak({ text: "Your order has shipped.", voice: "coral", model: "tts/auto", format: "mp3" }, "nomen-vo-1");
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toBe("https://naive.test/v1/media/audio/speech");
    expect(calls[0].headers["idempotency-key"]).toBe("nomen-vo-1");
    expect(calls[0].body).toEqual({ text: "Your order has shipped.", voice: "coral", model: "tts/auto", format: "mp3" });
    expect(result.file.id).toMatch(/^fil_/);
    expect(result.file.content_type).toBe("audio/wav");
  });
});

describe("computers and the browser", () => {
  const computer = {
    id: "cmp_01H8YZ",
    object: "computer",
    name: "nomen-capture-monid.ai",
    vcpu: 1,
    memory_mb: 1024,
    disk_gb: 5,
    status: "creating",
    browser: { allowed_domains: ["monid.ai", "*.monid.ai"], timeout_minutes: 5, viewport: { width: 430, height: 932 }, os: "mobile" },
    volume: null,
    snapshot_id: null,
    agent_id: null,
    created_at: "2026-08-20T17:00:00Z",
  };

  it("creates a computer with a phone-shaped browser", async () => {
    replies.push({ status: 202, body: computer });
    const created = await client().createComputer(
      { name: "nomen-capture-monid.ai", vcpu: 1, memory_mb: 1024, browser: { allowed_domains: ["monid.ai", "*.monid.ai"], timeout_minutes: 5, viewport: { width: 430, height: 932 }, os: "mobile" } },
      "nomen-capture-key",
    );
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toBe("https://naive.test/v1/computers");
    expect(calls[0].headers["idempotency-key"]).toBe("nomen-capture-key");
    expect(calls[0].body).toMatchObject({ vcpu: 1, memory_mb: 1024, browser: { viewport: { width: 430, height: 932 }, os: "mobile", allowed_domains: ["monid.ai", "*.monid.ai"] } });
    expect(created.status).toBe("creating");
  });

  it("reads, pauses and destroys a computer", async () => {
    replies.push({ status: 200, body: { ...computer, status: "running" } }, { status: 200, body: { id: "cmp_01H8YZ", status: "paused" } }, { status: 200, body: { id: "cmp_01H8YZ", object: "computer", deleted: true } });
    const naive = client();
    expect((await naive.getComputer("cmp_01H8YZ")).status).toBe("running");
    expect((await naive.pauseComputer("cmp_01H8YZ")).status).toBe("paused");
    expect((await naive.deleteComputer("cmp_01H8YZ")).deleted).toBe(true);
    expect(calls.map((call) => `${call.method} ${call.url.replace("https://naive.test", "")}`)).toEqual([
      "GET /v1/computers/cmp_01H8YZ",
      "POST /v1/computers/cmp_01H8YZ/pause",
      "DELETE /v1/computers/cmp_01H8YZ",
    ]);
  });

  it("sends one browser action per request, with the key goto requires", async () => {
    const result = (extra: object) => ({ object: "browser_action", url: "https://monid.ai/", text: null, data: null, links: null, elements: null, file_id: null, performed: true, ...extra });
    replies.push(
      { status: 200, body: result({ action: "goto" }) },
      { status: 200, body: result({ action: "links", links: [{ href: "https://monid.ai/pricing", text: "Pricing" }] }) },
      { status: 200, body: result({ action: "screenshot", file_id: "fil_shot" }) },
      { status: 200, body: result({ action: "extract", text: "Monid" }) },
    );
    const naive = client();
    await naive.browserAction("cmp_01H8YZ", { action: "goto", url: "https://monid.ai/" }, "goto-1");
    const links = await naive.browserAction("cmp_01H8YZ", { action: "links", limit: 200 });
    const shot = await naive.browserAction("cmp_01H8YZ", { action: "screenshot" });
    const title = await naive.browserAction("cmp_01H8YZ", { action: "extract", selector: "title" });

    expect(calls.every((call) => call.method === "POST" && call.url === "https://naive.test/v1/computers/cmp_01H8YZ/browser/actions")).toBe(true);
    expect(calls.map((call) => call.body)).toEqual([{ action: "goto", url: "https://monid.ai/" }, { action: "links", limit: 200 }, { action: "screenshot" }, { action: "extract", selector: "title" }]);
    expect(calls[0].headers["idempotency-key"]).toBe("goto-1");
    expect(calls[2].headers["idempotency-key"]).toBeUndefined();
    expect(links.links?.[0].href).toBe("https://monid.ai/pricing");
    expect(shot.file_id).toBe("fil_shot");
    expect(title.text).toBe("Monid");
  });

  it("refuses goto and act without an Idempotency-Key before calling the API", () => {
    expect(() => client().browserAction("cmp_1", { action: "goto", url: "https://monid.ai/" })).toThrow(/Idempotency-Key/);
    expect(() => client().browserAction("cmp_1", { action: "act", instruction: "open the pricing menu" })).toThrow(/Idempotency-Key/);
    expect(calls).toHaveLength(0);
  });

  it("closes the browser, and reads a 204 (nothing open) as null", async () => {
    replies.push({ status: 200, body: { id: "brw_1", object: "browser_session", status: "closed", closed_at: "2026-08-20T17:05:00Z" } }, { status: 204 });
    const naive = client();
    expect((await naive.closeBrowser("cmp_01H8YZ"))?.status).toBe("closed");
    expect(await naive.closeBrowser("cmp_01H8YZ")).toBeNull();
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual(["DELETE https://naive.test/v1/computers/cmp_01H8YZ/browser", "DELETE https://naive.test/v1/computers/cmp_01H8YZ/browser"]);
  });
});
