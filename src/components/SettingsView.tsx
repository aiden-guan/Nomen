"use client";

import { type ReactNode, useEffect, useState } from "react";
import { Badge, Button, Card } from "./ui";

type Secret = { set: boolean; source: "env" | "settings" | "none"; hint: string };
type Settings = { values: Record<string, string>; secrets: Record<string, Secret>; videoModels: string[] };

const KEYS = [
  { key: "naive_api_key", label: "Naive", help: "Strategy, video rendering, quality checks and posting. Create a key in the Naive Studio (app.usenaive.ai)." },
  { key: "monid_api_key", label: "Monid", help: "Research data and the backup video renderer. Create a key at app.monid.ai/access/api-keys." },
  { key: "mobilerun_api_key", label: "Mobilerun", help: "Cloud phones for warming up the brand's own accounts. Optional." },
];

const VEO_PER_SECOND = 0.4;

export function SettingsView() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);

  async function load() {
    const data: Settings = await (await fetch("/api/settings", { cache: "no-store" })).json();
    setSettings(data);
    setValues(data.values);
  }
  useEffect(() => {
    void load();
  }, []);

  async function save(payload: Record<string, string>, label: string) {
    setSaving(true);
    setSaved(null);
    await fetch("/api/settings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
    setKeys({});
    await load();
    setSaving(false);
    setSaved(label);
  }

  if (!settings) return <div className="h-64 animate-pulse rounded-2xl bg-white/[0.03]" />;
  const set = (key: string) => (value: string) => setValues((current) => ({ ...current, [key]: value }));
  const seconds = Number(values.videos_per_campaign) * Number(values.shots_per_video) * Number(values.video_seconds);
  const estimate = values.video_model === "google/veo-3.1" ? `about $${(seconds * VEO_PER_SECOND).toFixed(2)} of Veo 3.1 per campaign (${seconds} s at $0.40/s, measured)` : `${seconds} s of video per campaign`;

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="mt-1 text-sm text-zinc-400">Keys are stored in this app&apos;s local database or read from the environment, and never sent back to the browser.</p>
      </div>

      <Card title="Connections">
        <div className="space-y-5">
          {KEYS.map(({ key, label, help }) => {
            const secret = settings.secrets[key];
            return (
              <div key={key}>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium text-zinc-100">{label}</span>
                  {secret.set ? (
                    <Badge tone="good">{secret.source === "env" ? `from the environment (${secret.hint})` : `saved (${secret.hint})`}</Badge>
                  ) : (
                    <Badge tone="warn">not set</Badge>
                  )}
                </div>
                <p className="mt-1 text-xs text-zinc-500">{help}</p>
                {secret.source !== "env" && (
                  <div className="mt-2 flex gap-2">
                    <input
                      type="password"
                      autoComplete="off"
                      value={keys[key] ?? ""}
                      onChange={(event) => setKeys((current) => ({ ...current, [key]: event.target.value }))}
                      placeholder={secret.set ? "Paste a new key to replace it" : "Paste the API key"}
                      className="h-10 flex-1 rounded-xl border border-white/10 bg-black/20 px-3 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-violet-400/50 focus:outline-none"
                    />
                    <Button disabled={!keys[key]} loading={saving} onClick={() => void save({ [key]: keys[key] }, label)}>
                      Save
                    </Button>
                    {secret.source === "settings" && (
                      <Button variant="ghost" onClick={() => void save({ [key]: "" }, label)}>
                        Remove
                      </Button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </Card>

      <Card title="Video" subtitle={estimate}>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Who makes the videos" hint="AI makes every video end to end, or each brief goes to a real creator: agents find creators who already make that kind of video, write their brief, and a client-taste agent approves the pair before any outreach.">
            <select value={values.production_mode} onChange={(event) => set("production_mode")(event.target.value)} className={inputClass}>
              <option value="ai">AI videos, end to end</option>
              <option value="creators">Real creators, briefed by agents</option>
            </select>
          </Field>
          {values.production_mode === "creators" ? (
            <Field label="Creator fee (USD)" hint="The flat fee offered for one video, with usage on your own accounts.">
              <input type="number" min={0} value={values.creator_fee_usd} onChange={(event) => set("creator_fee_usd")(event.target.value)} className={inputClass} />
            </Field>
          ) : null}
          <Field label="Video model" hint="Naive renders with this model; Monid's Kling 3.0 takes over if Naive runs out of credits.">
            <select value={values.video_model} onChange={(event) => set("video_model")(event.target.value)} className={inputClass}>
              {[...new Set([values.video_model, ...settings.videoModels])].map((id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Videos per campaign">
            <input type="number" min={1} max={8} value={values.videos_per_campaign} onChange={(event) => set("videos_per_campaign")(event.target.value)} className={inputClass} />
          </Field>
          <Field label="Shots per video" hint="Each shot is a separate render; shots are cut together.">
            <input type="number" min={1} max={3} value={values.shots_per_video} onChange={(event) => set("shots_per_video")(event.target.value)} className={inputClass} />
          </Field>
          <Field label="Seconds per shot">
            <input type="number" min={4} max={10} value={values.video_seconds} onChange={(event) => set("video_seconds")(event.target.value)} className={inputClass} />
          </Field>
          <Field label="Quality-check re-renders per shot" hint="A shot that fails QC is re-rendered with a corrected prompt this many times.">
            <input type="number" min={0} max={3} value={values.qc_max_retries} onChange={(event) => set("qc_max_retries")(event.target.value)} className={inputClass} />
          </Field>
          <Field label="Monid fallback resolution">
            <select value={values.monid_video_resolution} onChange={(event) => set("monid_video_resolution")(event.target.value)} className={inputClass}>
              <option value="720p">720p ($0.126/s with audio)</option>
              <option value="1080p">1080p ($0.168/s with audio)</option>
              <option value="4k">4K ($0.42/s)</option>
            </select>
          </Field>
        </div>
        <div className="mt-5 space-y-3">
          <Toggle checked={values.learn_style === "true"} onChange={(v) => set("learn_style")(String(v))} label="Study the format of top videos before writing concepts" />
          <Toggle checked={values.monid_video_fallback === "true"} onChange={(v) => set("monid_video_fallback")(String(v))} label="Render on Monid when Naive is out of credits" />
          <Toggle
            checked={values.autopilot === "true"}
            onChange={(v) => set("autopilot")(String(v))}
            label="Autopilot: approve finished videos and schedule them without review"
            hint="Off by default. With it on, videos post to the brand's accounts without a person watching them first."
          />
        </div>
        <div className="mt-6 flex items-center gap-3">
          <Button variant="primary" loading={saving} onClick={() => void save(values, "Video settings")}>
            Save
          </Button>
          {saved && <span className="text-sm text-emerald-300">{saved} saved</span>}
        </div>
      </Card>
    </div>
  );
}

const inputClass = "h-10 w-full rounded-xl border border-white/10 bg-black/20 px-3 text-sm text-zinc-100 focus:border-violet-400/50 focus:outline-none";

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="text-xs font-medium text-zinc-300">{label}</span>
      <div className="mt-1">{children}</div>
      {hint && <span className="mt-1 block text-[11px] text-zinc-500">{hint}</span>}
    </label>
  );
}

function Toggle({ checked, onChange, label, hint }: { checked: boolean; onChange: (value: boolean) => void; label: string; hint?: string }) {
  return (
    <label className="flex cursor-pointer items-start gap-3">
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} className="mt-0.5 size-4 accent-violet-500" />
      <span>
        <span className="text-sm text-zinc-200">{label}</span>
        {hint && <span className="block text-xs text-zinc-500">{hint}</span>}
      </span>
    </label>
  );
}
