"use client";

import { type ReactNode, useEffect, useRef } from "react";
import type { BrandView, CreativeView } from "../api";
import type { Baker } from "../engine/baker";
import { type AgentPlan, type CampPlan, runLabel, stationForEvent } from "../scenes/derive";
import { STATION, type StationId } from "../scenes/layout";
import styles from "../troy.module.css";
import { Basket, VideoDossier } from "./AgentCard";
import { type CampActions } from "./Camp";
import { ago, money, platformName, when } from "./format";
import { CampMap, Chip, crispIfTiny, Emblem, greekName, Icon, type IconName, Parchment, Portrait, quote, Section, Stat, STATE_COLOR, STATE_WORD, Steps } from "./ui";

/** What each station does, in a sentence, for someone seeing the camp for the first time. */
const ABOUT: Record<StationId, string> = {
  scouts: "Scouts ride out to the brand's website, its rivals, TikTok, Reels, Shorts, ad libraries and Reddit, and bring back what they find.",
  oracle: "The oracle watches the best short videos in the category and writes down why they work: structure, pacing, hooks.",
  tent: "The strategist turns the research into a brief and one concept per video: a hook, an angle and every shot.",
  workshop: "Each editor makes one video: first frames are painted, shots are filmed, and an inspector checks every frame.",
  theatre: "Finished videos play here. Approve the ones you want, then send them out.",
  agora: "The herald posts each approved video to the brand's own accounts, now or one a day.",
};

export function StationPanel({
  id,
  view,
  plan,
  baker,
  wide,
  busy,
  error,
  actions,
  demo,
  onAgent,
  onStation,
  onClose,
}: {
  id: StationId;
  view: BrandView;
  plan: CampPlan;
  baker: Baker | null;
  wide: boolean;
  busy: string | null;
  error: string | null;
  actions: CampActions;
  /** Set in the demo camp: whether it replays a recorded campaign or the made-up sample. */
  demo: { recorded: boolean } | null;
  onAgent: (id: string) => void;
  onStation: (id: StationId) => void;
  onClose: () => void;
}) {
  const station = STATION[id];
  const state = plan.stations[id];
  const here = plan.agents.filter((a) => a.station === id);
  // Scouts who already brought their findings back have gone home: count them instead of listing.
  const agents = here.filter((a) => !a.returning);
  const away = here.filter((a) => a.away).length;
  const back = here.filter((a) => a.returning === "scroll").length;
  const empty = here.filter((a) => a.returning === "empty").length;
  const latest = view.events.filter((e) => stationForEvent(e.message, view.campaign?.stage ?? "research") === id).slice(0, 4);
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
      className={`${styles.box} ${styles.rise} absolute z-20 flex flex-col ${wide ? "bottom-4 right-4 top-[76px] w-[420px]" : "inset-x-3 bottom-3 h-[62vh]"}`}
    >
      <header className="relative border-b-2 border-[rgba(43,29,20,0.12)] px-5 pb-3 pt-4">
        <div className="flex items-start gap-3">
          <div className={`${styles.parchment} grid size-[64px] shrink-0 place-items-center`}>
            <Emblem baker={baker} id={id} size={56} />
          </div>
          <div className="min-w-0 flex-1 pr-6">
            <p className="flex items-center gap-2 text-[11px] uppercase tracking-wider text-[var(--ink-soft)]">
              {station.role} · <span style={{ color: STATE_COLOR[state.state] }}>{STATE_WORD[state.state]}</span>
            </p>
            <h2 ref={headingRef} tabIndex={-1} className={`${styles.pixel} mt-1 text-[24px] font-semibold leading-none outline-none`}>
              {station.name}
            </h2>
            <p className="mt-2 text-[13px] leading-snug">{state.status}</p>
          </div>
        </div>
        {state.progress !== null && <Progress value={state.progress} color={STATE_COLOR[state.state]} />}
        <button type="button" onClick={onClose} className={`${styles.link} ${styles.pixel} absolute right-3 top-3 px-2 text-xl leading-none`} aria-label="Close">
          ×
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {error && (
          <p role="alert" className="mb-4 bg-[rgba(183,58,49,0.08)] px-3 py-2 text-[13px] text-[var(--crimson-dark)]">
            {error}
          </p>
        )}

        <div className="mb-5">
          <p className="mb-2 text-[12px] leading-relaxed text-[var(--ink-soft)]">{ABOUT[id]}</p>
          <div className="bg-[rgba(43,29,20,0.04)] px-2 pt-2">
            <CampMap stations={plan.stations} here={id} onPick={onStation} />
          </div>
        </div>

        <Section
          title="Agents"
          aside={
            <span className="text-[11px] text-[var(--ink-faint)]">
              {[away && `${away} out on runs`, back && `${back} back with findings`, empty && `${empty} came back empty`].filter(Boolean).join(" · ") || "Click one to follow them"}
            </span>
          }
        >
          {agents.length === 0 ? (
            <p className="text-[13px] text-[var(--ink-soft)]">{away ? "Everyone is out gathering." : "No one is posted here yet."}</p>
          ) : (
            <ul className="grid grid-cols-3 gap-2">
              {agents.slice(0, 12).map((agent) => (
                <AgentTile key={agent.id} agent={agent} baker={baker} onClick={() => onAgent(agent.id)} />
              ))}
            </ul>
          )}
          {agents.length > 12 && <p className="mt-2 text-[12px] text-[var(--ink-soft)]">and {agents.length - 12} more</p>}
        </Section>

        {id === "scouts" && <Scouts view={view} />}
        {id === "oracle" && <Oracle view={view} state={state.state} />}
        {id === "tent" && <Tent view={view} />}
        {id === "workshop" && <Workshop view={view} busy={busy} actions={actions} />}
        {id === "theatre" && <Theatre view={view} busy={busy} actions={actions} />}
        {id === "agora" && <Agora view={view} />}

        {latest.length > 0 && (
          <Section title="Latest here">
            <ol className="space-y-1.5 border-l-2 border-[rgba(43,29,20,0.12)] pl-3">
              {latest.map((event, i) => (
                <li key={`${event.ts}-${i}`} className="relative text-[12px] leading-snug">
                  <span className="absolute -left-[17px] top-[5px] size-[6px]" style={{ background: event.level === "error" ? "var(--crimson)" : event.level === "warn" ? "var(--bronze)" : "var(--teal)" }} aria-hidden="true" />
                  <span>{event.message}</span>
                  <time dateTime={event.ts} className="ml-2 text-[11px] text-[var(--ink-faint)]">
                    {ago(event.ts)}
                  </time>
                </li>
              ))}
            </ol>
          </Section>
        )}
      </div>

      <footer className="border-t-2 border-[rgba(43,29,20,0.12)] px-5 py-3 text-[12px] text-[var(--ink-soft)]">
        {demo ? (
          <span>{demo.recorded ? "A recorded campaign, replayed: nothing is spent." : "Demo camp: made-up data, nothing is spent."}</span>
        ) : (
          <a href={`/brands/${encodeURIComponent(view.brand.id)}`} className={`${styles.link} ${styles.pixel}`}>
            Open the full workspace ↗
          </a>
        )}
      </footer>
    </aside>
  );
}

