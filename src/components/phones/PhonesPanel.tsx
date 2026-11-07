"use client";

// OWNED BY THE PHONES TRACK (see docs/handoff-dylan.md). The brand page renders <PhonesPanel /> with
// these props and nothing else, so the panel's internals can change freely.

export type PhonesPanelProps = {
  brandId: string;
  brandName: string;
  /** Topics the brand's audience follows, from the campaign strategy; empty before the first strategy. */
  niche: string[];
};

export function PhonesPanel({ brandName }: PhonesPanelProps) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-6 text-sm text-zinc-400">
      Phone warm-up for {brandName}&apos;s own accounts is being built. It will run Mobilerun sessions that browse the brand&apos;s niche from its official accounts before
      posting starts.
    </div>
  );
}
