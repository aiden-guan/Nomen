"use client";

import { type RefObject, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { type BrandView, campaignAction, getBrand } from "../api";
import type { Baker } from "../engine/baker";
import { easeInOutCubic, type Stage } from "../engine/stage";
import type { CampScene } from "../scenes/camp";
import { derive, stationOf } from "../scenes/derive";
import { STATION, type StationId, STATIONS } from "../scenes/layout";
import type { LandingScene } from "../scenes/landing";
import styles from "../troy.module.css";
import { Dispatches } from "./Dispatches";
import { ago, money } from "./format";
import { StationPanel } from "./StationPanel";

export type Engine = { stage: Stage; baker: Baker; landing: LandingScene; camp: CampScene };

type Bubble = { id: number; station: StationId; text: string; level: string };

export function Camp({ brandId, arrived, engine }: { brandId: string; arrived: boolean; engine: RefObject<Engine | null> }) {
  const [view, setView] = useState<BrandView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<StationId | null>(null);
  const [bubbles, setBubbles] = useState<Bubble[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const plan = useMemo(() => derive(view), [view]);
  const campaign = view?.campaign ?? null;
  const viewRef = useRef(view);
  viewRef.current = view;
  const reloadRef = useRef<() => void>(() => undefined);

  // --- Live data: fast while agents work, slower when the camp is waiting on you. ------------
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      clearTimeout(timer);
      try {
        const next = await getBrand(brandId);
        if (!alive) return;
        setView(next);
        setLoadError(null);
      } catch (error) {
        if (!alive) return;
        setLoadError(error instanceof Error ? error.message : String(error));
      }
      const status = viewRef.current?.campaign?.status;
      const fast = status === "running" || status === "publishing";
      if (alive && document.visibilityState === "visible") timer = setTimeout(load, fast ? 2500 : 9000);
    };
    reloadRef.current = () => void load();
    const onVisible = () => document.visibilityState === "visible" && void load();
    document.addEventListener("visibilitychange", onVisible);
    void load();
    return () => {
      alive = false;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [brandId]);

  // --- The world follows the data. ------------------------------------------------------------
  useEffect(() => {
    const e = engine.current;
    if (!e || !view || !arrived) return;
    e.camp.apply(plan);
  }, [engine, view, plan, arrived]);

  // Messengers ride when work changes hands.
  const lastStage = useRef<number | null>(null);
  const lastReady = useRef<number | null>(null);
  useEffect(() => {
    const e = engine.current;
    const stageIndex = campaign?.stageIndex;
    if (!e || !arrived || stageIndex === undefined || stageIndex < 0) return;
    if (lastStage.current !== null && stageIndex > lastStage.current) {
      e.camp.dispatch(STATIONS[lastStage.current].id, STATIONS[Math.min(5, stageIndex)].id);
    }
    lastStage.current = stageIndex;
    const ready = campaign?.creatives.filter((c) => c.status === "ready").length ?? 0;
    if (lastReady.current !== null && ready > lastReady.current) e.camp.dispatch("workshop", "theatre");
    lastReady.current = ready;
  }, [engine, arrived, campaign]);

  // New dispatches pop up over the station they concern.
  const seen = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!view) return;
    const keys = view.events.map((event) => `${event.ts}|${event.message}`);
    if (!seen.current) {
      seen.current = new Set(keys);
      return;
    }
    const fresh = view.events.filter((event, i) => !seen.current!.has(keys[i])).reverse();
    keys.forEach((key) => seen.current!.add(key));
    if (!fresh.length || !arrived) return;
    setBubbles((current) => [
      ...current.slice(-4),
      ...fresh.slice(-3).map((event, i) => ({ id: Date.now() + i, station: stationForEvent(event.message, view.campaign?.stage ?? "research"), text: event.message, level: event.level })),
    ]);
  }, [view, arrived]);
  useEffect(() => {
    if (!bubbles.length) return;
    const timer = setTimeout(() => setBubbles((current) => current.slice(1)), 6500);
    return () => clearTimeout(timer);
  }, [bubbles]);

  // --- Camera: frame the camp, or zoom to a station when its panel is open. ---------------------
  // Narrow screens can't show six islands at a readable size: they follow one station at a time,
  // picked from a strip of cards along the bottom.
  const wide = useWide();
  const [focused, setFocused] = useState<StationId | null>(null);
  const current = stationOf(campaign?.stage ?? "research");
  const shown = selected ?? focused ?? current;
  const insets = useMemo(() => ({ top: wide ? 84 : 64, bottom: wide ? 76 : 176, right: selected && wide ? 440 : 0 }), [selected, wide]);
  const frameCamera = useCallback(
    (duration: number) => {
      const e = engine.current;
      if (!e) return;
      e.camp.insets = { ...insets, bottom: selected && !wide ? Math.round(window.innerHeight * 0.58) : insets.bottom };
      const target = wide ? (selected ? e.camp.focus(selected, e.camp.insets) : e.camp.camera(e.camp.insets)) : e.camp.focus(shown, e.camp.insets);
      e.stage.look(target, duration, easeInOutCubic);
    },
    [engine, insets, selected, wide, shown],
  );
  useEffect(() => {
    if (arrived) frameCamera(0.9);
  }, [arrived, frameCamera]);
  useEffect(() => {
    const e = engine.current;
    if (!e) return;
    const previous = e.stage.onResize;
    e.stage.onResize = () => {
      if (!arrived) return previous?.(0, 0);
      frameCamera(0);
    };
    return () => {
      e.stage.onResize = previous;
    };
  }, [engine, arrived, frameCamera]);

  const act = useCallback(async (key: string, run: () => Promise<unknown>) => {
    setBusy(key);
    setActionError(null);
    try {
      await run();
      reloadRef.current();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  }, []);

  const spend = campaign ? campaign.spend.naive + campaign.spend.monid : 0;

  return (
    <>
      <TopBar view={view} spend={spend} visible={arrived} onSelect={setSelected} selected={selected} />

      {arrived && view && !wide && (
        <StationStrip
          plan={plan}
          shown={shown}
          bubbles={bubbles}
          onPick={(id) => {
            if (id === shown) setSelected(id);
            else {
              setSelected(null);
              setFocused(id);
            }
          }}
        />
      )}

      {arrived &&
        view &&
        wide &&
        STATIONS.map((station) => (
          <StationTag
            key={station.id}
            engine={engine}
            id={station.id}
            plan={plan.stations[station.id]}
            active={selected === station.id}
            onClick={() => setSelected((current) => (current === station.id ? null : station.id))}
            bubble={bubbles.filter((b) => b.station === station.id).slice(-1)[0]}
          />
        ))}

      {arrived && campaign?.status === "failed" && (
        <div role="alert" className={`${styles.box} ${styles.enter} absolute left-1/2 top-[92px] z-20 flex max-w-[min(640px,calc(100vw-32px))] -translate-x-1/2 items-center gap-4 px-4 py-3`}>
          <span className={`${styles.pixel} shrink-0 text-[var(--crimson)]`}>! Halted</span>
          <span className="min-w-0 flex-1 text-sm leading-snug">{campaign.error ?? "The campaign stopped."}</span>
          <button
            type="button"
            className={`${styles.button} ${styles.pixel} h-9 shrink-0 px-3 text-sm`}
            disabled={busy === "retry"}
            onClick={() => act("retry", () => campaignAction(campaign.id, "retry"))}
          >
            {busy === "retry" ? <span className={styles.spinner} aria-hidden="true" /> : null} Retry
          </button>
        </div>
      )}

      {arrived && view && <Dispatches events={view.events} wide={wide} />}

      {arrived && selected && view && (
        <StationPanel
          id={selected}
          view={view}
          plan={plan}
          baker={engine.current?.baker ?? null}
          wide={wide}
          busy={busy}
          error={actionError}
          act={act}
          onClose={() => setSelected(null)}
        />
      )}

      {arrived && !view && (
        <div className={`${styles.box} ${styles.enter} absolute left-1/2 top-1/2 w-[min(420px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 p-6 text-center`}>
          {loadError ? (
            <>
              <p className={`${styles.pixel} text-lg`}>We couldn&apos;t reach this camp</p>
              <p className="mt-2 text-sm text-[var(--ink-soft)]">{loadError}</p>
              <a href="/" className={`${styles.button} ${styles.pixel} mt-5 h-10 px-4 text-sm`}>
                Back to the horse
              </a>
            </>
          ) : (
            <p className={`${styles.pixel} flex items-center justify-center gap-3 text-[var(--ink-soft)]`}>
              <span className={styles.spinner} aria-hidden="true" /> Reading the dispatches
            </p>
          )}
        </div>
      )}
    </>
  );
}