function AgentTile({ agent, baker, onClick }: { agent: AgentPlan; baker: Baker | null; onClick: () => void }) {
  const tone = agent.state === "working" ? "var(--crimson)" : agent.state === "done" ? "var(--olive)" : agent.state === "failed" ? "var(--crimson-dark)" : "var(--ink-faint)";
  return (
    <li>
      <button type="button" onClick={onClick} className={`${styles.boxSoft} group block w-full px-1 pb-2 pt-1 text-center transition-transform hover:-translate-y-0.5`} aria-label={`${greekName(agent.id)}, ${agent.role}: ${agent.task}`}>
        <span className="block bg-[rgba(234,214,173,0.35)]">
          <Portrait baker={baker} look={agent.look} act={agent.away ? "march" : agent.act} size={72} />
        </span>
        <span className={`${styles.pixel} mt-1 block truncate text-[12px]`}>{greekName(agent.id)}</span>
        <span className="flex items-center justify-center gap-1 text-[10px] text-[var(--ink-soft)]">
          <span className={`inline-block size-[6px] ${agent.state === "working" ? styles.blink : ""}`} style={{ background: tone }} aria-hidden="true" />
          {agent.away ? "Out on a run" : agent.role}
        </span>
      </button>
    </li>
  );
}

function Progress({ value, color }: { value: number; color: string }) {
  const segments = 16;
  const filled = Math.round(Math.max(0, Math.min(1, value)) * segments);
  return (
    <div className="mt-3 flex gap-[3px]" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(value * 100)}>
      {Array.from({ length: segments }, (_, i) => (
        <span key={i} className="h-[6px] flex-1" style={{ background: i < filled ? color : "rgba(43,29,20,0.1)" }} />
      ))}
    </div>
  );
}

const RUN_ICON: Record<string, IconName> = { pending: "hourglass", running: "horse", done: "scroll", failed: "cross" };
const RUN_WORD: Record<string, string> = { pending: "Waiting", running: "Out riding", done: "Back", failed: "Empty-handed" };

