import { randomUUID } from "node:crypto";
import { TABLES } from "../../convex/tables";
import { store } from "./store";
import { sqliteConnection } from "./store/sqlite";
import type { TableName } from "./store/types";

// The core's storage helpers. Rows live in the store (src/lib/store): SQLite on a machine with a
// disk, Convex on serverless hosts. Everything here is async because Convex is a network away.

export { store };

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
export async function save(table: TableName, id: string, fields: Record<string, unknown>) {
  if (Object.keys(fields).length === 0) return;
  await store().update(table, { [TABLES[table].key]: id }, fields);
}

export async function logEvent(event: { brandId?: string; campaignId?: string; level?: "info" | "warn" | "error"; message: string }) {
  await store().logEvent({ brand_id: event.brandId ?? null, campaign_id: event.campaignId ?? null, ts: now(), level: event.level ?? "info", message: event.message });
}

// --- The phones track's tables (src/lib/phones) still use SQLite directly. ---------------------

/** The SQLite connection, for the phones track's own tables. Phones need the SQLite store. */
export function db() {
  if (store().kind !== "sqlite") throw new Error("Phones aren't available on this deployment yet: they still keep their data in the local database.");
  return sqliteConnection();
}

/** Synchronous update for the phones track's tables (SQLite only). The core uses save(). */
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
