import { createHash } from "node:crypto";
import { convexStore, httpCaller } from "./convex";
import { sqliteStore } from "./sqlite";
import type { Store } from "./types";

export type { BrandSnapshot, EventLine, Files, ListItem, Row, Store, TableName, Where } from "./types";

declare global {
  var __nomenStore: Store | undefined;
}

/**
 * The store this process uses. Convex when NOMEN_STORE=convex, or when a Convex URL and the
 * server secret are both present (a Vercel build with Convex sets them); SQLite otherwise.
 */
export function store(): Store {
  if (!globalThis.__nomenStore) globalThis.__nomenStore = choose();
  return globalThis.__nomenStore;
}

/** Tests swap in a store (an in-memory Convex, for instance) and back. */
export function useStore(next: Store | undefined) {
  globalThis.__nomenStore = next;
}

function choose(): Store {
  const choice = process.env.NOMEN_STORE;
  const url = process.env.NEXT_PUBLIC_CONVEX_URL || process.env.CONVEX_URL;
  const secret = serverSecret();
  if (choice === "convex" || (!choice && url && secret)) {
    if (!url || !secret) throw new Error("The Convex store needs NEXT_PUBLIC_CONVEX_URL and NOMEN_SERVER_SECRET (or CONVEX_DEPLOY_KEY).");
    return convexStore(httpCaller(url, secret));
  }
  return sqliteStore();
}

/**
 * The secret the server shows Convex. Set NOMEN_SERVER_SECRET, or let it derive from the deploy
 * key, which scripts/vercel-build.sh does too when it hands the same value to Convex.
 */
export function serverSecret(): string | null {
  if (process.env.NOMEN_SERVER_SECRET) return process.env.NOMEN_SERVER_SECRET;
  const key = process.env.CONVEX_DEPLOY_KEY;
  return key ? createHash("sha256").update(`nomen-server:v1:${key}`).digest("hex") : null;
}
