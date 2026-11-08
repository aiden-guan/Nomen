"use client";

import { useState } from "react";
import type { CampaignView } from "@/lib/views";
import { Badge, Button, Card, cx, Empty, Spinner } from "./ui";

type Statics = NonNullable<CampaignView["statics"]>;
type StaticAd = Statics["ads"][number];

const STEPS = [
  { key: "research", label: "Research", hint: "Competitor and leader ads on Meta, X, Google, the web" },
  { key: "study", label: "Ad study", hint: "Top ads read by a vision model; art direction set" },
  { key: "write", label: "Copy", hint: "Concepts and platform copy, fact-checked against the site" },
  { key: "produce", label: "Production", hint: "Every size rendered, then checked" },
  { key: "ready", label: "Ready", hint: "Download the pack" },
] as const;

const PLATFORM: Record<string, string> = { meta: "Meta", x: "X", reddit: "Reddit", google: "Google" };

async function send(url: string, method: "POST" | "PATCH", payload: object = {}) {
  const response = await fetch(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error ?? "Request failed");
  return data;
}

export function StaticAdsView({ campaign, onChange }: { campaign: CampaignView; onChange: () => void }) {
  const statics = campaign.statics;
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const researchDone = Boolean(campaign.research);

  async function act(label: string, url: string, payload: object = {}) {
    setBusy(label);
    setError(null);
    try {
      await send(url, "POST", payload);
      onChange();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  if (!statics) {
    return (
      <Empty title="No static ads yet">
        <p>Static ads are researched separately: Nomen looks at competitors&apos; and category leaders&apos; best image ads, sets an art direction from them, and renders every size Google, Meta, X and Reddit ask for.</p>
        <div className="mt-4 flex justify-center">
          <Button variant="primary" disabled={!researchDone} loading={busy === "start"} onClick={() => act("start", `/api/campaigns/${campaign.id}/statics`)}>
            {researchDone ? "Make static ads" : "Waiting for research"}
          </Button>
        </div>
        {error && <p className="mt-3 text-rose-300">{error}</p>}
      </Empty>
    );
  }

  const current = STEPS.findIndex((step) => step.key === statics.stage);
  const ready = statics.ads.filter((ad) => ad.status === "ready");
  const approved = ready.filter((ad) => ad.approved).length;

  return (
    <div className="space-y-6">
      <ol className="grid grid-cols-2 gap-2 sm:grid-cols-5">
        {STEPS.map((step, i) => {
          const done = i < current || statics.status === "ready";
          const active = i === current && !done;
          return (
            <li key={step.key} className={cx("rounded-xl border px-3 py-2.5", done && "border-emerald-500/20 bg-emerald-500/[0.06]", active && statics.status !== "failed" && "border-violet-400/40 bg-violet-500/[0.08]", active && statics.status === "failed" && "border-rose-500/40 bg-rose-500/[0.08]", !done && !active && "border-white/5 bg-white/[0.02]")}>
              <div className="flex items-center gap-2 text-xs font-medium">
                <span className={cx("grid size-5 place-items-center rounded-full text-[10px]", done ? "bg-emerald-500/20 text-emerald-300" : active ? "bg-violet-500/20 text-violet-200" : "bg-white/5 text-zinc-500")}>
                  {done ? "✓" : active && statics.status === "running" ? <Spinner className="size-3" /> : i + 1}
                </span>
                <span className={done || active ? "text-zinc-100" : "text-zinc-500"}>{step.label}</span>
              </div>
              <p className="mt-1 hidden text-[11px] leading-snug text-zinc-500 sm:block">{step.hint}</p>
            </li>
          );
        })}
      </ol>

      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-white/10 bg-white/[0.02] px-4 py-3">
        <p className="text-sm text-zinc-300">
          {statics.status === "ready"
            ? `${ready.length} concepts ready, each at up to ${Math.max(0, ...ready.map((ad) => ad.renders.length))} sizes. ${approved ? `${approved} approved: the download holds those.` : "Approve the ones you want, or download all of them."}`
            : statics.status === "failed"
              ? statics.error
              : statics.status === "stopped"
                ? "Stopped."
                : "Working: research, then the study, the copy and the renders. This takes a few minutes."}
          <span className="ml-2 text-xs text-zinc-500">
            Monid ${statics.spend.monid.toFixed(3)} · images ${statics.spend.images.toFixed(2)} · model ≈${(statics.spend.modelEstimate ?? 0).toFixed(2)}
          </span>
        </p>
        <div className="flex flex-wrap gap-2">
          {statics.status === "running" && (
            <Button size="sm" variant="ghost" loading={busy === "stop"} onClick={() => act("stop", `/api/statics/${statics.id}`, { action: "stop" })}>
              Stop
            </Button>
          )}
          {(statics.status === "failed" || statics.status === "stopped") && (
            <Button size="sm" loading={busy === "retry"} onClick={() => act("retry", `/api/statics/${statics.id}`, { action: "retry" })}>
              {statics.status === "stopped" ? "Resume" : "Retry"}
            </Button>
          )}
          {statics.status !== "running" && (
            <Button size="sm" variant="ghost" loading={busy === "again"} onClick={() => act("again", `/api/campaigns/${campaign.id}/statics`)}>
              New set
            </Button>
          )}
          {ready.length > 0 && (
            <a href={`/api/statics/${statics.id}/download`} className="inline-flex h-8 items-center rounded-xl bg-gradient-to-r from-violet-500 to-fuchsia-500 px-3 text-xs font-medium text-white shadow-lg shadow-violet-500/20 hover:brightness-110">
              Download pack (.zip)
            </a>
          )}
        </div>
      </div>
      {error && <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">{error}</div>}

      {statics.study && (
        <Card title="Art direction" subtitle="Set by the ad study from the brand's site and the best-performing ads in its category">
          <div className="flex flex-wrap gap-1.5">
            <Badge tone="accent">{statics.study.art.type_style} type</Badge>
            <Badge>{statics.study.art.scheme} ground</Badge>
            <Badge>{statics.study.art.alt_scheme} second ground</Badge>
            <Badge>decoration: {statics.study.art.decoration}</Badge>
            <Badge>imagery: {statics.study.art.imagery.replace("_", " ")}</Badge>
            <Badge>{statics.study.art.cta_in_image ? "button in image" : "no button in image"}</Badge>
          </div>
          {statics.study.art.notes && <p className="mt-3 text-sm text-zinc-300">{statics.study.art.notes}</p>}
          {statics.study.brandIdentity && <p className="mt-2 text-xs text-zinc-500">On its own site: {statics.study.brandIdentity}</p>}
        </Card>
      )}

      {statics.ads.length > 0 && (
        <div className="grid gap-5 lg:grid-cols-2">
          {statics.ads.map((ad) => (
            <StaticAdCard key={ad.id} ad={ad} onChange={onChange} />
          ))}
        </div>
      )}

      {statics.search && <SearchAssetsCard search={statics.search} logos={statics.logos} domain={campaign.research?.domain ?? ""} brand={campaign.research?.brand.name ?? ""} />}

      {statics.research && (
        <Card title="What wins in this category" subtitle={`The ads the research ranked highest by their published signals (${statics.research.sources.done}/${statics.research.sources.total} sources). Ad libraries do not publish results for commercial ads; these are impression rank, days running, versions, and views and engagement on X.`}>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            {statics.research.ads
              .filter((ad) => ad.image)
              .slice(0, 15)
              .map((ad) => (
                <a key={ad.id} href={ad.url || ad.image!} target="_blank" rel="noreferrer" className={cx("group overflow-hidden rounded-xl border bg-white/[0.02]", statics.study?.studied.includes(ad.id) ? "border-violet-400/30" : "border-white/5")}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={ad.image!} alt="" loading="lazy" className="aspect-square w-full bg-zinc-900 object-cover opacity-90 group-hover:opacity-100" />
                  <div className="space-y-1 p-2">
                    <div className="truncate text-xs font-medium text-zinc-200">{ad.advertiser}</div>
                    <div className="flex flex-wrap gap-1">
                      <Badge>{ad.source}</Badge>
                      <Badge tone={ad.role === "brand" ? "accent" : ad.role === "competitor" ? "warn" : ad.role === "leader" ? "info" : "neutral"}>{ad.role}</Badge>
                    </div>
                    <div className="text-[11px] leading-snug text-zinc-500">{ad.signal}</div>
                  </div>
                </a>
              ))}
          </div>
          {statics.study?.patterns && (
            <details className="mt-4">
              <summary className="cursor-pointer text-sm text-zinc-300">What the study found</summary>
              <pre className="mt-3 max-h-96 overflow-auto whitespace-pre-wrap rounded-lg bg-black/30 p-4 text-xs text-zinc-300">{statics.study.patterns}</pre>
            </details>
          )}
          {statics.research.cases.length > 0 && (
            <div className="mt-4">
              <h3 className="mb-2 text-xs uppercase tracking-wider text-zinc-500">Case studies found</h3>
              <ul className="space-y-1 text-sm">
                {statics.research.cases.map((c) => (
                  <li key={c.url}>
                    <a href={c.url} target="_blank" rel="noreferrer" className="text-violet-300 hover:underline">
                      {c.title}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {statics.research.searchAds.length > 0 && (
            <div className="mt-4">
              <h3 className="mb-2 text-xs uppercase tracking-wider text-zinc-500">Paid search ads on the category&apos;s searches</h3>
              <ul className="space-y-2 text-sm">
                {statics.research.searchAds.slice(0, 8).map((ad, i) => (
                  <li key={`${ad.url}-${i}`}>
                    <div className="text-sky-300">{ad.title}</div>
                    <div className="text-xs text-zinc-500">
                      {ad.advertiser} · “{ad.keyword}”{ad.description ? ` · ${ad.description}` : ""}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Card>
      )}
    </div>
  );
}

function StaticAdCard({ ad, onChange }: { ad: StaticAd; onChange: () => void }) {
  const concept = ad.concept;
  const [selected, setSelected] = useState(0);
  const [headline, setHeadline] = useState(concept?.copy.headline ?? "");
  const [subhead, setSubhead] = useState(concept?.copy.subhead ?? "");
  const [note, setNote] = useState("");
  const [showNote, setShowNote] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const renders = ad.renders;
  const shown = renders[selected] ?? renders[0];
  const dirty = headline !== (concept?.copy.headline ?? "") || subhead !== (concept?.copy.subhead ?? "");

  async function call(label: string, method: "POST" | "PATCH", payload: object) {
    setBusy(label);
    setError(null);
    try {
      await send(`/api/statics/ads/${ad.id}`, method, payload);
      setShowNote(false);
      onChange();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <article className={cx("overflow-hidden rounded-2xl border bg-white/[0.03]", ad.approved ? "border-emerald-500/30" : "border-white/10")}>
      <div className="grid gap-0 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="relative bg-zinc-950 p-3">
          {shown ? (
            <a href={shown.url} target="_blank" rel="noreferrer" className="block">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={shown.url} alt="" className="mx-auto max-h-[460px] w-auto rounded-lg object-contain" />
            </a>
          ) : (
            <div className="flex aspect-[4/5] items-center justify-center text-sm text-zinc-400">
              {ad.status === "failed" ? <span className="text-rose-300">{ad.error}</span> : <span className="flex items-center gap-2"><Spinner /> {ad.status === "checking" ? "Checking" : ad.status === "visual" ? "Preparing the picture" : "Rendering every size"}</span>}
            </div>
          )}
          {(ad.qc || ad.approved) && (
            <div className="absolute left-5 top-5 flex gap-1.5 rounded-full bg-black/60 p-1 backdrop-blur">
              {ad.qc && <Badge tone={ad.qc.score >= 8 ? "good" : ad.qc.score >= 7 ? "info" : "warn"}>check {ad.qc.score}/10</Badge>}
              {ad.approved && <Badge tone="good">Approved</Badge>}
            </div>
          )}
        </div>
        <div className="flex flex-col gap-3 p-4">
          <div>
            <div className="flex flex-wrap gap-1">
              <Badge tone="accent">{concept?.archetype.replace("_", " ")}</Badge>
              <Badge>{concept?.scheme}</Badge>
              {ad.visual && <Badge>{ad.visual.kind === "generated" ? "AI picture" : ad.visual.kind === "site_photo" ? "brand photo" : ad.visual.kind === "screenshot" ? "site screenshot" : "type only"}</Badge>}
            </div>
            <p className="mt-2 text-sm text-zinc-300">{concept?.angle}</p>
            {concept?.why && <p className="mt-1 text-xs text-zinc-500">{concept.why}</p>}
          </div>
          {renders.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {renders.map((r, i) => (
                <button key={r.placement} onClick={() => setSelected(i)} title={`${PLATFORM[r.platform] ?? r.platform}: ${r.label} · ${r.width}×${r.height} · ${Math.round(r.bytes / 1024)} KB`} className={cx("rounded-md px-1.5 py-0.5 text-[10px] ring-1 ring-inset", i === selected ? "bg-violet-500/20 text-violet-100 ring-violet-400/40" : "bg-white/[0.04] text-zinc-400 ring-white/10 hover:text-zinc-200")}>
                  {PLATFORM[r.platform] ?? r.platform} {r.width}×{r.height}
                  {r.textFree ? " · no text" : ""}
                </button>
              ))}
            </div>
          )}
          {ad.qc && !ad.qc.pass && ad.qc.issues.length > 0 && (
            <details className="rounded-lg border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-xs text-amber-200">
              <summary className="cursor-pointer">Check notes ({ad.qc.issues.length})</summary>
              <ul className="mt-2 list-disc space-y-1 pl-4">
                {ad.qc.issues.map((issue) => (
                  <li key={issue}>{issue}</li>
                ))}
              </ul>
            </details>
          )}
          <label className="block text-xs text-zinc-500">
            Headline <span className="text-zinc-600">(*words* in asterisks take the brand color)</span>
            <input value={headline} onChange={(e) => setHeadline(e.target.value)} className="mt-1 w-full rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-sm text-zinc-200 focus:border-violet-400/50 focus:outline-none" />
          </label>
          <label className="block text-xs text-zinc-500">
            Subhead
            <input value={subhead} onChange={(e) => setSubhead(e.target.value)} className="mt-1 w-full rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-sm text-zinc-200 focus:border-violet-400/50 focus:outline-none" />
          </label>
          {concept && (
            <details className="text-xs text-zinc-400">
              <summary className="cursor-pointer text-zinc-300">Platform copy</summary>
              <dl className="mt-2 space-y-2">
                <div>
                  <dt className="text-zinc-500">Meta · {concept.meta.cta}</dt>
                  {concept.meta.primary_text.map((t) => (
                    <dd key={t} className="text-zinc-300">{t}</dd>
                  ))}
                  <dd className="text-zinc-200">{concept.meta.headline} <span className="text-zinc-500">· {concept.meta.description}</span></dd>
                </div>
                <div>
                  <dt className="text-zinc-500">X</dt>
                  <dd className="text-zinc-300">{concept.x.post}</dd>
                  <dd className="text-zinc-500">Card: {concept.x.card_headline}</dd>
                </div>
                <div>
                  <dt className="text-zinc-500">Reddit · {concept.reddit.cta}</dt>
                  <dd className="text-zinc-300">{concept.reddit.headline}</dd>
                </div>
                {concept.sources.length > 0 && (
                  <div>
                    <dt className="text-zinc-500">Supported by the site</dt>
                    {concept.sources.map((s) => (
                      <dd key={s} className="text-zinc-400">“{s}”</dd>
                    ))}
                  </div>
                )}
              </dl>
            </details>
          )}
          {showNote && <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder="Note for the next version, e.g. use the dark ground, shorter headline" className="w-full rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-sm text-zinc-200 focus:border-violet-400/50 focus:outline-none" />}
          {error && <p className="text-xs text-rose-300">{error}</p>}
          <div className="mt-auto flex flex-wrap gap-2">
            {dirty && (
              <Button size="sm" loading={busy === "copy"} onClick={() => call("copy", "PATCH", { headline, subhead })}>
                Save and re-render
              </Button>
            )}
            {ad.status === "ready" && (
              <Button size="sm" variant={ad.approved ? "secondary" : "primary"} loading={busy === "approve"} onClick={() => call("approve", "PATCH", { approved: !ad.approved })}>
                {ad.approved ? "Unapprove" : "Approve"}
              </Button>
            )}
            {(ad.status === "ready" || ad.status === "failed") &&
              (showNote ? (
                <Button size="sm" loading={busy === "redo"} onClick={() => call("redo", "POST", { note })}>
                  Make again
                </Button>
              ) : (
                <Button size="sm" variant="ghost" onClick={() => setShowNote(true)}>
                  Make again…
                </Button>
              ))}
          </div>
        </div>
      </div>
    </article>
  );
}

function SearchAssetsCard({ search, logos, domain, brand }: { search: NonNullable<Statics["search"]>; logos: string[]; domain: string; brand: string }) {
  const count = (text: string, max: number) => <span className={cx("ml-2 tabular-nums text-[11px]", text.length > max ? "text-rose-300" : "text-zinc-500")}>{text.length}/{max}</span>;
  return (
    <Card title="Google: search, display and Performance Max text" subtitle="Responsive search ad in Google Ads Editor's import format, plus sitelinks, callouts and display text. Every line is within Google's limits and editorial rules.">
      <div className="rounded-xl border border-white/10 bg-white p-4 text-[#202124]">
        <div className="text-xs">Sponsored</div>
        <div className="mt-0.5 flex items-center gap-2 text-xs text-[#4d5156]">
          <span className="font-medium text-[#202124]">{brand}</span>
          <span>
            {domain}
            {search.rsa.path1 ? ` › ${search.rsa.path1}` : ""}
            {search.rsa.path2 ? ` › ${search.rsa.path2}` : ""}
          </span>
        </div>
        <div className="mt-1 text-lg leading-snug text-[#1a0dab]">{search.rsa.headlines.slice(0, 3).join(" | ")}</div>
        <div className="mt-1 text-sm text-[#4d5156]">{search.rsa.descriptions.slice(0, 2).join(" ")}</div>
        {search.sitelinks.length > 0 && <div className="mt-2 flex flex-wrap gap-x-4 text-sm text-[#1a0dab]">{search.sitelinks.map((s) => <span key={s.text}>{s.text}</span>)}</div>}
      </div>
      <div className="mt-5 grid gap-6 md:grid-cols-3">
        <div>
          <h3 className="mb-2 text-xs uppercase tracking-wider text-zinc-500">Headlines ({search.rsa.headlines.length})</h3>
          <ul className="space-y-1 text-sm text-zinc-200">{search.rsa.headlines.map((h) => <li key={h}>{h}{count(h, 30)}</li>)}</ul>
        </div>
        <div>
          <h3 className="mb-2 text-xs uppercase tracking-wider text-zinc-500">Descriptions</h3>
          <ul className="space-y-2 text-sm text-zinc-300">{search.rsa.descriptions.map((d) => <li key={d}>{d}{count(d, 90)}</li>)}</ul>
          <h3 className="mb-2 mt-4 text-xs uppercase tracking-wider text-zinc-500">Callouts</h3>
          <div className="flex flex-wrap gap-1">{search.callouts.map((c) => <Badge key={c}>{c}</Badge>)}</div>
          {search.snippet.values.length > 0 && <p className="mt-3 text-xs text-zinc-400">{search.snippet.header}: {search.snippet.values.join(", ")}</p>}
        </div>
        <div>
          <h3 className="mb-2 text-xs uppercase tracking-wider text-zinc-500">Display and Performance Max</h3>
          <ul className="space-y-1 text-sm text-zinc-300">
            {search.display.long_headline && <li>{search.display.long_headline}{count(search.display.long_headline, 90)}</li>}
            {search.pmax.long_headlines.map((h) => <li key={h}>{h}{count(h, 90)}</li>)}
          </ul>
          {logos.length > 0 && (
            <div className="mt-4 flex items-center gap-3">
              {logos.map((src) => (
                // eslint-disable-next-line @next/next/no-img-element
                <img key={src} src={src} alt="" className="h-12 rounded border border-white/10 bg-white object-contain" />
              ))}
            </div>
          )}
          {search.short && search.short.length > 0 && <p className="mt-3 text-xs text-amber-200">{search.short.join(". ")}.</p>}
        </div>
      </div>
    </Card>
  );
}
