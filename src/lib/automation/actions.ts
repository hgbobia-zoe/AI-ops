// Controlled Automation (MVP8) — pure action proposer. OBSERVE MODE: it turns the signals the
// other systems already computed into a structured list of actions the platform WOULD take, with
// the intended handling tier + reversibility. It executes NOTHING. Wiring real execution is a
// separate, explicitly gated step (see the automation page banner).

export type Tier = "observe" | "recommend" | "prepare" | "approve" | "auto";
export type Target = "dispatch" | "connecteam" | "goodshuffle" | "slack" | "internal";

export interface ProposedAction {
  key: string; // stable + idempotent per underlying signal
  tier: Tier;
  target: Target;
  actionType: string;
  title: string; // imperative, e.g. "Assign a driver to this route"
  detail: string;
  reversible: boolean;
  outward: boolean; // touches customers or the external commercial system
  severity?: string;
  date?: string;
  eventId?: string;
  routeId?: string;
}

// Conservative defaults per target: consequential/outward work is "approve" (a human must say yes
// before it ever runs); an internal data refresh is safe enough to eventually automate ("observe"
// now, "auto" candidate later). These are INTENDED tiers — nothing acts on them in observe mode.
const TARGET_RULE: Record<Target, { tier: Tier; outward: boolean; reversible: boolean }> = {
  dispatch: { tier: "approve", outward: false, reversible: true },
  connecteam: { tier: "approve", outward: false, reversible: true },
  goodshuffle: { tier: "approve", outward: true, reversible: true },
  slack: { tier: "auto", outward: false, reversible: true },
  internal: { tier: "observe", outward: false, reversible: true },
};

function actionTypeFor(riskType: string): string {
  if (riskType === "route_no_driver") return "assign_driver";
  if (riskType === "driver_double_booked") return "reassign_driver";
  if (riskType.startsWith("driver_")) return "schedule_or_reassign_driver";
  if (riskType === "unload_shortage") return "schedule_unload_crew";
  if (riskType === "setup_crew_shortage" || riskType === "warehouse_shortage") return "schedule_crew";
  if (riskType === "route_schedule_unverified") return "add_windows";
  if (riskType === "staffing_unverified") return "recheck_connecteam";
  return "review";
}

export interface RiskLike {
  signature: string;
  riskType: string;
  severity: string;
  title: string;
  description: string;
  recommendedAction?: string;
  actionTarget?: string;
  date?: string;
  eventId?: string;
  routeId?: string;
}

/** One proposed action per active risk that recommends one. Idempotent key = the risk signature. */
export function proposeFromRisks(risks: RiskLike[]): ProposedAction[] {
  const out: ProposedAction[] = [];
  for (const r of risks) {
    if (!r.recommendedAction) continue; // only risks with a concrete recommended action
    const target = (["dispatch", "connecteam", "goodshuffle", "slack", "internal"].includes(r.actionTarget ?? "")
      ? r.actionTarget
      : "internal") as Target;
    const rule = TARGET_RULE[target];
    // staffing_unverified is a pure data refresh — override to the safest tier regardless of target.
    const isRefresh = r.riskType === "staffing_unverified";
    out.push({
      key: `risk|${r.signature}`,
      tier: isRefresh ? "observe" : rule.tier,
      target: isRefresh ? "internal" : target,
      actionType: actionTypeFor(r.riskType),
      title: r.recommendedAction,
      detail: r.description,
      reversible: rule.reversible,
      outward: isRefresh ? false : rule.outward,
      severity: r.severity,
      date: r.date,
      eventId: r.eventId,
      routeId: r.routeId,
    });
  }
  return out;
}

/** A review action per near-term booking gap. Internal, non-outward, recommend tier. */
export function proposeFromGaps(gaps: { label: string }[]): ProposedAction[] {
  return gaps.map((g) => ({
    key: `gap|${g.label}`,
    tier: "recommend" as Tier,
    target: "internal" as Target,
    actionType: "review_booking_gap",
    title: `Review the empty week of ${g.label}`,
    detail: "A near-term week has no booked events. Confirm nothing is missing from the board before it's too late to fill.",
    reversible: true,
    outward: false,
  }));
}

const TIER_ORDER: Record<Tier, number> = { approve: 0, prepare: 1, recommend: 2, auto: 3, observe: 4 };
const SEV_ORDER: Record<string, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };

/** Stable display order: most-consequential tier first, then by severity, then title. */
export function orderProposals(props: ProposedAction[]): ProposedAction[] {
  return [...props].sort(
    (a, b) =>
      TIER_ORDER[a.tier] - TIER_ORDER[b.tier] ||
      (SEV_ORDER[a.severity ?? "LOW"] ?? 3) - (SEV_ORDER[b.severity ?? "LOW"] ?? 3) ||
      a.title.localeCompare(b.title),
  );
}
