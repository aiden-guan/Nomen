import type { Strategy } from "@/lib/strategy";
import { Badge, Card } from "./ui";

const List = ({ items }: { items: string[] }) => (
  <ul className="space-y-1.5 text-sm text-zinc-300">
    {items.map((item) => (
      <li key={item} className="flex gap-2">
        <span className="mt-2 size-1 shrink-0 rounded-full bg-violet-400" />
        <span>{item}</span>
      </li>
    ))}
  </ul>
);

export function StrategyView({ strategy }: { strategy: Strategy }) {
  const { brand, audience, competitors, content_patterns: patterns, search, campaign } = strategy;
  return (
    <div className="grid gap-5 lg:grid-cols-3">
      <Card title={brand.name} subtitle={brand.category} className="lg:col-span-2">
        <p className="text-lg leading-relaxed text-zinc-100">{brand.one_liner}</p>
        <div className="mt-5 grid gap-5 sm:grid-cols-2">
          <div>
            <h3 className="mb-2 text-xs uppercase tracking-wider text-zinc-500">Value props</h3>
            <List items={brand.value_props} />
          </div>
          <div>
            <h3 className="mb-2 text-xs uppercase tracking-wider text-zinc-500">Proof points (from the site)</h3>
            <List items={brand.proof_points} />
          </div>
          <div>
            <h3 className="mb-2 text-xs uppercase tracking-wider text-zinc-500">Tone</h3>
            <p className="text-sm text-zinc-300">{brand.tone}</p>
          </div>
          <div>
            <h3 className="mb-2 text-xs uppercase tracking-wider text-zinc-500">Visual style</h3>
            <p className="text-sm text-zinc-300">{brand.visual_style}</p>
          </div>
        </div>
      </Card>

      <Card title={campaign.name} subtitle="Campaign">
        <p className="text-sm text-zinc-300">{campaign.objective}</p>
        <h3 className="mb-1 mt-4 text-xs uppercase tracking-wider text-zinc-500">Posting plan</h3>
        <p className="text-sm text-zinc-300">{campaign.posting_plan.cadence}</p>
        <div className="mt-2 flex flex-wrap gap-1">
          {campaign.posting_plan.best_times.map((time) => (
            <Badge key={time}>{time}</Badge>
          ))}
        </div>
        {campaign.posting_plan.notes && <p className="mt-2 text-xs text-zinc-400">{campaign.posting_plan.notes}</p>}
      </Card>

      <Card title="Audience" className="lg:col-span-3">
        <div className="grid gap-4 md:grid-cols-3">
          {audience.map((persona) => (
            <div key={persona.name} className="rounded-xl border border-white/5 bg-white/[0.02] p-4">
              <div className="font-medium text-zinc-100">{persona.name}</div>
              <p className="mt-1 text-sm text-zinc-400">{persona.description}</p>
              <h4 className="mb-1 mt-3 text-[11px] uppercase tracking-wider text-zinc-500">Pains</h4>
              <List items={persona.pains} />
              <h4 className="mb-1 mt-3 text-[11px] uppercase tracking-wider text-zinc-500">Motivations</h4>
              <List items={persona.motivations} />
            </div>
          ))}
        </div>
      </Card>

      <Card title="What is working in the category" className="lg:col-span-2">
        <div className="space-y-4">
          {patterns.map((pattern) => (
            <div key={pattern.pattern}>
              <div className="font-medium text-zinc-100">{pattern.pattern}</div>
              <p className="mt-1 text-sm text-zinc-400">{pattern.why_it_works}</p>
              <div className="mt-1 flex flex-wrap gap-2">
                {pattern.examples.map((example) =>
                  /^https?:\/\//.test(example) ? (
                    <a key={example} href={example} target="_blank" rel="noreferrer" className="text-xs text-violet-300 hover:underline">
                      example ↗
                    </a>
                  ) : (
                    <span key={example} className="text-xs text-zinc-500">
                      {example}
                    </span>
                  ),
                )}
              </div>
            </div>
          ))}
        </div>
      </Card>

      <Card title="Competitors">
        <div className="space-y-3">
          {competitors.map((competitor) => (
            <div key={competitor.name}>
              <div className="font-medium text-zinc-100">{competitor.name}</div>
              <p className="text-sm text-zinc-400">{competitor.positioning}</p>
              <p className="mt-1 text-xs text-zinc-500">Working for them: {competitor.what_works}</p>
            </div>
          ))}
        </div>
      </Card>

      <Card title="Search: SEO, AI answers (AEO) and generative search (GEO)" className="lg:col-span-3">
        <div className="grid gap-6 md:grid-cols-3">
          <div>
            <h3 className="mb-2 text-xs uppercase tracking-wider text-zinc-500">Keywords to win</h3>
            <div className="space-y-1.5">
              {search.seo_keywords.map((keyword) => (
                <div key={keyword.keyword} className="flex items-center justify-between gap-2 text-sm">
                  <span className="text-zinc-200">{keyword.keyword}</span>
                  <span className="flex gap-1">
                    <Badge>{keyword.intent}</Badge>
                    <Badge tone={keyword.priority.toLowerCase().startsWith("h") ? "accent" : "neutral"}>{keyword.priority}</Badge>
                  </span>
                </div>
              ))}
            </div>
            <h3 className="mb-2 mt-4 text-xs uppercase tracking-wider text-zinc-500">SEO actions</h3>
            <List items={search.seo_actions} />
          </div>
          <div>
            <h3 className="mb-2 text-xs uppercase tracking-wider text-zinc-500">How AI assistants describe the brand</h3>
            <p className="text-sm text-zinc-300">{search.aeo_status}</p>
            <h3 className="mb-2 mt-4 text-xs uppercase tracking-wider text-zinc-500">AEO actions</h3>
            <List items={search.aeo_actions} />
          </div>
          <div>
            <h3 className="mb-2 text-xs uppercase tracking-wider text-zinc-500">GEO actions</h3>
            <List items={search.geo_actions} />
          </div>
        </div>
      </Card>
    </div>
  );
}
