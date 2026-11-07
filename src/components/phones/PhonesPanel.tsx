"use client";

// OWNED BY THE PHONES TRACK (see docs/handoff-dylan.md). The brand page renders <PhonesPanel /> with
// these props and nothing else, so the panel's internals can change freely.
import { useCallback, useEffect, useState } from "react";
import { Badge, Button, Card, Empty, Spinner, Stat } from "@/components/ui";
import { LinkForm } from "./LinkForm";
import { RiskNotice, SessionLine, ago, clock, phonesApi, useNow, type PhonesStatus } from "./parts";

export type PhonesPanelProps = {
  brandId: string;
  brandName: string;
  /** Topics the brand's audience follows, from the campaign strategy; empty before the first strategy. */
  niche: string[];
};

export function PhonesPanel({ brandId, brandName, niche }: PhonesPanelProps) {
  const [status, setStatus] = useState<PhonesStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [days, setDays] = useState(7);
  const now = useNow(15_000);

  const refresh = useCallback(async () => {
    try {
      const next = await phonesApi<PhonesStatus>(`?brandId=${encodeURIComponent(brandId)}`);
      setStatus(next);
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  }, [brandId]);

  const activeCount = status?.active.length ?? 0;
  useEffect(() => {
    void refresh();
    const id = setInterval(() => void refresh(), activeCount > 0 ? 5_000 : 20_000);
    return () => clearInterval(id);
  }, [refresh, activeCount]);

  useEffect(() => {
    if (status?.link) setDays(status.link.schedule.days);
  }, [status?.link?.schedule.days]); // eslint-disable-line react-hooks/exhaustive-deps

  async function act(name: string, call: () => Promise<PhonesStatus>) {
    setBusy(name);
    setActionError(null);
    try {
      setStatus(await call());
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  const header = (
    <span className="flex items-center gap-2">
      Phones
      <Badge tone="accent">Warm-up</Badge>
    </span>
  );
  const subtitle = `Warms up ${brandName}'s own new accounts on a Mobilerun cloud phone before posting starts.`;

  if (!status) {
    return (
      <Card title={header} subtitle={subtitle}>
        {loadError ? <p className="text-sm text-rose-300">{loadError}</p> : <div className="flex items-center gap-2 text-sm text-zinc-400"><Spinner /> Loading…</div>}
      </Card>
    );
  }

  if (!status.configured) {
    return (
      <Card title={header} subtitle={subtitle}>
        <div className="space-y-4">
          <Empty title="Connect Mobilerun to use phones">
            Add a Mobilerun API key (it starts with <code className="text-zinc-300">dr_sk_</code>) in{" "}
            <a href="/settings" className="text-violet-300 underline-offset-2 hover:underline">
              Settings
            </a>
            . Phones are optional: campaigns and posting work without them.
          </Empty>
          <RiskNotice />
        </div>
      </Card>
    );
  }

  const link = status.link;
  const device = status.device;
  const running = status.active.find((session) => session.status === "running" || session.status === "starting" || session.status === "queued");
  const finished = status.history.filter((session) => !status.active.some((active) => active.id === session.id));
  const succeeded = status.history.filter((session) => session.status === "succeeded").length;
  const strategyHasNewTopics = Boolean(link && niche.length && niche.some((topic) => !link.topics.map((t) => t.toLowerCase()).includes(topic.toLowerCase())));

  return (
    <Card
      title={header}
      subtitle={subtitle}
      action={
        link && !editing ? (
          <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
            Edit
          </Button>
        ) : undefined
      }
    >
      <div className="space-y-5">
        <RiskNotice />
        {loadError && <p className="text-xs text-amber-300">Couldn&apos;t refresh: {loadError}</p>}

        {!link || editing ? (
          <LinkForm
            status={status}
            niche={niche}
            onSaved={(next) => {
              setStatus(next);
              setEditing(false);
            }}
            onCancel={link ? () => setEditing(false) : undefined}
          />
        ) : (
          <>
            <div className="rounded-xl border border-white/10 bg-white/[0.02] px-4 py-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2 text-sm text-zinc-100">
                    <span className="font-medium">{device?.name ?? link.deviceId.slice(0, 8)}</span>
                    {device ? <Badge tone={device.tone}>{device.label}</Badge> : <Badge tone="bad">Unknown</Badge>}
                  </div>
                  <p className="mt-0.5 text-xs text-zinc-500">{device?.detail ?? status.deviceError ?? "Couldn't read the phone's state from Mobilerun."}</p>
                </div>
                {device?.canResume && (
                  <Button size="sm" loading={busy === "resume"} onClick={() => void act("resume", async () => {
                    await phonesApi(`/devices/${encodeURIComponent(link.deviceId)}/resume`, { method: "POST" });
                    return phonesApi<PhonesStatus>(`?brandId=${encodeURIComponent(brandId)}`);
                  })}>
                    Resume phone
                  </Button>
                )}
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                {link.accounts.map((account) => (
                  <Badge key={account.platform} tone="neutral">
                    {status.platforms.find((p) => p.id === account.platform)?.label ?? account.platform}
                    {account.credentialName ? ` · ${account.credentialName}` : " · already logged in"}
                  </Badge>
                ))}
              </div>
              <p className="mt-2 text-xs text-zinc-500">
                Browses: {link.topics.join(", ")}
                {link.vpnCountry ? ` · traffic via ${link.vpnCountry}` : ""}
              </p>
              {strategyHasNewTopics && (
                <p className="mt-2 text-xs text-sky-300">
                  The latest strategy has new topics.{" "}
                  <button className="underline underline-offset-2" onClick={() => setEditing(true)}>
                    Review them
                  </button>
                </p>
              )}
            </div>

            <div className="grid gap-3 sm:grid-cols-3">
              <Stat label="Session length" value={`${status.session.minutes} min`} hint={`≈${status.session.estimatedCredits} Mobilerun credits max`} />
              <Stat
                label="Schedule"
                value={
                  link.schedule.state === "running"
                    ? `Day ${link.schedule.day} of ${link.schedule.days}`
                    : link.schedule.state === "finished"
                      ? "Finished"
                      : "Off"
                }
                hint={link.schedule.nextAt ? `Next: ${clock(link.schedule.nextAt)}` : link.schedule.state === "finished" ? `Ended ${ago(link.schedule.endsAt, now)}` : "Daily, one session per account"}
              />
              <Stat label="Completed" value={succeeded} hint={`of the last ${status.history.length} sessions`} />
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <Button
                variant="primary"
                loading={busy === "run"}
                disabled={status.active.length >= link.accounts.length}
                onClick={() => void act("run", () => phonesApi<PhonesStatus>("/sessions", { method: "POST", body: { brandId } }))}
              >
                Run warm-up now
              </Button>
              <div className="flex items-center gap-2 rounded-xl border border-white/10 bg-white/[0.02] px-3 py-1.5 text-sm text-zinc-300">
                <span>Daily for</span>
                <input
                  type="number"
                  min={1}
                  max={30}
                  value={days}
                  onChange={(event) => setDays(Number(event.target.value))}
                  className="h-7 w-14 rounded-md border border-white/10 bg-white/[0.04] px-2 text-center text-sm text-zinc-100 focus:outline-none focus:ring-2 focus:ring-violet-500/40"
                />
                <span>days</span>
                {link.schedule.enabled ? (
                  <>
                    {days !== link.schedule.days && (
                      <Button size="sm" loading={busy === "schedule"} onClick={() => void act("schedule", () => phonesApi<PhonesStatus>("/schedule", { method: "PUT", body: { brandId, enabled: true, days } }))}>
                        Update
                      </Button>
                    )}
                    <Button size="sm" variant="ghost" loading={busy === "schedule-off"} onClick={() => void act("schedule-off", () => phonesApi<PhonesStatus>("/schedule", { method: "PUT", body: { brandId, enabled: false, days } }))}>
                      Turn off
                    </Button>
                  </>
                ) : (
                  <Button size="sm" loading={busy === "schedule"} onClick={() => void act("schedule", () => phonesApi<PhonesStatus>("/schedule", { method: "PUT", body: { brandId, enabled: true, days } }))}>
                    Start schedule
                  </Button>
                )}
              </div>
            </div>
            {actionError && <p className="text-sm text-rose-300">{actionError}</p>}

            {status.active.length > 0 && (
              <div>
                <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-400">Now</h3>
                <ul className="divide-y divide-white/5">
                  {status.active.map((session) => (
                    <SessionLine
                      key={session.id}
                      session={session}
                      now={now}
                      action={
                        <Button size="sm" variant="danger" loading={busy === `stop-${session.id}`} onClick={() => void act(`stop-${session.id}`, () => phonesApi<PhonesStatus>(`/sessions/${session.id}/cancel`, { method: "POST" }))}>
                          Stop
                        </Button>
                      }
                    />
                  ))}
                </ul>
                {running && <p className="mt-1 text-[11px] text-zinc-500">Updates every few seconds. Sessions on the same phone run one at a time.</p>}
              </div>
            )}

            <div>
              <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-400">History</h3>
              {finished.length === 0 ? (
                <p className="mt-2 text-sm text-zinc-500">No sessions yet. Run one now, or start the daily schedule.</p>
              ) : (
                <ul className="divide-y divide-white/5">
                  {finished.map((session) => (
                    <SessionLine key={session.id} session={session} now={now} />
                  ))}
                </ul>
              )}
            </div>

            <div className="flex justify-end">
              <Button
                size="sm"
                variant="ghost"
                loading={busy === "unlink"}
                onClick={() => {
                  if (window.confirm(`Unlink ${brandName}'s phone and accounts? Running sessions stop. The phone itself is kept in Mobilerun.`)) {
                    void act("unlink", () => phonesApi<PhonesStatus>(`/link?brandId=${encodeURIComponent(brandId)}`, { method: "DELETE" }));
                  }
                }}
              >
                Unlink phone
              </Button>
            </div>
          </>
        )}
      </div>
    </Card>
  );
}
