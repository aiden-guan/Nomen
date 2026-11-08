"use client";

import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { getAutopilot, type LoopView, setAutopilot } from "../api";
import styles from "../troy.module.css";
import { money } from "./format";

// The camp's autopilot: the brand's always-on loop (src/lib/loop.ts) in Troy's style. Once the last
// campaign is done and its videos have gone out, it sends the next one by itself, every N days,
// within a weekly budget the person sets. Same rules and API as the workspace's Autopilot tab: it
// can't be turned on until the budget is filled in, and posting stays a separate opt-in.

const CODE_WORDS: Record<string, string> = {
  start: "starting",
  running: "a campaign is running",
  review: "waiting for your review",
  posting: "posts going out",
  cadence: "waiting for the next run",
  off: "off",
  no_budget: "no budget",
  too_expensive: "budget too small",
  over_budget: "over budget this week",
  error: "error",
};
const TONE: Record<string, string> = { start: "text-[var(--olive)]", running: "text-[var(--crimson)]", too_expensive: "text-[var(--crimson-dark)]", over_budget: "text-[var(--crimson-dark)]", no_budget: "text-[var(--crimson-dark)]", error: "text-[var(--crimson-dark)]" };

const when = (iso: string) => new Date(iso).toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

/** The loop's state for the top bar's button: null until loaded. */
export function useAutopilot(brandId: string | null) {
  const [view, setView] = useState<LoopView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(async () => {
    if (!brandId) return;
    try {
      setView(await getAutopilot(brandId));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [brandId]);
  useEffect(() => {
    if (!brandId) return;
    void reload();
    const timer = setInterval(() => void reload(), 15000);
    return () => clearInterval(timer);
  }, [brandId, reload]);
  return { view, setView, error, reload };
}

export function AutopilotDrawer({ brandId, autopilot, wide, onClose, onChange }: { brandId: string; autopilot: ReturnType<typeof useAutopilot>; wide: boolean; onClose: () => void; onChange?: () => void }) {
  const { view, setView, error: loadError } = autopilot;
  const [budget, setBudget] = useState("");
  const [cadence, setCadence] = useState("7");
  const [autopost, setAutopost] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const filled = useRef(false);

  const fill = useCallback((next: LoopView) => {
    setBudget(next.settings.weeklyBudgetUsd > 0 ? String(next.settings.weeklyBudgetUsd) : "");
    setCadence(String(next.settings.cadenceDays));
    setAutopost(next.settings.autopost);
    setDirty(false);
  }, []);

  // The form starts from the saved settings once; the 15 s refresh only updates the status.
  useEffect(() => {
    if (view && !filled.current) {
      filled.current = true;
      fill(view);
    }
  }, [view, fill]);
  useEffect(() => {
    headingRef.current?.focus();
  }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function save(label: string, payload: Parameters<typeof setAutopilot>[1]) {
    setBusy(label);
    setError(null);
    try {
      const next = await setAutopilot(brandId, payload);
      setView(next);
      fill(next);
      onChange?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  const form = { weeklyBudgetUsd: budget.trim() || 0, cadenceDays: Number(cadence), autopost };
  const hasBudget = Number(budget) > 0;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (dirty) void save("save", form);
  };

  return (
    <aside aria-label="Autopilot" className={`${styles.box} ${styles.enter} absolute z-20 flex flex-col ${wide ? "bottom-4 right-4 top-[76px] w-[420px]" : "inset-x-3 bottom-3 h-[64vh]"}`}>
      <header className="flex items-start gap-3 border-b-2 border-[rgba(43,29,20,0.12)] px-5 pb-3 pt-4">
        <div className="min-w-0 flex-1">
          <p className="text-[11px] uppercase tracking-wider text-[var(--ink-soft)]">The next campaign · {view ? (view.settings.enabled ? "On" : "Off") : "…"}</p>
          <h2 ref={headingRef} tabIndex={-1} className={`${styles.pixel} mt-1 text-[24px] font-semibold leading-none outline-none`}>
            Autopilot
          </h2>
          <p className="mt-2 text-[13px] leading-snug text-[var(--ink-soft)]">
            Sends the army out again by itself once the last campaign is done and its posts have gone out, within the weekly budget you set. Each campaign learns from how the last videos did.
          </p>
        </div>
        <button type="button" onClick={onClose} className={`${styles.link} ${styles.pixel} -mr-1 px-2 text-xl leading-none`} aria-label="Close">
          ×
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4 text-[13px]">
        {!view ? (
          loadError ? (
            <p role="alert" className="text-[var(--crimson-dark)]">
              {loadError}
            </p>
          ) : (
            <p className={`${styles.pixel} flex items-center gap-2 text-[var(--ink-soft)]`}>
              <span className={styles.spinner} aria-hidden="true" /> Reading the orders
            </p>
          )
        ) : (
          <>
            <div className="grid grid-cols-3 gap-2">
              <Figure label="next run" value={!view.settings.enabled ? "off" : view.status.nextRunAt ? (view.status.decision.start ? "now" : when(view.status.nextRunAt)) : "waiting"} />
              <Figure label={view.settings.weeklyBudgetUsd > 0 ? `of ${money(view.settings.weeklyBudgetUsd)} this week` : "spent this week"} value={money(view.status.spendThisWeekUsd)} />
              <Figure label="next campaign, at most" value={money(view.status.estimateUsd)} />
            </div>

            <section className="mt-5">
              <h3 className={`${styles.pixel} mb-1.5 text-[12px] uppercase tracking-wider text-[var(--ink-faint)]`}>Last decision</h3>
              <p className={`${styles.pixel} text-[13px] ${TONE[view.status.decision.code] ?? "text-[var(--ink-soft)]"}`}>{CODE_WORDS[view.status.decision.code] ?? view.status.decision.code}</p>
              <p className="mt-1 leading-snug">{view.status.decision.reason}</p>
              {view.status.last && view.status.last.reason !== view.status.decision.reason && (
                <p className="mt-1.5 text-[12px] text-[var(--ink-faint)]">
                  Before ({when(view.status.last.at)}): {view.status.last.reason}
                </p>
              )}
              {view.status.skippable && (
                <button
                  type="button"
                  disabled={busy === "skip"}
                  className={`${styles.link} ${styles.pixel} mt-2 text-[12px] underline decoration-dotted underline-offset-4`}
                  onClick={() => void save("skip", { skipCampaignId: view.status.skippable! })}
                >
                  {busy === "skip" ? "Skipping…" : "Skip these videos and move on"}
                </button>
              )}
            </section>

            <form className="mt-6 space-y-4" onSubmit={submit}>
              <label className="block">
                <span className={`${styles.pixel} text-[13px]`}>Weekly budget (USD)</span>
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
                  className={`${styles.input} mt-1 block h-10 w-full border-2 border-[rgba(43,29,20,0.2)] bg-[var(--paper)] px-2 text-[14px]`}
                />
                <span className="mt-1 block text-[12px] leading-snug text-[var(--ink-faint)]">Everything this brand&apos;s campaigns spend in any 7 days counts, including ones you start yourself.</span>
              </label>
              <label className="block">
                <span className={`${styles.pixel} text-[13px]`}>Send a campaign every (days)</span>
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
                  className={`${styles.input} mt-1 block h-10 w-24 border-2 border-[rgba(43,29,20,0.2)] bg-[var(--paper)] px-2 text-[14px]`}
                />
              </label>
              <label className="flex cursor-pointer items-start gap-2.5">
                <input
                  type="checkbox"
                  checked={autopost}
                  onChange={(event) => {
                    setAutopost(event.target.checked);
                    setDirty(true);
                  }}
                  className="mt-0.5 size-4 accent-[var(--crimson)]"
                />
                <span>
                  <span className={styles.pixel}>Post automatically</span>
                  <span className="block text-[12px] leading-snug text-[var(--ink-faint)]">
                    On: finished videos are approved and posted one a day on the brand&apos;s connected accounts. Off: they wait in the theatre for you, and autopilot waits too.
                  </span>
                </span>
              </label>

              <div className="flex flex-wrap items-center gap-3 pt-1">
                {view.settings.enabled ? (
                  <button type="button" className={`${styles.button} ${styles.pixel} h-9 px-3 text-[13px]`} disabled={busy === "off"} onClick={() => void save("off", { enabled: false })}>
                    {busy === "off" ? <span className={styles.spinner} aria-hidden="true" /> : null} Turn off
                  </button>
                ) : (
                  <button
                    type="button"
                    className={`${styles.button} ${styles.buttonInk} ${styles.pixel} h-9 px-3 text-[13px]`}
                    disabled={!hasBudget || busy === "on"}
                    onClick={() => void save("on", { ...form, enabled: true })}
                  >
                    {busy === "on" ? <span className={styles.spinner} aria-hidden="true" /> : null} Turn on
                  </button>
                )}
                <button type="submit" className={`${styles.button} ${styles.buttonQuiet} ${styles.pixel} h-9 px-3 text-[13px]`} disabled={!dirty || busy === "save"}>
                  Save
                </button>
                {!view.settings.enabled && !hasBudget && <span className="text-[12px] text-[var(--ink-faint)]">Set a weekly budget to turn it on.</span>}
              </div>
              {error && (
                <p role="alert" className="bg-[rgba(183,58,49,0.08)] px-3 py-2 text-[12px] text-[var(--crimson-dark)]">
                  {error}
                </p>
              )}
            </form>

            <p className="mt-6 text-[11px] leading-snug text-[var(--ink-faint)]">
              The estimate prices every video as a {view.assumptions.presenterSecondsPerVideo} s presenter video rendered {view.assumptions.rendersPerShot} times, plus {money(view.assumptions.untrackedUsdPerVideo)} a video for model
              calls, voice-overs and screens, plus {money(view.assumptions.campaignOverheadUsd)} for research. It over-counts on purpose.
            </p>
          </>
        )}
      </div>
    </aside>
  );
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-[rgba(43,29,20,0.05)] px-2 py-2 text-center">
      <div className={`${styles.pixel} text-[15px] leading-tight`}>{value}</div>
      <div className="mt-1 text-[10px] uppercase leading-tight tracking-wide text-[var(--ink-soft)]">{label}</div>
    </div>
  );
}
