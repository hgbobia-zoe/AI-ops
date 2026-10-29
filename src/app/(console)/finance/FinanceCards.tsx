// Finance blade — presentation primitives (server-component safe). Blade-LOCAL building blocks that
// sit on the shared Nocturne tokens + the shared StatusBadge; they do not re-declare colour, tokens or
// a competing design system. One honest contract for a finance figure:
//   • plain-language label • the amount (white, tabular) • unit/scope • accounting basis • date basis
//   • freshness • estimate/verification state (a shared StatusBadge — colour on the indicator, the
//     number itself always stays the high-contrast foreground).
//
// Status colour lives ONLY on an indicator, never on a dollar amount (that is the shared design-system
// rule). Variance and contribution-sign therefore carry their direction on a small icon beside a white
// number, not by tinting the number.

import type React from "react";
import { TrendingUp, TrendingDown, Minus } from "lucide-react";
import { StatusBadge } from "@/components/ui/status";
import { STATUS_INDICATOR, STATUS_DOT, type Tone } from "@/lib/tone";
import type { Variance } from "@/lib/finance/calc";
import { money, signedMoney, pct, hrs, varianceTone, snapshotStatusTone, phaseTone } from "./viewModel";

/** "Unavailable" marker — a real source gap, never shown as 0. */
export function Unavail(): React.JSX.Element {
  return <span className="text-meta">Unavailable</span>;
}

// ── MetricCard — the consistent headline card ───────────────────────────────────────────────────────
export interface MetricCardProps {
  /** Plain-language label (no implementation jargon). */
  label: string;
  /** The headline figure (already formatted) or an Unavail node. */
  value: React.ReactNode;
  /** Unit / scope, e.g. "signed contracts · 12 events". */
  scope?: React.ReactNode;
  /** Accounting basis: Signed / Planned / Actual / Attributed / Projected / … */
  basis?: React.ReactNode;
  /** Date basis: the period the figure covers. */
  dateBasis?: React.ReactNode;
  /** Freshness, e.g. "as of last pull" — omit when genuinely unknown (never fabricate a time). */
  freshness?: React.ReactNode;
  /** Estimate / verification state — rendered as a shared StatusBadge (indicator + crisp label). */
  state?: { tone: Tone; label: string };
  /** Detail rows (dt/dd) under the headline. */
  children?: React.ReactNode;
  /** A short contextual footnote (e.g. "excludes non-labor costs"). */
  footnote?: React.ReactNode;
}

export function MetricCard({
  label, value, scope, basis, dateBasis, freshness, state, children, footnote,
}: MetricCardProps): React.JSX.Element {
  return (
    <div className="surface flex min-w-0 flex-col border border-border p-4">
      <div className="flex items-start justify-between gap-2">
        <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-tertiary-text">{label}</span>
        {state && <StatusBadge tone={state.tone} size="sm">{state.label}</StatusBadge>}
      </div>
      <div className="mt-2 text-[28px] font-medium leading-none tabular-nums text-foreground">{value}</div>
      {scope && <div className="mt-1.5 text-[12px] text-meta">{scope}</div>}
      {(basis || dateBasis || freshness) && (
        <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-meta">
          {basis && <span>Basis: <span className="text-secondary-text">{basis}</span></span>}
          {dateBasis && <><span aria-hidden>·</span><span>{dateBasis}</span></>}
          {freshness && <><span aria-hidden>·</span><span>{freshness}</span></>}
        </div>
      )}
      {children && <dl className="mt-3">{children}</dl>}
      {footnote && <p className="mt-3 border-t border-[var(--row-rule)] pt-2 text-[11.5px] text-meta">{footnote}</p>}
    </div>
  );
}

// ── Block / BRow — the denser figure card used across the analysis views ────────────────────────────
// Kept as the compact secondary card (the per-view sub-tiles). Values stay foreground; a `tag` names
// the basis in small caps. For the headline cards prefer MetricCard (fuller metadata).
export function Block({
  title, tag, headline, children,
}: { title: string; tag: string; headline: React.ReactNode; children?: React.ReactNode }): React.JSX.Element {
  return (
    <div className="bg-panel p-4">
      <div className="mb-2 flex items-baseline gap-2">
        <span className="text-[11px] font-medium uppercase tracking-[0.1em] text-tertiary-text">{title}</span>
        <span className="text-[10.5px] uppercase tracking-[0.08em] text-meta">{tag}</span>
      </div>
      <div className="text-[28px] font-medium leading-none tabular-nums text-foreground">{headline}</div>
      {children && <dl className="mt-3">{children}</dl>}
    </div>
  );
}
export function BRow({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-3 border-t border-[var(--row-rule)] py-1.5 text-[13px] first:border-t-0">
      <dt className="text-meta">{label}</dt>
      <dd className="tabular-nums text-foreground">{children}</dd>
    </div>
  );
}

