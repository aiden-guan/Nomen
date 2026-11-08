import type { Metadata } from "next";
import { TroyExperience } from "@/components/troy/TroyExperience";
import { defaultOptions } from "@/lib/pipeline";
import { estimateUsd } from "@/lib/views";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Nomen: send in the horse",
  description: "Paste your website. An army of agents researches your market, writes the strategy, films UGC video ads and posts them.",
};

/**
 * The landing: the Trojan horse. The brand list that used to live here is at /brands.
 * NOMEN_DEMO_ONLY=1 (demo deployments, where campaigns can't run) sends the horse's column into
 * the demo camp instead of starting a campaign.
 */
export default function LandingPage() {
  if (process.env.NOMEN_DEMO_ONLY === "1") return <TroyExperience initialView="landing" demoOnly />;
  const options = defaultOptions();
  const estimate = estimateUsd(options);
  const cost = `${options.concepts} videos × ${options.shotsPerConcept} shots × ${options.secondsPerShot}s on ${options.videoModel}${estimate ? `, about $${estimate.toFixed(2)} of video` : ""}`;
  return <TroyExperience initialView="landing" cost={cost} />;
}
