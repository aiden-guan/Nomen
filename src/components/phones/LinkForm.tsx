"use client";

// OWNED BY THE PHONES TRACK (see docs/handoff-dylan.md). Pick the brand's phone and its official accounts.
import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge, Button, Spinner, cx } from "@/components/ui";
import { inputClass, phonesApi, type DeviceView, type PhonesStatus, type Platform } from "./parts";

type Props = {
  status: PhonesStatus;
  niche: string[];
  onSaved: (status: PhonesStatus) => void;
  onCancel?: () => void;
};

const newKey = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);

export function LinkForm({ status, niche, onSaved, onCancel }: Props) {
  const link = status.link;
  const [devices, setDevices] = useState<DeviceView[] | null>(null);
  const [devicesError, setDevicesError] = useState<string | null>(null);
  const [credentials, setCredentials] = useState<Record<string, string[]>>({});
  const [deviceId, setDeviceId] = useState(link?.deviceId ?? "");
  const [accounts, setAccounts] = useState<Partial<Record<Platform, string>>>(() =>
    Object.fromEntries((link?.accounts ?? []).map((account) => [account.platform, account.credentialName ?? ""])),
  );
  const [topicsText, setTopicsText] = useState(() => (link?.topics.length ? link.topics : niche).join(", "));
  const [vpnCountry, setVpnCountry] = useState(link?.vpnCountry ?? "");
  const [official, setOfficial] = useState(false);
  const [saving, setSaving] = useState(false);
  const [provisioning, setProvisioning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadDevices = useCallback(async () => {
    setDevicesError(null);
    try {
      setDevices(await phonesApi<DeviceView[]>("/devices"));
    } catch (err) {
      setDevicesError(err instanceof Error ? err.message : String(err));
      setDevices([]);
    }
  }, []);

  useEffect(() => {
    void loadDevices();
    phonesApi<Record<string, string[]>>("/credentials")
      .then(setCredentials)
      .catch(() => setCredentials({}));
  }, [loadDevices]);

  const topics = useMemo(
    () =>
      topicsText
        .split(/[,\n]/)
        .map((topic) => topic.trim())
        .filter(Boolean),
    [topicsText],
  );
  const selected = Object.keys(accounts) as Platform[];
  const canSave = Boolean(deviceId) && selected.length > 0 && topics.length > 0 && official && !saving;

  async function provision() {
    setProvisioning(true);
    setError(null);
    try {
      const device = await phonesApi<DeviceView>("/devices", { method: "POST", body: { brandId: status.brand.id, idempotencyKey: newKey(), country: vpnCountry || undefined } });
      await loadDevices();
      setDeviceId(device.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setProvisioning(false);
    }
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const next = await phonesApi<PhonesStatus>("/link", {
        method: "PUT",
        body: {
          brandId: status.brand.id,
          deviceId,
          official,
          topics,
          vpnCountry: vpnCountry || null,
          accounts: selected.map((platform) => ({ platform, credentialName: accounts[platform] ?? "" })),
        },
      });
      onSaved(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  function toggle(platform: Platform) {
    setAccounts((current) => {
      const next = { ...current };
      if (platform in next) delete next[platform];
      else next[platform] = credentials[platform]?.[0] ?? "";
      return next;
    });
  }

  return (
    <div className="space-y-6">
      <section>
        <div className="mb-2 flex items-center justify-between gap-3">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-400">1. Phone</h3>
          <Button size="sm" variant="ghost" onClick={() => void loadDevices()}>
            Refresh
          </Button>
        </div>
        {devices === null ? (
          <div className="flex items-center gap-2 text-sm text-zinc-400">
            <Spinner /> Loading phones from Mobilerun…
          </div>
        ) : (
          <div className="space-y-2">
            {devicesError && <p className="text-sm text-rose-300">{devicesError}</p>}
            {devices.length === 0 && !devicesError && <p className="text-sm text-zinc-400">No phones on this Mobilerun account yet.</p>}
            {devices.map((device) => {
              const takenByOther = device.linkedBrandId !== null && device.linkedBrandId !== status.brand.id;
              const unusable = takenByOther || device.state === "terminated";
              return (
                <label
                  key={device.id}
                  className={cx(
                    "flex cursor-pointer items-start gap-3 rounded-xl border px-3 py-2.5 transition",
                    deviceId === device.id ? "border-violet-500/50 bg-violet-500/[0.06]" : "border-white/10 bg-white/[0.02] hover:bg-white/[0.04]",
                    unusable && "cursor-not-allowed opacity-50",
                  )}
                >
                  <input type="radio" name="phone" className="mt-1 accent-violet-500" checked={deviceId === device.id} disabled={unusable} onChange={() => setDeviceId(device.id)} />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2 text-sm text-zinc-100">
                      <span className="font-medium">{device.name}</span>
                      <Badge tone={device.tone}>{device.label}</Badge>
                      {takenByOther && <span className="text-xs text-zinc-500">Linked to {device.linkedBrandName ?? "another brand"}</span>}
                    </div>
                    <p className="mt-0.5 text-xs text-zinc-500">{device.detail}</p>
                  </div>
                </label>
              );
            })}
            <div className="flex flex-wrap items-center gap-3 pt-1">
              <Button size="sm" onClick={() => void provision()} loading={provisioning}>
                New Android cloud phone
              </Button>
              <span className="text-xs text-zinc-500">Billed per minute while it runs. Each brand gets its own phone.</span>
            </div>
          </div>
        )}
      </section>

      <section>
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-zinc-400">2. The brand&apos;s accounts</h3>
        <p className="mb-3 text-xs text-zinc-500">
          One account per platform. Save each login in Mobilerun&apos;s credential store first (dashboard → Credentials), then pick its name here. Leave it blank if
          the app on the phone is already logged in.
        </p>
        <div className="space-y-2">
          {status.platforms.map((platform) => {
            const on = platform.id in accounts;
            const saved = credentials[platform.id] ?? [];
            return (
              <div key={platform.id} className={cx("rounded-xl border px-3 py-2.5", on ? "border-white/15 bg-white/[0.04]" : "border-white/10 bg-white/[0.02]")}>
                <label className="flex cursor-pointer items-center gap-3 text-sm text-zinc-100">
                  <input type="checkbox" className="accent-violet-500" checked={on} onChange={() => toggle(platform.id)} />
                  <span className="font-medium">{platform.label}</span>
                  <span className="text-xs text-zinc-500">{platform.packageName}</span>
                </label>
                {on && (
                  <div className="mt-2 pl-7">
                    <input
                      className={inputClass}
                      list={`phones-cred-${platform.id}`}
                      placeholder="Saved login name in Mobilerun (optional)"
                      value={accounts[platform.id] ?? ""}
                      onChange={(event) => setAccounts((current) => ({ ...current, [platform.id]: event.target.value }))}
                    />
                    <datalist id={`phones-cred-${platform.id}`}>
                      {saved.map((name) => (
                        <option key={name} value={name} />
                      ))}
                    </datalist>
                    {saved.length === 0 && <p className="mt-1 text-[11px] text-zinc-500">No saved {platform.label} login found in Mobilerun.</p>}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </section>

      <section className="grid gap-4 sm:grid-cols-[1fr_180px]">
        <div>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-zinc-400">3. Niche to browse</h3>
          <textarea
            className={cx(inputClass, "h-20 py-2")}
            placeholder="Comma-separated topics, e.g. skincare routines, SPF, dermatologist tips"
            value={topicsText}
            onChange={(event) => setTopicsText(event.target.value)}
          />
          <p className="mt-1 text-[11px] text-zinc-500">
            {niche.length ? "Prefilled from the brand's latest strategy." : "The brand's strategy fills this in once it exists; add a few topics by hand until then."} Up
            to 12 topics.
          </p>
        </div>
        <div>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-zinc-400">Traffic country</h3>
          <select className={inputClass} value={vpnCountry} onChange={(event) => setVpnCountry(event.target.value)}>
            <option value="">Phone default</option>
            {status.vpnCountries.map((country) => (
              <option key={country} value={country}>
                {country}
              </option>
            ))}
          </select>
          <p className="mt-1 text-[11px] text-zinc-500">Match the brand&apos;s audience, and keep it the same every day.</p>
        </div>
      </section>

      <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-white/10 bg-white/[0.02] px-3 py-3 text-sm text-zinc-100">
        <input type="checkbox" className="mt-0.5 accent-violet-500" checked={official} onChange={(event) => setOfficial(event.target.checked)} />
        <span>
          This is the brand&apos;s own official account.
          <span className="mt-0.5 block text-xs text-zinc-500">Required. Nomen never creates accounts and only warms up accounts {status.brand.name} owns.</span>
        </span>
      </label>

      {error && <p className="text-sm text-rose-300">{error}</p>}

      <div className="flex items-center gap-2">
        <Button variant="primary" disabled={!canSave} loading={saving} onClick={() => void save()}>
          {link ? "Save changes" : "Link phone and accounts"}
        </Button>
        {onCancel && (
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        )}
      </div>
    </div>
  );
}
