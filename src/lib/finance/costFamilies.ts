// Financial Intelligence — Stage 5: cost families BEYOND labor. PURE deterministic estimators + the
// manual-entry validator. No DB, no network, no clock. Each estimator returns `CostEntryInput[]` (the
// SAME ledger-row shape the labor cascade writes via allocation.ts), so a thin repo writer persists them
// and the already-shipped per-project snapshot (projectSnapshot.ts, PR #125) rolls them up unchanged.
//
// GOVERNING LAWS enforced here (RULES CALCULATE, AI INTERPRETS, NEVER FABRICATE):
//   • Missing input → emit NO row (the family stays UNAVAILABLE in the snapshot), NEVER a 0.
//   • Money is plain dollars. Every row carries an honest amount_status + a plain-language note.
//   • No double-count: these families use DISTINCT `type`s and DISTINCT `source_ref` prefixes from the
//     labor cascade (`labor:` / `driver-labor:`), so a derived estimate can never overlap attributed
//     labor, and re-running is an idempotent upsert on the unique source_ref.
//
// Status note — PROVISIONAL vs ESTIMATED: the ledger's leaf `amount_status` is ACTUAL | ESTIMATED |
// UNAVAILABLE (allocation.ts `AmountStatus`), and the shipped snapshot rollup only sums ACTUAL/ESTIMATED
// leaves. A "PROVISIONAL" value (overtime at period grain, extra-trip inferred from history) is therefore
// stored as ESTIMATED so it is visible and summed, with the provisional nature carried in `confidence:'LOW'`
// + the note — never a stronger label than the data supports. See the PR "Honest gaps" for this decision.

import type { CostEntryInput } from "./allocation";

const round2 = (n: number): number => Math.round(n * 100) / 100;

// ── Manual adjustment (G9) — a human-entered, ACTUAL cost on a project ───────────────────────────────

/** The cost types a human may add manually. `labor` is intentionally EXCLUDED: labor is the derived
 *  worker→route→stop→project cascade's domain, and a hand-keyed labor row would blur the attribution
 *  honesty (and risk double-counting the cascade). Sub-rental (G4) lives here — there is no structured
 *  line-item price source (titles only, audit §2.5), so sub-rental is populated via this manual path. */
export const MANUAL_COST_TYPES = [
  "sub_rental",
  "subcontractor",
  "vehicle",
  "fuel",
  "consumables",
  "event_expense",
  "other",
] as const;
export type ManualCostType = (typeof MANUAL_COST_TYPES)[number];

export interface ManualCostInput {
  eventId: string;
  type: string;
  class: string;
  amount: number | null;
  note?: string | null;
}

export interface ManualCostValue {
  eventId: string;
  type: ManualCostType;
  klass: "DIRECT" | "OVERHEAD";
  amount: number;
  note: string | null;
}

/** Validate + normalize a manual cost entry. Pure — returns an error reason instead of throwing so the
 *  route can map it to a 400. A manual entry is a real number a human stands behind → it becomes an
 *  ACTUAL ledger row (see `manualCostEntry`). */
export function validateManualCost(raw: ManualCostInput): { ok: true; value: ManualCostValue } | { ok: false; error: string } {
  const eventId = typeof raw.eventId === "string" ? raw.eventId.trim() : "";
  if (!eventId) return { ok: false, error: "event_id_required" };
  if (typeof raw.type !== "string" || !(MANUAL_COST_TYPES as readonly string[]).includes(raw.type)) {
    return { ok: false, error: "invalid_type" };
  }
  if (raw.class !== "DIRECT" && raw.class !== "OVERHEAD") return { ok: false, error: "invalid_class" };
  if (raw.amount == null || !Number.isFinite(raw.amount)) return { ok: false, error: "invalid_amount" };
  const note = typeof raw.note === "string" ? raw.note.trim().slice(0, 500) || null : null;
  return {
    ok: true,
    value: { eventId, type: raw.type as ManualCostType, klass: raw.class, amount: round2(raw.amount), note },
  };
}

/** Build the ledger row for a validated manual entry. `sourceRef` is supplied by the caller (stable per
 *  entry) so an edit is an idempotent upsert and a delete targets exactly this row. ACTUAL: a human
 *  entered a real figure (amount_status reflects the DOLLARS, not an attribution method). */
