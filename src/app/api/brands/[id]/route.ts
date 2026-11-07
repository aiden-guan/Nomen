import { handle } from "@/lib/api";
import { brandView } from "@/lib/views";

export const runtime = "nodejs";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const view = brandView((await params).id);
    return view ? Response.json(view) : Response.json({ error: "No such brand" }, { status: 404 });
  });
}
