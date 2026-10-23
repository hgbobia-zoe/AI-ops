// Financial Intelligence — per-project profitability snapshot (compute-on-read). PURE: no DB, no
// network, no clock. Takes already-read inputs (the bookings revenue row + a cost-family rollup of
// cost_entries) and returns a serializable snapshot. This is the first build of the Profitability &
// Operational Intelligence capability (Stage-1 audit "Recommended first PR"): it EXTENDS the existing
// FI engine — it does NOT persist anything. There is intentionally NO project_financials table and NO
// migration in this PR; the snapshot is a deterministic, recomputable rollup over the ledger already
// written every scan. See the "PERSISTENCE SEAM" note below for where a stored snapshot would later go.
//
// Governing laws enforced here: RULES CALCULATE, AI INTERPRETS, NEVER FABRICATE. Money is plain
// dollars. A cost family the ledger does not yet write stays UNAVAILABLE (null) and is labeled
// not-yet-tracked — NEVER zeroed (zeroing an unknown cost would fake an inflated contribution). No
// double-counting. The rollup reconciles: the cost-family parts sum back to the direct-cost total.

import { contribution, contributionMargin, sumKnown, type MoneyStatus } from "./calc";

/** The cost-family taxonomy the `cost_entries` ledger supports (index.ts:515). Today only `labor` is
 *  ever written (by the worker→route→stop→project cascade); every other family is schema-ready but
 *  unwritten, so it honestly reports UNAVAILABLE here — later stages (sub_rental/fuel/vehicle/…) will
 *  start writing rows and those families light up automatically, no change to this module. */
export const COST_FAMILIES = [
  "labor",
  "vehicle",
  "fuel",
  "subcontractor",
  "sub_rental",
  "consumables",
  "event_expense",
  "other",
] as const;
export type CostFamily = (typeof COST_FAMILIES)[number];

/** A cost family's status is the HONEST floor across its leaves: any estimated leaf makes the family
 *  ESTIMATED; only an all-actual family is ACTUAL; no known leaf = UNAVAILABLE (never a 0). */
export type CostStatus = "ACTUAL" | "ESTIMATED" | "UNAVAILABLE";

/** Overall profit-confidence of a project snapshot. PROVISIONAL = data is stale (office-pull cadence)
 *  or there is no cost evidence yet; ESTIMATED = fresh but some direct cost is still estimated
 *  (today labor is PLANNED-grain) or revenue is not fully collected; RECONCILED = every direct cost
 *  is ACTUAL, revenue is fully collected, and the data is fresh. See `deriveStatus` for the exact rule. */
export type ProjectSnapshotStatus = "PROVISIONAL" | "ESTIMATED" | "RECONCILED";

/** Raw revenue from the `bookings` SoT (dollars). Fees/discounts/refunds are NOT separated upstream
 *  (Stage 3) — we do not invent them; the snapshot flags `componentsTracked: false`. */
export interface RevenueInput {
  /** grand_total — the contracted/grand total; the revenue basis for contribution. */
  grandTotal: number | null;
  /** contract_total — Goodshuffle's pre-discount subtotal (shown for context, not the contribution basis). */
  contractTotal: number | null;
  /** amount_paid — money actually collected (a real figure, so ACTUAL even when 0). */
  amountPaid: number | null;
  /** amount_due — outstanding receivable. */
  amountDue: number | null;
  /** Signed contract vs an unsigned quote. */
  signed: boolean;
}

/** One rolled-up cost family for a project (summed over its `cost_entries` DIRECT leaves). Produced by
 *  the thin repo reader; absent families are filled in as UNAVAILABLE by `projectSnapshot`. */
export interface CostFamilyInput {
  type: CostFamily;
  /** Σ of known (ACTUAL+ESTIMATED) leaf amounts in dollars; null when no known leaf. */
  amount: number | null;
  status: CostStatus;
  /** Best/most-honest attribution method across the leaves (labor only today); null otherwise. */
  method?: string | null;
  confidence?: string | null;
  /** How many ledger leaves fed this family (lineage/debug; 0 for untracked). */
  leafCount?: number;
}

export interface ProjectSnapshotInput {
  projectId: string;
  label: string;
  eventDate?: string | null;
  revenue: RevenueInput;
  /** Cost families that have ledger rows. Families NOT present are reported UNAVAILABLE (never 0). */
  costFamilies: CostFamilyInput[];
  /** ISO timestamp of the last pull that could have refreshed this project's revenue (bookings.updated_at). */
  revenueAsOf?: string | null;
  /** True when the revenue data is older than the staleness threshold (office-pull cadence). Computed by
   *  the assembler (needs a clock); passed in to keep this function pure. Defaults to false. */
  stale?: boolean;
}

