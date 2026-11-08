"use client";

// OWNED BY THE PHONES TRACK (see docs/handoff-dylan.md). Small pieces shared by the phones panel.
import { useEffect, useState, type ReactNode } from "react";
import { Badge, Spinner, cx } from "@/components/ui";

export type Platform = "tiktok" | "instagram" | "youtube" | "x" | "reddit";

export type SessionView = {
  id: string;
  platform: Platform;
  platformLabel: string;
  kind: "manual" | "scheduled";
  day: number | null;
  status: "pending" | "waiting" | "starting" | "queued" | "running" | "succeeded" | "failed" | "cancelled";
  minutes: number;
  steps: number | null;
  message: string | null;
  error: string | null;
  hasRecording: boolean;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
};

export type DeviceView = {
  id: string;
  name: string;
  state: string;
  label: string;
  detail: string;
  tone: "good" | "warn" | "bad" | "info" | "neutral";
  canResume: boolean;
  linkedBrandId: string | null;
  linkedBrandName: string | null;
};

export type PhonesStatus = {
  configured: boolean;
  keySource: "env" | "settings" | "none";
  brand: { id: string; name: string; domain: string };
  platforms: Array<{ id: Platform; label: string; packageName: string }>;
  vpnCountries: string[];
  session: { minutes: number; estimatedCredits: number };
  link: null | {
    deviceId: string;
    topics: string[];
    vpnCountry: string | null;
    officialConfirmedAt: string;
    accounts: Array<{ platform: Platform; credentialName: string | null }>;
    schedule: {
      enabled: boolean;
      days: number;
      startedAt: string | null;
      state: "off" | "scheduled" | "running" | "finished";
      day: number | null;
      nextAt: string | null;
      endsAt: string | null;
    };
  };
  device: DeviceView | null;
  deviceError: string | null;
  active: SessionView[];
  history: SessionView[];
};

/** JSON fetch against the phones routes; a failed call throws the route's plain-language `error`. */
export async function phonesApi<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const response = await fetch(`/api/phones${path}`, {
    method: init?.method ?? "GET",
    headers: init?.body === undefined ? undefined : { "content-type": "application/json" },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
    cache: "no-store",
  });
  const data = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) throw new Error(data.error ?? `Request failed (${response.status}).`);
  return data as T;
}

const SESSION_BADGES: Record<SessionView["status"], { label: string; tone: "neutral" | "good" | "warn" | "bad" | "info" | "accent" }> = {
  pending: { label: "Up next", tone: "neutral" },
  waiting: { label: "Waiting for phone", tone: "warn" },
  starting: { label: "Starting", tone: "info" },
  queued: { label: "Queued", tone: "info" },
  running: { label: "Running", tone: "accent" },
  succeeded: { label: "Done", tone: "good" },
  failed: { label: "Failed", tone: "bad" },
  cancelled: { label: "Stopped", tone: "neutral" },
};

export function SessionBadge({ status }: { status: SessionView["status"] }) {
  const badge = SESSION_BADGES[status];
  return (
    <Badge tone={badge.tone}>
      {(status === "running" || status === "starting") && <Spinner className="size-2.5" />}
      {badge.label}
    </Badge>
  );
}

export function RiskNotice() {
  return (
    <div className="rounded-xl border border-amber-500/20 bg-amber-500/[0.06] px-4 py-3 text-xs leading-relaxed text-amber-200/90">
      <span className="font-semibold text-amber-200">Account risk.</span> Automated activity can break a platform&apos;s terms of service and put the account at risk,
      including limits or suspension. Only link the brand&apos;s own official accounts. Warm-up only browses and watches the brand&apos;s niche, likes at most 8 videos and
      follows at most 2 creators; it never posts, comments, messages, buys anything or changes settings. Posting through the phone is a separate task: it runs only
      when a person clicks &ldquo;Post through phone&rdquo; for one video in the camp, and posts that one video on TikTok with its caption and the AI-generated label.
    </div>
  );
}

/** Re-renders every `ms` so relative times stay fresh. */
export function useNow(ms = 30_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

export function ago(iso: string | null, now: number) {
  if (!iso) return "";
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `${hours} h ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function clock(iso: string | null) {
  if (!iso) return "";
  return new Date(iso).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" });
}

export function SessionLine({ session, now, action }: { session: SessionView; now: number; action?: ReactNode }) {
  const when = session.finishedAt ?? session.startedAt ?? session.createdAt;
  const detail = session.status === "failed" ? (session.message ?? session.error) : (session.message ?? (session.error ? `Retrying: ${session.error}` : null));
  return (
    <li className="flex items-start justify-between gap-4 py-3">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2 text-sm text-zinc-100">
          <span className="font-medium">{session.platformLabel}</span>
          <SessionBadge status={session.status} />
          <span className="text-xs text-zinc-500">
            {session.kind === "scheduled" && session.day ? `Day ${session.day}` : "Run now"} · {session.minutes} min
            {session.steps != null && ` · ${session.steps} steps`} · {ago(when, now)}
          </span>
        </div>
        {detail && <p className={cx("mt-1 text-xs leading-relaxed", session.status === "failed" ? "text-rose-300/90" : "text-zinc-400")}>{detail}</p>}
      </div>
      {action}
    </li>
  );
}

export const inputClass =
  "h-9 w-full rounded-lg border border-white/10 bg-white/[0.04] px-3 text-sm text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:ring-2 focus:ring-violet-500/40";
