// Per-event operational TIMELINE — PURE (no DB/net/AI/UI).
//
// Governing law: RULES CALCULATE, AI INTERPRETS. The timeline is GENERATED from the event's DATE +
// ATTRIBUTES (tent vs simple delivery, pickup present), never a single hardcoded universal list: a tent
// event earns earlier staffing/inventory/weather checkpoints; a simple chair-only delivery gets a short
// one. Milestone STATUS is computed deterministically from "today" vs the milestone date and whether the
// P3 requirements mapped to it are satisfied (requirements are passed in as a resolved fact so this core
// stays DB-free — the Phase-1 "compose, don't duplicate" rule).
//
// Reused (no duplication):
//   • crewRules.ts crewForItems — the SAME pure tent detector the crew engine uses, to classify the event
//     as tent vs simple from its line items. We do NOT re-implement tent parsing.
//   • requirements.ts / types.ts Requirement[] — milestones reference P3 requirement ids; status reads the
//     passed requirements' statuses. The milestone→requirement mapping also feeds real DEADLINES back to
//     P3 (requirementDeadlines / withDeadlines), replacing P3's documented null deadline without mutating
//     P3's output.
//   • machine.ts LifecycleState — each milestone is grouped under a lifecycle-ish phase for display.

import { crewForItems, type LineItem } from "@/lib/crewRules";
import type { EventView, Requirement } from "./types";
import type { LifecycleState } from "./machine";

/** How "done"/"due"/etc. a milestone is, computed from today vs its date + its requirements' statuses. */
export type MilestoneStatus = "done" | "due" | "upcoming" | "overdue" | "na";

/** Which event profile a timeline was generated for. */
export type TimelineProfile = "tent" | "simple";

export interface TimelineMilestone {
  /** Stable machine key (e.g. "staffing_review"). */
  id: string;
  /** Days relative to the event: negative = before, 0 = event day, positive = after. */
  offsetDays: number;
  /** The milestone's calendar date (YYYY-MM-DD), or null when the event has no known date. */
  date: string | null;
  label: string;
  /** Lifecycle-ish grouping for display (PLANNING / READY / DISPATCHED / LIVE / CLOSEOUT). */
  phase: LifecycleState;
  /** Which P3 requirement ids are due by this milestone. */
  requirementIds: string[];
  status: MilestoneStatus;
}

/**
 * Company-policy timeline constants — NAMED + documented so they can be tuned later without touching the
 * generation logic. Offsets are days relative to the event date.
 *
 * Tent events (bigger operational lift) front-load the checkpoints: planning locked a month out, a
 * dedicated staffing review two weeks out, a combined inventory+weather check a week out, final
 * confirmation at T-3, dispatch readiness at T-1, the event at T-0, and pickup/closeout at T+1.
 *
 * Simple deliveries (chair/table drop, no tent) run a compressed track: planning at T-10, staffing at
 * T-5, a single final confirmation at T-2 that also folds in the weather check, dispatch at T-1, event
 * at T-0, pickup/closeout at T+1.
 */
export const TIMELINE_POLICY = {
  tent: {
    planning: -30,
    staffingReview: -14,
    inventoryWeather: -7,
    finalConfirm: -3,
    dispatchCheck: -1,
    eventDay: 0,
    pickupCloseout: 1,
  },
  simple: {
    planning: -10,
    staffingReview: -5,
    finalConfirm: -2,
    dispatchCheck: -1,
    eventDay: 0,
    pickupCloseout: 1,
  },
} as const;

export interface GenerateTimelineOpts {
  /** "today" for status math — a YYYY-MM-DD string or a Date (normalized to a UTC calendar day). Defaults
   *  to the actual current day. */
  today?: string | Date;
  /** The event's resolved P3 requirements — drives "done"/"overdue" (passed in to keep this core DB-free). */
  requirements?: Requirement[];
  /** Force the profile (tests / overrides). Default: inferred from the event's items (tent vs simple). */
  profile?: TimelineProfile;
}

