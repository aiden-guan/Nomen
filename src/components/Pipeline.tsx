import type { CampaignView } from "@/lib/views";
import { cx, Spinner } from "./ui";

const STEPS = [
  { key: "research", label: "Research", hint: "Monid: site, competitors, SEO, top videos, ads, AI answers" },
  { key: "style", label: "Format study", hint: "Top videos read frame by frame" },
  { key: "strategy", label: "Strategy", hint: "Brief, search plan and concepts" },
  { key: "production", label: "Production", hint: "First frames, renders, QC, editing" },
  { key: "review", label: "Review", hint: "You approve what goes out" },
  { key: "live", label: "Live", hint: "Posted to the brand's accounts" },
] as const;

export function Pipeline({ campaign }: { campaign: CampaignView }) {
  const current = campaign.stageIndex;
  const failed = campaign.status === "failed";
  return (
    <ol className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
      {STEPS.map((step, i) => {
        const done = i < current || (campaign.status === "live" && i === current);
        const active = i === current && !done;
        return (
          <li
            key={step.key}
            className={cx(
              "rounded-xl border px-3 py-2.5 transition",
              done && "border-emerald-500/20 bg-emerald-500/[0.06]",
              active && !failed && "border-violet-400/40 bg-violet-500/[0.08] shadow-[0_0_30px_-10px] shadow-violet-500/40",
              active && failed && "border-rose-500/40 bg-rose-500/[0.08]",
              !done && !active && "border-white/5 bg-white/[0.02]",
            )}
          >
            <div className="flex items-center gap-2 text-xs font-medium">
              <span
                className={cx(
                  "grid size-5 place-items-center rounded-full text-[10px]",
                  done ? "bg-emerald-500/20 text-emerald-300" : active ? (failed ? "bg-rose-500/20 text-rose-300" : "bg-violet-500/20 text-violet-200") : "bg-white/5 text-zinc-500",
                )}
              >
                {done ? "✓" : active && !failed && campaign.status === "running" ? <Spinner className="size-3" /> : i + 1}
              </span>
              <span className={done || active ? "text-zinc-100" : "text-zinc-500"}>{step.label}</span>
            </div>
            <p className="mt-1 hidden text-[11px] leading-snug text-zinc-500 sm:block">{step.hint}</p>
          </li>
        );
      })}
    </ol>
  );
}
