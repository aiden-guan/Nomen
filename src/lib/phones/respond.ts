// OWNED BY THE PHONES TRACK (see docs/handoff-dylan.md). Shared plumbing for the /api/phones routes.
import { describeApiError } from "./rules";
import { PhonesError } from "./service";

/** Runs a route body and answers JSON: the result, or `{ error }` with a status the panel can show. */
export async function respond(body: () => Promise<unknown>) {
  try {
    return Response.json(await body(), { headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (error instanceof PhonesError) return Response.json({ error: error.message }, { status: error.status });
    console.error("[phones]", error);
    return Response.json({ error: describeApiError(error).message }, { status: 500 });
  }
}

export async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const body = await request.json();
    return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  } catch {
    throw new PhonesError(400, "Expected a JSON body.");
  }
}
