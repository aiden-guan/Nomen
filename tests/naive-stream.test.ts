import { afterEach, describe, expect, it, vi } from "vitest";
import { NaiveClient } from "@/lib/naive";

// A streamed model call through Naive's proxy must report what it was billed for. Naive's proxy
// sends zeros in message_start and the real counts in the final message_delta (captured from
// api.vetta.sh on 2026-11-08); Anthropic's own API puts the input counts in message_start.

function sse(events: object[]) {
  const text = events.map((e) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
  const bytes = new TextEncoder().encode(text);
  // Split mid-event to check that chunks are reassembled.
  const cut = Math.floor(bytes.length / 2);
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(bytes.slice(0, cut));
        controller.enqueue(bytes.slice(cut));
        controller.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

const zeros = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
const toolCall = [
  { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t1", name: "verdict", input: {} } },
  { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"score":' } },
  { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "8}" } },
  { type: "content_block_stop", index: 0 },
];

async function call(events: object[]) {
  vi.stubGlobal("fetch", vi.fn(async () => sse(events)));
  const client = new NaiveClient("test-key", "https://naive.test");
  return client.messageStream({ model: "anthropic/claude-haiku-5.5", max_tokens: 10, messages: [{ role: "user", content: "hi" }] });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("streamed model calls", () => {
  it("counts input tokens that Naive's proxy reports only in the final delta", async () => {
    const reply = await call([
      { type: "message_start", message: { id: "m", type: "message", role: "assistant", content: [], usage: zeros } },
      ...toolCall,
      { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { input_tokens: 1200, output_tokens: 40, cache_read_input_tokens: 300, cache_creation_input_tokens: 50 } },
      { type: "message_stop" },
    ]);
    expect(reply.usage).toEqual({ input_tokens: 1550, output_tokens: 40 });
    expect(reply.content).toEqual([{ type: "tool_use", name: "verdict", input: { score: 8 } }]);
    expect(reply.stop_reason).toBe("tool_use");
  });

  it("counts input tokens reported at the start, as Anthropic's API does, without doubling them", async () => {
    const reply = await call([
      { type: "message_start", message: { id: "m", type: "message", role: "assistant", content: [], usage: { input_tokens: 900, output_tokens: 1, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 } } },
      ...toolCall,
      { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 40 } },
      { type: "message_stop" },
    ]);
    expect(reply.usage).toEqual({ input_tokens: 1000, output_tokens: 40 });
  });

  it("fails a stream that ends before the model finished", async () => {
    await expect(call([{ type: "message_start", message: { usage: zeros } }, ...toolCall])).rejects.toThrow(/ended early/);
  });
});
