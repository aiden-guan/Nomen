"use client";

import { type ReactNode, type RefObject, useEffect, useRef, useState } from "react";
import type { BrandView, CreativeView } from "../api";
import type { Baker } from "../engine/baker";
import type { AgentInfo } from "../scenes/camp";
import { type AgentPlan, type CampPlan, runLabel } from "../scenes/derive";
import { LAND, landRuns, scoutLand, STATION, type StationId } from "../scenes/layout";
import styles from "../troy.module.css";
import type { Engine } from "./Camp";
import { money, platformName, when } from "./format";
import { CampMap, Chip, crispIfTiny, greekName, Icon, type IconName, Parchment, Portrait, quote, Section, Stat, Steps } from "./ui";

const STATE: Record<AgentPlan["state"], { word: string; tone: "crimson" | "faint" | "olive" | "teal" }> = {
  working: { word: "Working", tone: "crimson" },
  idle: { word: "Waiting", tone: "faint" },
  done: { word: "Done", tone: "olive" },
  failed: { word: "Needs help", tone: "crimson" },
};

/**
 * One soldier, up close: who they are, what they are doing this moment in the camp, and their piece
 * of the campaign, drawn so you can see it at a glance. The camera follows them while it is open.
 */
export function AgentCard({
  id,
  view,
  plan,
  engine,
  wide,
  following,
  onFollow,
  onStation,
  onClose,
}: {
  id: string;
  view: BrandView;
  plan: CampPlan;
  engine: RefObject<Engine | null>;
  wide: boolean;
  following: boolean;
  onFollow: () => void;
  onStation: (id: StationId) => void;
  onClose: () => void;
}) {
  // An agent the plan has let go (a scout whose run is over) keeps its card, from its last plan.
  const last = useRef<AgentPlan | null>(null);
  const agent = plan.agents.find((a) => a.id === id) ?? last.current;
  if (agent) last.current = agent;
  const [info, setInfo] = useState<AgentInfo | null>(() => engine.current?.camp.info(id) ?? null);
  useEffect(() => {
    const read = () => setInfo(engine.current?.camp.info(id) ?? null);
    read();
    const timer = setInterval(read, 250);
    return () => clearInterval(timer);
  }, [engine, id]);
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => headingRef.current?.focus(), [id]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  if (!agent) return null;

  const station = STATION[agent.station];
  // The plan says what the agent is for; the camp shows whether they are busy with it right now.
  const state = agent.state === "idle" && info?.where === "moving" ? { word: "On the move", tone: "teal" as const } : STATE[agent.state];
  const baker = engine.current?.baker ?? null;
  const name = greekName(agent.id);
  const moving = info?.where === "moving";
  const gone = info?.where === "home";

  return (
    <aside
      aria-label={`${name}, ${agent.role}`}
      className={`${styles.box} ${styles.rise} absolute z-20 flex flex-col ${wide ? "bottom-4 right-4 top-[76px] w-[420px]" : "inset-x-3 bottom-3 h-[62vh]"}`}
    >
      <header className="relative flex gap-4 border-b-2 border-[rgba(43,29,20,0.12)] px-5 pb-4 pt-4">
        <div className={`${styles.parchment} shrink-0 self-start`}>
          <Portrait baker={baker} look={agent.look} act={moving && !info?.mounted ? (agent.returning === "scroll" && !gone ? "carry" : "march") : agent.act} mounted={info?.mounted} moving={moving} carry={agent.returning === "scroll" ? 1 : 0} coat={info?.coat} size={wide ? 104 : 84} />
        </div>
        <div className="min-w-0 flex-1 pt-1">
          <p className="flex flex-wrap items-center gap-1.5 text-[11px] uppercase tracking-wider text-[var(--ink-soft)]">
            {agent.role} ·
            <button type="button" onClick={() => onStation(agent.station)} className={`${styles.link} uppercase underline decoration-dotted underline-offset-2`}>
              {station.name}
            </button>
          </p>
          <h2 ref={headingRef} tabIndex={-1} className={`${styles.pixel} mt-1 text-[26px] font-semibold leading-none outline-none`}>
            {name}
          </h2>
          <div className="mt-2">
            <Chip tone={state.tone}>{state.word}</Chip>
          </div>
          <p className="mt-3 flex items-start gap-2 text-[13px] leading-snug" aria-live="polite">
            <span className={`mt-[5px] inline-block size-[7px] shrink-0 ${gone ? "bg-[var(--ink-faint)]" : `bg-[var(--crimson)] ${styles.blink}`}`} aria-hidden="true" />
            <span>
              <span className={`${styles.pixel} text-[11px] uppercase tracking-wide text-[var(--ink-faint)]`}>Now </span>
              {info?.doing ?? "…"}
            </span>
          </p>
        </div>
        <button type="button" onClick={onClose} className={`${styles.link} ${styles.pixel} absolute right-3 top-3 px-2 text-xl leading-none`} aria-label="Close">
          ×
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        <Section title="Their part of the campaign">
          <p className="text-[13px] leading-relaxed">{mission(agent, view)}</p>
        </Section>
        <Dossier agent={agent} info={info} view={view} plan={plan} />
      </div>

      <footer className="flex items-center gap-3 border-t-2 border-[rgba(43,29,20,0.12)] px-5 py-3">
        <button type="button" onClick={onFollow} aria-pressed={following} disabled={!info?.visible} className={`${styles.button} ${following ? styles.buttonInk : styles.buttonQuiet} ${styles.pixel} h-8 px-3 text-[12px]`}>
          <Icon name="eye" size={12} /> {following ? "Following" : "Follow"}
        </button>
        <button type="button" onClick={() => onStation(agent.station)} className={`${styles.link} ${styles.pixel} text-[12px] underline decoration-dotted underline-offset-4`}>
          ← The {station.name.toLowerCase()}
        </button>
        {!info?.visible && <span className="ml-auto text-right text-[11px] leading-tight text-[var(--ink-faint)]">Inside the horse</span>}
      </footer>
    </aside>
  );
}

