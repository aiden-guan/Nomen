"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TourStep } from "./tour";
import { paceFor, tourSteps } from "./tour";
import type { DemoPlayer } from "./useDemo";

export type Tour = {
  on: boolean;
  steps: TourStep[];
  /** The open step's index, -1 before the tour starts. */
  index: number;
  step: TourStep | null;
  next: () => void;
  back: () => void;
  /** Back to the first step, with the replay from the start. */
  restart: () => void;
  /** Off: the replay plays freely and the presenter's keys work as before. */
  toggle: () => void;
  /** Autoplay walks the tour by itself, each step for its time (TourStep.dwell). */
  auto: boolean;
  /** The open step's timer: its length, the seconds already spent on it, and whether it is running. */
  timer: { dwell: number; spent: number; running: boolean; key: number };
};

/**
 * Walks a replay step by step (camp/tour.ts): each step moves the clock to its part of the work,
 * holds it there, and asks the camp to open what it shows (`apply`).
 *
 * Autoplay (the default; ?autoplay=0 turns it off) opens the next step once a step's time is up,
 * and plays each step fast enough to fit (`pace`: the clock and the scene alike), so the whole
 * walk-through runs like a video. Pausing the replay (Space, or the card's button) pauses it too.
 * → and ← (or N and P) still walk the tour, and autoplay carries on from there; R starts it over and
 * T turns the tour on or off; ?tour=0 starts with it off.
 */
export function useTour({
  enabled,
  arrived,
  player,
  apply,
  pace,
}: {
  enabled: boolean;
  arrived: boolean;
  player: DemoPlayer;
  apply: (step: TourStep | null) => void;
  /** Plays the scene this many times faster (the clock is the player's). */
  pace: (rate: number) => void;
}): Tour {
  const steps = useMemo(() => (enabled && player.script ? tourSteps(player.script) : []), [enabled, player.script]);
  const [on, setOn] = useState(true);
  const [auto, setAuto] = useState(true);
  const [index, setIndex] = useState(-1);
  // Each opening of a step, so its timer starts over even when the same step opens again.
  const [opened, setOpened] = useState(0);
  const playerRef = useRef(player);
  playerRef.current = player;
  const indexRef = useRef(index);
  indexRef.current = index;
  const autoRef = useRef(auto);
  autoRef.current = auto;
  // The step's pace on autoplay, kept while the replay is paused.
  const rateRef = useRef(1);

  useEffect(() => {
    if (!enabled) return;
    const params = new URLSearchParams(window.location.search);
    if (params.get("tour") === "0") setOn(false);
    if (params.get("autoplay") === "0" || params.get("tour") === "0") setAuto(false);
  }, [enabled]);

  const go = useCallback(
    (i: number) => {
      const step = steps[i];
      if (!step) return;
      const p = playerRef.current;
      let from: number;
      // The loop's last step plays autopilot's next campaign; every other step is the recording's.
      const round = step.round ? 2 : 1;
      if (round > p.round) p.nextRound();
      else if (round < p.round) p.previousRound();
      if (round !== p.round) {
        // Back in the recording, a step with a start goes there (after the round switch above).
        if (round === 1 && step.at !== undefined) p.seek(step.at);
        from = round === 2 ? 0 : (step.at ?? p.t);
        p.holdAt(step.hold === "end" ? null : step.run !== undefined ? null : step.hold);
      } else {
        const back = i < indexRef.current;
        // Forward never rewinds what has already played; back goes to the step's start.
        const rewind = step.at !== undefined && (back || p.t < step.at);
        if (rewind) p.seek(step.at!);
        if (step.post) p.postAll();
        from = rewind ? step.at! : p.t;
        p.holdAt(step.hold === "end" ? null : step.run !== undefined ? from + step.run : step.hold);
      }
      // On autoplay the step plays fast enough to fit its time on screen.
      const rate = autoRef.current ? paceFor(step, from, from + 30) : 1;
      rateRef.current = rate;
      p.setRate(rate);
      pace(rate);
      p.play();
      apply(step);
      setIndex(i);
      setOpened((n) => n + 1);
    },
    [steps, apply, pace],
  );

  // The tour starts once the column reaches the camp; turned back on, it picks up where the clock is.
  useEffect(() => {
    if (!enabled || !arrived || !on || !steps.length || indexRef.current >= 0) return;
    let start = 0;
    steps.forEach((step, i) => {
      if (step.at !== undefined && step.at <= playerRef.current.t + 0.01) start = i;
    });
    go(start);
  }, [enabled, arrived, on, steps, go]);

  const next = useCallback(() => go(Math.min(steps.length - 1, indexRef.current + 1)), [go, steps.length]);
  const back = useCallback(() => go(Math.max(0, indexRef.current - 1)), [go]);
  const restart = useCallback(() => {
    playerRef.current.restart();
    setIndex(-1);
    indexRef.current = -1;
    // The fresh state lands first; the first step then holds it at its start.
    setTimeout(() => go(0), 0);
  }, [go]);
  const toggle = useCallback(() => {
    setOn((was) => {
      const now = !was;
      if (!now) {
        playerRef.current.holdAt(null);
        playerRef.current.setRate(1);
        pace(1);
        apply(null);
      } else {
        setIndex(-1);
        indexRef.current = -1;
      }
      return now;
    });
  }, [apply, pace]);

  // --- Autoplay: the step's timer. --------------------------------------------------------------
  const live = on && enabled && steps.length > 0 && index >= 0;
  const running = live && auto && player.playing;
  const spent = useRef(0);
  const since = useRef(0);
  const [timer, setTimer] = useState({ dwell: 0, spent: 0, running: false, key: 0 });
  // A newly opened step starts its timer from nothing.
  useEffect(() => {
    spent.current = 0;
    since.current = 0;
  }, [opened]);
  useEffect(() => {
    const step = steps[index];
    if (!live || !step || !auto) return;
    if (!running) {
      // Paused: the time so far is kept, and the scene plays at its own pace meanwhile.
      pace(1);
      setTimer({ dwell: step.dwell, spent: spent.current, running: false, key: opened });
      return;
    }
    since.current = performance.now();
    playerRef.current.setRate(rateRef.current);
    pace(rateRef.current);
    setTimer({ dwell: step.dwell, spent: spent.current, running: true, key: opened });
    const last = index >= steps.length - 1;
    const left = Math.max(0, step.dwell - spent.current);
    const timeout = setTimeout(() => {
      if (last) {
        // The end: the tour stays on its last step, at real speed.
        playerRef.current.setRate(1);
        pace(1);
        return;
      }
      next();
    }, left * 1000);
    return () => {
      clearTimeout(timeout);
      if (since.current) spent.current += (performance.now() - since.current) / 1000;
      since.current = 0;
    };
  }, [live, running, auto, index, opened, steps, next, pace]);

  // The presenter's keys, captured before the replay's own (useDemo) and the screening room's.
  useEffect(() => {
    if (!enabled || !arrived || !steps.length) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || event.repeat) return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (target?.closest("input, textarea, select, [contenteditable='true']")) return;
      const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
      const action = key === "t" ? toggle : !on ? undefined : ({ ArrowRight: next, n: next, ArrowLeft: back, p: back, r: restart } as Record<string, (() => void) | undefined>)[key];
      if (!action) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      action();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [enabled, arrived, steps.length, on, next, back, restart, toggle]);

  return { on: on && enabled && steps.length > 0, steps, index, step: on && index >= 0 ? (steps[index] ?? null) : null, next, back, restart, toggle, auto: auto && live, timer };
}
