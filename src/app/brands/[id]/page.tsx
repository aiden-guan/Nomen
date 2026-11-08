import { notFound } from "next/navigation";
import { BrandWorkspace } from "@/components/BrandWorkspace";
import { brandView } from "@/lib/views";

export const dynamic = "force-dynamic";

export default async function BrandPage({ params }: { params: Promise<{ id: string }> }) {
  const view = await brandView((await params).id);
  if (!view) notFound();
  return <BrandWorkspace initial={view} />;
}
