"use client";

import { useCallback, useEffect, useState } from "react";
import type { CampaignView } from "@/lib/views";
import { Badge, Button, Card, Empty } from "./ui";

type Account = { platform: string; name: string; id: string };

const STATUS_TONE = { pending: "info", scheduled: "accent", processing: "info", posted: "good", failed: "bad", deleted: "neutral" } as const;

export function PublishView({ brandId, campaign, onChange }: { brandId: string; campaign: CampaignView; onChange: () => void }) {
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [accountError, setAccountError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: "good" | "bad"; text: string } | null>(null);

  const loadAccounts = useCallback(async () => {
    const response = await fetch(`/api/brands/${brandId}/social`, { cache: "no-store" });
    const data = await response.json();
    setAccounts(data.accounts ?? []);
    setAccountError(data.error ?? null);
  }, [brandId]);

  useEffect(() => {
    void loadAccounts();
  }, [loadAccounts]);

  async function connect() {
    setBusy("connect");
    setMessage(null);
    try {
      const response = await fetch(`/api/brands/${brandId}/social`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ returnTo: window.location.href }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Could not open the connection page");
      window.open(data.url, "_blank", "noopener");
      setMessage({ tone: "good", text: "The connection page opened in a new tab. Connect the brand's accounts there, then press Refresh." });
    } catch (err) {
      setMessage({ tone: "bad", text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(null);
    }
  }

  async function publish(mode: "now" | "daily") {
    setBusy(mode);
    setMessage(null);
    try {
      const response = await fetch(`/api/campaigns/${campaign.id}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "publish", mode }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Could not publish");
      setMessage({ tone: "good", text: `${data.queued} video${data.queued === 1 ? "" : "s"} queued${mode === "daily" ? ", one per day at 16:00 UTC" : ""}.` });
      onChange();
    } catch (err) {
      setMessage({ tone: "bad", text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(null);
    }
  }

  const approved = campaign.creatives.filter((c) => c.approved && c.status === "ready");
  const titles = new Map(campaign.creatives.map((c) => [c.id, c.concept?.title ?? "Video"]));

  return (
    <div className="grid gap-5 lg:grid-cols-3">
      <Card
        title="The brand's accounts"
        subtitle="Nomen posts only to accounts the brand owns, connected through Naive. It never sees the passwords."
        action={
          <Button size="sm" variant="ghost" onClick={() => void loadAccounts()}>
            Refresh
          </Button>
        }
      >
        {accounts === null ? (
          <p className="text-sm text-zinc-500">Loading…</p>
        ) : accounts.length === 0 ? (
          <p className="text-sm text-zinc-400">No accounts connected yet.</p>
        ) : (
          <ul className="space-y-2">
            {accounts.map((account) => (
              <li key={`${account.platform}-${account.id}`} className="flex items-center gap-2 text-sm">
                <Badge tone="good">{account.platform}</Badge>
                <span className="text-zinc-200">{account.name}</span>
              </li>
            ))}
          </ul>
        )}
        {accountError && <p className="mt-2 text-xs text-rose-300">{accountError}</p>}
        <Button className="mt-4 w-full" loading={busy === "connect"} onClick={() => void connect()}>
          Connect accounts
        </Button>
        <p className="mt-3 text-xs text-zinc-500">TikTok, Instagram, YouTube, X, Facebook, LinkedIn and Threads can receive videos.</p>
      </Card>

      <Card title="Publish approved videos" subtitle="Every post carries each network's AI-generated label and an #AIgenerated line." className="lg:col-span-2">
        {approved.length === 0 ? (
          <Empty title="Nothing approved yet">Approve videos on the Videos tab first.</Empty>
        ) : (
          <div className="space-y-4">
            <p className="text-sm text-zinc-300">
              {approved.length} approved video{approved.length === 1 ? "" : "s"} will go to the connected accounts that match each video&apos;s platforms.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button variant="primary" loading={busy === "daily"} disabled={!accounts?.length} onClick={() => void publish("daily")}>
                Schedule one per day
              </Button>
              <Button loading={busy === "now"} disabled={!accounts?.length} onClick={() => void publish("now")}>
                Post now
              </Button>
            </div>
          </div>
        )}
        {message && <p className={`mt-3 text-sm ${message.tone === "good" ? "text-emerald-300" : "text-rose-300"}`}>{message.text}</p>}
      </Card>

      <Card title="Posts" className="lg:col-span-3">
        {campaign.posts.length === 0 ? (
          <p className="text-sm text-zinc-500">No posts yet.</p>
        ) : (
          <div className="divide-y divide-white/5">
            {campaign.posts.map((post) => (
              <div key={post.id} className="flex flex-wrap items-center gap-3 py-3 text-sm">
                <span className="min-w-0 flex-1 truncate text-zinc-200">{titles.get(post.creativeId)}</span>
                <span className="flex gap-1">
                  {post.platforms.map((platform) => (
                    <Badge key={platform}>{platform}</Badge>
                  ))}
                </span>
                <span className="w-40 text-xs text-zinc-500">{post.scheduledAt ? new Date(post.scheduledAt).toLocaleString() : "as soon as possible"}</span>
                <Badge tone={STATUS_TONE[post.status as keyof typeof STATUS_TONE] ?? "neutral"}>{post.status}</Badge>
                {post.analytics && <span className="text-xs text-zinc-400">{summarize(post.analytics)}</span>}
                {post.error && <span className="w-full text-xs text-rose-300">{post.error}</span>}
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

function summarize(analytics: Record<string, unknown>) {
  const numbers: string[] = [];
  const walk = (value: unknown, key = "") => {
    if (typeof value === "number" && /view|like|comment|share|impression|play/i.test(key)) numbers.push(`${key.replace(/_/g, " ")} ${Intl.NumberFormat("en", { notation: "compact" }).format(value)}`);
    else if (value && typeof value === "object") Object.entries(value as Record<string, unknown>).forEach(([k, v]) => walk(v, k));
  };
  walk(analytics);
  return numbers.slice(0, 4).join(" · ");
}
