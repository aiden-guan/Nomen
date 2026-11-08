import { body, handle } from "@/lib/api";
import { db } from "@/lib/db";
import { NaiveClient } from "@/lib/naive";
import { DEFAULTS, getSetting, SECRET_KEYS, secretStatus, type SettingKey, setSetting } from "@/lib/settings";

export const runtime = "nodejs";

const EDITABLE: SettingKey[] = [
  "video_model",
  "video_seconds",
  "shots_per_video",
  "videos_per_campaign",
  "learn_style",
  "qc_max_retries",
  "monid_video_fallback",
  "monid_video_resolution",
  "autopilot",
  "planner_model",
  "warmup_minutes",
  "static_ads_auto",
  "static_concepts",
  "static_model",
  "static_image_model",
  "static_ai_images",
];

let models: { at: number; ids: string[] } | null = null;

async function videoModels() {
  if (models && Date.now() - models.at < 10 * 60 * 1000) return models.ids;
  try {
    const ids = (await new NaiveClient().mediaModels("video")).sort();
    models = { at: Date.now(), ids };
    return ids;
  } catch {
    return [getSetting("video_model")];
  }
}

export async function GET() {
  return handle(async () =>
    Response.json({
      values: Object.fromEntries(EDITABLE.map((key) => [key, getSetting(key)])),
      secrets: Object.fromEntries(SECRET_KEYS.map((key) => [key, secretStatus(key)])),
      videoModels: await videoModels(),
    }),
  );
}

export async function POST(request: Request) {
  return handle(async () => {
    const input = await body<Record<string, unknown>>(request);
    for (const [key, raw] of Object.entries(input)) {
      if (!(key in DEFAULTS)) continue;
      const settingKey = key as SettingKey;
      const value = String(raw ?? "").trim();
      if (SECRET_KEYS.includes(settingKey)) {
        if (value === "") db().prepare("delete from settings where key = ?").run(settingKey);
        else setSetting(settingKey, value);
      } else if (EDITABLE.includes(settingKey)) {
        setSetting(settingKey, value);
      }
    }
    return Response.json({ ok: true });
  });
}