/** What the agent is for. For a scout, the errand itself (the camp shows how far along it is). */
function mission(agent: AgentPlan, view: BrandView) {
  if (!agent.id.startsWith("scout:")) return agent.task;
  const land = LAND[scoutLand(agent.id)];
  const runs = landRuns(view.campaign?.runs ?? [], land.id);
  const providers = [...new Set(runs.map((run) => run.provider).filter(Boolean))];
  // Searches of one kind together: “TikTok: category” (5).
  const kinds = new Map<string, number>();
  for (const run of runs) kinds.set(runLabel(run.key), (kinds.get(runLabel(run.key)) ?? 0) + 1);
  const what = runs.length ? list([...kinds].map(([label, n]) => `“${label}”${n > 1 ? ` (${n})` : ""}`)) : land.what.toLowerCase();
  return `Ride to ${land.name}, fetch ${what}${providers.length ? ` through ${list(providers)}` : ""} and bring it all back to camp in a scroll case.`;
}

/** "a", "a and b", "a, b and c". */
function list(items: string[]) {
  return items.length < 2 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

const SOURCE_ICON: Record<string, IconName> = { pending: "hourglass", running: "horse", done: "scroll", failed: "cross" };
const SOURCE_COLOR: Record<string, string> = { pending: "var(--ink-faint)", running: "var(--crimson)", done: "var(--bronze)", failed: "var(--crimson-dark)" };

/** What this agent's job looks like right now, by role. */
function Dossier({ agent, info, view, plan }: { agent: AgentPlan; info: AgentInfo | null; view: BrandView; plan: CampPlan }) {
  const campaign = view.campaign;
  if (!campaign) return null;
  const creatives = campaign.creatives.slice().sort((a, b) => a.idx - b.idx);

  if (agent.id.startsWith("scout:")) {
    const land = LAND[scoutLand(agent.id)];
    const runs = landRuns(campaign.runs, land.id);
    const cost = runs.reduce((sum, run) => sum + (run.cost ?? 0), 0);
    const errors = runs.filter((run) => run.error);
    // The trip as the camp shows it, so the steps match the rider you are following.
    const trip = info?.trip ?? "camp";
    const step = { camp: 0, out: 1, there: 2, back: 3, done: 5, empty: 4 }[trip];
    return (
      <>
        <Section title="The errand">
          <Parchment>
            <p className="flex items-center gap-2">
              <span className="inline-block size-[10px] shrink-0" style={{ background: land.color }} aria-hidden="true" />
              <span className={`${styles.pixel} text-[16px]`}>{land.name}</span>
            </p>
            <p className="mt-1 text-[12px] text-[var(--ink-soft)]">
              {land.what}
              {cost ? ` · ${money(cost)}` : ""}
            </p>
            {runs.length > 0 && (
              <ul className="mt-2.5 space-y-1 border-t border-dashed border-[rgba(43,29,20,0.18)] pt-2.5">
                {runs.map((run) => (
                  <li key={run.key} className="flex items-center gap-2 text-[12px]">
                    <Icon name={SOURCE_ICON[run.status] ?? "hourglass"} size={12} color={SOURCE_COLOR[run.status] ?? "var(--ink-faint)"} />
                    <span className="min-w-0 flex-1 truncate">{runLabel(run.key)}</span>
                    <span className="shrink-0 text-[11px] text-[var(--ink-faint)]">{run.provider}</span>
                  </li>
                ))}
              </ul>
            )}
            <div className="mt-3">
              <Steps steps={["In camp", "Riding out", `At ${land.name}`, "Riding back", trip === "empty" ? "Came back empty" : "In the basket"]} current={step} failed={trip === "empty"} />
            </div>
            {errors.map((run) => (
              <p key={run.key} className="mt-2 text-[12px] text-[var(--crimson-dark)]">
                {runLabel(run.key)}: {run.error}
              </p>
            ))}
          </Parchment>
        </Section>
        <Basket view={view} highlight={runs.map((run) => run.key)} />
      </>
    );
  }

  if (/^(hoplite|archer):/.test(agent.id)) {
    const battle = plan.battle;
    const idx = Number(agent.id.split(":")[1]);
    const company = idx === null ? null : battle.companies.find((c) => c.idx === idx) ?? null;
    const creative = company ? creatives.find((c) => c.id === company.creativeId) : null;
    const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
    return (
      <Section title={company ? `Company ${company.idx + 1}` : "The battle"} aside={battle.rival ? <span className="text-[11px] text-[var(--ink-faint)]">against {battle.rival.name}</span> : undefined}>
        {company ? (
          <Parchment>
            <div className="flex gap-3">
              {creative?.posterUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={creative.posterUrl} alt="" onLoad={crispIfTiny} className="aspect-[9/16] w-[44px] shrink-0 self-start bg-[var(--ink)] object-cover" />
              ) : (
                <span className="aspect-[9/16] w-[44px] shrink-0 self-start bg-[var(--ink)]" />
              )}
              <div className="min-w-0 flex-1">
                <p className={`${styles.pixel} text-[15px] leading-snug`}>{company.title}</p>
                <p className="mt-1 text-[12px] text-[var(--ink-soft)]">
                  {company.ratio !== null && company.views
                    ? `${pct((company.likes ?? 0) / company.views)} likes per view against ${pct(battle.benchmark!.engagement)} for the top videos: ${company.ratio >= 1 ? "ahead" : "behind"} by ${Math.abs(Math.round((company.ratio - 1) * 100))}%.`
                    : company.state === "engaged"
                      ? "Posted. The company lands in the rival's city and forms up on the quay until the numbers come in."
                      : company.state === "sent"
                        ? "Its post is going out: the company is aboard its ship, sailing for the rival's city."
                        : company.state === "failed"
                          ? "Its post failed, so the company stays on the quay at home."
                          : "Mustered on the quay below the agora beside its ship, waiting for the video to be approved and sent."}
                </p>
                {company.views !== null && (
                  <p className="mt-1.5 text-[11px] text-[var(--ink-faint)]">
                    {company.views.toLocaleString()} views · {(company.likes ?? 0).toLocaleString()} likes
                    {battle.illustrative ? " (illustrative)" : ""}
                  </p>
                )}
              </div>
            </div>
          </Parchment>
        ) : (
          <p className="text-[13px] leading-relaxed text-[var(--ink-soft)]">
            Each company sails with its archer, who looses arrows at the legion from the deck as the ship runs in, then from behind the phalanx.
            {battle.score?.ratio ? ` So far your videos are ${Math.abs(Math.round((battle.score.ratio - 1) * 100))}% ${battle.score.ratio >= 1 ? "ahead of" : "behind"} the top videos.` : ""}
          </p>
        )}
      </Section>
    );
  }

  if (agent.id === "lookout") {
    const runs = campaign.runs;
    return (
      <Section title="What the lookout sees">
        <div className="grid grid-cols-4 gap-2">
          <Stat n={runs.filter((r) => r.status === "pending").length} label="waiting" icon="hourglass" />
          <Stat n={runs.filter((r) => r.status === "running").length} label="out" icon="horse" />
          <Stat n={runs.filter((r) => r.status === "done").length} label="back" icon="scroll" />
          <Stat n={runs.filter((r) => r.status === "failed").length} label="empty" icon="cross" />
        </div>
      </Section>
    );
  }

  if (agent.id === "courier") {
    return (
      <Section title="Dispatches" aside={<span className="text-[11px] text-[var(--ink-faint)]">{info?.deliveries ?? 0} delivered</span>}>
        <div className="bg-[rgba(43,29,20,0.04)] px-2 pt-2">
          <CampMap stations={plan.stations} route={info?.errand ?? null} here={info?.errand?.to ?? null} />
        </div>
        <p className="mt-2 text-[12px] leading-snug text-[var(--ink-soft)]">
          {info?.errand ? `Carrying finished work from the ${STATION[info.errand.from].name.toLowerCase()} to the ${STATION[info.errand.to].name.toLowerCase()}.` : "Each time a station finishes its part, the courier rides it to the next one."}
        </p>
      </Section>
    );
  }

  if (agent.id === "watcher") {
    const style = campaign.style;
    return (
      <Section title="The format study">
        <Parchment>
          <p className="flex items-center gap-2">
            <Icon name="eye" size={16} color="var(--teal)" />
            <span className={`${styles.pixel} text-[15px]`}>{style ? `${style.samples.length || "Top"} videos studied` : agent.state === "working" ? "Watching now" : "Not started"}</span>
          </p>
          <p className="mt-1 text-[12px] leading-snug text-[var(--ink-soft)]">Structure, pacing and hooks of the best short videos in the category, written down for the strategist.</p>
          {style?.slug && <p className="mt-2 text-[11px] text-[var(--ink-faint)]">Saved as {style.slug}{style.version ? `@${style.version}` : ""}</p>}
        </Parchment>
      </Section>
    );
  }

  if (agent.id === "general" || agent.id === "scribe") {
    const strategy = campaign.strategy;
    if (!strategy) return <Note>The battle plan is written once the research is in.</Note>;
    return agent.id === "general" ? (
      <Section title="The battle plan">
        <Parchment>
          <p className={`${styles.pixel} text-[16px] leading-snug`}>{strategy.campaign.name}</p>
          <p className="mt-1 text-[12px] leading-relaxed text-[var(--ink-soft)]">{strategy.campaign.objective}</p>
        </Parchment>
        <div className="mt-3 grid grid-cols-3 gap-2">
          <Stat n={strategy.campaign.concepts.length} label="concepts" icon="film" />
          <Stat n={strategy.audience.length} label="audiences" icon="eye" />
          <Stat n={strategy.competitors.length} label="rivals" icon="pin" />
        </div>
      </Section>
    ) : (
      <Section title="The scribe's notes">
        <ol className="space-y-1.5">
          {strategy.campaign.concepts.map((concept, i) => (
            <li key={i} className="flex gap-2 text-[13px]">
              <span className={`${styles.pixel} w-5 shrink-0 text-[var(--ink-faint)]`}>{i + 1}.</span>
              <span className="min-w-0">
                <span className="font-semibold">{concept.title}</span>
                <span className="block text-[12px] text-[var(--ink-soft)]">{quote(concept.hook)}</span>
              </span>
            </li>
          ))}
        </ol>
      </Section>
    );
  }

  if (agent.id.startsWith("editor:")) {
    const slot = Number(agent.id.slice(7));
    const creative = creatives[slot];
    const planned = campaign.strategy?.campaign.concepts[slot];
    if (!creative) {
      return (
        <Section title={`Desk ${slot + 1}`}>
          <Parchment>
            <p className={`${styles.pixel} text-[15px]`}>{planned?.title ?? "No concept yet"}</p>
            <p className="mt-1 text-[12px] text-[var(--ink-soft)]">{planned ? quote(planned.hook) : "The war tent hands each desk a concept when the strategy is done."}</p>
          </Parchment>
        </Section>
      );
    }
    return <VideoDossier creative={creative} />;
  }

  if (agent.id === "painter") {
    const frames = creatives.flatMap((c) => c.shots.filter((s) => s.frameUrl).map((s) => ({ key: `${c.id}-${s.n}`, url: s.frameUrl!, title: `${c.concept?.title ?? "Video"}, shot ${s.n}` })));
    const toPaint = creatives.filter((c) => c.status === "producing").reduce((n, c) => n + c.shots.filter((s) => s.status === "pending").length, 0);
    return (
      <Section title="First frames" aside={<span className="text-[11px] text-[var(--ink-faint)]">{toPaint} to paint</span>}>
        <p className="mb-2 text-[12px] leading-snug text-[var(--ink-soft)]">Each shot starts from a painted first frame, so the product looks exactly right before it is filmed.</p>
        {frames.length ? (
          <div className="grid grid-cols-4 gap-1.5">
            {frames.slice(-8).map((f) => (
              // eslint-disable-next-line @next/next/no-img-element
              <img key={f.key} src={f.url} alt={f.title} title={f.title} onLoad={crispIfTiny} className="aspect-[9/16] w-full bg-[var(--ink)] object-cover" />
            ))}
          </div>
        ) : (
          <Note>No frames painted yet.</Note>
        )}
      </Section>
    );
  }

  if (agent.id === "inspector") {
    const checking = creatives.find((c) => c.shots.some((s) => s.status === "rendered"));
    const shot = checking?.shots.find((s) => s.status === "rendered");
    const verdicts = creatives.flatMap((c) => c.shots.filter((s) => s.qc).map((s) => ({ key: `${c.id}-${s.n}`, title: c.concept?.title ?? "Video", n: s.n, qc: s.qc! })));
    return (
      <>
        {checking && shot && (
          <Section title="On the bench">
            <Parchment>
              <p className={`${styles.pixel} text-[15px]`}>{checking.concept?.title ?? "Video"}</p>
              <p className="mt-1 text-[12px] text-[var(--ink-soft)]">Shot {shot.n}: checking for warped hands, wrong labels and garbled text.</p>
            </Parchment>
          </Section>
        )}
        <Section title="Verdicts">
          {verdicts.length === 0 ? (
            <Note>No shot has been checked yet.</Note>
          ) : (
            <ul className="space-y-2">
              {verdicts.slice(-6).map((v) => (
                <li key={v.key} className="text-[12px]">
                  <div className="flex items-center gap-2">
                    <Icon name={v.qc.pass ? "check" : "cross"} size={12} color={v.qc.pass ? "var(--olive)" : "var(--crimson)"} />
                    <span className="min-w-0 flex-1 truncate">
                      {v.title} · shot {v.n}
                    </span>
                    <span className={`${styles.pixel} tabular-nums`}>{v.qc.score}/10</span>
                  </div>
                  <Bar value={v.qc.score / 10} color={v.qc.pass ? "var(--olive)" : "var(--crimson)"} />
                  {!v.qc.pass && v.qc.issues[0] && <p className="mt-0.5 text-[11px] text-[var(--crimson-dark)]">{v.qc.issues[0]}</p>}
                </li>
              ))}
            </ul>
          )}
        </Section>
      </>
    );
  }

  if (agent.id.startsWith("audience:")) {
    const ready = creatives.filter((c) => c.status === "ready");
    return (
      <Section title="The cut" aside={<span className="text-[11px] text-[var(--ink-faint)]">{ready.filter((c) => c.approved).length}/{ready.length} approved</span>}>
        {ready.length ? (
          <div className="grid grid-cols-4 gap-1.5">
            {ready.map((c) => (
              <div key={c.id} className="relative">
                {c.posterUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={c.posterUrl} alt={c.concept?.title ?? "Video"} onLoad={crispIfTiny} className="aspect-[9/16] w-full bg-[var(--ink)] object-cover" />
                ) : (
                  <div className="aspect-[9/16] w-full bg-[var(--ink)]" />
                )}
                {c.approved && (
                  <span className="absolute right-1 top-1 bg-[var(--olive)] p-0.5">
                    <Icon name="check" size={10} color="var(--paper)" />
                  </span>
                )}
              </div>
            ))}
          </div>
        ) : (
          <Note>Waiting for the first finished video to play on the screen.</Note>
        )}
      </Section>
    );
  }

  if (agent.id === "herald") {
    const posts = campaign.posts;
    if (!posts.length) return <Note>Approve videos in the theatre and the herald announces each one on the brand&apos;s accounts.</Note>;
    return (
      <Section title="Announcements">
        <div className="mb-3 grid grid-cols-3 gap-2">
          <Stat n={posts.filter((p) => p.status === "posted").length} label="posted" icon="trumpet" />
          <Stat n={posts.filter((p) => p.status === "scheduled").length} label="scheduled" icon="hourglass" />
          <Stat n={posts.filter((p) => p.status === "pending" || p.status === "processing").length} label="going out" icon="play" />
        </div>
        <ul className="space-y-1.5">
          {posts.map((post) => (
            <li key={post.id} className="flex items-center gap-2 text-[12px]">
              <span className="min-w-0 flex-1 truncate">{creatives.find((c) => c.id === post.creativeId)?.concept?.title ?? "Video"}</span>
              <span className="text-[var(--ink-faint)]">{post.platforms.map(platformName).join(", ")}</span>
              <Chip tone={post.status === "posted" ? "olive" : post.status === "failed" ? "crimson" : "faint"}>{post.status === "scheduled" && post.scheduledAt ? when(post.scheduledAt) : post.status}</Chip>
            </li>
          ))}
        </ul>
      </Section>
    );
  }
  return null;
}

