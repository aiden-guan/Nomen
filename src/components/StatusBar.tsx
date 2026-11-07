"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

type Status = {
  naive: { ok: boolean; organization?: string; balanceUsd?: number; strategist?: boolean; error?: string };
  monid: { ok: boolean; balanceUsd?: number; error?: string };
  mobilerun: { configured: boolean };
  ffmpeg: boolean;
};

const money = (value?: number) => (typeof value === "number" ? `$${value.toFixed(2)}` : "—");

export function StatusBar() {
  const [status, setStatus] = useState<Status | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () =>
      fetch("/api/status")
        .then((response) => response.json())
        .then((data: Status) => alive && setStatus(data))
        .catch(() => undefined);
    load();
    const timer = setInterval(load, 30_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);
  if (!status) return <div className="h-6 w-48 animate-pulse rounded-full bg-white/5" />;
  const pill = (ok: boolean, label: string, value: string, title?: string) => (
    <Link href="/settings" title={title} className="flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.03] px-2.5 py-1 text-xs text-zinc-300 hover:bg-white/[0.06]">
      <span className={`size-1.5 rounded-full ${ok ? "bg-emerald-400" : "bg-rose-400"}`} />
      <span className="text-zinc-500">{label}</span>
      <span className="tabular-nums">{value}</span>
    </Link>
  );
  return (
    <div className="hidden items-center gap-2 md:flex">
      {pill(status.naive.ok && status.naive.strategist !== false, "Naive", status.naive.ok ? money(status.naive.balanceUsd) : "not connected", status.naive.error)}
      {pill(status.monid.ok, "Monid", status.monid.ok ? money(status.monid.balanceUsd) : "not connected", status.monid.error)}
      {pill(status.mobilerun.configured, "Phones", status.mobilerun.configured ? "on" : "off")}
    </div>
  );
}
