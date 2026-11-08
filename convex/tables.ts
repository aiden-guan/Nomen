// The core's tables, as Convex sees them. Rows keep the core's own shape (snake_case columns, JSON
// stored as strings, 0/1 flags, string ids like "brd_…"), so the same code reads them whether the
// store is SQLite (local development) or Convex (deployments). See src/lib/store/.

export type TableName = "settings" | "brands" | "campaigns" | "monid_runs" | "creatives" | "posts" | "events";

type Spec = {
  /** The column rows are looked up by. */
  key: string;
  /** Columns with an index, for equality lookups. */
  indexed: Record<string, string>;
  /** Values for columns an insert leaves out, as the SQL schema's defaults. */
  defaults: Record<string, string | number | null>;
  /** Columns an insert must give. */
  required: string[];
  /** Whether rows carry updated_at. */
  stamped: boolean;
};

const nulls = (...columns: string[]) => Object.fromEntries(columns.map((c) => [c, null]));

export const TABLES: Record<TableName, Spec> = {
  settings: { key: "key", indexed: { key: "by_key" }, defaults: {}, required: ["key", "value"], stamped: false },
  brands: {
    key: "id",
    indexed: { id: "by_row_id", domain: "by_domain" },
    defaults: { ...nulls("profile_json", "identity_id"), social_activated: 0 },
    required: ["id", "name", "domain", "url", "created_at", "updated_at"],
    stamped: true,
  },
  campaigns: {
    key: "id",
    indexed: { id: "by_row_id", brand_id: "by_brand", status: "by_status" },
    defaults: {
      ...nulls("error", "plan_json", "research_json", "style_build_id", "style_idem", "style_json", "style_started_at", "strategy_idem", "strategy_session_id", "strategy_json"),
      attempts: 0,
      style_attempt: 0,
      strategy_nudges: 0,
      naive_out: 0,
      style_spend_micro: 0,
      strategy_spend_micro: 0,
      naive_spend_micro: 0,
      monid_spend_micro: 0,
    },
    required: ["id", "brand_id", "status", "stage", "options_json", "created_at", "updated_at"],
    stamped: true,
  },
  monid_runs: {
    key: "id",
    indexed: { id: "by_row_id", campaign_id: "by_campaign" },
    defaults: { ...nulls("run_id", "output_json", "error"), cost_micro: 0 },
    required: ["id", "campaign_id", "key", "phase", "provider", "endpoint", "input_json", "status", "created_at", "updated_at"],
    stamped: true,
  },
  creatives: {
    key: "id",
    indexed: { id: "by_row_id", campaign_id: "by_campaign" },
    defaults: {
      ...nulls("final_file_id", "final_url", "final_url_expires_at", "final_external_url", "final_key", "poster_url", "qc_score", "continuity_json", "error"),
      generation: 1,
      approved: 0,
      rejected: 0,
      cost_micro: 0,
    },
    required: ["id", "campaign_id", "idx", "concept_json", "shots_json", "status", "caption", "platforms_json", "created_at", "updated_at"],
    stamped: true,
  },
  posts: {
    key: "id",
    indexed: { id: "by_row_id", creative_id: "by_creative", brand_id: "by_brand", status: "by_status" },
    defaults: nulls("naive_post_id", "scheduled_at", "result_json", "analytics_json", "analytics_at", "error"),
    required: ["id", "creative_id", "brand_id", "idem", "platforms_json", "status", "created_at", "updated_at"],
    stamped: true,
  },
  events: {
    key: "id",
    indexed: { brand_id: "by_brand", campaign_id: "by_campaign" },
    defaults: nulls("brand_id", "campaign_id"),
    required: ["ts", "level", "message"],
    stamped: false,
  },
};

export const isTable = (name: string): name is TableName => Object.hasOwn(TABLES, name);

export type Scalar = string | number | null;
/** Equality, or one of: { in: [...] }, { ne }, { lt }, { lte }, { gt }, { gte }. */
export type Condition = Scalar | { in: Scalar[] } | { ne: Scalar } | { lt: Scalar } | { lte: Scalar } | { gt: Scalar } | { gte: Scalar };
export type Where = Record<string, Condition>;
export type Order = Array<[column: string, direction: "asc" | "desc"]>;

const isScalar = (value: unknown): value is Scalar => value === null || typeof value === "string" || typeof value === "number";

export function matches(row: Record<string, unknown>, where: Where): boolean {
  return Object.entries(where).every(([column, condition]) => {
    const value = (row[column] ?? null) as Scalar;
    if (isScalar(condition)) return value === condition;
    if ("in" in condition) return condition.in.includes(value);
    if ("ne" in condition) return value !== condition.ne;
    if (value === null) return false;
    if ("lt" in condition) return condition.lt !== null && value < condition.lt;
    if ("lte" in condition) return condition.lte !== null && value <= condition.lte;
    if ("gt" in condition) return condition.gt !== null && value > condition.gt;
    if ("gte" in condition) return condition.gte !== null && value >= condition.gte;
    return false;
  });
}

/** The equality column to look rows up by, if one of the conditions has an index. */
export function indexedEquality(table: TableName, where: Where): [column: string, index: string, value: Scalar] | null {
  for (const [column, condition] of Object.entries(where)) {
    const index = TABLES[table].indexed[column];
    if (index && isScalar(condition)) return [column, index, condition];
  }
  return null;
}

/** Sorts in place by the given columns; ties keep insertion order (like SQLite's rowid). */
export function sortRows<T extends Record<string, unknown>>(rows: T[], order: Order | undefined, inserted: (row: T) => number): T[] {
  const keys = order ?? [];
  return rows.sort((a, b) => {
    for (const [column, direction] of keys) {
      const x = (a[column] ?? null) as Scalar;
      const y = (b[column] ?? null) as Scalar;
      if (x === y) continue;
      // SQLite sorts NULL first ascending.
      const less = x === null ? true : y === null ? false : x < y;
      return (less ? -1 : 1) * (direction === "desc" ? -1 : 1);
    }
    const tie = inserted(a) - inserted(b);
    return keys[0]?.[1] === "desc" ? -tie : tie;
  });
}