export function manualCostEntry(v: ManualCostValue, sourceRef: string, actorLabel: string): CostEntryInput {
  return {
    type: v.type,
    class: v.klass,
    eventId: v.eventId,
    amount: v.amount,
    amountStatus: "ACTUAL",
    source: "manual",
    sourceRef,
    note: v.note ? `${v.note} (manual entry by ${actorLabel})` : `Manual entry by ${actorLabel}`,
    method: "ACTUAL_STOP",
    confidence: "HIGH",
  };
}

// ── Transport / fuel estimate (G6) — distance × a config cost-per-mile ───────────────────────────────
// This is a COST estimate, NOT the customer delivery PRICE. The /pricing per-leg formula prices what Zoe
// CHARGES; equating that with cost would fabricate. Instead we cost the real driven distance at a
// config fuel/vehicle $/mi knob (never a magic number). No odometer/fuel-receipt source exists, so the
// row is honestly ESTIMATED, LOW confidence.

export interface TransportLeg {
  eventId: string;
  /** Round-trip miles warehouse ↔ event site for this project on the route. null = not geocodable → OMIT. */
  roundTripMiles: number | null;
}

export interface TransportInput {
  routeId: string;
  day: string;
  /** Dollars of fuel+vehicle wear per mile. <= 0 disables the family (emits nothing). */
  costPerMile: number;
  legs: TransportLeg[];
}

/** Per-project transport/fuel ESTIMATE for one route-day. A leg with no distance (un-geocoded address)
 *  emits NO row (UNAVAILABLE), never a 0. */
export function estimateTransportCost(input: TransportInput): CostEntryInput[] {
  if (!(input.costPerMile > 0)) return [];
  const out: CostEntryInput[] = [];
  for (const leg of input.legs) {
    if (leg.roundTripMiles == null || !(leg.roundTripMiles > 0)) continue; // UNAVAILABLE → omit
    const miles = round2(leg.roundTripMiles);
    out.push({
      type: "fuel",
      class: "DIRECT",
      eventId: leg.eventId,
      routeId: input.routeId,
      day: input.day,
      amount: round2(miles * input.costPerMile),
      amountStatus: "ESTIMATED",
      source: "derived",
      sourceRef: `fuel:${input.routeId}:${leg.eventId}:${input.day}`,
      note: `Transport/fuel estimate: ${miles} mi round-trip (warehouse↔site) × $${input.costPerMile}/mi. ESTIMATED — no odometer/fuel-receipt source.`,
      method: "ESTIMATED",
      confidence: "LOW",
    });
  }
  return out;
}

// ── Overtime premium (G8) — the PREMIUM DELTA only, distributed across a worker's projects ───────────
// Base hours are already costed by the labor cascade at the straight rate; this adds only the EXTRA
// (e.g. the +0.5× of time-and-a-half). It therefore cannot double-count the base. Overtime is known only
// at period grain (hr_time_entries), so attribution to projects is PROVISIONAL (stored ESTIMATED,
// confidence LOW): the premium is split across the worker's attributed customer-labor by each project's
// share of that labor.

export interface OtProjectShare {
  eventId: string;
  /** The worker's attributed customer-labor $ on this project in the period (the weighting basis). */
  laborCost: number;
}

export interface OvertimeInput {
  /** cost_entries.worker_ref of the worker (e.g. "ct:1234"). */
  workerRef: string;
  periodStart: string;
  periodEnd: string;
  /** Overtime hours in the period. null/<=0 → no premium. */
  overtimeHours: number | null;
  /** The worker's $/h (from the labor ledger). null/<=0 → cannot cost → no row. */
  rate: number | null;
  /** Premium fraction of the base rate (0.5 = the +50% of time-and-a-half). From config. */
  premiumMultiplier: number;
  shares: OtProjectShare[];
}

/** Overtime-premium rows for one worker/period, distributed across projects by labor share. Penny-true
 *  (the rounding residual lands on the last share) so Σ parts === the computed premium. Emits NOTHING
 *  when OT, rate, or any project share is missing (UNAVAILABLE, never 0). */
