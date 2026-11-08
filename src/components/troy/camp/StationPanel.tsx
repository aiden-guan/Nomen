"use client";

import { type ReactNode, useEffect, useRef } from "react";
import { type BrandView, campaignAction, connectLink, type CreativeView, regenerate, setApproved } from "../api";
import type { Baker } from "../engine/baker";
import { type CampPlan, runLabel } from "../scenes/derive";
import { STATION, type StationId } from "../scenes/layout";
import styles from "../troy.module.css";
import { Avatar } from "./Avatar";
import { DEMO_ID } from "./demo";
import { Pip } from "./Camp";
import { money, platformName, when } from "./format";

type Act = (key: string, run: () => Promise<unknown>) => Promise<void>;

const STATE_WORD: Record<string, string> = { waiting: "Waiting", working: "Working", done: "Done", failed: "Stopped", skipped: "Skipped", yours: "Your turn" };

export function StationPanel({
  id,
  view,
  plan,
  baker,
  wide,
  busy,
  error,
  act,
  onClose,
}: {
  id: StationId;
  view: BrandView;
  plan: CampPlan;
  baker: Baker | null;
  wide: boolean;
  busy: string | null;
  error: string | null;
  act: Act;
  onClose: () => void;
}) {
  const station = STATION[id];
  const state = plan.stations[id];
  const here = plan.agents.filter((a) => a.station === id);
  // Scouts who already brought their findings back are off duty: count them instead of listing.
  const agents = here.filter((a) => !a.away && !a.returning);
  const away = here.filter((a) => a.away).length;
  const back = here.filter((a) => a.returning === "scroll").length;
  const empty = here.filter((a) => a.returning === "empty").length;
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    headingRef.current?.focus();
  }, [id]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <aside
      aria-label={`${station.name}: ${station.role}`}
      className={`${styles.box} ${styles.enter} absolute z-20 flex flex-col ${wide ? "bottom-4 right-4 top-[76px] w-[420px]" : "inset-x-3 bottom-3 h-[58vh]"}`}
    >
      <header className="flex items-start gap-3 border-b-2 border-[rgba(43,29,20,0.12)] px-5 pb-3 pt-4">
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-2 text-[11px] uppercase tracking-wider text-[var(--ink-soft)]">
            <Pip state={state.state} /> {station.role} · {STATE_WORD[state.state]}
          </p>
          <h2 ref={headingRef} tabIndex={-1} className={`${styles.pixel} mt-1 text-[24px] font-semibold leading-none outline-none`}>
            {station.name}
          </h2>
          <p className="mt-2 text-[13px] text-[var(--ink-soft)]">{state.status}</p>
        </div>
        <button type="button" onClick={onClose} className={`${styles.link} ${styles.pixel} -mr-1 px-2 text-xl leading-none`} aria-label="Close">
          ×
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {error && (
          <p role="alert" className="mb-4 bg-[rgba(183,58,49,0.08)] px-3 py-2 text-[13px] text-[var(--crimson-dark)]">
            {error}
          </p>
        )}

        <Section title={`Agents${away ? ` · ${away} out on runs` : ""}`}>
          {agents.length === 0 ? (
            <p className="text-[13px] text-[var(--ink-soft)]">{away ? "Everyone is out gathering." : "No one is posted here yet."}</p>
          ) : (
            <ul className="space-y-2">
              {agents.slice(0, 12).map((agent) => (
                <li key={agent.id} className="flex items-center gap-3">
                  <span className="shrink-0 bg-[var(--sand)]/50">
                    <Avatar baker={baker} look={agent.look} act={agent.act} size={36} />
                  </span>
                  <span className="min-w-0">
                    <span className={`${styles.pixel} block text-[13px]`}>
                      {agent.role}
                      {agent.state === "working" && <span className="ml-2 text-[11px] text-[var(--crimson)]">working</span>}
                      {agent.state === "failed" && <span className="ml-2 text-[11px] text-[var(--crimson-dark)]">needs help</span>}
                    </span>
                    <span className="block text-[12px] leading-snug text-[var(--ink-soft)]">{agent.task}</span>
                  </span>
                </li>
              ))}
              {agents.length > 12 && <li className="text-[12px] text-[var(--ink-soft)]">and {agents.length - 12} more</li>}
            </ul>
          )}
          {(back > 0 || empty > 0) && (
            <p className="mt-3 text-[12px] text-[var(--ink-soft)]">
              {back > 0 && `${back} ${back === 1 ? "scout is" : "scouts are"} back with findings`}
              {back > 0 && empty > 0 && " · "}
              {empty > 0 && `${empty} came back empty-handed`}
            </p>
          )}
        </Section>

        {id === "scouts" && <Scouts view={view} />}
        {id === "oracle" && <Oracle view={view} state={state.state} />}
        {id === "tent" && <Tent view={view} />}
        {id === "workshop" && <Workshop view={view} busy={busy} act={act} />}
        {id === "theatre" && <Theatre view={view} busy={busy} act={act} />}
        {id === "agora" && <Agora view={view} />}
      </div>

      <footer className="border-t-2 border-[rgba(43,29,20,0.12)] px-5 py-3 text-[12px] text-[var(--ink-soft)]">
        {view.brand.id === DEMO_ID ? (
          <span>Demo camp: sample data, nothing is spent.</span>
        ) : (
          <a href={`/brands/${encodeURIComponent(view.brand.id)}`} className={`${styles.link} ${styles.pixel}`}>
            Open the full workspace ↗
          </a>
        )}
      </footer>
    </aside>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mb-6">
      <h3 className={`${styles.pixel} mb-2.5 text-[12px] uppercase tracking-wider text-[var(--ink-faint)]`}>{title}</h3>
      {children}
    </section>
  );
}

