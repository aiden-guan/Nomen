"use client";

import { type RefObject, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { type BrandView, campaignAction, connectLink, type CreativeView, getBrand, regenerate, setApproved } from "../api";
import type { Baker } from "../engine/baker";
import { easeInOutCubic, type Stage } from "../engine/stage";
import { projectX, projectY } from "../engine/tracer";
import type { CampScene } from "../scenes/camp";
import { activeStation, derive, stationForEvent } from "../scenes/derive";
import { type BattlePlan, type Company } from "../scenes/battle";
import { type Land, LAND_RADIUS, type LandId, LANDS, ROME_LINES, romePoint, STATION, type StationId, STATIONS } from "../scenes/layout";
import type { LandingScene } from "../scenes/landing";
import styles from "../troy.module.css";
import { DEMO_ID, type PublishMode } from "./demo";
import { AgentCard } from "./AgentCard";
import { Dispatches } from "./Dispatches";
import { Icon } from "./ui";
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
  // The viewer zoomed or dragged the map: the camera is theirs until they fit the view again or
  // open something (a station, a soldier), which the camera frames for them.
  const [manual, setManual] = useState(false);
  const manualRef = useRef(false);
  /** The camera's follow while it rides with the fleet (so it can let go when the fleet arrives). */
  const fleetFollow = useRef<{ at: () => { x: number; y: number; z: number } | null; dx: number; dy: number } | null>(null);
  const takeCamera = useCallback(
    (mine: boolean) => {
      manualRef.current = mine;
      setManual(mine);
      // A viewer who takes the camera stops riding along with the fleet.
      const stage = engine.current?.stage;
      if (mine && stage && fleetFollow.current && stage.follow === fleetFollow.current) stage.follow = null;
    },
    [engine],
  );
  const openStation = useCallback(
    (id: StationId | null) => {
      setAgentId(null);
      setSelected(id);
      takeCamera(false);
    },
    [takeCamera],
  );
  const [bubbles, setBubbles] = useState<Bubble[]>([]);
  // Lines the soldiers call out, over their heads for a few seconds.
  const [lines, setLines] = useState<Array<{ key: number; id: string; text: string; seconds: number }>>([]);
  useEffect(() => {
    const e = engine.current;
    if (!e) return;
    const timers: Array<ReturnType<typeof setTimeout>> = [];
    let next = 0;
    e.camp.events.onSay = (line) => {
      const key = ++next;
      setLines((all) => [...all.filter((l) => l.id !== line.id), { key, id: line.id, text: line.text, seconds: line.seconds }]);
      timers.push(setTimeout(() => setLines((all) => all.filter((l) => l.key !== key)), line.seconds * 1000));
    };
    return () => {
      e.camp.events.onSay = undefined;
      timers.forEach(clearTimeout);
    };
  }, [engine]);
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
  // picked from a strip of cards along the bottom. The lands the scouts ride to lie far to the west,
  // out of view unless you zoom out to them.
  const wide = useWide();
  const reduced = useReducedMotion();
  const [focused, setFocused] = useState<StationId | null>(null);
  const current = activeStation(campaign);
  const shown = selected ?? focused ?? current;
  const panel = Boolean(selected || agentId);
  const insets = useMemo(() => ({ top: wide ? 84 : 64, bottom: wide ? 76 : 176, right: panel && wide ? 440 : 0 }), [panel, wide]);
  // Once the videos go out, the agora's army sails for the rival's city: the camera goes with it,
  // from the harbour below the agora, along with the fleet across the sea, to the battle there.
  const battling = plan.battle.phase === "advance" || plan.battle.phase === "clash";
  const [voyage, setVoyage] = useState<"harbor" | "fleet" | "rome" | null>(null);
  // Each company's part of the story (boarding, under sail, fighting...), and whether the city has fallen.
  const [fleetWords, setFleetWords] = useState<string[]>([]);
  const [taken, setTaken] = useState(false);

  // What the map shows changes with the camp, not only with the data: polled a few times a second.
  const [busyLands, setBusyLands] = useState<Partial<Record<LandId, number>>>({});
  // How much the labels on the map say: 2 in full, 1 names only (zoomed out), 0 a marker (far out).
  const [detail, setDetail] = useState<0 | 1 | 2>(2);
  useEffect(() => {
    const e = engine.current;
    if (!e || !arrived) return;
    let lastKey = "";
    const poll = () => {
      // The lands are out of view unless you zoom out to them; their labels count the scouts there.
      const busy = e.camp.landsBusy();
      const key = JSON.stringify(busy);
      if (key !== lastKey) {
        lastKey = key;
        setBusyLands(busy);
      }
      // Where the expedition is: the camera follows it.
      setVoyage(e.camp.expedition.focus()?.kind ?? null);
      const words = e.camp.expedition.stages();
      setFleetWords((old) => (old.length === words.length && old.every((w, i) => w === words[i]) ? old : words));
      setTaken(e.camp.expedition.taken);
      // Zoomed out, the labels shrink so the map stays readable: to their names, then to markers.
      const zoom = e.stage.camera.zoom;
      setDetail(zoom >= Math.max(1.6, e.camp.camera(e.camp.insets).zoom * 0.8) ? 2 : zoom >= 0.95 ? 1 : 0);
    };
    poll();
    const timer = setInterval(poll, 250);
    return () => clearInterval(timer);
  }, [engine, arrived]);

  const frameCamera = useCallback(
    (duration: number) => {
      const e = engine.current;
      if (!e) return;
      e.camp.insets = { ...insets, bottom: panel && !wide ? Math.round(window.innerHeight * 0.64) : battling && wide && !panel ? 128 : insets.bottom };
      // While a soldier's card is open the camera follows them instead (below); a viewer who moved
      // the camera keeps it.
      if ((agentId && following) || manualRef.current) return;
      const ins = e.camp.insets;
      // The expedition holds the camera while it is under way, unless a station's panel is open.
      const sailing = battling && voyage && (wide ? !selected || selected === "agora" : shown === "agora" && !panel);
      const fleet = sailing && voyage === "fleet";
      if (e.stage.follow && fleetFollow.current && e.stage.follow === fleetFollow.current && !fleet) e.stage.follow = null;
      if (fleet) {
        // Ride along with the fleet across the sea.
        const zoom = e.camp.fleetZoom(ins);
        const follow = {
          at: () => {
            const f = e.camp.expedition.focus();
            return f?.kind === "fleet" ? f.at : null;
          },
          dx: ins.right / 2,
          dy: (ins.bottom - ins.top) / 2,
        };
        fleetFollow.current = follow;
        e.stage.follow = follow;
        const at = follow.at();
        if (at) e.stage.look({ x: projectX(at.x, at.y) + follow.dx / zoom, y: projectY(at.x, at.y, 0) + follow.dy / zoom, zoom }, reduced ? 0 : Math.max(duration, 1.2), easeInOutCubic);
        return;
      }
      const target = sailing
        ? voyage === "rome"
          ? e.camp.romeView(ins)
          : e.camp.harborView(ins)
        : wide
          ? selected
            ? e.camp.focus(selected, ins)
            : e.camp.camera(ins)
          : e.camp.focus(shown, ins);
      e.stage.look(target, reduced ? 0 : sailing ? Math.max(duration, 1.4) : duration, easeInOutCubic);
    },
    [engine, insets, selected, wide, shown, reduced, agentId, following, panel, battling, voyage],
  );
  useEffect(() => {
    if (arrived) frameCamera(1);
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
    // CSS px from the soldier to the camera's centre, so they sit in the middle of the open map.
    const dx = ins.right / 2;
    const dy = (ins.bottom - ins.top) / 2;
    e.stage.follow = { at: () => e.camp.position(agentId), dx, dy };
    const p = e.camp.position(agentId);
    if (p) e.stage.look({ x: projectX(p.x, p.y) + dx / zoom, y: projectY(p.x, p.y, p.z) + dy / zoom, zoom }, reduced ? 0 : 0.8, easeInOutCubic);
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
      e.stage.bounds = null;
    },
    [engine],
  );

  // The viewer's own camera: buttons and keys zoom a step around the middle of the open map
  // (around the followed soldier, who stays put), and Fit hands the camera back.
  const limitCamera = useCallback(() => {
    const e = engine.current;
    if (!e) return;
    const limits = e.camp.limits(e.camp.insets);
    e.stage.bounds = limits.bounds;
    e.stage.zoomRange = limits.zoom;
  }, [engine]);
  const zoomBy = useCallback(
    (direction: 1 | -1) => {
      const e = engine.current;
      if (!e) return;
      limitCamera();
      const { width, height } = e.stage.size;
      const ins = e.camp.insets;
      e.stage.zoomStep(direction, e.stage.follow ? undefined : { x: (width - ins.right) / 2, y: (ins.top + height - ins.bottom) / 2 });
      takeCamera(true);
    },
    [engine, limitCamera, takeCamera],
  );
  const fitView = useCallback(() => {
    takeCamera(false);
    if (agentId && following) setFollowing(false);
    else frameCamera(0.7);
  }, [takeCamera, agentId, following, frameCamera]);
  useEffect(() => {
    if (!arrived) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (target?.closest("input, textarea, select, [contenteditable='true']")) return;
      if (event.key === "+" || event.key === "=") zoomBy(1);
      else if (event.key === "-" || event.key === "_") zoomBy(-1);
      else if (event.key === "0") fitView();
      else return;
      event.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [arrived, zoomBy, fitView]);

  // The map takes the pointer: the wheel (or a trackpad pinch) zooms toward the pointer, a drag
  // pans, two fingers pinch. A press that doesn't move is a click: it picks the soldier under it,
  // and a mouse hovering over a soldier rings them.
  const [hinted, setHinted] = useState(true);
  useEffect(() => {
    const e = engine.current;
    if (!e || !arrived) return;
    const canvas = e.stage.element;
    const local = (event: { clientX: number; clientY: number }) => {
      const rect = canvas.getBoundingClientRect();
      return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    };
    const own = () => {
      if (!manualRef.current) takeCamera(true);
    };
    const pointers = new Map<number, { x: number; y: number }>();
    let press: { x: number; y: number } | null = null;
    let dragging = false;
    let pinch: { dist: number; mid: { x: number; y: number } } | null = null;
    const fingers = () => {
      const [a, b] = [...pointers.values()];
      return { dist: Math.hypot(a.x - b.x, a.y - b.y), mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
    };
    const hover = (p: { x: number; y: number } | null) => {
      const id = p ? e.camp.pick(p.x, p.y) : null;
      e.camp.hovered = id;
      canvas.style.cursor = dragging ? "grabbing" : id ? "pointer" : "grab";
    };
    const down = (event: PointerEvent) => {
      if (event.pointerType === "mouse" && event.button !== 0) return;
      limitCamera();
      canvas.setPointerCapture?.(event.pointerId);
      const p = local(event);
      pointers.set(event.pointerId, p);
      if (pointers.size === 1) {
        press = p;
        dragging = false;
      } else if (pointers.size === 2) {
        pinch = fingers();
        dragging = true;
      }
    };
    const move = (event: PointerEvent) => {
      const p = local(event);
      const last = pointers.get(event.pointerId);
      if (!last) {
        if (event.pointerType === "mouse") hover(p);
        return;
      }
      if (pointers.size >= 2) {
        pointers.set(event.pointerId, p);
        if (!pinch) return;
        const now = fingers();
        e.stage.zoomToward(now.dist / Math.max(1, pinch.dist), now.mid, { instant: true });
        e.stage.panBy(now.mid.x - pinch.mid.x, now.mid.y - pinch.mid.y);
        pinch = now;
        own();
        return;
      }
      // A small wobble is still a click.
      if (!dragging && press && Math.hypot(p.x - press.x, p.y - press.y) < (event.pointerType === "mouse" ? 4 : 9)) return;
      if (!dragging) {
        dragging = true;
        own();
        // Dragging the map lets go of a followed soldier.
        setFollowing(false);
        hover(null);
      }
      e.stage.panBy(p.x - last.x, p.y - last.y);
      pointers.set(event.pointerId, p);
    };
    const up = (event: PointerEvent) => {
      if (!pointers.delete(event.pointerId)) return;
      if (pinch && pointers.size < 2) {
        pinch = null;
        e.stage.settleZoom();
      }
      if (pointers.size > 0) return;
      const p = local(event);
      if (!dragging && event.type === "pointerup") {
        const id = e.camp.pick(p.x, p.y);
        if (id) {
          setAgentId(id);
          setFollowing(true);
          setHinted(true);
          takeCamera(false);
        }
      }
      dragging = false;
      press = null;
      if (event.pointerType === "mouse") hover(p);
    };
    const leave = () => {
      if (pointers.size) return;
      e.camp.hovered = null;
      canvas.style.cursor = "";
    };
    let settle: ReturnType<typeof setTimeout> | undefined;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      limitCamera();
      const delta = event.deltaY * (event.deltaMode === 1 ? 33 : event.deltaMode === 2 ? 800 : 1);
      // A trackpad pinch arrives as a wheel with ctrl held, in small steps.
      const factor = Math.min(2, Math.max(0.5, Math.exp(-delta * (event.ctrlKey ? 0.01 : 0.0022))));
      e.stage.zoomToward(factor, e.stage.follow ? undefined : local(event));
      own();
      clearTimeout(settle);
      settle = setTimeout(() => e.stage.settleZoom(), 160);
    };
    canvas.addEventListener("pointerdown", down);
    canvas.addEventListener("pointermove", move);
    canvas.addEventListener("pointerup", up);
    canvas.addEventListener("pointercancel", up);
    canvas.addEventListener("pointerleave", leave);
    canvas.addEventListener("wheel", wheel, { passive: false });
    canvas.style.cursor = "grab";
    return () => {
      clearTimeout(settle);
      canvas.removeEventListener("pointerdown", down);
      canvas.removeEventListener("pointermove", move);
      canvas.removeEventListener("pointerup", up);
      canvas.removeEventListener("pointercancel", up);
      canvas.removeEventListener("pointerleave", leave);
      canvas.removeEventListener("wheel", wheel);
      e.camp.hovered = null;
      canvas.style.cursor = "";
    };
  }, [engine, arrived, limitCamera, takeCamera]);
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
  // Finished videos waiting for you: the theatre calls for attention until they are approved and sent.
  const review = useMemo(() => {
    if (plan.stations.theatre.state !== "yours" || !campaign) return null;
    const ready = campaign.creatives.filter((c) => c.status === "ready");
    return ready.length ? { ready: ready.length, approved: ready.filter((c) => c.approved).length } : null;
  }, [plan, campaign]);

  return (
    <>
      <TopBar view={view} spend={spend} visible={arrived} onSelect={openStation} selected={selected} demo={demo ? player : undefined} home={home} />

      {lines.map((line) => (
        <SpeechBubble key={line.key} engine={engine} id={line.id} text={line.text} seconds={line.seconds} />
      ))}

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
            compact={detail < 2 || (battling && !manual && !selected)}
            onClick={() => openStation(selected === station.id && !agentId ? null : station.id)}
            bubble={bubbles.filter((b) => b.station === station.id).slice(-1)[0]}
          />
        ))}

      {arrived && view && LANDS.map((land) => <LandTag key={land.id} engine={engine} land={land} scouts={busyLands[land.id] ?? 0} detail={detail} />)}

      {arrived && view && plan.battle.phase !== "none" && (
        <>
          {/* Once the city falls the banner at its gate says it for all of them. */}
          {!taken &&
            plan.battle.companies.map((company, k) => (
              <CompanyTag key={company.creativeId} engine={engine} company={company} index={k} word={fleetWords[k] ?? COMPANY_WORD[company.state]} detail={detail} />
            ))}
          {plan.battle.rival && <RivalBanner engine={engine} rival={plan.battle.rival} taken={taken} detail={detail} />}
        </>
      )}
      {arrived && view && wide && battling && !panel && <Scoreboard battle={plan.battle} category={campaign?.plan?.category ?? null} onOpen={() => openStation("agora")} />}

      {arrived && view && (wide || !panel) && <ZoomControls wide={wide} panel={panel} manual={manual || (Boolean(agentId) && following)} onZoom={zoomBy} onFit={fitView} />}

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

      {arrived && review && selected !== "theatre" && !screening && <ReviewBeacon engine={engine} ready={review.ready} approved={review.approved} onOpen={() => openStation("theatre")} />}

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
            takeCamera(false);
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
          onFollow={() => {
            if (!following) takeCamera(false);
            setFollowing((f) => !f);
          }}
          onStation={openStation}
          // Back to the station panel it was opened from, if any.
          onClose={() => setAgentId(null)}
        />
      )}

      {arrived && !hinted && !agentId && !selected && !battling && (
        <p role="status" className={`${styles.boxSoft} ${styles.rise} pointer-events-none absolute left-1/2 z-10 -translate-x-1/2 px-3 py-1.5 text-[12px] ${wide ? "bottom-5" : "top-[64px]"}`}>
          <span className={`${styles.pixel} text-[var(--crimson)]`}>Tip </span>Click any soldier to follow them. Scroll or pinch to zoom, drag to look around.
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
                {state === "yours" && <span className="bg-[var(--teal)] px-1 text-[11px] text-[var(--paper)]">your turn</span>}
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
  plus: "M6 2h2v4h4v2h-4v4h-2v-4h-4v-2h4z",
  minus: "M2 6h10v2h-10z",
  fit: "M1 1h5v2h-3v3h-2zM8 1h5v5h-2v-3h-3zM1 8h2v3h3v2h-5zM11 8h2v5h-5v-2h3z",
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
      className={state === "working" ? "animate-pulse" : state === "yours" ? styles.blink : ""}
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
  compact,
  onClick,
  bubble,
}: {
  engine: RefObject<Engine | null>;
  id: StationId;
  plan: ReturnType<typeof derive>["stations"][StationId];
  active: boolean;
  /** Zoomed well out: just the name and its light. */
  compact: boolean;
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
  const yours = plan.state === "yours";
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
          title={compact ? `${station.role}: ${plan.status}` : undefined}
          className={`${active || yours ? styles.box : styles.boxSoft} ${styles.enter} ${yours && !active ? styles.beckon : ""} pointer-events-auto block -translate-x-1/2 text-left transition-transform hover:-translate-y-0.5 ${compact ? "whitespace-nowrap px-2 py-1" : "w-[208px] px-3 py-2"}`}
        >
          <span className="flex items-center gap-2">
            <Pip state={plan.state} />
            <span className={`${styles.pixel} font-semibold uppercase tracking-wide ${compact ? "text-[12px]" : "text-[14px]"}`}>{station.name}</span>
            {!compact && <span className="ml-auto text-[11px] text-[var(--ink-soft)]">{station.role}</span>}
            {compact && yours && <span className={`${styles.pixel} bg-[var(--teal)] px-1.5 text-[11px] text-[var(--paper)]`}>Your turn</span>}
          </span>
          {yours && !compact && (
            <span className={`${styles.pixel} mt-1.5 flex items-center justify-between bg-[var(--teal)] px-2 py-1 text-[12px] text-[var(--paper)]`}>
              Your turn: {id === "theatre" ? "review the videos" : "take a look"}
              <span aria-hidden="true">→</span>
            </span>
          )}
          {compact ? null : bubble ? (
            // A fresh dispatch replaces the status line for a few seconds.
            <span key={bubble.id} className={`${styles.fadeIn} mt-1 line-clamp-2 block text-[12px] leading-snug`} style={{ color: tone }} role="status">
              › {bubble.text}
            </span>
          ) : (
            <span className="mt-1 block truncate text-[12px] leading-snug text-[var(--ink-soft)]">{plan.status}</span>
          )}
          {plan.progress !== null && !compact && (
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

/**
 * Over the theatre while the campaign waits for your review: a bobbing call that is hard to miss,
 * one click from the cut.
 */
function ReviewBeacon({ engine, ready, approved, onOpen }: { engine: RefObject<Engine | null>; ready: number; approved: number; onOpen: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const e = engine.current;
    if (!e || !ref.current) return;
    const theatre = STATION.theatre;
    // Just above the screen's top edge.
    return e.stage.anchor(ref.current, () => ({ x: theatre.x - 15, y: theatre.y - 15, z: 30 }));
  }, [engine]);
  const left = ready - approved;
  return (
    <div ref={ref} className="pointer-events-none absolute left-0 top-0 z-[7] will-change-transform">
      <div className={`${styles.bob} flex -translate-x-1/2 -translate-y-full flex-col items-center`}>
        <button
          type="button"
          onClick={onOpen}
          className={`${styles.box} ${styles.beckon} ${styles.enter} pointer-events-auto flex items-center gap-2.5 whitespace-nowrap px-3 py-2 text-left text-[var(--paper)]`}
          style={{ background: "var(--teal)" }}
          aria-label={`${ready} ${ready === 1 ? "video is" : "videos are"} ready for your review. Open the theatre.`}
        >
          <Icon name="film" size={18} />
          <span>
            <span className={`${styles.pixel} block text-[15px] font-semibold leading-tight`}>
              {ready} {ready === 1 ? "video" : "videos"} ready
            </span>
            <span className="block text-[12px] leading-tight opacity-90">{approved ? `${approved} approved, ${left} to go` : "Your turn: review and approve"} →</span>
          </span>
        </button>
        {/* A pixel arrow down to the screen. */}
        <svg width="18" height="10" viewBox="0 0 9 5" shapeRendering="crispEdges" aria-hidden="true" className="-mt-px">
          <path d="M0 0h9v1h-1v1h-1v1h-1v1h-1v1h-1v-1h-1v-1h-1v-1h-1v-1h-1z" fill="var(--ink)" />
          <path d="M1 0h7v1h-1v1h-1v1h-1v1h-1v-1h-1v-1h-1v-1h-1z" fill="var(--teal)" />
        </svg>
      </div>
    </div>
  );
}

/**
 * A land's name on the map, under its shore: the site or API the scouts ride to, what they fetch
 * there, and how many scouts are out on that errand now. Zoomed far out it is just a marker in the
 * land's colour (and the count), so neighbouring labels don't pile up.
 */
function LandTag({ engine, land, scouts, detail }: { engine: RefObject<Engine | null>; land: Land; scouts: number; detail: 0 | 1 | 2 }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const e = engine.current;
    if (!e || !ref.current) return;
    return e.stage.anchor(ref.current, () => ({ x: land.x + LAND_RADIUS * 0.72, y: land.y + LAND_RADIUS * 0.72, z: 0 }));
  }, [engine, land]);
  const count = scouts > 0 && (
    <span className={`${styles.pixel} bg-[var(--crimson)] px-1 text-[10px] leading-[14px] text-[var(--paper)]`} aria-label={`${scouts} ${scouts === 1 ? "scout" : "scouts"} on this errand`}>
      {scouts}
    </span>
  );
  return (
    <div ref={ref} className="pointer-events-none absolute left-0 top-0 z-[4] will-change-transform">
      {detail === 0 ? (
        <div className={`${styles.fadeIn} flex -translate-x-1/2 items-center gap-1`} aria-label={land.name}>
          <span aria-hidden="true" className="inline-block size-2.5" style={{ background: land.color, boxShadow: "0 0 0 2px var(--paper)" }} />
          {count}
        </div>
      ) : (
        <div className={`${scouts ? styles.box : styles.boxSoft} ${styles.fadeIn} -translate-x-1/2 whitespace-nowrap ${detail === 1 ? "px-1.5 py-0.5" : "px-2 py-1"}`}>
          <span className="flex items-center gap-1.5">
            <span aria-hidden="true" className="inline-block size-2 shrink-0" style={{ background: land.color }} />
            <span className={`${styles.pixel} font-semibold ${detail === 1 ? "text-[11px]" : "text-[12px]"}`}>{land.name}</span>
            {count}
          </span>
          {detail === 2 && <span className="block text-[11px] leading-tight text-[var(--ink-soft)]">{land.what}</span>}
        </div>
      )}
    </div>
  );
}

/** A soldier's line, in a pixel speech bubble over his head that follows him as he moves. */
function SpeechBubble({ engine, id, text, seconds }: { engine: RefObject<Engine | null>; id: string; text: string; seconds: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const e = engine.current;
    if (!e || !ref.current) return;
    return e.stage.anchor(ref.current, () => {
      const p = e.camp.position(id);
      return p ? { ...p, z: p.z + 27 } : null;
    });
  }, [engine, id]);
  return (
    <div ref={ref} className="pointer-events-none absolute left-0 top-0 z-[8] will-change-transform" role="status">
      <div className={styles.say} style={{ animationDuration: `${seconds}s` }}>
        <p className={`${styles.box} ${styles.pixel} max-w-[240px] px-2.5 py-1.5 text-center text-[13px] leading-snug text-[var(--ink)]`}>{text}</p>
        <svg width="14" height="8" viewBox="0 0 7 4" shapeRendering="crispEdges" aria-hidden="true" className="mx-auto -mt-[3px] block">
          <path d="M0 0h7v1h-1v1h-1v1h-1v1h-1v-1h-1v-1h-1v-1h-1z" fill="var(--ink)" />
          <path d="M1 0h5v1h-1v1h-1v1h-1v-1h-1v-1h-1z" fill="var(--paper)" />
        </svg>
      </div>
    </div>
  );
}

