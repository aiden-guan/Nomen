"use client";

import { useLayoutEffect, useState } from "react";
import styles from "../troy.module.css";
import type { Tour } from "./useTour";

/**
 * The tour's caption: where the replay is, what happens there, and the presenter's arrows. It sits
 * along the bottom between the dispatches and any open panel, above the screening room.
 */
export function TourCard({ tour, wide, right, screening, scoreboard }: { tour: Tour; wide: boolean; right: number; screening: boolean; scoreboard: boolean }) {
  const step = tour.step;
  // While a video plays in the screening room, the card moves into the room's margin beside it
  // (when there is space for it there) so it covers none of the video.
  const [beside, setBeside] = useState<number | null>(null);
  useLayoutEffect(() => {
    if (!screening || !wide) {
      setBeside(null);
      return;
    }
    const place = () => {
      const box = document.querySelector("[data-screening-box]")?.getBoundingClientRect();
      setBeside(box && window.innerWidth - box.right >= 280 ? Math.round(box.right + 16) : null);
    };
    place();
    // Again once the room's entrance animation has settled.
    const timer = setTimeout(place, 400);
    window.addEventListener("resize", place);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("resize", place);
    };
  }, [screening, wide, tour.index]);
  if (!step) return null;
  const n = tour.index + 1;
  const last = n >= tour.steps.length;
  return (
    <div
      className="pointer-events-none absolute z-50 flex justify-center"
      style={
        !wide
          ? { left: 12, right: 12, top: 64 }
          : beside !== null
            ? { left: beside, right: 16, bottom: 16 }
            : scoreboard
              ? // The battle's scoreboard holds the bottom middle: the card goes to its right.
                { left: "calc(50% + 280px)", right: 16, bottom: 16 }
              : { left: 412, right: right + 16, bottom: 16 }
      }
    >
      <section key={step.key} aria-label="Tour" aria-live="polite" className={`${styles.box} ${styles.enter} pointer-events-auto w-full max-w-[580px] px-4 pb-3 pt-3`}>
        <div className="flex items-baseline gap-3">
          <span className={`${styles.pixel} shrink-0 text-[12px] text-[var(--crimson)]`}>
            {n}/{tour.steps.length}
          </span>
          <h2 className={`${styles.pixel} min-w-0 flex-1 text-[19px] font-semibold leading-tight`}>{step.title}</h2>
          <button type="button" onClick={tour.toggle} className={`${styles.link} ${styles.pixel} shrink-0 px-1 text-[17px] leading-none`} aria-label="Close the tour" title="Close the tour (T)">
            ×
          </button>
        </div>
        <p className="mt-1.5 text-[13.5px] leading-snug text-[var(--ink-soft)]">{step.body}</p>
        <div className="mt-3 flex items-center gap-3">
          <button type="button" onClick={tour.back} disabled={n <= 1} className={`${styles.button} ${styles.pixel} h-8 px-3 text-[13px]`} title="Back (←)">
            ← Back
          </button>
          <span aria-hidden="true" className="flex min-w-0 flex-1 items-center justify-center gap-[5px]">
            {tour.steps.map((s, i) => (
              <span key={s.key} className="h-[6px] w-[6px]" style={{ background: i < n ? "var(--crimson)" : "rgba(43,29,20,0.18)" }} />
            ))}
          </span>
          <button type="button" onClick={tour.next} disabled={last} className={`${styles.button} ${styles.buttonInk} ${styles.pixel} h-8 px-3 text-[13px]`} title="Next (→)">
            {last ? "The end" : "Next →"}
          </button>
        </div>
      </section>
    </div>
  );
}
