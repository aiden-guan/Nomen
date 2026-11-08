// OWNED BY THE PHONES TRACK (see docs/handoff-dylan.md). The phones track's own tables and queries.
import { db, newId, now, parse, update } from "../db";
import { PLATFORMS, type Platform } from "./mobilerun";

const SCHEMA = `
create table if not exists phone_links (
  id text primary key,
  brand_id text not null unique references brands(id) on delete cascade,
  device_id text not null unique,
  official_confirmed_at text not null,
  topics_json text not null default '[]',
  vpn_country text,
  schedule_enabled integer not null default 0,
  schedule_days integer not null default 7,
  schedule_started_at text,
  created_at text not null,
  updated_at text not null
);

create table if not exists phone_accounts (
  id text primary key,
  brand_id text not null references brands(id) on delete cascade,
  platform text not null,
  credential_name text,
  created_at text not null,
  updated_at text not null,
  unique (brand_id, platform)
);

create table if not exists phone_sessions (
  id text primary key,
  brand_id text not null references brands(id) on delete cascade,
  device_id text not null,
  platform text not null,
  kind text not null,
  day_index integer,
  status text not null,
  minutes integer not null,
  task_id text,
  task_status text,
  steps integer,
  succeeded integer,
  message text,
  error text,
  recording_id text,
  attempts integer not null default 0,
  next_check_at text not null,
  waiting_since text,
  started_at text,
  finished_at text,
  created_at text not null,
  updated_at text not null
);

create unique index if not exists phone_sessions_scheduled on phone_sessions (brand_id, platform, day_index) where kind = 'scheduled';
create index if not exists phone_sessions_brand on phone_sessions (brand_id, created_at);
create index if not exists phone_sessions_status on phone_sessions (status, next_check_at);

create table if not exists phone_parks (
  device_id text primary key,
  brand_id text,
  due_at text not null,
  attempts integer not null default 0,
  error text,
  created_at text not null,
  updated_at text not null
);

create table if not exists phone_posts (
  id text primary key,
  brand_id text not null references brands(id) on delete cascade,
  creative_id text not null,
  title text not null,
  device_id text not null,
  platform text not null,
  visibility text not null default 'public',
  status text not null,
  caption text not null,
  file_name text not null,
  folder text,
  video_seconds real,
  uploaded_at text,
  task_id text,
  task_status text,
  steps integer,
  post_url text,
  message text,
  error text,
  recording_id text,
  attempts integer not null default 0,
  next_check_at text not null,
  waiting_since text,
  started_at text,
  finished_at text,
  created_at text not null,
  updated_at text not null
);

create index if not exists phone_posts_status on phone_posts (status, next_check_at);
create index if not exists phone_posts_brand on phone_posts (brand_id, created_at);
`;

/** Columns added to a phones table after it first shipped. `create table if not exists` never alters a table. */
const ADDED_COLUMNS: Array<[table: string, column: string, definition: string]> = [["phone_posts", "visibility", "text not null default 'public'"]];

let ready = false;

/** Creates the phones tables on first use. Safe to call on every request and worker tick. */
export function phonesDb() {
  const conn = db();
  if (!ready) {
    conn.exec(SCHEMA);
    for (const [table, column, definition] of ADDED_COLUMNS) {
      const columns = conn.prepare(`pragma table_info(${table})`).all() as Array<{ name: string }>;
      if (!columns.some((existing) => existing.name === column)) conn.exec(`alter table ${table} add column ${column} ${definition}`);
    }
    ready = true;
  }
  return conn;
}

/** Test hook: the next phonesDb() call re-runs the schema (after a test drops the tables). */
export function resetSchemaFlag() {
  ready = false;
}

/**
 * pending: waiting for its turn on the phone · waiting: the phone is not ready yet ·
 * starting: a task is being created · queued/running: Mobilerun has the task ·
 * succeeded/failed/cancelled: finished.
 */
