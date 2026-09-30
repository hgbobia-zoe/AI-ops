// Scheduling / Staffing — the app-owned shift model. The app is the source of truth: a human
// builds shifts here (pre-filled from route demand), assigns internal crew, and tops up the gap
// with temp labor. Shifts then push OUT to Connecteam (internal, published) and Instawork (the
// gap-fill gig). Naming: "staff_shifts"/StaffShift, deliberately distinct from Connecteam's
// read-only CrewShift and the unrelated shift_passes (contractor access links).
//
// Design law (same as the rest of the app): RULES CALCULATE, FACTS ONLY. Demand is deterministic
// (routes + crew rules); a time we don't actually know is left null with windowKnown=false — never
// fabricated to look staffed.

/** Roles the schedule reasons about. Maps onto Connecteam's Title-derived driver|prep|other. */
export type ShiftRole = "driver" | "field" | "prep";

/** Lifecycle of a shift the human is building toward sending out. */
export type ShiftStatus =
  | "draft" // just built / suggested, not yet reviewed
  | "confirmed" // human OK'd it, ready to send
  | "sent" // pushed to Connecteam and/or posted to Instawork
  | "cancelled";

/** How the shift originated. */
export type ShiftSource = "derived" | "manual";

/** A suggested shift the demand generator emits from routes — not yet persisted. */
export interface DemandShift {
  date: string; // YYYY-MM-DD the work actually happens
  role: ShiftRole;
  headcount: number;
  startTime: string | null; // ISO; null when we don't know it (never fabricated)
  endTime: string | null;
  windowKnown: boolean; // false → the time is a placeholder the human must set
  location: string | null; // "Warehouse" | venue address
  routeId?: string;
  truckId?: string;
  eventLabel?: string;
  reasons: string[]; // why this headcount (tent rules, route counts…)
}

/** A persisted shift the human is building. Carries internal assignments AND the temp gap-fill. */
export interface StaffShift {
  id: string;
  date: string; // YYYY-MM-DD
  role: ShiftRole;
  headcount: number; // total people this shift needs
  startTime: string | null; // ISO
  endTime: string | null;
  windowKnown: boolean;
  location: string | null;
  routeId: string | null;
  truckId: string | null;
  eventLabel: string | null;
  reasons: string[];
  notes: string | null;
  source: ShiftSource;
  status: ShiftStatus;
  /** Internal crew assigned (Connecteam userIds). */
  assignees: number[];
  /** People still needed after internal assignment → posted as the Instawork gig (0 = none). */
  instaworkHeadcount: number;
  /** Hourly rate for the Instawork gig (dollars). */
  payRate: number | null;
  // External linkage (set when the shift is pushed out).
  connecteamShiftId: string | null;
  connecteamSchedulerId: number | null;
  connecteamPublishedAt: string | null;
  instaworkGigId: string | null;
  instaworkPostedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** The unfilled remainder of a shift = headcount minus internal assignees (never below 0). */
export function shiftGap(s: Pick<StaffShift, "headcount" | "assignees">): number {
  return Math.max(0, s.headcount - s.assignees.length);
}
