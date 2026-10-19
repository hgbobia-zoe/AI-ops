// Scheduling operations BASELINE — a read-only, deterministic roll-up of what the newly-enabled automatic
// scheduling actually DID over a window, so workload reduction can be MEASURED rather than assumed. It only
// aggregates facts already recorded (shift_assignment_events, shift_exceptions, audit_logs); it computes
// nothing new and it NEVER fabricates a savings number.
//
// Design law (04 mission): observe before redesign; represent assignment / notification / confirmation as
// SEPARATE states; and be honest where a state isn't observable (worker acknowledgement is not wired, so
// "confirmed" here means a dispatcher confirmation, not a worker reply — surfaced as a caveat, not hidden).

import { getDb } from "@/lib/db";

// ── Raw inputs (what we read from the tables) ────────────────────────────────────────────────────────
export interface RawEvent {
  kind: string; // assigned | packet_sent | notify | confirmed | override | cancelled | reassigned | ...
  shiftDate: string | null; // the shift's work date (YYYY-MM-DD), used to window
  ts: string; // ISO when the event was logged
  actor: string | null; // a human actor name, or "system"
  assignmentId: string | null;
}
export interface RawException {
  code: string; // understaffed | no_truck | not_published | replacement_needed | ...
  status: string; // OPEN | ACKNOWLEDGED | RESOLVED
  firstDetectedAt: string;
  resolvedAt: string | null;
}
export interface RawAudit {
  action: string;
  ts: string;
}
export interface BaselineRaw {
  events: RawEvent[];
  exceptions: RawException[];
  audits: RawAudit[];
}

// ── Output ───────────────────────────────────────────────────────────────────────────────────────────
export interface SchedulingBaseline {
  window: { start: string; end: string; days: number };
  /** The assignment lifecycle as SEPARATE observable states (04 criterion 4). `confirmedObservable` is false
   *  because worker acknowledgement isn't wired — `confirmed` counts dispatcher confirmations only. */
  funnel: { assigned: number; notified: number; confirmed: number; confirmedObservable: boolean };
  assignments: { created: number; overridden: number; cancelled: number; reassigned: number };
  autoAssigned: number; // seniority/rule auto-assignments committed by the engine
  shiftsAdjustedToRoute: number; // route-change tracking moves/grows (ROUTE_SYNC_SHIFT_EXPANDED)
  connecteamCreated: number;
  needsReview: number; // shifts flagged for a human to reconcile (route-sync + connecteam-sync)
  publishes: { sent: number; failedNoScheduler: number };
  exceptions: {
    opened: number;
    resolved: number;
    stillOpen: number;
    byCode: Record<string, number>;
    medianMinutesToResolve: number | null; // null when nothing resolved in-window (not fabricated as 0)
  };
  /** A deterministic proxy for owner/dispatcher touch — human-actor events + overrides + needs-review flags.
   *  NOT a time figure; labelled so no fake "hours saved" is implied. */
  manualTouchpoints: number;
  /** Honest limits so the numbers are never over-read. */
  caveats: string[];
}

function ymd(iso: string): string {
  return iso.slice(0, 10);
}