export type SessionStatus = "pending" | "waiting" | "starting" | "queued" | "running" | "succeeded" | "failed" | "cancelled";
export const ACTIVE_STATUSES: SessionStatus[] = ["pending", "waiting", "starting", "queued", "running"];
export const TERMINAL_STATUSES: SessionStatus[] = ["succeeded", "failed", "cancelled"];

export type LinkRow = {
  id: string;
  brand_id: string;
  device_id: string;
  official_confirmed_at: string;
  topics_json: string;
  vpn_country: string | null;
  schedule_enabled: number;
  schedule_days: number;
  schedule_started_at: string | null;
  created_at: string;
  updated_at: string;
};

export type AccountRow = { id: string; brand_id: string; platform: Platform; credential_name: string | null; created_at: string; updated_at: string };

export type SessionRow = {
  id: string;
  brand_id: string;
  device_id: string;
  platform: Platform;
  /** "setup": the one-time setup for posting (install TikTok, allow its photos), not a warm-up. */
  kind: "manual" | "scheduled" | "setup";
  day_index: number | null;
  status: SessionStatus;
  minutes: number;
  task_id: string | null;
  task_status: string | null;
  steps: number | null;
  succeeded: number | null;
  message: string | null;
  error: string | null;
  recording_id: string | null;
  attempts: number;
  next_check_at: string;
  waiting_since: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  updated_at: string;
};

export type BrandRow = { id: string; name: string; domain: string };

export const getBrand = (brandId: string) => phonesDb().prepare("select id, name, domain from brands where id = ?").get(brandId) as BrandRow | undefined;

export const getLink = (brandId: string) => phonesDb().prepare("select * from phone_links where brand_id = ?").get(brandId) as LinkRow | undefined;

export const getLinkByDevice = (deviceId: string) => phonesDb().prepare("select * from phone_links where device_id = ?").get(deviceId) as LinkRow | undefined;

export const listLinks = () => phonesDb().prepare("select * from phone_links").all() as LinkRow[];

export const linkTopics = (link: LinkRow) => parse<string[]>(link.topics_json, []);

/** The brand's accounts in the platform list's order (TikTok first). */
export const listAccounts = (brandId: string) =>
  (phonesDb().prepare("select * from phone_accounts where brand_id = ?").all(brandId) as AccountRow[]).sort((a, b) => PLATFORMS.indexOf(a.platform) - PLATFORMS.indexOf(b.platform));

export const getSession = (id: string) => phonesDb().prepare("select * from phone_sessions where id = ?").get(id) as SessionRow | undefined;

export function listSessions(brandId: string, limit = 50) {
  return phonesDb().prepare("select * from phone_sessions where brand_id = ? order by created_at desc, rowid desc limit ?").all(brandId, limit) as SessionRow[];
}

export function activeSessions(brandId: string) {
  return phonesDb()
    .prepare(`select * from phone_sessions where brand_id = ? and status in (${ACTIVE_STATUSES.map(() => "?").join(",")}) order by created_at, rowid`)
    .all(brandId, ...ACTIVE_STATUSES) as SessionRow[];
}

