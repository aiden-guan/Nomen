import type { Order, TableName, Where } from "../../../convex/tables";

export type { Order, TableName, Where } from "../../../convex/tables";

export type Row = Record<string, unknown>;
export type EventLine = { ts: string; level: string; message: string };

/** What a brand's page needs, in one read: the brand, its campaigns and the latest one's rows. */
export type BrandSnapshot = { brand: Row; campaigns: Row[]; runs: Row[]; creatives: Row[]; posts: Row[]; events: EventLine[] };
export type ListItem = { brand: Row; campaign: Row | null; creatives: Row[] };

/**
 * Where the core keeps its rows. SQLite on a machine with a disk (local development, tests);
 * Convex on serverless hosts. Rows keep the core's shapes either way (see convex/tables.ts).
 */
export interface Store {
  readonly kind: "sqlite" | "convex";
  find<T = Row>(table: TableName, where?: Where, options?: { order?: Order; limit?: number }): Promise<T[]>;
  /** Inserts with the table's defaults. With `unique`, returns false and does nothing if a row matches those columns. */
  insert(table: TableName, row: Row, options?: { unique?: string[] }): Promise<boolean>;
  /** Updates matching rows (stamping updated_at where the table has it); returns how many. */
  update(table: TableName, where: Where, fields: Row): Promise<number>;
  upsert(table: TableName, key: string[], row: Row): Promise<void>;
  remove(table: TableName, where: Where): Promise<number>;
  logEvent(event: { brand_id: string | null; campaign_id: string | null; ts: string; level: string; message: string }): Promise<void>;
  /** Newest first. */
  events(options: { brand_id?: string; campaign_id?: string; limit?: number }): Promise<EventLine[]>;
  brandSnapshot(brandId: string): Promise<BrandSnapshot | null>;
  listSnapshot(): Promise<ListItem[]>;
  files: Files;
  /** One worker tick at a time, across every instance of the app. */
  lease: { acquire(name: string, holder: string, ttlMs: number): Promise<boolean>; release(name: string, holder: string): Promise<void> };
  /**
   * Called after each tick: on a serverless host, asks for another tick in `delayMs` while a
   * campaign is still in flight (convex/worker.ts). A process that stays up ticks on its own.
   */
  nextTick(delayMs: number): Promise<void>;
}

/**
 * Media by key ("crv_…/final.mp4"). Local: data/media/<key>. Convex: file storage, with copies in
 * the temp folder while ffmpeg works on them.
 */
export interface Files {
  /** Saves a local file under the key. */
  putFile(key: string, path: string, contentType: string): Promise<void>;
  /** Downloads a URL and saves it under the key. */
  saveUrl(key: string, url: string, contentType: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  /** A local path to read the file from (downloaded to the temp folder when stored remotely). */
  localPath(key: string): Promise<string>;
  /** Where a browser can fetch it: a path on this app (local) or a storage URL (Convex). */
  url(key: string): Promise<string | null>;
}
