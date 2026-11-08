// OWNED BY THE PHONES TRACK. POST /api/phones/sessions/{sessionId}/cancel: stop a queued or running warm-up.
import { respond } from "@/lib/phones/respond";
import { cancelSession } from "@/lib/phones/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(_request: Request, { params }: { params: Promise<{ sessionId: string }> }) {
  const { sessionId } = await params;
  return respond(() => cancelSession(sessionId));
}
