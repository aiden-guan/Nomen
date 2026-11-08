"use client";

import { type SyntheticEvent, useState } from "react";
import type { CreativeView, ReferenceView } from "../api";
import styles from "../troy.module.css";
import { clock, compact, LANE_NAMES, platformName } from "./format";

// The viral videos the agents work from: what the oracle broke down (or is breaking down), what it
// set aside and why, and which of our videos remake which. Shown live while the campaign runs.

const STATUS: Record<ReferenceView["status"], { word: string; tone: string }> = {
  studied: { word: "broken down", tone: "text-[var(--olive)]" },
  studying: { word: "breaking down", tone: "text-[var(--crimson)]" },
  unreadable: { word: "couldn't read", tone: "text-[var(--crimson-dark)]" },
  shortlisted: { word: "shortlisted", tone: "text-[var(--ink-faint)]" },
  dropped: { word: "set aside", tone: "text-[var(--ink-faint)]" },
};

const hideBroken = (event: SyntheticEvent<HTMLImageElement>) => {
  event.currentTarget.style.visibility = "hidden";
};

const times = (n: number) => `${n >= 10 ? Math.round(n) : n.toFixed(1)}×`;

/** The references, grouped: the ones the director can use, then (folded) the ones set aside. */
export function ReferenceList({ references, onScreen }: { references: ReferenceView[]; onScreen?: (creativeId: string) => void }) {
  const used = references.filter((r) => r.status === "studied" || r.status === "studying" || r.status === "unreadable");
  const aside = references.filter((r) => r.status === "shortlisted" || r.status === "dropped");
  if (!references.length) return null;
  return (
    <>
      {used.length > 0 && (
        <ul className="space-y-4">
          {used.map((reference) => (
            <ReferenceCard key={reference.url} reference={reference} onScreen={onScreen} />
          ))}
        </ul>
      )}
      {aside.length > 0 && (
        <details className="mt-4 text-[13px]" open={used.length === 0}>
          <summary className={`${styles.pixel} cursor-pointer text-[12px] text-[var(--ink-soft)]`}>
            Considered and set aside · {aside.length}
          </summary>
          <ul className="mt-3 space-y-4">
            {aside.map((reference) => (
              <ReferenceCard key={reference.url} reference={reference} onScreen={onScreen} />
            ))}
          </ul>
        </details>
      )}
    </>
  );
}

export function ReferenceCard({ reference: r, onScreen }: { reference: ReferenceView; onScreen?: (creativeId: string) => void }) {
  const [open, setOpen] = useState(false);
  const status = STATUS[r.status];
  // A paid ad has no public view count (ad libraries hide it), so its engagement numbers are blank too.
  const count = (label: string, value: number | null): Array<[string, string]> => (value === null || (r.paidAd && !value) ? [] : [[label, compact(value)]]);
  const stats: Array<[string, string]> = [
    r.paidAd && !r.views ? ["views", "unknown (paid ad)"] : ["views", compact(r.views)],
    ...count("followers", r.followers),
    ...(r.outlier ? ([["its followers", times(r.outlier)]] as Array<[string, string]>) : []),
    ...count("likes", r.likes),
    ...count("saves", r.saves),
    ...count("shares", r.shares),
    ...count("comments", r.comments),
  ];
  const note = r.status === "dropped" || r.status === "shortlisted" ? r.relevanceReason : (r.whyItWorks ?? r.relevanceReason);
  return (
    <li className="flex gap-3 text-[13px]">
      <a
        href={r.url}
        target="_blank"
        rel="noreferrer"
        className="relative block aspect-[9/16] w-[64px] shrink-0 self-start overflow-hidden bg-[var(--ink)]"
        aria-label={`Open @${r.author}'s original video on ${platformName(r.platform)}`}
      >
        {r.thumbnail && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={r.thumbnail} alt="" referrerPolicy="no-referrer" loading="lazy" onError={hideBroken} className="size-full object-cover" />
        )}
        <span aria-hidden="true" className="absolute inset-0 grid place-items-center">
          <span className="grid size-6 place-items-center bg-[rgba(255,250,240,0.85)] text-[10px] text-[var(--ink)]">▶</span>
        </span>
        {r.duration ? <span className="absolute bottom-0 right-0 bg-[rgba(43,29,20,0.8)] px-1 text-[10px] tabular-nums text-[var(--paper)]">{clock(r.duration)}</span> : null}
        {r.status === "studying" && <span className={`${styles.spinner} absolute left-1 top-1`} aria-hidden="true" />}
      </a>
      <div className="min-w-0 flex-1">
        <p className="flex items-baseline gap-2">
          <a href={r.url} target="_blank" rel="noreferrer" className={`${styles.link} min-w-0 truncate font-semibold`}>
            @{r.author.replace(/^@/, "") || "unknown"}
          </a>
          <span className="shrink-0 text-[11px] text-[var(--ink-faint)]">{platformName(r.platform)}</span>
          {r.role && <RoleBadge role={r.role} />}
          <span className={`${styles.pixel} ml-auto shrink-0 text-[11px] ${status.tone}`}>{status.word}</span>
        </p>
        <p className="mt-0.5 text-[11px] text-[var(--ink-soft)]">
          {[r.lane ? LANE_NAMES[r.lane] ?? r.lane : null, r.fit ? `fit ${r.fit.score}/10` : r.relevance !== null ? `relevance ${r.relevance}/10` : null].filter(Boolean).join(" · ")}
        </p>
        <p className="mt-1 flex flex-wrap gap-x-2.5 gap-y-0.5 text-[11px] tabular-nums text-[var(--ink-soft)]">
          {stats.map(([label, value]) => (
            <span key={label}>
              <b className="font-semibold text-[var(--ink)]">{value}</b> {label}
            </span>
          ))}
        </p>
        {r.conversion !== null && (
          <p className="mt-1 text-[11px] leading-snug text-[var(--ink-soft)]">
            <b className="font-semibold text-[var(--ink)]">converts {r.conversion}/10</b>
            {r.signals.length ? `: ${r.signals.join(" · ")}` : ""}
          </p>
        )}
        {r.cloneability !== null && (
          <p className="mt-1 text-[11px] leading-snug text-[var(--ink-soft)]" title="How faithfully the footage clone can remake it: one person talking to camera, in long takes, in a plain room clones best">
            <b className={`font-semibold ${r.hardToClone ? "text-[var(--crimson-dark)]" : "text-[var(--ink)]"}`}>clones {r.cloneability}/10</b>
            {r.cloneBasis === "metadata" ? " (guessed from the caption)" : ""}
            {open && r.cloneSignals.length ? `: ${r.cloneSignals.join(" · ")}` : r.hardestToClone ? ` · hardest: ${r.hardestToClone}` : ""}
          </p>
        )}
        {r.hook?.line && <p className="mt-1.5 leading-snug">“{r.hook.line}”</p>}
        {note && <p className={`mt-1 leading-snug text-[12px] text-[var(--ink-soft)] ${open ? "" : "line-clamp-2"}`}>{note}</p>}
        {r.hook?.mechanic && open && <p className="mt-1 text-[12px] leading-snug text-[var(--ink-soft)]">Hook: {r.hook.mechanic}</p>}
        {r.format && open && <p className="mt-1 text-[12px] leading-snug text-[var(--ink-soft)]">Format: {r.format}{r.beats ? `, ${r.beats} beats` : ""}</p>}
        {r.error && <p className="mt-1 text-[12px] text-[var(--crimson-dark)]">{r.error}</p>}
        {(r.hook?.mechanic || r.format || r.cloneSignals.length > 0 || (note && note.length > 110)) && (
          <button type="button" className={`${styles.link} mt-0.5 text-[11px] underline decoration-dotted underline-offset-4`} onClick={() => setOpen((o) => !o)}>
            {open ? "less" : "more"}
          </button>
        )}
        {r.remadeBy.length > 0 && (
          <p className="mt-1.5 text-[12px] text-[var(--crimson)]">
            Remade as{" "}
            {r.remadeBy.map((use, i) => (
              <span key={`${use.title}-${i}`}>
                {i > 0 && ", "}
                {use.creativeId && onScreen ? (
                  <button type="button" className={`${styles.link} underline decoration-dotted underline-offset-4`} onClick={() => onScreen(use.creativeId!)}>
                    “{use.title}”
                  </button>
                ) : (
                  <>“{use.title}”</>
                )}
              </span>
            ))}
          </p>
        )}
      </div>
    </li>
  );
}

