// Reconcile Instawork shifts against the app's schedule. The scheduling board already nets internal
// (Connecteam) crew against demand to compute the Instawork gap; this answers the next question: for a
// given day, what has Instawork ALREADY got booked (or pending) that covers that gap? So a flagged gap
// reads honestly as "already booked on Instawork" vs "still needs posting". Pure + deterministic.

import type { ShiftRole } from "@/lib/scheduling/types";
import type { InstaworkShift } from "./types";

/** Which app roles an Instawork position can cover. Driver→driver; General Labor is generic help that
 *  covers both field (on-site) and prep (warehouse). Unknown positions cover nothing (honest). */
export function instaworkCoversRole(position: string, role: ShiftRole): boolean {
  const p = position.toLowerCase();
  if (p.includes("driver")) return role === "driver";
  if (p.includes("labor") || p.includes("helper") || p.includes("general")) return role === "field" || role === "prep";
  return false;
}

/** The local calendar day (YYYY-MM-DD) an Instawork shift starts on, in its own timezone. */
export function instaworkLocalDate(shift: InstaworkShift): string {
  const t = Date.parse(shift.startsAt);
  if (Number.isNaN(t)) return "";
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: shift.timezone || "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(t));
}

/** Instawork shifts whose local start-day is `date`. */
export function instaworkShiftsForDate(shifts: InstaworkShift[], date: string): InstaworkShift[] {
  return shifts.filter((s) => instaworkLocalDate(s) === date);
}

export interface InstaworkRoleSummary {
  total: number; // Instawork positions covering this role that day
  booked: number; // filled
  pending: number; // posted but unfilled
}

/** Per-role Instawork coverage for a day (booked vs pending vs total), so the board can show whether a
 *  gap is already handled on Instawork. A General Labor gig counts toward BOTH field and prep (it can
 *  cover either) — this is an availability view, not an allocation, and is labelled as such in the UI. */
export function summarizeInstaworkByRole(shifts: InstaworkShift[], date: string): Record<ShiftRole, InstaworkRoleSummary> {
  const out: Record<ShiftRole, InstaworkRoleSummary> = {
    driver: { total: 0, booked: 0, pending: 0 },
    field: { total: 0, booked: 0, pending: 0 },
    prep: { total: 0, booked: 0, pending: 0 },
  };
  const roles: ShiftRole[] = ["driver", "field", "prep"];
  for (const s of instaworkShiftsForDate(shifts, date)) {
    for (const role of roles) {
      if (!instaworkCoversRole(s.position, role)) continue;
      out[role].total += s.total;
      out[role].booked += s.filled;
      out[role].pending += Math.max(0, s.total - s.filled);
    }
  }
  return out;
}
