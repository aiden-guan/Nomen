// OWNED BY THE PHONES TRACK. POST /api/phones/devices/{deviceId}/resume: wake a parked phone.
import { respond } from "@/lib/phones/respond";
import { resumeDevice } from "@/lib/phones/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(_request: Request, { params }: { params: Promise<{ deviceId: string }> }) {
  const { deviceId } = await params;
  return respond(() => resumeDevice(deviceId));
}
