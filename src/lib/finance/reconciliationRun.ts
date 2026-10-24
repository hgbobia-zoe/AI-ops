// FI Stage 7a — reconciliation-run lifecycle (PURE: no DB, no network, no clock). Takes the CURRENT
// per-project profitability snapshot (projectSnapshot.ts) plus the PRIOR stored run, and produces the new
// run's lifecycle phase + the VARIANCE-VS-PRIOR (what moved on each revenue/cost line, by how much, and a
// deterministic reason tag derived from WHICH inputs moved). This is the honest "profitability settles
// over time" record the compute-on-read snapshot can't give on its own.
//
// Governing laws: RULES CALCULATE, NEVER FABRICATE. A variance is a computed fact (current − prior), never
// a guess; a reason tag is derived from the data that changed, never inferred intent. `final` is reached
// ONLY on real settlement (the snapshot's own RECONCILED gate: all direct cost ACTUAL, revenue fully
// collected, fresh) — we never fabricate "final" while anything is estimated. Missing inputs stay null,
// never zeroed. The run mirrors the append-only, sig-deduped discipline of event_snapshots/labor_snapshots.

import type { ProjectSnapshot, CostFamily } from "./projectSnapshot";
import { COST_FAMILIES } from "./projectSnapshot";

/** snapshot → revision → final. First-ever run = `snapshot`; a later run with deltas = `revision`; `final`
 *  ONLY when the snapshot is RECONCILED (settled). A first run of an already-settled project is `final`. */
export type RunPhase = "snapshot" | "revision" | "final";

/** Why a line moved — a deterministic fact derived from which inputs changed, NOT an inferred motive. */
export type VarianceReason =
  | "late_timesheet" // labor rose/appeared as later shift/timesheet data landed
  | "labor_actualized" // labor went from an estimate to a verified actual (grain lifted)
  | "refund" // revenue (contracted or collected) went DOWN — money credited/returned
  | "payment_received" // collected went UP — a payment landed
  | "revenue_adjustment" // contracted (grand total) went UP — the contract grew
  | "manual_adjustment" // a hand-entered ('manual' source) cost family moved/appeared
  | "new_estimate" // a derived/estimated cost family (transport, fuel, overtime, …) moved/appeared
  | "cost_removed"; // a cost family that had a value is no longer tracked (went unavailable)

/** One changed line in the variance-vs-prior. Only lines that actually MOVED (appeared, disappeared, or
 *  changed beyond a penny) are emitted — an unchanged line is omitted, not listed with a zero delta. */
export interface RunVarianceLine {
  /** Stable machine key: "revenue.contracted" | "revenue.collected" | "cost.<family>". */
  line: string;
  /** Human-free display label. */
  label: string;
  /** Prior run's value (dollars) or null when the line did not exist then. */
  prior: number | null;
  /** This run's value (dollars) or null when the line is no longer tracked. */
  current: number | null;
  /** current − prior, treating an absent side as the change itself (appearance = +current, removal = −prior). */
  delta: number;
  reason: VarianceReason;
}

/** The variance of this run vs the immediately-prior run for the same project. Null `priorSeq` = first run. */
export interface RunVariance {
  priorSeq: number | null;
  priorPhase: RunPhase | null;
  priorCapturedAt: string | null;
  /** Only the lines that moved. Empty = no material change since the prior run (then no run is appended). */
  lines: RunVarianceLine[];
  /** Summary movements (explained by `lines`; not reason-tagged). Null when a side is unknown. */
  revenueDelta: number | null;
  directCostDelta: number | null;
  contributionDelta: number | null;
}

/** The flat, durable figures a run records (a superset snapshot is kept too for exact recompute). */
export interface RunFigures {
  status: ProjectSnapshot["status"];
  revenue: number | null; // contracted/grand total — the contribution basis
  collected: number | null;
  directCost: number | null;
  contribution: number | null;
  marginPct: number | null;
  balanced: boolean;
  residual: number | null;
}

export interface ReconciliationRunResult {
  phase: RunPhase;
  /** Material-figures signature; an identical sig to the prior run means nothing moved → do not append. */
  sig: string;
  figures: RunFigures;
  variance: RunVariance;
  /** True when this run is materially different from the prior (or is the first) → caller should append it. */
  changed: boolean;
}

const EPS = 0.005;
const round2 = (n: number): number => Math.round(n * 100) / 100;

const FAMILY_LABEL: Record<CostFamily, string> = {
  labor: "Labor",
  vehicle: "Vehicle",
  fuel: "Fuel",
  subcontractor: "Subcontractor",
  sub_rental: "Sub-rental",
  consumables: "Consumables",
  event_expense: "Event expense",
  other: "Other",
};

/** The material figures that define a run (dedup basis). A change in ANY of these is a real revision. */
function figuresOf(s: ProjectSnapshot): RunFigures {
  return {
    status: s.status,
    revenue: s.revenue.contracted,
    collected: s.revenue.collected,
    directCost: s.directCost,
    contribution: s.contribution,
    marginPct: s.marginPct,
    balanced: s.reconciliation.balanced,
    residual: s.reconciliation.residual,
  };
}

/** Deterministic signature of a snapshot's material figures (string compare, like event_snapshots.sig).
 *  Includes each cost family's amount+status so a family changing — even at an unchanged direct-cost total
 *  (one up, one down) — is still a revision. */
