import { describe, expect, it } from "vitest";
import { providerFailed, runCostMicro } from "@/lib/monid";
import { normalizeDomain } from "@/lib/pipeline";
import type { ResearchPack } from "@/lib/research";
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
  const pack = { brand: { images: ["https://brand.com/can.png"] } } as unknown as ResearchPack;
  const concept = {
    title: "T",
    format: "f",
    angle: "a",
    platforms: ["tiktok", "myspace"],
    hook: "h",
    creator: "c",
    setting: "s",
    shots: [1, 2, 3].map(() => ({ seconds: 99, frame_prompt: "f", video_prompt: "v", dialogue: "d" })),
    reference_images: ["https://brand.com/can.png", "https://evil.example/x.png"],
    caption: "Try it",
    hashtags: ["soda", "#gut health"],
    cta: "c",
    inspired_by: [],
    why: "w",
  };
  const raw = { campaign: { concepts: [concept, concept, concept] } } as unknown as Strategy;
  const options = { concepts: 2, shotsPerConcept: 2, secondsPerShot: 8, videoModel: "google/veo-3.1" };
  const strategy = normalizeStrategy(structuredClone(raw), options, pack);

  it("keeps the requested number of concepts and shots, at the requested length", () => {
    expect(strategy.campaign.concepts).toHaveLength(2);
    expect(strategy.campaign.concepts[0].shots).toHaveLength(2);
    expect(strategy.campaign.concepts[0].shots.every((shot) => shot.seconds === 8)).toBe(true);
  });

  it("drops unknown platforms and reference images that did not come from research", () => {
    expect(strategy.campaign.concepts[0].platforms).toEqual(["tiktok"]);
    expect(strategy.campaign.concepts[0].reference_images).toEqual(["https://brand.com/can.png"]);
  });

  it("formats hashtags and the caption", () => {
    expect(strategy.campaign.concepts[0].hashtags).toEqual(["#soda", "#guthealth"]);
    expect(captionFor(strategy.campaign.concepts[0])).toBe("Try it\n\n#soda #guthealth");
  });
});