/** Writes the brand's phone, accounts and topics in one transaction. */
export function saveLink(input: { brandId: string; deviceId: string; topics: string[]; vpnCountry: string | null; accounts: Array<{ platform: Platform; credentialName: string | null }> }) {
  const conn = phonesDb();
  const stamp = now();
  conn.transaction(() => {
    const existing = getLink(input.brandId);
    if (existing) {
      update("phone_links", existing.id, { device_id: input.deviceId, topics_json: JSON.stringify(input.topics), vpn_country: input.vpnCountry, official_confirmed_at: stamp });
    } else {
      conn
        .prepare(
          "insert into phone_links (id, brand_id, device_id, official_confirmed_at, topics_json, vpn_country, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(newId("phl"), input.brandId, input.deviceId, stamp, JSON.stringify(input.topics), input.vpnCountry, stamp, stamp);
    }
    const keep = input.accounts.map((account) => account.platform);
    conn
      .prepare(`delete from phone_accounts where brand_id = ? ${keep.length ? `and platform not in (${keep.map(() => "?").join(",")})` : ""}`)
      .run(input.brandId, ...keep);
    const upsert = conn.prepare(
      `insert into phone_accounts (id, brand_id, platform, credential_name, created_at, updated_at) values (?, ?, ?, ?, ?, ?)
       on conflict (brand_id, platform) do update set credential_name = excluded.credential_name, updated_at = excluded.updated_at`,
    );
    for (const account of input.accounts) upsert.run(newId("pha"), input.brandId, account.platform, account.credentialName, stamp, stamp);
  })();
  return getLink(input.brandId)!;
}

export function deleteLink(brandId: string) {
  const conn = phonesDb();
  conn.transaction(() => {
    conn.prepare("delete from phone_accounts where brand_id = ?").run(brandId);
    conn.prepare("delete from phone_links where brand_id = ?").run(brandId);
  })();
}

/**
 * Adds a session unless one is already active for the same brand and platform. A scheduled
 * session is also unique per day, so a worker tick that repeats is harmless.
 */
export function insertSession(input: { brandId: string; deviceId: string; platform: Platform; kind: SessionRow["kind"]; dayIndex: number | null; minutes: number }): SessionRow | undefined {
  const conn = phonesDb();
  return conn.transaction(() => {
    const busy = conn
      .prepare(`select 1 from phone_sessions where brand_id = ? and platform = ? and status in (${ACTIVE_STATUSES.map(() => "?").join(",")})`)
      .get(input.brandId, input.platform, ...ACTIVE_STATUSES);
    if (busy) return undefined;
    const id = newId("phs");
    const stamp = now();
    const result = conn
      .prepare(
        `insert or ignore into phone_sessions (id, brand_id, device_id, platform, kind, day_index, status, minutes, next_check_at, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
      )
      .run(id, input.brandId, input.deviceId, input.platform, input.kind, input.dayIndex, input.minutes, stamp, stamp, stamp);
    return result.changes ? getSession(id) : undefined;
  })();
}

/** The tables whose rows hold a phone while they run: warm-up sessions and posts. */
type JobTable = "phone_sessions" | "phone_posts";

/** Moves a row from one of `from` to `to` only if nobody else moved it first. */
function claimRow(table: JobTable, id: string, from: readonly string[], to: string, fields: Record<string, unknown>) {
  const sets = Object.keys(fields).map((key) => `, ${key} = @${key}`).join("");
  const result = phonesDb()
    .prepare(`update ${table} set status = @to, updated_at = @updated_at${sets} where id = @id and status in (${from.map((_, i) => `@from${i}`).join(",")})`)
    .run({ id, to, updated_at: now(), ...Object.fromEntries(from.map((status, i) => [`from${i}`, status])), ...fields });
  return result.changes === 1;
}

/** Updates a row only while it is still active, so one the user stopped stays stopped. */
function updateActiveRow(table: JobTable, id: string, fields: Record<string, unknown>) {
  const keys = Object.keys(fields);
  const sets = keys.map((key) => `${key} = @${key}`).join(", ");
  const result = phonesDb()
    .prepare(`update ${table} set ${sets}${sets ? ", " : ""}updated_at = @updated_at where id = @id and status in (${ACTIVE_STATUSES.map((_, i) => `@active${i}`).join(",")})`)
    .run({ ...fields, id, updated_at: now(), ...Object.fromEntries(ACTIVE_STATUSES.map((status, i) => [`active${i}`, status])) });
  return result.changes === 1;
}

/** Moves a session from one of `from` to `to` only if nobody else moved it first. */
export const claimSession = (id: string, from: SessionStatus[], to: SessionStatus, fields: Record<string, unknown> = {}) => claimRow("phone_sessions", id, from, to, fields);

export const updateSession = (id: string, fields: Partial<Omit<SessionRow, "id" | "created_at" | "updated_at">>) => update("phone_sessions", id, fields);

/** Updates a session only while it is still active, so a session the user stopped stays stopped. */
export const updateActive = (id: string, fields: Partial<Omit<SessionRow, "id" | "created_at" | "updated_at">>) => updateActiveRow("phone_sessions", id, fields);

export const updateLink = (id: string, fields: Partial<Omit<LinkRow, "id" | "created_at" | "updated_at">>) => update("phone_links", id, fields);

/** Sessions the worker should look at now: active ones whose next check is due, oldest first. */
export function dueSessions(at: string, limit: number) {
  return phonesDb()
    .prepare(`select * from phone_sessions where status in (${ACTIVE_STATUSES.map(() => "?").join(",")}) and next_check_at <= ? order by created_at, rowid limit ?`)
    .all(...ACTIVE_STATUSES, at, limit) as SessionRow[];
}

/**
 * Whether another session or post already holds the phone (a task is being created, queued or
 * running). One task runs on a phone at a time.
 */
export function deviceBusy(deviceId: string, exceptId: string) {
  const holding = (table: JobTable) => `select 1 from ${table} where device_id = @deviceId and id != @exceptId and status in ('starting', 'queued', 'running')`;
  return Boolean(phonesDb().prepare(`${holding("phone_sessions")} union all ${holding("phone_posts")}`).get({ deviceId, exceptId }));
}

// --- Parking: a phone whose work is done is parked so a per-minute phone stops billing. --------

/** A phone waiting to be parked, one row per phone, until it is parked or can't be. */
export type ParkRow = { device_id: string; brand_id: string | null; due_at: string; attempts: number; error: string | null; created_at: string; updated_at: string };

/** Asks the worker to park the phone at `dueAt` (now by default). A new request replaces the old one. */
export function requestPark(deviceId: string, brandId: string | null, dueAt = now()) {
  const stamp = now();
  phonesDb()
    .prepare(
      `insert into phone_parks (device_id, brand_id, due_at, attempts, error, created_at, updated_at) values (?, ?, ?, 0, null, ?, ?)
       on conflict (device_id) do update set brand_id = excluded.brand_id, due_at = excluded.due_at, attempts = 0, error = null, updated_at = excluded.updated_at`,
    )
    .run(deviceId, brandId, dueAt, stamp, stamp);
}

export function dueParks(at: string, limit: number) {
  return phonesDb().prepare("select * from phone_parks where due_at <= ? order by due_at limit ?").all(at, limit) as ParkRow[];
}

export function updatePark(deviceId: string, fields: Partial<Pick<ParkRow, "due_at" | "attempts" | "error">>) {
  const keys = Object.keys(fields);
  phonesDb()
    .prepare(`update phone_parks set ${keys.map((key) => `${key} = @${key}`).join(", ")}${keys.length ? ", " : ""}updated_at = @updated_at where device_id = @device_id`)
    .run({ ...fields, device_id: deviceId, updated_at: now() });
}

export const clearPark = (deviceId: string) => phonesDb().prepare("delete from phone_parks where device_id = ?").run(deviceId);

/** Whether a session or post holds the phone, or another one is due on it before `until`. */
export function phoneNeededBefore(deviceId: string, until: string) {
  const needing = (table: JobTable) =>
    `select 1 from ${table} where device_id = @deviceId and (status in ('starting', 'queued', 'running') or (status in ('pending', 'waiting') and next_check_at <= @until))`;
  return Boolean(phonesDb().prepare(`${needing("phone_sessions")} union all ${needing("phone_posts")}`).get({ deviceId, until }));
}

// --- Posts through the phone: one finished video, posted by the phone agent in the TikTok app. ----

/** Who sees a post through the phone: everyone, or only the brand's own account (TikTok's "Only you"). */
export type PostVisibility = "public" | "private";

/** Same lifecycle as a session, ending in posted, failed or cancelled. */
export type PhonePostStatus = "pending" | "waiting" | "starting" | "queued" | "running" | "posted" | "failed" | "cancelled";

export type PhonePostRow = {
  id: string;
  brand_id: string;
  creative_id: string;
  title: string;
  device_id: string;
  platform: "tiktok";
  /** "private" is a test post TikTok shows only to the brand's own account ("Only you"). */
  visibility: PostVisibility;
  status: PhonePostStatus;
  /** What the agent types, already one line and labeled AI-generated. */
  caption: string;
  /** The cut's name on the phone ("nomen-php_….mp4"). */
  file_name: string;
  /** Where on the phone it was copied ("/DCIM/Camera"), once it was. */
  folder: string | null;
  video_seconds: number | null;
  uploaded_at: string | null;
  task_id: string | null;
  task_status: string | null;
  steps: number | null;
  post_url: string | null;
  message: string | null;
  error: string | null;
  recording_id: string | null;
  attempts: number;
  next_check_at: string;
  waiting_since: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  updated_at: string;
};

export const getPhonePost = (id: string) => phonesDb().prepare("select * from phone_posts where id = ?").get(id) as PhonePostRow | undefined;

export function listPhonePosts(brandId: string, limit = 20) {
  return phonesDb().prepare("select * from phone_posts where brand_id = ? order by created_at desc, rowid desc limit ?").all(brandId, limit) as PhonePostRow[];
}

/**
 * Queues one video to post through the brand's phone. Answers "active" while one of its posts is
 * on its way, and "posted" for a public post once one is out; a private test post doesn't count,
 * and a failed or stopped post can be queued again.
 */
export function insertPhonePost(input: { brandId: string; creativeId: string; title: string; deviceId: string; caption: string; visibility: PostVisibility }): PhonePostRow | "active" | "posted" {
  const conn = phonesDb();
  return conn.transaction(() => {
    const active = conn.prepare(`select 1 from phone_posts where creative_id = ? and status in (${ACTIVE_STATUSES.map(() => "?").join(",")})`).get(input.creativeId, ...ACTIVE_STATUSES);
    if (active) return "active" as const;
    if (input.visibility === "public" && conn.prepare("select 1 from phone_posts where creative_id = ? and status = 'posted' and visibility = 'public'").get(input.creativeId)) {
      return "posted" as const;
    }
    const id = newId("php");
    const stamp = now();
    conn
      .prepare(
        `insert into phone_posts (id, brand_id, creative_id, title, device_id, platform, visibility, status, caption, file_name, next_check_at, created_at, updated_at)
         values (?, ?, ?, ?, ?, 'tiktok', ?, 'pending', ?, ?, ?, ?, ?)`,
      )
      .run(id, input.brandId, input.creativeId, input.title, input.deviceId, input.visibility, input.caption, `nomen-${id}.mp4`, stamp, stamp, stamp);
    return getPhonePost(id)!;
  })();
}

/** Posts the worker should look at now, oldest first. */
export function duePhonePosts(at: string, limit: number) {
  return phonesDb()
    .prepare(`select * from phone_posts where status in (${ACTIVE_STATUSES.map(() => "?").join(",")}) and next_check_at <= ? order by created_at, rowid limit ?`)
    .all(...ACTIVE_STATUSES, at, limit) as PhonePostRow[];
}

export const claimPhonePost = (id: string, from: PhonePostStatus[], to: PhonePostStatus, fields: Record<string, unknown> = {}) => claimRow("phone_posts", id, from, to, fields);

export const updateActivePhonePost = (id: string, fields: Partial<Omit<PhonePostRow, "id" | "created_at" | "updated_at">>) => updateActiveRow("phone_posts", id, fields);
