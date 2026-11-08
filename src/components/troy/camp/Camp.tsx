"use client";

import { type RefObject, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { type BrandView, campaignAction, connectLink, type CreativeView, getBrand, regenerate, setApproved } from "../api";
import type { Baker } from "../engine/baker";
import { easeInOutCubic, type Stage } from "../engine/stage";
import { projectX, projectY } from "../engine/tracer";
import type { CampScene } from "../scenes/camp";
import { activeStation, derive, stationForEvent } from "../scenes/derive";
import { STATION, type StationId, STATIONS } from "../scenes/layout";
import type { LandingScene } from "../scenes/landing";
import styles from "../troy.module.css";
import { DEMO_ID, type PublishMode } from "./demo";
import { AgentCard } from "./AgentCard";
import { Dispatches } from "./Dispatches";
import { ago, money } from "./format";
import { Screening } from "./Screening";
import { StationPanel } from "./StationPanel";
import { type DemoPlayer, useDemo } from "./useDemo";
import { useReducedMotion, useWide } from "../hooks";

export type Engine = { stage: Stage; baker: Baker; landing: LandingScene; camp: CampScene };

/** What the panels' buttons do: the core's API for a real campaign, the replay's clock in the demo. */
export type CampActions = {
  approve: (creative: CreativeView, approved: boolean) => void;
  approveAll: () => void;
  publish: (mode: PublishMode) => void;
  regenerate: (creative: CreativeView) => void;
  connect: () => void;
  retry: () => void;
  /** Opens a finished video at full height. */
  screen: (creative: CreativeView) => void;
};

type Bubble = { id: number; station: StationId; text: string; level: string };

export function Camp({ brandId, arrived, engine, home = "/" }: { brandId: string; arrived: boolean; engine: RefObject<Engine | null>; home?: string }) {
  const demo = brandId === DEMO_ID;
  const [liveView, setLiveView] = useState<BrandView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<StationId | null>(null);
  // A soldier picked on the map (or from a station's panel): their card replaces the station panel.
  const [agentId, setAgentId] = useState<string | null>(null);
  const [following, setFollowing] = useState(true);
  const openStation = useCallback((id: StationId | null) => {
    setAgentId(null);
    setSelected(id);
  }, []);
  const [bubbles, setBubbles] = useState<Bubble[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [screening, setScreening] = useState<string | null>(null);
  // The demo replays a campaign on a clock (./demo.ts) instead of reading the API.
  const player = useDemo(demo, arrived);
  const view = demo ? player.view : liveView;
  const plan = useMemo(() => derive(view), [view]);
  const campaign = view?.campaign ?? null;
  const viewRef = useRef(view);
  viewRef.current = view;
  const reloadRef = useRef<() => void>(() => undefined);

  // --- Live data: fast while agents work, slower when the camp is waiting on you. ------------
  useEffect(() => {
    if (demo) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      clearTimeout(timer);
      try {
        const next = await getBrand(brandId);
        if (!alive) return;
        setLiveView(next);
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
  }, [brandId, demo]);

  // --- The world follows the data. ------------------------------------------------------------
  // This runs before the column arrives too: the first plan is who marches out of the horse.
  useEffect(() => {
    const e = engine.current;
    if (!e || !view) return;
    e.camp.apply(plan);
  }, [engine, view, plan]);

  // The courier rides when work changes hands.
  const lastStage = useRef<number | null>(null);
  const lastReady = useRef<number | null>(null);
  useEffect(() => {
    const e = engine.current;
    const stageIndex = campaign ? STATIONS.findIndex((s) => s.id === activeStation(campaign)) : undefined;
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
  const reduced = useReducedMotion();
  const [focused, setFocused] = useState<StationId | null>(null);
  const current = activeStation(campaign);
  const shown = selected ?? focused ?? current;
  const panel = Boolean(selected || agentId);
  const insets = useMemo(() => ({ top: wide ? 84 : 64, bottom: wide ? 76 : 176, right: panel && wide ? 440 : 0 }), [panel, wide]);
  const frameCamera = useCallback(
    (duration: number) => {
      const e = engine.current;
      // While a soldier's card is open the camera follows them instead (below).
      if (!e || (agentId && following)) return;
      e.camp.insets = { ...insets, bottom: panel && !wide ? Math.round(window.innerHeight * 0.64) : insets.bottom };
      const target = wide ? (selected ? e.camp.focus(selected, e.camp.insets) : e.camp.camera(e.camp.insets)) : e.camp.focus(shown, e.camp.insets);
      e.stage.look(target, reduced ? 0 : duration, easeInOutCubic);
    },
    [engine, insets, selected, wide, shown, reduced, agentId, following, panel],
  );
  useEffect(() => {
    if (arrived) frameCamera(0.9);
  }, [arrived, frameCamera]);
  // Follow the picked soldier: ease in close, then keep them in view (clear of the card) as they move.
  useEffect(() => {
    const e = engine.current;
    if (!e) return;
    e.camp.selected = agentId;
    if (!agentId || !following || !arrived) {
      e.stage.follow = null;
      return;
    }
    const agent = plan.agents.find((a) => a.id === agentId);
    const ins = { ...insets, bottom: wide ? insets.bottom : Math.round(window.innerHeight * 0.64) };
    const zoom = e.camp.focus(agent?.station ?? current, ins).zoom;
    const dx = ins.right / 2 / zoom;
    const dy = (ins.bottom - ins.top) / 2 / zoom;
    e.stage.follow = { at: () => e.camp.position(agentId), dx, dy };
    const p = e.camp.position(agentId);
    if (p) e.stage.look({ x: projectX(p.x, p.y) + dx, y: projectY(p.x, p.y, p.z) + dy, zoom }, reduced ? 0 : 0.8, easeInOutCubic);
    return () => {
      e.stage.follow = null;
    };
    // The plan changes every tick in the demo; who is followed and how is what matters here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, agentId, following, arrived, insets, wide, reduced]);
  useEffect(
    () => () => {
      const e = engine.current;
      if (!e) return;
      e.camp.selected = null;
      e.camp.hovered = null;
      e.stage.follow = null;
    },
    [engine],
  );

  // Soldiers on the map are clickable: hover shows a ring and a pointer, a click opens their card.
  const [hinted, setHinted] = useState(true);
  useEffect(() => {
    const e = engine.current;
    if (!e || !arrived) return;
    const canvas = e.stage.element;
    const at = (event: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      return e.camp.pick(event.clientX - rect.left, event.clientY - rect.top);
    };
    const move = (event: PointerEvent) => {
      if (event.pointerType !== "mouse") return;
      const id = at(event);
      e.camp.hovered = id;
      canvas.style.cursor = id ? "pointer" : "";
    };
    const leave = () => {
      e.camp.hovered = null;
      canvas.style.cursor = "";
    };
    const click = (event: MouseEvent) => {
      const id = at(event);
      if (!id) return;
      setAgentId(id);
      setFollowing(true);
      setHinted(true);
    };
    canvas.addEventListener("pointermove", move);
    canvas.addEventListener("pointerleave", leave);
    canvas.addEventListener("click", click);
    return () => {
      canvas.removeEventListener("pointermove", move);
      canvas.removeEventListener("pointerleave", leave);
      canvas.removeEventListener("click", click);
      leave();
    };
  }, [engine, arrived]);
  // A first-time hint that the soldiers can be clicked (once per browser).
  useEffect(() => {
    if (!arrived) return;
    let seen = true;
    try {
      seen = window.localStorage.getItem("troy:agents-hint") === "1";
      window.localStorage.setItem("troy:agents-hint", "1");
    } catch {
      seen = false;
    }
    if (seen) return;
    setHinted(false);
    const timer = setTimeout(() => setHinted(true), 9000);
    return () => clearTimeout(timer);
  }, [arrived]);

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

  const campaignId = campaign?.id ?? null;
  const actions = useMemo<CampActions>(() => {
    const screen = (creative: CreativeView) => setScreening(creative.id);
    if (demo) {
      return {
        approve: (creative, value) => player.approve(creative.idx, value),
        approveAll: player.approveAll,
        publish: player.publish,
        regenerate: () => setActionError("The demo replays a finished campaign, so it can't film a new take here."),
        connect: () => undefined,
        retry: () => undefined,
        screen,
      };
    }
    return {
      approve: (creative, value) => void act(`approve:${creative.id}`, () => setApproved(creative.id, value)),
      approveAll: () => campaignId && void act("approve", () => campaignAction(campaignId, "approve_all")),
      publish: (mode) => campaignId && void act(mode, () => campaignAction(campaignId, "publish", mode)),
      regenerate: (creative) => void act(`regen:${creative.id}`, () => regenerate(creative.id)),
      connect: () =>
        void act("connect", async () => {
          const url = await connectLink(brandId, window.location.href);
          window.location.assign(url);
        }),
      retry: () => campaignId && void act("retry", () => campaignAction(campaignId, "retry")),
      screen,
    };
  }, [demo, player.approve, player.approveAll, player.publish, act, campaignId, brandId]);

  // The screening room shows finished videos; close it if its video goes away (a demo restart).
  const finishedVideos = useMemo(() => (campaign?.creatives ?? []).filter((c) => c.status === "ready").sort((a, b) => a.idx - b.idx), [campaign]);
  useEffect(() => {
    if (screening && !finishedVideos.some((c) => c.id === screening)) setScreening(null);
  }, [screening, finishedVideos]);

  const spend = campaign ? campaign.spend.naive + campaign.spend.monid : 0;

  return (
    <>
      <TopBar view={view} spend={spend} visible={arrived} onSelect={openStation} selected={selected} demo={demo ? player : undefined} home={home} />

      {arrived && view && !wide && (
        <StationStrip
          plan={plan}
          shown={shown}
          bubbles={bubbles}
          onPick={(id) => {
            if (id === shown) openStation(id);
            else {
              openStation(null);
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
            onClick={() => openStation(selected === station.id && !agentId ? null : station.id)}
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
            onClick={actions.retry}
          >
            {busy === "retry" ? <span className={styles.spinner} aria-hidden="true" /> : null} Retry
          </button>
        </div>
      )}

      {arrived && view && <Dispatches events={view.events} wide={wide} />}

      {arrived && selected && !agentId && view && (
        <StationPanel
          id={selected}
          view={view}
          plan={plan}
          baker={engine.current?.baker ?? null}
          wide={wide}
          busy={busy}
          error={actionError}
          actions={actions}
          demo={demo ? { recorded: Boolean(player.script?.recorded) } : null}
          onAgent={(id) => {
            setAgentId(id);
            setFollowing(true);
          }}
          onStation={openStation}
          onClose={() => setSelected(null)}
        />
      )}

      {arrived && agentId && view && (
        <AgentCard
          id={agentId}
          view={view}
          plan={plan}
          engine={engine}
          wide={wide}
          following={following}
          onFollow={() => setFollowing((f) => !f)}
          onStation={openStation}
          // Back to the station panel it was opened from, if any.
          onClose={() => setAgentId(null)}
        />
      )}

      {arrived && !hinted && !agentId && !selected && (
        <p role="status" className={`${styles.boxSoft} ${styles.rise} pointer-events-none absolute left-1/2 z-10 -translate-x-1/2 px-3 py-1.5 text-[12px] ${wide ? "bottom-5" : "top-[64px]"}`}>
          <span className={`${styles.pixel} text-[var(--crimson)]`}>Tip </span>Click any soldier to see what they&apos;re doing and follow them.
        </p>
      )}

      {arrived && screening && finishedVideos.length > 0 && (
        <Screening videos={finishedVideos} id={screening} onPick={setScreening} onClose={() => setScreening(null)} actions={actions} busy={busy} wide={wide} />
      )}

      {demo && player.notice && (
        <p role="status" className={`${styles.boxSoft} ${styles.enter} absolute left-1/2 top-[76px] z-30 -translate-x-1/2 px-3 py-1.5 text-[13px]`}>
          {player.notice}
        </p>
      )}

      {arrived && !view && (
        <div className={`${styles.box} ${styles.enter} absolute left-1/2 top-1/2 w-[min(420px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 p-6 text-center`}>
          {loadError ? (
            <>
              <p className={`${styles.pixel} text-lg`}>We couldn&apos;t reach this camp</p>
              <p className="mt-2 text-sm text-[var(--ink-soft)]">{loadError}</p>
              <a href={home} className={`${styles.button} ${styles.pixel} mt-5 h-10 px-4 text-sm`}>
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

function TopBar({
  view,
  spend,
  visible,
  onSelect,
  selected,
  demo,
  home,
}: {
  view: BrandView | null;
  spend: number;
  visible: boolean;
  onSelect: (id: StationId | null) => void;
  selected: StationId | null;
  demo?: DemoPlayer;
  home: string;
}) {
  const campaign = view?.campaign ?? null;
  const plan = useMemo(() => derive(view), [view]);
  const stateFor = (i: number) => plan.stations[STATIONS[i].id].state;
  const current = Math.max(0, STATIONS.findIndex((s) => s.id === activeStation(campaign)));
  return (
    <header
      className={`pointer-events-none absolute inset-x-0 top-0 z-10 flex items-center gap-3 px-4 pb-6 pt-4 sm:gap-5 sm:px-6 ${visible ? styles.fadeIn : "opacity-0"}`}
      style={{ background: "linear-gradient(var(--page) 62%, rgba(246, 244, 239, 0))" }}
    >
      <a href={home} className={`${styles.pixel} ${styles.link} pointer-events-auto shrink-0 text-[20px] font-semibold text-[var(--ink)]`} aria-label="Nomen home">
        Nomen
      </a>
      {view && (
        <div className={`${styles.boxSoft} pointer-events-auto flex min-w-0 items-center gap-2.5 px-2 py-1.5 sm:px-3`} title={`${view.brand.name} · ${view.brand.domain}`}>
          {view.brand.profile?.logo ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={view.brand.profile.logo} alt="" className="size-6 shrink-0 object-contain" />
          ) : (
            <span className={`${styles.pixel} grid size-6 shrink-0 place-items-center bg-[var(--sand)] text-xs`}>{view.brand.name[0]}</span>
          )}
          {/* On phones the name would truncate to a letter or two: the logo stands in for it there. */}
          <span className="hidden min-w-0 sm:block">
            <span className="block truncate text-sm font-semibold leading-tight">{view.brand.name}</span>
            <span className="block truncate text-[11px] leading-tight text-[var(--ink-soft)]">{view.brand.domain}</span>
          </span>
          <span className="sr-only sm:hidden">{view.brand.name}</span>
        </div>
      )}

      {demo && <DemoControls player={demo} />}
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
        <span className={`${styles.pixel} pointer-events-auto ml-auto whitespace-nowrap text-[13px] text-[var(--ink-soft)] lg:hidden`}>
          {current + 1}/6 · {STEP_NAMES[current]}
        </span>
      )}

      {campaign && (
        <span className={`${styles.pixel} pointer-events-auto hidden shrink-0 text-[13px] text-[var(--ink-soft)] sm:inline`} title={`Naive ${money(campaign.spend.naive)} · Monid ${money(campaign.spend.monid)}${campaign.estimateUsd ? ` · video budget about ${money(campaign.estimateUsd)}` : ""}`}>
          {money(spend)} spent
        </span>
      )}
      {view && !demo && (
        <a href={`/brands/${encodeURIComponent(view.brand.id)}`} className={`${styles.link} ${styles.pixel} pointer-events-auto hidden shrink-0 text-[13px] sm:inline`}>
          Workspace ↗
        </a>
      )}
    </header>
  );
}

/** The demo's badge and the presenter's buttons (the keys are listed in useDemo.ts). */
function DemoControls({ player }: { player: DemoPlayer }) {
  const label = player.script?.recorded ? "Replay" : "Demo";
  return (
    <div role="group" aria-label="Demo controls" className="pointer-events-auto flex shrink-0 items-center gap-[3px]">
      <span
        className={`${styles.pixel} flex h-[26px] items-center whitespace-nowrap bg-[var(--teal)] px-2 text-[12px] text-[var(--paper)]`}
        title={player.script?.recorded ? "A recorded campaign, replayed. Nothing is spent." : "A made-up campaign. Nothing is spent."}
      >
        {label}
        {!player.playing && !player.done ? " · paused" : ""}
        {player.auto ? " · auto" : ""}
      </span>
      <button type="button" className={styles.iconButton} onClick={player.toggle} aria-label={player.playing ? "Pause" : "Play"} title={`${player.playing ? "Pause" : "Play"} (Space)`}>
        <PixelIcon name={player.playing ? "pause" : "play"} />
      </button>
      <button type="button" className={styles.iconButton} onClick={player.next} aria-label="Skip to the next step" title="Skip to the next step (→). At the review this approves and posts every video.">
        <PixelIcon name="skip" />
      </button>
      <button type="button" className={`${styles.iconButton} ${styles.wideOnly}`} onClick={player.restart} aria-label="Replay from the start" title="Replay from the start (R)">
        <PixelIcon name="restart" />
      </button>
    </div>
  );
}

const ICONS = {
  play: "M4 3h2v9h-2zM6 4h1v7h-1zM7 5h1v5h-1zM8 6h1v3h-1zM9 7h1v1h-1z",
  pause: "M3 3h3v8h-3zM8 3h3v8h-3z",
  skip: "M3 3h2v8h-2zM5 4h1v6h-1zM6 5h1v4h-1zM7 6h1v2h-1zM9 3h2v8h-2z",
  restart: "M4 2h6v2h-6zM2 4h2v6h-2zM4 10h6v2h-6zM10 7h2v3h-2zM10 0h1v1h1v1h1v2h-1v1h-1v1h-1z",
};

function PixelIcon({ name }: { name: keyof typeof ICONS }) {
  return (
    <svg viewBox="0 0 14 14" width="14" height="14" fill="currentColor" shapeRendering="crispEdges" aria-hidden="true">
      <path d={ICONS[name]} />
    </svg>
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
    // Up and to the right of the island, clear of the tower, the shrine and the screen.
    return e.stage.anchor(emoteRef.current, () => ({ x: station.x + 26, y: station.y - 26, z: 38 }));
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


export { ago };
