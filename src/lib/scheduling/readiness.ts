// Shift READINESS — a per-shift, rules-computed readiness roll-up (STAFFING / LOGISTICS / COMMUNICATION
// / TIMEKEEPING / CONFIRMATION), modeled on src/lib/risk/readiness.ts (weighted components, a level that
// a high number can't hide). Pure + deterministic.
//
// HONESTY (the house law): an UNVERIFIED integration (Connecteam unreachable, Instawork stale) leaves
// its component UNKNOWN, never RED — an infra outage must not fabricate a deficiency (the same rule
// risk/readiness.ts applies to f.unverified). An unknown fact stays unknown; nothing is invented.
//
// Grain note: this is SHIFT/worker readiness, deliberately distinct from the EVENT readiness in
// risk/readiness.ts (a different grain) — the two never share a score.

export type ShiftReadinessStatus = "green" | "red" | "unknown";
export type ShiftReadinessLevel = "READY" | "BLOCKED" | "UNVERIFIED";

export interface ShiftReadinessComponent {
  key: "staffing" | "logistics" | "communication" | "timekeeping" | "confirmation";
  label: string;
  weight: number;
  status: ShiftReadinessStatus;
  /** The one missing fact when red, or a short note when unknown; empty when green. */
  note: string;
}

export interface ShiftReadiness {
  score: number; // 0..100 (sum of green component weights)
  level: ShiftReadinessLevel;
  components: ShiftReadinessComponent[];
  /** The red components' notes, in order — the dispatcher's blocker list. */
  blockers: string[];
}

export interface ShiftReadinessInput {
  // STAFFING
  gap: number; // coverage gap (0 = fully staffed)
  staffingUnverified?: boolean; // Instawork/Connecteam unreachable → UNKNOWN, never red
  // LOGISTICS
  hasRoute: boolean;
  truckSet: boolean;
  windowKnown: boolean;
  reportTimeSet: boolean;
  reportLocationSet: boolean;
  // COMMUNICATION
  assignmentCount: number;
  allPacketsSent: boolean;
  commsUnverified?: boolean; // the send pipeline isn't wired yet / provider unreachable → UNKNOWN
  // TIMEKEEPING
  timekeepingLinked: boolean; // internal linked to a Connecteam userId on a published shift; temp gig booked
  timekeepingUnverified?: boolean;
  // CONFIRMATION
  allConfirmed: boolean;
  confirmationUnverified?: boolean;
}

const WEIGHTS = { staffing: 30, logistics: 25, communication: 15, timekeeping: 15, confirmation: 15 } as const;

export function computeShiftReadiness(input: ShiftReadinessInput): ShiftReadiness {
  const components: ShiftReadinessComponent[] = [];

  // STAFFING
  components.push(
    input.staffingUnverified
      ? comp("staffing", "Staffing", "unknown", "Coverage unverified (couldn't reach Connecteam/Instawork)")
      : input.gap > 0
        ? comp("staffing", "Staffing", "red", `${input.gap} seat${input.gap === 1 ? "" : "s"} unstaffed`)
        : comp("staffing", "Staffing", "green", ""),
  );

  // LOGISTICS — first missing fact wins the note.
  const logisticsNote =
    input.hasRoute && !input.truckSet
      ? "No truck assigned"
      : !input.windowKnown
        ? "Window not set"
        : !input.reportTimeSet
          ? "Report time not set"
          : !input.reportLocationSet
            ? "Report location not set"
            : "";
  components.push(comp("logistics", "Logistics", logisticsNote ? "red" : "green", logisticsNote));

  // COMMUNICATION
  components.push(
    input.commsUnverified
      ? comp("communication", "Communication", "unknown", "Packet delivery not wired yet")
      : input.assignmentCount > 0 && input.allPacketsSent
        ? comp("communication", "Communication", "green", "")
        : comp("communication", "Communication", "red", input.assignmentCount === 0 ? "No packet sent yet" : "Packet not sent to everyone"),
  );

  // TIMEKEEPING — "linked", not "owned".
  components.push(
    input.timekeepingUnverified
      ? comp("timekeeping", "Timekeeping", "unknown", "Timekeeping link unverified")
      : input.timekeepingLinked
        ? comp("timekeeping", "Timekeeping", "green", "")
        : comp("timekeeping", "Timekeeping", "red", "Not linked to a timesheet"),
  );

  // CONFIRMATION
  components.push(
    input.confirmationUnverified
      ? comp("confirmation", "Confirmation", "unknown", "Confirmation signal not wired yet")
      : input.assignmentCount > 0 && input.allConfirmed
        ? comp("confirmation", "Confirmation", "green", "")
        : comp("confirmation", "Confirmation", "red", input.assignmentCount === 0 ? "No one confirmed yet" : "Not everyone confirmed"),
  );

  const score = components.reduce((n, c) => n + (c.status === "green" ? c.weight : 0), 0);
  const anyRed = components.some((c) => c.status === "red");
  const anyUnknown = components.some((c) => c.status === "unknown");
  const level: ShiftReadinessLevel = anyRed ? "BLOCKED" : anyUnknown ? "UNVERIFIED" : "READY";
  const blockers = components.filter((c) => c.status === "red").map((c) => c.note);

  return { score, level, components, blockers };
}

function comp(key: ShiftReadinessComponent["key"], label: string, status: ShiftReadinessStatus, note: string): ShiftReadinessComponent {
  return { key, label, weight: WEIGHTS[key], status, note };
}