/**
 * Generate the operational timeline for an event from its date + attributes. PURE. The milestone SET
 * diverges by profile (tent vs simple); each milestone's STATUS is computed from `today` + the passed
 * requirements. When the event has no date every milestone is undated and "na".
 */
export function generateTimeline(view: EventView, opts: GenerateTimelineOpts = {}): TimelineMilestone[] {
  const profile = opts.profile ?? inferProfile(view);
  const eventDate = view.ref.date; // authoritative planning date (EventRef)
  const hasPickup = view.logistics.stops.some((s) => s.kind === "pickup");
  const today = normalizeDay(opts.today);
  const requirements = opts.requirements ?? [];

  const specs = profile === "tent" ? tentSpecs(hasPickup) : simpleSpecs(hasPickup);

  return specs.map((spec) => {
    const date = eventDate ? addDays(eventDate, spec.offsetDays) : null;
    return {
      ...spec,
      date,
      status: computeStatus(date, spec.requirementIds, requirements, today),
    };
  });
}

/**
 * Feed deadlines back to P3: map each requirement id to the EARLIEST milestone date that requires it (the
 * earliest binding checkpoint = the most lead-time deadline). Undated milestones are skipped. PURE.
 */
export function requirementDeadlines(timeline: TimelineMilestone[]): Record<string, string> {
  const out: Record<string, string> = {};
  // Earliest milestone first so the first write wins = earliest deadline.
  const dated = timeline.filter((m) => m.date != null).sort((a, b) => a.offsetDays - b.offsetDays);
  for (const m of dated) {
    for (const reqId of m.requirementIds) {
      if (!(reqId in out)) out[reqId] = m.date as string;
    }
  }
  return out;
}

/**
 * Return a COPY of the requirements with `deadline` filled in from the timeline mapping where available
 * (P3 ships deadline:null; this supplies the real one). Does NOT mutate the input. PURE.
 */
export function withDeadlines(requirements: Requirement[], timeline: TimelineMilestone[]): Requirement[] {
  const map = requirementDeadlines(timeline);
  return requirements.map((r) => (map[r.id] ? { ...r, deadline: map[r.id] } : { ...r }));
}

// ── milestone specs (the SET that diverges by profile) ─────────────────────────────────────────────────
type MilestoneSpec = Pick<TimelineMilestone, "id" | "offsetDays" | "label" | "phase" | "requirementIds">;

function tentSpecs(hasPickup: boolean): MilestoneSpec[] {
  const p = TIMELINE_POLICY.tent;
  return [
    { id: "planning", offsetDays: p.planning, label: "Planning & booking locked", phase: "PLANNING", requirementIds: ["contract_signed", "route_exists", "payment_deposit"] },
    { id: "staffing_review", offsetDays: p.staffingReview, label: "Staffing review", phase: "PLANNING", requirementIds: ["crew_sufficient", "tent_crew", "driver_assigned"] },
    { id: "inventory_weather", offsetDays: p.inventoryWeather, label: "Inventory & weather check", phase: "PLANNING", requirementIds: ["inventory_concurrency", "weather_reviewed"] },
    { id: "final_confirm", offsetDays: p.finalConfirm, label: "Final confirmation", phase: "READY", requirementIds: ["delivery_window", "payment_deposit"] },
    { id: "dispatch_check", offsetDays: p.dispatchCheck, label: "Dispatch readiness check", phase: "DISPATCHED", requirementIds: ["driver_assigned", "delivery_window"] },
    { id: "event_day", offsetDays: p.eventDay, label: "Event day", phase: "LIVE", requirementIds: [] },
    { id: "pickup_closeout", offsetDays: p.pickupCloseout, label: hasPickup ? "Pickup & closeout" : "Closeout", phase: "CLOSEOUT", requirementIds: [] },
  ];
}

