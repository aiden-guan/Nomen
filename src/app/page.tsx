import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { TroyExperience } from "@/components/troy/TroyExperience";
import { defaultOptions } from "@/lib/pipeline";
import { estimateUsd } from "@/lib/views";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Nomen: send in the horse",
  description: "Paste your website. An army of agents researches your market, writes the strategy, films UGC video ads and posts them.",
};

/**
 * The landing: the Trojan horse. The box starts a real campaign, which spends real credits; the
 * demo, which spends nothing, is at /demo. The brand list that used to live here is at /brands.
 * NOMEN_DEMO_ONLY=1 marks a deployment that can't run campaigns (Vercel: no lasting disk, no
 * background worker), so this page sends visitors to the demo there.
 */
export default function LandingPage() {
  if (process.env.NOMEN_DEMO_ONLY === "1") redirect("/demo");
  const options = defaultOptions();
  const estimate = estimateUsd(options);
  const cost = `${options.concepts} videos × ${options.shotsPerConcept} shots × ${options.secondsPerShot}s on ${options.videoModel}${estimate ? `, about $${estimate.toFixed(2)} of video` : ""}`;
  return <TroyExperience initialView="landing" cost={cost} />;
}
