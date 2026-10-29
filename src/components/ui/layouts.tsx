// The four composable layout patterns (Nocturne). Every blade is one (or a stack) of these, so the
// console feels like one product. They are fl/grid wrappers only — no colour, no data. Each keeps
// its scroll LOCAL (boards/tables scroll inside their box; the page never scrolls sideways).
// Server-component safe.

import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * BladeMain — the standard page container every blade opens with: centred, max 1400px, breathing
 * room, a touch of extra bottom padding so the last row clears the fold. Put a <PageHeader> first.
 */
export function BladeMain({
  className,
  children,
  ...props
}: React.ComponentProps<"main">): React.JSX.Element {
  return (
    <main className={cn("mx-auto max-w-[1400px] p-3 pb-10 md:p-4", className)} {...props}>
      {children}
    </main>
  );
}

/**
 * Pattern 1 — Overview with a context column. A wide main area beside a narrower context rail
 * (summary, filters, "what to do next"). Stacks to a single column below `lg`. `side` places the
 * rail left or right (default right).
 */
export function OverviewLayout({
  main,
  context,
  side = "right",
  className,
}: {
  main: React.ReactNode;
  context: React.ReactNode;
  side?: "left" | "right";
  className?: string;
}): React.JSX.Element {
  return (
    <div className={cn("grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_320px]", className)}>
      <div className={cn("min-w-0", side === "left" && "lg:order-2")}>{main}</div>
      <aside className={cn("min-w-0 space-y-4", side === "left" && "lg:order-1")}>{context}</aside>
    </div>
  );
}

/**
 * Pattern 2 — Full-width work surface (a table or board). The content scrolls inside itself; this
 * wrapper just owns the vertical rhythm and an optional toolbar slot above the surface.
 */
export function WorkSurfaceLayout({
  toolbar,
  children,
  className,
}: {
  toolbar?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}): React.JSX.Element {
  return (
    <div className={cn("space-y-3", className)}>
      {toolbar}
      <div className="min-w-0">{children}</div>
    </div>
  );
}

/**
 * Pattern 3 — Operational timeline. A single vertical rail of time-ordered events (dispatch stops,
 * sync pipeline, activity). Children are <TimelineItem>s. The rail rule + dots come from the items.
 */
export function TimelineLayout({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}): React.JSX.Element {
  return <ol className={cn("relative space-y-0", className)}>{children}</ol>;
}

export function TimelineItem({
  dot,
  children,
  className,
}: {
  /** A leading marker (e.g. a StatusDot). */
  dot?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}): React.JSX.Element {
  return (
    <li className={cn("flex items-start gap-3 border-l border-rule py-2 pl-3", className)}>
      {dot && <span className="mt-0.5 shrink-0">{dot}</span>}
      <div className="min-w-0 flex-1">{children}</div>
    </li>
  );
}

/**
 * Pattern 4 — Focused form with a summary rail. The form takes the main column; a sticky summary
 * (totals, preview, "what happens on save") rides alongside and collapses below it on narrow.
 */
export function FocusFormLayout({
  form,
  summary,
  className,
}: {
  form: React.ReactNode;
  summary: React.ReactNode;
  className?: string;
}): React.JSX.Element {
  return (
    <div className={cn("grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_300px]", className)}>
      <div className="min-w-0 space-y-4">{form}</div>
      <aside className="min-w-0">
        <div className="lg:sticky lg:top-4 space-y-4">{summary}</div>
      </aside>
    </div>
  );
}