const STEP_NAMES = ["Scouts", "Oracle", "War tent", "Workshop", "Theatre", "Agora"];

function TopBar({ view, spend, visible, onSelect, selected }: { view: BrandView | null; spend: number; visible: boolean; onSelect: (id: StationId | null) => void; selected: StationId | null }) {
  const campaign = view?.campaign ?? null;
  const plan = useMemo(() => derive(view), [view]);
  const stateFor = (i: number) => plan.stations[STATIONS[i].id].state;
  const current = Math.max(0, campaign?.stageIndex ?? 0);
  return (
    <header
      className={`pointer-events-none absolute inset-x-0 top-0 z-10 flex items-center gap-3 px-4 pb-6 pt-4 sm:gap-5 sm:px-6 ${visible ? styles.fadeIn : "opacity-0"}`}
      style={{ background: "linear-gradient(var(--page) 62%, rgba(246, 244, 239, 0))" }}
    >
      <a href="/" className={`${styles.pixel} ${styles.link} pointer-events-auto shrink-0 text-[20px] font-semibold text-[var(--ink)]`} aria-label="Nomen home">
        Nomen
      </a>
      {view && (
        <div className={`${styles.boxSoft} pointer-events-auto flex min-w-0 items-center gap-2.5 px-3 py-1.5`}>
          {view.brand.profile?.logo ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={view.brand.profile.logo} alt="" className="size-6 shrink-0 object-contain" />
          ) : (
            <span className={`${styles.pixel} grid size-6 shrink-0 place-items-center bg-[var(--sand)] text-xs`}>{view.brand.name[0]}</span>
          )}
          <span className="min-w-0">
            <span className="block truncate text-sm font-semibold leading-tight">{view.brand.name}</span>
            <span className="block truncate text-[11px] leading-tight text-[var(--ink-soft)]">{view.brand.domain}</span>
          </span>
        </div>
      )}

      {campaign && (
        <nav aria-label="Campaign progress" className="pointer-events-auto ml-auto hidden items-center gap-1 lg:flex">
          {STEP_NAMES.map((name, i) => {
            const state = stateFor(i);
            const id = STATIONS[i].id;
            return (
              <button
                key={id}
                type="button"
                onClick={() => onSelect(selected === id ? null : id)}
                aria-current={i === current ? "step" : undefined}
                className={`${styles.pixel} flex items-center gap-1.5 px-2 py-1 text-[13px] transition-colors ${i === current ? "text-[var(--ink)]" : "text-[var(--ink-faint)] hover:text-[var(--ink-soft)]"}`}
              >
                <Pip state={state} />
                {name}
              </button>
            );
          })}
        </nav>
      )}
      {campaign && (
        <span className={`${styles.pixel} pointer-events-auto ml-auto text-[13px] text-[var(--ink-soft)] lg:hidden`}>
          {current + 1}/6 · {STEP_NAMES[current]}
        </span>
      )}

      {campaign && (
        <span className={`${styles.pixel} pointer-events-auto hidden shrink-0 text-[13px] text-[var(--ink-soft)] sm:inline`} title={`Naive ${money(campaign.spend.naive)} · Monid ${money(campaign.spend.monid)}${campaign.estimateUsd ? ` · video budget about ${money(campaign.estimateUsd)}` : ""}`}>
          {money(spend)} spent
        </span>
      )}
      {view && (
        <a href={`/brands/${encodeURIComponent(view.brand.id)}`} className={`${styles.link} ${styles.pixel} pointer-events-auto hidden shrink-0 text-[13px] sm:inline`}>
          Workspace ↗
        </a>
      )}
    </header>
  );
}

