import { type GenericDatabaseReader, type GenericDataModel, mutationGeneric, queryGeneric } from "convex/server";
import { v } from "convex/values";
import { guard } from "./auth";
import { indexedEquality, isTable, matches, type Order, sortRows, TABLES, type TableName, type Where } from "./tables";

// Generic row access for the core's store (src/lib/store/convex.ts). The core keeps its own row
// shapes and ids; these functions only find, insert, update and delete rows by simple conditions.
// Tables are small (a brand has a few campaigns, a campaign a few dozen rows), so conditions an
// index can't serve are filtered in memory.

type Doc = Record<string, unknown> & { _id: string; _creationTime: number };
type Reader = GenericDatabaseReader<GenericDataModel>;

function table(name: string): TableName {
  if (!isTable(name)) throw new Error(`Unknown table ${name}`);
  return name;
}

async function select(db: Reader, name: TableName, where: Where): Promise<Doc[]> {
  const lookup = indexedEquality(name, where);
  const docs = (
    lookup ? await db.query(name).withIndex(lookup[1], (q) => q.eq(lookup[0], lookup[2])).collect() : await db.query(name).collect()
  ) as unknown as Doc[];
  return docs.filter((doc) => matches(doc, where));
}

const plain = (doc: Doc) => {
  const { _id, _creationTime, ...row } = doc;
  void _id;
  void _creationTime;
  return row;
};

const sorted = (docs: Doc[], order?: Order) => sortRows(docs, order, (doc) => doc._creationTime);

/** Drops undefined values, which Convex would read as "remove this column". */
const defined = (fields: Record<string, unknown>) => Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));

export const find = queryGeneric({
  args: { secret: v.string(), table: v.string(), where: v.optional(v.any()), order: v.optional(v.any()), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    guard(args.secret);
    const rows = sorted(await select(ctx.db, table(args.table), (args.where ?? {}) as Where), args.order as Order | undefined);
    return (args.limit ? rows.slice(0, args.limit) : rows).map(plain);
  },
});

/** Inserts a row with the table's defaults. With `unique`, does nothing if a row already matches those columns. */
export const insert = mutationGeneric({
  args: { secret: v.string(), table: v.string(), row: v.any(), unique: v.optional(v.array(v.string())) },
  handler: async (ctx, args) => {
    guard(args.secret);
    const name = table(args.table);
    const spec = TABLES[name];
    const row = { ...spec.defaults, ...defined(args.row as Record<string, unknown>) };
    for (const column of spec.required) if (row[column] === undefined) throw new Error(`${name}.${column} is required`);
    if (args.unique?.length) {
      const where = Object.fromEntries(args.unique.map((column) => [column, (row[column] ?? null) as string | number | null]));
      if ((await select(ctx.db, name, where)).length) return false;
    }
    await ctx.db.insert(name, row);
    return true;
  },
});

/** Updates every row that matches, stamping updated_at. Returns how many changed. */
export const update = mutationGeneric({
  args: { secret: v.string(), table: v.string(), where: v.any(), fields: v.any() },
  handler: async (ctx, args) => {
    guard(args.secret);
    const name = table(args.table);
    const fields = defined(args.fields as Record<string, unknown>);
    if (TABLES[name].stamped && fields.updated_at === undefined) fields.updated_at = new Date().toISOString();
    const docs = await select(ctx.db, name, args.where as Where);
    for (const doc of docs) await ctx.db.patch(doc._id as never, fields);
    return docs.length;
  },
});

/** Inserts the row, or updates the row that matches its `key` columns. */
export const upsert = mutationGeneric({
  args: { secret: v.string(), table: v.string(), key: v.array(v.string()), row: v.any() },
  handler: async (ctx, args) => {
    guard(args.secret);
    const name = table(args.table);
    const row = defined(args.row as Record<string, unknown>);
    const where = Object.fromEntries(args.key.map((column) => [column, (row[column] ?? null) as string | number | null]));
    const [existing] = await select(ctx.db, name, where);
    if (existing) await ctx.db.patch(existing._id as never, row);
    else await ctx.db.insert(name, { ...TABLES[name].defaults, ...row });
  },
});

