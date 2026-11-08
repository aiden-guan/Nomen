import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { advanceRemake, ensureReferenceVideo, loadReference, referenceKey, takeShots } from "@/lib/creative/remake-job";
import { save, store } from "@/lib/db";
import { createBrand, listCreatives, startCampaign } from "@/lib/pipeline";
import { insertCreative, type ProductionContext } from "@/lib/production";
import { useStore } from "@/lib/store";
import { sqliteStore } from "@/lib/store/sqlite";
import type { Files } from "@/lib/store/types";
import type { Concept } from "@/lib/strategy";
import { brandView } from "@/lib/views";

// The production hook: a remake concept starts its own background job, reads its reference from the
// campaign's records, shows its renders as the creative's shots, and stays internal.

let root = "";
function folderFiles(dir: string): Files {
  const at = (key: string) => join(dir, key);
  return {
    async putFile(key, path) {
      await mkdir(dirname(at(key)), { recursive: true });
      await copyFile(path, at(key));
    },
    async saveUrl() {
      throw new Error("no network");
    },
    async exists(key) {
      return existsSync(at(key));
    },
    async localPath(key) {
      return at(key);
    },
    async url(key) {
      return at(key);
    },
  };
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "nomen-remake-job-"));
  useStore({ ...sqliteStore(), files: folderFiles(join(root, "kept")) });
});
afterAll(async () => {
  useStore(undefined);
  await rm(root, { recursive: true, force: true });
});

describe("the remake in production", () => {
  it("reads its reference from the campaign and finds the video kept by key", async () => {
    const brandId = await createBrand("remake-job.example");
    const campaignId = await startCampaign(brandId, { concepts: 1, shotsPerConcept: 1, secondsPerShot: 4, videoModel: "google/veo-3.1", learnStyle: false });
    const breakdown = { id: "ref_abc", url: "https://www.tiktok.com/@a/video/1", beats: [] };
    await save("campaigns", campaignId, { style_json: JSON.stringify({ breakdowns: [breakdown] }), research_json: JSON.stringify({ videos: [{ url: "https://www.tiktok.com/@a/video/1", media_url: "https://cdn.invalid/v.mp4" }] }) });
    expect(await loadReference(campaignId, "ref_abc")).toMatchObject({ breakdown: { id: "ref_abc" }, mediaUrl: "https://cdn.invalid/v.mp4" });
    expect(await loadReference(campaignId, "ref_missing")).toBeNull();

    const video = join(root, "ref.mp4");
    await writeFile(video, "not really a video");
    await store().files.putFile(referenceKey("ref_abc"), video, "video/mp4");
    expect(await ensureReferenceVideo({ id: "ref_abc", url: breakdown.url }, null)).toBe(join(root, "kept", "references", "ref_abc.mp4"));
    await expect(ensureReferenceVideo({ id: "ref_none", url: breakdown.url }, null)).rejects.toThrow(/save it as data\/media\/references\/ref_none\.mp4/);
  });

  it("fails at once without the providers it needs, and shows the video as internal", async () => {
    const brandId = await createBrand("remake-job-2.example");
    const campaignId = await startCampaign(brandId, { concepts: 1, shotsPerConcept: 1, secondsPerShot: 4, videoModel: "google/veo-3.1", learnStyle: false });
    const concept = { title: "Clone", format: "remake", angle: "", platforms: ["tiktok"], hook: "", creator: "", setting: "", shots: [], reference_images: [], caption: "", hashtags: [], cta: "", inspired_by: [], why: "", internal: true, brief: { format: "remake" } } as unknown as Concept;
    const id = await insertCreative(campaignId, 0, concept);
    const [row] = await listCreatives(campaignId);
    const ctx = { campaignId, brandId, naive: {}, monid: null, naiveOut: () => false, markNaiveOut: async () => undefined, strategy: {} } as unknown as ProductionContext;
    await advanceRemake(ctx, row, concept);
    const [failed] = await listCreatives(campaignId);
    expect(failed).toMatchObject({ id, status: "failed" });
    expect(failed.error).toMatch(/needs Naive .* and Monid/);
    const view = (await brandView(brandId))!;
    expect(view.campaign!.creatives[0]).toMatchObject({ internal: true, cleared: null });
  });

  it("shows each render as a take, its spend on it, and the rest of the remake's on the first", () => {
    const shots = takeShots(
      "crv_x",
      {
        takes: [
          { n: 1, layer: "s1", role: "host", inset: false, start: 0, end: 6, status: "rendered", frame_key: "crv_x/shot1-frame.png", naive_micro: 40_000, monid_micro: 1_176_000, error: null },
          { n: 2, layer: "s2-inset", role: "host", inset: true, start: 6, end: 9, status: "rendering", frame_key: null, naive_micro: 0, monid_micro: 0, error: null },
        ],
        spend: { naive_micro: 40_000, monid_micro: 1_200_000 },
        estimate: null,
      },
      { naive_micro: 5_000, monid_micro: 24_000 },
      "kling-native",
      true,
    );
    expect(shots.map((s) => [s.n, s.status, s.provider, s.frame_key, s.naive_cost, s.monid_cost])).toEqual([
      [1, "passed", "monid", "crv_x/shot1-frame.png", 45_000, 1_200_000],
      [2, "rendering", "monid", null, 0, 0],
    ]);
    expect(shots[1].prompt).toBe("host cut-out, 6.0-9.0 s of the reference");
  });
});
