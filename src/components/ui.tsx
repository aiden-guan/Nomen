import type { ButtonHTMLAttributes, ReactNode } from "react";

// Nomen's UI kit. The props below are a stable contract: other tracks import these components.

const cx = (...classes: Array<string | false | null | undefined>) => classes.filter(Boolean).join(" ");

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "sm" | "md" | "lg";
  loading?: boolean;
};

export function Button({ variant = "secondary", size = "md", loading = false, className, children, disabled, ...rest }: ButtonProps) {
  return (
    <button
      {...rest}
      disabled={disabled || loading}
      className={cx(
        "inline-flex items-center justify-center gap-2 rounded-xl font-medium transition disabled:cursor-not-allowed disabled:opacity-50",
        size === "sm" && "h-8 px-3 text-xs",
        size === "md" && "h-10 px-4 text-sm",
        size === "lg" && "h-12 px-6 text-base",
        variant === "primary" && "bg-gradient-to-r from-violet-500 to-fuchsia-500 text-white shadow-lg shadow-violet-500/20 hover:brightness-110",
        variant === "secondary" && "border border-white/10 bg-white/[0.06] text-zinc-100 hover:bg-white/[0.1]",
        variant === "ghost" && "text-zinc-300 hover:bg-white/[0.06] hover:text-white",
        variant === "danger" && "border border-rose-500/30 bg-rose-500/10 text-rose-200 hover:bg-rose-500/20",
        className,
      )}
    >
      {loading && <Spinner />}
      {children}
    </button>
  );
}

export function Card({ title, subtitle, action, children, className }: { title?: ReactNode; subtitle?: ReactNode; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cx("rounded-2xl border border-white/10 bg-white/[0.03] p-5", className)}>
      {(title || action) && (
        <header className="mb-4 flex items-start justify-between gap-4">
          <div>
            {title && <h2 className="text-sm font-semibold tracking-tight text-zinc-100">{title}</h2>}
            {subtitle && <p className="mt-1 text-xs text-zinc-400">{subtitle}</p>}
          </div>
          {action}
        </header>
      )}
      {children}
    </section>
  );
}

const tones = {
  neutral: "bg-white/[0.06] text-zinc-300 ring-white/10",
  good: "bg-emerald-500/10 text-emerald-300 ring-emerald-500/20",
  warn: "bg-amber-500/10 text-amber-300 ring-amber-500/20",
  bad: "bg-rose-500/10 text-rose-300 ring-rose-500/20",
  info: "bg-sky-500/10 text-sky-300 ring-sky-500/20",
  accent: "bg-violet-500/10 text-violet-300 ring-violet-500/20",
} as const;

export function Badge({ tone = "neutral", children, className }: { tone?: keyof typeof tones; children: ReactNode; className?: string }) {
  return <span className={cx("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset", tones[tone], className)}>{children}</span>;
}

export function Spinner({ className }: { className?: string }) {
  return <span className={cx("inline-block size-3.5 animate-spin rounded-full border-2 border-current border-r-transparent", className)} aria-hidden />;
}

export function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: ReactNode }) {
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.02] px-4 py-3">
      <div className="text-[11px] uppercase tracking-wider text-zinc-500">{label}</div>
      <div className="mt-1 text-lg font-semibold tabular-nums text-zinc-100">{value}</div>
      {hint && <div className="mt-0.5 text-xs text-zinc-500">{hint}</div>}
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-2xl border border-dashed border-white/10 px-6 py-10 text-center">
      <div className="text-sm font-medium text-zinc-200">{title}</div>
      {children && <div className="mx-auto mt-2 max-w-md text-sm text-zinc-400">{children}</div>}
    </div>
  );
}

export { cx };
