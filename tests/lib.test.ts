import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/http";
import { providerFailed, runCostMicro } from "@/lib/monid";
import { normalizeDomain } from "@/lib/pipeline";
import { captionFor, normalizeStrategy, type Strategy } from "@/lib/strategy";

describe("Monid run accounting", () => {
  it("reads the cost of a polled run in USD", () => {
    expect(runCostMicro({ runId: "r", status: "COMPLETED", cost: { value: 0.0012, currency: "USD" } })).toBe(1200);
  });

  it("reads the cost of a sync run in micro-dollars", () => {
    expect(runCostMicro({ runId: "r", status: "COMPLETED", billing: { reportedCost: { value: 20000, unit: "MICRO_DOLLAR" } } })).toBe(20000);
  });

  it("treats a provider 4xx inside a completed run as a failure", () => {
    expect(providerFailed({ runId: "r", status: "COMPLETED", providerResponse: { httpStatus: 404 } })).toBe(true);
    expect(providerFailed({ runId: "r", status: "COMPLETED", providerResponse: { httpStatus: 200 } })).toBe(false);
  });
});

describe("normalizeDomain", () => {
  it("accepts what people paste", () => {
    expect(normalizeDomain("https://www.Example.com/shop?x=1")).toEqual({ domain: "example.com", url: "https://www.example.com" });
    expect(normalizeDomain("monid.ai")).toEqual({ domain: "monid.ai", url: "https://monid.ai" });
  });

  it("rejects things that are not websites", () => {
    expect(() => normalizeDomain("hello")).toThrow();
  });
});

describe("normalizeStrategy", () => {
  const brief = {
    title: "T",
    reference_id: "ref_x",
    format: "hologram",
    angle: "a",
    audience: "devs",
    hook_plan: "h",
    keep: ["pacing"],
    change: ["topic"],
    visuals: ["s1", "evil"],
    creator: "c",
    setting: "s",
    platforms: ["tiktok", "myspace"],
    caption: "Try it",
    hashtags: ["soda", "#gut health"],
    cta: "c",
    why: "w",
  };
  const raw = { campaign: { name: "n", objective: "o", briefs: [brief, brief, brief] } } as unknown as Strategy;
  const options = { concepts: 2, shotsPerConcept: 2, secondsPerShot: 8, videoModel: "google/veo-3.1" };
  const strategy = normalizeStrategy(structuredClone(raw), options, { referenceIds: ["ref_a", "ref_b"], visualIds: ["s1", "p1"] });
  const briefs = strategy.campaign.briefs!;

  it("keeps the requested number of briefs and leaves concepts to the script room", () => {
    expect(briefs).toHaveLength(2);
    expect(strategy.campaign.concepts).toEqual([]);
  });

  it("only points at references and visuals that exist, with a known format", () => {
    expect(briefs.map((b) => b.reference_id)).toEqual(["ref_a", "ref_b"]);
    expect(briefs[0].visuals).toEqual(["s1"]);
    expect(briefs[0].format).toBe("talking_head_broll");
  });

  it("drops unknown platforms and formats hashtags and the caption", () => {
    expect(briefs[0].platforms).toEqual(["tiktok"]);
    expect(briefs[0].hashtags).toEqual(["#soda", "#guthealth"]);
    expect(captionFor({ caption: briefs[0].caption, hashtags: briefs[0].hashtags } as Parameters<typeof captionFor>[0])).toBe("Try it\n\n#soda #guthealth");
  });
});

describe("ApiError classification", () => {
  it("waits on a request that is still in flight under the same key", () => {
    const error = new ApiError("naive", 409, "idempotency_conflict", "a request with this Idempotency-Key is still in flight; retry once it has completed");
    expect(error.inFlight).toBe(true);
    expect(error.retryable).toBe(true);
    expect(error.keyConflict).toBe(false);
  });

  it("treats a reused key with a different body as a conflict, not a retry", () => {
    const error = new ApiError("naive", 409, "idempotency_conflict", "this Idempotency-Key was used with a different request body");
    expect(error.keyConflict).toBe(true);
    expect(error.retryable).toBe(false);
  });

  it("retries provider outages and recognizes an empty balance", () => {
    expect(new ApiError("naive", 502, "502", "upstream request failed").retryable).toBe(true);
    expect(new ApiError("naive", 402, "insufficient_credits", "top up").outOfCredits).toBe(true);
    expect(new ApiError("monid", 400, "400", "bad input").retryable).toBe(false);
  });
});