export const remove = mutationGeneric({
  args: { secret: v.string(), table: v.string(), where: v.any() },
  handler: async (ctx, args) => {
    guard(args.secret);
    const docs = await select(ctx.db, table(args.table), args.where as Where);
    for (const doc of docs) await ctx.db.delete(doc._id as never);
    return docs.length;
  },
});

// --- Events ------------------------------------------------------------------------------------

export const logEvent = mutationGeneric({
  args: { secret: v.string(), brand_id: v.union(v.string(), v.null()), campaign_id: v.union(v.string(), v.null()), ts: v.string(), level: v.string(), message: v.string() },
  handler: async (ctx, { secret, ...event }) => {
    guard(secret);
    await ctx.db.insert("events", event);
  },
});

/** A brand's (or a campaign's) event lines, newest first. */
export const events = queryGeneric({
  args: { secret: v.string(), brand_id: v.optional(v.string()), campaign_id: v.optional(v.string()), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    guard(args.secret);
    const query = args.campaign_id
      ? ctx.db.query("events").withIndex("by_campaign", (q) => q.eq("campaign_id", args.campaign_id!))
      : ctx.db.query("events").withIndex("by_brand", (q) => q.eq("brand_id", args.brand_id ?? null));
    const docs = (await query.order("desc").take(args.limit ?? 60)) as unknown as Doc[];
    return docs.map((doc) => ({ ts: doc.ts, level: doc.level, message: doc.message }));
  },
});

// --- Snapshots: the camp polls these every few seconds, so each is one round trip. --------------

/** Everything a brand's view needs: the brand, its campaigns, and the latest one's rows. */
export const brandSnapshot = queryGeneric({
  args: { secret: v.string(), brand_id: v.string(), events: v.optional(v.number()) },
  handler: async (ctx, args) => {
    guard(args.secret);
    const [brand] = await select(ctx.db, "brands", { id: args.brand_id });
    if (!brand) return null;
    const campaigns = sorted(await select(ctx.db, "campaigns", { brand_id: args.brand_id }), [["created_at", "desc"]]);
    const latest = campaigns[0];
    const runs = latest ? sorted(await select(ctx.db, "monid_runs", { campaign_id: latest.id as string }), [["created_at", "asc"]]) : [];
    const creatives = latest ? sorted(await select(ctx.db, "creatives", { campaign_id: latest.id as string }), [["idx", "asc"], ["generation", "asc"]]) : [];
    const posts: Doc[] = [];
    for (const creative of creatives) posts.push(...(await select(ctx.db, "posts", { creative_id: creative.id as string })));
    const events = (await ctx.db
      .query("events")
      .withIndex("by_brand", (q) => q.eq("brand_id", args.brand_id))
      .order("desc")
      .take(args.events ?? 60)) as unknown as Doc[];
    return {
      brand: plain(brand),
      campaigns: campaigns.map(plain),
      runs: runs.map(plain),
      creatives: creatives.map(plain),
      posts: sorted(posts, [["created_at", "asc"]]).map(plain),
      events: events.map((doc) => ({ ts: doc.ts, level: doc.level, message: doc.message })),
    };
  },
});

/** Every brand, newest activity first, with its latest campaign and that campaign's videos. */
export const listSnapshot = queryGeneric({
  args: { secret: v.string() },
  handler: async (ctx, args) => {
    guard(args.secret);
    const brands = sorted(await select(ctx.db, "brands", {}), [["updated_at", "desc"]]);
    const out = [];
    for (const brand of brands) {
      const [campaign] = sorted(await select(ctx.db, "campaigns", { brand_id: brand.id as string }), [["created_at", "desc"]]);
      const creatives = campaign ? sorted(await select(ctx.db, "creatives", { campaign_id: campaign.id as string }), [["idx", "asc"], ["generation", "asc"]]) : [];
      out.push({ brand: plain(brand), campaign: campaign ? plain(campaign) : null, creatives: creatives.map(plain) });
    }
    return out;
  },
});
