"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { BrandView } from "../api";
import { advance, approveAll, type DemoScript, type DemoState, finished, freshState, jump, loadDemoScript, nextRound, previousRound, type PublishMode, publish, replay, seek } from "./demo";

export type DemoPlayer = {
  script: DemoScript | null;
  view: BrandView | null;
  playing: boolean;
  /** Seconds on the demo clock. */
  t: number;
  /** Which campaign of the loop is playing: 1 is the recording, 2 autopilot's next one. */
  round: number;
  /** Autoplay approves and posts the videos itself instead of waiting at the review. */
  auto: boolean;
  done: boolean;
  notice: string | null;
  toggle: () => void;
  next: () => void;
  back: () => void;
  restart: () => void;
  toggleAuto: () => void;
  approve: (idx: number, value: boolean) => void;
  approveAll: () => void;
  publish: (mode: PublishMode) => void;
  /** For the tour: put the clock at a time, stop it at one (null: no stop), start it, post everything. */
  seek: (t: number) => void;
  holdAt: (t: number | null) => void;
  play: () => void;
  postAll: () => void;
  /** Autopilot starts the next campaign; and back to the one before, as it ended. */
  nextRound: () => void;
  previousRound: () => void;
  /** Runs the clock this many times faster (the tour's autoplay fast-forwards a step to fit its time). */
  setRate: (rate: number) => void;
};

const TICK_MS = 250;

/**
 * Plays the demo campaign: loads the script (the recording for ?site=, if any), runs its clock
 * once the column reaches the camp, and gives the presenter a few keys.
 *
 * Space pauses, → skips to the next step (at the review it approves and posts everything),
 * ← goes back a step, R starts over, A turns autoplay on or off. ?auto=1 starts with autoplay
 * on and ?speed=1.5 runs the clock faster.
 */
export function useDemo(enabled: boolean, arrived: boolean, site: string | null = null): DemoPlayer {
  const [script, setScript] = useState<DemoScript | null>(null);
  const [state, setState] = useState<DemoState>(() => freshState());
  const [playing, setPlaying] = useState(true);
  const [auto, setAuto] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  // ?speed= sets the base; the tour's autoplay multiplies it per step (rate).
  const baseSpeed = useRef(1);
  const speed = useRef(1);
  const playingRef = useRef(playing);
  playingRef.current = playing;
  const autoRef = useRef(auto);
  autoRef.current = auto;
  // Where a tour step stops the clock, if one does.
  const holdRef = useRef<number | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    const params = new URLSearchParams(window.location.search);
    setAuto(params.get("auto") === "1");
    const asked = Number(params.get("speed"));
    baseSpeed.current = Number.isFinite(asked) && asked > 0 ? Math.min(4, Math.max(0.25, asked)) : 1;
    speed.current = baseSpeed.current;
    // The site typed at the horse, else ?site=: the camp mounts while the doors open, before the
    // address changes to ?site=, so the landing passes it in.
    void loadDemoScript(site ?? params.get("site")).then((loaded) => alive && setScript(loaded));
    return () => {
      alive = false;
    };
  }, [enabled, site]);

  // The clock starts when the column reaches the camp.
  useEffect(() => {
    if (!enabled || !arrived || !script) return;
    setState(freshState());
    let last = performance.now();
    const timer = setInterval(() => {
      const now = performance.now();
      const dt = ((now - last) / 1000) * speed.current;
      last = now;
      if (!playingRef.current) return;
      setState((current) => {
        const next = advance(script, current, dt, autoRef.current, holdRef.current ?? Number.POSITIVE_INFINITY);
        // Waiting at the review changes nothing: keep the same state so nothing re-renders.
        return next.t === current.t && next.approved === current.approved && next.publish === current.publish ? current : next;
      });
    }, TICK_MS);
    return () => clearInterval(timer);
  }, [enabled, arrived, script]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 2600);
    return () => clearTimeout(timer);
  }, [notice]);

  const controls = useMemo(
    () => ({
      toggle: () => setPlaying((p) => !p),
      next: () => script && setState((s) => jump(script, s, 1)),
      back: () => script && setState((s) => jump(script, s, -1)),
      restart: () => {
        holdRef.current = null;
        setState(freshState());
        setPlaying(true);
      },
      toggleAuto: () => {
        const on = !autoRef.current;
        setAuto(on);
        setNotice(on ? "Autoplay on: the videos get approved and posted by themselves" : "Autoplay off: the camp waits for your review");
      },
      approve: (idx: number, value: boolean) => setState((s) => ({ ...s, approved: { ...s.approved, [idx]: value } })),
      approveAll: () => script && setState((s) => approveAll(script, s)),
      publish: (mode: PublishMode) => script && setState((s) => publish(script, s, mode)),
      seek: (t: number) => script && setState((s) => seek(script, s, t)),
      holdAt: (t: number | null) => {
        holdRef.current = t;
      },
      play: () => setPlaying(true),
      postAll: () => script && setState((s) => publish(script, approveAll(script, s), "now")),
      setRate: (rate: number) => {
        speed.current = baseSpeed.current * rate;
      },
      nextRound: () => setState((s) => nextRound(s)),
      previousRound: () => setState((s) => previousRound(s)),
    }),
    [script],
  );

  // Presenter keys, unless the key is meant for a control or a video.
  useEffect(() => {
    if (!enabled || !arrived || !script) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || event.repeat) return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (target?.closest("input, textarea, select, button, a, video, [contenteditable='true']")) return;
      const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
      const action: (() => void) | undefined = {
        " ": controls.toggle,
        k: controls.toggle,
        ArrowRight: controls.next,
        n: controls.next,
        ArrowLeft: controls.back,
        p: controls.back,
        r: controls.restart,
        a: controls.toggleAuto,
      }[key];
      if (!action) return;
      event.preventDefault();
      action();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled, arrived, script, controls]);

  // The camp needs the cast before the column marches in, so the view exists from the start; the
  // clock only runs once the column has arrived.
  const view = useMemo(() => (enabled && script ? replay(script, state) : null), [enabled, script, state]);
  const done = script ? finished(script, state) : false;
  return { script, view, playing, t: state.t, round: state.round, auto, done, notice, ...controls };
}
