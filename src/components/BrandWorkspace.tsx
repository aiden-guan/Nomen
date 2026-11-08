"use client";

import { useCallback, useEffect, useState } from "react";
import type { BrandView } from "@/lib/views";
import { AutopilotPanel } from "./AutopilotPanel";
import { campaignBadge } from "./HomeView";
import { BrandKitPanel } from "./brandkit/BrandKitPanel";
import { PhonesPanel } from "./phones/PhonesPanel";
import { CreativeCard } from "./CreativeCard";
import { Pipeline } from "./Pipeline";
import { PublishView } from "./PublishView";
import { ResearchView } from "./ResearchView";
import { StaticAdsView } from "./StaticAdsView";
import { StrategyView } from "./StrategyView";
import { Badge, Button, Card, cx, Empty, Stat } from "./ui";

const TABS = ["Videos", "Static ads", "Strategy", "Research", "Brand kit", "Publish", "Autopilot", "Phones", "Activity"] as const;
type Tab = (typeof TABS)[number];

export function BrandWorkspace({ initial }: { initial: BrandView }) {
  const [view, setView] = useState(initial);
  const [tab, setTab] = useState<Tab>(initial.campaign?.creatives.length ? "Videos" : initial.campaign?.statics || initial.campaign?.options.concepts === 0 ? "Static ads" : "Research");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const campaign = view.campaign;
  const live = campaign?.status === "running" || campaign?.status === "publishing" || campaign?.statics?.status === "running";

  const refresh = useCallback(async () => {
    const response = await fetch(`/api/brands/${view.brand.id}`, { cache: "no-store" });
    if (response.ok) setView(await response.json());
  }, [view.brand.id]);

  useEffect(() => {
    const timer = setInterval(() => void refresh(), live ? 3000 : 15000);
    return () => clearInterval(timer);
  }, [refresh, live]);

  async function act(label: string, url: string, payload: object = {}) {
    setBusy(label);
    setError(null);
    try {
      const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Request failed");
      await refresh();
      return data;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  const profile = view.brand.profile;
  const creatives = campaign?.creatives ?? [];
  const ready = creatives.filter((c) => c.status === "ready");
  const niche = campaign?.plan ? [campaign.plan.category, ...campaign.plan.content_queries] : [];

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-center gap-4">
        {profile?.logo ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={profile.logo} alt="" className="size-14 rounded-2xl bg-white object-contain p-1.5" />
        ) : (
          <div className="grid size-14 place-items-center rounded-2xl bg-white/10 text-xl font-semibold">{view.brand.name[0]}</div>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight">{view.brand.name}</h1>
            {campaign && campaignBadge({ id: campaign.id, status: campaign.status, stage: campaign.stage, error: campaign.error })}
          </div>
          <a href={view.brand.url} target="_blank" rel="noreferrer" className="text-sm text-zinc-400 hover:text-zinc-200">
            {view.brand.domain} ↗
          </a>
          {profile?.colors.length ? (
            <div className="mt-2 flex gap-1">
              {profile.colors.map((color) => (
                <span key={color} title={color} className="size-4 rounded-full ring-1 ring-white/20" style={{ background: color }} />
              ))}
            </div>
          ) : null}
        </div>
        <div className="flex flex-wrap gap-2">
          {campaign?.status === "running" && (
            <Button variant="ghost" loading={busy === "stop"} onClick={() => act("stop", `/api/campaigns/${campaign.id}`, { action: "stop" })}>
              Stop
            </Button>
          )}
          {(campaign?.status === "failed" || campaign?.status === "stopped") && (
            <Button loading={busy === "retry"} onClick={() => act("retry", `/api/campaigns/${campaign.id}`, { action: "retry" })}>
              {campaign.status === "stopped" ? "Resume" : "Retry"}
            </Button>
          )}
          <Button variant="ghost" loading={busy === "static"} disabled={campaign?.status === "running"} onClick={() => act("static", `/api/brands/${view.brand.id}/campaigns`, { concepts: 0, statics: true })}>
            Static ads only
          </Button>
          <Button variant="primary" loading={busy === "new"} disabled={campaign?.status === "running"} onClick={() => act("new", `/api/brands/${view.brand.id}/campaigns`)}>
            New campaign
          </Button>
        </div>
      </header>

      {error && <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">{error}</div>}

      {!campaign ? (
        <Empty title="No campaign yet">Start one to research the brand and produce videos.</Empty>
      ) : (
        <>
          {campaign.options.concepts === 0 ? (
            <div className="rounded-xl border border-white/10 bg-white/[0.02] px-4 py-3 text-sm text-zinc-300">
              Static ads only: this campaign researches the brand and makes static ads, with no video. Progress is on the Static ads tab.
            </div>
          ) : (
            <Pipeline campaign={campaign} />
          )}
          {campaign.error && campaign.status !== "running" && (
            <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">{campaign.error}</div>
          )}
          {campaign.naiveOut && (
            <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
              Naive ran out of credits during this campaign, so new renders use Kling 3.0 on Monid. Top up Naive to switch back.
            </div>
          )}

          <div className="grid gap-4 sm:grid-cols-4">
            {campaign.options.concepts === 0 ? (
              <Stat label="Static ads ready" value={`${campaign.statics?.ads.filter((ad) => ad.status === "ready").length ?? 0} / ${campaign.statics?.ads.length ?? 0}`} hint="each at every platform size" />
            ) : (
              <Stat label="Videos ready" value={`${ready.length} / ${creatives.length || campaign.options.concepts}`} hint={`${campaign.options.shotsPerConcept} shots × ${campaign.options.secondsPerShot}s each`} />
            )}
            {campaign.options.concepts === 0 ? (
              <Stat label="Naive spend" value={`≈$${(campaign.statics?.spend.modelEstimate ?? 0).toFixed(2)}`} hint="static ads: model calls, estimated from tokens" />
            ) : (
              <Stat label="Naive spend" value={`$${campaign.spend.naive.toFixed(2)}`} hint={campaign.estimateUsd ? `video estimate ~$${campaign.estimateUsd.toFixed(2)}` : campaign.options.videoModel} />
            )}
            <Stat label="Monid spend" value={`$${campaign.spend.monid.toFixed(2)}`} hint={`${campaign.runs.filter((r) => r.status === "done").length} research sources`} />
            <Stat label="Posts" value={campaign.posts.length} hint={`${campaign.posts.filter((p) => p.status === "posted").length} live`} />
          </div>

          <nav className="flex gap-1 overflow-x-auto border-b border-white/10">
            {TABS.map((name) => (
              <button
                key={name}
                onClick={() => setTab(name)}
                className={cx("-mb-px border-b-2 px-4 py-2.5 text-sm transition", tab === name ? "border-violet-400 text-white" : "border-transparent text-zinc-400 hover:text-zinc-200")}
              >
                {name}
                {name === "Videos" && creatives.length > 0 && <span className="ml-1.5 text-xs text-zinc-500">{creatives.length}</span>}
                {name === "Static ads" && (campaign.statics?.ads.length ?? 0) > 0 && <span className="ml-1.5 text-xs text-zinc-500">{campaign.statics!.ads.length}</span>}
              </button>
            ))}
          </nav>

          {tab === "Videos" &&
            (creatives.length === 0 ? (
              <Empty title={campaign.status === "running" ? "Videos are on their way" : "No videos in this campaign"}>
                {campaign.status === "running" ? "Research and strategy come first; each concept then renders shot by shot and passes a quality check before it appears here." : null}
              </Empty>
            ) : (
              <div className="space-y-4">
                {ready.length > 0 && (
                  <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-white/10 bg-white/[0.02] px-4 py-3">
                    <p className="text-sm text-zinc-300">
                      Watch each video, edit captions, then approve the ones that represent the brand well. Only approved videos are posted.
                    </p>
                    <div className="flex gap-2">
                      <Button size="sm" loading={busy === "approve"} onClick={() => act("approve", `/api/campaigns/${campaign.id}`, { action: "approve_all" })}>
                        Approve all ready
                      </Button>
                      <Button size="sm" variant="primary" onClick={() => setTab("Publish")}>
                        Publish…
                      </Button>
                    </div>
                  </div>
                )}
                <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-4">
                  {creatives.map((creative) => (
                    <CreativeCard key={creative.id} creative={creative} onChange={() => void refresh()} />
                  ))}
                </div>
              </div>
            ))}

          {tab === "Static ads" && <StaticAdsView campaign={campaign} onChange={() => void refresh()} />}
          {tab === "Strategy" && (campaign.strategy ? <StrategyView strategy={campaign.strategy} /> : <Empty title="The strategy is not written yet">It follows the research, usually within a few minutes.</Empty>)}
          {tab === "Research" && <ResearchView campaign={campaign} />}
          {tab === "Publish" && <PublishView brandId={view.brand.id} campaign={campaign} onChange={() => void refresh()} />}
          {tab === "Autopilot" && <AutopilotPanel brandId={view.brand.id} onChange={() => void refresh()} />}
          {tab === "Brand kit" && <BrandKitPanel brandId={view.brand.id} brandName={view.brand.name} />}
          {tab === "Phones" && <PhonesPanel brandId={view.brand.id} brandName={view.brand.name} niche={niche} />}
          {tab === "Activity" && (
            <Card title="Activity">
              <ol className="space-y-2">
                {view.events.map((event, i) => (
                  <li key={`${event.ts}-${i}`} className="flex gap-3 text-sm">
                    <span className="w-16 shrink-0 tabular-nums text-xs text-zinc-500">{new Date(event.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
                    <span className={event.level === "error" ? "text-rose-300" : event.level === "warn" ? "text-amber-200" : "text-zinc-300"}>{event.message}</span>
                  </li>
                ))}
              </ol>
            </Card>
          )}

          {view.campaigns.length > 1 && (
            <p className="text-xs text-zinc-500">
              Showing the latest of {view.campaigns.length} campaigns for this brand. <Badge>{campaign.id}</Badge>
            </p>
          )}
        </>
      )}
    </div>
  );
}
