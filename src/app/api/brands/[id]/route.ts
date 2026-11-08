import { handle } from "@/lib/api";
import { brandView } from "@/lib/views";

export const runtime = "nodejs";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const view = await brandView((await params).id, new URL(request.url).searchParams.get("campaign"));
    return view ? Response.json(view) : Response.json({ error: "No such brand" }, { status: 404 });
  });
}
