"use client";

import { useState } from "react";
import styles from "../troy.module.css";
import { collapseRepeats, creatorChips, summarizeEvent } from "./eventSummary";
import { ago } from "./format";

type Event = { ts: string; level: string; message: string };

/** List items shown before "more" opens the rest. */
const ITEMS_SHOWN = 2;

/**
 * What just happened at a station, scannable: each dispatch as a headline, its gist, the numbers
 * as chips and any list it carries, with the full line a click away (camp/eventSummary.ts).
 */
export function EventLog({ events }: { events: Event[] }) {
  return (
    <ol className="space-y-2">
      {collapseRepeats(events).map((event, i) => (
        <EventRow key={`${event.ts}-${i}`} event={event} times={event.times} />
      ))}
    </ol>
  );
}

function EventRow({ event, times }: { event: Event; times: number }) {
  const [open, setOpen] = useState(false);
  const s = summarizeEvent(event.message);
  const tone = event.level === "error" ? "var(--crimson)" : event.level === "warn" ? "var(--bronze)" : "var(--teal)";
  const items = s.list?.items ?? [];
  const hidden = open ? 0 : Math.max(0, items.length - ITEMS_SHOWN);
  const expandable = s.more || hidden > 0;
  return (
    <li className="bg-[rgba(43,29,20,0.035)] py-2 pl-3 pr-2.5" style={{ boxShadow: `inset 3px 0 0 ${tone}` }}>
      <div className="flex items-baseline gap-2">
        <p className="min-w-0 flex-1 text-[12.5px] font-semibold leading-snug text-[var(--ink)]">
          {s.headline}
          {times > 1 && <span className={`${styles.pixel} ml-1.5 bg-[var(--ink)] px-1 text-[10px] font-normal text-[var(--paper)]`}>×{times}</span>}
        </p>
        <time dateTime={event.ts} className="shrink-0 text-[10.5px] text-[var(--ink-faint)]">
          {ago(event.ts)}
        </time>
      </div>
      {s.lead && <p className={`mt-0.5 text-[12px] leading-snug text-[var(--ink-soft)] ${open ? "" : "line-clamp-2"}`}>{s.lead}</p>}
      {s.chips.length > 0 && (
        <ul className="mt-1.5 flex flex-wrap gap-1" aria-label="Numbers">
          {s.chips.map((chip) => (
            <li key={chip} className={`${styles.pixel} bg-[rgba(43,29,20,0.07)] px-1.5 py-px text-[11px] leading-[16px] text-[var(--ink)]`}>
              {chip}
            </li>
          ))}
        </ul>
      )}
      {items.length > 0 && (
        <div className="mt-1.5">
          {s.list!.label && <p className={`${styles.pixel} text-[10.5px] uppercase tracking-wide text-[var(--ink-faint)]`}>{s.list!.label}</p>}
          <ul className="mt-0.5 space-y-0.5">
            {items.slice(0, items.length - hidden).map((item, k) => (
              <li key={k} className="flex gap-1.5 text-[11.5px] leading-snug text-[var(--ink-soft)]">
                <span aria-hidden="true" className="mt-[6px] size-[4px] shrink-0 bg-[var(--ink-faint)]" />
                <span className="min-w-0">{item}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {open && s.more && <p className="mt-1.5 border-t border-dashed border-[rgba(43,29,20,0.15)] pt-1.5 text-[11.5px] leading-relaxed text-[var(--ink-soft)]">{event.message}</p>}
      {expandable && (
        <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className={`${styles.link} ${styles.pixel} mt-1 text-[11px] text-[var(--ink-soft)]`}>
          {open ? "Less ▴" : hidden > 0 ? `${hidden} more ▾` : "Full note ▾"}
        </button>
      )}
    </li>
  );
}

/**
 * A long reason, kept to two lines with the creators it cites as chips; "more" opens the rest.
 * For the panels' paragraphs (the war tent's why for each video).
 */
export function Reason({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const chips = creatorChips(text);
  const long = text.length > 150;
  return (
    <div className="mt-1">
      <p className={`text-[12.5px] leading-snug text-[var(--ink-soft)] ${open || !long ? "" : "line-clamp-2"}`}>{text}</p>
      {chips.length > 0 && !open && (
        <ul className="mt-1 flex flex-wrap gap-1" aria-label="Creators it cites">
          {chips.slice(0, 4).map((chip) => (
            <li key={chip} className={`${styles.pixel} bg-[rgba(43,29,20,0.07)] px-1.5 py-px text-[11px] leading-[16px]`}>
              {chip}
            </li>
          ))}
        </ul>
      )}
      {long && (
        <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className={`${styles.link} ${styles.pixel} mt-0.5 text-[11px] text-[var(--ink-soft)]`}>
          {open ? "Less ▴" : "More ▾"}
        </button>
      )}
    </div>
  );
}
