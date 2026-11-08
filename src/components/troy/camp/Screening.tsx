"use client";

import { useEffect, useRef, useState } from "react";
import type { CreativeView, ReferenceView } from "../api";
import styles from "../troy.module.css";
import type { CampActions } from "./Camp";
import { money, platformName, referenceVerb } from "./format";
import { InternalBadge, RemakeOf, RoleBadge } from "./References";
import { crispIfTiny } from "./StationPanel";
import { recording } from "./useTour";

/**
 * The screening room: one finished video at full height over the camp, with its hook and caption
 * and the approve box, so the cut can be watched properly before it goes out. ← and → move
 * between videos, Escape closes.
 */
export function Screening({
  videos,
  references = [],
  id,
  onPick,
  onClose,
  actions,
  busy,
  wide,
  arrows = true,
}: {
  videos: CreativeView[];
  /** The campaign's reference study, for the numbers of the viral video each one remakes. */
  references?: ReferenceView[];
  id: string;
  onPick: (id: string) => void;
  onClose: () => void;
  actions: CampActions;
  busy: string | null;
  wide: boolean;
  /** ← and → step between the videos (the demo's tour takes those keys while it runs). */
  arrows?: boolean;
}) {
  // Filming the demo video (?record=1): the video plays without the browser's controls over it.
  const [filming] = useState(() => recording());
  const index = Math.max(0, videos.findIndex((v) => v.id === id));
  const creative = videos[index];
  const closeRef = useRef<HTMLButtonElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

  // Focus moves in (to the video, so Space plays and pauses it) and back out when it closes.
  useEffect(() => {
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => before?.focus();
  }, []);
  useEffect(() => {
    (videoRef.current ?? closeRef.current)?.focus();
  }, [id]);

  // Captured before the panel's own Escape handler and the demo's arrow keys.
  useEffect(() => {
    const step = (by: number) => onPick(videos[(index + by + videos.length) % videos.length].id);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      } else if (arrows && (event.key === "ArrowRight" || event.key === "ArrowLeft") && videos.length > 1 && !(event.target instanceof HTMLInputElement)) {
        event.preventDefault();
        event.stopPropagation();
        step(event.key === "ArrowRight" ? 1 : -1);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [index, videos, onPick, onClose, arrows]);

  if (!creative) return null;
  const concept = creative.concept;
  const title = concept?.title ?? `Video ${creative.idx + 1}`;
  const approveKey = `approve:${creative.id}`;
  const height = wide ? "min(82vh, 760px)" : "min(56vh, calc((100vw - 32px) * 16 / 9))";

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`${title}: the finished video`}
      className={`${styles.overlay} absolute inset-0 z-40 flex items-center justify-center p-4`}
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <div data-screening-box className={`${styles.box} ${styles.enter} flex max-h-full min-h-0 overflow-hidden ${wide ? "flex-row" : "w-full max-w-[460px] flex-col"}`}>
        <div className={`relative shrink-0 bg-[#120c08] ${wide ? "" : "mx-auto"}`} style={{ height, aspectRatio: "9 / 16" }}>
          {creative.videoUrl ? (
            <video ref={videoRef} key={creative.id} src={creative.videoUrl} poster={creative.posterUrl ?? undefined} controls={!filming} autoPlay playsInline className="size-full bg-black object-contain outline-none" />
          ) : creative.posterUrl ? (
            <>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={creative.posterUrl} alt="" onLoad={crispIfTiny} className="size-full object-cover" />
              <p className="absolute inset-x-3 bottom-3 bg-[rgba(43,29,20,0.82)] px-3 py-2 text-[12px] leading-snug text-[var(--paper)]">
                A still: the made-up demo brand has no footage. A recorded demo plays the real video here.
              </p>
            </>
          ) : null}
        </div>

        <div className={`flex min-h-0 flex-col ${wide ? "w-[320px]" : "max-h-[34vh]"}`}>
          <div className="flex items-center gap-3 border-b-2 border-[rgba(43,29,20,0.12)] px-5 py-3">
            <span className={`${styles.pixel} text-[12px] uppercase tracking-wider text-[var(--ink-faint)]`}>
              The cut · {index + 1} of {videos.length}
            </span>
            <button ref={closeRef} type="button" onClick={onClose} className={`${styles.link} ${styles.pixel} -mr-1 ml-auto px-2 text-xl leading-none`} aria-label="Close">
              ×
            </button>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4 text-[13px]">
            <h2 className={`${styles.pixel} text-[22px] font-semibold leading-tight`}>{title}</h2>
            {creative.internal && (
              <p className="mt-1.5 flex items-center gap-2 text-[12px] text-[var(--ink-soft)]">
                <InternalBadge cleared={creative.cleared} />
                {creative.cleared ? `cleared for posting by ${creative.cleared.by}` : "one-to-one remake for internal review: not posted unless cleared"}
              </p>
            )}
            {concept && (
              <p className="mt-1 text-[12px] text-[var(--ink-soft)]">
                {[concept.format, concept.angle].filter(Boolean).join(" · ")}
              </p>
            )}
            {creative.role && (
              <p className="mt-1.5 flex items-center gap-2 text-[12px] text-[var(--ink-soft)]">
                <RoleBadge role={creative.role} />
                {creative.metric ? `judged on ${creative.metric.replace(/_/g, " ")}` : null}
              </p>
            )}
            {creative.reference && (
              <section className="mt-4">
                <h3 className={`${styles.pixel} mb-1.5 text-[11px] uppercase tracking-wider text-[var(--ink-faint)]`}>{referenceVerb(creative.reference)}</h3>
                <RemakeOf creative={creative} reference={references.find((r) => r.url === creative.reference?.url) ?? null} />
              </section>
            )}
            {concept?.hook && (
              <section className="mt-4">
                <h3 className={`${styles.pixel} mb-1 text-[11px] uppercase tracking-wider text-[var(--ink-faint)]`}>Hook</h3>
                <p className="leading-relaxed">{concept.hook}</p>
              </section>
            )}
            {concept?.script && (
              <details className="mt-4">
                <summary className={`${styles.pixel} cursor-pointer text-[11px] uppercase tracking-wider text-[var(--ink-faint)]`}>
                  Script · {Math.round(concept.script.total_seconds)} s{concept.script.review ? ` · critic ${concept.script.review.score}/10` : ""}
                </summary>
                <ol className="mt-2 space-y-1.5 text-[12px]">
                  {concept.script.beats.map((beat) => (
                    <li key={beat.n} className="leading-snug">
                      <span className="text-[var(--ink-faint)]">
                        {beat.job} · {beat.visual}
                        {beat.on_screen_text ? ` · “${beat.on_screen_text}”` : ""}
                      </span>
                      <br />
                      {beat.line ? `“${beat.line}”` : <span className="text-[var(--ink-faint)]">(no line)</span>}
                    </li>
                  ))}
                </ol>
                {concept.script.review?.notes.length ? <p className="mt-2 text-[12px] text-[var(--ink-soft)]">Critic: {concept.script.review.notes.slice(0, 2).join(" ")}</p> : null}
              </details>
            )}
            {creative.caption && (
              <section className="mt-4">
                <h3 className={`${styles.pixel} mb-1 text-[11px] uppercase tracking-wider text-[var(--ink-faint)]`}>Caption</h3>
                <p className="leading-relaxed text-[var(--ink-soft)]">{creative.caption}</p>
              </section>
            )}
            <p className="mt-4 text-[12px] text-[var(--ink-faint)]">
              {[
                creative.qcScore ? `QC ${creative.qcScore}/10` : null,
                creative.cost ? `${money(creative.cost)} to film` : null,
                creative.generation > 1 ? `take ${creative.generation}` : null,
                creative.platforms.length ? creative.platforms.map(platformName).join(", ") : null,
              ]
                .filter(Boolean)
                .join(" · ")}
            </p>
          </div>

          <div className="flex items-center gap-3 border-t-2 border-[rgba(43,29,20,0.12)] px-5 py-3">
            <label className="flex cursor-pointer items-center gap-2">
              <input
                type="checkbox"
                checked={creative.approved}
                disabled={busy === approveKey}
                onChange={(event) => actions.approve(creative, event.target.checked)}
                className="size-4 accent-[var(--crimson)]"
              />
              <span className={`${styles.pixel} text-[14px]`}>{creative.approved ? "Approved" : "Approve"}</span>
            </label>
            {videos.length > 1 && (
              <span className="ml-auto flex gap-2">
                <button type="button" className={`${styles.button} ${styles.buttonQuiet} ${styles.pixel} h-8 px-3 text-[13px]`} onClick={() => onPick(videos[(index - 1 + videos.length) % videos.length].id)} aria-label="Previous video">
                  ←
                </button>
                <button type="button" className={`${styles.button} ${styles.buttonQuiet} ${styles.pixel} h-8 px-3 text-[13px]`} onClick={() => onPick(videos[(index + 1) % videos.length].id)} aria-label="Next video">
                  →
                </button>
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
