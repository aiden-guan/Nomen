import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { BrandSnapshot, EventLine, Files, ListItem, Row, Store } from "./types";

// The store on serverless hosts: rows and media in Convex (convex/*.ts). Every call carries the
// server secret; the functions refuse anything else, so browsers can't reach the data directly.

/** Convex has no undefined: leave such keys out, at any depth. */
function clean(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(clean);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined).map(([k, v]) => [k, clean(v)]));
  return value;
}

export type ConvexCaller = {
  query<T>(name: string, args: Record<string, unknown>): Promise<T>;
  mutation<T>(name: string, args: Record<string, unknown>): Promise<T>;
};

/** Calls the deployment over HTTP, as the server. */
export function httpCaller(url: string, secret: string): ConvexCaller {
  const client = new ConvexHttpClient(url);
  return {
    query: (name, args) => client.query(makeFunctionReference<"query">(name), { ...args, secret } as never),
    mutation: (name, args) => client.mutation(makeFunctionReference<"mutation">(name), { ...args, secret } as never),
  };
}

export function convexStore(caller: ConvexCaller, options: { tmp?: string } = {}): Store {
  const call: ConvexCaller = {
    query: (name, args) => caller.query(name, clean(args) as Record<string, unknown>),
    mutation: (name, args) => caller.mutation(name, clean(args) as Record<string, unknown>),
  };
  return {
    kind: "convex",
    find: (table, where = {}, { order, limit } = {}) => call.query("rows:find", { table, where, order, limit }),
    insert: (table, row, { unique } = {}) => call.mutation<boolean>("rows:insert", { table, row, unique }),
    update: (table, where, fields) => call.mutation<number>("rows:update", { table, where, fields }),
    upsert: (table, key, row) => call.mutation<void>("rows:upsert", { table, key, row }),
    remove: (table, where) => call.mutation<number>("rows:remove", { table, where }),
    logEvent: (event) => call.mutation<void>("rows:logEvent", event),
    events: (options) => call.query<EventLine[]>("rows:events", options),
    brandSnapshot: (brandId) => call.query<BrandSnapshot | null>("rows:brandSnapshot", { brand_id: brandId }),
    listSnapshot: () => call.query<ListItem[]>("rows:listSnapshot", {}),
    files: convexFiles(call, options.tmp ?? join(tmpdir(), "nomen-media")),
    lease: {
      acquire: (name, holder, ttlMs) => call.mutation<boolean>("lease:acquire", { name, holder, ttl_ms: ttlMs }),
      release: (name, holder) => call.mutation<void>("lease:release", { name, holder }),
    },
    nextTick: async (delayMs) => {
      await call.mutation("worker:continueTicking", { delay_ms: delayMs });
    },
  };
}

function convexFiles(call: ConvexCaller, root: string): Files {
  const local = (key: string) => join(root, key);
  const info = (key: string) => call.query<{ url: string | null; size: number; content_type: string } | null>("files:get", { key });
  const files: Files = {
    async putFile(key, path, contentType) {
      const body = await readFile(path);
      const uploadUrl = await call.mutation<string>("files:uploadUrl", {});
      const response = await fetch(uploadUrl, { method: "POST", headers: { "content-type": contentType }, body, signal: AbortSignal.timeout(120_000) });
      if (!response.ok) throw new Error(`upload of ${key} failed: HTTP ${response.status}`);
      const { storageId } = (await response.json()) as { storageId: string };
      await call.mutation("files:record", { key, storage_id: storageId, content_type: contentType, size: body.length });
      // Keep a copy here: the same tick usually reads it again (QC frames, the cut).
      if (path !== local(key)) {
        await mkdir(dirname(local(key)), { recursive: true });
        await copyFile(path, local(key));
      }
    },
    async saveUrl(key, url, contentType) {
      const { download } = await import("../media");
      await download(url, local(key));
      await files.putFile(key, local(key), contentType);
    },
    async exists(key) {
      return Boolean(await info(key));
    },
    async localPath(key) {
      if (existsSync(local(key))) return local(key);
      const found = await info(key);
      if (!found?.url) throw new Error(`no stored file ${key}`);
      const { download } = await import("../media");
      return download(found.url, local(key));
    },
    async url(key) {
      return (await info(key))?.url ?? null;
    },
  };
  return files;
}

export type { Row };