function simpleSpecs(hasPickup: boolean): MilestoneSpec[] {
  const p = TIMELINE_POLICY.simple;
  return [
    { id: "planning", offsetDays: p.planning, label: "Planning & booking locked", phase: "PLANNING", requirementIds: ["contract_signed", "route_exists", "payment_deposit"] },
    { id: "staffing_review", offsetDays: p.staffingReview, label: "Staffing review", phase: "PLANNING", requirementIds: ["crew_sufficient", "driver_assigned"] },
    { id: "final_confirm", offsetDays: p.finalConfirm, label: "Final confirmation", phase: "READY", requirementIds: ["delivery_window", "weather_reviewed", "payment_deposit"] },
    { id: "dispatch_check", offsetDays: p.dispatchCheck, label: "Dispatch readiness check", phase: "DISPATCHED", requirementIds: ["driver_assigned", "delivery_window"] },
    { id: "event_day", offsetDays: p.eventDay, label: "Event day", phase: "LIVE", requirementIds: [] },
    { id: "pickup_closeout", offsetDays: p.pickupCloseout, label: hasPickup ? "Pickup & closeout" : "Closeout", phase: "CLOSEOUT", requirementIds: [] },
  ];
}

// ── attribute inference + status + date math (all pure) ──────────────────────────────────────────────

/** Classify the event as tent vs simple from its line items, reusing crewRules' tent detector. Items come
 *  from the routed stops (authoritative for logistics) plus captured booking line-item titles. */
function inferProfile(view: EventView): TimelineProfile {
  const items: LineItem[] = [];
  for (const s of view.logistics.stops) for (const it of s.items ?? []) items.push({ name: it.name, quantity: it.quantity });
  for (const title of view.commercial.lineItems ?? []) items.push({ name: title });
  return crewForItems(items).hasTent ? "tent" : "simple";
}

/**
 * Deterministic milestone status.
 *  - no date (undated event) ⇒ "na" (cannot place it on a calendar).
 *  - a REQUIREMENT-backed milestone (has mapped requirements that were generated):
 *      all mapped (generated) requirements OK ⇒ "done";
 *      else past date with a mapped BLOCKING requirement still BLOCKED/WARNING ⇒ "overdue";
 *      else past/today ⇒ "due"; future ⇒ "upcoming".
 *  - a CALENDAR-only milestone (no mapped requirement generated, e.g. event day / closeout): past ⇒ "done"
 *      (the checkpoint has elapsed), today ⇒ "due", future ⇒ "upcoming".
 */
function computeStatus(
  date: string | null,
  requirementIds: string[],
  requirements: Requirement[],
  today: string,
): MilestoneStatus {
  if (!date) return "na";

  const relevant = requirementIds
    .map((id) => requirements.find((r) => r.id === id))
    .filter((r): r is Requirement => r != null);

  const past = date < today;
  const isToday = date === today;

  if (relevant.length === 0) {
    // Calendar-only checkpoint.
    if (past) return "done";
    if (isToday) return "due";
    return "upcoming";
  }

  const allOk = relevant.every((r) => r.status === "OK");
  if (allOk) return "done";

  const anyUnmetBlocking = relevant.some((r) => r.blocking && (r.status === "BLOCKED" || r.status === "WARNING"));
  if (past) return anyUnmetBlocking ? "overdue" : "due";
  if (isToday) return "due";
  return "upcoming";
}

/** Normalize a YYYY-MM-DD string or Date to a UTC calendar day (YYYY-MM-DD). Defaults to now. */
function normalizeDay(input: string | Date | undefined): string {
  if (typeof input === "string") return input.slice(0, 10);
  const d = input ?? new Date();
  return d.toISOString().slice(0, 10);
}

/** Add days to a YYYY-MM-DD date in UTC, returning YYYY-MM-DD. Pure, tz-safe. */
function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}
