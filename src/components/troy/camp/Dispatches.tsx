"use client";

import { useEffect, useState } from "react";
import type { EventView } from "../api";
import styles from "../troy.module.css";
import { ago } from "./format";

/** The camp's log: the latest dispatch in one line, the whole history on demand. */
export function Dispatches({ events, wide }: { events: EventView[]; wide: boolean }) {
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  const latest = events[0];
  return (
    <section
      aria-label="Dispatches"
      className={`${styles.boxSoft} ${styles.enter} absolute left-4 z-10 flex flex-col ${wide ? "bottom-4" : "bottom-[124px]"} ${open ? "max-h-[min(460px,60vh)]" : ""}`}
      style={{ width: wide ? 380 : "calc(100vw - 32px)" }}
    >
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex w-full items-center gap-2 px-3 py-2.5 text-left">
        <span className={`${styles.pixel} shrink-0 text-[13px] font-semibold uppercase tracking-wide`}>Dispatches</span>
        {!open && latest && (
          <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--ink-soft)]" aria-live="polite">
            {latest.message}
          </span>
        )}
        {open && <span className="flex-1 text-[12px] text-[var(--ink-faint)]">{events.length} most recent</span>}
        <span className={`${styles.pixel} shrink-0 text-[12px] text-[var(--ink-soft)]`}>{open ? "▾" : "▴"}</span>
      </button>
      {open && (
        <ol className="min-h-0 flex-1 overflow-y-auto border-t-2 border-[rgba(43,29,20,0.12)] px-3 py-2">
          {events.length === 0 && <li className="py-2 text-[12px] text-[var(--ink-soft)]">Nothing yet.</li>}
          {events.map((event, i) => (
            <li key={`${event.ts}-${i}`} className="flex gap-2.5 py-1.5 text-[12px] leading-snug">
              <span
                className={`${styles.pixel} mt-px shrink-0 ${event.level === "error" ? "text-[var(--crimson)]" : event.level === "warn" ? "text-[var(--bronze)]" : "text-[var(--teal)]"}`}
                aria-label={event.level === "info" ? undefined : event.level}
              >
                {event.level === "error" ? "!" : event.level === "warn" ? "▲" : "›"}
              </span>
              <span className="min-w-0 flex-1">{event.message}</span>
              <time dateTime={event.ts} className="shrink-0 text-[11px] text-[var(--ink-faint)]">
                {ago(event.ts, now)}
              </time>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
