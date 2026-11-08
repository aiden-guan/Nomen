import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { TroyExperience } from "@/components/troy/TroyExperience";
import { liveEnabled } from "@/lib/live";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Nomen: send in the horse",
  description: "Paste your website. An army of agents researches your market, writes the strategy, films UGC video ads and posts them.",
};

/**
 * The landing: the Trojan horse. The box starts a real campaign, which spends real credits; the
 * demo, which spends nothing, is at /demo. The brand list that used to live here is at /brands.
 * Where real campaigns can't run yet (Vercel before Convex is connected; see src/lib/live.ts), this
 * page sends visitors to the demo instead.
 */
export default async function LandingPage() {
  if (!liveEnabled()) redirect("/demo");
  return <TroyExperience initialView="landing" />;
}
