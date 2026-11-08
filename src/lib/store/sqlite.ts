import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";
import { copyFile, mkdir } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { isTable, type Scalar, TABLES } from "../../../convex/tables";
import type { BrandSnapshot, Files, ListItem, Order, Row, Store, TableName, Where } from "./types";

// The store on a machine with a disk: one SQLite file (data/nomen.db, or NOMEN_DB_PATH) and media
// under data/media. This is the core's original storage, unchanged in shape.

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
`;

/** Columns added after a table first shipped. `create table if not exists` never alters a table. */
const ADDED_COLUMNS: Array<[table: string, column: string, definition: string]> = [
  ["campaigns", "style_attempt", "integer not null default 0"],
  ["creatives", "continuity_json", "text"],
  ["creatives", "final_key", "text"],
];

export function sqliteConnection(): Database.Database {
  if (!globalThis.__nomenDb) {
    const path = process.env.NOMEN_DB_PATH ?? join(process.cwd(), "data", "nomen.db");
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    const conn = new Database(path);
    conn.pragma("journal_mode = WAL");
    conn.pragma("foreign_keys = ON");
    conn.pragma("busy_timeout = 5000");
    conn.exec(SCHEMA);
    for (const [table, column, definition] of ADDED_COLUMNS) {
      const columns = conn.prepare(`pragma table_info(${table})`).all() as Array<{ name: string }>;
      if (!columns.some((c) => c.name === column)) conn.exec(`alter table ${table} add column ${column} ${definition}`);
    }
    globalThis.__nomenDb = conn;
  }
  return globalThis.__nomenDb;
}

const COLUMN = /^[a-z_][a-z0-9_]*$/;
function column(name: string) {
  if (!COLUMN.test(name)) throw new Error(`Bad column name ${name}`);
  return name;
}
function table(name: string): TableName {
  if (!isTable(name)) throw new Error(`Unknown table ${name}`);
  return name;
}

/** SQL for the conditions in convex/tables.ts, with the same meaning (null never equals a value). */
function whereSql(where: Where): { sql: string; params: Scalar[] } {
  const parts: string[] = [];
  const params: Scalar[] = [];
  for (const [name, condition] of Object.entries(where)) {
    const c = column(name);
    if (condition === null) parts.push(`${c} is null`);
    else if (typeof condition !== "object") {
      parts.push(`${c} = ?`);
      params.push(condition);
    } else if ("in" in condition) {
      const values = condition.in.filter((value) => value !== null);
      const or = condition.in.includes(null) ? ` or ${c} is null` : "";
      parts.push(values.length ? `(${c} in (${values.map(() => "?").join(", ")})${or})` : or ? `${c} is null` : "0");
      params.push(...values);
    } else if ("ne" in condition) {
      if (condition.ne === null) parts.push(`${c} is not null`);
      else {
        parts.push(`(${c} != ? or ${c} is null)`);
        params.push(condition.ne);
      }
    } else {
      const [op, value] = "lt" in condition ? ["<", condition.lt] : "lte" in condition ? ["<=", condition.lte] : "gt" in condition ? [">", condition.gt] : ["gte" in condition ? ">=" : "=", (condition as { gte: Scalar }).gte];
      if (value === null) parts.push("0");
      else {
        parts.push(`${c} ${op} ?`);
        params.push(value);
      }
    }
  }
  return { sql: parts.length ? ` where ${parts.join(" and ")}` : "", params };
}

function orderSql(order: Order | undefined) {
  const keys = (order ?? []).map(([name, direction]) => `${column(name)} ${direction === "desc" ? "desc" : "asc"}`);
  // Ties keep insertion order, the same tie-break as convex/tables.ts sortRows.
  keys.push(`rowid ${order?.[0]?.[1] === "desc" ? "desc" : "asc"}`);
  return ` order by ${keys.join(", ")}`;
}

const values = (row: Row) => Object.fromEntries(Object.entries(row).filter(([, value]) => value !== undefined).map(([key, value]) => [column(key), typeof value === "boolean" ? Number(value) : value]));

export function sqliteStore(): Store {
  const db = sqliteConnection;
  const files = localFiles();
  const store: Store = {
    kind: "sqlite",
    async find<T>(name: TableName, where: Where = {}, options: { order?: Order; limit?: number } = {}) {
      const { sql, params } = whereSql(where);
      const limit = options.limit ? ` limit ${Math.max(0, Math.floor(options.limit))}` : "";
      return db().prepare(`select * from ${table(name)}${sql}${orderSql(options.order)}${limit}`).all(...params) as T[];
    },
    async insert(name, row, options = {}) {
      const t = table(name);
      const data = values({ ...TABLES[t].defaults, ...row });
      if (options.unique?.length) {
        const where = Object.fromEntries(options.unique.map((c) => [c, (data[c] ?? null) as Scalar]));
        if ((await store.find(t, where, { limit: 1 })).length) return false;
      }
      const columns = Object.keys(data);
      db()
        .prepare(`insert into ${t} (${columns.join(", ")}) values (${columns.map((c) => `@${c}`).join(", ")})`)
        .run(data);
      return true;
    },
    async update(name, where, fields) {
      const t = table(name);
      const data = values(fields);
      if (TABLES[t].stamped && data.updated_at === undefined) data.updated_at = new Date().toISOString();
      const keys = Object.keys(data);
      if (!keys.length) return 0;
      const { sql, params } = whereSql(where);
      const sets = keys.map((key) => `${key} = ?`).join(", ");
      return db()
        .prepare(`update ${t} set ${sets}${sql}`)
        .run(...keys.map((key) => data[key] as Scalar), ...params).changes;
    },
    async upsert(name, key, row) {
      const where = Object.fromEntries(key.map((c) => [c, (row[c] ?? null) as Scalar]));
      if (!(await store.update(name, where, row))) await store.insert(name, row);
    },
    async remove(name, where) {
      const { sql, params } = whereSql(where);
      return db().prepare(`delete from ${table(name)}${sql}`).run(...params).changes;
    },
    async logEvent(event) {
      db().prepare("insert into events (brand_id, campaign_id, ts, level, message) values (?, ?, ?, ?, ?)").run(event.brand_id, event.campaign_id, event.ts, event.level, event.message);
    },
    async events({ brand_id, campaign_id, limit = 60 }) {
      const [where, value] = campaign_id ? ["campaign_id", campaign_id] : ["brand_id", brand_id ?? null];
      return db()
        .prepare(`select ts, level, message from events where ${where} ${value === null ? "is null" : "= ?"} order by id desc limit ?`)
        .all(...(value === null ? [] : [value]), limit) as Array<{ ts: string; level: string; message: string }>;
    },
    async brandSnapshot(brandId) {
      const [brand] = await store.find("brands", { id: brandId });
      if (!brand) return null;
      const campaigns = await store.find("campaigns", { brand_id: brandId }, { order: [["created_at", "desc"]] });
      const latest = campaigns[0];
      const id = latest?.id as string | undefined;
      const runs = id ? await store.find("monid_runs", { campaign_id: id }, { order: [["created_at", "asc"]] }) : [];
      const creatives = id ? await store.find("creatives", { campaign_id: id }, { order: [["idx", "asc"], ["generation", "asc"]] }) : [];
      const posts = creatives.length ? await store.find("posts", { creative_id: { in: creatives.map((c) => c.id as string) } }, { order: [["created_at", "asc"]] }) : [];
      const events = await store.events({ brand_id: brandId, limit: 60 });
      return { brand, campaigns, runs, creatives, posts, events } satisfies BrandSnapshot;
    },
    async listSnapshot() {
      const brands = await store.find("brands", {}, { order: [["updated_at", "desc"]] });
      const out: ListItem[] = [];
      for (const brand of brands) {
        const [campaign] = await store.find("campaigns", { brand_id: brand.id as string }, { order: [["created_at", "desc"]], limit: 1 });
        const creatives = campaign ? await store.find("creatives", { campaign_id: campaign.id as string }, { order: [["idx", "asc"], ["generation", "asc"]] }) : [];
        out.push({ brand, campaign: campaign ?? null, creatives });
      }
      return out;
    },
    files,
    // One process: the worker's own busy flag already keeps ticks apart, and its interval ticks.
    lease: { acquire: async () => true, release: async () => undefined },
    nextTick: async () => undefined,
  };
  return store;
}

/** Finished videos and frames are kept here so review never depends on a provider's link. */
export const mediaRoot = () => join(process.cwd(), "data", "media");

function localFiles(): Files {
  // Keys are "crv_…/name"; older rows may hold an absolute path, which still works.
  const pathOf = (key: string) => (isAbsolute(key) ? key : join(mediaRoot(), key));
  return {
    async putFile(key, path) {
      const target = pathOf(key);
      if (target === path) return;
      await mkdir(dirname(target), { recursive: true });
      await copyFile(path, target);
    },
    async saveUrl(key, url) {
      const { download } = await import("../media");
      await download(url, pathOf(key));
    },
    async exists(key) {
      return existsSync(pathOf(key));
    },
    async localPath(key) {
      return pathOf(key);
    },
    async url(key) {
      return existsSync(pathOf(key)) && !isAbsolute(key) ? `/api/media/${key}` : null;
    },
  };
}
