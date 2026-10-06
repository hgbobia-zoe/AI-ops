// Shared presentational bits for the AI Org blades (server components, Nocturne tokens). Kept tiny and
// DRY so the command center, employee grid and detail page render status the same way.

import type React from "react";
import Link from "next/link";
import type { AiBacking, AiLiveState, AiMetric } from "@/lib/aiorg/types";

const TABS: { href: string; label: string }[] = [
  { href: "/ai-org", label: "Command Center" },
  { href: "/ai-org/employees", label: "AI Employees" },
  { href: "/ai-org/approvals", label: "Approvals" },
  { href: "/ai-org/runs", label: "Runs" },
  { href: "/ai-org/exceptions", label: "Exceptions" },
];

/** The sub-nav shared across the AI Org blades. `active` is the href of the current view. */
export function OrgTabs({ active }: { active: string }): React.JSX.Element {
  return (
    <nav className="mb-5 flex flex-wrap gap-4 border-b border-border pb-2">
      {TABS.map((t) => (
        <Link
          key={t.href}
          href={t.href}
          className={`text-[13.5px] transition-colors ${t.href === active ? "font-medium text-foreground" : "text-muted-foreground hover:text-foreground"}`}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );
}

const STATE_DOT: Record<AiLiveState, string> = {
  ok: "bg-positive",
  attention: "bg-attention",
  idle: "bg-[var(--bar)]",
  coming: "bg-[var(--bar)]",
};

/** The liveness dot for an employee. */
export function StateDot({ state }: { state: AiLiveState }): React.JSX.Element {
  return <span className={`inline-block size-1.5 shrink-0 rounded-full ${STATE_DOT[state]}`} aria-hidden />;
}

const BACKING_LABEL: Record<AiBacking, string> = { live: "LIVE", seed: "SEED", partial: "PARTIAL", coming: "COMING" };
const BACKING_TONE: Record<AiBacking, string> = {
  live: "border-positive/40 text-positive",
  seed: "border-attention/40 text-attention",
  partial: "border-border text-tertiary-text",
  coming: "border-border text-meta",
};

/** The honest backing badge (LIVE / SEED / PARTIAL / COMING). */
export function BackingBadge({ backing }: { backing: AiBacking }): React.JSX.Element {
  return (
    <span className={`rounded border px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-[0.08em] ${BACKING_TONE[backing]}`}>
      {BACKING_LABEL[backing]}
    </span>
  );
}

const METRIC_TONE: Record<string, string> = { critical: "text-critical", attention: "text-attention", positive: "text-positive", default: "text-foreground" };

/** A compact inline metric list (label + value). Empty render for a "coming" employee (no metrics). */
export function MetricRow({ metrics }: { metrics: AiMetric[] }): React.JSX.Element | null {
  if (metrics.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-1">
      {metrics.map((mm) => (
        <span key={mm.label} className="inline-flex items-baseline gap-1.5 whitespace-nowrap">
          <span className={`text-[14px] font-medium tabular-nums ${METRIC_TONE[mm.tone ?? "default"]}`}>{mm.value}</span>
          <span className="text-[10.5px] uppercase tracking-[0.07em] text-meta">{mm.label}</span>
        </span>
      ))}
    </div>
  );
}

/** Data-source health dot + label (from computeConnections). */
export function HealthMark({ health }: { health: { status: "ok" | "idle" | "attention" | "off"; label: string } | null }): React.JSX.Element | null {
  if (!health) return null;
  // idle + off both read as neutral grey (connected-but-quiet, or not set up) — only a real problem is amber.
  const tone = health.status === "ok" ? "bg-positive" : health.status === "attention" ? "bg-attention" : "bg-[var(--bar)]";
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] text-meta">
      <span className={`size-1.5 rounded-full ${tone}`} aria-hidden /> {health.label}
    </span>
  );
}
