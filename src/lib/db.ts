import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

declare global {
  var __nomenDb: Database.Database | undefined;
}

const SCHEMA = `
create table if not exists settings (key text primary key, value text not null);

create table if not exists brands (
  id text primary key,
  name text not null,
  domain text not null,
  url text not null,
  profile_json text,
  identity_id text,
  social_activated integer not null default 0,
  created_at text not null,
  updated_at text not null
);

create table if not exists campaigns (
  id text primary key,
  brand_id text not null references brands(id) on delete cascade,
  status text not null,
  stage text not null,
  error text,
  attempts integer not null default 0,
  options_json text not null,
  plan_json text,
  research_json text,
  style_build_id text,
  style_idem text,
  style_json text,
  style_started_at text,
  strategy_idem text,
  strategy_session_id text,
  strategy_nudges integer not null default 0,
  strategy_json text,
  naive_out integer not null default 0,
  style_spend_micro integer not null default 0,
  strategy_spend_micro integer not null default 0,
  naive_spend_micro integer not null default 0,
  monid_spend_micro integer not null default 0,
  created_at text not null,
  updated_at text not null
);

create table if not exists monid_runs (
  id text primary key,
  campaign_id text not null references campaigns(id) on delete cascade,
  key text not null,
  phase text not null,
  provider text not null,
  endpoint text not null,
  input_json text not null,
  run_id text,
  status text not null,
  output_json text,
  error text,
  cost_micro integer not null default 0,
  created_at text not null,
  updated_at text not null,
  unique (campaign_id, key)
);

create table if not exists creatives (
  id text primary key,
  campaign_id text not null references campaigns(id) on delete cascade,
  idx integer not null,
  generation integer not null default 1,
  concept_json text not null,
  shots_json text not null,
  status text not null,
  final_file_id text,
  final_url text,
  final_url_expires_at text,
  final_external_url text,
  poster_url text,
  qc_score real,
  caption text not null,
  platforms_json text not null,
  approved integer not null default 0,
  rejected integer not null default 0,
  cost_micro integer not null default 0,
  error text,
  created_at text not null,
  updated_at text not null
);

create table if not exists posts (
  id text primary key,
  creative_id text not null references creatives(id) on delete cascade,
  brand_id text not null references brands(id) on delete cascade,
  idem text not null,
  naive_post_id text,
  platforms_json text not null,
  scheduled_at text,
  status text not null,
  result_json text,
  analytics_json text,
  analytics_at text,
  error text,
  created_at text not null,
  updated_at text not null
);

create table if not exists events (
  id integer primary key autoincrement,
  brand_id text,
  campaign_id text,
  ts text not null,
  level text not null,
  message text not null
);

create index if not exists events_campaign on events (campaign_id, id);
create index if not exists creatives_campaign on creatives (campaign_id, idx);

create table if not exists static_packs (
  id text primary key,
  campaign_id text not null references campaigns(id) on delete cascade,
  brand_id text not null references brands(id) on delete cascade,
  status text not null,
  stage text not null,
  error text,
  attempts integer not null default 0,
  options_json text not null,
  plan_json text,
  research_json text,
  study_json text,
  search_json text,
  assets_json text,
  tokens_in integer not null default 0,
  tokens_out integer not null default 0,
  image_cost_micro integer not null default 0,
  created_at text not null,
  updated_at text not null
);

create table if not exists static_ads (
  id text primary key,
  pack_id text not null references static_packs(id) on delete cascade,
  idx integer not null,
  generation integer not null default 1,
  concept_json text not null,
  status text not null,
  visual_json text,
  renders_json text,
  qc_json text,
  approved integer not null default 0,
  rejected integer not null default 0,
  error text,
  created_at text not null,
  updated_at text not null
);

create index if not exists static_packs_campaign on static_packs (campaign_id, created_at);
create index if not exists static_ads_pack on static_ads (pack_id, idx);
`;

export function db(): Database.Database {
  if (!globalThis.__nomenDb) {
    const path = process.env.NOMEN_DB_PATH ?? join(process.cwd(), "data", "nomen.db");
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    const conn = new Database(path);
    conn.pragma("journal_mode = WAL");
    conn.pragma("foreign_keys = ON");
    conn.pragma("busy_timeout = 5000");
    conn.exec(SCHEMA);
    migrate(conn);
    globalThis.__nomenDb = conn;
  }
  return globalThis.__nomenDb;
}

/** Columns added after a table first shipped. `create table if not exists` never alters a table. */
const ADDED_COLUMNS: Array<[table: string, column: string, definition: string]> = [
  ["campaigns", "style_attempt", "integer not null default 0"],
  ["creatives", "continuity_json", "text"],
];

function migrate(conn: Database.Database) {
  for (const [table, column, definition] of ADDED_COLUMNS) {
    const columns = conn.prepare(`pragma table_info(${table})`).all() as Array<{ name: string }>;
    if (!columns.some((c) => c.name === column)) conn.exec(`alter table ${table} add column ${column} ${definition}`);
  }
}

export const newId = (prefix: string) => `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
export const now = () => new Date().toISOString();

export function parse<T>(json: string | null | undefined, fallback: T): T {
  if (!json) return fallback;
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
}

/** Updates the named columns of one row and stamps updated_at. */
export function update(table: string, id: string, fields: Record<string, unknown>) {
  const keys = Object.keys(fields);
  if (keys.length === 0) return;
  const sets = keys.map((key) => `${key} = @${key}`).join(", ");
  const values: Record<string, unknown> = { id, updated_at: now() };
  for (const key of keys) {
    const value = fields[key];
    values[key] = typeof value === "boolean" ? Number(value) : value;
  }
  db().prepare(`update ${table} set ${sets}, updated_at = @updated_at where id = @id`).run(values);
}

export function logEvent(event: { brandId?: string; campaignId?: string; level?: "info" | "warn" | "error"; message: string }) {
  db()
    .prepare("insert into events (brand_id, campaign_id, ts, level, message) values (?, ?, ?, ?, ?)")
    .run(event.brandId ?? null, event.campaignId ?? null, now(), event.level ?? "info", event.message);
}