export function runSig(s: ProjectSnapshot): string {
  const fams = COST_FAMILIES.map((t) => {
    const f = s.costFamilies.find((x) => x.type === t);
    return [t, f?.amount ?? null, f?.status ?? "UNAVAILABLE"];
  });
  return JSON.stringify([s.status, s.revenue.contracted, s.revenue.collected, s.revenue.due, s.directCost, s.contribution, fams]);
}

/** The lifecycle phase. `final` iff the snapshot is settled (RECONCILED) — that gate itself guarantees all
 *  direct cost is ACTUAL, revenue is fully collected and data is fresh, so `final` is never fabricated while
 *  anything is still estimated. Otherwise the first run is `snapshot`, any later run is a `revision`. */
export function derivePhase(s: ProjectSnapshot, hasPrior: boolean): RunPhase {
  if (s.status === "RECONCILED") return "final";
  return hasPrior ? "revision" : "snapshot";
}

/** Reason tag for a cost family that moved. Labor lifts as timesheets land; a 'manual'-source family is a
 *  hand adjustment; a derived/estimated family is a new estimate; a family that lost its value was removed. */
function costReason(family: CostFamily, priorAmount: number | null, current: { amount: number | null; status: string; source: string | null }): VarianceReason {
  if (current.amount == null && priorAmount != null) return "cost_removed";
  if (family === "labor") {
    // Labor that was an estimate and is now actual = the grain was lifted; otherwise more labor landed.
    return current.status === "ACTUAL" ? "labor_actualized" : "late_timesheet";
  }
  return current.source === "manual" ? "manual_adjustment" : "new_estimate";
}

/** Compute the new run (phase + variance-vs-prior) for a project. PURE. `prior` is the immediately-preceding
 *  stored run (its snapshot + seq/phase/capturedAt), or null for the first-ever run. */
export function computeReconciliationRun(args: {
  snapshot: ProjectSnapshot;
  prior: { snapshot: ProjectSnapshot; seq: number; phase: RunPhase; capturedAt: string } | null;
}): ReconciliationRunResult {
  const { snapshot, prior } = args;
  const phase = derivePhase(snapshot, prior != null);
  const sig = runSig(snapshot);
  const figures = figuresOf(snapshot);

  const lines: RunVarianceLine[] = [];
  if (prior) {
    const p = prior.snapshot;

    // ── Revenue lines ──────────────────────────────────────────────────────────────────────────────
    pushRevenueLine(lines, "revenue.contracted", "Revenue (contracted)", p.revenue.contracted, snapshot.revenue.contracted, "contracted");
    pushRevenueLine(lines, "revenue.collected", "Revenue (collected)", p.revenue.collected, snapshot.revenue.collected, "collected");

    // ── Cost-family lines ──────────────────────────────────────────────────────────────────────────
    for (const family of COST_FAMILIES) {
      const pf = p.costFamilies.find((x) => x.type === family);
      const cf = snapshot.costFamilies.find((x) => x.type === family);
      const priorAmt = pf?.amount ?? null;
      const curAmt = cf?.amount ?? null;
      if (!moved(priorAmt, curAmt)) continue;
      lines.push({
        line: `cost.${family}`,
        label: FAMILY_LABEL[family],
        prior: priorAmt,
        current: curAmt,
        delta: deltaOf(priorAmt, curAmt),
        reason: costReason(family, priorAmt, { amount: curAmt, status: cf?.status ?? "UNAVAILABLE", source: cf?.source ?? null }),
      });
    }
  }

  const variance: RunVariance = {
    priorSeq: prior?.seq ?? null,
    priorPhase: prior?.phase ?? null,
    priorCapturedAt: prior?.capturedAt ?? null,
    lines,
    revenueDelta: prior ? pairDelta(prior.snapshot.revenue.contracted, snapshot.revenue.contracted) : null,
    directCostDelta: prior ? pairDelta(prior.snapshot.directCost, snapshot.directCost) : null,
    contributionDelta: prior ? pairDelta(prior.snapshot.contribution, snapshot.contribution) : null,
  };

  // Changed = first-ever run, OR the material signature differs from the prior run. (A phase flip alone, e.g.
  // snapshot→final with no figure change, also differs because status is in the sig.)
  const changed = prior == null || runSig(prior.snapshot) !== sig;

  return { phase, sig, figures, variance, changed };
}

/** A line MOVED when it appeared, disappeared, or changed by more than a penny. */
function moved(prior: number | null, current: number | null): boolean {
  if (prior == null && current == null) return false;
  if (prior == null || current == null) return true;
  return Math.abs(current - prior) >= EPS;
}

/** current − prior, counting an absent side as the full change (appearance = +current, removal = −prior). */
function deltaOf(prior: number | null, current: number | null): number {
  return round2((current ?? 0) - (prior ?? 0));
}

/** Summary delta that stays null unless BOTH sides are known (an aggregate we won't half-invent). */
function pairDelta(prior: number | null, current: number | null): number | null {
  if (prior == null || current == null) return null;
  return round2(current - prior);
}

function pushRevenueLine(out: RunVarianceLine[], line: string, label: string, prior: number | null, current: number | null, which: "contracted" | "collected"): void {
  if (!moved(prior, current)) return;
  const delta = deltaOf(prior, current);
  // contracted up = the contract grew (revenue_adjustment); either revenue going DOWN = a refund/credit;
  // collected up = a payment landed.
  const reason: VarianceReason = delta < 0 ? "refund" : which === "collected" ? "payment_received" : "revenue_adjustment";
  out.push({ line, label, prior, current, delta, reason });
}
