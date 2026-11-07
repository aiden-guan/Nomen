"use client";

import { useState } from "react";
import type { CreativeView } from "@/lib/views";
import { Badge, Button, cx, Spinner } from "./ui";

const SHOT_LABEL: Record<string, string> = {
  pending: "Composing the first frame",
  framed: "Queued to render",
  rendering: "Rendering",
  rendered: "Quality check",
  passed: "Passed QC",
  failed: "Failed",
};

export function CreativeCard({ creative, onChange }: { creative: CreativeView; onChange: () => void }) {
  const [caption, setCaption] = useState(creative.caption);
  const [note, setNote] = useState("");
  const [showNote, setShowNote] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const concept = creative.concept;
  const ready = creative.status === "ready";
  const dirty = caption !== creative.caption;

  async function call(label: string, method: "PATCH" | "POST", payload: object) {
    setBusy(label);
    setError(null);
    try {
      const response = await fetch(`/api/creatives/${creative.id}`, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Request failed");
      setShowNote(false);
      setNote("");
      onChange();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  const qcTone = creative.qcScore === null ? "neutral" : creative.qcScore >= 8 ? "good" : creative.qcScore >= 7 ? "info" : "warn";
  const issues = [
    ...creative.shots.flatMap((shot) => (shot.qc && !shot.qc.pass ? shot.qc.issues.map((issue) => `Shot ${shot.n}: ${issue}`) : [])),
    ...(creative.continuity?.checked && !creative.continuity.consistent && creative.continuity.note ? [`Between shots: ${creative.continuity.note}`] : []),
  ];

  return (
    <article className={cx("flex flex-col overflow-hidden rounded-2xl border bg-white/[0.03]", creative.approved ? "border-emerald-500/30" : "border-white/10")}>
      <div className="relative aspect-[9/16] bg-zinc-900">
        {creative.videoUrl ? (
          <video src={creative.videoUrl} poster={creative.posterUrl ?? undefined} controls playsInline preload="metadata" className="size-full object-cover" />
        ) : (
          <div className="absolute inset-0">
            {creative.shots[0]?.frameUrl && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={creative.shots[0].frameUrl} alt="" className="size-full object-cover opacity-40 blur-[1px]" />
            )}
            <div className="absolute inset-0 flex flex-col justify-end gap-2 bg-gradient-to-t from-zinc-950 via-zinc-950/60 to-transparent p-4">
              {creative.status === "failed" ? (
                <p className="text-sm text-rose-300">{creative.error}</p>
              ) : (
                creative.shots.map((shot) => (
                  <div key={shot.n} className="flex items-center gap-2 text-xs text-zinc-300">
                    {shot.status === "passed" ? <span className="text-emerald-400">✓</span> : shot.status === "failed" ? <span className="text-rose-400">✕</span> : <Spinner className="text-violet-300" />}
                    <span>
                      Shot {shot.n}: {SHOT_LABEL[shot.status] ?? shot.status}
                      {shot.provider === "monid" && " on Monid"}
                      {shot.renders > 1 && ` (take ${shot.renders})`}
                    </span>
                  </div>
                ))
              )}
            </div>
          </div>
        )}
        {(creative.generation > 1 || creative.qcScore !== null || creative.approved || creative.continuity?.checked) && (
          <div className="absolute left-3 top-3 flex flex-wrap gap-1.5 rounded-full bg-black/60 p-1 backdrop-blur">
            {creative.generation > 1 && <Badge tone="neutral">Take {creative.generation}</Badge>}
            {creative.qcScore !== null && <Badge tone={qcTone}>QC {creative.qcScore}/10</Badge>}
            {creative.continuity?.checked && (
              <Badge tone={creative.continuity.consistent ? "good" : "warn"}>{creative.continuity.consistent ? "Same person ✓" : "Changes between shots"}</Badge>
            )}
            {creative.approved && <Badge tone="good">Approved</Badge>}
          </div>
        )}
      </div>

      <div className="flex flex-1 flex-col gap-3 p-4">
        <div>
          <div className="flex items-start justify-between gap-2">
            <h3 className="font-medium leading-snug text-zinc-100">{concept?.title}</h3>
            <span className="shrink-0 text-xs tabular-nums text-zinc-500">${creative.cost.toFixed(2)}</span>
          </div>
          <p className="mt-1 text-xs text-zinc-400">
            {concept?.format} · {concept?.angle}
          </p>
          {concept?.hook && <p className="mt-2 text-sm text-zinc-300">“{concept.hook}”</p>}
        </div>

        {issues.length > 0 && (
          <details className="rounded-lg border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-xs text-amber-200">
            <summary className="cursor-pointer">QC notes ({issues.length})</summary>
            <ul className="mt-2 list-disc space-y-1 pl-4">
              {issues.map((issue) => (
                <li key={issue}>{issue}</li>
              ))}
            </ul>
          </details>
        )}

        <label className="block text-xs text-zinc-500">
          Caption
          <textarea
            value={caption}
            onChange={(event) => setCaption(event.target.value)}
            rows={4}
            className="mt-1 w-full resize-y rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-sm text-zinc-200 focus:border-violet-400/50 focus:outline-none"
          />
        </label>
        <div className="flex flex-wrap gap-1">
          {creative.platforms.map((platform) => (
            <Badge key={platform}>{platform}</Badge>
          ))}
        </div>

        {showNote && (
          <textarea
            value={note}
            onChange={(event) => setNote(event.target.value)}
            rows={2}
            placeholder="Director's note, e.g. warmer light, she should sound more surprised"
            className="w-full rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-sm text-zinc-200 focus:border-violet-400/50 focus:outline-none"
          />
        )}
        {error && <p className="text-xs text-rose-300">{error}</p>}

        <div className="mt-auto flex flex-wrap gap-2">
          {dirty && (
            <Button size="sm" loading={busy === "caption"} onClick={() => call("caption", "PATCH", { caption })}>
              Save caption
            </Button>
          )}
          {ready && (
            <Button size="sm" variant={creative.approved ? "secondary" : "primary"} loading={busy === "approve"} onClick={() => call("approve", "PATCH", { approved: !creative.approved })}>
              {creative.approved ? "Unapprove" : "Approve"}
            </Button>
          )}
          {creative.videoUrl && (
            <a href={creative.videoUrl} download={`${(concept?.title ?? "video").replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.mp4`} className="inline-flex h-8 items-center rounded-xl px-3 text-xs text-zinc-300 hover:bg-white/[0.06]">
              Download
            </a>
          )}
          {(ready || creative.status === "failed") &&
            (showNote ? (
              <Button size="sm" loading={busy === "redo"} onClick={() => call("redo", "POST", { note })}>
                Re-render
              </Button>
            ) : (
              <Button size="sm" variant="ghost" onClick={() => setShowNote(true)}>
                Re-render…
              </Button>
            ))}
        </div>
      </div>
    </article>
  );
}
