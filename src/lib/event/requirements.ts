// Per-event REQUIREMENTS engine — PURE (no DB/net/AI).
//
// Governing law: RULES CALCULATE, AI INTERPRETS — and the Phase-3 scoping decision: DATA-BACKED
// REQUIREMENTS ONLY. generateRequirements emits a requirement ONLY when a real system source can compute
// its status from the resolved facts the caller passes in. Requirements are generated from the event's
// ATTRIBUTES (what the data shows this event actually is) — a chair-only delivery gets no tent
// requirement; a pure-planning event with no route gets no driver requirement.
//
// DELIBERATELY OMITTED (no real backing yet — would be fabricated, so they are NOT emitted until each
// gets a real source): certificate of insurance (COI), permits, venue access / load-in approval, the
// final-confirmation call, surface/staking/ground checks, and owned-inventory OVER-BOOKING (there is no
// owned-inventory master — inferring ownership from bookings is forbidden; see inventory.ts). Only the
// honest concurrency SIGNAL is emitted, never an over-booking verdict.
//
// This core takes RESOLVED FACTS as input (staffing counts, weather result, inventory concurrency) — it
// never fetches. The resolver layer (resolvers.ts) gathers those facts by composing existing readers.

import type { EventView, Requirement, RequirementStatus } from "./types";
import type { WeatherResult } from "@/lib/weather/types";
import { classifyWeatherRisk } from "@/lib/weather/classify";

/** Resolved staffing facts for the event's primary route (the caller resolves these from scheduling +
 *  Connecteam + crewRules — all existing sources). */
export interface StaffingFact {
  /** True when the app schedule / Connecteam data exists for this event's date+route; false = unknown. */
  verified: boolean;
  /** Crew the route needs (from crewRules.crewForRoute). */
  requiredCrew: number;
  /** Distinct crew assigned (scheduling assignees + the Dispatch-assigned driver). */
  assignedCrew: number;
  /** Whether the event's items include a tent (from crewRules). */
  hasTent: boolean;
  /** Why crew is needed (crewRules reasons, e.g. "tent → 2 crew"). */
  tentReasons: string[];
  /** Whether a driver is assigned to the route in Dispatch (routes.driver_id). */
  driverAssigned: boolean;
}

/** One item's resolved concurrency signal (from inventory.peakItemDemand). */
export interface InventoryConcurrencyItem {
  name: string;
  peakQty: number;
  peakDate: string;
  /** True when this item's peak day is shared with OTHER events (same-day contention worth a human look). */
  sharedWithOtherEvents: boolean;
}

export interface InventoryConcurrencyFact {
  items: InventoryConcurrencyItem[];
}

/** The resolved facts generateRequirements consumes. All optional — a fact the caller couldn't resolve
 *  yields an UNVERIFIED requirement (never a fabricated pass). */
export interface RequirementFacts {
  /** Days until the event (from the authoritative date); null when undated. Reserved for Phase-4 deadlines. */
  daysUntilEvent?: number | null;
  staffing?: StaffingFact | null;
  weather?: WeatherResult | null;
  inventory?: InventoryConcurrencyFact | null;
}

// Real sources (cited verbatim on each requirement so every one is traceable).
const SRC = {
  bookings: "src/lib/db/repo.ts (bookings)",
  stops: "src/lib/db/repo.ts (routes/stops)",
  routeDriver: "src/lib/db/repo.ts (routes.driver_id)",
  crew: "src/lib/crewRules.ts + src/lib/scheduling/* / src/lib/connecteam.ts",
  inventory: "src/lib/inventory/inventory.ts (peakItemDemand)",
  weather: "src/lib/weather/* (Open-Meteo + classifyWeatherRisk)",
} as const;

/**
 * Generate the data-backed requirement set for an event. PURE. Only attributes the EventView actually
 * carries, plus the resolved facts, produce requirements.
 */
