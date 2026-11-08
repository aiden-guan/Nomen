import type { Metadata } from "next";
import { TroyExperience } from "@/components/troy/TroyExperience";

export const metadata: Metadata = {
  title: "Nomen demo: send in the horse",
  description: "A finished campaign replayed from the website to posted videos, in about two minutes. Nothing is spent.",
};

/**
 * The demo: the same horse and camp, but the box marches into a replayed campaign (the
 * recording for the typed website, if one is installed) instead of starting a real one.
 */
export default function DemoPage() {
  return <TroyExperience initialView="landing" demoOnly />;
}
