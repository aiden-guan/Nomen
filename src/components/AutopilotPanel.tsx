"use client";

import { useCallback, useEffect, useState } from "react";
import type { LoopView } from "@/lib/loop";
import { Badge, Button, Card, Stat } from "./ui";

const inputClass = "h-10 w-full rounded-xl border border-white/10 bg-black/30 px-3 text-sm text-zinc-100 outline-none focus:border-violet-400/60";

const TONE = { start: "good", running: "info", review: "warn", posting: "info", cadence: "neutral", off: "neutral", no_budget: "warn", too_expensive: "bad", over_budget: "warn", error: "bad" } as const;

const when = (iso: string) => new Date(iso).toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
const money = (usd: number) => `$${usd.toFixed(2)}`;

/** The brand's always-on loop: starts the next campaign by itself, within a weekly budget the person sets. */
export function AutopilotPanel({ brandId, onChange }: { brandId: string; onChange?: () => void }) {
  const [view, setView] = useState<LoopView | null>(null);
  const [budget, setBudget] = useState("");
  const [cadence, setCadence] = useState("7");
  const [autopost, setAutopost] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fill = useCallback((next: LoopView) => {
    setView(next);
    setBudget(next.settings.weeklyBudgetUsd > 0 ? String(next.settings.weeklyBudgetUsd) : "");
    setCadence(String(next.settings.cadenceDays));
    setAutopost(next.settings.autopost);
    setDirty(false);
  }, []);

  const load = useCallback(
    async (overwriteForm: boolean) => {
      const response = await fetch(`/api/brands/${brandId}/loop`, { cache: "no-store" });
      if (!response.ok) return;
      const next = (await response.json()) as LoopView;
      if (overwriteForm) fill(next);
      else setView(next);
    },
    [brandId, fill],
  );

  useEffect(() => {
    void load(true);
    const timer = setInterval(() => void load(false), 15000);
    return () => clearInterval(timer);
  }, [load]);

  async function save(label: string, payload: Record<string, unknown>) {
    setBusy(label);
    setError(null);
    try {
      const response = await fetch(`/api/brands/${brandId}/loop`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Could not save");
      fill(data as LoopView);
      onChange?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  if (!view) return <div className="h-48 animate-pulse rounded-2xl bg-white/[0.03]" />;
  const { settings, status, assumptions } = view;
  const form = { weeklyBudgetUsd: budget.trim() || 0, cadenceDays: Number(cadence), autopost };
  const hasBudget = Number(budget) > 0;

  return (
    <Card
      title="Autopilot"
      subtitle="Starts this brand's next campaign by itself once the last one is done, its posts have gone out and the weekly budget has room. Each campaign learns from how the posted videos did."
      action={<Badge tone={settings.enabled ? "good" : "neutral"}>{settings.enabled ? "On" : "Off"}</Badge>}
    >
      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label="Next run" value={!settings.enabled ? "Off" : status.nextRunAt ? (status.decision.start ? "Now" : when(status.nextRunAt)) : "Waiting"} hint={settings.enabled ? `every ${settings.cadenceDays} days` : undefined} />
        <Stat
          label="Spent, last 7 days"
          value={money(status.spendThisWeekUsd)}
          hint={settings.weeklyBudgetUsd > 0 ? `of ${money(settings.weeklyBudgetUsd)} a week` : "no budget set"}
        />
        <Stat label="Next campaign" value={`up to ${money(status.estimateUsd)}`} hint="estimate, on the high side" />
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2 text-sm">
        <Badge tone={TONE[status.decision.code]}>{status.decision.start ? "starting" : status.decision.code.replace(/_/g, " ")}</Badge>
        <span className="min-w-0 flex-1 text-zinc-300">{status.decision.reason}</span>
        {status.skippable && (
          <Button size="sm" variant="ghost" loading={busy === "skip"} onClick={() => void save("skip", { skipCampaignId: status.skippable })}>
            Skip these videos
          </Button>
        )}
      </div>
      {status.last && status.last.reason !== status.decision.reason && (
        <p className="mt-1 text-xs text-zinc-500">
          Last decision ({when(status.last.at)}): {status.last.reason}
        </p>
      )}

      <div className="mt-5 grid gap-4 sm:grid-cols-2">
        <label className="block text-sm">
          <span className="text-zinc-300">Weekly budget (USD)</span>
          <input
            type="number"
            min={0}
            step={1}
            inputMode="decimal"
            placeholder="Required"
            value={budget}
            onChange={(event) => {
              setBudget(event.target.value);
              setDirty(true);
            }}
            className={`${inputClass} mt-1`}
          />
          <span className="mt-1 block text-xs text-zinc-500">Covers everything this brand&apos;s campaigns spend in any 7 days, including ones you start yourself.</span>
        </label>
        <label className="block text-sm">
          <span className="text-zinc-300">Start a campaign every (days)</span>
          <input
            type="number"
            min={1}
            max={60}
            step={1}
            value={cadence}
            onChange={(event) => {
              setCadence(event.target.value);
              setDirty(true);
            }}
            className={`${inputClass} mt-1`}
          />
        </label>
      </div>

      <label className="mt-4 flex items-start gap-3 text-sm">
        <input
          type="checkbox"
          checked={autopost}
          onChange={(event) => {
            setAutopost(event.target.checked);
            setDirty(true);
          }}
          className="mt-0.5 size-4 accent-violet-500"
        />
        <span>
          <span className="text-zinc-200">Post automatically</span>
          <span className="block text-xs text-zinc-500">
            On: finished videos are approved and scheduled one a day on the brand&apos;s connected accounts. Off: they wait for your approval, and autopilot waits for you.
          </span>
        </span>
      </label>

      <div className="mt-5 flex flex-wrap items-center gap-2">
        {settings.enabled ? (
          <Button variant="danger" loading={busy === "off"} onClick={() => void save("off", { enabled: false })}>
            Turn off
          </Button>
        ) : (
          <Button variant="primary" loading={busy === "on"} disabled={!hasBudget} onClick={() => void save("on", { ...form, enabled: true })}>
            Turn on
          </Button>
        )}
        <Button loading={busy === "save"} disabled={!dirty} onClick={() => void save("save", form)}>
          Save
        </Button>
        {!settings.enabled && !hasBudget && <span className="text-xs text-zinc-500">Set a weekly budget to turn autopilot on.</span>}
      </div>
      {error && <p className="mt-3 text-sm text-rose-300">{error}</p>}

      <p className="mt-5 text-xs text-zinc-500">
        How the estimate is made: every video is priced as a presenter video of {assumptions.presenterSecondsPerVideo} s rendered {assumptions.rendersPerShot} times at the video model&apos;s price, plus{" "}
        {money(assumptions.untrackedUsdPerVideo)} per video for model calls, voice-overs and screens that are not billed back one by one, plus {money(assumptions.campaignOverheadUsd)} for
        research. Past campaigns count their recorded spend plus the same {money(assumptions.untrackedUsdPerVideo)} per video. It over-counts on purpose.
      </p>
    </Card>
  );
}