export function generateRequirements(view: EventView, facts: RequirementFacts = {}): Requirement[] {
  const out: Requirement[] = [];
  const c = view.commercial;
  const logistics = view.logistics;
  const hasRoute = logistics.present && logistics.stops.length > 0;

  // ── Commercial: contract signed (blocking) ──────────────────────────────────────────────────────────
  if (c.present) {
    const signed = c.signed === true;
    out.push({
      id: "contract_signed",
      label: "Contract signed",
      status: signed ? "OK" : "BLOCKED",
      source: SRC.bookings,
      owner: "Sales",
      deadline: null,
      blocking: true,
      resolution: signed ? "Contract is signed in Goodshuffle." : "Get the client to e-sign the contract in Goodshuffle.",
    });

    // ── Commercial: payment / deposit (non-blocking — Sales owns it, it doesn't gate dispatch) ──────────
    // Backed only when there are real $ figures. Nothing paid with a balance due → WARNING; otherwise OK.
    const hasMoney = c.amountPaid != null || c.amountDue != null || c.grandTotal != null;
    if (hasMoney) {
      const paid = c.amountPaid ?? 0;
      const due = c.amountDue ?? 0;
      const status: RequirementStatus = paid > 0 || due <= 0 ? "OK" : "WARNING";
      out.push({
        id: "payment_deposit",
        label: "Deposit / payment collected",
        status,
        source: SRC.bookings,
        owner: "Sales (Jessie)",
        deadline: null,
        blocking: false,
        resolution:
          status === "OK"
            ? `Payment on file (paid $${round(paid)}${due > 0 ? `, $${round(due)} balance remaining` : ""}).`
            : `No payment collected yet; $${round(due)} due. Request the deposit.`,
      });
    }
  }

  // ── Logistics: a route exists (blocking) ─────────────────────────────────────────────────────────────
  out.push({
    id: "route_exists",
    label: "Route planned",
    status: hasRoute ? "OK" : "BLOCKED",
    source: SRC.stops,
    owner: "Dispatch / Ops",
    deadline: null,
    blocking: true,
    resolution: hasRoute ? "A route with stops exists for this event." : "Plan a route (import/build it from Goodshuffle).",
  });

  // The logistics-dependent requirements only apply once a route exists.
  if (hasRoute) {
    // ── Delivery window present (blocking — can't confidently be READY without timing) ─────────────────
    const hasWindow = logistics.earliestWindow != null;
    out.push({
      id: "delivery_window",
      label: "Delivery window set",
      status: hasWindow ? "OK" : "WARNING",
      source: SRC.stops,
      owner: "Dispatch / Ops",
      deadline: null,
      blocking: true,
      resolution: hasWindow ? "Stops carry planned delivery/pickup windows." : "Add delivery/pickup windows in Goodshuffle.",
    });

    // ── Driver assigned (non-blocking — Zoe hasn't adopted driver-assignment as policy) ────────────────
    const staffing = facts.staffing;
    if (staffing) {
      out.push({
        id: "driver_assigned",
        label: "Driver assigned",
        status: staffing.driverAssigned ? "OK" : "WARNING",
        source: SRC.routeDriver,
        owner: "Dispatch / Ops",
        deadline: null,
        blocking: false,
        resolution: staffing.driverAssigned ? "A driver is assigned to the route." : "Assign a driver to the route in Dispatch.",
      });

      // ── Crew / staffing sufficient (blocking) ────────────────────────────────────────────────────────
      out.push({
        id: "crew_sufficient",
        label: "Crew staffed",
        ...crewStatus(staffing, staffing.requiredCrew, "the route"),
        source: SRC.crew,
        owner: "Back Office (Lisa)",
        deadline: null,
        blocking: true,
      });

      // ── Tent crew — ONLY when the event has a tent (attribute-gated) ──────────────────────────────────
      if (staffing.hasTent) {
        out.push({
          id: "tent_crew",
          label: "Tent crew staffed",
          ...crewStatus(staffing, staffing.requiredCrew, `the tent (${staffing.tentReasons.join(", ") || "tent setup"})`),
          source: SRC.crew,
          owner: "Ops",
          deadline: null,
          blocking: true,
        });
      }
    } else {
      // No staffing fact resolved → honest UNVERIFIED (non-blocking), never a fabricated pass.
      out.push({
        id: "crew_sufficient",
        label: "Crew staffed",
        status: "UNVERIFIED",
        source: SRC.crew,
        owner: "Back Office (Lisa)",
        deadline: null,
        blocking: true,
        resolution: "Staffing data not available yet (roster not generated / Connecteam unreachable).",
      });
    }
  }

  // ── Inventory concurrency SIGNAL (non-blocking; owned-inventory over-booking stays UNVERIFIED) ────────
  if (facts.inventory && facts.inventory.items.length > 0) {
    const contended = facts.inventory.items.filter((i) => i.sharedWithOtherEvents);
    out.push({
      id: "inventory_concurrency",
      label: "Inventory concurrency reviewed",
      status: contended.length > 0 ? "WARNING" : "OK",
      source: SRC.inventory,
      owner: "Ops",
      deadline: null,
      blocking: false,
      resolution:
        contended.length > 0
          ? `Same-day demand overlaps other events for: ${contended.map((i) => `${i.name} (peak ${i.peakQty})`).join(", ")}. Confirm stock. (Owned-inventory capacity is UNVERIFIED — no owned master.)`
          : "No same-day concurrency contention detected. (Owned-inventory capacity is UNVERIFIED — no owned master.)",
    });
  }

  // ── Weather reviewed (non-blocking) ──────────────────────────────────────────────────────────────────
  if (view.ref.date) {
    out.push(weatherRequirement(facts.weather));
  }

  return out;
}

