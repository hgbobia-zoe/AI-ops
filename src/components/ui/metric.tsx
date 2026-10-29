// Metric — a stat tile (label · value · sub). Values are tabular-nums so money/hours columns line up.
//
// The value ALWAYS stays the high-contrast foreground — a metric is a number, not a status, so it is
// never painted red/amber/green. When a tile carries state, the colour goes on a small INDICATOR DOT
// beside the label (and the sub-text names it); the figure itself stays neutral.
// Server-component safe.

import * as React from "react";
import { cn } from "@/lib/utils";
import { type Tone, STATUS_DOT } from "@/lib/tone";

export function Metric({
  label,
  value,
  sub,
  tone,
  className,
}: {
  label: React.ReactNode;
  value: React.ReactNode;
  sub?: React.ReactNode;
  /** Puts a small coloured status dot beside the label. The value stays foreground regardless. */
  tone?: Tone;
  className?: string;
}): React.JSX.Element {
  return (
    <div className={cn("surface border border-border p-3", className)}>
      <div className="flex items-center gap-1.5 text-[11px] tracking-[0.04em] text-meta">
        {tone && <span className={cn("size-1.5 shrink-0 rounded-full", STATUS_DOT[tone])} aria-hidden />}
        {label}
      </div>
      <div className="mt-1.5 text-[18px] leading-tight font-semibold tabular-nums text-foreground">
        {value}
      </div>
      {sub && <div className="mt-1 truncate text-[11px] text-meta">{sub}</div>}
    </div>
  );
}

/**
 * MetricGrid — the responsive wrapper the tiles usually sit in (2 → 3 → 4 columns).
 */
export function MetricGrid({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className={cn("grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4", className)}>
      {children}
    </div>
  );
}
