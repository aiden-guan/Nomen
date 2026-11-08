import { ApiError } from "./http";
import { loadSettings } from "./settings";
import { startWorker } from "./worker";

/** Wraps a route handler: starts the worker if needed, loads settings and turns any error into a JSON message. */
export async function handle(fn: () => Promise<Response> | Response): Promise<Response> {
  startWorker();
  try {
    await loadSettings();
    return await fn();
  } catch (error) {
    const status = error instanceof ApiError ? (error.status >= 400 && error.status < 600 ? error.status : 502) : 400;
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status });
  }
}

export async function body<T>(request: Request): Promise<Partial<T>> {
  try {
    return (await request.json()) as Partial<T>;
  } catch {
    return {};
  }
}
