// Empty / error / stale states (Nocturne). One honest vocabulary for the "no rows" situations the
// platform is strict about: ZERO (a real empty set), UNAVAILABLE (source down), and STALE (data is
// old). These are deliberately distinct — never show an error as "0", or stale data as fresh.
// Server-component safe.

import * as React from "react";
import { cn } from "@/lib/utils";
import { type Tone } from "@/lib/tone";

/**
 * EmptyState — a centred panel for a legitimately empty surface (no data yet, nothing to do).
 * Matches the pattern already used across the blades. Use ErrorState instead when a source failed.
 */
export function EmptyState({
  icon,
  title,
  body,
  action,
  className,
}: {
  icon?: React.ReactNode;
  title: string;
  body?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}): React.JSX.Element {
  return (
    <div
      className={cn(
        "surface flex flex-col items-center gap-2 border border-border px-6 py-14 text-center",
        className
      )}
    >
      {icon && <span className="text-meta" aria-hidden>{icon}</span>}
      <div className="text-[13px] font-medium text-foreground">{title}</div>
      {body && <p className="max-w-sm text-[12px] text-meta">{body}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

/**
 * ErrorState — a source is unavailable / a call failed. Tinted attention/critical so it reads as a
 * problem, not an empty set. `tone` defaults to "attention" (stale/unavailable); use "critical" for
 * a hard failure. role="alert" so assistive tech announces it.
 */
export function ErrorState({
  icon,
  title,
  body,
  tone = "attention",
  action,
  className,
}: {
  icon?: React.ReactNode;
  title: string;
  body?: React.ReactNode;
  tone?: Extract<Tone, "attention" | "critical">;
  action?: React.ReactNode;
  className?: string;
}): React.JSX.Element {
  const ring = tone === "critical" ? "border-critical/40" : "border-attention/40";
  const accent = tone === "critical" ? "text-critical" : "text-attention";
  return (
    <div
      role="alert"
      className={cn(
        "surface flex flex-col items-center gap-2 border px-6 py-12 text-center",
        ring,
        className
      )}
    >
      {icon && <span className={accent} aria-hidden>{icon}</span>}
      <div className={cn("text-[13px] font-medium", accent)}>{title}</div>
      {body && <p className="max-w-sm text-[12px] text-meta">{body}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

/**
 * StaleBadge — a small inline marker that a figure/surface is older than expected. Carries the "as
 * of" text so staleness is explicit rather than silently shown as current.
 */
export function StaleBadge({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}): React.JSX.Element {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded border border-attention/40 bg-attention/10 px-1.5 py-0.5 text-[10.5px] font-medium text-attention",
        className
      )}
    >
      {children}
    </span>
  );
}
