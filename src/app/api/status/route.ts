import { handle } from "@/lib/api";
import { ffmpegPath } from "@/lib/media";
import { MonidClient } from "@/lib/monid";
import { NaiveClient } from "@/lib/naive";
import { getSetting, secretStatus } from "@/lib/settings";

export const runtime = "nodejs";

type Status = {
  naive: { ok: boolean; organization?: string; balanceUsd?: number; strategist?: boolean; error?: string };
  monid: { ok: boolean; balanceUsd?: number; error?: string };
  mobilerun: { configured: boolean };
  ffmpeg: boolean;
};

let cached: { at: number; status: Status } | null = null;

export async function GET(request: Request) {
  return handle(async () => {
    const fresh = new URL(request.url).searchParams.has("fresh");
    if (!fresh && cached && Date.now() - cached.at < 20_000) return Response.json(cached.status);
    const [naive, monid, ffmpeg] = await Promise.all([naiveStatus(), monidStatus(), ffmpegPath()]);
    const status: Status = { naive, monid, mobilerun: { configured: secretStatus("mobilerun_api_key").set }, ffmpeg: Boolean(ffmpeg) };
    cached = { at: Date.now(), status };
    return Response.json(status);
  });
}

async function naiveStatus(): Promise<Status["naive"]> {
  try {
    const naive = new NaiveClient();
    const [me, balance, agent] = await Promise.all([naive.me(), naive.balance().catch(() => null), naive.findAgent(getSetting("strategist_agent")).catch(() => undefined)]);
    return { ok: true, organization: me.organization?.name, balanceUsd: balance ? balance.balance_micro_usd / 1_000_000 : undefined, strategist: Boolean(agent) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function monidStatus(): Promise<Status["monid"]> {
  try {
    return { ok: true, balanceUsd: await new MonidClient().balanceUsd() };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
