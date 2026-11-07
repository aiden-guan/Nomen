import { describe, expect, it } from "vitest";
import { MonidClient, providerFailed, runCostMicro, TERMINAL } from "@/lib/monid";
import { firstVideoUrl } from "@/lib/production";

// Live check of the Monid video fallback (Kling 3.0, 5 s, 720p with audio: about $0.63):
// NOMEN_LIVE_FALLBACK=1 MONID_API_KEY=… npx vitest run tests/fallback.live.test.ts
describe.skipIf(!process.env.NOMEN_LIVE_FALLBACK)("Monid video fallback (live)", () => {
  it("renders a vertical clip with Kling 3.0 and returns a video link", async () => {
    const monid = new MonidClient();
    let run = await monid.run("kling", "/v1/video/kling-3.0-t2v", {
      body: {
        prompt: "Vertical 9:16 handheld smartphone video, UGC style. A woman in her thirties in a sunlit kitchen smiles and says to camera: \"Okay, this actually works.\" Photorealistic, no on-screen text.",
        resolution: "720p",
        aspect_ratio: "9:16",
        duration: 5,
        audio: "native",
      },
    });
    for (let i = 0; i < 80 && !TERMINAL.has(run.status); i++) {
      await new Promise((resolve) => setTimeout(resolve, 6000));
      run = await monid.getRun(run.runId);
    }
    expect(run.status).toBe("COMPLETED");
    expect(providerFailed(run)).toBe(false);
    const url = firstVideoUrl(run.output);
    expect(url).toMatch(/^https:\/\//);
    console.log(JSON.stringify({ runId: run.runId, url, costMicro: runCostMicro(run) }));
  }, 600_000);
});