/** PURE. Roll raw rows up into the baseline. No DB, no clock, no fabrication. */
export function summarizeBaseline(raw: BaselineRaw, window: { start: string; end: string }): SchedulingBaseline {
  const days = Math.max(1, Math.round((Date.parse(`${window.end}T00:00:00Z`) - Date.parse(`${window.start}T00:00:00Z`)) / 86_400_000) + 1);

  const countKind = (k: string) => raw.events.filter((e) => e.kind === k).length;
  const notified = countKind("packet_sent") + countKind("notify");

  const action = (a: string) => raw.audits.filter((x) => x.action === a).length;

  // Exceptions
  const byCode: Record<string, number> = {};
  for (const x of raw.exceptions) byCode[x.code] = (byCode[x.code] ?? 0) + 1;
  const resolvedDurations: number[] = [];
  for (const x of raw.exceptions) {
    if (x.status === "RESOLVED" && x.resolvedAt) {
      const d = Date.parse(x.resolvedAt) - Date.parse(x.firstDetectedAt);
      if (Number.isFinite(d) && d >= 0) resolvedDurations.push(d);
    }
  }
  resolvedDurations.sort((a, b) => a - b);
  const medianMs = resolvedDurations.length
    ? resolvedDurations.length % 2
      ? resolvedDurations[(resolvedDurations.length - 1) / 2]
      : (resolvedDurations[resolvedDurations.length / 2 - 1] + resolvedDurations[resolvedDurations.length / 2]) / 2
    : null;

  const opened = raw.exceptions.length;
  const resolved = raw.exceptions.filter((x) => x.status === "RESOLVED").length;
  const stillOpen = raw.exceptions.filter((x) => x.status === "OPEN" || x.status === "ACKNOWLEDGED").length;

  const overridden = countKind("override");
  const needsReview = action("ROUTE_SYNC_NEEDS_REVIEW") + action("SHIFT_SYNC_NEEDS_REVIEW");
  const humanActorEvents = raw.events.filter((e) => e.actor && e.actor !== "system").length;

  return {
    window: { start: window.start, end: window.end, days },
    funnel: { assigned: countKind("assigned"), notified, confirmed: countKind("confirmed"), confirmedObservable: false },
    assignments: {
      created: countKind("assigned"),
      overridden,
      cancelled: countKind("cancelled"),
      reassigned: countKind("reassigned"),
    },
    autoAssigned: action("ROUTE_SYNC_AUTO_ASSIGNED"),
    shiftsAdjustedToRoute: action("ROUTE_SYNC_SHIFT_EXPANDED"),
    connecteamCreated: action("ROUTE_SYNC_CONNECTEAM_CREATED"),
    needsReview,
    publishes: { sent: action("SHIFT_PUBLISH_SENT"), failedNoScheduler: action("SHIFT_PUBLISH_NO_SCHEDULER") },
    exceptions: {
      opened,
      resolved,
      stillOpen,
      byCode,
      medianMinutesToResolve: medianMs == null ? null : Math.round(medianMs / 60_000),
    },
    manualTouchpoints: humanActorEvents + overridden + needsReview,
    caveats: [
      "Worker acknowledgement is not wired: 'confirmed' counts dispatcher confirmations, not worker replies.",
      "Duplicate actions prevented are not recorded (idempotency is silent), so that figure is omitted rather than estimated.",
      "Availability-feed staleness is not historized; treat per-day staffing-data gaps from the live board, not this baseline.",
      "No time-saved figure is derived — these are activity counts for building a baseline over several cycles.",
    ],
  };
}

const SCHED_AUDIT_ACTIONS = [
  "ROUTE_SYNC_AUTO_ASSIGNED",
  "ROUTE_SYNC_SHIFT_EXPANDED",
  "ROUTE_SYNC_CONNECTEAM_CREATED",
  "ROUTE_SYNC_NEEDS_REVIEW",
  "SHIFT_SYNC_NEEDS_REVIEW",
  "SHIFT_PUBLISH_SENT",
  "SHIFT_PUBLISH_NO_SCHEDULER",
];

/** Read the raw rows for [start,end] (inclusive, YYYY-MM-DD) from the live tables. Guarded so a fresh/empty
 *  DB yields empty sets instead of throwing. */
export function collectBaselineRaw(start: string, end: string): BaselineRaw {
  const db = getDb();
  const safe = <T>(fn: () => T, fallback: T): T => {
    try {
      return fn();
    } catch {
      return fallback;
    }
  };

  const events = safe<RawEvent[]>(() => {
    const rows = db
      .prepare(
        `SELECT e.kind AS kind, e.ts AS ts, e.actor AS actor, e.assignment_id AS assignmentId, s.date AS shiftDate
           FROM shift_assignment_events e
           LEFT JOIN staff_shifts s ON s.id = e.shift_id
          WHERE (s.date IS NOT NULL AND s.date BETWEEN ? AND ?)
             OR (s.date IS NULL AND substr(e.ts, 1, 10) BETWEEN ? AND ?)`,
      )
      .all(start, end, start, end) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      kind: String(r.kind),
      ts: String(r.ts),
      actor: (r.actor as string) ?? null,
      assignmentId: (r.assignmentId as string) ?? null,
      shiftDate: (r.shiftDate as string) ?? null,
    }));
  }, []);

  const exceptions = safe<RawException[]>(() => {
    const rows = db
      .prepare(
        `SELECT code, status, first_detected_at AS firstDetectedAt, resolved_at AS resolvedAt
           FROM shift_exceptions WHERE date BETWEEN ? AND ?`,
      )
      .all(start, end) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      code: String(r.code),
      status: String(r.status),
      firstDetectedAt: String(r.firstDetectedAt),
      resolvedAt: (r.resolvedAt as string) ?? null,
    }));
  }, []);

  const audits = safe<RawAudit[]>(() => {
    const placeholders = SCHED_AUDIT_ACTIONS.map(() => "?").join(",");
    const rows = db
      .prepare(
        `SELECT action, ts FROM audit_logs
          WHERE action IN (${placeholders}) AND substr(ts, 1, 10) BETWEEN ? AND ?`,
      )
      .all(...SCHED_AUDIT_ACTIONS, start, end) as Array<Record<string, unknown>>;
    return rows.map((r) => ({ action: String(r.action), ts: String(r.ts) }));
  }, []);

  return { events, exceptions, audits };
}

/** The live baseline for a window. Read-only; safe to call from a server component or an API route. */
export function computeSchedulingBaseline(start: string, end: string): SchedulingBaseline {
  return summarizeBaseline(collectBaselineRaw(start, end), { start, end });
}
