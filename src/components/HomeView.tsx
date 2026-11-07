"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useState } from "react";
import type { BrandListItem } from "@/lib/views";
import { Badge, Button, Empty } from "./ui";

const STAGE_LABEL: Record<string, string> = {
  research: "Researching",
  style: "Studying top videos",
  strategy: "Writing the strategy",
  production: "Producing videos",
  review: "Ready for review",
  live: "Live",
};

export function campaignBadge(campaign: BrandListItem["campaign"]) {
  if (!campaign) return <Badge>No campaign</Badge>;
  if (campaign.status === "failed") return <Badge tone="bad">Needs attention</Badge>;
  if (campaign.status === "stopped") return <Badge>Stopped</Badge>;
  if (campaign.status === "review") return <Badge tone="accent">Ready for review</Badge>;
  if (campaign.status === "publishing") return <Badge tone="info">Publishing</Badge>;
  if (campaign.status === "live") return <Badge tone="good">Live</Badge>;
  return <Badge tone="info">{STAGE_LABEL[campaign.stage] ?? campaign.stage}</Badge>;
}

export function HomeView({ initialBrands }: { initialBrands: BrandListItem[] }) {
  const router = useRouter();
  const [brands, setBrands] = useState(initialBrands);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const timer = setInterval(() => {
      fetch("/api/brands")
        .then((response) => response.json())
        .then((data: { brands: BrandListItem[] }) => setBrands(data.brands))
        .catch(() => undefined);
    }, 8000);
    return () => clearInterval(timer);
  }, []);

  async function start(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/brands", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Could not start");
      router.push(`/brands/${data.brandId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <div className="space-y-14">
      <section className="mx-auto max-w-3xl pt-10 text-center">
        <Badge tone="accent">Research → strategy → video → posting</Badge>
        <h1 className="mt-5 text-4xl font-semibold tracking-tight text-white sm:text-5xl">Paste a website. Get a campaign.</h1>
        <p className="mx-auto mt-4 max-w-2xl text-base text-zinc-400">
          Nomen researches the brand, its competitors and what is winning on TikTok, Reels and in AI answers, then writes and produces original UGC-style video ads, checks every
          shot, and posts the ones you approve to the brand&apos;s own accounts.
        </p>
        <form onSubmit={start} className="mx-auto mt-8 flex max-w-xl flex-col gap-3 sm:flex-row">
          <input
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder="yourbrand.com"
            autoFocus
            className="h-12 flex-1 rounded-xl border border-white/10 bg-white/[0.04] px-4 text-base text-white placeholder:text-zinc-500 focus:border-violet-400/60 focus:outline-none focus:ring-4 focus:ring-violet-500/10"
          />
          <Button variant="primary" size="lg" loading={busy} disabled={!url.trim()}>
            Start campaign
          </Button>
        </form>
        {error && <p className="mt-3 text-sm text-rose-300">{error}</p>}
      </section>

      <section>
        <div className="mb-4 flex items-baseline justify-between">
          <h2 className="text-sm font-semibold text-zinc-200">Brands</h2>
          <span className="text-xs text-zinc-500">{brands.length} total</span>
        </div>
        {brands.length === 0 ? (
          <Empty title="No brands yet">Start with any website above. Research takes about two minutes; videos take ten to twenty.</Empty>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {brands.map((brand) => (
              <Link key={brand.id} href={`/brands/${brand.id}`} className="group overflow-hidden rounded-2xl border border-white/10 bg-white/[0.03] transition hover:border-white/20 hover:bg-white/[0.05]">
                <div className="relative aspect-[16/9] overflow-hidden bg-zinc-900">
                  {brand.poster ? (
                    <video src={`/api/media/${brand.poster}/final.mp4#t=1`} muted playsInline preload="metadata" className="size-full object-cover opacity-90 transition group-hover:opacity-100" />
                  ) : (
                    <div className="size-full" style={{ background: `linear-gradient(135deg, ${brand.colors[0] ?? "#4c1d95"}, ${brand.colors[1] ?? "#18181b"})` }} />
                  )}
                </div>
                <div className="flex items-center gap-3 p-4">
                  {brand.logo ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={brand.logo} alt="" className="size-9 rounded-lg bg-white object-contain p-1" />
                  ) : (
                    <div className="grid size-9 place-items-center rounded-lg bg-white/10 text-sm font-semibold">{brand.name[0]}</div>
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium text-zinc-100">{brand.name}</div>
                    <div className="truncate text-xs text-zinc-500">{brand.domain}</div>
                  </div>
                  <div className="flex flex-col items-end gap-1">
                    {campaignBadge(brand.campaign)}
                    {brand.total > 0 && (
                      <span className="text-[11px] text-zinc-500">
                        {brand.ready}/{brand.total} videos
                      </span>
                    )}
                  </div>
                </div>
              </Link>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