export interface ProjectRevenue {
  /** Contracted/grand total — the contribution basis. */
  contracted: number | null;
  contractedStatus: MoneyStatus;
  /** Pre-discount subtotal (context only). */
  subtotal: number | null;
  /** Collected to date. */
  collected: number | null;
  collectedStatus: MoneyStatus;
  /** Outstanding receivable. */
  due: number | null;
  dueStatus: MoneyStatus;
  signed: boolean;
  /** True once revenue is fully collected (amount_due ≈ 0, or paid ≥ contracted). */
  fullyCollected: boolean;
  /** Fees, discounts and refunds are NOT separated in the data today (Stage 3). Honest, not zeroed. */
  componentsTracked: false;
}

export interface CostFamilyLine {
  type: CostFamily;
  /** Dollars; null when UNAVAILABLE — an untracked family is NEVER rendered as 0. */
  amount: number | null;
  status: CostStatus;
  method: string | null;
  confidence: string | null;
  /** False = schema-ready but nothing writes this family yet (reported UNAVAILABLE, not 0). */
  tracked: boolean;
  leafCount: number;
}

/** Proof the cost-family parts sum back to the direct-cost total (mirrors the labor engine's
 *  ReconciliationRow discipline). `residual` must be ~0 and `balanced` true by construction — it is
 *  surfaced, not hidden, so a future family that breaks the partition is caught. */
export interface ProjectReconciliation {
  directCostTotal: number | null;
  familySum: number | null;
  residual: number | null;
  balanced: boolean;
}

export interface ProjectSnapshot {
  projectId: string;
  label: string;
  eventDate: string | null;
  revenue: ProjectRevenue;
  /** Every family in the taxonomy, in display order; untracked ones are UNAVAILABLE. */
  costFamilies: CostFamilyLine[];
  /** Σ of KNOWN direct cost families (today: customer-bucket labor). Null when no cost is known. */
  directCost: number | null;
  directCostStatus: CostStatus;
  /** contracted − directCost. Null when either side is unknown (an unknown cost is NOT zero). */
  contribution: number | null;
  contributionStatus: CostStatus;
  marginPct: number | null;
  status: ProjectSnapshotStatus;
  /** Deterministic, human-readable reason for `status` (RULES CALCULATE — no AI here). */
  statusReason: string;
  reconciliation: ProjectReconciliation;
  revenueAsOf: string | null;
  stale: boolean;
  /** Honest gaps surfaced for the UI (untracked families, estimated grain, uncollected revenue, staleness). */
  notes: string[];
}

const round2 = (n: number): number => Math.round(n * 100) / 100;
const EPS = 0.005;

