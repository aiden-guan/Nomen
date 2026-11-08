import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createBrand, getCampaign, listCreatives, startCampaign } from "@/lib/pipeline";
import { advanceCreative, insertCreative, type ProductionContext } from "@/lib/production";
import { ffmpegPath } from "@/lib/media";
import { useStore } from "@/lib/store";
import { sqliteConnection, sqliteStore } from "@/lib/store/sqlite";
import type { Files, Store } from "@/lib/store/types";
import { brandView } from "@/lib/views";

// Production keeps what must outlive a tick in the store's files, by key, so it works the same on
// a machine with a disk (data/media) and on Convex (file storage). Here the store's files live in a
// temp folder, and a second "machine" (an empty local cache) must still find everything by key.

const exec = promisify(execFile);
const ffmpeg = await ffmpegPath();

let root = "";
let kept = "";
const saved: string[] = [];

/** Files like Convex's: kept in one place, read through a per-machine local copy. */
function remoteFiles(cache: string): Files {
  const at = (key: string) => join(kept, key);
  return {
    async putFile(key, path) {
      saved.push(key);
      await mkdir(dirname(at(key)), { recursive: true });
      await copyFile(path, at(key));
    },
    async saveUrl() {
      throw new Error("no network in this test");
    },
    async exists(key) {
      return existsSync(at(key));
    },
    async localPath(key) {
      if (!existsSync(at(key))) throw new Error(`no stored file ${key}`);
      const local = join(cache, key);
      await mkdir(dirname(local), { recursive: true });
      await copyFile(at(key), local);
      return local;
    },
    async url(key) {
      return existsSync(at(key)) ? `https://files.example/${key}` : null;
    },
  };
}

function storeWith(files: Files): Store {
  const db = sqliteConnection();
  for (const table of ["events", "posts", "creatives", "monid_runs", "campaigns", "brands", "settings"]) db.prepare(`delete from ${table}`).run();
  return { ...sqliteStore(), files };
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "nomen-production-files-"));
  kept = join(root, "kept");
});
afterAll(async () => {
  useStore(undefined);
  await rm(root, { recursive: true, force: true });
});

describe.skipIf(!ffmpeg)("production's files", () => {
  it("cuts the final from renders kept by key and keeps the cut by key", async () => {
    useStore(storeWith(remoteFiles(join(root, "machine-1"))));
    const brandId = await createBrand("acme.example");
    const campaignId = await startCampaign(brandId, { concepts: 1, shotsPerConcept: 1, secondsPerShot: 4, videoModel: "google/veo-3.1", learnStyle: false });
    const concept = { title: "Swap", format: "UGC", angle: "", platforms: ["tiktok"], hook: "h", creator: "", setting: "", shots: [{ frame_prompt: "f", video_prompt: "v", seconds: 2, dialogue: "" }], reference_images: [], caption: "c", hashtags: [], cta: "", inspired_by: [], why: "" };
    const id = await insertCreative(campaignId, 0, concept);

    // A render from an earlier tick, kept under its key; the cut runs on another machine that never saw it.
    const render = join(root, "render.mp4");
    await exec(ffmpeg!, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=360x640:rate=30:duration=2", "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", render]);
    await remoteFiles(join(root, "machine-1")).putFile(`${id}/shot1-r1.mp4`, render, "video/mp4");
    useStore({ ...sqliteStore(), files: remoteFiles(join(root, "machine-2")) });

    const [creative] = await listCreatives(campaignId);
    const shots = JSON.parse(creative.shots_json);
    Object.assign(shots[0], { status: "passed", local_path: `${id}/shot1-r1.mp4`, renders: 1, provider: "naive" });
    await sqliteStore().update("creatives", { id }, { shots_json: JSON.stringify(shots), status: "producing" });

    const ctx: ProductionContext = { campaignId, brandId, naive: null, monid: null, naiveOut: () => false, markNaiveOut: async () => undefined, strategy: { brand: {} } as never };
    const [row] = await listCreatives(campaignId);
    await advanceCreative(ctx, row);

    const [done] = await listCreatives(campaignId);
    expect(done).toMatchObject({ status: "ready", final_key: `${id}/final.mp4` });
    expect(saved).toContain(`${id}/final.mp4`);
    expect(existsSync(join(kept, id, "final.mp4"))).toBe(true);
    const view = (await brandView(brandId))!;
    expect(view.campaign!.creatives[0].videoUrl).toBe(`/api/media/${id}/final.mp4`);
    expect((await getCampaign(campaignId))!.id).toBe(campaignId);
  });
});
