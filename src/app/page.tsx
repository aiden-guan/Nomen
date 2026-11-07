import type { Metadata } from "next";
import { TroyExperience } from "@/components/troy/TroyExperience";

export const metadata: Metadata = {
  title: "Nomen: send in the horse",
  description: "Paste your website. An army of agents researches your market, writes the strategy, films UGC video ads and posts them.",
};

export default function LandingPage() {
  return <TroyExperience initialView="landing" />;
}
