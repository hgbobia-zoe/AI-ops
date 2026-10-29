// Empty / error / stale / blocking states (Nocturne). One honest vocabulary for the "something isn't
// a normal row of data" situations the platform is strict about: ZERO (a real empty set), UNAVAILABLE
// (a source failed), STALE (data is old), and BLOCKED (an action can't proceed yet). These are
// distinct — never show an error as "0", or stale data as fresh.
//
// Status colour lives on the INDICATOR icon; headings/explanations stay the high-contrast label/text
// tier (never a bright-filled panel). Server-component safe.

import * as React from "react";
import { cn } from "@/lib/utils";
import { AlertTriangle } from "lucide-react";
import { type Tone, STATUS_INDICATOR } from "@/lib/tone";
import { STATUS_ICON } from "@/components/ui/status";

/**
 * EmptyState — a centred panel for a legitimately empty surface (no data yet, nothing to do).
 * Neutral by design (no status colour). Use ErrorState when a source failed, StatusBanner to block.
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
 * ErrorState — a source is unavailable / a call failed (distinct from an empty set). Colour sits on
 * the indicator icon; the heading stays foreground (white on dark) on the neutral surface. role="alert".
 */
export function ErrorState({
  title,
  body,
  tone = "attention",
  action,
  className,
}: {
  title: string;
  body?: React.ReactNode;
  tone?: Extract<Tone, "attention" | "critical">;
  action?: React.ReactNode;
  className?: string;
}): React.JSX.Element {
  const Icon = STATUS_ICON[tone];
  return (
    <div
      role="alert"
      className={cn(
        "surface flex flex-col items-center gap-2 border border-border px-6 py-12 text-center",
        className
      )}
    >
      <Icon className={cn("size-5", STATUS_INDICATOR[tone])} aria-hidden />
      <div className="text-[13px] font-medium text-foreground">{title}</div>
      {body && <p className="max-w-sm text-[12px] text-secondary-text">{body}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

/**
 * StatusBanner — the shared BLOCKING banner: a neutral surface with a coloured status icon, a white
 * heading, a readable explanation, the specific next action, and an OPTIONAL narrow status-coloured
 * left edge. It never fills the whole banner bright — colour is confined to the icon + the hairline
 * edge, so one banner states the problem once without competing with other panels. role="alert".
 */
export function StatusBanner({
  tone,
  title,
  children,
  action,
  edge = true,
  icon,
  className,
}: {
  tone: Tone;
  title: React.ReactNode;
  children?: React.ReactNode;
  action?: React.ReactNode;
  /** The narrow status-coloured left edge. On by default; set false for a fully-neutral banner. */
  edge?: boolean;
  icon?: React.ReactNode;
  className?: string;
}): React.JSX.Element {
  const Icon = STATUS_ICON[tone];
  const EDGE: Record<Tone, string> = {
    positive: "border-l-status-ready",
    attention: "border-l-status-warning",
    critical: "border-l-status-blocked",
    info: "border-l-status-syncing",
    neutral: "border-l-status-neutral",
  };
  return (
    <div
      role="alert"
      className={cn(
        "surface flex items-start gap-3 border border-border p-4",
        edge && cn("border-l-2", EDGE[tone]),
        className
      )}
    >
      <span className="mt-0.5 shrink-0">
        {icon ?? <Icon className={cn("size-5", STATUS_INDICATOR[tone])} aria-hidden />}
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium text-foreground">{title}</div>
        {children && <div className="mt-1 text-[12.5px] text-secondary-text">{children}</div>}
        {action && <div className="mt-2.5">{action}</div>}
      </div>
    </div>
  );
}

/**
 * StaleBadge — a small inline marker that a figure/surface is older than expected. A warning-coloured
 * indicator + the "as of" text in the neutral meta tier (a timestamp is secondary metadata). No tint.
 */
export function StaleBadge({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}): React.JSX.Element {
  return (
    <span className={cn("inline-flex items-center gap-1 text-[11px] text-meta", className)}>
      <AlertTriangle className={cn("size-3 shrink-0", STATUS_INDICATOR.attention)} aria-hidden />
      {children}
    </span>
  );
}
