import type { Metadata } from "next";
import { TroyExperience } from "@/components/troy/TroyExperience";

export const metadata: Metadata = { title: "Nomen: the camp" };

export default async function CampPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // The demo camp belongs to the demo: its links and Back lead to /demo, not the real landing.
  return <TroyExperience initialView="camp" brandId={id} demoOnly={id === "demo"} />;
}
