// Nocturne shared primitives — the design-system components the redesign reuses across every console
// screen (handoff: design_handoff_zoe_ops_redesign). One `tier` prop drives row/card styling; figures,
// action verbs, timeline rows, exception items, tables and provenance text all come from here so the
// per-screen badge/colour maps (StateBadge, StatusTag, Stat, STAGE_STYLE, ACTION_STYLE, COL_ACCENT) are
// replaced by one source of truth. Presentational only — no data, no business logic.
//
// Tokens: critical/attention/positive + text tiers + surfaces come from globals.css (.dark). The few
// exact hexes the spec names that have no token (now-row #1b1d29, done-row #191b26, exception-critical
// #251b22) are inlined as arbitrary values.

import type React from "react";

// ── Tiers ─────────────────────────────────────────────────────────────────────
export type Tier = "now" | "today" | "attention" | "passive" | "stale" | "done";

export interface TierClasses {
  rowBg: string; // row background (class)
  bar: string; // 2px left bar colour (class for border-l-color), "" = none
  value: string; // value/figure text colour
  name: string; // primary name text colour
  action: string; // action verb colour
}

/** The one mapping the whole system reads. Mirrors the renderVals() tier rules in the handoff. */
export function tierClasses(tier: Tier): TierClasses {
  switch (tier) {
    case "now":
      return { rowBg: "bg-[#1b1d29]", bar: "border-l-critical", value: "text-foreground", name: "text-foreground", action: "text-critical" };
    case "today":
    case "attention":
      return { rowBg: "", bar: "border-l-attention", value: "text-secondary-text", name: "text-foreground", action: "text-attention" };
    case "stale":
      return { rowBg: "", bar: "", value: "text-tertiary-text", name: "text-tertiary-text", action: "text-attention" };
    case "done":
      return { rowBg: "bg-[#191b26]", bar: "", value: "text-tertiary-text", name: "text-tertiary-text", action: "text-meta" };
    case "passive":
    default:
      return { rowBg: "", bar: "", value: "text-tertiary-text", name: "text-tertiary-text", action: "text-meta" };
  }
}

export type Tone = "critical" | "attention" | "positive" | "neutral" | "default";
const TONE_TEXT: Record<Tone, string> = {
  critical: "text-critical",
  attention: "text-attention",
  positive: "text-positive",
  neutral: "text-meta",
  default: "text-foreground",
};
const TONE_DOT: Record<Tone, string> = {
  critical: "bg-critical",
  attention: "bg-attention",
  positive: "bg-positive",
  neutral: "bg-[var(--bar)]",
  default: "bg-[var(--bar-2)]",
};

// ── Status dot ──────────────────────────────────────────────────────────────
/** A 6px state dot. */
export function StatusMark({ tone = "neutral", className }: { tone?: Tone; className?: string }): React.JSX.Element {
  return <span className={`inline-block size-1.5 shrink-0 rounded-full ${TONE_DOT[tone]} ${className ?? ""}`} aria-hidden />;
}

// ── FigureStrip ───────────────────────────────────────────────────────────────
export interface Figure {
  label: string;
  value: string | number;
  /** Colour the NUMBER only when it is a state (critical/attention/positive). */
  tone?: Tone;
  /** Insert a 1×30 hairline separator BEFORE this figure (splits attention figures from volume figures). */
  divide?: boolean;
}

