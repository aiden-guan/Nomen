// GET    /api/brands/:id/brandkit               the brand kit: assets, repo scan, `captioning`
// POST   /api/brands/:id/brandkit               multipart/form-data, one or more `files` entries (a folder
//                                               upload's relative path is the file name) -> the kit + `added`, `skipped`
// DELETE /api/brands/:id/brandkit?asset=<id>    removes one asset -> the kit
import { BrandKitError, MAX_ASSETS, addUploadedFiles, brandKitView, removeAsset, requireBrand, tooBigReason, MAX_FILE_BYTES, type SkippedFile } from "@/lib/creative/brandkit";
import { captionInBackground, respond } from "./respond";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Params) {
  return respond(async () => {
    const { id } = await params;
    requireBrand(id);
    return brandKitView(id);
  });
}

export async function POST(request: Request, { params }: Params) {
  return respond(async () => {
    const { id } = await params;
    requireBrand(id);
    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      throw new BrandKitError(400, "Expected multipart/form-data with one or more files.");
    }
    const entries = form.getAll("files").filter((entry): entry is File => typeof entry !== "string");
    if (!entries.length) throw new BrandKitError(400, "No files were sent.");
    if (entries.length > MAX_ASSETS) throw new BrandKitError(400, `Send at most ${MAX_ASSETS} files at a time.`);
    const files: Array<{ name: string; bytes: Buffer }> = [];
    const skipped: SkippedFile[] = [];
    for (const entry of entries) {
      // Refuse an oversized file before reading it into memory.
      if (entry.size > MAX_FILE_BYTES) skipped.push({ name: entry.name.slice(0, 200), reason: tooBigReason(entry.size) });
      else files.push({ name: entry.name, bytes: Buffer.from(await entry.arrayBuffer()) });
    }
    const result = await addUploadedFiles(id, files);
    if (result.added.length) captionInBackground(id);
    return { ...brandKitView(id), added: result.added.map((asset) => asset.id), skipped: [...skipped, ...result.skipped] };
  });
}

export async function DELETE(request: Request, { params }: Params) {
  return respond(async () => {
    const { id } = await params;
    requireBrand(id);
    const asset = new URL(request.url).searchParams.get("asset") ?? "";
    await removeAsset(id, asset);
    return brandKitView(id);
  });
}