/** An editor's video: the production line it is on and every shot as a frame of film. */
export function VideoDossier({ creative, compact = false }: { creative: CreativeView; compact?: boolean }) {
  const shots = creative.shots;
  const all = (status: string[]) => shots.length > 0 && shots.every((s) => status.includes(s.status));
  const step = creative.status === "ready" ? 4 : creative.status === "queued" ? 0 : all(["passed"]) ? 3 : shots.some((s) => s.status === "rendered") ? 2 : all(["framed", "rendering", "rendered", "passed"]) ? 1 : 0;
  const body = (
    <>
      {!compact && (
        <Parchment className="mb-3">
          <p className={`${styles.pixel} text-[16px] leading-snug`}>{creative.concept?.title ?? `Video ${creative.idx + 1}`}</p>
          {creative.concept?.hook && <p className="mt-1 text-[12px] text-[var(--ink-soft)]">{quote(creative.concept.hook)}</p>}
          {creative.concept?.angle && (
            <div className="mt-2">
              <Chip tone="teal">{creative.concept.angle}</Chip>
            </div>
          )}
        </Parchment>
      )}
      <Steps steps={["First frames", "Filming", "Quality check", "Ready"]} current={step} failed={creative.status === "failed"} />
      <div className="mt-3 flex gap-1.5">
        {shots.map((shot) => {
          const tone = shot.status === "passed" ? "var(--olive)" : shot.status === "failed" ? "var(--crimson-dark)" : shot.status === "rendering" || shot.status === "rendered" ? "var(--crimson)" : "var(--ink-faint)";
          return (
            <figure key={shot.n} className="w-[64px] shrink-0" title={shot.error ?? shot.qc?.issues[0] ?? undefined}>
              <div className="relative bg-[var(--ink)] p-[3px]">
                {/* Sprocket holes down both edges. */}
                <div className="pointer-events-none absolute inset-y-0 left-0 w-[3px] bg-[repeating-linear-gradient(var(--paper)_0_2px,transparent_2px_5px)] opacity-60" />
                <div className="pointer-events-none absolute inset-y-0 right-0 w-[3px] bg-[repeating-linear-gradient(var(--paper)_0_2px,transparent_2px_5px)] opacity-60" />
                {shot.frameUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={shot.frameUrl} alt={`Shot ${shot.n}`} onLoad={crispIfTiny} className="aspect-[9/16] w-full object-cover" />
                ) : (
                  <ShotFace status={shot.status} />
                )}
                {shot.frameUrl && shot.status !== "passed" && <ShotBadge status={shot.status} />}
              </div>
              <figcaption className="mt-1 text-[10px] leading-tight">
                <span className="block h-[3px]" style={{ background: tone }} />
                <span className={`${styles.pixel} mt-0.5 block`}>Shot {shot.n}</span>
                <span className="block text-[var(--ink-soft)]">{shot.qc ? `QC ${shot.qc.score}/10` : shot.status}</span>
              </figcaption>
            </figure>
          );
        })}
      </div>
      <p className="mt-2 text-[11px] text-[var(--ink-faint)]">
        {creative.cost ? `${money(creative.cost)} so far` : "No cost yet"}
        {creative.generation > 1 ? ` · take ${creative.generation}` : ""}
      </p>
      {creative.error && <p className="mt-1 text-[12px] text-[var(--crimson-dark)]">{creative.error}</p>}
    </>
  );
  return compact ? body : <Section title="The video">{body}</Section>;
}