/** "▲ 19%" or "▼ 9%": a ratio against the top videos, as a difference. */
function versus(ratio: number) {
  const pct = Math.round((ratio - 1) * 100);
  return pct === 0 ? "level" : `${pct > 0 ? "▲" : "▼"} ${Math.abs(pct)}%`;
}

/** "Your videos are 14% ahead of", "… level with", "… 9% behind". */
function standing(ratio: number) {
  const pct = Math.round((ratio - 1) * 100);
  return pct === 0 ? "Your videos are level with" : `Your videos are ${Math.abs(pct)}% ${pct > 0 ? "ahead of" : "behind"}`;
}

const COMPANY_WORD: Record<Company["state"], string> = { formed: "mustered", approved: "cleared to sail", sent: "under sail", engaged: "landed", failed: "post failed" };

/** Over each company of the army: which video it fights for, and how that video is doing. */
function CompanyTag({ engine, company, index, word, detail }: { engine: RefObject<Engine | null>; company: Company; index: number; word: string; detail: 0 | 1 | 2 }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const e = engine.current;
    if (!e || !ref.current) return;
    // Over its ship until it lands, then over its front rank; every other one a little higher, so
    // neighbours don't cover each other.
    return e.stage.anchor(ref.current, () => e.camp.expedition.companyAt(index), 0, -(index % 2) * 22);
  }, [engine, index]);
  // The result once the company has fought; until then, what it is doing.
  const fought = word === "fighting" || word === "took the gate" || word === "holding" || word === "thrown back";
  const result = company.ratio !== null && fought ? versus(company.ratio) : null;
  const tone = company.ratio === null ? "var(--ink)" : company.ratio >= 1 ? "var(--olive)" : "var(--crimson)";
  return (
    <div ref={ref} className="pointer-events-none absolute left-0 top-0 z-[5] will-change-transform">
      <div className={`${styles.boxSoft} ${styles.fadeIn} flex -translate-x-1/2 -translate-y-full items-center gap-1.5 whitespace-nowrap px-1.5 py-0.5`} title={company.title}>
        <span className={`${styles.pixel} bg-[var(--ink)] px-1 text-[11px] leading-[15px] text-[var(--paper)]`}>{company.idx + 1}</span>
        {detail > 0 && (
          <span className={`${styles.pixel} text-[11px]`} style={{ color: result ? tone : "var(--ink-soft)" }}>
            {result ? `${result} vs top videos` : word}
          </span>
        )}
      </div>
    </div>
  );
}