/** The READY gate helper (used by lifecycle.ts): all BLOCKING requirements must be OK. A blocking
 *  requirement that is BLOCKED or WARNING withholds READY; UNVERIFIED is an unknown and does NOT block.
 *  Requires at least one blocking requirement present (an empty set is never "ready"). PURE. */
export function isReadyGateSatisfied(requirements: Requirement[]): boolean {
  const blocking = requirements.filter((r) => r.blocking);
  if (blocking.length === 0) return false;
  return blocking.every((r) => r.status === "OK" || r.status === "UNVERIFIED");
}

// ── helpers ─────────────────────────────────────────────────────────────────────────────────────────
function crewStatus(
  staffing: StaffingFact,
  required: number,
  what: string,
): { status: RequirementStatus; resolution: string } {
  if (!staffing.verified) {
    return { status: "UNVERIFIED", resolution: "Staffing not generated yet for this date/route (roster not built / Connecteam unreachable)." };
  }
  if (staffing.assignedCrew >= required) {
    return { status: "OK", resolution: `${staffing.assignedCrew}/${required} crew assigned for ${what}.` };
  }
  return {
    status: "BLOCKED",
    resolution: `Only ${staffing.assignedCrew} of ${required} needed crew assigned for ${what}. Schedule ${required - staffing.assignedCrew} more.`,
  };
}

function weatherRequirement(weather: WeatherResult | null | undefined): Requirement {
  const base = {
    id: "weather_reviewed",
    label: "Weather reviewed",
    source: SRC.weather,
    owner: "Ops",
    deadline: null,
    blocking: false,
  } as const;

  if (!weather || weather.status !== "OK") {
    const why =
      weather?.status === "BEYOND_HORIZON"
        ? "Event is beyond the 16-day forecast horizon."
        : weather?.status === "LOCATION_UNKNOWN"
          ? "Could not geocode the event address."
          : "Weather service unavailable.";
    return { ...base, status: "UNVERIFIED", resolution: `${why} Re-check closer to the date.` };
  }

  const risk = classifyWeatherRisk(weather.forecast);
  if (risk.level === "NONE") {
    return { ...base, status: "OK", resolution: "Forecast is benign for an outdoor event." };
  }
  return {
    ...base,
    status: "WARNING",
    resolution: `${risk.level === "RISK" ? "Weather RISK" : "Weather WATCH"}: ${risk.reasons.join("; ")}. Plan accordingly (tents/sidewalls/heat plan).`,
  };
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
