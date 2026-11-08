"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TourStep } from "./tour";
import { tourSteps } from "./tour";
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
};

/**
 * Walks a replay step by step (camp/tour.ts): each step moves the clock to its part of the work,
 * holds it there, and asks the camp to open what it shows (`apply`). → and ← (or N and P) walk the
 * tour, R starts it over and T turns it on or off; ?tour=0 starts with it off.
 */
export function useTour({ enabled, arrived, player, apply }: { enabled: boolean; arrived: boolean; player: DemoPlayer; apply: (step: TourStep | null) => void }): Tour {
  const steps = useMemo(() => (enabled && player.script ? tourSteps(player.script) : []), [enabled, player.script]);
  const [on, setOn] = useState(true);
  const [index, setIndex] = useState(-1);
  const playerRef = useRef(player);
  playerRef.current = player;
  const indexRef = useRef(index);
  indexRef.current = index;

  useEffect(() => {
    if (!enabled) return;
    if (new URLSearchParams(window.location.search).get("tour") === "0") setOn(false);
  }, [enabled]);

  const go = useCallback(
    (i: number) => {
      const step = steps[i];
      if (!step) return;
      const p = playerRef.current;
      const back = i < indexRef.current;
      // Forward never rewinds what has already played; back goes to the step's start.
      const rewind = step.at !== undefined && (back || p.t < step.at);
      if (rewind) p.seek(step.at!);
      if (step.post) p.postAll();
      const from = rewind ? step.at! : p.t;
      p.holdAt(step.hold === "end" ? null : step.run !== undefined ? from + step.run : step.hold);
      p.play();
      apply(step);
      setIndex(i);
    },
    [steps, apply],
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
        apply(null);
      } else {
        setIndex(-1);
        indexRef.current = -1;
      }
      return now;
    });
  }, [apply]);

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

  return { on: on && enabled && steps.length > 0, steps, index, step: on && index >= 0 ? (steps[index] ?? null) : null, next, back, restart, toggle };
}
