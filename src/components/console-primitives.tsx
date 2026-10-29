// Nocturne primitives — build once, use across every blade. Tier drives the visual weight of a row/card
// (left bar, text colour, action colour); FigureStrip is the header figure row; ActionVerb is the caps
// verb; table class constants give every data table the same sticky-thead / fixed-layout look.

import type React from "react";
import { type Tone, STATUS_INDICATOR, STATUS_LABEL, STATUS_DOT } from "@/lib/tone";
import { STATUS_ICON } from "@/components/ui/status";

// ── Tier ─────────────────────────────────────────────────────────────────────
export type Tier = "now" | "today" | "attention" | "passive" | "stale" | "done";

/** Left bar (2px) for a tiered row/card — critical for now, attention for today, none otherwise. */
export function tierBar(tier: Tier): string {
  if (tier === "now") return "border-l-2 border-critical";
  if (tier === "today" || tier === "attention") return "border-l-2 border-attention";
  return "border-l-2 border-transparent";
}
/** Row background by tier. Tokenised (was hard-coded dark hex) so it renders in both themes. */
export function tierRowBg(tier: Tier): string {
  if (tier === "now") return "bg-row";
  if (tier === "done") return "bg-panel";
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

// Status colour lives on a small INDICATOR DOT, never on the figure itself — the value/count stays
// the high-contrast foreground so money and counts never read as "warning numbers". The figure's own
// label already names the state, so a dot (not a full icon) is enough disambiguation here.
const FIG_DOT: Record<"critical" | "attention" | "positive", Tone> = {
  critical: "critical", attention: "attention", positive: "positive",
};

export function FigureStrip({ figures }: { figures: Figure[] }): React.JSX.Element {
  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
      {figures.map((f, i) => {
        const toned = f.tone && f.tone !== "default";
        return (
          <div key={f.label} className="flex items-center gap-6">
            {f.sep && i > 0 && <span className="h-[30px] w-px bg-border" aria-hidden />}
            <div className="whitespace-nowrap">
              <div className="flex items-center gap-1.5 text-[20px] font-medium leading-tight tabular-nums text-foreground">
                {toned && (
                  <span className={`size-2 shrink-0 rounded-full ${STATUS_DOT[FIG_DOT[f.tone as "critical" | "attention" | "positive"]]}`} aria-hidden />
                )}
                <span>{f.value}</span>
              </div>
              <div className="mt-0.5 text-[10.5px] uppercase tracking-[0.1em] text-meta">{f.label}</div>
            </div>
          </div>
        );
      })}
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
// Status = a distinct-shape coloured INDICATOR icon + a crisp white (ink on light) label on the
// inherited surface. Colour is on the icon only; the label is never tinted. `idle` → neutral.
const MARK_TONE: Record<"positive" | "attention" | "critical" | "idle", Tone> = {
  positive: "positive", attention: "attention", critical: "critical", idle: "neutral",
};
export function StatusMark({ tone, label }: { tone: "positive" | "attention" | "critical" | "idle"; label: string }): React.JSX.Element {
  const t = MARK_TONE[tone];
  const Icon = STATUS_ICON[t];
  return (
    <span className="inline-flex items-center gap-1.5">
      <Icon className={`size-3.5 shrink-0 ${STATUS_INDICATOR[t]}`} aria-hidden />
      <span className={`text-[12px] ${STATUS_LABEL}`}>{label}</span>
    </span>
  );
}

// ── Table class constants ───────────────────────────────────────────────────────
// Archetype A — the full-height DATA GRID: fixed layout, sticky thead on the canvas, hairline rules.
// Use when the table is the page and the header should stay pinned while the body scrolls vertically.
export const tableCls = "w-full table-fixed border-collapse text-[13.5px]";
export const theadCls = "sticky top-0 z-10 bg-background";
export const thCls = "px-2.5 py-2 text-left text-[11px] font-medium uppercase tracking-[0.08em] text-meta";
export const tdCls = "px-2.5 py-2.5 align-middle";
export const rowCls = "border-t border-rule transition-colors hover:bg-row-hover";

// Archetype B — the COMPACT bounded table (as on Payroll): sits inside a bordered surface that
// scrolls HORIZONTALLY in its own box, denser rows, small-caps header. Wrap the <table> in
// `compactTableFrameCls` and give the <table> `compactTableCls` + a min-w so it scrolls, not squashes.
export const compactTableFrameCls = "surface overflow-x-auto border border-border";
export const compactTableCls = "w-full text-[12.5px]";
export const compactTheadRowCls = "border-b border-rule text-left text-[10.5px] uppercase tracking-[0.06em] text-meta";
export const compactThCls = "px-3 py-2 font-medium";
export const compactTdCls = "px-3 py-2 text-secondary-text";
export const compactRowCls = "border-b border-rule/60 last:border-0 hover:bg-row-hover";

// ── Verified / Inferred meta line ──────────────────────────────────────────────
export function Provenance({ kind, detail }: { kind: "verified" | "inferred" | "unverified"; detail?: string }): React.JSX.Element {
  const label = kind === "verified" ? "Verified" : kind === "inferred" ? "Inferred" : "Unverified";
  return <span className="text-[12px] text-meta">{label}{detail ? ` · ${detail}` : ""}</span>;
}
