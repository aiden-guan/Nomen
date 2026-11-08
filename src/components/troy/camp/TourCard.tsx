"use client";

import { useLayoutEffect, useRef, useState } from "react";
import styles from "../troy.module.css";
import type { Tour } from "./useTour";

/** Narrower than this, the gap in the top bar can't hold the card: it goes just under the bar. */
const MIN_GAP = 300;

/** The bar's gap (its left edge, and its right edge from the window's right), where it is, and just under the bar. */
type Place = { left: number; right: number; top: number; below: number; width: number };

/**
 * The tour's caption: where the replay is, what happens there, and the presenter's arrows. On wide
 * screens it sits in the top bar, between the replay buttons and the spend (the demo's bar has no
 * campaign steps: the tour walks them), stopping short of an open station panel (`clear`), and
 * tells the camp how far down it reaches (`onBottom`) so the camera frames the camp below it. While
 * a video plays it moves into the screening room's margin beside the video when there is room
 * there, so it covers none of it.
 */
export function TourCard({ tour, wide, screening, clear = 0, onBottom }: { tour: Tour; wide: boolean; screening: boolean; clear?: number; onBottom?: (bottom: number) => void }) {
  const step = tour.step;
  const [place, setPlace] = useState<Place | null>(null);
  const [beside, setBeside] = useState<number | null>(null);
  const card = useRef<HTMLDivElement>(null);

  // The top bar's gap: from the replay buttons' right edge to the next thing in the bar.
  useLayoutEffect(() => {
    if (!wide) {
      setPlace(null);
      return;
    }
    const measure = () => {
      const controls = document.querySelector("[data-demo-controls]")?.getBoundingClientRect();
      const bar = document.querySelector("[data-topbar]");
      if (!controls || !bar) return setPlace(null);
      const after = [...bar.children]
        .map((child) => child.getBoundingClientRect())
        .filter((box) => box.width > 0 && box.left >= controls.right - 1)
        .map((box) => box.left);
      const end = after.length ? Math.min(...after) : window.innerWidth;
      setPlace({ left: Math.round(controls.right + 16), right: Math.round(window.innerWidth - end + 16), top: Math.round(controls.top), below: Math.round(controls.bottom + 12), width: window.innerWidth });
    };
    measure();
    // Again once the bar's fonts and the campaign's steps have settled.
    const timer = setTimeout(measure, 400);
    const bar = document.querySelector("[data-topbar]");
    const observer = typeof ResizeObserver !== "undefined" && bar ? new ResizeObserver(measure) : null;
    if (observer && bar) observer.observe(bar);
    window.addEventListener("resize", measure);
    return () => {
      clearTimeout(timer);
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [wide, tour.index]);

  useLayoutEffect(() => {
    if (!screening || !wide) {
      setBeside(null);
      return;
    }
    const measure = () => {
      const box = document.querySelector("[data-screening-box]")?.getBoundingClientRect();
      setBeside(box && window.innerWidth - box.right >= 280 ? Math.round(box.right + 16) : null);
    };
    measure();
    // Again once the room's entrance animation has settled.
    const timer = setTimeout(measure, 400);
    window.addEventListener("resize", measure);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("resize", measure);
    };
  }, [screening, wide, tour.index]);

  // How far down the card reaches at the top of the screen (0 when it isn't there).
  const atTop = wide && beside === null && place !== null && Boolean(step);
  useLayoutEffect(() => {
    if (!onBottom) return;
    const el = card.current;
    if (!atTop || !el) {
      onBottom(0);
      return;
    }
    const report = () => onBottom(Math.round(el.getBoundingClientRect().bottom));
    report();
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(report) : null;
    observer?.observe(el);
    return () => observer?.disconnect();
  }, [atTop, onBottom, step?.key, place]);
  useLayoutEffect(() => () => onBottom?.(0), [onBottom]);

  if (!step) return null;
  const n = tour.index + 1;
  const last = n >= tour.steps.length;
  // An open station panel holds the right side below the bar: the card stops short of it. Where
  // that leaves the bar's gap too narrow, the card goes just under the bar instead.
  const clearRight = clear ? clear + 16 : 16;
  const inBar = place && place.width - place.left - Math.max(place.right, clearRight) >= MIN_GAP;
  const style = !wide
    ? { left: 12, right: 12, top: 64 }
    : beside !== null
      ? { left: beside, right: 16, bottom: 16 }
      : place && inBar
        ? { left: place.left, right: Math.max(place.right, clearRight), top: place.top }
        : { left: 16, right: clearRight, top: place?.below ?? 76 };
  return (
    <div className={`pointer-events-none absolute z-50 flex ${wide && beside === null ? "justify-start" : "justify-center"}`} style={style}>
      <section ref={card} key={step.key} aria-label="Tour" aria-live="polite" className={`${styles.box} ${styles.enter} pointer-events-auto w-full max-w-[960px] px-3.5 pb-2.5 pt-2`}>
        <div className="flex items-center gap-2.5">
          <span className={`${styles.pixel} shrink-0 text-[12px] text-[var(--crimson)]`}>
            {n}/{tour.steps.length}
          </span>
          <h2 className={`${styles.pixel} min-w-0 flex-1 truncate text-[16px] font-semibold leading-tight`} title={step.title}>
            {step.title}
          </h2>
          <span className="flex shrink-0 items-center gap-[3px]">
            <button type="button" onClick={tour.back} disabled={n <= 1} className={`${styles.button} ${styles.pixel} h-7 px-2 text-[13px]`} aria-label="Back" title="Back (←)">
              ←
            </button>
            <button type="button" onClick={tour.next} disabled={last} className={`${styles.button} ${styles.buttonInk} ${styles.pixel} h-7 px-2.5 text-[13px]`} aria-label={last ? "The end" : "Next"} title="Next (→)">
              {last ? "End" : "Next →"}
            </button>
          </span>
          <button type="button" onClick={tour.toggle} className={`${styles.link} ${styles.pixel} shrink-0 px-1 text-[17px] leading-none`} aria-label="Close the tour" title="Close the tour (T)">
            ×
          </button>
        </div>
        <p className="mt-1 text-[13px] leading-snug text-[var(--ink-soft)]">{step.body}</p>
        {/* How far through the tour: a thin bar instead of a row of dots. */}
        <span aria-hidden="true" className="mt-2 block h-[3px] bg-[rgba(43,29,20,0.12)]">
          <span className="block h-full bg-[var(--crimson)] transition-[width] duration-300" style={{ width: `${(n / tour.steps.length) * 100}%` }} />
        </span>
      </section>
    </div>
  );
}
