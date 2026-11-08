/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type { ApiFromModules, FilterApi, FunctionReference } from "convex/server";
import type * as auth from "../auth.js";
import type * as crons from "../crons.js";
import type * as files from "../files.js";
import type * as lease from "../lease.js";
import type * as rows from "../rows.js";
import type * as tables from "../tables.js";
import type * as worker from "../worker.js";

/**
 * A utility for referencing Convex functions in your app's API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
declare const fullApi: ApiFromModules<{
  "auth": typeof auth,
"crons": typeof crons,
"files": typeof files,
"lease": typeof lease,
"rows": typeof rows,
"tables": typeof tables,
"worker": typeof worker,
}>;
export declare const api: FilterApi<typeof fullApi, FunctionReference<any, "public">>;
export declare const internal: FilterApi<typeof fullApi, FunctionReference<any, "internal">>;
