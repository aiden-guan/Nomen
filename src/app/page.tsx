import { HomeView } from "@/components/HomeView";
import { brandList } from "@/lib/views";

export const dynamic = "force-dynamic";

export default function HomePage() {
  return <HomeView initialBrands={brandList()} />;
}