/** Build a per-project profitability snapshot from pre-read inputs. Pure + deterministic. */
export function projectSnapshot(input: ProjectSnapshotInput): ProjectSnapshot {
  const { projectId, label, revenue } = input;
  const eventDate = input.eventDate ?? null;
  const revenueAsOf = input.revenueAsOf ?? null;
  const stale = input.stale ?? false;

  // ── Revenue (bookings SoT). A quote is not committed revenue → PROJECTED, not SIGNED. Collected
  //    money is a real figure (ACTUAL even at 0). Missing figures are UNAVAILABLE, never 0.
  const contracted = revenue.grandTotal;
  const contractedStatus: MoneyStatus = contracted == null ? "UNAVAILABLE" : revenue.signed ? "SIGNED" : "PROJECTED";
  const collected = revenue.amountPaid;
  const collectedStatus: MoneyStatus = collected == null ? "UNAVAILABLE" : "ACTUAL";
  const due = revenue.amountDue;
  const dueStatus: MoneyStatus = due == null ? "UNAVAILABLE" : revenue.signed ? "SCHEDULED" : "PROJECTED";
  // Fully collected: prefer amount_due when known, else paid ≥ contracted. Cannot prove → false.
  const fullyCollected =
    due != null ? due <= EPS : collected != null && contracted != null ? collected >= contracted - EPS : false;

  // ── Cost families — merge the ledger rollup with the full taxonomy; absent families = UNAVAILABLE.
  const byType = new Map<string, CostFamilyInput>();
  for (const f of input.costFamilies) byType.set(f.type, f);
  const costFamilies: CostFamilyLine[] = COST_FAMILIES.map((type) => {
    const f = byType.get(type);
    const known = f != null && f.amount != null && f.status !== "UNAVAILABLE";
    return {
      type,
      amount: known ? round2(f!.amount as number) : null,
      status: known ? f!.status : "UNAVAILABLE",
      method: f?.method ?? null,
      confidence: f?.confidence ?? null,
      tracked: known,
      leafCount: f?.leafCount ?? 0,
    };
  });

  // ── Direct cost = Σ of KNOWN families. sumKnown returns null only when EVERY family is unknown, so
  //    an all-untracked project has an UNAVAILABLE direct cost (never a fake 0 → never a fake 100% margin).
  const directCost = sumKnown(costFamilies.map((f) => f.amount));
  const anyEstimated = costFamilies.some((f) => f.status === "ESTIMATED");
  const anyActual = costFamilies.some((f) => f.status === "ACTUAL");
  const directCostStatus: CostStatus = directCost == null ? "UNAVAILABLE" : anyEstimated ? "ESTIMATED" : "ACTUAL";

  // ── Contribution = contracted − directCost (calc helper: null if EITHER side unknown — never zeroed).
  const contributionVal = contribution(contracted, directCost);
  const marginPct = contributionMargin(contracted, directCost);
  const contributionStatus: CostStatus = contributionVal == null ? "UNAVAILABLE" : anyEstimated ? "ESTIMATED" : "ACTUAL";

  // ── Reconciliation: the family parts sum back to the direct-cost total (expect residual 0).
  const familySum = sumKnown(costFamilies.map((f) => f.amount));
  const residual = directCost != null && familySum != null ? round2(directCost - familySum) : null;
  const reconciliation: ProjectReconciliation = {
    directCostTotal: directCost,
    familySum,
    residual,
    balanced: residual == null ? directCost == null && familySum == null : Math.abs(residual) < EPS,
  };

  const { status, statusReason } = deriveStatus({
    directCost,
    anyActual,
    anyEstimated,
    fullyCollected,
    revenueKnown: contracted != null,
    stale,
  });

  // ── Honest notes (surfaced gaps — labels, never invented numbers).
  const notes: string[] = [];
  const untracked = costFamilies.filter((f) => !f.tracked).map((f) => f.type);
  if (untracked.length > 0) {
    notes.push(
      `Cost families not tracked yet (reported unavailable, not zero): ${untracked.join(", ")}. Only labor is written to the ledger today, so this profit is a labor-only contribution — later stages add sub-rental, transport/fuel, overtime and manual adjustments.`,
    );
  }
  if (anyEstimated) notes.push("Labor is attributed at planned grain (method PLANNED/Derived) → direct cost is ESTIMATED, not a verified actual.");
  if (contracted != null && !fullyCollected) notes.push("Revenue is contracted but not fully collected — contribution is not yet realized cash.");
  if (stale) notes.push("Revenue data may be stale (Goodshuffle is pulled about once a day) — figures are provisional until the next pull.");
  if (directCost == null) notes.push("No direct cost is attributed to this project yet — contribution is unavailable, not zero.");
  notes.push("Fees, discounts and refunds are not separated in the data today — revenue is the Goodshuffle grand total as pulled.");

  return {
    projectId,
    label,
    eventDate,
    revenue: {
      contracted,
      contractedStatus,
      subtotal: revenue.contractTotal,
      collected,
      collectedStatus,
      due,
      dueStatus,
      signed: revenue.signed,
      fullyCollected,
      componentsTracked: false,
    },
    costFamilies,
    directCost,
    directCostStatus,
    contribution: contributionVal,
    contributionStatus,
    marginPct,
    status,
    statusReason,
    reconciliation,
    revenueAsOf,
    stale,
    notes,
  };
}

/**
 * The overall status rule (deterministic). Precedence:
 *   1. No cost evidence (directCost unknown)   → PROVISIONAL — profit cannot even be estimated.
 *   2. Stale data (office-pull cadence)         → PROVISIONAL — figures can't be trusted as current.
 *   3. All direct cost ACTUAL AND fully collected AND fresh → RECONCILED.
 *   4. Otherwise                                → ESTIMATED — fresh, but cost is estimated and/or revenue uncollected.
 * RECONCILED is intentionally unreachable while labor is PLANNED-grain (always ESTIMATED today) — the
 * audit says so, and labeling it anything stronger would fabricate confidence we don't have.
 */
function deriveStatus(x: {
  directCost: number | null;
  anyActual: boolean;
  anyEstimated: boolean;
  fullyCollected: boolean;
  revenueKnown: boolean;
  stale: boolean;
}): { status: ProjectSnapshotStatus; statusReason: string } {
  if (x.directCost == null) return { status: "PROVISIONAL", statusReason: "No direct cost attributed yet — profit cannot be estimated." };
  if (x.stale) return { status: "PROVISIONAL", statusReason: "Revenue data may be stale (once-a-day Goodshuffle pull)." };
  const allActual = x.anyActual && !x.anyEstimated;
  if (allActual && x.revenueKnown && x.fullyCollected) {
    return { status: "RECONCILED", statusReason: "All direct cost is actual and revenue is fully collected." };
  }
  if (x.anyEstimated) return { status: "ESTIMATED", statusReason: "Some direct cost is estimated (labor at planned grain)." };
  if (!x.fullyCollected) return { status: "ESTIMATED", statusReason: "Revenue is contracted but not fully collected." };
  return { status: "ESTIMATED", statusReason: "Direct cost is actual but completeness of cost families is not yet verified." };
}

// PERSISTENCE SEAM (later stage): to store a snapshot (e.g. a project_financials table) for history and
// late-data reconciliation, persist this exact serializable ProjectSnapshot plus a computed_at, keyed by
// projectId — the shape is the contract. This PR deliberately stays compute-on-read: no new table, no
// migration, always recomputable from cost_entries + bookings.
