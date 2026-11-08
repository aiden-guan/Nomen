// OWNED BY THE PHONES TRACK (see docs/handoff-dylan.md). What the /api/phones routes do.
import { logEvent, now } from "../db";
import { secretStatus } from "../settings";
import { warmupMinutes, stopSession } from "./engine";
import { APP_PACKAGES, MobilerunClient, PLATFORMS, PLATFORM_LABELS, VPN_COUNTRIES, type Device, type Platform } from "./mobilerun";
import { clampDays, describeApiError, describeDevice, estimateCredits, scheduleSummary } from "./rules";
import {
  activeSessions,
  deleteLink,
  getBrand,
  getLink,
  getLinkByDevice,
  getSession,
  insertSession,
  linkTopics,
  listAccounts,
  listSessions,
  phonesDb,
  saveLink,
  updateLink,
  type SessionRow,
} from "./store";

/** A request the panel should show as-is: bad input (4xx) or a Mobilerun problem (502). */
export class PhonesError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const requireBrand = (brandId: unknown) => {
  const brand = typeof brandId === "string" ? getBrand(brandId) : undefined;
  if (!brand) throw new PhonesError(404, "Brand not found.");
  return brand;
};

const client = () => {
  if (!secretStatus("mobilerun_api_key").set) throw new PhonesError(400, "No Mobilerun API key. Add one in Settings.");
  return new MobilerunClient();
};

/** Runs a Mobilerun call and turns its failure into a message the panel can show. */
async function mobilerun<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof PhonesError) throw error;
    throw new PhonesError(502, describeApiError(error).message);
  }
}

export type DeviceView = { id: string; name: string; state: string; label: string; detail: string; tone: string; canResume: boolean; linkedBrandId: string | null; linkedBrandName: string | null };

function deviceView(device: Device): DeviceView {
  const link = getLinkByDevice(device.id);
  const words = describeDevice(device.state);
  return {
    id: device.id,
    name: device.name || device.id.slice(0, 8),
    state: device.state,
    label: words.label,
    detail: device.stateMessage && device.state !== "ready" ? `${words.detail} (${device.stateMessage})` : words.detail,
    tone: words.tone,
    canResume: words.canResume,
    linkedBrandId: link?.brand_id ?? null,
    linkedBrandName: link ? (getBrand(link.brand_id)?.name ?? null) : null,
  };
}

