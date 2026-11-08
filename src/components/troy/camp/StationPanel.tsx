"use client";

import { type ReactNode, type RefObject, type SyntheticEvent, useEffect, useRef, useState } from "react";
import { type BrandView, type CreativeView, type PostView, type SocialAccountView, socialAccounts } from "../api";
import type { Baker } from "../engine/baker";
import type { BattlePlan } from "../scenes/battle";
import { type AgentPlan, type CampPlan, runLabel, stationForEvent } from "../scenes/derive";
import { LAND, landFor, STATION, type StationId } from "../scenes/layout";
import styles from "../troy.module.css";
import { Basket, VideoDossier } from "./AgentCard";
import { EventLog, Reason } from "./EventLog";
import { type CampActions, Pip } from "./Camp";
import { money, platformName, remakeLine, when } from "./format";
import { InternalBadge, ReferenceList, RoleBadge } from "./References";
import { CampMap, Chip, crispIfTiny, Emblem, greekName, Icon, type IconName, Parchment, Portrait, quote, Section, Stat, STATE_COLOR, STATE_WORD, Steps } from "./ui";

/** What a brief's video is judged on once posted, as the War tent says it. */
const METRIC_WORDS: Record<string, string> = { views: "views", shares: "shares", saves: "saves", link_clicks: "link clicks", sign_ups: "sign-ups", purchases: "purchases" };

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
  focus,
  glide = null,
  spot = null,
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
  /** The demo tour's pointer: "concepts" scrolls the war tent to its concepts once they are in. */
  focus?: string | null;
  /** The tour's autoplay: seconds it stays here, scrolling itself to what this station did and on down. */
  glide?: number | null;
  /** The tour opened this panel (a new number each time): it spotlights the section the step is about. */
  spot?: number | null;
  onAgent: (id: string) => void;
  onStation: (id: StationId) => void;
  onClose: () => void;
}) {
  const station = STATION[id];
  const state = plan.stations[id];
  const here = plan.agents.filter((a) => a.station === id);
  // Scouts who already brought their findings back have gone home: count them instead of listing.
  // The agora's army is shown a company at a time: its first hoplite, and the first company's archer.
  const army = here.filter((a) => /^(hoplite|archer):/.test(a.id));
  const agents = here.filter((a) => !a.returning && (!/^(hoplite|archer):/.test(a.id) || a.id.endsWith(":0")));
  const away = here.filter((a) => a.away).length;
  const back = here.filter((a) => a.returning === "scroll").length;
  const empty = here.filter((a) => a.returning === "empty").length;
  const latest = view.events.filter((e) => stationForEvent(e.message, view.campaign?.stage ?? "research") === id).slice(0, 4);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const detail = useRef<HTMLDivElement>(null);
  useGlide(scroller, detail, glide, id);
  useSpotlight(scroller, detail, spot, focus ?? null, Boolean(glide));
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

      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
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

        {id === "agora" && <Battle battle={plan.battle} category={view.campaign?.plan?.category ?? null} />}

        <Section
          title="Agents"
          aside={
            <span className="text-[11px] text-[var(--ink-faint)]">
              {[away && `${away} out on runs`, back && `${back} back with findings`, empty && `${empty} came back empty`, army.length && `an army of ${army.length}, one of each company shown`].filter(Boolean).join(" · ") || "Click one to follow them"}
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

        <div ref={detail} className="scroll-mt-3" />
        {id === "scouts" && <Scouts view={view} actions={actions} />}
        {id === "oracle" && <Oracle view={view} state={state.state} actions={actions} />}
        {id === "tent" && <Tent view={view} focus={focus ?? null} />}
        {id === "workshop" && <Workshop view={view} busy={busy} actions={actions} />}
        {id === "theatre" && <Theatre view={view} busy={busy} actions={actions} demo={Boolean(demo)} focus={focus ?? null} />}
        {id === "agora" && <Agora view={view} actions={actions} />}

        {latest.length > 0 && (
          <Section title="Latest here">
            <EventLog events={latest} />
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

/** A nudge to bring the brand kit while it can still shape this campaign's product study. */
function KitNudge({ actions, children }: { actions: CampActions; children: ReactNode }) {
  if (!actions.openKit) return null;
  return (
    <p className="mb-6 bg-[rgba(201,143,58,0.12)] px-3 py-2 text-[12px] leading-snug">
      {children}{" "}
      <button type="button" className={`${styles.link} ${styles.pixel} underline decoration-dotted underline-offset-4`} onClick={actions.openKit}>
        Open the brand kit
      </button>
    </p>
  );
}

function Scouts({ view, actions }: { view: BrandView; actions: CampActions }) {
  const campaign = view.campaign;
  if (!campaign) return null;
  const plan = campaign.plan;
  const pack = campaign.research;
  return (
    <>
      {campaign.stage === "research" && campaign.status === "running" && (
        <KitNudge actions={actions}>While the scouts are out: give the agents your real logo, product screens and code, so the videos show the actual product.</KitNudge>
      )}
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
            {campaign.runs.map((run) => {
              // The land on the map this source is fetched from, in its colour.
              const land = LAND[landFor(run.key)];
              return (
                <li
                  key={run.key}
                  className="flex items-center gap-2 bg-[rgba(43,29,20,0.04)] py-1.5 pl-2.5 pr-2"
                  style={{ boxShadow: `inset 3px 0 0 ${land.color}` }}
                  title={run.error ?? `${land.name}: ${land.what}, through ${run.provider}${run.cost ? ` · ${money(run.cost)}` : ""}`}
                >
                  <Icon name={RUN_ICON[run.status] ?? "hourglass"} size={14} color={run.status === "done" ? "var(--bronze)" : run.status === "failed" ? "var(--crimson-dark)" : run.status === "running" ? "var(--crimson)" : "var(--ink-faint)"} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[12px] leading-tight">{runLabel(run.key)}</span>
                    <span className={`block truncate text-[10px] leading-tight ${run.status === "running" ? "text-[var(--crimson)]" : "text-[var(--ink-faint)]"}`}>
                      {land.name} · {RUN_WORD[run.status] ?? run.status}
                    </span>
                  </span>
                </li>
              );
            })}
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

function Oracle({ view, state, actions }: { view: BrandView; state: string; actions: CampActions }) {
  const campaign = view.campaign;
  if (!campaign) return null;
  const study = campaign.study ?? null;
  const references = campaign.references ?? [];
  // The creative engine's reference study; campaigns from before it (and the demo) had a format study.
  if (study || references.length) {
    const ready = campaign.creatives.filter((c) => c.status === "ready");
    const onScreen = (creativeId: string) => {
      const creative = ready.find((c) => c.id === creativeId);
      if (creative) actions.screen(creative);
    };
    const studied = references.filter((r) => r.status === "studied").length;
    return (
      <>
        {study && (
          <Section title="The study">
            <dl className="space-y-1.5 text-[13px]">
              <Row label="Product">{study.product ? `${study.product.name}: ${study.product.oneLiner}` : "Reading the site…"}</Row>
              {study.product && (
                <Row label="On screen">
                  {study.product.visuals} visuals{study.product.fromKit ? `, ${study.product.fromKit} from your brand kit` : ""}
                  {!study.captured && " · screenshotting the site…"}
                </Row>
              )}
              {study.screened > 0 && <Row label="Screened">{`${study.kept} of ${study.screened} top videos could be remade for this product`}</Row>}
              {(study.picked > 0 || study.studied > 0) && <Row label="Broken down">{study.done ? `${study.studied} of ${Math.max(study.picked, study.studied)}${study.failed ? ` (${study.failed} couldn't be read)` : ""}` : `${study.studied} of ${Math.max(study.picked, study.studied)}, beat by beat…`}</Row>}
            </dl>
            {campaign.spend.style > 0 && <p className="mt-2 text-[12px] text-[var(--ink-faint)]">Cost so far {money(campaign.spend.style)}</p>}
          </Section>
        )}
        {study && !study.product?.fromKit && state === "working" && <KitNudge actions={actions}>The oracle works best with your real screens and logo.</KitNudge>}
        <Section title={`Viral references${studied ? ` · ${studied} broken down` : ""}`}>
          {references.length === 0 ? (
            <p className="text-[13px] text-[var(--ink-soft)]">The oracle ranks the videos the scouts found by how far they outran their accounts, then breaks the best down beat by beat. They show up here as soon as they&apos;re picked.</p>
          ) : (
            <ReferenceList references={references} onScreen={onScreen} />
          )}
        </Section>
      </>
    );
  }
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

/**
 * The demo tour's pointer: once `ready`, scrolls the panel's own box (never the page, as
 * scrollIntoView would) so the returned mark is at its top.
 */
/**
 * The tour points at what a station did: the section its step is about (the one after the focus
 * mark, or the station's own first section) is brought into view and outlined for a moment.
 */
function useSpotlight(scroller: RefObject<HTMLDivElement | null>, detail: RefObject<HTMLDivElement | null>, spot: number | null, focus: string | null, gliding: boolean) {
  useEffect(() => {
    const box = scroller.current;
    if (spot === null || !box) return;
    let lit: Element | null = null;
    const nextSection = (from: Element | null) => {
      for (let el = from?.nextElementSibling ?? null; el; el = el.nextElementSibling) if (el.tagName === "SECTION") return el;
      return null;
    };
    // After the panel has opened (and, gliding, scrolled down to it).
    const show = setTimeout(
      () => {
        const target = focus ? nextSection(box.querySelector(`[data-mark="${focus}"]`)) : nextSection(detail.current);
        if (!target) return;
        if (!gliding && !focus) box.scrollTo({ top: box.scrollTop + target.getBoundingClientRect().top - box.getBoundingClientRect().top - 8, behavior: "smooth" });
        target.classList.add(styles.spotlight);
        lit = target;
      },
      gliding ? 2000 : 650,
    );
    const hide = setTimeout(() => lit?.classList.remove(styles.spotlight), (gliding ? 2000 : 650) + 2800);
    return () => {
      clearTimeout(show);
      clearTimeout(hide);
      lit?.classList.remove(styles.spotlight);
    };
  }, [scroller, detail, spot, focus, gliding]);
}

/**
 * The tour's autoplay scrolls the panel itself: a moment on the top, then down to what the station
 * did (`detail`), then slowly on to the bottom before the step ends. Scrolling by hand stops it.
 */
function useGlide(scroller: RefObject<HTMLDivElement | null>, detail: RefObject<HTMLDivElement | null>, seconds: number | null, id: StationId) {
  useEffect(() => {
    const box = scroller.current;
    if (!seconds || !box) return;
    const start = performance.now();
    const from = box.scrollTop;
    const ease = (x: number) => (x < 0.5 ? 2 * x * x : 1 - (-2 * x + 2) ** 2 / 2);
    let frame = 0;
    let stopped = false;
    const stop = () => {
      stopped = true;
    };
    box.addEventListener("wheel", stop, { passive: true });
    box.addEventListener("touchstart", stop, { passive: true });
    const tick = () => {
      if (stopped) return;
      const t = (performance.now() - start) / 1000;
      const max = Math.max(0, box.scrollHeight - box.clientHeight);
      const mark = detail.current ? Math.min(max, box.scrollTop + detail.current.getBoundingClientRect().top - box.getBoundingClientRect().top - 8) : 0;
      // 0.9 s on the top, 1 s down to the detail, a stay there while it is spotlit, then on to
      // the bottom by 90% of the step.
      const settle = 1.9;
      const end = Math.max(settle + 0.5, seconds * 0.9);
      const stay = Math.min(settle + 2.4, end - 0.8);
      const target =
        t < 0.9 ? from : t < settle ? from + (mark - from) * ease((t - 0.9) / 1) : t < stay ? mark : mark + (max - mark) * Math.min(1, (t - stay) / Math.max(0.1, end - stay));
      box.scrollTop = target;
      if (t < end) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      box.removeEventListener("wheel", stop);
      box.removeEventListener("touchstart", stop);
    };
  }, [scroller, detail, seconds, id]);
}

function useScrollMark(on: boolean, ready: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const mark = ref.current;
    if (!on || !ready || !mark) return;
    let box = mark.parentElement;
    while (box && !(box.scrollHeight > box.clientHeight && /(auto|scroll)/.test(getComputedStyle(box).overflowY))) box = box.parentElement;
    if (box) box.scrollTo({ top: box.scrollTop + mark.getBoundingClientRect().top - box.getBoundingClientRect().top - 8, behavior: "smooth" });
  }, [on, ready]);
  return ref;
}

function Tent({ view, focus }: { view: BrandView; focus: string | null }) {
  const strategy = view.campaign?.strategy;
  const conceptsRef = useScrollMark(focus === "concepts", Boolean(strategy));
  const engine = Boolean(view.campaign?.study || view.campaign?.references?.length);
  if (!strategy) {
    return (
      <Section title="Battle plan">
        <p className="text-[13px] text-[var(--ink-soft)]">
          {engine
            ? "The creative director reads the oracle's breakdowns and picks which viral video each of ours remakes, and how. Then the script room writes every video line by line, and a critic scores each script."
            : "The strategist writes the brand brief, the search plan and every concept once the research is in."}
        </p>
      </Section>
    );
  }
  const briefs = strategy.campaign.briefs ?? [];
  const references = view.campaign?.references ?? [];
  if (briefs.length) {
    const concepts = strategy.campaign.concepts ?? [];
    return (
      <>
        <Section title="The brief">
          <p className={`${styles.pixel} text-[17px] leading-snug`}>{strategy.campaign.name}</p>
          <p className="mt-1.5 text-[13px] leading-relaxed text-[var(--ink-soft)]">{strategy.campaign.objective}</p>
          <dl className="mt-3 space-y-1.5 text-[13px]">
            <Row label="Brand">{strategy.brand.one_liner}</Row>
            {strategy.audience.length > 0 && <Row label="For">{strategy.audience.map((a) => a.name).join(", ")}</Row>}
          </dl>
        </Section>
        <div ref={conceptsRef} data-mark="concepts" className="scroll-mt-3" />
        <Section title={`Videos · ${concepts.length} of ${briefs.length} scripted`}>
          <ol className="space-y-2">
            {briefs.map((brief, i) => {
              const reference = references.find((r) => r.id && r.id === brief.reference_id);
              const concept = concepts.find((c) => c.brief?.title === brief.title);
              const review = concept?.script?.review;
              return (
                <li key={`${brief.title}-${i}`} className="flex gap-2.5 bg-[rgba(43,29,20,0.035)] px-3 py-2.5 text-[13px]">
                  <span className={`${styles.pixel} grid size-6 shrink-0 place-items-center bg-[var(--ink)] text-[12px] text-[var(--paper)]`}>{i + 1}</span>
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold leading-snug">{brief.title}</p>
                    <p className="mt-1 flex flex-wrap items-center gap-1.5 text-[11.5px] text-[var(--ink-soft)]">
                      <span className={`${styles.pixel} bg-[rgba(43,29,20,0.07)] px-1.5 text-[11px] leading-[16px]`}>{brief.format.replace(/_/g, " ")}</span>
                      {brief.role && <RoleBadge role={brief.role} />}
                      {brief.metric && <span>judged on {METRIC_WORDS[brief.metric] ?? brief.metric.replace(/_/g, " ")}</span>}
                    </p>
                    {reference && <p className="mt-1 text-[12px] text-[var(--crimson)]">{remakeLine(reference)}</p>}
                    <Reason text={brief.hook_plan || brief.angle} />
                    <p className="mt-1 text-[11.5px] text-[var(--ink-faint)]">
                      {concept?.script
                        ? concept.script.beats.length
                          ? `Script ${Math.round(concept.script.total_seconds)} s, ${concept.script.beats.length} beats${review ? ` · critic ${review.score}/10` : ""}`
                          : `${Math.round(concept.script.total_seconds)} s video`
                        : "The script room is writing it…"}
                    </p>
                  </div>
                </li>
              );
            })}
          </ol>
        </Section>
      </>
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
      <div ref={conceptsRef} data-mark="concepts" className="scroll-mt-3" />
      <Section title={`Concepts · ${strategy.campaign.concepts.length}`}>
        <ol className="space-y-2">
          {strategy.campaign.concepts.map((concept, i) => (
            <li key={i} className="flex gap-3 bg-[rgba(43,29,20,0.04)] px-3 py-2.5">
              <span className={`${styles.pixel} grid size-7 shrink-0 place-items-center bg-[var(--ink)] text-[13px] text-[var(--paper)]`}>{i + 1}</span>
              <span className="min-w-0 text-[13px]">
                <span className="block font-semibold leading-snug">{concept.title}</span>
                <span className="mt-0.5 block text-[12px] leading-snug text-[var(--ink-soft)]">{quote(concept.hook)}</span>
                {concept.format && <span className="mt-1 block text-[11px] uppercase tracking-wide text-[var(--ink-faint)]">{concept.format}</span>}
                {/* What the research found that made the director pick this video. */}
                {concept.why && (
                  <span className="mt-1 block text-[12px] leading-snug">
                    <span className={`${styles.pixel} text-[var(--crimson)]`}>Why </span>
                    {concept.why}
                  </span>
                )}
                {concept.angle && concept.angle !== concept.why && (
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
                {creative.internal && <InternalBadge cleared={creative.cleared} />}
                {creative.role && <RoleBadge role={creative.role} />}
                <Chip tone={creative.status === "ready" ? "olive" : creative.status === "failed" ? "crimson" : creative.status === "producing" ? "crimson" : "faint"}>{creative.status}</Chip>
              </div>
              {creative.reference && (
                <p className="mt-0.5 truncate text-[12px] text-[var(--crimson)]">
                  <a href={creative.reference.url} target="_blank" rel="noreferrer" className={styles.link}>
                    {remakeLine(creative.reference)}
                  </a>
                </p>
              )}
              {(creative.concept?.format || creative.script) && (
                <p className="mb-1 mt-0.5 text-[12px] text-[var(--ink-faint)]">
                  {[creative.concept?.format?.replace(/_/g, " "), creative.script ? `${Math.round(creative.script.seconds)} s script` : null, creative.script?.critic ? `critic ${creative.script.critic}/10` : null].filter(Boolean).join(" · ")}
                </p>
              )}
              <VideoDossier creative={creative} compact />
              {creative.error && <p className="mt-1 text-[12px] text-[var(--crimson-dark)]">{creative.error}</p>}
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

function Theatre({ view, busy, actions, demo, focus }: { view: BrandView; busy: string | null; actions: CampActions; demo: boolean; focus: string | null }) {
  const accounts = useAccounts(demo ? null : view.brand.id, view.brand.connected);
  const campaign = view.campaign;
  const finished = (campaign?.creatives ?? []).filter((c) => c.status === "ready").sort((a, b) => a.idx - b.idx);
  // Real-creator mode: a brief cast to a creator, waiting for your OK to send its outreach. A brief
  // can have its video, its creator, or both (an AI campaign whose briefs were also cast).
  const briefs = finished.filter((c) => castingOf(c));
  const ready = finished.filter((c) => c.videoUrl || !castingOf(c));
  const creatorsRef = useScrollMark(focus === "creators", briefs.length > 0);
  if (!campaign) return null;
  const approved = ready.filter((c) => c.approved).length;
  // Approved videos with no post yet (a failed post can go again). A real campaign can post a
  // finished video while the others are still being made; the demo's replay posts from the review.
  const sent = new Set(campaign.posts.filter((p) => p.status !== "failed").map((p) => p.creativeId));
  const unposted = ready.filter((c) => c.approved && !sent.has(c.id)).length;
  const canPublish = unposted > 0 && (!demo || campaign.status === "review" || campaign.status === "live");
  return (
    <>
      {(ready.length > 0 || briefs.length === 0) && (
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
      )}
      {ready.length > 0 && (
        <Section title="Send them out">
          {demo ? null : <Accounts state={accounts} busy={busy} connect={actions.connect} />}
          <div className="flex flex-wrap gap-3">
            <button type="button" className={`${styles.button} ${styles.buttonInk} ${styles.pixel} h-9 px-3 text-[13px]`} disabled={busy === "approve" || approved === ready.length} onClick={actions.approveAll}>
              Approve all
            </button>
            <button type="button" className={`${styles.button} ${styles.pixel} h-9 px-3 text-[13px]`} disabled={!canPublish || busy === "daily"} onClick={() => actions.publish("daily")}>
              {busy === "daily" ? <span className={styles.spinner} aria-hidden="true" /> : null} One a day
            </button>
            <button type="button" className={`${styles.button} ${styles.pixel} h-9 px-3 text-[13px]`} disabled={!canPublish || busy === "now"} onClick={() => actions.publish("now")}>
              {busy === "now" ? <span className={styles.spinner} aria-hidden="true" /> : null} Post now
            </button>
          </div>
          <p className="mt-2 text-[11px] text-[var(--ink-faint)]">&ldquo;One a day&rdquo; posts each approved video at 16:00 UTC on consecutive days.</p>
        </Section>
      )}
      <div ref={creatorsRef} data-mark="creators" className="scroll-mt-3" />
      {briefs.length > 0 && (
        <Section title={`Creator briefs · ${briefs.filter((c) => c.approved).length}/${briefs.length} approved to send`}>
          <ul className="grid grid-cols-1 gap-3">
            {briefs.map((creative) => (
              <CastingCard key={creative.id} creative={creative} casting={castingOf(creative)!} busy={busy} actions={actions} brandId={demo ? null : view.brand.id} />
            ))}
          </ul>
          <p className="mt-2 text-[11px] text-[var(--ink-faint)]">The client-taste agent approved each creator and brief. Nothing goes out until you send it.</p>
        </Section>
      )}
    </>
  );
}

type AccountsState = { accounts: SocialAccountView[] | null; error: string | null };

/** The brand's connected accounts, read live from Naive when the theatre opens (none before it is activated). */
function useAccounts(brandId: string | null, activated: boolean): AccountsState {
  const [state, setState] = useState<AccountsState>({ accounts: null, error: null });
  useEffect(() => {
    if (!brandId) return;
    if (!activated) {
      setState({ accounts: [], error: null });
      return;
    }
    let alive = true;
    socialAccounts(brandId).then(
      (result) => alive && setState(result),
      (error: unknown) => alive && setState({ accounts: null, error: error instanceof Error ? error.message : String(error) }),
    );
    return () => {
      alive = false;
    };
  }, [brandId, activated]);
  return state;
}

/** Where posts go, or the way to connect the brand's accounts. */
function Accounts({ state, busy, connect }: { state: AccountsState; busy: string | null; connect: () => void }) {
  const link = (label: string) => (
    <button type="button" className={`${styles.link} underline decoration-dotted underline-offset-4`} onClick={connect}>
      {busy === "connect" ? "Opening…" : label}
    </button>
  );
  const { accounts, error } = state;
  return (
    <p className="mb-3 text-[12px] leading-relaxed text-[var(--ink-soft)]">
      {error ? (
        <>Couldn&apos;t read the brand&apos;s accounts ({error}). {link("Connect accounts")}</>
      ) : accounts === null ? (
        "Checking the brand's accounts…"
      ) : accounts.length === 0 ? (
        <>Posting goes to the brand&apos;s own accounts, labeled AI-generated. Connect them once: {link("connect accounts")}.</>
      ) : (
        <>
          Posting to {accounts.map((a) => `${platformName(a.platform)} ${a.name}`).join(", ")}, labeled AI-generated. {link("Add accounts")}
        </>
      )}
    </p>
  );
}

/** What real-creator mode keeps on a brief (creative/casting.ts), as the camp shows it. */
type CastingView = {
  status: string;
  pick: { handle: string; platform: string; followers: number | null; url: string; evidence: string } | null;
  briefing: { title: string; hook: string; summary: string; fee: string } | null;
  reviews: Array<{ creator: string; approve: boolean; score: number; reasons: string[] }>;
  outreach: { channel: string; message: string } | null;
};

function castingOf(creative: CreativeView): CastingView | null {
  const casting = (creative.concept as unknown as { casting?: CastingView } | null)?.casting;
  return casting?.pick ? casting : null;
}

const followersLabel = (n: number | null) => (n === null ? "" : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M followers` : n >= 1e3 ? `${Math.round(n / 1e3)}K followers` : `${n} followers`);

function CastingCard({ creative, casting, busy, actions, brandId }: { creative: CreativeView; casting: CastingView; busy: string | null; actions: CampActions; brandId: string | null }) {
  const key = `approve:${creative.id}`;
  const pick = casting.pick!;
  const verdict = casting.reviews.filter((r) => r.creator === pick.handle).at(-1);
  const turnedDown = casting.reviews.filter((r) => r.creator !== pick.handle).map((r) => `@${r.creator}`);
  return (
    <li className="border-2 border-[var(--ink)] bg-[var(--paper)] p-3 text-[12px]">
      <p className="font-semibold leading-snug">{casting.briefing?.title ?? creative.concept?.title}</p>
      <p className="mt-1 text-[11px] text-[var(--ink-soft)]">
        Creator:{" "}
        <a href={pick.url} target="_blank" rel="noreferrer" className="font-semibold underline">
          @{pick.handle}
        </a>{" "}
        · {pick.platform === "instagram" ? "Instagram" : "TikTok"}
        {pick.followers !== null ? ` · ${followersLabel(pick.followers)}` : ""}
      </p>
      {pick.evidence && <p className="mt-0.5 line-clamp-2 text-[11px] leading-snug text-[var(--ink-faint)]">Made: {pick.evidence}</p>}
      {creative.reference && <p className="mt-0.5 line-clamp-2 text-[11px] leading-snug text-[var(--crimson)]">{remakeLine(creative.reference)}</p>}
      {casting.briefing && <p className="mt-2 italic leading-snug">&ldquo;{casting.briefing.hook}&rdquo;</p>}
      {verdict && (
        <p className="mt-2 text-[11px] leading-snug">
          <span className="font-semibold text-[var(--crimson)]">
            Client taste {verdict.approve ? "approved" : "turned down"} · {verdict.score}/10
          </span>{" "}
          {verdict.reasons[0] ?? ""}
          {turnedDown.length ? ` (turned down before: ${turnedDown.join(", ")})` : ""}
        </p>
      )}
      {casting.outreach && (
        <details className="mt-2">
          <summary className={`${styles.pixel} cursor-pointer text-[11px]`}>Outreach draft{casting.briefing?.fee ? ` · ${casting.briefing.fee}` : ""}</summary>
          <p className="mt-1 whitespace-pre-wrap text-[11px] leading-snug">{casting.outreach.message}</p>
          <button type="button" className={`${styles.button} ${styles.pixel} mt-1 h-7 px-2 text-[11px]`} onClick={() => void navigator.clipboard?.writeText(casting.outreach!.message)}>
            Copy
          </button>
        </details>
      )}
      <label className="mt-2 flex cursor-pointer items-center gap-2">
        <input type="checkbox" checked={creative.approved} disabled={busy === key} onChange={(event) => actions.approve(creative, event.target.checked)} className="size-4 accent-[var(--crimson)]" />
        <span className={styles.pixel}>{creative.approved ? "Approved to send" : "Approve to send"}</span>
      </label>
      {brandId && casting.outreach && creative.approved && <SendFromPhone brandId={brandId} creativeId={creative.id} handle={casting.pick!.handle} />}
    </li>
  );
}

type OutreachSession = { status: string; message: string | null; error: string | null; finishedAt: string | null } | null;
const OUTREACH_WORD: Record<string, string> = {
  pending: "Waiting for the phone",
  waiting: "Waiting for the phone",
  starting: "Opening the app",
  queued: "Queued on the phone",
  running: "Sending from the phone",
  succeeded: "Sent",
  failed: "Not sent",
  cancelled: "Stopped",
};

/**
 * Sends the approved outreach DM from the brand's own account on its phone (phones track,
 * /api/phones/outreach), and follows it until it is sent or stops.
 */
function SendFromPhone({ brandId, creativeId, handle }: { brandId: string; creativeId: string; handle: string }) {
  const [state, setState] = useState<{ session: OutreachSession; linked: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const url = `/api/phones/outreach?brandId=${encodeURIComponent(brandId)}&creativeId=${encodeURIComponent(creativeId)}`;
  const status = state?.session?.status ?? null;
  const active = status !== null && !["succeeded", "failed", "cancelled"].includes(status);
  useEffect(() => {
    let alive = true;
    const load = () =>
      fetch(url, { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : null))
        .then((data) => alive && data && setState(data))
        .catch(() => undefined);
    void load();
    // While it is on its way, check every few seconds.
    const timer = active ? setInterval(load, 4000) : null;
    return () => {
      alive = false;
      if (timer) clearInterval(timer);
    };
  }, [url, active]);
  const send = async () => {
    setSending(true);
    setError(null);
    try {
      const response = await fetch("/api/phones/outreach", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ brandId, creativeId }) });
      const data = await response.json().catch(() => null);
      if (!response.ok) throw new Error(data?.error ?? `The server answered ${response.status}.`);
      setState((s) => ({ linked: s?.linked ?? true, session: data.session }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  };
  if (state && !state.linked) return <p className="mt-1 text-[11px] text-[var(--ink-faint)]">Link the brand&apos;s phone (Phones) to send this DM from its own account.</p>;
  const sent = status === "succeeded";
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      {!sent && !active && (
        <button type="button" onClick={() => void send()} disabled={sending || !state} className={`${styles.button} ${styles.buttonInk} ${styles.pixel} h-7 px-2.5 text-[11px]`}>
          {sending ? "Sending…" : status === "failed" || status === "cancelled" ? `Try again: DM @${handle}` : `Send from the phone: DM @${handle}`}
        </button>
      )}
      {status && (
        <span className={`${styles.pixel} text-[11px] ${sent ? "text-[var(--olive)]" : status === "failed" ? "text-[var(--crimson)]" : "text-[var(--ink-soft)]"}`} title={state?.session?.message ?? undefined}>
          {sent ? `Sent to @${handle} from the phone` : OUTREACH_WORD[status] ?? status}
          {status === "failed" && state?.session?.message ? `: ${state.session.message}` : ""}
        </span>
      )}
      {error && <span className="text-[11px] text-[var(--crimson)]">{error}</span>}
    </div>
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
      <p className="mt-1.5 flex items-start gap-1.5 font-semibold leading-snug">
        <span className="line-clamp-2 min-w-0 flex-1">{title}</span>
        {creative.internal && <InternalBadge cleared={creative.cleared} />}
      </p>
      {creative.reference && <p className="mt-0.5 line-clamp-2 text-[11px] leading-snug text-[var(--crimson)]">{remakeLine(creative.reference)}</p>}
      <label className="mt-1 flex cursor-pointer items-center gap-2">
        <input type="checkbox" checked={creative.approved} disabled={busy === key} onChange={(event) => actions.approve(creative, event.target.checked)} className="size-4 accent-[var(--crimson)]" />
        <span className={styles.pixel}>{creative.approved ? "Approved" : "Approve"}</span>
        {creative.script?.critic || creative.qcScore ? (
          <span className="ml-auto text-[var(--ink-faint)]">{[creative.script?.critic ? `script ${creative.script.critic}` : null, creative.qcScore ? `QC ${creative.qcScore}` : null].filter(Boolean).join(" · ")}</span>
        ) : null}
      </label>
    </li>
  );
}

export { crispIfTiny };

/**
 * The expedition, in numbers: each video's company and how its posts do against the category's top
 * videos, which is how each attack on the rival's city ends.
 */
function Battle({ battle, category }: { battle: BattlePlan; category: string | null }) {
  if (battle.phase === "none") return null;
  const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
  const rival = battle.rival?.name ?? "the rival";
  const lean = battle.score?.ratio ? Math.max(0.06, Math.min(0.94, 0.5 + Math.log2(battle.score.ratio) * 0.45)) : 0.5;
  return (
    <Section title="The battle" aside={battle.rival ? <span className="text-[11px] text-[var(--ink-faint)]">against {rival}{battle.rival.ads ? `, ${battle.rival.ads} live ads` : ""}</span> : undefined}>
      <p className="text-[12px] leading-relaxed text-[var(--ink-soft)]">
        A company for each video sails from the quay below the agora to the city of {rival} and lands once its video is posted. It routs the legion facing it if the video beats the top videos
        {category ? ` in ${category}` : ""} the scouts found by likes per view, holds its ground if level, and falls back to the quay if behind.
      </p>
      <div className="mt-3 bg-[rgba(43,29,20,0.04)] p-2.5">
        <p className="flex items-center justify-between text-[11px]">
          <span className={`${styles.pixel} text-[var(--olive)]`}>Your videos {battle.score ? pct(battle.score.engagement) : "–"}</span>
          <span className={`${styles.pixel} text-[var(--crimson)]`}>Top videos {battle.benchmark ? pct(battle.benchmark.engagement) : "–"}</span>
        </p>
        <p className="relative mt-1.5 h-[8px] bg-[var(--crimson)]" aria-hidden="true">
          <span className="absolute inset-y-0 left-0 bg-[var(--olive)]" style={{ width: `${lean * 100}%` }} />
          <span className="absolute inset-y-[-3px] left-1/2 w-[2px] bg-[var(--ink)]" />
        </p>
        <p className="mt-1.5 text-[11px] text-[var(--ink-faint)]">
          {battle.benchmark ? `Median of ${battle.benchmark.videos} top videos.` : "Too few of the top videos had numbers to compare against."}
          {battle.score ? ` Yours: ${battle.score.likes.toLocaleString()} likes on ${battle.score.views.toLocaleString()} views.` : " Yours show here once posts have numbers."}
          {battle.illustrative ? " Yours are illustrative: this replay's videos weren't posted." : ""}
        </p>
      </div>
      <ul className="mt-3 space-y-1.5">
        {battle.companies.map((company) => {
          const ahead = company.ratio !== null && company.ratio >= 1;
          return (
            <li key={company.creativeId} className="flex items-center gap-2 text-[12px]">
              <span className={`${styles.pixel} bg-[var(--ink)] px-1 text-[11px] leading-[15px] text-[var(--paper)]`}>{company.idx + 1}</span>
              <span className="min-w-0 flex-1 truncate">{company.title}</span>
              <span className={`${styles.pixel} shrink-0 text-[11px]`} style={{ color: company.ratio === null ? "var(--ink-faint)" : ahead ? "var(--olive)" : "var(--crimson)" }}>
                {company.ratio !== null
                  ? `${ahead ? "▲" : "▼"} ${Math.abs(Math.round((company.ratio - 1) * 100))}%${company.views ? ` · ${pct((company.likes ?? 0) / company.views)}` : ""}`
                  : { formed: "mustered", approved: "cleared to sail", sent: "under sail", engaged: "landed", failed: "post failed" }[company.state]}
              </span>
            </li>
          );
        })}
      </ul>
    </Section>
  );
}

function Agora({ view, actions }: { view: BrandView; actions: CampActions }) {
  const campaign = view.campaign;
  if (!campaign) return null;
  const posts = campaign.posts;
  return (
    <>
      {actions.openAutopilot && (
        <p className="mb-6 bg-[rgba(45,123,152,0.1)] px-3 py-2 text-[12px] leading-snug">
          Once these posts are out, autopilot can send the next campaign by itself, every few days and within a weekly budget you set.{" "}
          <button type="button" className={`${styles.link} ${styles.pixel} underline decoration-dotted underline-offset-4`} onClick={actions.openAutopilot}>
            Open autopilot
          </button>
        </p>
      )}
      <Section title={`Posts · ${posts.length}`}>
        {posts.length === 0 ? (
          <p className="text-[13px] text-[var(--ink-soft)]">Approve videos in the theatre, then send them out. The herald posts each one to the brand&apos;s own accounts.</p>
        ) : (
          <ul className="space-y-3">
            {posts.map((post) => {
              const creative = campaign.creatives.find((c) => c.id === post.creativeId);
              const title = creative?.concept?.title ?? "Video";
              const numbers = postNumbers(post);
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
                    {numbers.length > 0 && <p className="mt-1.5 text-[12px] text-[var(--ink-soft)]">{numbers.map(([k, v]) => `${COMPACT.format(v)} ${k}`).join(" · ")}</p>}
                    {post.url && (
                      <a href={post.url} target="_blank" rel="noreferrer" className={`${styles.link} mt-1 inline-block text-[12px] underline decoration-dotted underline-offset-4`}>
                        See the post
                      </a>
                    )}
                    {post.error && <p className={`mt-1 text-[12px] ${post.status === "failed" ? "text-[var(--crimson-dark)]" : "text-[var(--ink-faint)]"}`}>{post.error}</p>}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Section>
    </>
  );
}

const COMPACT = new Intl.NumberFormat("en", { notation: "compact" });

/** A post's numbers: the stats read from the network's analytics, or (the demo) its flat analytics. */
function postNumbers(post: PostView): Array<[string, number]> {
  const stats: Record<string, unknown> = post.stats && Object.keys(post.stats).length ? post.stats : (post.analytics ?? {});
  return Object.entries(stats)
    .filter((entry): entry is [string, number] => typeof entry[1] === "number")
    .slice(0, 4);
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex gap-3">
      <dt className="w-[68px] shrink-0 text-[var(--ink-faint)]">{label}</dt>
      <dd className="min-w-0 flex-1">{children}</dd>
    </div>
  );
}
