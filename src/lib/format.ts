import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { download, extractFrames, ffmpegPath, scratchDir } from "./media";
import type { NaiveClient } from "./naive";
import { QC_MODEL } from "./qc";
import type { ResearchPack, Video } from "./research";

// The format study: what the best-performing videos in the category actually do, read from their
// frames by a vision model. Its notes steer the strategist toward formats that already win.

// Naive's model proxy takes at most 12 images per request: three videos at four frames each.
const FRAMES_PER_VIDEO = 4;

/** Up to three downloadable top videos, category searches first (they show what wins in the market). */
export function studyCandidates(pack: ResearchPack): Video[] {
  const usable = pack.videos
    .filter((video) => video.media_url && (video.platform === "tiktok" || video.platform === "instagram"))
    .filter((video) => video.duration === null || (video.duration >= 5 && video.duration <= 90));
  const category = usable.filter((video) => video.source !== "tiktok_brand");
  const brand = usable.filter((video) => video.source === "tiktok_brand");
  return [...category, ...brand].slice(0, 3);
}

export async function studyFormat(naive: NaiveClient, pack: ResearchPack, campaignId: string): Promise<{ markdown: string; urls: string[] } | null> {
  const candidates = studyCandidates(pack);
  if (candidates.length === 0 || !(await ffmpegPath())) return null;
  const dir = join(scratchDir(), `study-${campaignId}`);
  await mkdir(dir, { recursive: true });
  const studied: Array<{ video: Video; frames: Buffer[] }> = [];
  try {
    for (const [i, video] of candidates.entries()) {
      try {
        const path = await download(video.media_url!, join(dir, `v${i}.mp4`));
        studied.push({ video, frames: await extractFrames(path, FRAMES_PER_VIDEO) });
      } catch {
        // a link that expired or refused us: study the others
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  if (studied.length === 0) return null;

  const content: unknown[] = [];
  studied.forEach(({ video, frames }, i) => {
    content.push({
      type: "text",
      text: `Video ${i + 1}: ${video.platform}, @${video.author}, ${video.views.toLocaleString("en")} views, ${video.likes.toLocaleString("en")} likes, ${video.duration ? `${Math.round(video.duration)}s` : "unknown length"}${video.paid ? ", paid partnership" : ""}. Caption: ${video.caption || "(none)"}. These are ${frames.length} frames in order.`,
    });
    for (const frame of frames) content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: frame.toString("base64") } });
  });
  content.push({
    type: "text",
    text: [
      `These are the best-performing short videos around ${pack.brand.name} (${pack.brand.industry || "its category"}). Write a format study in Markdown that a creative director will use to brief new, original videos.`,
      "For each video: the hook (what is seen and likely said in the first two seconds), the shot structure, camera and framing, pacing and cuts, on-screen text style, the person on camera and their delivery, setting and lighting, and why it earns views.",
      "Then a section 'What wins here' with the patterns the videos share, and 'Rules for new videos' with concrete, reusable instructions (structure, length, hooks, delivery).",
      "Describe formats, not identities: never tell anyone to copy a specific person, their words or another brand's branding. Be specific and brief.",
    ].join("\n"),
  });

  const reply = await naive.message({ model: QC_MODEL, max_tokens: 2500, messages: [{ role: "user", content }] });
  const markdown = reply.content.map((block) => block.text ?? "").join("\n").trim();
  return markdown ? { markdown, urls: studied.map(({ video }) => video.url) } : null;
}
