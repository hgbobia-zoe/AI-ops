// Payroll navigation URL helpers — PURE so the nested sidebar sub-nav (ConsoleNav) and the blade's period
// selector (page header) build identical, deep-linkable URLs AND so the deep-link / active-state behaviour is
// unit-testable without a DOM. Rules preserved: payroll targets COMPLETED weeks (weeksAgo 1–8, default 1,
// omitted when 1); the bare blade path is the Overview tab; the selected period is carried across sub-sections.

export const PAYROLL_PATH = "/payroll";

/** Normalize a raw ?weeksAgo into 1–8 (default 1). Matches the page's period resolution exactly. */
export function clampWeeksAgo(raw: string | number | null | undefined): number {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 1 ? Math.min(8, Math.floor(n)) : 1;
}

/** The query fragment that preserves the selected period (empty for the default last-completed week). */
export function periodQS(weeksAgo: number): string {
  return weeksAgo > 1 ? `weeksAgo=${weeksAgo}` : "";
}

/** Href for a payroll sub-section ("overview" = the bare blade path), carrying the selected period. */
export function payrollSubHref(bladeHref: string, tab: string, weeksAgo: number): string {
  const qs = periodQS(weeksAgo);
  if (tab === "overview") return qs ? `${bladeHref}?${qs}` : bladeHref;
  return `${bladeHref}?tab=${tab}${qs ? `&${qs}` : ""}`;
}

/** Is a sub-section the active one? Active = on the blade's own path AND the current ?tab matches (bare ⇒
 *  "overview"). Path-only matching keeps back/forward + refresh + deep links lit correctly. */
export function payrollSubActive(pathname: string, currentTab: string | null, bladeHref: string, tab: string): boolean {
  return pathname === bladeHref && (currentTab || "overview") === tab;
}

/** Href for the period selector / history (same tab, stepped period). */
export function periodNavHref(tab: string, weeksAgo: number): string {
  return `${PAYROLL_PATH}?tab=${tab}${weeksAgo > 1 ? `&weeksAgo=${weeksAgo}` : ""}`;
}
