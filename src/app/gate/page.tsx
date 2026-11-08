import type { Metadata } from "next";
import { GateForm } from "./GateForm";
import { safeNext } from "./token";

export const metadata: Metadata = { title: "Nomen", robots: { index: false, follow: false } };

export default async function GatePage({ searchParams }: { searchParams: Promise<{ next?: string | string[] }> }) {
  const { next } = await searchParams;
  return <GateForm next={safeNext(Array.isArray(next) ? next[0] : next)} />;
}
