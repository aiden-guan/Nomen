import type { CampaignView } from "@/lib/views";
import { Badge, Card, Empty } from "./ui";

const compact = (n: number | null) => (n === null ? "—" : Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(n));

export function ResearchView({ campaign }: { campaign: CampaignView }) {
  const research = campaign.research;
  const sources = (
    <Card title="Sources" subtitle="Every research call ran on Monid; cost is what Monid billed.">
      <div className="divide-y divide-white/5 text-sm">
        {campaign.runs.map((run) => (
          <div key={run.key} className="flex items-center justify-between gap-3 py-2">
            <span className="min-w-0 truncate text-zinc-300">
              {run.provider} <span className="text-zinc-500">{run.endpoint}</span>
            </span>
            <span className="flex shrink-0 items-center gap-2">
              {run.error && <span className="max-w-48 truncate text-xs text-rose-300">{run.error}</span>}
              <Badge tone={run.status === "done" ? "good" : run.status === "failed" ? "bad" : "info"}>{run.status}</Badge>
              <span className="w-16 text-right text-xs tabular-nums text-zinc-500">${run.cost.toFixed(4)}</span>
            </span>
          </div>
        ))}
      </div>
    </Card>
  );
  if (!research) return campaign.runs.length ? sources : <Empty title="Research has not started" />;

  return (
    <div className="grid gap-5 lg:grid-cols-3">
      <Card title="Top short-form videos" subtitle="TikTok, Instagram Reels and YouTube Shorts, ranked by views within each platform" className="lg:col-span-2">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-xs text-zinc-500">
              <tr>
                <th className="py-2 pr-3 font-normal">Video</th>
                <th className="py-2 pr-3 text-right font-normal">Views</th>
                <th className="py-2 pr-3 text-right font-normal">Likes</th>
                <th className="py-2 text-right font-normal">Length</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {research.videos.map((video) => (
                <tr key={video.url}>
                  <td className="max-w-md py-2 pr-3">
                    <a href={video.url} target="_blank" rel="noreferrer" className="line-clamp-1 text-zinc-200 hover:text-white">
                      {video.caption || video.url}
                    </a>
                    <div className="mt-0.5 flex items-center gap-1.5 text-xs text-zinc-500">
                      <Badge>{video.platform}</Badge>@{video.author}
                      {video.paid && <Badge tone="warn">paid partnership</Badge>}
                    </div>
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums text-zinc-300">{compact(video.views)}</td>
                  <td className="py-2 pr-3 text-right tabular-nums text-zinc-400">{compact(video.likes)}</td>
                  <td className="py-2 text-right tabular-nums text-zinc-400">{video.duration ? `${Math.round(video.duration)}s` : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <div className="space-y-5">
        <Card title="AI answers" subtitle="What ChatGPT and Perplexity say when a buyer asks">
          <div className="space-y-4">
            {research.aeo.length === 0 && <p className="text-sm text-zinc-500">No AI answers were collected.</p>}
            {research.aeo.map((answer) => (
              <div key={answer.engine}>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-zinc-100">{answer.engine}</span>
                  <Badge tone={answer.mentions_brand ? "good" : "bad"}>{answer.mentions_brand ? "mentions the brand" : "brand not mentioned"}</Badge>
                </div>
                <p className="mt-1 text-xs text-zinc-500">“{answer.prompt}”</p>
                {answer.competitors_mentioned.length > 0 && <p className="mt-1 text-xs text-zinc-400">Also names: {answer.competitors_mentioned.join(", ")}</p>}
                <details className="mt-1 text-xs text-zinc-400">
                  <summary className="cursor-pointer text-zinc-500">Read the answer</summary>
                  <p className="mt-1 whitespace-pre-line">{answer.answer}</p>
                </details>
              </div>
            ))}
          </div>
        </Card>
        <Card title="Search" subtitle={research.seo.domain_rating !== null ? `Ahrefs domain rating ${research.seo.domain_rating}` : "Ahrefs"}>
          <div className="space-y-1 text-sm">
            {research.seo.keywords.slice(0, 12).map((keyword) => (
              <div key={keyword.keyword} className="flex justify-between gap-2">
                <span className="truncate text-zinc-300">{keyword.keyword}</span>
                <span className="shrink-0 tabular-nums text-xs text-zinc-500">
                  {compact(keyword.volume)}/mo · #{keyword.position ?? "—"}
                </span>
              </div>
            ))}
          </div>
        </Card>
      </div>

      <Card title="Live ads" subtitle="Meta and TikTok ad libraries" className="lg:col-span-2">
        <div className="grid gap-3 sm:grid-cols-2">
          {research.ads.map((ad, i) => (
            <div key={`${ad.advertiser}-${i}`} className="rounded-xl border border-white/5 bg-white/[0.02] p-3">
              <div className="flex items-center justify-between gap-2 text-xs">
                <span className="font-medium text-zinc-200">{ad.advertiser}</span>
                <span className="flex gap-1">
                  <Badge>{ad.platform}</Badge>
                  {ad.media && <Badge>{ad.media}</Badge>}
                </span>
              </div>
              <p className="mt-2 line-clamp-3 text-sm text-zinc-400">{ad.text}</p>
              <div className="mt-2 flex justify-between text-xs text-zinc-500">
                <span>{ad.started && `since ${ad.started}`}</span>
                {ad.url && (
                  <a href={ad.url} target="_blank" rel="noreferrer" className="text-violet-300 hover:underline">
                    view ↗
                  </a>
                )}
              </div>
            </div>
          ))}
        </div>
      </Card>

      <Card title="Voice of the customer" subtitle="On-topic Reddit threads">
        <div className="space-y-3">
          {research.reddit.length === 0 && <p className="text-sm text-zinc-500">No on-topic threads found.</p>}
          {research.reddit.map((post) => (
            <a key={post.url} href={post.url} target="_blank" rel="noreferrer" className="block rounded-lg p-2 hover:bg-white/[0.03]">
              <div className="text-sm text-zinc-200">{post.title}</div>
              <div className="mt-0.5 text-xs text-zinc-500">
                r/{post.subreddit} · {compact(post.score)} upvotes · {compact(post.comments)} comments
              </div>
            </a>
          ))}
        </div>
      </Card>

      {campaign.style && (
        <Card title="Format study" subtitle={campaign.style.slug ? `Saved on Naive as ${campaign.style.slug}@${campaign.style.version}` : undefined} className="lg:col-span-3">
          <details>
            <summary className="cursor-pointer text-sm text-zinc-300">What the top videos have in common</summary>
            <pre className="mt-3 max-h-96 overflow-auto whitespace-pre-wrap rounded-lg bg-black/30 p-4 text-xs text-zinc-300">{campaign.style.skill_md}</pre>
          </details>
        </Card>
      )}

      <div className="lg:col-span-3">{sources}</div>
    </div>
  );
}
