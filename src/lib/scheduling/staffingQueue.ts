// STAFFING & READINESS queue — the ONE consolidated, ordered list that merges the day's existing
// authoritative staffing signals into a single top-of-page surface (doc §15). It invents NO new exception
// rules: it reads the records the blade already computes (route pre-check gaps, shift readiness/exceptions,
// two-way-sync conflicts, scheduled-but-unrouted prompts) and orders them by a fixed operational priority.
//
// ORDER (ascending category wins first, then severity, then the route's time):
//   1  blocking staffing gaps          (pre-check gap, understaffed shift, scheduled-but-unrouted candidate)
//   2  assignment conflicts + unverified critical availability (no-show replacement, assignee now unavailable)
//   3  missing confirmations / required comms (unconfirmed, packet not delivered)
//   4  unpublished shifts / missing packets  (staffed but not pushed to Connecteam)
//   5  sync conflicts                   (needs_review)
//   6  other                            (no truck, no window, no supervisor)
//
// Severity is preserved from the source where present (an exception's RED/YELLOW, a pre-check's nobody vs
// partial). Pure + deterministic — the detail panels below remain the action targets the rows point at.

import type { RoutePreCheck } from "./preCheck";
import type { ShiftException } from "./exceptions";
import type { SyncConflictView } from "./needsReview";

export type QueueSeverity = "critical" | "attention" | "info";
export type QueueCategory = 1 | 2 | 3 | 4 | 5 | 6;

/** Where a row's action scrolls — the existing detail panel that owns the real workflow. */
export type QueueTarget = "board" | "scheduled-to-route" | "sync-conflicts" | "shift-readiness";

export interface QueueItem {
  id: string; // stable identity (dedupe + React key)
  category: QueueCategory;
  severity: QueueSeverity;
  /** Route / vehicle this is about ("Box Truck 1", or "Prep / other" when not route-tied). */
  routeLabel: string;
  /** The time window, pre-formatted (null when not set). */
  windowLabel: string | null;
  /** Short problem statement. */
  problem: string;
  /** Concise supporting detail. */
  detail: string;
  /** The contextual action: a label + the panel to reveal. */
  actionLabel: string;
  target: QueueTarget;
  /** Start of the route/shift window in ms (for the tie-break); null/Infinity sorts last. */
  sortTime: number;
}

/** Per-route display metadata, so the builder stays pure (no truck lookups / date math inside). */
export interface RouteMeta {
  label: string;
  windowLabel: string | null;
  startMs: number | null;
}
/** Per-shift display metadata for exception rows (routeLabel folds in "Prep / other" for route-less shifts). */
export interface ShiftMeta {
  routeLabel: string;
  windowLabel: string | null;
  startMs: number | null;
}

export interface ScheduledUnroutedLite {
  userId: number;
  name: string;
  roleLabel: string;
  windowLabel: string | null;
  startMs: number | null;
}

export interface StaffingQueueInput {
  preChecks: RoutePreCheck[];
  exceptions: ShiftException[];
  conflicts: SyncConflictView[];
  scheduledUnrouted: ScheduledUnroutedLite[];
  routeMeta: Record<string, RouteMeta>;
  shiftMeta: Record<string, ShiftMeta>;
}

const SEV_RANK: Record<QueueSeverity, number> = { critical: 0, attention: 1, info: 2 };
const sortTimeOf = (ms: number | null): number => (ms == null ? Number.POSITIVE_INFINITY : ms);

/** Which category + action target a shift exception belongs to (pure mapping over the existing codes). */
function categoryForException(code: ShiftException["code"]): { category: QueueCategory; target: QueueTarget } {
  switch (code) {
    case "understaffed":
      return { category: 1, target: "board" };
    case "replacement_needed":
    case "assignee_unavailable":
      return { category: 2, target: "shift-readiness" };
    case "unconfirmed":
    case "packet_undelivered":
      return { category: 3, target: "shift-readiness" };
    case "not_published":
      return { category: 4, target: "shift-readiness" };
    case "no_truck":
    case "no_window":
    case "supervisor_missing":
    default:
      return { category: 6, target: "shift-readiness" };
  }
}

