"use client";

// Global integration summary — ONE compact control in the app header that replaces the old per-blade
// pill row. Collapsed, it shows a single Spectrum status indicator + a short headline ("All systems
// connected" / "2 need attention"). Expanded (a disclosure popover), it lists the integrations in two
// deliberately separate sections:
//
//   • Connections — connection HEALTH (wired up + reachable).
//   • Data freshness — the Auto-Pull heartbeat + Goodshuffle routes/bookings recency. This mirrors the
//     non-dismissible PullHealthBanner (which stays, as the active freshness alert); here it is read-only
//     so the two signals are never conflated.
//
// Actionable outages carry a "Fix" link; the long per-integration diagnostics live only in this panel,
// not repeated on every blade. Data is computed server-side and passed in (a render-time snapshot, like
// the old status bar) — no client fetch, no flash.

import { useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { ChevronDown, ArrowRight } from "lucide-react";
import type { Connection } from "@/lib/health/connections";
import { StatusBadge, STATUS_ICON } from "@/components/ui/status";
import { STATUS_INDICATOR } from "@/lib/tone";
import {
  connTone, splitConnections, overallTone, summaryHeadline, attentionCount,
} from "@/lib/health/integrationSummary";

function Row({ c }: { c: Connection }): React.JSX.Element {
  const tone = connTone(c.status);
  return (
    <div className="flex items-start gap-2.5 px-3 py-2">
      <StatusBadge tone={tone} size="sm" className="min-w-0 shrink-0">
        <span className="truncate">{c.label}</span>
      </StatusBadge>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-[11.5px] font-medium text-secondary-text">{c.headline}</span>
          {c.fixHref && (c.status === "attention" || c.status === "off") && (
            <Link
              href={c.fixHref}
              className="inline-flex items-center gap-0.5 text-[11px] font-medium text-[var(--info)] hover:underline"
            >
              {c.fixLabel ?? "Fix"} <ArrowRight className="size-3" aria-hidden />
            </Link>
          )}
        </div>
        <p className="mt-0.5 text-[11px] leading-snug text-meta">{c.detail}</p>
      </div>
    </div>
  );
}

function Section({ title, rows }: { title: string; rows: Connection[] }): React.JSX.Element | null {
  if (rows.length === 0) return null;
  return (
    <div className="border-t border-border first:border-t-0">
      <div className="px-3 pt-2.5 pb-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-meta">{title}</div>
      <div className="divide-y divide-[var(--row-rule)]">
        {rows.map((c) => (
          <Row key={c.key} c={c} />
        ))}
      </div>
    </div>
  );
}

export function IntegrationSummary({ connections }: { connections: Connection[] }): React.JSX.Element | null {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);

  // Close on outside click or Escape; return focus to the trigger on Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        btnRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (connections.length === 0) return null;

  const { connections: health, freshness } = splitConnections(connections);
  const tone = overallTone(connections);
  const Icon = STATUS_ICON[tone];
  const headline = summaryHeadline(connections);
  const needs = attentionCount(connections);

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={`Integrations: ${headline}`}
        className="inline-flex h-8 items-center gap-1.5 rounded border border-border bg-panel px-2.5 text-[12px] text-foreground transition-colors hover:bg-[var(--row-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Icon className={`size-3.5 shrink-0 ${STATUS_INDICATOR[tone]}`} aria-hidden />
        <span className="hidden whitespace-nowrap sm:inline">{headline}</span>
        {/* Compact mode (narrow header): just the count of outages beside the indicator. */}
        {needs > 0 && <span className="whitespace-nowrap sm:hidden">{needs}</span>}
        <ChevronDown className={`size-3.5 shrink-0 text-meta transition-transform ${open ? "rotate-180" : ""}`} aria-hidden />
      </button>

      {open && (
        <div
          id={panelId}
          role="region"
          aria-label="Integration status"
          className="absolute right-0 z-50 mt-1.5 max-h-[70vh] w-[320px] max-w-[calc(100vw-1.5rem)] overflow-y-auto rounded-md border border-border bg-lifted shadow-lg"
        >
          <Section title="Connections" rows={health} />
          <Section title="Data freshness" rows={freshness} />
        </div>
      )}
    </div>
  );
}
