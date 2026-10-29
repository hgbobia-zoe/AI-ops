// Shared chart tokens (Nocturne). The single source of truth for colouring data visualisations so
// every chart in the console is legible and consistent in both themes.
//
// Two SEPARATE languages — do not mix them:
//   • CATEGORICAL series  → the ordered `--chart-1..5` ramp. Stable by index: the first series is
//     always --chart-1, so the same category keeps its colour across charts and reloads.
//   • SEMANTIC status      → the status tokens (positive/attention/critical/info). Use these ONLY
//     when a mark MEANS a state (e.g. a "blocked" bar), never as a 6th category colour.
//
// The ramp is intentionally the Nocturne grayscale (+ gold reserved for the Command Center accent):
// it keeps dashboards calm and on-brand rather than rainbow. For >5 categories, group the tail into
// an "Other" bucket instead of inventing colours — more than ~5 series is rarely readable anyway.
//
// All values are CSS custom-property references, so they theme automatically. Pass them to inline
// styles (fill/stroke/background) or read them in canvas charts via getComputedStyle.

/** Ordered categorical ramp. Index 0-based; wraps if you exceed its length (prefer grouping). */
export const CHART_CATEGORY = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
] as const;

/** Colour for the i-th categorical series (stable by index). */
export function categoryColor(i: number): string {
  return CHART_CATEGORY[((i % CHART_CATEGORY.length) + CHART_CATEGORY.length) % CHART_CATEGORY.length];
}

/** Semantic status marks — use only when the mark encodes a state. */
export const CHART_STATUS = {
  positive: "var(--positive)",
  attention: "var(--attention)",
  critical: "var(--critical)",
  info: "var(--info)",
  neutral: "var(--text-meta)",
} as const;

/** The Command Center accent mark (Zoe gold). Scoped to the dashboard per the brand handoff. */
export const CHART_ACCENT = "var(--gold)";

/** Chart chrome — axes, gridlines, labels. Keeps marks readable without competing with them. */
export const CHART_CHROME = {
  grid: "var(--grid-rule)",
  axis: "var(--border)",
  label: "var(--text-meta)",
  /** Legend/tooltip surface + text (match the raised panel so tooltips read above the plot). */
  tooltipBg: "var(--lifted)",
  tooltipText: "var(--foreground)",
  tooltipBorder: "var(--border)",
} as const;

export type ChartStatus = keyof typeof CHART_STATUS;