export function sessionView(row: SessionRow) {
  return {
    id: row.id,
    platform: row.platform,
    platformLabel: PLATFORM_LABELS[row.platform] ?? row.platform,
    kind: row.kind,
    day: row.day_index === null ? null : row.day_index + 1,
    status: row.status,
    minutes: row.minutes,
    steps: row.steps,
    message: row.message,
    error: row.error,
    hasRecording: Boolean(row.recording_id),
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

/** Everything the panel shows for one brand. Mobilerun being down only blanks the phone's live state. */
export async function getStatus(brandId: unknown) {
  phonesDb();
  const brand = requireBrand(brandId);
  const key = secretStatus("mobilerun_api_key");
  const link = getLink(brand.id);
  const minutes = warmupMinutes();
  let device: DeviceView | null = null;
  let deviceError: string | null = null;
  if (key.set && link) {
    try {
      device = deviceView(await new MobilerunClient().getDevice(link.device_id));
    } catch (error) {
      deviceError = describeApiError(error).message;
    }
  }
  const schedule = link ? { enabled: link.schedule_enabled === 1, days: link.schedule_days, startedAt: link.schedule_started_at } : null;
  return {
    configured: key.set,
    keySource: key.source,
    brand,
    platforms: PLATFORMS.map((id) => ({ id, label: PLATFORM_LABELS[id], packageName: APP_PACKAGES[id] })),
    vpnCountries: VPN_COUNTRIES,
    session: { minutes, estimatedCredits: estimateCredits(minutes) },
    link: link
      ? {
          deviceId: link.device_id,
          topics: linkTopics(link),
          vpnCountry: link.vpn_country,
          officialConfirmedAt: link.official_confirmed_at,
          accounts: listAccounts(brand.id).map((row) => ({ platform: row.platform, credentialName: row.credential_name })),
          schedule: { ...schedule!, ...scheduleSummary(schedule!, new Date()) },
        }
      : null,
    device,
    deviceError,
    active: activeSessions(brand.id).map(sessionView),
    history: listSessions(brand.id, 40).map(sessionView),
  };
}

export async function listDevices() {
  const devices = await mobilerun(() => client().listDevices());
  return devices.map(deviceView);
}

export async function provisionDevice(input: { brandId?: unknown; idempotencyKey?: unknown; country?: unknown }) {
  const brand = requireBrand(input.brandId);
  const key = typeof input.idempotencyKey === "string" && /^[!-~]{8,255}$/.test(input.idempotencyKey) ? input.idempotencyKey : null;
  if (!key) throw new PhonesError(400, "Missing idempotency key.");
  const country = typeof input.country === "string" && /^[A-Z]{2}$/.test(input.country) ? input.country : undefined;
  const device = await mobilerun(() => client().provisionAndroidPhone({ idempotencyKey: key, name: `nomen-${brand.name}`.slice(0, 60), country }));
  logEvent({ brandId: brand.id, message: `Phones: requested a new Android cloud phone (${device.name || device.id}). It is billed per minute while it runs.` });
  return deviceView(device);
}

export async function resumeDevice(deviceId: string) {
  const mr = client();
  await mobilerun(() => mr.resumeDevice(deviceId));
  return deviceView(await mobilerun(() => mr.getDevice(deviceId)));
}

/** Saved login names per platform. The values never leave the Mobilerun client. */
export async function credentialNames() {
  const names = await mobilerun(() => client().listCredentialNames());
  return Object.fromEntries(PLATFORMS.map((platform) => [platform, names.filter((item) => item.packageName === APP_PACKAGES[platform]).map((item) => item.credentialName)]));
}

function cleanTopics(value: unknown) {
  const topics = Array.isArray(value) ? value : [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const topic of topics) {
    if (typeof topic !== "string") continue;
    const clean = topic.replace(/\s+/g, " ").trim().slice(0, 60);
    if (clean && !seen.has(clean.toLowerCase())) {
      seen.add(clean.toLowerCase());
      out.push(clean);
    }
  }
  return out.slice(0, 12);
}

export async function linkAccounts(input: { brandId?: unknown; deviceId?: unknown; official?: unknown; topics?: unknown; vpnCountry?: unknown; accounts?: unknown }) {
  const brand = requireBrand(input.brandId);
  if (input.official !== true) throw new PhonesError(400, "Confirm that these are the brand's own official accounts.");
  const deviceId = typeof input.deviceId === "string" ? input.deviceId.trim() : "";
  if (!deviceId) throw new PhonesError(400, "Choose a phone.");

  const rawAccounts = Array.isArray(input.accounts) ? input.accounts : [];
  const accounts: Array<{ platform: Platform; credentialName: string | null }> = [];
  for (const raw of rawAccounts) {
    const item = (raw ?? {}) as { platform?: unknown; credentialName?: unknown };
    if (typeof item.platform !== "string" || !PLATFORMS.includes(item.platform as Platform)) throw new PhonesError(400, `Unknown platform: ${String(item.platform)}.`);
    if (accounts.some((account) => account.platform === item.platform)) throw new PhonesError(400, `Only one ${PLATFORM_LABELS[item.platform as Platform]} account per brand.`);
    const name = typeof item.credentialName === "string" ? item.credentialName.trim().slice(0, 120) : "";
    accounts.push({ platform: item.platform as Platform, credentialName: name || null });
  }
  if (accounts.length === 0) throw new PhonesError(400, "Pick at least one platform.");

  const topics = cleanTopics(input.topics);
  if (topics.length === 0) throw new PhonesError(400, "Add at least one niche topic for the warm-up to browse.");
  const vpnCountry = typeof input.vpnCountry === "string" && (VPN_COUNTRIES as readonly string[]).includes(input.vpnCountry) ? input.vpnCountry : null;

  const other = getLinkByDevice(deviceId);
  if (other && other.brand_id !== brand.id) {
    throw new PhonesError(409, `That phone is already linked to ${getBrand(other.brand_id)?.name ?? "another brand"}. Each brand needs its own phone so its accounts are not tied to another brand's.`);
  }
  const device = await mobilerun(() => client().getDevice(deviceId));
  if (describeDevice(device.state).gone) throw new PhonesError(400, "That phone was deleted in Mobilerun. Choose another one.");

  const previous = getLink(brand.id);
  if (previous && previous.device_id !== deviceId) {
    for (const session of activeSessions(brand.id)) await stopSession(session, "The brand moved to a different phone.");
  }
  // Sessions for platforms that were removed stop too.
  for (const session of activeSessions(brand.id)) {
    if (!accounts.some((account) => account.platform === session.platform)) await stopSession(session, "This account was unlinked.");
  }
  saveLink({ brandId: brand.id, deviceId, topics, vpnCountry, accounts });
  logEvent({ brandId: brand.id, message: `Phones: linked ${accounts.map((account) => PLATFORM_LABELS[account.platform]).join(", ")} on phone ${device.name || deviceId}.` });
  return getStatus(brand.id);
}

export async function unlink(brandId: unknown) {
  const brand = requireBrand(brandId);
  for (const session of activeSessions(brand.id)) await stopSession(session, "The brand's phone was unlinked.");
  deleteLink(brand.id);
  logEvent({ brandId: brand.id, message: "Phones: unlinked the brand's phone and accounts." });
  return getStatus(brand.id);
}

export async function runNow(input: { brandId?: unknown; platform?: unknown }) {
  const brand = requireBrand(input.brandId);
  if (!secretStatus("mobilerun_api_key").set) throw new PhonesError(400, "No Mobilerun API key. Add one in Settings.");
  const link = getLink(brand.id);
  if (!link) throw new PhonesError(400, "Link the brand's phone and accounts first.");
  if (linkTopics(link).length === 0) throw new PhonesError(400, "Add at least one niche topic first.");
  const accounts = listAccounts(brand.id).filter((account) => input.platform === undefined || input.platform === null || account.platform === input.platform);
  if (accounts.length === 0) throw new PhonesError(400, "That account is not linked.");
  const minutes = warmupMinutes();
  const created = accounts.flatMap((account) => insertSession({ brandId: brand.id, deviceId: link.device_id, platform: account.platform, kind: "manual", dayIndex: null, minutes }) ?? []);
  if (created.length === 0) throw new PhonesError(409, "A warm-up is already queued or running for these accounts.");
  logEvent({ brandId: brand.id, message: `Phones: warm-up queued for ${created.map((row) => PLATFORM_LABELS[row.platform]).join(", ")}.` });
  return getStatus(brand.id);
}

export async function setSchedule(input: { brandId?: unknown; enabled?: unknown; days?: unknown }) {
  const brand = requireBrand(input.brandId);
  const link = getLink(brand.id);
  if (!link) throw new PhonesError(400, "Link the brand's phone and accounts first.");
  const days = clampDays(input.days ?? link.schedule_days);
  if (input.enabled === true) {
    const restart = link.schedule_enabled !== 1;
    updateLink(link.id, { schedule_enabled: 1, schedule_days: days, ...(restart ? { schedule_started_at: now() } : {}) });
    logEvent({ brandId: brand.id, message: restart ? `Phones: daily warm-up scheduled for ${days} days.` : `Phones: warm-up schedule changed to ${days} days.` });
  } else {
    updateLink(link.id, { schedule_enabled: 0, schedule_days: days });
    for (const session of activeSessions(brand.id)) {
      if (session.kind === "scheduled" && (session.status === "pending" || session.status === "waiting")) await stopSession(session, "The schedule was turned off.");
    }
    logEvent({ brandId: brand.id, message: "Phones: daily warm-up schedule turned off." });
  }
  return getStatus(brand.id);
}

export async function cancelSession(sessionId: string) {
  const session = getSession(sessionId);
  if (!session) throw new PhonesError(404, "Session not found.");
  const stopped = await stopSession(session, "Stopped by you.", secretStatus("mobilerun_api_key").set ? new MobilerunClient() : undefined);
  if (!stopped) throw new PhonesError(409, "That session already finished.");
  return getStatus(session.brand_id);
}
