// Shared plumbing for the /api/brands/[id]/brandkit routes (not a route itself).
import { BrandKitError, startCaptioning } from "@/lib/creative/brandkit";
import { NaiveClient } from "@/lib/naive";
import { loadSettings, secretStatus } from "@/lib/settings";

/** Runs a route body and answers JSON: the result, or `{ error }` with a status the panel can show. */
export async function respond(body: () => Promise<unknown>) {
  try {
    // Settings (the Naive key for captions) come from the store; on Convex they load per request.
    await loadSettings();
    return Response.json(await body(), { headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (error instanceof BrandKitError) return Response.json({ error: error.message }, { status: error.status });
    console.error("[brandkit]", error);
    return Response.json({ error: "Something went wrong with the brand kit. Try again." }, { status: 500 });
  }
}

/** Describes new images in the background when a Naive key is set; never fails the request. */
export function captionInBackground(brandId: string) {
  try {
    if (secretStatus("naive_api_key").set) startCaptioning(brandId, () => new NaiveClient());
  } catch (error) {
    console.error("[brandkit] caption pass not started", error);
  }
}
