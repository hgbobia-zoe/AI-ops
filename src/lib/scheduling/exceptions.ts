// Shift EXCEPTION queue — a deterministic RED/YELLOW/GREEN scan of the day's shifts (§H of the design),
// modeled on health/connections.ts (status + fixLabel + a stable rank) and risk/scan.ts (a stable
// signature so a re-scan updates in place, never duplicates). Pure + deterministic.
//
// ONLY ACTIONABLE alerts, and never a fabricated one: an UNVERIFIED integration (Connecteam/Instawork
// unreachable) is an UNKNOWN, NOT an exception (the same rule readiness.ts applies). Severity escalates
// by proximity to the shift start (the closer, the hotter).

import type { DayCoverage } from "./coverage";
import type { ShiftAssignment, StaffShift } from "./types";

export type ExceptionSeverity = "RED" | "YELLOW";

export interface ShiftException {
  signature: string; // stable identity for idempotent persistence (same discipline as risk_items)
  shiftId: string;
  routeId: string | null;
  code: "understaffed" | "no_truck" | "no_window" | "not_published" | "supervisor_missing" | "packet_undelivered" | "unconfirmed" | "replacement_needed";
  severity: ExceptionSeverity;
  title: string;
  detail: string;
  fixLabel: string;
  rank: number; // RED=0, YELLOW=1 — queue sorts ascending (problems first), like connections.ts
}

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

export interface ScanInput {
  shifts: StaffShift[];
  coverage: DayCoverage;
  now: number;
  /** Per-shift assignments (optional — enables the packet/confirmation checks when present). */
  assignmentsByShift?: Map<string, ShiftAssignment[]>;
  /** Connecteam/Instawork reachable this scan. When false, coverage-based exceptions are suppressed
   *  (UNVERIFIED is an UNKNOWN, never a fabricated understaffed alert). */
  staffingVerified?: boolean;
  /** The worker-facing comms loop is live (SHIFT_COMMS_ENABLED). Until it is, "packet not delivered" /
   *  "unconfirmed" are not actionable (we don't attempt a send), so they are suppressed — never a
   *  fabricated alert for a loop that isn't running yet. Defaults to true (preserves pure-test behavior). */
  commsWired?: boolean;
}

function startMsOf(s: StaffShift): number | null {
  if (!s.windowKnown || !s.startTime) return null;
  const t = Date.parse(s.startTime);
  return Number.isNaN(t) ? null : t;
}

/** Scan a day's shifts into the actionable exception queue, sorted RED first. Pure + deterministic. */
export function scanShiftExceptions(input: ScanInput): ShiftException[] {
  const { shifts, coverage, now } = input;
  const staffingVerified = input.staffingVerified ?? true;
  const out: ShiftException[] = [];

  for (const s of shifts) {
    if (s.status === "cancelled") continue;
    const startMs = startMsOf(s);
    const gap = coverage.byShift[s.id]?.gap ?? Math.max(0, s.headcount - s.assignees.length);
    const nearStart = startMs != null && startMs - now < DAY_MS;

    // #1 Understaffed — only when staffing is VERIFIED (an unreachable integration is UNKNOWN, not red).
    if (gap > 0 && staffingVerified) {
      const red = nearStart; // escalate to RED inside T-1d
      out.push(ex(s, "understaffed", red ? "RED" : "YELLOW", "Understaffed", `${gap} seat${gap === 1 ? "" : "s"} still need staffing`, "Assign or post gig"));
    }

    // #2 No truck assigned (a route shift with no truck) — RED.
    if (s.routeId && !s.truckId) {
      out.push(ex(s, "no_truck", "RED", "No truck assigned", "This route shift has no truck", "Set truck"));
    }

    // #3 No window / report time near the shift — YELLOW.
    if (!s.windowKnown) {
      out.push(ex(s, "no_window", "YELLOW", "No window set", "The shift time is still a placeholder", "Set time"));
    }

    // #4 Staffed internally but not published to Connecteam — YELLOW.
    if (gap === 0 && staffingVerified && s.assignees.length > 0 && !s.connecteamShiftId) {
      out.push(ex(s, "not_published", "YELLOW", "Not published", "Staffed internally but not pushed to Connecteam", "Publish"));
    }

    // #10 Supervisor missing on a multi-person shift — YELLOW.
    if (s.headcount > 1 && s.supervisorUserId == null) {
      out.push(ex(s, "supervisor_missing", "YELLOW", "No supervisor", "Multi-person shift has no lead assigned", "Assign lead"));
    }

    // #7/#11 Replacement needed — a worker who WAS on this shift is a no-show (deterministic no_show flag
    // or NO_SHOW state), which reopens the seat. Fire regardless of the comms loop (a no-show is a hard
    // fact, not a comms step). Priority to fill: other qualified internal first, then Instawork. The
    // runtime enriches the detail with the est. additional temp cost. RED near/after start.
    const allAssignments = input.assignmentsByShift?.get(s.id);
    if (allAssignments && allAssignments.some((a) => a.noShow || a.state === "NO_SHOW")) {
      const red = startMs == null || startMs - now < 2 * HOUR_MS;
      out.push(ex(s, "replacement_needed", red ? "RED" : "YELLOW", "Replacement needed", "A worker is a no-show. Fill from other internal first, then Instawork.", "Reassign or post gig"));
    }

    // Assignment-grained checks (only when assignments are provided AND the comms loop is live).
    const assignments = input.assignmentsByShift?.get(s.id);
    if ((input.commsWired ?? true) && assignments && assignments.length > 0) {
      // #5 Packet not delivered to every assignment — YELLOW.
      if (assignments.some((a) => a.packetSentAt == null)) {
        out.push(ex(s, "packet_undelivered", "YELLOW", "Packet not delivered", "A worker has not received the shift packet", "Send packet"));
      }
      // #6 Unconfirmed near start — YELLOW, RED within T-2h.
      if (assignments.some((a) => a.confirmedAt == null)) {
        const red = startMs != null && startMs - now < 2 * HOUR_MS;
        out.push(ex(s, "unconfirmed", red ? "RED" : "YELLOW", "Unconfirmed", "A worker has not confirmed", "Call or confirm"));
      }
    }
  }

  return out.sort((a, b) => a.rank - b.rank || a.shiftId.localeCompare(b.shiftId) || a.code.localeCompare(b.code));
}

function ex(
  s: StaffShift,
  code: ShiftException["code"],
  severity: ExceptionSeverity,
  title: string,
  detail: string,
  fixLabel: string,
): ShiftException {
  return {
    signature: `${s.id}:${code}`,
    shiftId: s.id,
    routeId: s.routeId,
    code,
    severity,
    title,
    detail,
    fixLabel,
    rank: severity === "RED" ? 0 : 1,
  };
}