function Scouts({ view }: { view: BrandView }) {
  const campaign = view.campaign;
  if (!campaign) return null;
  const plan = campaign.plan;
  const pack = campaign.research;
  return (
    <>
      {pack && (
        <Section title="What came back">
          <div className="grid grid-cols-4 gap-2">
            <Stat n={pack.videos.length} label="top videos" icon="film" />
            <Stat n={pack.ads.length} label="live ads" icon="eye" />
            <Stat n={pack.reddit.length} label="threads" icon="scroll" />
            <Stat n={pack.seo.keywords.length} label="keywords" icon="pin" />
          </div>
        </Section>
      )}
      <Basket view={view} />
      <Section title={`Sources · ${campaign.runs.filter((r) => r.status === "done").length}/${campaign.runs.length}`}>
        {campaign.runs.length === 0 ? (
          <p className="text-[13px] text-[var(--ink-soft)]">The scouts are about to set out.</p>
        ) : (
          <ul className="grid grid-cols-2 gap-1.5">
            {campaign.runs.map((run) => (
              <li key={run.key} className="flex items-center gap-2 bg-[rgba(43,29,20,0.04)] px-2 py-1.5" title={run.error ?? `${run.provider}${run.cost ? ` · ${money(run.cost)}` : ""}`}>
                <Icon name={RUN_ICON[run.status] ?? "hourglass"} size={14} color={run.status === "done" ? "var(--bronze)" : run.status === "failed" ? "var(--crimson-dark)" : run.status === "running" ? "var(--crimson)" : "var(--ink-faint)"} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12px] leading-tight">{runLabel(run.key)}</span>
                  <span className={`block text-[10px] leading-tight ${run.status === "running" ? "text-[var(--crimson)]" : "text-[var(--ink-faint)]"}`}>{RUN_WORD[run.status] ?? run.status}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>
      {plan && (
        <Section title="Their orders">
          <Parchment>
            <dl className="space-y-1.5 text-[12px]">
              <Row label="Category">{plan.category}</Row>
              <Row label="Audience">{plan.audience}</Row>
              {plan.competitors.length > 0 && <Row label="Rivals">{plan.competitors.map((c) => c.name).join(", ")}</Row>}
              {plan.content_queries.length > 0 && <Row label="Searching">{plan.content_queries.join(", ")}</Row>}
            </dl>
          </Parchment>
        </Section>
      )}
    </>
  );
}

function Oracle({ view, state }: { view: BrandView; state: string }) {
  const campaign = view.campaign;
  if (!campaign) return null;
  const style = campaign.style;
  const steps = ["Gather the top videos", "Watch them frame by frame", "Write the format down"];
  const current = state === "done" ? 3 : state === "working" ? 1 : 0;
  return (
    <Section title="Format study">
      {state === "skipped" ? (
        <p className="text-[13px] leading-relaxed text-[var(--ink-soft)]">No format study this time: there were no public short videos to learn from, or it was turned off. The strategist works from the research alone.</p>
      ) : (
        <>
          <Steps steps={steps} current={current} failed={state === "failed"} />
          <Parchment className="mt-3">
            <p className="flex items-center gap-2">
              <Icon name="eye" size={16} color="var(--teal)" />
              <span className={`${styles.pixel} text-[15px]`}>{style ? `Learned from ${style.samples.length || "the top"} videos` : state === "working" ? "Watching now" : "Waits for the scouts"}</span>
            </p>
            {style?.slug && <p className="mt-1 text-[11px] text-[var(--ink-faint)]">Saved as {style.slug}{style.version ? `@${style.version}` : ""}</p>}
            {campaign.spend.style > 0 && <p className="mt-1 text-[11px] text-[var(--ink-faint)]">Cost {money(campaign.spend.style)}</p>}
          </Parchment>
        </>
      )}
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
        <Parchment>
          <p className={`${styles.pixel} text-[17px] leading-snug`}>{strategy.campaign.name}</p>
          <p className="mt-1.5 text-[12px] leading-relaxed text-[var(--ink-soft)]">{strategy.campaign.objective}</p>
          <dl className="mt-3 space-y-1.5 text-[12px]">
            <Row label="Brand">{strategy.brand.one_liner}</Row>
            <Row label="Tone">{strategy.brand.tone}</Row>
            {strategy.audience.length > 0 && <Row label="For">{strategy.audience.map((a) => a.name).join(", ")}</Row>}
            <Row label="Cadence">{strategy.campaign.posting_plan.cadence}</Row>
          </dl>
        </Parchment>
      </Section>
      <Section title={`Concepts · ${strategy.campaign.concepts.length}`}>
        <ol className="space-y-2">
          {strategy.campaign.concepts.map((concept, i) => (
            <li key={i} className="flex gap-3 bg-[rgba(43,29,20,0.04)] px-3 py-2.5">
              <span className={`${styles.pixel} grid size-7 shrink-0 place-items-center bg-[var(--ink)] text-[13px] text-[var(--paper)]`}>{i + 1}</span>
              <span className="min-w-0 text-[13px]">
                <span className="block font-semibold leading-snug">{concept.title}</span>
                <span className="mt-0.5 block text-[12px] leading-snug text-[var(--ink-soft)]">{quote(concept.hook)}</span>
                {concept.angle && (
                  <span className="mt-1.5 inline-block">
                    <Chip tone="teal">{concept.angle}</Chip>
                  </span>
                )}
              </span>
            </li>
          ))}
        </ol>
      </Section>
    </>
  );
}

function Workshop({ view, busy, actions }: { view: BrandView; busy: string | null; actions: CampActions }) {
  const campaign = view.campaign;
  if (!campaign) return null;
  const creatives = campaign.creatives.slice().sort((a, b) => a.idx - b.idx);
  return (
    <Section title={`Videos · ${creatives.filter((c) => c.status === "ready").length}/${creatives.length || campaign.options.concepts}`}>
      {campaign.naiveOut && <p className="mb-3 bg-[rgba(201,143,58,0.12)] px-3 py-2 text-[12px]">Naive is out of credits, so new shots render on Kling through Monid.</p>}
      {creatives.length === 0 ? (
        <p className="text-[13px] text-[var(--ink-soft)]">The desks are set up; each editor starts when the strategist hands over the concepts.</p>
      ) : (
        <ul className="space-y-4">
          {creatives.map((creative) => (
            <li key={creative.id} className="bg-[rgba(43,29,20,0.04)] px-3 py-3 text-[13px]">
              <div className="mb-2 flex items-baseline gap-2">
                <span className="min-w-0 flex-1 truncate font-semibold">{creative.concept?.title ?? `Video ${creative.idx + 1}`}</span>
                <Chip tone={creative.status === "ready" ? "olive" : creative.status === "failed" ? "crimson" : creative.status === "producing" ? "crimson" : "faint"}>{creative.status}</Chip>
              </div>
              <VideoDossier creative={creative} compact />
              {(creative.status === "failed" || creative.status === "ready") && (
                <button
                  type="button"
                  className={`${styles.link} ${styles.pixel} mt-1.5 text-[12px] underline decoration-dotted underline-offset-4`}
                  disabled={busy === `regen:${creative.id}`}
                  onClick={() => actions.regenerate(creative)}
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

function Theatre({ view, busy, actions }: { view: BrandView; busy: string | null; actions: CampActions }) {
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
              <VideoCard key={creative.id} creative={creative} busy={busy} actions={actions} />
            ))}
          </ul>
        )}
      </Section>
      {ready.length > 0 && (
        <Section title="Send them out">
          {!view.brand.connected && (
            <p className="mb-3 text-[12px] leading-relaxed text-[var(--ink-soft)]">
              Posting goes to the brand&apos;s own accounts, labeled AI-generated. Connect them once:{" "}
              <button type="button" className={`${styles.link} underline decoration-dotted underline-offset-4`} onClick={actions.connect}>
                {busy === "connect" ? "Opening…" : "connect accounts"}
              </button>
              .
            </p>
          )}
          <div className="flex flex-wrap gap-3">
            <button type="button" className={`${styles.button} ${styles.buttonInk} ${styles.pixel} h-9 px-3 text-[13px]`} disabled={busy === "approve" || approved === ready.length} onClick={actions.approveAll}>
              Approve all
            </button>
            <button type="button" className={`${styles.button} ${styles.pixel} h-9 px-3 text-[13px]`} disabled={!canPublish || approved === 0 || busy === "daily"} onClick={() => actions.publish("daily")}>
              {busy === "daily" ? <span className={styles.spinner} aria-hidden="true" /> : null} One a day
            </button>
            <button type="button" className={`${styles.button} ${styles.pixel} h-9 px-3 text-[13px]`} disabled={!canPublish || approved === 0 || busy === "now"} onClick={() => actions.publish("now")}>
              {busy === "now" ? <span className={styles.spinner} aria-hidden="true" /> : null} Post now
            </button>
          </div>
          <p className="mt-2 text-[11px] text-[var(--ink-faint)]">&ldquo;One a day&rdquo; posts each approved video at 16:00 UTC on consecutive days.</p>
        </Section>
      )}
    </>
  );
}

function VideoCard({ creative, busy, actions }: { creative: CreativeView; busy: string | null; actions: CampActions }) {
  const key = `approve:${creative.id}`;
  const title = creative.concept?.title ?? "Video";
  return (
    <li className="text-[12px]">
      <button type="button" onClick={() => actions.screen(creative)} className="group relative block aspect-[9/16] w-full overflow-hidden bg-[var(--ink)]" aria-label={`Watch “${title}”`}>
        {creative.posterUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={creative.posterUrl} alt="" onLoad={crispIfTiny} className="size-full object-cover transition-transform duration-300 group-hover:scale-[1.03]" />
        ) : creative.videoUrl ? (
          <video src={`${creative.videoUrl}#t=0.5`} muted playsInline preload="metadata" className="size-full object-cover" />
        ) : null}
        <span aria-hidden="true" className="absolute inset-0 grid place-items-center bg-[rgba(43,29,20,0.12)] opacity-90 transition-opacity group-hover:opacity-100">
          <span className="grid size-10 place-items-center bg-[var(--paper)] text-[var(--ink)] shadow-[0_3px_0_rgba(43,29,20,0.3)]">
            <Icon name="play" size={16} />
          </span>
        </span>
        {creative.approved && (
          <span className="absolute right-1.5 top-1.5 bg-[var(--olive)] p-1" aria-hidden="true">
            <Icon name="check" size={12} color="var(--paper)" />
          </span>
        )}
      </button>
      <p className="mt-1.5 line-clamp-2 font-semibold leading-snug">{title}</p>
      <label className="mt-1 flex cursor-pointer items-center gap-2">
        <input type="checkbox" checked={creative.approved} disabled={busy === key} onChange={(event) => actions.approve(creative, event.target.checked)} className="size-4 accent-[var(--crimson)]" />
        <span className={styles.pixel}>{creative.approved ? "Approved" : "Approve"}</span>
        {creative.qcScore ? <span className="ml-auto text-[var(--ink-faint)]">QC {creative.qcScore}</span> : null}
      </label>
    </li>
  );
}

export { crispIfTiny };

function Agora({ view }: { view: BrandView }) {
  const campaign = view.campaign;
  if (!campaign) return null;
  const posts = campaign.posts;
  return (
    <Section title={`Posts · ${posts.length}`}>
      {posts.length === 0 ? (
        <p className="text-[13px] text-[var(--ink-soft)]">Approve videos in the theatre, then send them out. The herald posts each one to the brand&apos;s own accounts.</p>
      ) : (
        <ul className="space-y-3">
          {posts.map((post) => {
            const creative = campaign.creatives.find((c) => c.id === post.creativeId);
            const title = creative?.concept?.title ?? "Video";
            const numbers = post.analytics ? Object.entries(post.analytics).filter(([, v]) => typeof v === "number").slice(0, 3) : [];
            const step = post.status === "posted" || post.status === "scheduled" ? 3 : post.status === "processing" ? 2 : post.status === "failed" ? 2 : 1;
            return (
              <li key={post.id} className="flex gap-3 bg-[rgba(43,29,20,0.04)] p-2.5 text-[13px]">
                {creative?.posterUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={creative.posterUrl} alt="" onLoad={crispIfTiny} className="aspect-[9/16] w-[38px] shrink-0 self-start bg-[var(--ink)] object-cover" />
                ) : (
                  <span className="aspect-[9/16] w-[38px] shrink-0 self-start bg-[var(--ink)]" />
                )}
                <div className="min-w-0 flex-1">
                  <p className="truncate font-semibold">{title}</p>
                  <p className="mb-2 mt-0.5 flex flex-wrap gap-1">
                    {post.platforms.map((p) => (
                      <Chip key={p} tone="ink">
                        {platformName(p)}
                      </Chip>
                    ))}
                  </p>
                  <Steps steps={["Queued", "Sent", post.status === "scheduled" ? `On ${when(post.scheduledAt)}` : "Posted"]} current={step} failed={post.status === "failed"} />
                  {numbers.length > 0 && <p className="mt-1.5 text-[12px] text-[var(--ink-soft)]">{numbers.map(([k, v]) => `${k} ${(v as number).toLocaleString()}`).join(" · ")}</p>}
                  {post.error && <p className="mt-1 text-[12px] text-[var(--crimson-dark)]">{post.error}</p>}
                </div>
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
      <dt className="w-[68px] shrink-0 text-[var(--ink-faint)]">{label}</dt>
      <dd className="min-w-0 flex-1">{children}</dd>
    </div>
  );
}
