import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { TroyExperience } from "@/components/troy/TroyExperience";
import { defaultOptions } from "@/lib/pipeline";
import { liveEnabled } from "@/lib/live";
import { loadSettings } from "@/lib/settings";
import { estimateUsd } from "@/lib/views";

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
  await loadSettings();
  const options = defaultOptions();
  const estimate = estimateUsd(options);
  const cost = `${options.concepts} videos × ${options.shotsPerConcept} shots × ${options.secondsPerShot}s on ${options.videoModel}${estimate ? `, about $${estimate.toFixed(2)} of video` : ""}`;
  return <TroyExperience initialView="landing" cost={cost} />;
}