/** Under the rival city's gate: whose legion this is, and how many of its ads the scouts found running. */
function RivalBanner({ engine, rival, taken, detail }: { engine: RefObject<Engine | null>; rival: { name: string; ads: number | null }; taken: boolean; detail: 0 | 1 | 2 }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const e = engine.current;
    if (!e || !ref.current) return;
    // In the street just inside the gate, clear of the fighting.
    const p = romePoint(ROME_LINES.gate + 30, 0);
    return e.stage.anchor(ref.current, () => ({ ...p, z: 0 }));
  }, [engine]);
  return (
    <div ref={ref} className="pointer-events-none absolute left-0 top-0 z-[5] will-change-transform">
      <div key={taken ? "taken" : "rival"} className={`${styles.box} ${styles.fadeIn} -translate-x-1/2 translate-y-2 whitespace-nowrap px-2.5 py-1 text-center`} style={{ background: taken ? "var(--olive)" : "var(--crimson)", color: "var(--paper)" }}>
        <span className={`${styles.pixel} block text-[13px] font-semibold uppercase tracking-wide`}>{taken ? `${rival.name}: taken` : rival.name}</span>
        {detail > 0 && (
          <span className="block text-[11px] leading-tight opacity-90">
            {taken ? "Every video beat the top videos" : `The rival${rival.ads ? ` · ${rival.ads} live ${rival.ads === 1 ? "ad" : "ads"} found` : ""}`}
          </span>
        )}
      </div>
    </div>
  );
}

