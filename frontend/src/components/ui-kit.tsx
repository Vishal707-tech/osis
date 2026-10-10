import { useEffect, type ReactNode } from "react";

export function Panel({
  title,
  badge,
  action,
  children,
  className = "",
}: {
  title?: string;
  badge?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`rounded-md border border-border bg-card ${className}`}>
      {title && (
        <header className="flex items-center justify-between gap-3 border-b border-border px-5 py-3">
          <div className="flex items-center gap-2.5">
            <div className="w-0.5 h-4 rounded-full bg-[var(--primary)]" />
            <h2 className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground font-mono">
              {title}
            </h2>
            {badge}
          </div>
          {action}
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

export function Stat({
  label,
  value,
  hint,
  highlight,
}: {
  label: string;
  value: ReactNode;
  hint?: string;
  highlight?: "cyan" | "amber" | "emerald" | "rose" | undefined;
}) {
  const borderClass =
    highlight === "cyan"
      ? "border-[var(--accent-blue)]"
      : highlight === "amber"
        ? "border-amber-400"
        : highlight === "emerald"
          ? "border-emerald-400"
          : highlight === "rose"
            ? "border-rose-400"
            : "border-border";

  const highlightClass =
    highlight === "cyan"
      ? "text-[var(--accent-blue)] font-semibold"
      : highlight === "amber"
        ? "text-amber-400 font-semibold"
        : highlight === "emerald"
          ? "text-emerald-400 font-semibold"
          : highlight === "rose"
            ? "text-rose-400 font-semibold"
            : "text-foreground font-medium";

  return (
    <div className={`border-l-2 ${borderClass} pl-3.5 py-1 space-y-0.5`}>
      <div className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground font-mono">
        {label}
      </div>
      <div className={`text-xl tabular-nums font-mono ${highlightClass}`}>{value}</div>
      {hint && <div className="text-[11px] text-muted-foreground">{hint}</div>}
    </div>
  );
}

export function Meter({
  label,
  value,
  max = 100,
  tone,
}: {
  label: string;
  value: number;
  max?: number;
  tone?: "cyan" | "amber" | "emerald" | "rose";
}) {
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  const barColor =
    tone === "amber"
      ? "bg-amber-400"
      : tone === "emerald"
        ? "bg-emerald-400"
        : tone === "rose"
          ? "bg-rose-500"
          : "bg-[var(--accent-blue)]";

  return (
    <div>
      <div className="flex items-baseline justify-between text-[11px]">
        <span className="uppercase tracking-[0.12em] text-muted-foreground font-mono">{label}</span>
        <span className="tabular-nums font-mono text-foreground font-medium">
          {Math.round(value)}%
        </span>
      </div>
      <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-secondary">
        <div
          className={`h-full rounded-full ${barColor} transition-[width] duration-300 ease-out`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

export function StatusDot({ label }: { label: string }) {
  const upper = label.toUpperCase();
  let textClass = "text-muted-foreground border-border bg-secondary/60";
  let dotBg = "bg-muted-foreground";

  if (
    upper.includes("SPILL_DETECTED") ||
    upper.includes("ALERT") ||
    upper.includes("DISCONTINUITY")
  ) {
    textClass = "text-rose-400 border-rose-500/40 bg-rose-500/10";
    dotBg = "bg-rose-500";
  } else if (upper.includes("NO_SPILL") || upper.includes("CLEAN") || upper.includes("VERIFIED")) {
    textClass = "text-emerald-400 border-emerald-500/40 bg-emerald-500/10";
    dotBg = "bg-emerald-400";
  } else if (
    upper.includes("INCONCLUSIVE") ||
    upper.includes("UNAVAILABLE") ||
    upper.includes("PENDING")
  ) {
    textClass = "text-amber-400 border-amber-500/40 bg-amber-500/10";
    dotBg = "bg-amber-400";
  }

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-[11px] uppercase tracking-[0.12em] font-mono ${textClass}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${dotBg}`} />
      {label}
    </span>
  );
}

export function OutcomeBadge({ outcome }: { outcome?: string | null }) {
  if (!outcome) return null;
  if (outcome === "SPILL_DETECTED") {
    return (
      <div className="inline-flex items-center gap-2 rounded-md border border-rose-500/40 bg-rose-500/10 px-2.5 py-1 text-xs font-mono font-semibold text-rose-400">
        <span className="h-1.5 w-1.5 rounded-full bg-rose-500 om-pulse-dot" />
        OIL-LIKE SIGNATURE DETECTED
      </div>
    );
  }
  if (outcome === "NO_SPILL_DETECTED") {
    return (
      <div className="inline-flex items-center gap-2 rounded-md border border-emerald-500/40 bg-emerald-500/10 px-2.5 py-1 text-xs font-mono font-semibold text-emerald-400">
        <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
        NO SPILL DETECTED
      </div>
    );
  }
  if (outcome === "ANALYSIS_INCONCLUSIVE") {
    return (
      <div className="inline-flex items-center gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-2.5 py-1 text-xs font-mono font-semibold text-amber-300">
        <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
        ANALYSIS INCONCLUSIVE
      </div>
    );
  }
  return <StatusDot label={outcome} />;
}

export function Modal({
  open,
  onClose,
  title,
  subtitle,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string | undefined;
  children: ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="om-fade absolute inset-0 bg-background/80" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="om-rise relative z-10 w-full max-w-lg rounded-md border border-border bg-card shadow-2xl"
      >
        <header className="flex items-start justify-between gap-4 border-b border-border px-5 py-3.5">
          <div>
            <h3 className="text-sm font-semibold text-foreground font-mono">{title}</h3>
            {subtitle && <p className="text-[11px] text-muted-foreground font-mono">{subtitle}</p>}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-border px-2 py-0.5 text-xs text-muted-foreground font-mono transition-colors hover:bg-secondary hover:text-foreground"
          >
            Close
          </button>
        </header>
        <div className="max-h-[65vh] overflow-y-auto px-5 py-4 text-sm">{children}</div>
      </div>
    </div>
  );
}

export function KeyVal({ k, v }: { k: string; v: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-border/50 py-1.5 last:border-0">
      <span className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground font-mono">
        {k}
      </span>
      <span className="tabular-nums text-foreground font-mono text-xs">{v}</span>
    </div>
  );
}
