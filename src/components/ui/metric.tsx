// Metric — a stat tile (label · value · sub). Mirrors the tile already used on the Payroll Overview.
// Values are tabular-nums so money/hours columns line up. `tone="attention"` emphasises a value that
// needs attention (e.g. blocked payroll > 0); plain values stay in the foreground tier.
// Server-component safe.

import * as React from "react";
import { cn } from "@/lib/utils";

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
  tone?: "attention" | "positive" | "critical";
  className?: string;
}): React.JSX.Element {
  const valueTone =
    tone === "attention"
      ? "text-attention"
      : tone === "positive"
        ? "text-positive"
        : tone === "critical"
          ? "text-critical"
          : "text-foreground";
  return (
    <div className={cn("surface border border-border p-3", className)}>
      <div className="text-[11px] tracking-[0.04em] text-meta">{label}</div>
      <div className={cn("mt-1.5 text-[18px] leading-tight font-semibold tabular-nums", valueTone)}>
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