const SHOT_FACE: Record<string, { bg: string; icon: IconName; word: string }> = {
  pending: { bg: "#3a2c22", icon: "hourglass", word: "Painting" },
  framed: { bg: "#5a4636", icon: "film", word: "Framed" },
  rendering: { bg: "#20506f", icon: "film", word: "Filming" },
  rendered: { bg: "#235f7e", icon: "eye", word: "Checking" },
  passed: { bg: "#536840", icon: "check", word: "Passed" },
  failed: { bg: "#651b1d", icon: "cross", word: "Failed" },
};

/** A shot with no frame to show yet: its state, as a little title card. */
function ShotFace({ status }: { status: string }) {
  const face = SHOT_FACE[status] ?? SHOT_FACE.pending;
  return (
    <div className="grid aspect-[9/16] w-full place-items-center text-[var(--paper)]" style={{ background: face.bg }}>
      <span className="grid place-items-center gap-1">
        <span className={status === "rendering" || status === "pending" ? styles.blink : ""}>
          <Icon name={face.icon} size={16} />
        </span>
        <span className={`${styles.pixel} text-[9px] uppercase tracking-wide`}>{face.word}</span>
      </span>
    </div>
  );
}

function ShotBadge({ status }: { status: string }) {
  const face = SHOT_FACE[status] ?? SHOT_FACE.pending;
  return (
    <span className="absolute bottom-1 right-1 grid size-4 place-items-center text-[var(--paper)]" style={{ background: face.bg }} aria-hidden="true">
      <Icon name={face.icon} size={10} />
    </span>
  );
}