export function estimateOvertimePremium(input: OvertimeInput): CostEntryInput[] {
  const { overtimeHours, rate, premiumMultiplier, shares, workerRef, periodStart, periodEnd } = input;
  if (overtimeHours == null || !(overtimeHours > 0)) return [];
  if (rate == null || !(rate > 0)) return [];
  if (!(premiumMultiplier > 0)) return [];
  const positive = shares.filter((s) => s.laborCost > 0);
  const totalShare = positive.reduce((a, s) => a + s.laborCost, 0);
  if (positive.length === 0 || !(totalShare > 0)) return [];

  const premiumTotal = round2(overtimeHours * rate * premiumMultiplier);
  if (!(premiumTotal > 0)) return [];

  const out: CostEntryInput[] = [];
  let allocated = 0;
  positive.forEach((s, i) => {
    const isLast = i === positive.length - 1;
    const part = isLast ? round2(premiumTotal - allocated) : round2((premiumTotal * s.laborCost) / totalShare);
    allocated = round2(allocated + part);
    if (!(part > 0)) return;
    out.push({
      type: "other",
      class: "DIRECT",
      eventId: s.eventId,
      amount: part,
      amountStatus: "ESTIMATED", // conceptually PROVISIONAL — see the module header; LOW confidence carries it
      rate,
      source: "derived",
      sourceRef: `ot-premium:${workerRef}:${periodStart}:${s.eventId}`,
      note: `Overtime premium (PROVISIONAL, period ${periodStart}..${periodEnd}): ${round2(overtimeHours)}h OT × $${rate}/h × ${premiumMultiplier} premium, allocated by this project's share of the worker's attributed labor. Premium delta only — base hours are not double-counted.`,
      workerKind: "internal",
      workerRef,
      bucket: "customer",
      method: "ESTIMATED",
      confidence: "LOW",
    });
  });
  return out;
}

// ── Extra-trip / repeat-trip cost (G7) — a second (or later) trip of the same kind for a project ─────
// Detect-from-rules ONLY: a project's FIRST delivery (and FIRST pickup) is the planned baseline; a later
// trip of the SAME kind on a different date is a repeat/unplanned trip (e.g. a return/redelivery). We
// never assert a trip the data doesn't show — the trip genuinely occurred in stop history. Cost = the
// transport estimate for that trip. ESTIMATED, LOW confidence (cannot distinguish a planned phased
// delivery from an unplanned return).

export interface TripRecord {
  eventId: string;
  routeId?: string;
  day: string;
  kind: "delivery" | "pickup";
  /** Round-trip miles for this trip. null = not geocodable → the extra trip is detected but NOT costed. */
  roundTripMiles: number | null;
}

export interface ExtraTripInput {
  /** Trips occurring on the day(s) currently being (re)computed. */
  trips: TripRecord[];
  /** Earliest date (YYYY-MM-DD) this project had a trip of the given kind, across ALL history. null = none. */
  firstKindDate: (eventId: string, kind: "delivery" | "pickup") => string | null;
  costPerMile: number;
}

/** Cost rows for repeat/unplanned trips found among `trips`. A trip is "extra" when the project had an
 *  EARLIER same-kind trip. A trip with no distance is detected but not costed (emits nothing — never 0). */
export function detectExtraTrips(input: ExtraTripInput): CostEntryInput[] {
  if (!(input.costPerMile > 0)) return [];
  const out: CostEntryInput[] = [];
  for (const t of input.trips) {
    const first = input.firstKindDate(t.eventId, t.kind);
    if (first == null || !(t.day > first)) continue; // first-of-kind or no history → planned baseline
    if (t.roundTripMiles == null || !(t.roundTripMiles > 0)) continue; // can't cost without distance → omit
    const miles = round2(t.roundTripMiles);
    out.push({
      type: "event_expense",
      class: "DIRECT",
      eventId: t.eventId,
      routeId: t.routeId,
      day: t.day,
      amount: round2(miles * input.costPerMile),
      amountStatus: "ESTIMATED",
      source: "derived",
      sourceRef: `extra-trip:${t.eventId}:${t.day}:${t.kind}`,
      note: `Extra ${t.kind} trip on ${t.day} (the project's first ${t.kind} was ${first}). Repeat/unplanned-trip cost estimated at ${miles} mi × $${input.costPerMile}/mi. ESTIMATED — inferred from stop history; a planned phased ${t.kind} cannot be distinguished from an unplanned return.`,
      method: "ESTIMATED",
      confidence: "LOW",
    });
  }
  return out;
}

// ── Guard shared by the derived writer + tests: no derived family may masquerade as cascade labor. ──
/** True when a source_ref belongs to the labor cascade (must NEVER be produced by a derived family). */
export function isLaborCascadeRef(sourceRef: string): boolean {
  return sourceRef.startsWith("labor:") || sourceRef.startsWith("driver-labor:");
}