/** While the battle holds the camera: your videos against the category's top videos, in numbers. */
function Scoreboard({ battle, category, onOpen }: { battle: BattlePlan; category: string | null; onOpen: () => void }) {
  const score = battle.score;
  const posted = battle.companies.filter((c) => c.state === "engaged").length;
  const going = battle.companies.filter((c) => c.state === "sent").length;
  const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
  // Where the line stands: the middle is level with the top videos.
  const lean = score?.ratio ? Math.max(0.06, Math.min(0.94, 0.5 + Math.log2(score.ratio) * 0.45)) : 0.5;
  return (
    <button type="button" onClick={onOpen} className={`${styles.box} ${styles.rise} absolute bottom-4 left-1/2 z-10 w-[min(560px,calc(100vw-420px))] -translate-x-1/2 px-4 py-2.5 text-left`}>
      <span className="flex items-center gap-2">
        <span className={`${styles.pixel} text-[13px] font-semibold uppercase tracking-wide`}>The battle</span>
        <span className="text-[12px] text-[var(--ink-soft)]">
          {score?.ratio
            ? `${standing(score.ratio)} the top videos${category ? ` in ${category}` : ""}`
            : posted
              ? "Posted. Waiting for the first numbers"
              : going
                ? `${going} ${going === 1 ? "video is" : "videos are"} going out`
                : "Formed up"}
        </span>
        <span className="ml-auto text-[11px] text-[var(--ink-faint)]">Details →</span>
      </span>
      <span className="mt-2 flex items-center gap-2 text-[11px]">
        <span className={`${styles.pixel} w-[92px] shrink-0 text-[var(--olive)]`}>You {score ? pct(score.engagement) : "–"}</span>
        <span className="relative h-[8px] flex-1 bg-[var(--crimson)]" aria-hidden="true">
          <span className="absolute inset-y-0 left-0 bg-[var(--olive)] transition-[width] duration-700" style={{ width: `${lean * 100}%` }} />
          <span className="absolute inset-y-[-3px] left-1/2 w-[2px] bg-[var(--ink)]" />
        </span>
        <span className={`${styles.pixel} w-[110px] shrink-0 text-right text-[var(--crimson)]`}>Top videos {battle.benchmark ? pct(battle.benchmark.engagement) : "–"}</span>
      </span>
      <span className="mt-1 block text-[10px] text-[var(--ink-faint)]">Likes per view of your posted videos against the median of the top videos the scouts found.</span>
    </button>
  );
}

