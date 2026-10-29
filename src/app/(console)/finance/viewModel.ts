// Finance blade — pure presentation view-model. No React, no DB, no I/O: just the deterministic
// decisions the /finance page makes about HOW to label and group what the FI engine computed. Kept
// here (not inline in page.tsx) so the honest-labelling rules the blade depends on are unit-tested.
//
// RULES CALCULATE, the presentation only LABELS: nothing in here invents a number. The formatters pass
// null straight through to an em-dash, and the basis/state helpers only describe a value the service
// already produced (never upgrade a planned figure to "actual", never a null to 0).

import type { Tone } from "@/lib/tone";

// ── Formatters (shared by the page + tested here) ─────────────────────────────────────────────────
// money() takes DOLLARS — the DB layer already divided the Goodshuffle cents by 100 (do not re-scale
// here). null → "—" (unavailable), never a fabricated 0. Negative renders as -$N.
export function money(n: number | null | undefined): string {
  if (n == null) return "—";
  return (n < 0 ? "-$" : "$") + Math.abs(Math.round(n)).toLocaleString("en-US");
}
/** A signed dollar delta: always shows the +/− so a variance reads as a direction, not a total. */
export function signedMoney(n: number): string {
  return (n > 0 ? "+" : n < 0 ? "-" : "") + "$" + Math.abs(Math.round(n)).toLocaleString("en-US");
}
export function hrs(n: number | null | undefined): string {
  return n == null ? "—" : `${n} h`;
}
export function pct(n: number | null | undefined): string {
  return n == null ? "—" : `${Math.round(n * 100)}%`;
}

// ── View keys + grouping ─────────────────────────────────────────────────────────────────────────
// Every key stays VALID (so existing deep links never 404 into the overview); the visible local nav is
// a CURATED subset grouped by purpose. "week"/"cycle" historically rendered the identical Overview
// component as "overview" — they are period lenses, not alternate views — so they remain working
// aliases of Overview rather than three identical nav rows.
export const FINANCE_VIEWS = [
  "overview", "week", "cycle", "routes", "projects", "labor",
  "instawork", "variance", "reconciliation", "visits", "insights",
] as const;
export type ViewKey = (typeof FINANCE_VIEWS)[number];

export const VIEW_LABEL: Record<ViewKey, string> = {
  overview: "Overview",
  week: "Week",
  cycle: "Operational Cycle",
  routes: "Routes",
  projects: "Projects",
  labor: "Labor",
  instawork: "Instawork",
  variance: "Variance",
  reconciliation: "Reconciliation",
  visits: "Visits (GPS vs dispatch)",
  insights: "Insights",
};

/** The three analytical sections the blade is organised into (overview / analysis / reconciliation),
 *  so the page is not one undifferentiated dashboard. Each item is a working ?view= deep link. */
export interface ViewNavGroup {
  label: string;
  items: ViewKey[];
}
export const VIEW_NAV_GROUPS: ViewNavGroup[] = [
  { label: "Overview", items: ["overview"] },
  { label: "Analysis", items: ["projects", "routes", "labor", "instawork", "variance", "insights"] },
  { label: "Reconciliation", items: ["reconciliation", "visits"] },
];

/** The nav key that should read as ACTIVE for a given current view. Overview's period-lens aliases
 *  ("week"/"cycle") light the single Overview tab rather than a tab that isn't shown. */
export function navKeyForView(view: ViewKey): ViewKey {
  return view === "week" || view === "cycle" ? "overview" : view;
}

/** True when the given view renders the Overview component (incl. its week/cycle aliases). */
export function isOverviewView(view: ViewKey): boolean {
  return view === "overview" || view === "week" || view === "cycle";
}

export function isViewKey(x: string | undefined | null): x is ViewKey {
  return (FINANCE_VIEWS as readonly string[]).includes(x ?? "");
}

// ── Honest labor headline (the audit's "Labor (planned)" mismatch) ─────────────────────────────────
// The Overview labor card used to be TITLED "Labor (planned)" while its headline actually showed the
// ACTUAL cost whenever one existed (falling back to planned) — so the headline equalled the "Actual"
// row and the title lied. The data is right; the LABEL was wrong. This resolves it deterministically:
// the card states the basis of the number it is actually showing (Actual when timesheets priced out,
// else Planned when a schedule priced out, else Unavailable — never 0).
export interface LaborHeadline {
  amount: number | null;
  /** Accounting basis of the headline number — what it actually represents. */
  basis: "actual" | "planned" | "unavailable";
  basisLabel: string;
  basisDetail: string;
  /** Verification/estimate state for the status indicator. */
  state: { tone: Tone; label: string };
}

export function laborHeadline(labor: {
  plannedCost: number | null;
  actualCost: number | null;
  rateStatus: string;
}): LaborHeadline {
  if (labor.actualCost != null) {
    return {
      amount: labor.actualCost,
      basis: "actual",
      basisLabel: "Actual",
      basisDetail: "Connecteam timesheets × pay rate",
      state: { tone: "positive", label: "Actual" },
    };
  }
  if (labor.plannedCost != null) {
    return {
      amount: labor.plannedCost,
      basis: "planned",
      basisLabel: "Planned",
      basisDetail: "Connecteam schedule × pay rate",
      state: { tone: "attention", label: "Planned, not yet actual" },
    };
  }
  return {
    amount: null,
    basis: "unavailable",
    basisLabel: "Unavailable",
    basisDetail: labor.rateStatus === "UNAVAILABLE" ? "Connecteam labor not retrieved" : "No priced hours yet",
    state: { tone: "neutral", label: "Unavailable" },
  };
}

// ── Per-project snapshot status → shared tone ──────────────────────────────────────────────────────
// RECONCILED (all cost actual + revenue collected) → positive; ESTIMATED (priced, some estimate) →
// info/syncing (still settling); PROVISIONAL (early, estimate-heavy) → attention.
export function snapshotStatusTone(status: "RECONCILED" | "ESTIMATED" | "PROVISIONAL"): Tone {
  return status === "RECONCILED" ? "positive" : status === "ESTIMATED" ? "info" : "attention";
}

// ── Reconciliation-run phase → shared tone (lifecycle, not a health status) ─────────────────────────
export function phaseTone(phase: "snapshot" | "revision" | "final"): Tone {
  return phase === "final" ? "positive" : phase === "revision" ? "attention" : "neutral";
}

// ── Variance direction → indicator ──────────────────────────────────────────────────────────────────
// A variance carries a DIRECTION (favorable / unfavorable / flat). Per the Nocturne status model the
// dollar value stays the high-contrast foreground; the colour + meaning ride a small indicator, never
// the number itself. favorable=null → unknown (one side missing) → neutral.
export function varianceTone(favorable: boolean | null): Tone {
  if (favorable == null) return "neutral";
  return favorable ? "positive" : "critical";
}
