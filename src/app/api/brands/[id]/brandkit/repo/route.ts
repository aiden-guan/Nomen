// POST   /api/brands/:id/brandkit/repo { source }   reads a public GitHub/GitLab repo or a local folder
//                                                  (never runs its code; can take a minute or two) -> the kit
// DELETE /api/brands/:id/brandkit/repo              forgets the scan and the assets it copied in -> the kit
import { BrandKitError, brandKitView, forgetRepo, requireBrand, scanRepo } from "@/lib/creative/brandkit";
import { captionInBackground, respond } from "../respond";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

type Params = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: Params) {
  return respond(async () => {
    const { id } = await params;
    requireBrand(id);
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      throw new BrandKitError(400, "Expected a JSON body: { source }.");
    }
    const source = body && typeof body === "object" ? (body as { source?: unknown }).source : undefined;
    if (typeof source !== "string" || !source.trim()) throw new BrandKitError(400, "Paste a GitHub or GitLab link, or a folder path on this machine.");
    const kit = await scanRepo(id, source);
    if (kit.assets.some((asset) => asset.source.startsWith("repo:"))) captionInBackground(id);
    return brandKitView(id);
  });
}

export async function DELETE(_request: Request, { params }: Params) {
  return respond(async () => {
    const { id } = await params;
    requireBrand(id);
    await forgetRepo(id);
    return brandKitView(id);
  });
}
