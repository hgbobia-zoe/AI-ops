// PageHeader + Toolbar — the shared top-of-blade header and control row (Nocturne).
// Codifies the header already shipped on Payroll: an icon + title, an optional subtitle in the meta
// tier, and right-aligned actions that wrap gracefully. Server-component safe.

import * as React from "react";
import { cn } from "@/lib/utils";

// Title scale. "page" (22px) is the established blade-title size (matches Payroll and the other
// blades); it intentionally sits below the 01-prompt's 26–30px suggestion because changing it would
// desync every already-shipped blade header — see docs/DESIGN_SYSTEM.md. "display" (28px) is the
// larger option for a hero/overview header; "section" (18px) is a sub-section heading.
const TITLE_SIZE = {
  display: "text-[28px]",
  page: "text-[22px]",
  section: "text-[18px]",
} as const;

export function PageHeader({
  title,
  icon,
  subtitle,
  actions,
  size = "page",
  className,
}: {
  title: React.ReactNode;
  icon?: React.ReactNode;
  subtitle?: React.ReactNode;
  actions?: React.ReactNode;
  size?: keyof typeof TITLE_SIZE;
  className?: string;
}): React.JSX.Element {
  return (
    <header className={cn("mb-4 flex flex-wrap items-end justify-between gap-3", className)}>
      <div className="min-w-0">
        <h1 className={cn("flex items-center gap-2 font-semibold tracking-tight", TITLE_SIZE[size])}>
          {icon && <span className="text-meta" aria-hidden>{icon}</span>}
          {title}
        </h1>
        {subtitle && <div className="mt-1 text-[12.5px] text-meta">{subtitle}</div>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

/**
 * Toolbar — a horizontal control row (filters, search, view switches, actions). `justify` controls
 * the main-axis distribution; items wrap on narrow viewports so controls never overflow the page.
 */
export function Toolbar({
  justify = "between",
  className,
  children,
}: {
  justify?: "start" | "between" | "end";
  className?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  const j =
    justify === "between" ? "justify-between" : justify === "end" ? "justify-end" : "justify-start";
  return (
    <div className={cn("flex flex-wrap items-center gap-2", j, className)}>{children}</div>
  );
}
