import { store } from "./store";
import { sqliteConnection } from "./store/sqlite";

/** Every tunable the app reads, with its default. Secrets come from the environment first. */
export const DEFAULTS = {
  naive_api_key: "",
  monid_api_key: "",
  mobilerun_api_key: "",
  naive_base_url: "https://api.vetta.sh",
  monid_base_url: "https://api.monid.ai",
  mobilerun_base_url: "https://api.mobilerun.ai/v1",
  strategist_agent: "nomen-director",
  planner_model: "anthropic/claude-haiku-5.5",
  video_model: "google/veo-3.1",
  video_seconds: "8",
  shots_per_video: "2",
  videos_per_campaign: "4",
  learn_style: "true",
  monid_video_fallback: "true",
  monid_video_resolution: "1080p",
  qc_max_retries: "2",
  autopilot: "false",
  warmup_minutes: "12",
  /** Who renders presenter shots: Kling 3.0 on Monid with its own voice ("kling-3.0"), or the Naive video model ("naive", video_model). */
  presenter_engine: "kling-3.0",
  /** "ai": AI-made videos end to end; "creators": each brief goes to a real creator, approved by the client-taste agent. */
  production_mode: "ai",
  /** The flat fee offered to a creator for one video, in USD. */
  creator_fee_usd: "150",
  /** The finish on the final render: a touch of contrast, sharpening and grain, and the voice chain with loudness ("on" or "off", to A/B). */
  finish: "on",
  /** One-to-one remakes: who re-performs each render ("kling-native", "kling-motion", or "naive:<video model>"); see creative/presenter.ts. */
  remake_presenter: "kling-native",
  /** Our voice in a remake, where no render voices itself: fresh (an emotional read on the reference's timing), convert, or auto. */
  remake_voice: "fresh",
  /** Each render's own voice passed through ElevenLabs speech-to-speech into the persona's one voice ("on"/"off"); keeps the render's timing. */
  remake_voice_match: "off",
  /** The cost guard: a remake whose estimate is over this many dollars is refused before anything is paid for. */
  remake_max_usd: "15",
  /** Filmed monitors in a remake: track our screens into the reference's footage, use a monitor plate, or auto (track when the corners hold up). */
  remake_screens: "auto",
  /** A prebuilt Naive character (chr_…) the brand's persona is made from, instead of a portrait from words; empty for our own. */
  persona_character: "",
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

// SQLite answers in a microsecond, so it is read on every call, as before. Convex is a network
// away, so its settings are loaded once per request and per worker tick (loadSettings).
let cache: Map<string, string> | null = null;

export async function loadSettings() {
  if (store().kind === "sqlite") return;
  const rows = await store().find<{ key: string; value: string }>("settings");
  cache = new Map(rows.map((row) => [row.key, row.value]));
}

function stored(key: SettingKey): string | undefined {
  if (store().kind === "sqlite") return (sqliteConnection().prepare("select value from settings where key = ?").get(key) as { value: string } | undefined)?.value;
  return cache?.get(key);
}

export function getSetting(key: SettingKey): string {
  const envName = ENV[key];
  const fromEnv = envName ? process.env[envName] : undefined;
  if (fromEnv) return fromEnv;
  return stored(key) ?? DEFAULTS[key];
}

export async function setSetting(key: SettingKey, value: string) {
  await store().upsert("settings", ["key"], { key, value });
  cache?.set(key, value);
}

export async function deleteSetting(key: SettingKey) {
  await store().remove("settings", { key });
  cache?.delete(key);
}

export const getBool = (key: SettingKey) => getSetting(key) === "true";
export const getInt = (key: SettingKey) => Number.parseInt(getSetting(key), 10);

/** Where a secret comes from, without revealing it. */
export function secretStatus(key: SettingKey): { set: boolean; source: "env" | "settings" | "none"; hint: string } {
  const envName = ENV[key];
  const fromEnv = envName ? process.env[envName] : undefined;
  if (fromEnv) return { set: true, source: "env", hint: fromEnv === "proxy-injected" ? "injected by the network proxy" : `…${fromEnv.slice(-4)}` };
  const value = stored(key);
  if (value) return { set: true, source: "settings", hint: `…${value.slice(-4)}` };
  return { set: false, source: "none", hint: "" };
}
