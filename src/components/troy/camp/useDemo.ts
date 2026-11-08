"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { BrandView } from "../api";
import { advance, approveAll, type DemoScript, type DemoState, finished, freshState, jump, loadDemoScript, type PublishMode, publish, replay } from "./demo";

export type DemoPlayer = {
  script: DemoScript | null;
  view: BrandView | null;
  playing: boolean;
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
export function useDemo(enabled: boolean, arrived: boolean): DemoPlayer {
  const [script, setScript] = useState<DemoScript | null>(null);
  const [state, setState] = useState<DemoState>(() => freshState());
  const [playing, setPlaying] = useState(true);
  const [auto, setAuto] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const speed = useRef(1);
  const playingRef = useRef(playing);
  playingRef.current = playing;
  const autoRef = useRef(auto);
  autoRef.current = auto;

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    const params = new URLSearchParams(window.location.search);
    setAuto(params.get("auto") === "1");
    const asked = Number(params.get("speed"));
    speed.current = Number.isFinite(asked) && asked > 0 ? Math.min(4, Math.max(0.25, asked)) : 1;
    void loadDemoScript(params.get("site")).then((loaded) => alive && setScript(loaded));
    return () => {
      alive = false;
    };
  }, [enabled]);

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
        const next = advance(script, current, dt, autoRef.current);
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

  const view = useMemo(() => (enabled && arrived && script ? replay(script, state) : null), [enabled, arrived, script, state]);
  const done = script ? finished(script, state) : false;
  return { script, view, playing, auto, done, notice, ...controls };
}