/** The scouts' basket: one scroll per source, filled when it is in. */
export function Basket({ view, highlight = [] }: { view: BrandView; highlight?: string[] }) {
  const runs = view.campaign?.runs ?? [];
  if (!runs.length) return null;
  const done = runs.filter((r) => r.status === "done").length;
  return (
    <Section title="The basket" aside={<span className="text-[11px] text-[var(--ink-faint)]">{done}/{runs.length} in</span>}>
      <div className="flex flex-wrap gap-1">
        {runs.map((run) => {
          const color = run.status === "done" ? "var(--bronze)" : run.status === "failed" ? "var(--crimson-dark)" : run.status === "running" ? "var(--ink-soft)" : "rgba(43,29,20,0.18)";
          return (
            <span key={run.key} title={`${runLabel(run.key)}: ${run.status}`} className={`grid size-6 place-items-center ${highlight.includes(run.key) ? "outline outline-2 outline-[var(--ink)]" : ""}`}>
              <Icon name={run.status === "failed" ? "cross" : run.status === "running" ? "horse" : "scroll"} size={14} color={color} />
            </span>
          );
        })}
      </div>
    </Section>
  );
}

function Bar({ value, color }: { value: number; color: string }) {
  return (
    <span className="mt-1 block h-[4px] bg-[rgba(43,29,20,0.08)]">
      <span className="block h-full" style={{ width: `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`, background: color }} />
    </span>
  );
}

function Note({ children }: { children: ReactNode }) {
  return <p className="text-[13px] leading-relaxed text-[var(--ink-soft)]">{children}</p>;
}