export function Pip({ state }: { state: string }) {
  const color =
    state === "done"
      ? "var(--olive)"
      : state === "working"
        ? "var(--crimson)"
        : state === "yours"
          ? "var(--teal)"
          : state === "failed"
            ? "var(--crimson-dark)"
            : state === "skipped"
              ? "var(--ink-faint)"
              : "transparent";
  return (
    <span
      aria-hidden="true"
      className={state === "working" ? "animate-pulse" : ""}
      style={{ width: 8, height: 8, background: color, boxShadow: `0 0 0 2px ${state === "waiting" || state === "skipped" ? "var(--ink-faint)" : color}`, display: "inline-block" }}
    />
  );
}

const STATE_WORD: Record<string, string> = { waiting: "Waiting", working: "Working", done: "Done", failed: "Stopped", skipped: "Skipped", yours: "Your turn" };

function StationTag({
  engine,
  id,
  plan,
  active,
  onClick,
  bubble,
}: {
  engine: RefObject<Engine | null>;
  id: StationId;
  plan: ReturnType<typeof derive>["stations"][StationId];
  active: boolean;
  onClick: () => void;
  bubble?: Bubble;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const emoteRef = useRef<HTMLDivElement>(null);
  const station = STATION[id];
  useLayoutEffect(() => {
    const e = engine.current;
    if (!e || !ref.current) return;
    // Under the island's front edge.
    return e.stage.anchor(ref.current, () => ({ x: station.x + 34, y: station.y + 34, z: 0 }));
  }, [engine, station]);
  useLayoutEffect(() => {
    const e = engine.current;
    if (!e || !emoteRef.current) return;
    return e.stage.anchor(emoteRef.current, () => ({ x: station.x - 4, y: station.y - 4, z: 34 }));
  }, [engine, station, bubble]);
  const segments = 8;
  const filled = plan.progress === null ? 0 : Math.round(plan.progress * segments);
  const glyph = bubble ? (bubble.level === "error" ? "!" : /ready|done|learned|approved|posted/i.test(bubble.text) ? "✓" : "!") : "";
  const tone = bubble?.level === "error" ? "var(--crimson)" : bubble?.level === "warn" ? "var(--bronze)" : glyph === "✓" ? "var(--olive)" : "var(--teal)";
  return (
    <>
      <div ref={ref} className="pointer-events-none absolute left-0 top-0 z-[5] will-change-transform">
        <button
          type="button"
          onClick={onClick}
          aria-pressed={active}
          aria-label={`${station.name}, ${station.role}: ${STATE_WORD[plan.state]}. ${plan.status}`}
          className={`${active ? styles.box : styles.boxSoft} ${styles.enter} pointer-events-auto block w-[208px] -translate-x-1/2 px-3 py-2 text-left transition-transform hover:-translate-y-0.5`}
        >
          <span className="flex items-center gap-2">
            <Pip state={plan.state} />
            <span className={`${styles.pixel} text-[14px] font-semibold uppercase tracking-wide`}>{station.name}</span>
            <span className="ml-auto text-[11px] text-[var(--ink-soft)]">{station.role}</span>
          </span>
          {bubble ? (
            // A fresh dispatch replaces the status line for a few seconds.
            <span key={bubble.id} className={`${styles.fadeIn} mt-1 line-clamp-2 block text-[12px] leading-snug`} style={{ color: tone }} role="status">
              › {bubble.text}
            </span>
          ) : (
            <span className="mt-1 block truncate text-[12px] leading-snug text-[var(--ink-soft)]">{plan.status}</span>
          )}
          {plan.progress !== null && (
            <span className="mt-1.5 flex gap-[3px]" aria-hidden="true">
              {Array.from({ length: segments }, (_, i) => (
                <span
                  key={i}
                  className="h-[5px] flex-1"
                  style={{
                    background:
                      i < filled
                        ? plan.state === "failed"
                          ? "var(--crimson-dark)"
                          : plan.state === "done"
                            ? "var(--olive)"
                            : plan.state === "yours"
                              ? "var(--teal)"
                              : "var(--crimson)"
                        : "rgba(43,29,20,0.1)",
                  }}
                />
              ))}
            </span>
          )}
        </button>
      </div>
      <div ref={emoteRef} className="pointer-events-none absolute left-0 top-0 z-[6] will-change-transform" aria-hidden="true">
        {bubble && (
          <span key={bubble.id} className={`${styles.emote} ${styles.pixel}`} style={{ background: tone }}>
            {glyph}
          </span>
        )}
      </div>
    </>
  );
}

/** Narrow screens: one card per station; the camera follows the picked one. */
function StationStrip({ plan, shown, bubbles, onPick }: { plan: ReturnType<typeof derive>; shown: StationId; bubbles: Bubble[]; onPick: (id: StationId) => void }) {
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const card = listRef.current?.querySelector<HTMLElement>(`[data-station="${shown}"]`);
    card?.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
  }, [shown]);
  return (
    <nav aria-label="Stations" className="absolute inset-x-0 bottom-0 z-10 pb-[max(12px,env(safe-area-inset-bottom))]">
      <div ref={listRef} className="flex snap-x snap-mandatory gap-3 overflow-x-auto px-4 pb-2 pt-3 [scrollbar-width:none]">
        {STATIONS.map((station) => {
          const p = plan.stations[station.id];
          const bubble = bubbles.filter((b) => b.station === station.id).slice(-1)[0];
          const active = station.id === shown;
          const segments = 8;
          const filled = p.progress === null ? 0 : Math.round(p.progress * segments);
          return (
            <button
              key={station.id}
              type="button"
              data-station={station.id}
              onClick={() => onPick(station.id)}
              aria-current={active ? "true" : undefined}
              aria-label={`${station.name}, ${station.role}: ${STATE_WORD[p.state]}. ${p.status}${active ? ". Tap again for details." : ""}`}
              className={`${active ? styles.box : styles.boxSoft} w-[200px] shrink-0 snap-center px-3 py-2.5 text-left`}
            >
              <span className="flex items-center gap-2">
                <Pip state={p.state} />
                <span className={`${styles.pixel} text-[14px] font-semibold uppercase tracking-wide`}>{station.name}</span>
                <span className="ml-auto text-[11px] text-[var(--ink-soft)]">{station.role}</span>
              </span>
              <span className="mt-1 line-clamp-2 block min-h-[32px] text-[12px] leading-snug text-[var(--ink-soft)]">{bubble ? `› ${bubble.text}` : p.status}</span>
              {p.progress !== null && (
                <span className="mt-1.5 flex gap-[3px]" aria-hidden="true">
                  {Array.from({ length: segments }, (_, i) => (
                    <span key={i} className="h-[4px] flex-1" style={{ background: i < filled ? (p.state === "done" ? "var(--olive)" : p.state === "yours" ? "var(--teal)" : "var(--crimson)") : "rgba(43,29,20,0.1)" }} />
                  ))}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </nav>
  );
}

/** Which station a core event line is about. */
export function stationForEvent(message: string, stage: string): StationId {
  const m = message.toLowerCase();
  if (m.startsWith("campaign started") || /research|monid|scout|sources/.test(m)) return "scouts";
  if (/format study|studying the format|format of/.test(m)) return "oracle";
  if (/strategist|concepts, now producing|^campaign "/.test(m)) return "tent";
  if (/ready for review|approved/.test(m)) return "theatre";
  if (/post|publish|account|autopilot/.test(m)) return "agora";
  if (/shot|render|qc|kling|veo|is ready|re-render|naive is out/.test(m)) return "workshop";
  return stationOf(stage);
}

function useWide() {
  const [wide, setWide] = useState(true);
  useEffect(() => {
    const query = window.matchMedia("(min-width: 900px)");
    setWide(query.matches);
    const change = () => setWide(query.matches);
    query.addEventListener("change", change);
    return () => query.removeEventListener("change", change);
  }, []);
  return wide;
}

export { ago };