/** Reach or convert: what a reference (or one of our videos) is for in the campaign. */
export function RoleBadge({ role }: { role: "reach" | "convert" }) {
  return (
    <span
      className={`${styles.pixel} shrink-0 px-1.5 text-[10px] uppercase leading-[16px] tracking-wider text-[var(--paper)] ${role === "convert" ? "bg-[var(--crimson)]" : "bg-[var(--teal)]"}`}
      title={role === "convert" ? "Built to make viewers act: judged on clicks and sign-ups" : "Built to be watched and shared: judged on views and shares"}
    >
      {role}
    </span>
  );
}

/** The reference a finished video remakes, as the screening room shows it. */
export function RemakeOf({ creative, reference }: { creative: CreativeView; reference: ReferenceView | null }) {
  const ref = creative.reference;
  if (!ref) return null;
  const paidAd = reference?.paidAd ?? ref.paidAd ?? false;
  const views = reference?.views ?? ref.views;
  const stats = [
    paidAd && !views ? "a paid ad: views unknown" : `${compact(views)} views`,
    (reference?.followers ?? ref.followers) !== null ? `${compact(reference?.followers ?? ref.followers)} followers` : null,
    (reference?.outlier ?? ref.outlier) ? `${times((reference?.outlier ?? ref.outlier)!)} followers` : null,
    reference?.likes != null ? `${compact(reference.likes)} likes` : null,
    reference?.shares != null ? `${compact(reference.shares)} shares` : null,
  ].filter(Boolean);
  const thumbnail = reference?.thumbnail ?? ref.thumbnail;
  return (
    <div className="flex gap-3">
      <a href={ref.url} target="_blank" rel="noreferrer" className="relative block aspect-[9/16] w-[48px] shrink-0 self-start overflow-hidden bg-[var(--ink)]" aria-label={`Open @${ref.author}'s original video`}>
        {thumbnail && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={thumbnail} alt="" referrerPolicy="no-referrer" loading="lazy" onError={hideBroken} className="size-full object-cover" />
        )}
      </a>
      <div className="min-w-0 text-[12px] leading-snug">
        <a href={ref.url} target="_blank" rel="noreferrer" className={`${styles.link} font-semibold`}>
          @{ref.author.replace(/^@/, "")}
        </a>{" "}
        <span className="text-[var(--ink-faint)]">{ref.platform ? platformName(ref.platform) : ""}</span>
        <p className="text-[var(--ink-soft)]">{stats.join(" · ")}</p>
        {reference?.hook?.line && <p className="mt-1">“{reference.hook.line}”</p>}
        {ref.format && (
          <p className="mt-1 line-clamp-3 text-[var(--ink-faint)]" title={ref.format}>
            {ref.format}
          </p>
        )}
      </div>
    </div>
  );
}