/** Header-right figure strip: 20/500 number over 10.5px .1em caps label, nowrap, gap 28, hairline divider. */
export function FigureStrip({ figures, className }: { figures: Figure[]; className?: string }): React.JSX.Element {
  return (
    <div className={`flex items-end gap-7 ${className ?? ""}`}>
      {figures.map((f, i) => (
        <div key={i} className="flex items-end gap-7">
          {f.divide && <span className="h-[30px] w-px shrink-0 bg-border" aria-hidden />}
          <div className="whitespace-nowrap">
            <div className={`text-[20px] font-medium leading-none tabular-nums ${TONE_TEXT[f.tone ?? "default"]}`}>{f.value}</div>
            <div className="mt-[5px] text-[10.5px] uppercase tracking-[0.1em] text-meta">{f.label}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

// ── ActionVerb ────────────────────────────────────────────────────────────────
/** Caps action verb, coloured by tier. Primary verb first; optional secondary in meta after a gap. Never a
 *  filled button. */
export function ActionVerb({ tier, children, secondary }: { tier: Tier; children: React.ReactNode; secondary?: React.ReactNode }): React.JSX.Element {
  const { action } = tierClasses(tier);
  return (
    <span className="inline-flex items-center gap-3 whitespace-nowrap">
      <span className={`text-[11.5px] font-semibold uppercase tracking-[0.07em] ${action}`}>{children}</span>
      {secondary && <span className="text-[11.5px] font-medium uppercase tracking-[0.07em] text-meta">{secondary}</span>}
    </span>
  );
}

// ── Buttons (Nocturne .btn) ─────────────────────────────────────────────────────
export function NButton({
  variant = "secondary",
  children,
  onClick,
  href,
  disabled,
  className,
  type = "button",
}: {
  variant?: "primary" | "secondary" | "ghost";
  children: React.ReactNode;
  onClick?: () => void;
  href?: string;
  disabled?: boolean;
  className?: string;
  type?: "button" | "submit";
}): React.JSX.Element {
  const base = "inline-flex items-center justify-center gap-1.5 rounded px-3 py-[7px] text-[13px] transition-colors disabled:opacity-45";
  const v =
    variant === "primary"
      ? "border border-foreground/80 text-foreground hover:bg-[var(--row-hover)]"
      : variant === "ghost"
        ? "text-tertiary-text hover:text-foreground"
        : "border border-[var(--bar)] text-secondary-text hover:bg-[var(--row-hover)] hover:text-foreground";
  const cls = `${base} ${v} ${className ?? ""}`;
  if (href) return <a href={href} className={cls}>{children}</a>;
  return <button type={type} onClick={onClick} disabled={disabled} className={cls}>{children}</button>;
}

// ── Data table ─────────────────────────────────────────────────────────────────
/** Fixed-layout table in a scroll container with sticky, caps headers and thin scrollbars. */
export function NTable({ children, className, head }: { children: React.ReactNode; head: React.ReactNode; className?: string }): React.JSX.Element {
  return (
    <div className={`min-h-0 flex-1 overflow-auto ${className ?? ""}`}>
      <table className="w-full table-fixed border-collapse text-[13.5px]">
        <thead>
          <tr className="sticky top-0 z-[1] bg-background text-[11px] uppercase tracking-[0.08em] text-meta">{head}</tr>
        </thead>
        {children}
      </table>
    </div>
  );
}

/** A sticky header cell. `align` right-aligns numeric columns. */
export function Th({ children, width, align = "left", className }: { children?: React.ReactNode; width?: number | string; align?: "left" | "right"; className?: string }): React.JSX.Element {
  return (
    <th
      style={width ? { width: typeof width === "number" ? `${width}px` : width } : undefined}
      className={`whitespace-nowrap px-2.5 pb-2 pt-2.5 font-medium ${align === "right" ? "text-right" : "text-left"} ${className ?? ""}`}
    >
      {children}
    </th>
  );
}

/** A body cell with the shared row rule. `bar` draws the tier bar on the first cell (border-l-2). */
export function Td({ children, align = "left", bar, className, title }: { children?: React.ReactNode; align?: "left" | "right"; bar?: string; className?: string; title?: string }): React.JSX.Element {
  return (
    <td title={title} className={`border-b border-rule px-2.5 py-2.5 ${align === "right" ? "text-right" : "text-left"} ${bar ? `border-l-2 ${bar}` : ""} ${className ?? ""}`}>
      {children}
    </td>
  );
}

/** A group header row inside a table body (ACT NOW / TODAY / MONITOR). */
export function GroupRow({ label, count, tone = "neutral", span }: { label: string; count?: number | string; tone?: Tone; span: number }): React.JSX.Element {
  return (
    <tr>
      <td colSpan={span} className="px-6 pb-1.5 pt-4 text-[11px] font-medium uppercase tracking-[0.12em]">
        <span className={TONE_TEXT[tone]}>{label}</span>
        {count != null && <span className="ml-1.5 font-normal text-meta">{count}</span>}
      </td>
    </tr>
  );
}

// ── Timeline row ────────────────────────────────────────────────────────────────
export type TimelineSource = "customer" | "rep" | "system" | "inferred";
const TL_SRC: Record<TimelineSource, { color: string; weight: string; title: string; dashed: boolean }> = {
  customer: { color: "text-foreground", weight: "font-semibold", title: "text-foreground", dashed: false },
  rep: { color: "text-tertiary-text", weight: "font-medium", title: "text-secondary-text", dashed: false },
  system: { color: "text-meta", weight: "font-medium", title: "text-tertiary-text", dashed: false },
  inferred: { color: "text-meta", weight: "font-medium", title: "text-tertiary-text", dashed: true },
};

/** One activity-timeline row: 64px time column | content; source label caps coloured by kind; INFERRED
 *  gets a dashed left rule. */
export function TimelineRow({ time, source, label, title, body }: { time: string; source: TimelineSource; label: string; title?: string; body?: string }): React.JSX.Element {
  const s = TL_SRC[source];
  return (
    <div className="grid grid-cols-[64px_1fr] gap-x-3 border-b border-[var(--grid-rule)] py-[9px] text-[13px]">
      <span className="pt-px text-[12.5px] text-meta">{time}</span>
      <div className={s.dashed ? "border-l border-dashed border-[var(--bar-2)] pl-2.5" : ""}>
        <div className="flex items-baseline gap-2">
          <span className={`text-[10.5px] uppercase tracking-[0.1em] ${s.color} ${s.weight}`}>{label}</span>
          {title && <span className={s.title}>{title}</span>}
        </div>
        {body && <div className="mt-0.5 text-[12.5px] text-muted-foreground">{body}</div>}
      </div>
    </div>
  );
}

// ── Exception / risk item ─────────────────────────────────────────────────────
export type Severity = "critical" | "high" | "medium" | "low";
const SEV: Record<Severity, { bar: string; text: string; bg: string }> = {
  critical: { bar: "border-l-critical", text: "text-critical", bg: "bg-[#251b22]" },
  high: { bar: "border-l-attention", text: "text-attention", bg: "bg-row" },
  medium: { bar: "border-l-attention/60", text: "text-attention", bg: "bg-row" },
  low: { bar: "border-l-[var(--bar)]", text: "text-meta", bg: "bg-row" },
};

/** A severity-barred exception/risk item: 2px severity left bar, caps severity, title, body, verbs row. */
export function ExceptionItem({ severity, title, body, children }: { severity: Severity; title: string; body?: string; children?: React.ReactNode }): React.JSX.Element {
  const s = SEV[severity];
  return (
    <div className={`border-l-2 ${s.bar} ${s.bg} rounded-r px-3.5 py-3`}>
      <div className={`text-[11px] font-semibold uppercase tracking-[0.06em] ${s.text}`}>{severity}</div>
      <div className="mt-1 text-[14.5px] font-medium text-foreground">{title}</div>
      {body && <div className="mt-0.5 text-[13px] text-muted-foreground">{body}</div>}
      {children && <div className="mt-2 flex flex-wrap items-center gap-4">{children}</div>}
    </div>
  );
}

// ── Provenance (Verified / Inferred / Unverified) ───────────────────────────────
/** The 12px meta line under a value: "Verified · Goodshuffle", "Inferred · high confidence", "Unverified". */
export function Provenance({ kind, detail }: { kind: "verified" | "inferred" | "unverified"; detail?: string }): React.JSX.Element {
  const label = kind === "verified" ? "Verified" : kind === "inferred" ? "Inferred" : "Unverified";
  return (
    <div className="mt-px text-[12px] text-tertiary-text">
      {label}
      {detail ? ` · ${detail}` : ""}
    </div>
  );
}

/** A WHAT · IMPACT · NEXT unavailable sentence (never an empty cell / fake 0). */
export function Unavailable({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <p className="text-[12.5px] leading-relaxed text-meta">{children}</p>;
}

// ── Section label ──────────────────────────────────────────────────────────────
export function SectionLabel({ children, className }: { children: React.ReactNode; className?: string }): React.JSX.Element {
  return <div className={`text-[10.5px] uppercase tracking-[0.1em] text-meta ${className ?? ""}`}>{children}</div>;
}
