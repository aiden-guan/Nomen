import { body, handle } from "@/lib/api";
import { db, update } from "@/lib/db";
import { regenerateCreative } from "@/lib/pipeline";
import { tick } from "@/lib/worker";

export const runtime = "nodejs";

const exists = (id: string) => Boolean(db().prepare("select 1 from creatives where id = ?").get(id));

/** Edit the caption, or approve / unapprove a finished video. */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const id = (await params).id;
    if (!exists(id)) return Response.json({ error: "No such video" }, { status: 404 });
    const { caption, approved } = await body<{ caption: string; approved: boolean }>(request);
    const fields: Record<string, unknown> = {};
    if (typeof caption === "string") fields.caption = caption.slice(0, 2200);
    if (typeof approved === "boolean") fields.approved = approved;
    update("creatives", id, fields);
    return Response.json({ ok: true });
  });
}

/** Re-render a video, optionally with a director's note. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const id = (await params).id;
    if (!exists(id)) return Response.json({ error: "No such video" }, { status: 404 });
    const { note } = await body<{ note: string }>(request);
    const newId = regenerateCreative(id, typeof note === "string" ? note.slice(0, 500) : undefined);
    void tick();
    return Response.json({ id: newId }, { status: 201 });
  });
}
