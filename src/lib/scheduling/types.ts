// Scheduling / Staffing — the app-owned shift model. The app is the source of truth: a human
// builds shifts here (pre-filled from route demand), assigns internal crew, and tops up the gap
// with temp labor. Shifts then push OUT to Connecteam (internal, published) and Instawork (the
// gap-fill gig). Naming: "staff_shifts"/StaffShift, deliberately distinct from Connecteam's
// read-only CrewShift and the unrelated shift_passes (contractor access links).
//
// Design law (same as the rest of the app): RULES CALCULATE, FACTS ONLY. Demand is deterministic
// (routes + crew rules); a time we don't actually know is left null with windowKnown=false — never
// fabricated to look staffed.

/** Roles the schedule reasons about. driver|field|prep are ROUTE/WAREHOUSE CREW; "office" is the non-crew
 *  bucket for office/admin people (Connecteam's catch-all "other" title: Operations Coordinator, Executive
 *  Assistant, Digital Sales Marketer, any manager). An "office" shift is NEVER route crew: it is excluded
 *  from coverage/required/assigned/gap, never recommended or route-assignable, and shown only in its own
 *  non-crew board section so the person is still visibly scheduled that day. Maps onto Connecteam's
 *  Title-derived driver|prep|other (other → office). */
export type ShiftRole = "driver" | "field" | "prep" | "office";

/** Lifecycle of a shift the human is building toward sending out. */
export type ShiftStatus =
  | "draft" // just built / suggested, not yet reviewed
  | "confirmed" // human OK'd it, ready to send
  | "sent" // pushed to Connecteam and/or posted to Instawork
  | "cancelled";

/** How the shift originated. "connecteam" = ingested from a Connecteam shift by the two-way-sync importer
 *  (the app did not author it; its linked Connecteam shift is the same record). */
export type ShiftSource = "derived" | "manual" | "connecteam";

/** Reconciliation state of an app shift against its linked Connecteam shift (two-way sync). null = not
 *  linked / not yet reconciled; "synced" = app and Connecteam agree as of connecteamSyncedAt; "needs_review"
 *  = a divergence a human must resolve (both sides edited and we can't safely pick a winner, or the
 *  Connecteam copy vanished). We NEVER silently clobber on needs_review. */
export type ShiftSyncStatus = "synced" | "needs_review";

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
  // External linkage (set when the shift is pushed out OR ingested — it is the SAME Connecteam record).
  connecteamShiftId: string | null;
  connecteamSchedulerId: number | null;
  connecteamPublishedAt: string | null;
  // Two-way-sync reconciliation bookkeeping (see docs/connecteam-two-way-sync.md).
  connecteamContentHash: string | null; // hash of the Connecteam shift content as of the last reconcile
  connecteamSyncedAt: string | null;    // ISO of the last successful reconcile for this shift
  connecteamLastModified: string | null;// ISO last-modified FROM Connecteam when exposed (else null)
  syncStatus: ShiftSyncStatus | null;
  syncNote: string | null;
  instaworkGigId: string | null;
  instaworkPostedAt: string | null;
  // Lifecycle + logistics (additive; lifecycleState authoritative going forward, derived from status when null).
  lifecycleState: ShiftLifecycleState | null;
  supervisorUserId: number | null;
  reportLocation: string | null;
  reportTime: string | null;
  equipment: string[];
  instructions: string | null;
  createdAt: string;
  updatedAt: string;
}

/** The unfilled remainder of a shift = headcount minus internal assignees (never below 0). */
export function shiftGap(s: Pick<StaffShift, "headcount" | "assignees">): number {
  return Math.max(0, s.headcount - s.assignees.length);
}

// ── Shift Lifecycle engine (per-worker entity + lifecycle state) ──────────────────────────────────
// The lifecycle evolves the flat ShiftStatus into a real state machine (see scheduling/lifecycle.ts).
// lifecycle_state is authoritative going forward; the legacy `status` is derived both ways during
// migration so neither the old board nor the engine breaks. FACTS ONLY: states are a deterministic
// roll-up of the assignments + coverage, never set by an LLM.

/** The shift-level lifecycle state (D.4 of the design). A deterministic roll-up, not hand-edited. */
export type ShiftLifecycleState =
  | "DRAFT" // demand line exists (derived or manual)
  | "STAFFED" // headcount met (gap 0) and window known
  | "PROVISIONED" // published to Connecteam and/or gig posted; packets built
  | "NOTIFIED" // packet delivered to every assignment
  | "CONFIRMED" // every assignment acknowledged (or dispatcher-confirmed)
  | "READY" // readiness == GREEN (all five components)
  | "IN_PROGRESS" // first clock-in (internal mirror) or shift start passed
  | "COMPLETE" // shift end passed and no open blocking exception
  | "EXCEPTION" // a RED exception is open against the shift
  | "CANCELLED"; // shift called off

/** Which labor pool a per-worker assignment draws from. Internal and Instawork are genuinely different
 *  rows: different identity handles, different timekeeping semantics (D.2). */
export type WorkerKind = "internal" | "instawork";

/** The per-worker (inner) assignment lifecycle (D.5). The shift state rolls up from these. */
export type AssignmentState =
  | "PROPOSED" // the optimizer/dispatcher suggested this worker, not yet committed
  | "ASSIGNED" // committed to the shift (internal publish target / booked gig seat)
  | "NOTIFIED" // packet delivered to the worker
  | "CONFIRMED" // worker acknowledged
  | "CLOCKED_IN" // clock-in seen (internal: Connecteam mirror; instawork: unavailable today)
  | "CLOCKED_OUT" // clock-out seen
  | "DECLINED" // worker declined
  | "NO_SHOW" // deterministic no-show flag
  | "CANCELLED" // assignment called off
  | "REPLACED"; // superseded by a reassignment

/** The keystone per-worker entity: one row per (shift x worker). Carries acceptance, packet, clock
 *  linkage, per-worker exceptions, and the optimizer's economics snapshot. */
export interface ShiftAssignment {
  id: string;
  shiftId: string;
  workerKind: WorkerKind;
  connecteamUserId: number | null; // internal: SoR for the person + timekeeping
  instaworkWorker: string | null; // instawork: worker NAME (the only stable handle captured)
  instaworkGigId: string | null;
  displayName: string | null;
  role: ShiftRole;
  state: AssignmentState;
  packetVersion: string | null;
  packetSentAt: string | null;
  confirmedAt: string | null;
  confirmMethod: string | null;
  clockInAt: string | null;
  clockOutAt: string | null;
  clockSource: string | null; // 'connecteam' | 'unavailable'
  noShow: boolean;
  // Staffing-economics snapshot (a MIRROR for display/audit; rate SoR stays Connecteam/Instawork).
  tempReason: string | null;
  routeReason: string | null;
  estHours: number | null;
  estRate: number | null;
  estCost: number | null;
  overridden: boolean;
  overrideReason: string | null;
  createdAt: string;
  updatedAt: string;
}
