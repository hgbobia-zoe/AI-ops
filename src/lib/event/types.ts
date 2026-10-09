// Canonical Event read-model types.
//
// Governing law: RULES CALCULATE, AI INTERPRETS. Phase 1 is a deterministic, READ-ONLY domain layer.
// These types describe an Event that is only ever RECONSTRUCTED from existing rows — never minted,
// never fabricated. Every slice is OPTIONAL and carries an honest presence flag: when the source has
// nothing, the slice is `present: false` and its facts are `null`, never a made-up value.
//
// An `Event` is NOT a persisted entity (Phase 1 introduces no new table). It is the composed, typed
// view of what already exists, keyed by the one canonical id (see ./id.ts).

import type { EventId } from "./id";
import type { StopState } from "@/lib/types";
import type { RiskSeverity } from "@/lib/risk/types";

/** A fact the data could not resolve. Phase 1 never fabricates — unresolved facts are `null`; where a
 *  status string is required, this sentinel is used so the UI can distinguish "unknown" from a value. */
export const UNVERIFIED = "UNVERIFIED" as const;
export type Unverified = typeof UNVERIFIED;

/**
 * The lightweight identity + headline of an Event — enough to list, link, and label it without loading
 * every slice.
 *
 * Date precedence (canonical decision): `bookings.event_date` is the AUTHORITATIVE planning date. The
 * routed stop windows are logistics timing, surfaced separately on the logistics slice (a later phase
 * flags drift between the two as risk). When there is no booking row, `date` falls back to the earliest
 * logistics date — the only date the data can offer — and `dateSource` says so honestly.
 */
export interface EventRef {
  /** The canonical GS project/transaction id (normalized). */
  id: EventId;
  /** Best available display name: the booking's event name, else the routed stop's customer label, else null. */
  displayName: string | null;
  /** The event date (YYYY-MM-DD), or null when unscheduled/unknown. */
  date: string | null;
  /** Where `date` came from — "booking" (authoritative) | "logistics" (fallback) | null (no date at all). */
  dateSource: "booking" | "logistics" | null;
  /** Renter/customer display name, or null when unknown. */
  customer: string | null;
  /** GS client contactID — the SECONDARY stable rollup key — or null when no routed stop carries it. */
  contactId: string | null;
  /** Free-text venue from the booking, or null when unknown (there is no venue registry). */
  venue: string | null;
}

/** Commercial facts from the `bookings` row (dollars). `present: false` when no booking row exists for
 *  this id (e.g. an event that only exists as routed stops). All figures null when absent. */
export interface CommercialSlice {
  present: boolean;
  statusLabel: string | null;
  /** 1 = signed contract in GS; null when no booking row. */
  signed: boolean | null;
  /** GS revenue (grand total), dollars. */
  grandTotal: number | null;
  /** GS pre-discount subtotal (delivery-pricing input), dollars. */
  contractTotal: number | null;
  amountPaid: number | null;
  amountDue: number | null;
  /** ISO — precise quote-email send time (from the GS message thread). */
  quoteSentAt: string | null;
  /** ISO — latest client open of the quote email. */
  quoteOpenedAt: string | null;
  dateCreated: string | null;
  lossReason: string | null;
  /** GS `archived` — off the active board (Lost/Cancelled/closed-won). null when no booking row. */
  archived: boolean | null;
  /** Captured line-item titles (event-type signal); null = never captured. */
  lineItems: string[] | null;
}

/** One routed stop belonging to this event (the logistics grain). */
export interface LogisticsStop {
  stopId: string;
  routeId: string;
  truckId: string;
  sequence: number;
  kind: "delivery" | "pickup" | null;
  state: StopState;
  /** Logistics timing — NOT the authoritative event date. */
  plannedWindow: string | null;
  eta: string | null;
  arrivedAt: string | null;
  completedAt: string | null;
  items: { name: string; quantity?: number; image?: string }[] | null;
}

/**
 * Logistics facts from `routes`/`stops`. `present: false` when no routed stop exists for this id yet
 * (a pure-planning event with no route).
 *
 * Phase-1 boundary: these are the stops of the event's PRIMARY (earliest-dated) route, resolved via the
 * existing readers. An event can have N routes/day; the deterministic rollup ACROSS multiple routes is
 * explicitly a later phase (the audit's riskiest-unknown #3). `primaryRouteOnly` flags that honesty so
 * no caller mistakes this for a full multi-route aggregate.
 */