function Status({ value }: { value: string }) {
  const tone =
    value === "done" || value === "passed" || value === "ready" || value === "posted"
      ? "text-[var(--olive)]"
      : value === "failed"
        ? "text-[var(--crimson-dark)]"
        : value === "running" || value === "rendering" || value === "producing" || value === "processing"
          ? "text-[var(--crimson)]"
          : "text-[var(--ink-faint)]";
  return <span className={`${styles.pixel} text-[12px] ${tone}`}>{value}</span>;
}

function Scouts({ view }: { view: BrandView }) {
  const campaign = view.campaign;
  if (!campaign) return null;
  const plan = campaign.plan;
  const pack = campaign.research;
  return (
    <>
      {plan && (
        <Section title="Battle plan">
          <dl className="space-y-1.5 text-[13px]">
            <Row label="Category">{plan.category}</Row>
            <Row label="Audience">{plan.audience}</Row>
            {plan.competitors.length > 0 && <Row label="Rivals">{plan.competitors.map((c) => c.name).join(", ")}</Row>}
            {plan.content_queries.length > 0 && <Row label="Searching">{plan.content_queries.join(", ")}</Row>}
          </dl>
        </Section>
      )}
      {pack && (
        <Section title="What came back">
          <div className="grid grid-cols-4 gap-2">
            <Count n={pack.videos.length} label="top videos" />
            <Count n={pack.ads.length} label="live ads" />
            <Count n={pack.reddit.length} label="threads" />
            <Count n={pack.seo.keywords.length} label="keywords" />
          </div>
        </Section>
      )}
      <Section title={`Sources · ${campaign.runs.filter((r) => r.status === "done").length}/${campaign.runs.length}`}>
        {campaign.runs.length === 0 ? (
          <p className="text-[13px] text-[var(--ink-soft)]">The scouts are about to set out.</p>
        ) : (
          <table className="w-full text-[12px]">
            <tbody>
              {campaign.runs.map((run) => (
                <tr key={run.key} className="border-b border-[rgba(43,29,20,0.07)] last:border-0" title={run.error ?? undefined}>
                  <td className="py-1.5 pr-2">{runLabel(run.key)}</td>
                  <td className="py-1.5 pr-2 text-[var(--ink-faint)]">{run.provider}</td>
                  <td className="py-1.5 pr-2 text-right">
                    <Status value={run.status} />
                  </td>
                  <td className="py-1.5 text-right tabular-nums text-[var(--ink-soft)]">{run.cost ? money(run.cost) : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>
    </>
  );
}

function Oracle({ view, state }: { view: BrandView; state: string }) {
  const campaign = view.campaign;
  if (!campaign) return null;
  return (
    <Section title="Format study">
      <p className="text-[13px] leading-relaxed text-[var(--ink-soft)]">
        {state === "working"
          ? "The oracle is watching the best-performing short videos in this category and writing down their structure, pacing and hooks."
          : state === "skipped"
            ? "No format study this time: there were no public short videos to learn from, or it was turned off. The strategist works from the research alone."
            : campaign.style
              ? `Learned the format from ${campaign.style.samples.length || "the top"} videos${campaign.style.slug ? `, saved as ${campaign.style.slug}${campaign.style.version ? `@${campaign.style.version}` : ""}` : ""}.`
              : "Waits for the scouts' research."}
      </p>
      {campaign.spend.style > 0 && <p className="mt-2 text-[12px] text-[var(--ink-faint)]">Cost so far {money(campaign.spend.style)}</p>}
    </Section>
  );
}

function Tent({ view }: { view: BrandView }) {
  const strategy = view.campaign?.strategy;
  if (!strategy) {
    return (
      <Section title="Battle plan">
        <p className="text-[13px] text-[var(--ink-soft)]">The strategist writes the brand brief, the search plan and every concept once the research is in.</p>
      </Section>
    );
  }
  return (
    <>
      <Section title="The brief">
        <p className={`${styles.pixel} text-[17px] leading-snug`}>{strategy.campaign.name}</p>
        <p className="mt-1.5 text-[13px] leading-relaxed text-[var(--ink-soft)]">{strategy.campaign.objective}</p>
        <dl className="mt-3 space-y-1.5 text-[13px]">
          <Row label="Brand">{strategy.brand.one_liner}</Row>
          <Row label="Tone">{strategy.brand.tone}</Row>
          {strategy.audience.length > 0 && <Row label="For">{strategy.audience.map((a) => a.name).join(", ")}</Row>}
          <Row label="Cadence">{strategy.campaign.posting_plan.cadence}</Row>
        </dl>
      </Section>
      <Section title={`Concepts · ${strategy.campaign.concepts.length}`}>
        <ol className="space-y-3">
          {strategy.campaign.concepts.map((concept, i) => (
            <li key={i} className="text-[13px]">
              <p className="font-semibold">
                {i + 1}. {concept.title} <span className="font-normal text-[var(--ink-faint)]">· {concept.angle}</span>
              </p>
              <p className="mt-0.5 leading-snug text-[var(--ink-soft)]">Hook: {concept.hook}</p>
            </li>
          ))}
        </ol>
      </Section>
    </>
  );
}

function Workshop({ view, busy, act }: { view: BrandView; busy: string | null; act: Act }) {
  const campaign = view.campaign;
  if (!campaign) return null;
  const creatives = campaign.creatives.slice().sort((a, b) => a.idx - b.idx);
  return (
    <Section title={`Videos · ${creatives.filter((c) => c.status === "ready").length}/${creatives.length || campaign.options.concepts}`}>
      {campaign.naiveOut && <p className="mb-3 bg-[rgba(201,143,58,0.12)] px-3 py-2 text-[12px]">Naive is out of credits, so new shots render on Kling through Monid.</p>}
      {creatives.length === 0 ? (
        <p className="text-[13px] text-[var(--ink-soft)]">Desks open as soon as the strategist hands over the concepts.</p>
      ) : (
        <ul className="space-y-4">
          {creatives.map((creative) => (
            <li key={creative.id} className="text-[13px]">
              <div className="flex items-baseline gap-2">
                <span className="min-w-0 flex-1 truncate font-semibold">{creative.concept?.title ?? `Video ${creative.idx + 1}`}</span>
                <Status value={creative.status} />
              </div>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {creative.shots.map((shot) => (
                  <span key={shot.n} className="bg-[rgba(43,29,20,0.06)] px-2 py-1 text-[11px]" title={shot.error ?? shot.qc?.issues[0] ?? undefined}>
                    Shot {shot.n}: {shot.status}
                    {shot.provider ? ` · ${shot.provider === "monid" ? "Kling" : "Veo"}` : ""}
                    {shot.qc ? ` · QC ${shot.qc.score}/10` : ""}
                  </span>
                ))}
              </div>
              <p className="mt-1 text-[12px] text-[var(--ink-faint)]">
                {creative.cost ? `${money(creative.cost)} so far` : "No cost yet"}
                {creative.qcScore ? ` · lowest QC ${creative.qcScore}/10` : ""}
                {creative.generation > 1 ? ` · take ${creative.generation}` : ""}
              </p>
              {creative.error && <p className="mt-1 text-[12px] text-[var(--crimson-dark)]">{creative.error}</p>}
              {(creative.status === "failed" || creative.status === "ready") && (
                <button
                  type="button"
                  className={`${styles.link} ${styles.pixel} mt-1.5 text-[12px] underline decoration-dotted underline-offset-4`}
                  disabled={busy === `regen:${creative.id}`}
                  onClick={() => act(`regen:${creative.id}`, () => regenerate(creative.id))}
                >
                  {busy === `regen:${creative.id}` ? "Sending back…" : "Send back for another take"}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function Theatre({ view, busy, act }: { view: BrandView; busy: string | null; act: Act }) {
  const campaign = view.campaign;
  if (!campaign) return null;
  const ready = campaign.creatives.filter((c) => c.status === "ready").sort((a, b) => a.idx - b.idx);
  const approved = ready.filter((c) => c.approved).length;
  const canPublish = campaign.status === "review" || campaign.status === "live";
  return (
    <>
      <Section title={`The cut · ${approved}/${ready.length} approved`}>
        {ready.length === 0 ? (
          <p className="text-[13px] text-[var(--ink-soft)]">Finished videos play here for you to approve.</p>
        ) : (
          <ul className="grid grid-cols-2 gap-3">
            {ready.map((creative) => (
              <VideoCard key={creative.id} creative={creative} busy={busy} act={act} />
            ))}
          </ul>
        )}
      </Section>
      {ready.length > 0 && (
        <Section title="Send them out">
          {!view.brand.connected && (
            <p className="mb-3 text-[12px] leading-relaxed text-[var(--ink-soft)]">
              Posting goes to the brand&apos;s own accounts, labeled AI-generated. Connect them once:{" "}
              <button
                type="button"
                className={`${styles.link} underline decoration-dotted underline-offset-4`}
                onClick={() =>
                  act("connect", async () => {
                    const url = await connectLink(view.brand.id, window.location.href);
                    window.location.assign(url);
                  })
                }
              >
                {busy === "connect" ? "Opening…" : "connect accounts"}
              </button>
              .
            </p>
          )}
          <div className="flex flex-wrap gap-3">
            <button type="button" className={`${styles.button} ${styles.pixel} h-9 bg-[var(--ink)] px-3 text-[13px]`} disabled={busy === "approve" || approved === ready.length} onClick={() => act("approve", () => campaignAction(campaign.id, "approve_all"))}>
              Approve all
            </button>
            <button type="button" className={`${styles.button} ${styles.pixel} h-9 px-3 text-[13px]`} disabled={!canPublish || approved === 0 || busy === "daily"} onClick={() => act("daily", () => campaignAction(campaign.id, "publish", "daily"))}>
              {busy === "daily" ? <span className={styles.spinner} aria-hidden="true" /> : null} One a day
            </button>
            <button type="button" className={`${styles.button} ${styles.pixel} h-9 px-3 text-[13px]`} disabled={!canPublish || approved === 0 || busy === "now"} onClick={() => act("now", () => campaignAction(campaign.id, "publish", "now"))}>
              {busy === "now" ? <span className={styles.spinner} aria-hidden="true" /> : null} Post now
            </button>
          </div>
          <p className="mt-2 text-[11px] text-[var(--ink-faint)]">&ldquo;One a day&rdquo; posts each approved video at 16:00 UTC on consecutive days.</p>
        </Section>
      )}
    </>
  );
}

function VideoCard({ creative, busy, act }: { creative: CreativeView; busy: string | null; act: Act }) {
  const key = `approve:${creative.id}`;
  return (
    <li className="text-[12px]">
      <div className="relative aspect-[9/16] overflow-hidden bg-[var(--ink)]">
        {creative.videoUrl ? (
          <video src={creative.videoUrl} poster={creative.posterUrl ?? undefined} controls playsInline preload="metadata" className="size-full object-cover" />
        ) : creative.posterUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={creative.posterUrl} alt="" className="size-full object-cover" />
        ) : null}
      </div>
      <p className="mt-1.5 line-clamp-2 font-semibold leading-snug">{creative.concept?.title ?? "Video"}</p>
      <label className="mt-1 flex cursor-pointer items-center gap-2">
        <input type="checkbox" checked={creative.approved} disabled={busy === key} onChange={(event) => act(key, () => setApproved(creative.id, event.target.checked))} className="size-4 accent-[var(--crimson)]" />
        <span className={styles.pixel}>{creative.approved ? "Approved" : "Approve"}</span>
        {creative.qcScore ? <span className="ml-auto text-[var(--ink-faint)]">QC {creative.qcScore}</span> : null}
      </label>
    </li>
  );
}

function Agora({ view }: { view: BrandView }) {
  const campaign = view.campaign;
  if (!campaign) return null;
  const posts = campaign.posts;
  return (
    <Section title={`Posts · ${posts.length}`}>
      {posts.length === 0 ? (
        <p className="text-[13px] text-[var(--ink-soft)]">Approve videos in the theatre, then send them out. The herald posts each one to the brand&apos;s own accounts.</p>
      ) : (
        <ul className="space-y-2.5">
          {posts.map((post) => {
            const title = campaign.creatives.find((c) => c.id === post.creativeId)?.concept?.title ?? "Video";
            const numbers = post.analytics ? Object.entries(post.analytics).filter(([, v]) => typeof v === "number").slice(0, 3) : [];
            return (
              <li key={post.id} className="text-[13px]">
                <div className="flex items-baseline gap-2">
                  <span className="min-w-0 flex-1 truncate font-semibold">{title}</span>
                  <Status value={post.status} />
                </div>
                <p className="text-[12px] text-[var(--ink-soft)]">
                  {post.platforms.map(platformName).join(", ")}
                  {post.scheduledAt ? ` · ${when(post.scheduledAt)}` : ""}
                </p>
                {numbers.length > 0 && <p className="text-[12px] text-[var(--ink-faint)]">{numbers.map(([k, v]) => `${k} ${v}`).join(" · ")}</p>}
                {post.error && <p className="text-[12px] text-[var(--crimson-dark)]">{post.error}</p>}
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex gap-3">
      <dt className="w-[72px] shrink-0 text-[var(--ink-faint)]">{label}</dt>
      <dd className="min-w-0 flex-1">{children}</dd>
    </div>
  );
}

function Count({ n, label }: { n: number; label: string }) {
  return (
    <div className="bg-[rgba(43,29,20,0.05)] px-2 py-2 text-center">
      <div className={`${styles.pixel} text-[20px] leading-none`}>{n}</div>
      <div className="mt-1 text-[10px] uppercase tracking-wide text-[var(--ink-soft)]">{label}</div>
    </div>
  );
}
