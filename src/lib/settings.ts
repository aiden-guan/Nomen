import { db } from "./db";

/** Every tunable the app reads, with its default. Secrets come from the environment first. */
export const DEFAULTS = {
  naive_api_key: "",
  monid_api_key: "",
  mobilerun_api_key: "",
  naive_base_url: "https://api.vetta.sh",
  monid_base_url: "https://api.monid.ai",
  mobilerun_base_url: "https://api.mobilerun.ai/v1",
  strategist_agent: "nomen-strategist",
  planner_model: "anthropic/claude-haiku-5.5",
  video_model: "google/veo-3.1",
  video_seconds: "8",
  shots_per_video: "2",
  videos_per_campaign: "4",
  learn_style: "true",
  monid_video_fallback: "true",
  monid_video_resolution: "1080p",
  qc_max_retries: "1",
  autopilot: "false",
  warmup_minutes: "12",
} as const;

export type SettingKey = keyof typeof DEFAULTS;

export const SECRET_KEYS: SettingKey[] = ["naive_api_key", "monid_api_key", "mobilerun_api_key"];

const ENV: Partial<Record<SettingKey, string>> = {
  naive_api_key: "NAIVE_API_KEY",
  monid_api_key: "MONID_API_KEY",
  mobilerun_api_key: "MOBILERUN_API_KEY",
  naive_base_url: "NAIVE_BASE_URL",
  monid_base_url: "MONID_BASE_URL",
  mobilerun_base_url: "MOBILERUN_BASE_URL",
};

export function getSetting(key: SettingKey): string {
  const envName = ENV[key];
  const fromEnv = envName ? process.env[envName] : undefined;
  if (fromEnv) return fromEnv;
  const row = db().prepare("select value from settings where key = ?").get(key) as { value: string } | undefined;
  return row?.value ?? DEFAULTS[key];
}

export function setSetting(key: SettingKey, value: string) {
  db().prepare("insert into settings (key, value) values (?, ?) on conflict (key) do update set value = excluded.value").run(key, value);
}

export const getBool = (key: SettingKey) => getSetting(key) === "true";
export const getInt = (key: SettingKey) => Number.parseInt(getSetting(key), 10);

/** Where a secret comes from, without revealing it. */
export function secretStatus(key: SettingKey): { set: boolean; source: "env" | "settings" | "none"; hint: string } {
  const envName = ENV[key];
  const fromEnv = envName ? process.env[envName] : undefined;
  if (fromEnv) return { set: true, source: "env", hint: fromEnv === "proxy-injected" ? "injected by the network proxy" : `…${fromEnv.slice(-4)}` };
  const row = db().prepare("select value from settings where key = ?").get(key) as { value: string } | undefined;
  if (row?.value) return { set: true, source: "settings", hint: `…${row.value.slice(-4)}` };
  return { set: false, source: "none", hint: "" };
}