export interface LogisticsSlice {
  present: boolean;
  routeId: string | null;
  stops: LogisticsStop[];
  /** True while this slice reflects only the primary route (see note above). */
  primaryRouteOnly: boolean;
  /** Earliest planned stop window across the included stops (logistics timing), or null. */
  earliestWindow: string | null;
}

/** Per-event financial projection from `event_financials` (derived, dollars). `present: false` when no
 *  row is found (or no date is known to look one up with — Phase 1 reuses only date-ranged readers). */
export interface FinancialsSlice {
  present: boolean;
  revenue: number | null;
  /** SIGNED | SCHEDULED | COLLECTED | UNAVAILABLE | UNVERIFIED. */
  revenueStatus: string | Unverified;
}

/** Labor economics from `cost_entries` (the attributed labor leaves funding this event's project). */
export interface LaborSlice {
  present: boolean;
  /** Sum of attributed labor amounts, dollars; null when no priced leaf exists. */
  totalCost: number | null;
  entryCount: number;
}

/** Closeout / post-event facts from `event_outcomes` (written when a route closes). */
export interface OutcomeSlice {
  present: boolean;
  routeId: string | null;
  totalStops: number | null;
  completedStops: number | null;
  allCompleted: boolean | null;
  closedAt: string | null;
}

/**
 * The composed, read-only Event — the canonical identity plus every slice. Each slice is independent
 * and honestly flagged; a missing source yields `present: false`, never a fabricated value. This is the
 * single typed object the rest of the system can read in place of re-joining the raw tables by hand.
 */
export interface EventView {
  ref: EventRef;
  commercial: CommercialSlice;
  logistics: LogisticsSlice;
  financials: FinancialsSlice;
  labor: LaborSlice;
  outcome: OutcomeSlice;
}

// ── Phase 3: readiness REQUIREMENTS + the independent readiness axis ──────────────────────────────────

/**
 * A requirement's status, computed deterministically from real data:
 *  - OK         the data backs it and it is satisfied.
 *  - WARNING    a real concern, but not a hard stop (e.g. no deposit yet, weather risk, driver unassigned).
 *  - BLOCKED    a real, data-backed deficiency (e.g. no route, crew short for an event we can staff).
 *  - UNVERIFIED we cannot verify it from data yet (e.g. roster not generated, weather beyond horizon).
 *               NEVER a fabricated pass; always non-blocking (an unknown is not a deficiency).
 */
export type RequirementStatus = "OK" | "WARNING" | "BLOCKED" | "UNVERIFIED";

/**
 * One data-backed requirement for an event. Governing law: DATA-BACKED REQUIREMENTS ONLY — a requirement
 * exists ONLY when a real system source can compute its status. Unbacked operational checks (COI, permits,
 * venue access, final-confirmation call, surface/staking, owned-inventory over-booking) are deliberately
 * NOT emitted (see requirements.ts) until each gets a real source.
 */
export interface Requirement {
  /** Stable machine key (e.g. "contract_signed"). */
  id: string;
  /** Human label. */
  label: string;
  status: RequirementStatus;
  /** The REAL source that backs this requirement (a repo file / table / module). */
  source: string;
  /** Responsible department / lead. */
  owner: string;
  /** When it's due. Phase 3 leaves this null (timeline/deadlines are Phase 4); documented, never faked. */
  deadline: string | null;
  /** True when this requirement gates READY — it must be OK for the event to become READY. */
  blocking: boolean;
  /** What to do to satisfy it. */
  resolution: string;
}

/** The independent readiness axis — a SEPARATE dimension from the lifecycle state (an event can be
 *  BOOKED + AT_RISK). Derived from requirement statuses + the EXISTING risk engine's findings. */
export type EventCondition = "NORMAL" | "WATCH" | "AT_RISK" | "BLOCKED" | "ESCALATED";

export interface EventReadinessResult {
  condition: EventCondition;
  /** The existing risk engine's 0-100 per-event readiness score (reused, not recomputed), when available. */
  score?: number;
  /** The existing risk engine's worst severity for this event (reused), or "READY" when clean. */
  riskLevel?: RiskSeverity | "READY";
  /** Labels of blocking requirements that are not OK (BLOCKED or a blocking WARNING). */
  blockers: string[];
  /** FACT/INFERENCE-labelled explanations citing requirements + risk findings. */
  reasons: string[];
}