/**
 * Merge the day's authoritative staffing signals into one ordered queue. Pure. Route staffing gaps come from
 * the pre-check (the §2.2 authority), so a route's understaffed shift exception is deduped against it to avoid
 * a double row for the same route. Scheduled-but-unrouted people ride alongside the gaps as the candidates.
 */
export function buildStaffingQueue(input: StaffingQueueInput): QueueItem[] {
  const items: QueueItem[] = [];
  const routesWithPreCheckGap = new Set<string>();

  // ── 1. Blocking staffing gaps — pre-check (route-level, authoritative). ──
  for (const pc of input.preChecks) {
    if (pc.status !== "gap") continue;
    routesWithPreCheckGap.add(pc.routeId);
    const meta = input.routeMeta[pc.routeId];
    items.push({
      id: `precheck:${pc.routeId}`,
      category: 1,
      severity: pc.nobody ? "critical" : "attention",
      routeLabel: meta?.label ?? pc.truckName,
      windowLabel: meta?.windowLabel ?? null,
      problem: pc.nobody ? "No crew assigned" : "Understaffed",
      detail: `${pc.reason} — debrief held. ${candidateHint(pc)}`,
      actionLabel: pc.nobody ? "Assign crew" : "Fill gap",
      target: "board",
      sortTime: sortTimeOf(meta?.startMs ?? null),
    });
  }

  // ── Shift exceptions — categorised; route-staffing understaffed deduped against the pre-check. ──
  for (const e of input.exceptions) {
    const { category, target } = categoryForException(e.code);
    if (e.code === "understaffed" && e.routeId && routesWithPreCheckGap.has(e.routeId)) continue; // already shown
    const meta = e.shiftId ? input.shiftMeta[e.shiftId] : undefined;
    items.push({
      id: `exc:${e.signature}`,
      category,
      severity: e.severity === "RED" ? "critical" : "attention",
      routeLabel: meta?.routeLabel ?? "Prep / other",
      windowLabel: meta?.windowLabel ?? null,
      problem: e.title,
      detail: e.detail,
      actionLabel: e.fixLabel,
      target,
      sortTime: sortTimeOf(meta?.startMs ?? null),
    });
  }

  // ── 1 (cont). Scheduled in Connecteam but not on a route — the candidate for a gap. ──
  for (const p of input.scheduledUnrouted) {
    items.push({
      id: `unrouted:${p.userId}`,
      category: 1,
      severity: "attention",
      routeLabel: p.roleLabel,
      windowLabel: p.windowLabel,
      problem: `${p.name} scheduled, not on a route`,
      detail: "Scheduled in Connecteam for this day but not yet assigned to a route. A schedule is not route coverage.",
      actionLabel: "Assign to route",
      target: "scheduled-to-route",
      sortTime: sortTimeOf(p.startMs),
    });
  }

  // ── 5. Sync conflicts (needs_review). ──
  for (const c of input.conflicts) {
    const meta = input.shiftMeta[c.shiftId];
    items.push({
      id: `sync:${c.shiftId}`,
      category: 5,
      severity: "critical",
      routeLabel: meta?.routeLabel ?? (c.routeId ? c.routeId : "Prep / other"),
      windowLabel: meta?.windowLabel ?? null,
      problem: "Sync conflict",
      detail: c.syncNote ?? "Changed in both Dispatch and Connecteam; pick which version to keep.",
      actionLabel: "Resolve",
      target: "sync-conflicts",
      sortTime: sortTimeOf(meta?.startMs ?? null),
    });
  }

  return items.sort(
    (a, b) =>
      a.category - b.category ||
      SEV_RANK[a.severity] - SEV_RANK[b.severity] ||
      a.sortTime - b.sortTime ||
      a.id.localeCompare(b.id),
  );
}

/** The honest one-line candidate hint for a pre-check gap (mirrors the pre-check panel's wording). */
function candidateHint(pc: RoutePreCheck): string {
  if (!pc.connecteamReachable) return "Candidate list unknown (Connecteam unreachable).";
  if (pc.connecteamCandidates.length === 0) return "No scheduled crew free — post a gig to fill it.";
  const names = pc.connecteamCandidates.slice(0, 3).map((c) => c.name).join(", ");
  const more = pc.connecteamCandidates.length > 3 ? ` +${pc.connecteamCandidates.length - 3} more` : "";
  return `Could assign: ${names}${more}.`;
}
