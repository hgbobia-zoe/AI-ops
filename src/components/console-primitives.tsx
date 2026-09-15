// Nocturne primitives — build once, use across every blade. Tier drives the visual weight of a row/card
// (left bar, text colour, action colour); FigureStrip is the header figure row; ActionVerb is the caps
// verb; table class constants give every data table the same sticky-thead / fixed-layout look.

import type React from "react";

// ── Tier ─────────────────────────────────────────────────────────────────────
export type Tier = "now" | "today" | "attention" | "passive" | "stale" | "done";

/** Left bar (2px) for a tiered row/card — critical for now, attention for today, none otherwise. */
export function tierBar(tier: Tier): string {
  if (tier === "now") return "border-l-2 border-critical";
  if (tier === "today" || tier === "attention") return "border-l-2 border-attention";
  return "border-l-2 border-transparent";
}
/** Row background by tier. */
export function tierRowBg(tier: Tier): string {
  if (tier === "now") return "bg-[#1b1d29]";
  if (tier === "done") return "bg-[#191b26]";
  return "";
}
/** Primary value / name text colour by tier. */
export function tierValueText(tier: Tier): string {
  if (tier === "passive") return "text-secondary-text";
  if (tier === "stale" || tier === "done") return "text-tertiary-text";
  return "text-foreground";
}
/** Action-verb colour by tier. */
export function tierActionTone(tier: Tier): string {
  if (tier === "now") return "text-critical";
  if (tier === "today" || tier === "attention") return "text-attention";
  return "text-meta";
}

// ── FigureStrip ───────────────────────────────────────────────────────────────
export interface Figure {
  label: string;
  value: string | number;
  tone?: "critical" | "attention" | "positive" | "default";
  /** insert a 1×30 hairline separator before this figure (attention figures | volume figures). */
  sep?: boolean;
}

const FIG_TONE: Record<string, string> = { critical: "text-critical", attention: "text-attention", positive: "text-positive", default: "text-foreground" };

export function FigureStrip({ figures }: { figures: Figure[] }): React.JSX.Element {
  return (
    <div className="flex items-center gap-6">
      {figures.map((f, i) => (
        <div key={f.label} className="flex items-center gap-6">
          {f.sep && i > 0 && <span className="h-[30px] w-px bg-border" aria-hidden />}
          <div className="whitespace-nowrap">
            <div className={`text-[20px] font-medium leading-tight tabular-nums ${FIG_TONE[f.tone ?? "default"]}`}>{f.value}</div>
            <div className="mt-0.5 text-[10.5px] uppercase tracking-[0.1em] text-meta">{f.label}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

// ── ActionVerb ────────────────────────────────────────────────────────────────
export function ActionVerb({ primary, secondary, tone = "text-foreground" }: { primary: string; secondary?: string; tone?: string }): React.JSX.Element {
  return (
    <span className="inline-flex items-center gap-3">
      <span className={`text-[11.5px] font-semibold uppercase tracking-[0.07em] ${tone}`}>{primary}</span>
      {secondary && <span className="text-[11.5px] font-medium uppercase tracking-[0.07em] text-meta">{secondary}</span>}
    </span>
  );
}

// ── StatusMark ────────────────────────────────────────────────────────────────
const MARK_DOT: Record<string, string> = { positive: "bg-positive", attention: "bg-attention", critical: "bg-critical", idle: "bg-[var(--bar)]" };
export function StatusMark({ tone, label }: { tone: "positive" | "attention" | "critical" | "idle"; label: string }): React.JSX.Element {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={`size-1.5 rounded-full ${MARK_DOT[tone]}`} />
      <span className="text-[12px] text-tertiary-text">{label}</span>
    </span>
  );
}

// ── Table class constants (fixed layout, sticky thead, hairline rules) ──────────
export const tableCls = "w-full table-fixed border-collapse text-[13.5px]";
export const theadCls = "sticky top-0 z-10 bg-background";
export const thCls = "px-2.5 py-2 text-left text-[11px] font-medium uppercase tracking-[0.08em] text-meta";
export const tdCls = "px-2.5 py-2.5 align-middle";
export const rowCls = "border-t border-[var(--row-rule)] transition-colors hover:bg-[var(--row-hover)]";

// ── Verified / Inferred meta line ──────────────────────────────────────────────
export function Provenance({ kind, detail }: { kind: "verified" | "inferred" | "unverified"; detail?: string }): React.JSX.Element {
  const label = kind === "verified" ? "Verified" : kind === "inferred" ? "Inferred" : "Unverified";
  return <span className="text-[12px] text-meta">{label}{detail ? ` · ${detail}` : ""}</span>;
}