/** Zoom buttons for the map (the wheel, a pinch and the + − 0 keys do the same). */
function ZoomControls({ wide, panel, manual, onZoom, onFit }: { wide: boolean; panel: boolean; manual: boolean; onZoom: (direction: 1 | -1) => void; onFit: () => void }) {
  return (
    <div
      role="group"
      aria-label="Map zoom"
      className={`${styles.fadeIn} absolute z-10 flex flex-col gap-[3px] ${wide ? `bottom-4 ${panel ? "right-[448px]" : "right-4"}` : "bottom-[184px] right-4"}`}
    >
      <button type="button" className={styles.iconButton} onClick={() => onZoom(1)} aria-label="Zoom in" title="Zoom in (+)">
        <PixelIcon name="plus" />
      </button>
      <button type="button" className={styles.iconButton} onClick={() => onZoom(-1)} aria-label="Zoom out" title="Zoom out (−)">
        <PixelIcon name="minus" />
      </button>
      <button
        type="button"
        className={styles.iconButton}
        style={manual ? { background: "var(--crimson)" } : undefined}
        onClick={onFit}
        aria-label="Fit the view"
        title="Fit the view (0): the camera frames the camp again, and the lands while scouts are out"
      >
        <PixelIcon name="fit" />
      </button>
    </div>
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
              className={`${active || p.state === "yours" ? styles.box : styles.boxSoft} ${p.state === "yours" ? styles.beckon : ""} w-[200px] shrink-0 snap-center px-3 py-2.5 text-left`}
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