// ── VarianceValue — white number + a direction indicator (never a tinted number) ───────────────────
export function VarianceValue({ v, kind }: { v: Variance; kind: "money" | "hours" }): React.JSX.Element {
  if (v.variance == null) return <span className="text-meta">—</span>;
  const tone = varianceTone(v.favorable);
  const Icon = v.variance > 0 ? TrendingUp : v.variance < 0 ? TrendingDown : Minus;
  const sign = v.variance > 0 ? "+" : "";
  const val = kind === "money" ? money(v.variance) : hrs(v.variance);
  return (
    <span className="inline-flex items-center gap-1.5 tabular-nums text-foreground">
      <Icon className={`size-3.5 shrink-0 ${STATUS_INDICATOR[tone]}`} aria-hidden />
      <span>{sign}{val}{v.variancePct != null ? ` (${sign}${pct(v.variancePct).replace("%", "")}%)` : ""}</span>
    </span>
  );
}

// ── ContributionValue — a contribution/profit dollar, white, with a sign indicator dot ─────────────
// Positive contribution = good (ready dot), negative = a loss (blocked dot). The number stays white.
export function ContributionValue({ value, estimated }: { value: number | null; estimated?: boolean }): React.JSX.Element {
  if (value == null) return <span className="text-meta">—</span>;
  const tone: Tone = value >= 0 ? "positive" : "critical";
  return (
    <span className="inline-flex items-center gap-1.5 tabular-nums text-foreground">
      <span className={`size-2 shrink-0 rounded-full ${STATUS_DOT[tone]}`} aria-hidden />
      <span>{money(value)}</span>
      {estimated && <span className="text-[10px] uppercase tracking-[0.06em] text-meta">est</span>}
    </span>
  );
}

/** A signed week-over-week style delta (white number + direction indicator). lowerIsBetter flips
 *  which direction reads as favorable (labor cost down = good). */
export function DeltaValue({ delta, lowerIsBetter = false }: { delta: number | null; lowerIsBetter?: boolean }): React.JSX.Element {
  if (delta == null) return <Unavail />;
  const favorable = delta === 0 ? true : lowerIsBetter ? delta < 0 : delta > 0;
  const tone = varianceTone(favorable);
  const Icon = delta > 0 ? TrendingUp : delta < 0 ? TrendingDown : Minus;
  return (
    <span className="inline-flex items-center gap-1.5 tabular-nums text-foreground">
      <Icon className={`size-3.5 shrink-0 ${STATUS_INDICATOR[tone]}`} aria-hidden />
      <span>{signedMoney(delta)}</span>
    </span>
  );
}

// ── Status / lifecycle / method tags (migrated onto the shared renderer) ────────────────────────────
/** Per-project settlement status — now the shared StatusBadge (was finance's local StatusBadge). */
export function SnapshotStatus({ status }: { status: "RECONCILED" | "ESTIMATED" | "PROVISIONAL" }): React.JSX.Element {
  const LABEL: Record<typeof status, string> = { RECONCILED: "Reconciled", ESTIMATED: "Estimated", PROVISIONAL: "Provisional" } as Record<"RECONCILED" | "ESTIMATED" | "PROVISIONAL", string>;
  return <StatusBadge tone={snapshotStatusTone(status)} size="sm">{LABEL[status]}</StatusBadge>;
}

/** Reconciliation-run lifecycle phase — a crisp label on a neutral indicator (colour on the dot only). */
export function PhaseTag({ phase }: { phase: "snapshot" | "revision" | "final" }): React.JSX.Element {
  const LABEL: Record<typeof phase, string> = { snapshot: "Snapshot", revision: "Revision", final: "Final" } as Record<"snapshot" | "revision" | "final", string>;
  const tone = phaseTone(phase);
  return (
    <span className="inline-flex items-center gap-1.5 text-[12px]">
      <span className={`size-1.5 shrink-0 rounded-full ${STATUS_DOT[tone]}`} aria-hidden />
      <span className="text-status-label">{LABEL[phase]}</span>
    </span>
  );
}

/** Attribution method — an informational qualitative tag (not a health status), so neutral meta text. */
export function MethodTag({ method, confidence }: { method: string | null; confidence: string | null }): React.JSX.Element {
  if (!method) return <span className="text-meta">—</span>;
  const label = method === "ACTUAL_STOP" ? "Actual" : method === "DERIVED_STOP" ? "Derived" : method === "PLANNED" ? "Planned" : method === "UNALLOCATED" ? "Unalloc" : "Est.";
  // ACTUAL_STOP is the only one that earns a positive indicator (a genuine GPS dwell); the rest are
  // honest estimates/derivations and stay neutral so nothing reads as "verified actual" that isn't.
  const tone: Tone = method === "ACTUAL_STOP" ? "positive" : "neutral";
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] uppercase tracking-[0.06em]">
      <span className={`size-1.5 shrink-0 rounded-full ${STATUS_DOT[tone]}`} aria-hidden />
      <span className="text-status-label">{label}{confidence ? ` · ${confidence[0]}` : ""}</span>
    </span>
  );
}
