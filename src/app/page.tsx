import { HomeView } from "@/components/HomeView";
import { defaultOptions } from "@/lib/pipeline";
import { brandList, estimateUsd } from "@/lib/views";

export const dynamic = "force-dynamic";

export default function HomePage() {
  const options = defaultOptions();
  const estimate = estimateUsd(options);
  const summary = `${options.concepts} videos × ${options.shotsPerConcept} shots × ${options.secondsPerShot}s on ${options.videoModel}${estimate ? `, about $${estimate.toFixed(2)} of video` : ""}`;
  return <HomeView initialBrands={brandList()} summary={summary} />;
}
