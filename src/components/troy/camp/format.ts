export function money(usd: number) {
  if (!Number.isFinite(usd)) return "—";
  if (usd === 0) return "$0";
  if (usd < 0.01) return "<$0.01";
  return `$${usd.toFixed(usd < 10 ? 2 : 0)}`;
}

/** "just now", "4m ago", "2h ago", or a date. */
export function ago(iso: string, now = Date.now()) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function when(iso: string | null) {
  if (!iso) return "";
  const t = new Date(iso);
  return t.toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" });
}

export const PLATFORM_NAMES: Record<string, string> = {
  tiktok: "TikTok",
  instagram: "Instagram",
  youtube: "YouTube",
  x: "X",
  facebook: "Facebook",
  linkedin: "LinkedIn",
  threads: "Threads",
  bluesky: "Bluesky",
};

export const platformName = (id: string) => PLATFORM_NAMES[id] ?? id;

/** 1234567 → "1.2M", 45200 → "45K", 950 → "950". */
export function compact(n: number | null | undefined) {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  const [value, unit] = abs >= 1e9 ? [n / 1e9, "B"] : abs >= 1e6 ? [n / 1e6, "M"] : abs >= 1e3 ? [n / 1e3, "K"] : [n, ""];
  const digits = unit && Math.abs(value) < 10 ? 1 : 0;
  return `${value.toFixed(digits).replace(/\.0$/, "")}${unit}`;
}

/** 23.4 → "0:23", 75 → "1:15". */
export function clock(seconds: number | null | undefined) {
  if (!seconds || !Number.isFinite(seconds)) return "";
  const s = Math.round(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** The lane a reference was found in, as the camp says it. */
export const LANE_NAMES: Record<string, string> = {
  competitor: "a competitor's video",
  category: "from the category",
  adjacent: "a format that transfers",
  benchmark: "famous viral benchmark",
  ad: "a live ad",
};

/** How a video relates to its reference: an organic video is an original its reference inspired. */
export const referenceVerb = (reference: { format?: string | null } | null | undefined) => (/organic/i.test(reference?.format ?? "") ? "Inspired by" : "Remake of");

/** "Remake of @creator, 1.2M views" for a video that remakes a reference ("Inspired by" for an organic one). */
export function remakeLine(reference: { author: string; views: number; outlier: number | null; paidAd?: boolean; format?: string | null } | null | undefined) {
  if (!reference?.author) return null;
  const who = `@${reference.author.replace(/^@/, "")}`;
  const verb = referenceVerb(reference);
  // Ad libraries publish no view counts: a paid ad's proof is that it kept running.
  if (reference.paidAd && !reference.views) return `${verb} ${who}'s paid ad (views unknown)`;
  return `${verb} ${who}, ${compact(reference.views)} views${reference.outlier ? ` (${reference.outlier >= 10 ? Math.round(reference.outlier) : reference.outlier.toFixed(1)}× followers)` : ""}`;
}
