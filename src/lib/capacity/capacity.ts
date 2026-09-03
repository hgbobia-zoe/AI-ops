// Capacity intelligence — "can Zoe physically execute what's booked on this day?" A pure, deterministic
// classifier over data we already load (fleet, routes, windows, crew). Surface-only — never blocks
// sales. When staffing can't be verified it's UNVERIFIED, never a fabricated verdict.

export type CapacityVerdict = "AVAILABLE" | "TIGHT" | "CONSTRAINED" | "UNVERIFIED";

export interface CapacityInput {
  date: string;
  fleetSize: number; // active trucks
  trucksRouted: number; // distinct trucks with a route that day
  peakConcurrentRoutes: number; // max simultaneous routes (min drivers needed)
  scheduledDrivers: number; // distinct drivers on the Connecteam schedule
  staffingVerified: boolean;
  /** Worst severity among the day's staffing/driver findings, if any. */
  worstStaffingSeverity: "CRITICAL" | "HIGH" | "MEDIUM" | null;
}

export interface CapacityResult {
  date: string;
  verdict: CapacityVerdict;
  reasons: string[];
}

const ORDER: Record<CapacityVerdict, number> = { AVAILABLE: 0, TIGHT: 1, CONSTRAINED: 2, UNVERIFIED: 3 };

export function classifyCapacity(inp: CapacityInput): CapacityResult {
  // Absence of staffing data is UNKNOWN, not a verdict.
  if (!inp.staffingVerified) return { date: inp.date, verdict: "UNVERIFIED", reasons: ["Connecteam staffing couldn't be verified"] };

  let verdict: CapacityVerdict = "AVAILABLE";
  const reasons: string[] = [];
  const bump = (v: CapacityVerdict, why: string) => {
    if (ORDER[v] > ORDER[verdict]) verdict = v;
    reasons.push(why);
  };

  if (inp.fleetSize > 0 && inp.trucksRouted >= inp.fleetSize) bump("TIGHT", "full fleet committed");
  if (inp.scheduledDrivers < inp.peakConcurrentRoutes) bump("CONSTRAINED", `drivers short (${inp.scheduledDrivers}/${inp.peakConcurrentRoutes} needed)`);
  if (inp.worstStaffingSeverity === "CRITICAL" || inp.worstStaffingSeverity === "HIGH") bump("CONSTRAINED", "a staffing/driver gap");
  else if (inp.worstStaffingSeverity === "MEDIUM") bump("TIGHT", "tight staffing");

  if (reasons.length === 0) reasons.push("fleet + crew cover the day");
  return { date: inp.date, verdict, reasons };
}
