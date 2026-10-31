// Route auto-sync — the effectful half of the Connecteam <-> Dispatch ROUTE bridge. It does two things each
// cycle, both idempotently and both under the CONNECTEAM_AUTOSYNC_DISABLED kill switch:
//
//   1. Connecteam -> route AUTO-ASSIGN. Takes the scheduledUnrouted detector's output and performs a REAL app
//      assignment through the SAME path the dispatcher's one-click uses (create/attach the route+role shift,
//      add the assignee, dual-write the per-worker row) for DRIVERS ONLY: (a) UNAMBIGUOUS matches — exactly
//      one open route fits (planRouteAutoAssign); and (b) AMBIGUOUS drivers, resolved deterministically across
//      all driver-gapped routes by seniority routing (resolveDriverSeniority). Per the owner directive
//      2026-10-30 ("asset prep does not get on a truck at all") a warehouse/prep worker is NOT delivery crew
//      and is never auto-placed on a truck — the detector no longer even surfaces them for a route seat, and
//      field-helper seats are Instawork. The staffing gate stays honest — a Connecteam schedule is never
//      credited as coverage; only the real assignment clears the gap — and a seat-capacity guard keeps a
//      route from being filled past its need.
//
//   2. App route -> Connecteam AUTO-CREATE (SILENT). Enforces the invariant "nobody on a Dispatch route
//      without being in Connecteam": a route app shift whose assignees are NOT in Connecteam that day gets a
//      Connecteam shift created automatically, with notifyUsers=FALSE so no crew is spammed. This replaces
//      the prior design where pushing to Connecteam was a separate human "publish" step — see
//      docs/connecteam-two-way-sync.md §Route auto-sync. The created id is stored so #48's reconcile adopts
//      (baselines) it and never re-imports a duplicate.
//
// SAFETY (house law, maximum care — this AUTO-WRITES real employee data):
//   - SILENT: every auto-create uses notifyUsers=false.
//   - IDEMPOTENT / no duplicates: dedupe strictly by connecteam_shift_id. Once a route shift is linked,
//     create never fires again; once a person is on a route app shift, auto-assign never re-surfaces them.
//     No create-then-delete thrash.
//   - OUTAGE-SAFE: Connecteam unreachable -> do NOTHING (don't lose the app assignment, don't duplicate).
//     We skip and retry next cycle, and never fabricate a Connecteam presence.
//   - UNCERTAIN -> record-only: a route shift whose assignees are a MIX of in-Connecteam and not (creating
//     one shift could duplicate or drop people) is flagged needs_review for a human, not auto-written.
//   - KILL SWITCH: connecteamAutosyncEnabled() gates the whole thing (mirrors CONNECTEAM_IMPORT_DISABLED).

import {
  connecteamConfigured,
  getCrewForDateSafe,
  getDefaultScheduler,
  getUsers,
  createPublishedShift,
  updatePublishedShift,
  type PublishShiftInput,
  type PublishShiftResult,
  type Scheduler,
} from "@/lib/connecteam";
import { getActiveVehicles } from "@/lib/vehicles";
import { getRoutesForDate, setRouteDriver } from "@/lib/db/repo";
import { insertAudit } from "@/lib/db/repo";
import { todayInOpsTz, shiftYmd, DISPLAY_TZ, formatYmdLong } from "@/lib/dates";
import { botAnnounce, appUrl } from "@/lib/notify/aiBots";
import { slackNotify } from "@/lib/notify/slack";
import { recordSchedulingAlarm } from "./autoAssignAlarm";
import { createShift, getShiftById, getShiftsForDate, updateShift } from "./store";
import { syncInternalAssignments } from "./assignments";
import { routeAssignWindow, requiredCrewForRoute, assignedCrewForRoute, computeRouteGap, type RouteCrewRole } from "./preCheck";
import { scheduledUnroutedForDate } from "./scheduledUnrouted";
import { matchConnecteamShiftForPush, unionPushWindowUnix } from "./connecteamImport";
import type { CrewShift, CrewRole } from "@/lib/connecteam";
import { planRouteAutoAssign, isAutoRouteEligible, type RouteAutoAssignPlan, type AutoAssignDecision } from "./routeAutoAssign";
import { resolveDriverSeniority, type SeniorityRouteMeta } from "./driverSeniority";
import { routeSpecialty } from "./routeSpecialty";
import { trackWindow, routeOwnWindow } from "./routeRatchet";
import { getSettings } from "@/lib/settings";
import type { ShiftRole, StaffShift } from "./types";
import type { Route } from "@/lib/types";

/** How many days forward (including today) the sweep reconciles. Bounds the write surface (mirrors #48). */
const SYNC_HORIZON_DAYS = 14;

const ROLE_LABEL: Record<ShiftRole, string> = { driver: "Driver", field: "Field", prep: "Prep", office: "Office" };
/** Natural duty words for the Slack narration ("delivery helper", not "field"). office never reaches a route
 *  sync (route seats are driver/field only) — the entry exists only to keep the map exhaustive. */
const ROLE_WORD: Record<ShiftRole, string> = { driver: "driver", field: "delivery helper", prep: "warehouse prep", office: "office" };

/** Enabled = Connecteam configured AND not killed by the env escape hatch (mirrors connecteamImportEnabled). */
export function connecteamAutosyncEnabled(): boolean {
  return connecteamConfigured() && process.env.CONNECTEAM_AUTOSYNC_DISABLED !== "1";
}

function audit(actor: string, action: string, entityId: string, after: Record<string, unknown>): void {
  try {
    insertAudit({ actor, action, entity: "staff_shift", entityId, after });
  } catch {
    /* audit must never block a sync */
  }
}

// ── 1. Connecteam -> route auto-assign (apply) ───────────────────────────────────────────────────────

export interface AutoAssignApplyDeps {
  date: string;
  /** Present routes for the day, keyed by routeId (built by the orchestrator). */
  routesById: Map<string, Route>;
  /** userId -> display name (best-effort from Connecteam; null when unknown — never blocks the assign). */
  nameOf: (userId: number) => string | null;
  actor?: string;
}

/** One assign actually made this run — enough for the Slack narration (the pure apply fn COLLECTS these; the
 *  async orchestrator announces them, so the apply stays pure + unit-testable). */
export interface AppliedAssignment {
  userId: number;
  name: string;
  routeId: string;
  truckId: string;
  fillRole: ShiftRole;
  routeStops: number;
  /** The deterministic facts behind the decision (incl. the senior→specialty reason), for the message. */
  reasons: string[];
}

export interface AutoAssignApplyResult {
  assigned: number;
  /** Already on the seat (idempotent no-op) or the route vanished since planning. */
  skipped: number;
  /** Details of each assign made this run, for Slack narration. */
  assignments: AppliedAssignment[];
}

/**
 * Apply the unambiguous auto-assigns to the app, idempotently, through the SAME store path the one-click
 * prompt uses: find/create the route+role shift, add the assignee, dual-write the per-worker row. DB-only
 * (no network) given routesById + nameOf — fully unit-testable.
 */
export function applyRouteAutoAssign(plan: RouteAutoAssignPlan, deps: AutoAssignApplyDeps): AutoAssignApplyResult {
  const actor = deps.actor ?? "connecteam-route-sync";
  let assigned = 0;
  let skipped = 0;
  const assignments: AppliedAssignment[] = [];

  for (const d of plan.autoAssign) {
    const route = deps.routesById.get(d.routeId);
    if (!route) {
      skipped += 1; // the route is gone since planning — don't guess another
      continue;
    }
    const routeShifts = getShiftsForDate(deps.date).filter((s) => s.routeId === route.routeId);
    let shift = routeShifts.find((s) => s.role === d.fillRole) ?? null;
    if (!shift) {
      const win = routeAssignWindow(route, routeShifts);
      shift = createShift({
        date: deps.date,
        role: d.fillRole,
        headcount: 1,
        startTime: win.start,
        endTime: win.end,
        windowKnown: win.known,
        location: null,
        routeId: route.routeId,
        truckId: route.truckId,
        eventLabel: null,
        source: "manual",
      });
    }
    if (shift.assignees.includes(d.userId)) {
      skipped += 1; // already assigned — idempotent
      continue;
    }
    const nextAssignees = [...shift.assignees, d.userId];
    const updated = updateShift(shift.id, { assignees: nextAssignees, headcount: Math.max(shift.headcount, nextAssignees.length) });
    if (!updated) {
      skipped += 1;
      continue;
    }
    try {
      syncInternalAssignments(updated, updated.assignees, deps.nameOf, actor);
    } catch {
      /* a dual-write failure must not fail the assign (assignees is the SoR the board reads) */
    }
    assigned += 1;
    audit(actor, "ROUTE_SYNC_AUTO_ASSIGNED", updated.id, { userId: d.userId, routeId: route.routeId, truckId: route.truckId, fillRole: d.fillRole });
    assignments.push({ userId: d.userId, name: d.name, routeId: route.routeId, truckId: route.truckId, fillRole: d.fillRole, routeStops: route.stops.length, reasons: d.reasons });
  }

  return { assigned, skipped, assignments };
}

// ── 2. App route -> Connecteam auto-create (plan + apply) ──────────────────────────────────────────────

/** A route app shift whose worker ALREADY has a matching Connecteam shift today -> UPDATE that shift in place
 *  (adopt its id, union the window) instead of creating a duplicate. This is the duplication + wrong-time fix. */
export interface AdoptDecision {
  shiftId: string;
  connecteamShiftId: string;
  schedulerId: number;
  timezone: string;
  /** The existing Connecteam shift's title — preserved so an auto-adopt never stomps the human's label. */
  title: string | null;
  startUnix: number; // union (no-shrink) window
  endUnix: number;
  assignees: number[]; // union of the Connecteam shift's assignees and the app shift's (never drops people)
}

export interface RouteCreatePlan {
  /** Route app shifts with NO assignee in Connecteam today -> create one silent Connecteam shift for all. */
  creates: { shiftId: string }[];
  /** Worker already has a matching Connecteam shift -> UPDATE it in place (no duplicate), window unioned. */
  adopts: AdoptDecision[];
  /** Mixed presence (some assignees in Connecteam, some not) -> flag needs_review, never auto-write. */
  flags: { shiftId: string; note: string }[];
  /** Eligible to create but no time window yet -> retry a later cycle (never a fabricated window). */
  deferred: { shiftId: string; reason: string }[];
  /** All assignees already in Connecteam across other shifts (invariant satisfied) or not a route seat. */
  skipped: number;
}

const MIXED_NOTE =
  "Some of this route's assignees already have a Connecteam shift today and some don't. Auto-creating one " +
  "Connecteam shift could duplicate or drop people, so it was left for a human. Publish this shift from " +
  "Dispatch to push it deliberately.";

export const NON_TRUCK_CREW_NOTE =
  "Someone on this route seat is asset prep (Event Asset Processor), which is not truck crew, so no " +
  "Connecteam shift was created for it. Creating one would set their schedule and pay to a truck shift they " +
  "should not be on. Remove them from the route in Scheduling, or confirm the assignment there if it is right.";

/**
 * PURE. Decide, per route app shift, whether to CREATE its Connecteam copy, ADOPT (update) an existing one,
 * flag, or defer. A "route seat" is a shift with a routeId and a driver/field role. `crew` is the day's live
 * Connecteam shifts (the worker's real Connecteam presence). Idempotent: an already-linked shift
 * (connecteam_shift_id set) or an already-needs_review shift is skipped.
 *
 * ADOPT-BEFORE-CREATE is the duplication fix: if the worker already has a Connecteam shift that holds all of
 * this shift's assignees, we UPDATE that shift in place (adopting its id, unioning the window so a longer
 * human shift is never truncated) rather than creating a parallel duplicate.
 */
export function planRouteConnecteamCreate(input: {
  appShifts: StaffShift[];
  crew: CrewShift[];
  /** userId → Connecteam crew role (roleFromTitle). The 4th chokepoint (owner directive 2026-10-30, the
   *  "Raquel" fix): a mirror must never turn a route truck shift into a Connecteam shift for an assignee who
   *  is NOT truck crew. Optional — when absent (older callers / unit tests) the gate is skipped and behaviour
   *  is unchanged; the orchestrator passes it from the Connecteam roster, and a null role (title unknown /
   *  roster unreachable) is treated as "don't block" so we never fabricate an exclusion. */
  crewRoleOf?: (userId: number) => CrewRole | null;
}): RouteCreatePlan {
  const ctUserIds = new Set<number>();
  for (const c of input.crew) for (const a of c.assignees) ctUserIds.add(a.userId);
  const plan: RouteCreatePlan = { creates: [], adopts: [], flags: [], deferred: [], skipped: 0 };

  for (const s of input.appShifts) {
    if (!s.routeId || (s.role !== "driver" && s.role !== "field")) continue; // not a route seat
    if (s.connecteamShiftId) continue; // already linked — never create twice (idempotent)
    if (s.syncStatus === "needs_review") continue; // never fight a human
    if (s.status === "cancelled") continue; // a called-off shift is not pushed to Connecteam
    if (s.assignees.length === 0) continue; // nothing to push

    // 4th CHOKEPOINT — asset prep is never turned into a truck shift (owner directive 2026-10-30). The three
    // auto-ASSIGN chokepoints keep prep off a route seat, but a pre-fix stale assignment or a forced manual
    // override can still leave a non-truck-crew worker on one. Silently mirroring that to Connecteam would set
    // their schedule + PAY to a truck shift, so we flag it for a human instead of writing it. Only blocks when
    // we actually KNOW the role is not truck crew (driver/warehouse are eligible; null/unknown never blocks).
    if (input.crewRoleOf) {
      const offCrew = s.assignees.some((u) => {
        const r = input.crewRoleOf!(u);
        return r != null && !isAutoRouteEligible(r);
      });
      if (offCrew) {
        plan.flags.push({ shiftId: s.id, note: NON_TRUCK_CREW_NOTE });
        continue;
      }
    }

    // ROBUST MATCH (worker + day): the worker already has a Connecteam shift holding all these assignees ->
    // UPDATE it in place, never duplicate. Union the window so Connecteam keeps the broader hours.
    const match = matchConnecteamShiftForPush(s, input.crew);
    if (match) {
      const win = unionPushWindowUnix(s.startTime, s.endTime, match);
      const assignees = [...new Set([...match.assignees.map((a) => a.userId), ...s.assignees])].sort((a, b) => a - b);
      plan.adopts.push({
        shiftId: s.id,
        connecteamShiftId: String(match.id),
        schedulerId: match.schedulerId,
        timezone: match.timezone,
        title: match.title || null,
        startUnix: win.startUnix,
        endUnix: win.endUnix,
        assignees,
      });
      continue;
    }

    const present = s.assignees.filter((u) => ctUserIds.has(u)).length;
    if (present === s.assignees.length) {
      plan.skipped += 1; // everyone is in Connecteam (across other shifts) — invariant satisfied, no dup risk
      continue;
    }
    if (present > 0) {
      plan.flags.push({ shiftId: s.id, note: MIXED_NOTE }); // mixed -> uncertain -> record-only
      continue;
    }
    // Nobody is in Connecteam yet -> create, but only with a real window (never fabricate a time).
    if (!s.windowKnown || !s.startTime || !s.endTime) {
      plan.deferred.push({ shiftId: s.id, reason: "no time window set yet" });
      continue;
    }
    plan.creates.push({ shiftId: s.id });
  }

  return plan;
}

export interface RouteCreateApplyDeps {
  scheduler: Scheduler | null;
  truckNameOf: (truckId: string) => string;
  /** userId -> display name, for the Slack announcement (best-effort; "#id" fallback). */
  nameOf?: (userId: number) => string | null;
  /** Injectable publisher (defaults to the real silent create). Tests pass a fake to assert notifyUsers. */
  publish?: (input: PublishShiftInput) => Promise<PublishShiftResult>;
  /** Injectable updater for ADOPT (defaults to the real silent update). Tests pass a fake to assert the id. */
  publishUpdate?: (input: PublishShiftInput & { shiftId: string }) => Promise<PublishShiftResult>;
  actor?: string;
}

export interface RouteCreateApplyResult {
  created: number;
  /** Existing Connecteam shifts UPDATED in place (worker already had one) instead of duplicated. */
  adopted: number;
  flagged: number;
  deferred: number;
  /** Connecteam rejected/unreachable, or no scheduler -> left unlinked, retried next cycle (honest). */
  failed: number;
}

/**
 * Apply a RouteCreatePlan. Creates are SILENT (notifyUsers=false) and store the returned Connecteam id so
 * #48's reconcile adopts them. Honest-when-unreachable: a failed/ambiguous create leaves the app shift
 * UNLINKED (no fake id) and is retried next cycle — but an accepted create with NO returned id is flagged
 * needs_review (so a re-run can't create a duplicate). Never notifies crew.
 */
export async function applyRouteConnecteamCreate(plan: RouteCreatePlan, deps: RouteCreateApplyDeps): Promise<RouteCreateApplyResult> {
  const actor = deps.actor ?? "connecteam-route-sync";
  const publish = deps.publish ?? ((input: PublishShiftInput) => createPublishedShift(input, { notifyUsers: false }));
  const publishUpdate = deps.publishUpdate ?? ((input: PublishShiftInput & { shiftId: string }) => updatePublishedShift(input, { notifyUsers: false }));
  let created = 0;
  let adopted = 0;
  let flagged = 0;
  let failed = 0;

  for (const f of plan.flags) {
    updateShift(f.shiftId, { syncStatus: "needs_review", syncNote: f.note });
    flagged += 1;
    const nonTruckCrew = f.note === NON_TRUCK_CREW_NOTE;
    audit(actor, "ROUTE_SYNC_NEEDS_REVIEW", f.shiftId, { reason: nonTruckCrew ? "non_truck_crew_on_route" : "mixed_connecteam_presence" });
    // A prep-on-a-truck hold is the user's actual pain, so announce it (owner rule: surface, never silent).
    // The mixed-presence flag stays quiet (it is an ordinary record-only case handled in Scheduling).
    if (nonTruckCrew) {
      const sh = getShiftById(f.shiftId);
      const whoNames = sh ? sh.assignees.map((u) => deps.nameOf?.(u) || `#${u}`).join(", ") : "someone";
      const truckName = sh?.truckId ? deps.truckNameOf(sh.truckId) : (sh?.date ?? "the route");
      void botAnnounce("scheduling", {
        emoji: "⚠️",
        title: "Held a route shift for review",
        fields: [
          { label: "Who", value: whoNames },
          { label: "Truck", value: truckName },
          ...(sh ? [{ label: "Day", value: formatYmdLong(sh.date) }] : []),
        ],
        body: "This person's Connecteam title is asset prep, which is not truck crew, so no Connecteam shift was created. Remove them from the route or confirm the assignment in Scheduling.",
        link: { text: "View in Scheduling", url: appUrl("/scheduling") },
        context: "Scheduling Bot · reply here if that's wrong",
      }).catch(() => {});
    }
  }

  // ADOPT: the worker already has a matching Connecteam shift -> UPDATE it in place (silent), link the app
  // shift to it, and store the unioned (never-shrunk) window. This is the de-dup: no second Connecteam shift
  // is created, and the app shift becomes linked so the importer baselines it (no conflict, no flap).
  for (const a of plan.adopts) {
    const shift = getShiftById(a.shiftId);
    if (!shift) {
      failed += 1;
      continue;
    }
    if (shift.connecteamShiftId) continue; // raced with another write — already linked
    if (!a.startUnix || !a.endUnix || a.endUnix <= a.startUnix) {
      failed += 1;
      continue;
    }
    const truckName = shift.truckId ? deps.truckNameOf(shift.truckId) : shift.date;
    const title = a.title || `${ROLE_LABEL[shift.role]} — ${shift.eventLabel || `${truckName} ${shift.date}`}`;
    const res = await publishUpdate({
      schedulerId: a.schedulerId,
      shiftId: a.connecteamShiftId,
      title,
      startUnix: a.startUnix,
      endUnix: a.endUnix,
      timezone: a.timezone,
      assignedUserIds: a.assignees,
    });
    if (!res.ok) {
      failed += 1; // Connecteam rejected/unreachable -> leave unlinked, retry (never a fake link)
      continue;
    }
    const nowIso = new Date().toISOString();
    updateShift(a.shiftId, {
      status: "sent",
      startTime: new Date(a.startUnix * 1000).toISOString(),
      endTime: new Date(a.endUnix * 1000).toISOString(),
      windowKnown: true,
      assignees: a.assignees,
      connecteamShiftId: a.connecteamShiftId,
      connecteamSchedulerId: a.schedulerId,
      connecteamPublishedAt: nowIso,
      connecteamContentHash: null, // re-baselined by the next import -> no conflict, no flap
      connecteamSyncedAt: nowIso,
      syncStatus: "synced",
      syncNote: null,
    });
    adopted += 1;
    audit(actor, "ROUTE_SYNC_CONNECTEAM_ADOPTED", a.shiftId, { connecteamShiftId: a.connecteamShiftId, schedulerId: a.schedulerId, assignees: a.assignees.length, notifyUsers: false });
    const whoNames = a.assignees.map((u) => deps.nameOf?.(u) || `#${u}`).join(", ") || "the crew";
    void botAnnounce("scheduling", {
      emoji: "🗓️",
      title: "Matched an existing Connecteam shift",
      fields: [
        { label: "Who", value: whoNames },
        { label: "Truck", value: truckName },
        { label: "Day", value: formatYmdLong(shift.date) },
        { label: "Role", value: ROLE_WORD[shift.role] },
        { label: "Window", value: `${hhmm(new Date(a.startUnix * 1000).toISOString())}–${hhmm(new Date(a.endUnix * 1000).toISOString())}` },
      ],
      body: "Linked to the shift they already had so the route doesn't create a duplicate.",
      link: { text: "View in Scheduling", url: appUrl("/scheduling") },
      context: "Scheduling Bot · reply here if that's wrong",
    }).catch(() => {});
  }

  for (const c of plan.creates) {
    const shift = getShiftById(c.shiftId);
    if (!shift) {
      failed += 1;
      continue;
    }
    if (shift.connecteamShiftId) continue; // raced with another write — already linked
    if (!deps.scheduler) {
      failed += 1; // no reachable scheduler -> outage, leave for next cycle
      continue;
    }
    if (!shift.windowKnown || !shift.startTime || !shift.endTime) {
      failed += 1;
      continue;
    }
    const startUnix = Math.floor(Date.parse(shift.startTime) / 1000);
    const endUnix = Math.floor(Date.parse(shift.endTime) / 1000);
    if (!startUnix || !endUnix || endUnix <= startUnix) {
      failed += 1;
      continue;
    }
    const truckName = shift.truckId ? deps.truckNameOf(shift.truckId) : shift.date;
    const title = `${ROLE_LABEL[shift.role]} — ${shift.eventLabel || `${truckName} ${shift.date}`}`;
    const res = await publish({
      schedulerId: deps.scheduler.schedulerId,
      title,
      startUnix,
      endUnix,
      timezone: deps.scheduler.timezone,
      assignedUserIds: shift.assignees,
    });
    if (!res.ok) {
      failed += 1; // Connecteam rejected/unreachable -> leave unlinked, retry (never a fake link)
      continue;
    }
    if (!res.shiftId) {
      // Accepted but returned no id to link. Don't retry (would duplicate); surface it for a human.
      updateShift(c.shiftId, {
        syncStatus: "needs_review",
        syncNote: "Created in Connecteam, but it returned no shift id to link. Resolve by hand so it isn't created again.",
      });
      flagged += 1;
      audit(actor, "ROUTE_SYNC_NEEDS_REVIEW", c.shiftId, { reason: "connecteam_created_no_id" });
      continue;
    }
    updateShift(c.shiftId, {
      status: "sent",
      connecteamShiftId: res.shiftId,
      connecteamSchedulerId: deps.scheduler.schedulerId,
      connecteamPublishedAt: new Date().toISOString(),
    });
    created += 1;
    audit(actor, "ROUTE_SYNC_CONNECTEAM_CREATED", c.shiftId, { connecteamShiftId: res.shiftId, schedulerId: deps.scheduler.schedulerId, assignees: shift.assignees.length, notifyUsers: false });
    // Narrate (owner rule: no silent AI actions). Silent to the CREW (notifyUsers=false) but visible to US.
    const whoNames = shift.assignees.map((u) => deps.nameOf?.(u) || `#${u}`).join(", ") || "the crew";
    void botAnnounce("scheduling", {
      emoji: "🗓️",
      title: "Connecteam shift created",
      fields: [
        { label: "Who", value: whoNames },
        { label: "Truck", value: truckName },
        { label: "Day", value: formatYmdLong(shift.date) },
        { label: "Role", value: ROLE_WORD[shift.role] },
        { label: "Window", value: `${hhmm(shift.startTime)}–${hhmm(shift.endTime)}` },
      ],
      body: "Created so their schedule and pay match the route.",
      link: { text: "View in Scheduling", url: appUrl("/scheduling") },
      context: "Scheduling Bot · reply here if that's wrong",
    }).catch(() => {});
  }

  return { created, adopted, flagged, deferred: plan.deferred.length, failed };
}

// ── Route-row driver reconcile (make route.driverId agree with the driver staff_shift) ──────────────────
//
// A driver assigned via a staff_shift (role=driver) — by the seniority auto-assign above, the one-click
// scheduled-unrouted prompt, the manual board, or the Connecteam import — sets staff_shifts.assignees but
// NOT the ROUTE row's driver_id/driver_name. The Dispatch route header + DRIVER column read route.driverName,
// so a genuinely-staffed route showed "No driver" there while the DRIVER & STAFFING panel (which counts the
// driver shift via assignedCrewForRoute) showed "Driver assigned: Yes / Fully staffed" — the two sides
// disagreed. This reconcile closes that split: for any present route with a driver staff_shift assignee but
// an EMPTY route driver row, set the route driver from the shift (first assignee), mirroring what a
// dispatcher does by hand. Never clobbers an existing route driver (a human's explicit choice stays).

export interface DriverRowReconcileRoute {
  routeId: string;
  /** route.driverId is already set (a dispatcher picked, or a prior reconcile ran) → leave it alone. */
  hasDriverRow: boolean;
  /** userIds on this route's non-cancelled driver staff_shift(s). */
  driverShiftAssignees: number[];
}

export interface DriverRowSet {
  routeId: string;
  userId: number;
}

/** PURE. Decide which route rows to backfill: a route with no driver row but a driver shift assignee gets
 *  its row set from the first assignee. A route that already has a driver row, or no driver shift assignee,
 *  is left untouched. */
export function planRouteDriverRowReconcile(routes: DriverRowReconcileRoute[]): DriverRowSet[] {
  const out: DriverRowSet[] = [];
  for (const r of routes) {
    if (r.hasDriverRow) continue; // never overwrite an explicit route driver
    const uid = r.driverShiftAssignees[0];
    if (uid == null) continue; // no driver shift assignee → nothing to mirror
    out.push({ routeId: r.routeId, userId: uid });
  }
  return out;
}

/** Apply the route-row driver reconcile for a day. DB write (setRouteDriver) + audit; keeps the in-memory
 *  routesById in step so the driverless metric computed afterwards reflects the just-set rows. Returns the
 *  number of route rows set. */
function applyRouteDriverRowReconcile(
  date: string,
  routesById: Map<string, Route>,
  nameOf: (userId: number) => string | null,
  actor: string,
): number {
  const dayShifts = getShiftsForDate(date);
  const driverAssigneesFor = (routeId: string): number[] =>
    dayShifts.filter((s) => s.routeId === routeId && s.role === "driver" && s.status !== "cancelled").flatMap((s) => s.assignees);

  const input: DriverRowReconcileRoute[] = [];
  for (const route of routesById.values()) {
    input.push({ routeId: route.routeId, hasDriverRow: Boolean(route.driverId), driverShiftAssignees: driverAssigneesFor(route.routeId) });
  }

  let set = 0;
  for (const d of planRouteDriverRowReconcile(input)) {
    const name = nameOf(d.userId);
    const res = setRouteDriver(d.routeId, String(d.userId), name);
    if (!res.ok) continue; // route row not present (e.g. a synthetic test route) → harmless no-op
    set += 1;
    const route = routesById.get(d.routeId);
    if (route) {
      route.driverId = String(d.userId);
      route.driverName = name ?? undefined;
    }
    audit(actor, "ROUTE_SYNC_DRIVER_ROW_SET", d.routeId, { userId: d.userId, name, from: "driver_shift_assignee" });
  }
  return set;
}

/** Count present routes that REQUIRE a driver but have none assigned anywhere — no driver on the route row
 *  AND no driver staff_shift assignee. This is the honest "a route that needs crew ended with no driver"
 *  signal the driverless-route alarm pages on (computed AFTER the reconcile, so a route staffed only via a
 *  shift is correctly counted as covered, not driverless). */
function countDriverlessRequiredRoutes(date: string, routesById: Map<string, Route>): number {
  const dayShifts = getShiftsForDate(date);
  let n = 0;
  for (const route of routesById.values()) {
    if (requiredCrewForRoute(route).driver <= 0) continue; // route doesn't need a driver
    const driverShiftAssignees = dayShifts
      .filter((s) => s.routeId === route.routeId && s.role === "driver" && s.status !== "cancelled")
      .reduce((acc, s) => acc + s.assignees.length, 0);
    if (!route.driverId && driverShiftAssignees === 0) n += 1;
  }
  return n;
}

// ── Orchestrator (per day) + runtime tick ──────────────────────────────────────────────────────────────

export interface RouteAutoSyncDayResult {
  date: string;
  /** False -> Connecteam unreachable; nothing was written (honest unknown). */
  reachable: boolean;
  autoAssigned: number;
  /** Of autoAssigned, how many were decided by the driver SENIORITY rule (same-time specialty vs easy). */
  seniorityAssigned: number;
  /** Shift windows GROWN because their route got longer (expand-only ratchet). */
  windowsExpanded: number;
  promptOnly: number; // ambiguous people left for the one-click prompt
  ctCreated: number;
  ctAdopted: number; // existing Connecteam shifts UPDATED in place instead of duplicated (de-dup fix)
  mixedFlagged: number; // route shifts flagged needs_review (mixed presence / no id)
  createDeferred: number; // eligible to create but no window yet
  createFailed: number; // Connecteam rejected/unreachable this cycle
  alreadyInCt: number; // route shifts whose crew are already in Connecteam
  /** Route rows whose driver was backfilled from a driver staff_shift (header/column ↔ panel reconcile). */
  driverRowsSet: number;
  /** Present routes that need a driver but have NONE assigned (route row empty AND no driver shift) after
   *  the sync — the driverless-route alarm's signal for this day. */
  driverlessRequiredRoutes: number;
}

const EMPTY_DAY = (date: string): RouteAutoSyncDayResult => ({
  date,
  reachable: false,
  autoAssigned: 0,
  seniorityAssigned: 0,
  windowsExpanded: 0,
  promptOnly: 0,
  ctCreated: 0,
  ctAdopted: 0,
  mixedFlagged: 0,
  createDeferred: 0,
  createFailed: 0,
  alreadyInCt: 0,
  driverRowsSet: 0,
  driverlessRequiredRoutes: 0,
});

/** HH:MM in the ops timezone (ET) for narration; "TBD" when unknown. */
function hhmm(iso: string | null): string {
  if (!iso) return "TBD";
  try {
    return new Date(iso).toLocaleTimeString("en-US", { timeZone: DISPLAY_TZ, hour: "numeric", minute: "2-digit" });
  } catch {
    return "TBD";
  }
}

/**
 * ROUTE-CHANGE TRACKING. For each route-tied app shift, FOLLOW the route's own window — move the shift
 * earlier/later with it and grow it to cover a longer route — so the schedule, Connecteam, and /dispatch all
 * agree with what Goodshuffle re-optimized. Guardrail: the window MOVES but we never auto-shrink a worker's
 * hours (a shorter route keeps the worker's existing duration; cutting hours stays a human decision). A shift
 * that already brackets the route is left as-is. For a Connecteam-linked shift the moved window is pushed to
 * Connecteam FIRST (silent); only on a successful push is the app side updated, so the Connecteam-wins
 * importer can never flap it back (connecteamContentHash=null makes the next import RE-BASELINE — no conflict,
 * no flag). Every move is announced in Slack so a human can see it and override. Returns the count of shifts
 * moved. Honest-when-unreachable: a failed Connecteam push skips that shift (retry next tick).
 */
export async function applyRouteWindowRatchet(deps: {
  date: string;
  routesById: Map<string, Route>;
  scheduler: Scheduler | null;
  truckNameOf: (id: string) => string;
  nameOf: (uid: number) => string | null;
  actor: string;
}): Promise<number> {
  let expanded = 0;
  const dayShifts = getShiftsForDate(deps.date);
  for (const route of deps.routesById.values()) {
    const rw = routeOwnWindow(route);
    if (!rw.known) continue; // no route window to compare against — nothing to ratchet
    const routeShifts = dayShifts.filter(
      (s) => s.routeId === route.routeId && (s.role === "driver" || s.role === "field") && s.status !== "cancelled",
    );
    for (const shift of routeShifts) {
      const out = trackWindow({ start: shift.startTime, end: shift.endTime, windowKnown: shift.windowKnown }, rw);
      if (!out.changed || !out.start || !out.end) continue;

      // Linked to Connecteam → push the grown window silently FIRST; only expand the app side if it sticks.
      if (shift.connecteamShiftId) {
        const schedulerId = shift.connecteamSchedulerId ?? deps.scheduler?.schedulerId ?? null;
        if (schedulerId == null) continue; // no scheduler to update — retry next tick
        const truckName = shift.truckId ? deps.truckNameOf(shift.truckId) : deps.date;
        const res = await updatePublishedShift(
          {
            schedulerId,
            shiftId: shift.connecteamShiftId,
            title: shift.eventLabel || `${ROLE_LABEL[shift.role]} — ${truckName} ${deps.date}`,
            startUnix: Math.floor(Date.parse(out.start) / 1000),
            endUnix: Math.floor(Date.parse(out.end) / 1000),
            timezone: deps.scheduler?.timezone ?? DISPLAY_TZ,
            assignedUserIds: shift.assignees,
          },
          { notifyUsers: false },
        );
        if (!res.ok) continue; // Connecteam unreachable/rejected → never expand app alone (would flap); retry
      }

      const updated = updateShift(shift.id, {
        startTime: out.start,
        endTime: out.end,
        windowKnown: true,
        // null → the next import re-baselines to the grown Connecteam window (no conflict, no flap).
        ...(shift.connecteamShiftId ? { connecteamContentHash: null } : {}),
      });
      if (!updated) continue;
      expanded += 1;
      audit(deps.actor, "ROUTE_SYNC_SHIFT_EXPANDED", shift.id, {
        routeId: route.routeId,
        from: { start: shift.startTime, end: shift.endTime },
        to: { start: out.start, end: out.end },
        reason: out.reason,
        pushedToConnecteam: Boolean(shift.connecteamShiftId),
      });
      const who = shift.assignees.map((u) => deps.nameOf(u) || `#${u}`).join(", ") || "the crew";
      const truck = shift.truckId ? deps.truckNameOf(shift.truckId) : "the route";
      // "moved" when the block slid earlier/later; "extended" when it only grew at the end.
      const moved = Boolean(out.reason && (out.reason.includes("moved") || out.reason.includes("earlier")));
      void botAnnounce("scheduling", {
        emoji: "🗓️",
        title: moved ? "Shift moved" : "Shift extended",
        fields: [
          { label: "Who", value: who },
          { label: "Truck", value: truck },
          { label: "New window", value: `${hhmm(out.start)}–${hhmm(out.end)}` },
          { label: "Was", value: `${hhmm(shift.startTime)}–${hhmm(shift.endTime)}` },
        ],
        body: `*Why:* ${out.reason}.${shift.connecteamShiftId ? " Updated Connecteam so their hours and pay reflect it." : ""}`,
        link: { text: "View in Scheduling", url: appUrl("/scheduling") },
        context: "Scheduling Bot · reply here if that's wrong",
      }).catch(() => {});
    }
  }
  return expanded;
}

/** Route metadata the driver seniority router needs: start time (for same-time clustering), open driver
 *  seats, and specialty difficulty (tents via crewRules + the configurable keyword list). Reuses the SAME
 *  gap + window readers the pre-check/detector use, so a route's seat + time match exactly. */
function buildSeniorityRouteMeta(date: string, routesById: Map<string, Route>): SeniorityRouteMeta[] {
  const keywords = getSettings().specialtyItemKeywords;
  const dayShifts = getShiftsForDate(date);
  const out: SeniorityRouteMeta[] = [];
  for (const route of routesById.values()) {
    const routeShifts = dayShifts.filter((s) => s.routeId === route.routeId);
    const gap = computeRouteGap({ requiredByRole: requiredCrewForRoute(route), assignedByRole: assignedCrewForRoute(route, routeShifts) });
    const win = routeAssignWindow(route, routeShifts);
    const startMs = win.known && win.start ? Date.parse(win.start) : NaN;
    const spec = routeSpecialty(route, keywords);
    out.push({
      routeId: route.routeId,
      startUnix: Number.isFinite(startMs) ? Math.floor(startMs / 1000) : null,
      driverGap: gap.gapByRole.driver,
      difficulty: spec.difficulty,
      specialty: spec.specialty,
      reasons: spec.reasons,
    });
  }
  return out;
}

/**
 * Reconcile ONE day in both directions. Honest-when-unreachable: if Connecteam can't be read, returns an
 * empty (reachable:false) result and writes NOTHING. Idempotent + kill-switchable at the tick level.
 */
export async function reconcileRouteAutoSyncForDate(date: string, actor = "connecteam-route-sync"): Promise<RouteAutoSyncDayResult> {
  const out = EMPTY_DAY(date);

  // 1. Connecteam -> route auto-assign. scheduledUnroutedForDate is reachable:false on a Connecteam outage.
  const su = await scheduledUnroutedForDate(date);
  if (!su.reachable) return out; // outage -> do nothing
  out.reachable = true;

  const aaPlan = planRouteAutoAssign(su);

  const trucks = getActiveVehicles();
  const truckNameOf = (id: string): string => trucks.find((t) => t.truckId === id)?.name ?? id;
  const routesById = new Map<string, Route>();
  for (const t of trucks) for (const r of getRoutesForDate(t.truckId, date)) routesById.set(r.routeId, r);

  let nameOf: (userId: number) => string | null = () => null;
  let seniorityOf: (userId: number) => string | null = () => null;
  let crewRoleOf: (userId: number) => CrewRole | null = () => null;
  try {
    const users = await getUsers();
    nameOf = (uid) => users.get(uid)?.name ?? null;
    seniorityOf = (uid) => users.get(uid)?.seniorityDate ?? null;
    crewRoleOf = (uid) => users.get(uid)?.role ?? null; // Connecteam Title → crew role (the 4th-chokepoint read)
  } catch {
    /* Connecteam roster unreachable — names/seniority/role stay null, filled on a later tick. */
  }

  // SENIORITY ROUTING: resolve the ambiguous DRIVERS (fit >= 2 routes) across ALL driver-gapped routes —
  // forced moves first (coverage), then senior drivers on the specialty routes and newer drivers on the
  // easier ones. These become real auto-assigns alongside the unambiguous ones; whatever the rule can't place
  // stays in the one-click prompt (promptOnly). Ambiguous FIELD/prep helpers have no seniority tiebreak, so
  // they are left on the prompt (only an UNAMBIGUOUS field match is auto-placed, via planRouteAutoAssign).
  const driverPrompts = aaPlan.prompt
    .filter((p) => p.fillRole === "driver")
    .map((p) => ({ userId: p.userId, name: p.name, eligibleRouteIds: p.eligibleRouteIds, seniorityDate: seniorityOf(p.userId) }));
  // The unambiguous pass already CLAIMED driver seats that aren't applied to the DB yet; subtract those claims
  // from each route's driver gap so the seniority pass can't re-fill the same seat (the apply-time capacity
  // guard backstops this, but planning honestly here keeps promptOnly / narration accurate).
  const driverClaims = new Map<string, number>();
  for (const a of aaPlan.autoAssign) if (a.fillRole === "driver") driverClaims.set(a.routeId, (driverClaims.get(a.routeId) ?? 0) + 1);
  const seniorityMeta = buildSeniorityRouteMeta(date, routesById).map((m) => ({
    ...m,
    driverGap: Math.max(0, m.driverGap - (driverClaims.get(m.routeId) ?? 0)),
  }));
  const seniorityPlan = resolveDriverSeniority(driverPrompts, seniorityMeta);
  const resolvedSet = new Set(seniorityPlan.resolvedUserIds);
  out.promptOnly = aaPlan.prompt.filter((p) => !resolvedSet.has(p.userId)).length;

  // SEAT-CAPACITY CAP (planning layer): bound the combined plan to each route's remaining gap per role, so
  // the broadened field/prep placement — and any overlap between the unambiguous pass and the seniority pass,
  // or two unambiguous people who each fit only the same single-seat route — can never fill a route past its
  // required crew. Budget per (route, role) = required − already-assigned (live, pre-apply). Unambiguous
  // decisions are kept ahead of the seniority ones; a decision with no seat left is dropped (not an error —
  // the person simply isn't auto-placed this cycle, and the detector re-surfaces them if a gap remains).
  const seatBudget = new Map<string, number>();
  const seatKey = (routeId: string, role: RouteCrewRole): string => `${routeId}:${role}`;
  const seatsLeft = (routeId: string, role: RouteCrewRole): number => {
    const key = seatKey(routeId, role);
    if (!seatBudget.has(key)) {
      const route = routesById.get(routeId);
      const live = route
        ? Math.max(0, requiredCrewForRoute(route)[role] - assignedCrewForRoute(route, getShiftsForDate(date).filter((s) => s.routeId === routeId))[role])
        : 0;
      seatBudget.set(key, live);
    }
    return seatBudget.get(key)!;
  };
  const cappedAutoAssign: AutoAssignDecision[] = [];
  for (const d of [...aaPlan.autoAssign, ...seniorityPlan.autoAssign]) {
    if (seatsLeft(d.routeId, d.fillRole) <= 0) continue; // seat already budgeted full — drop, never double-book
    seatBudget.set(seatKey(d.routeId, d.fillRole), seatsLeft(d.routeId, d.fillRole) - 1);
    cappedAutoAssign.push(d);
  }
  const combined: RouteAutoAssignPlan = { ...aaPlan, autoAssign: cappedAutoAssign };
  const aaRes = applyRouteAutoAssign(combined, { date, routesById, nameOf, actor });
  out.autoAssigned = aaRes.assigned;
  out.seniorityAssigned = seniorityPlan.autoAssign.length;

  // Narrate EACH auto-assign in Slack (owner rule: no silent AI actions). Seniority decisions carry their
  // "senior driver → specialty route" reason in d.reasons, so the message explains WHY, not just what.
  for (const a of aaRes.assignments) {
    const truck = a.truckId ? truckNameOf(a.truckId) : "the route";
    const why = a.reasons.length ? a.reasons.join("; ") : "it was the unambiguous match";
    void botAnnounce("scheduling", {
      emoji: "🗓️",
      title: "Crew assigned to a route",
      fields: [
        { label: "Who", value: a.name },
        { label: "Role", value: ROLE_WORD[a.fillRole] },
        { label: "Truck", value: truck },
        { label: "Day", value: formatYmdLong(date) },
        { label: "Route", value: `${a.routeStops} stop${a.routeStops === 1 ? "" : "s"}` },
      ],
      body: `*Why:* ${why}`,
      link: { text: "View in Scheduling", url: appUrl("/scheduling") },
      context: "Scheduling Bot · reply here if that's wrong",
    }).catch(() => {});
  }

  // RECONCILE THE ROUTE-ROW DRIVER with the driver staff_shift. A driver assigned via a shift (the
  // auto-assign above, the one-click prompt, the manual board, or the Connecteam import) sets the shift but
  // not route.driver_id/driver_name, so the Dispatch header + DRIVER column (which read route.driverName)
  // showed "No driver" on a route the staffing panel reported "Fully staffed". Backfill the route row so the
  // two agree. Never overwrites an explicit route driver.
  out.driverRowsSet = applyRouteDriverRowReconcile(date, routesById, nameOf, actor);

  // The scheduler is needed for both the route-change ratchet (silent Connecteam updates) and the auto-create
  // below — fetch it once. Null (unreachable) → the ratchet only touches unlinked shifts; linked ones retry.
  const scheduler = await getDefaultScheduler();

  // 1b. ROUTE-CHANGE TRACKING: a route that Goodshuffle moved (earlier/later) or lengthened moves/grows its
  //     workers' shifts (and their Connecteam hours) to follow it; hours are never auto-shrunk. Announced in
  //     Slack so a human can override. (Field name windowsExpanded kept for the API contract.)
  out.windowsExpanded = await applyRouteWindowRatchet({ date, routesById, scheduler, truckNameOf, nameOf, actor });

  // 2. App route -> Connecteam auto-create (silent). Needs the real Connecteam presence set; if we can't
  //    read it, skip (we must not create blind — that is how duplicates happen).
  const crew = await getCrewForDateSafe(date);
  if (!crew.ok) return out; // reachable for auto-assign (cache) but can't confirm presence now — skip create

  const appShifts = getShiftsForDate(date);
  const createPlan = planRouteConnecteamCreate({ appShifts, crew: crew.shifts, crewRoleOf });
  out.alreadyInCt = createPlan.skipped;
  out.createDeferred = createPlan.deferred.length;

  const applied = await applyRouteConnecteamCreate(createPlan, { scheduler, truckNameOf, nameOf, actor });
  out.ctCreated = applied.created;
  out.ctAdopted = applied.adopted;
  out.mixedFlagged = applied.flagged;
  out.createFailed = applied.failed;

  // Honest end-of-sync signal: present routes that need a driver but have none anywhere (route row empty AND
  // no driver shift). The runtime tick aggregates this across days and pages if it's non-zero (fail-loud).
  out.driverlessRequiredRoutes = countDriverlessRequiredRoutes(date, routesById);

  return out;
}

export interface RouteAutoSyncTickResult {
  ok: boolean;
  detail: string;
  days: number;
  autoAssigned: number;
  /** Of autoAssigned, how many the driver seniority rule decided (same-time specialty vs easy route). */
  seniorityAssigned: number;
  /** Shift windows grown because their route got longer (expand-only ratchet). */
  windowsExpanded: number;
  ctCreated: number;
  /** Existing Connecteam shifts UPDATED in place instead of duplicated (de-dup fix), across the sweep. */
  ctAdopted: number;
  flagged: number;
  unreachableDays: number;
  /** Route rows whose driver was backfilled from a driver staff_shift this sweep. */
  driverRowsSet: number;
  /** Present routes (across reachable days) that need a driver but have none assigned after the sweep. */
  driverlessRequiredRoutes: number;
}

/** The ops-channel link for the scheduling board (request-less; uses PUBLIC_BASE_URL like preCheckNotify). */
function schedulingLink(date: string): string {
  const base = process.env.PUBLIC_BASE_URL?.trim().replace(/\/+$/, "") ?? "";
  const path = `/scheduling?date=${date}`;
  return base ? `${base}${path}` : path;
}

/**
 * Runtime sweep: reconcile today..+SYNC_HORIZON_DAYS. For the RUNTIME_TOKEN-gated tick. Never throws. ok is
 * false only when enabled but EVERY day was unreachable (a real outage worth surfacing); true otherwise
 * (incl. the "disabled"/"not configured" no-ops). An unreachable day is skipped, never written.
 */
export async function runRouteAutoSyncTick(): Promise<RouteAutoSyncTickResult> {
  if (!connecteamAutosyncEnabled()) {
    return {
      ok: true,
      detail: connecteamConfigured() ? "autosync disabled" : "not configured",
      days: 0,
      autoAssigned: 0,
      seniorityAssigned: 0,
      windowsExpanded: 0,
      ctCreated: 0,
      ctAdopted: 0,
      flagged: 0,
      unreachableDays: 0,
      driverRowsSet: 0,
      driverlessRequiredRoutes: 0,
    };
  }
  const today = todayInOpsTz();
  const dates = Array.from({ length: SYNC_HORIZON_DAYS }, (_, i) => shiftYmd(today, i));
  let autoAssigned = 0;
  let seniorityAssigned = 0;
  let windowsExpanded = 0;
  let ctCreated = 0;
  let ctAdopted = 0;
  let flagged = 0;
  let unreachable = 0;
  let reachableDays = 0;
  let driverRowsSet = 0;
  let driverlessRequiredRoutes = 0;
  for (const d of dates) {
    try {
      const r = await reconcileRouteAutoSyncForDate(d);
      if (!r.reachable) {
        unreachable += 1;
        continue;
      }
      reachableDays += 1;
      autoAssigned += r.autoAssigned;
      seniorityAssigned += r.seniorityAssigned;
      windowsExpanded += r.windowsExpanded;
      ctCreated += r.ctCreated;
      ctAdopted += r.ctAdopted;
      flagged += r.mixedFlagged;
      driverRowsSet += r.driverRowsSet;
      driverlessRequiredRoutes += r.driverlessRequiredRoutes;
    } catch {
      unreachable += 1; // a thrown day is an unknown, not a zero — skip it
    }
  }
  const ok = reachableDays > 0;

  // FAIL-LOUD: if we actually reached Connecteam (we KNOW the roster) and present route(s) still need a
  // driver with none assigned, page the ops channel (2h-deduped, one "recovered" note). Only when
  // reachableDays>0 — an all-unreachable sweep is an UNKNOWN, never a false "0 assigned"/false recovery.
  if (reachableDays > 0) {
    const { alert } = recordSchedulingAlarm("driverlessRoutes", driverlessRequiredRoutes > 0);
    if (alert === "down") {
      void slackNotify(
        [
          `Route auto-assign: ${driverlessRequiredRoutes} present route${driverlessRequiredRoutes === 1 ? "" : "s"} still ${driverlessRequiredRoutes === 1 ? "needs" : "need"} a driver and ${driverlessRequiredRoutes === 1 ? "has" : "have"} none assigned (no driver on the route and no driver shift).`,
          `Auto-assign could not fill ${driverlessRequiredRoutes === 1 ? "it" : "them"} from the Connecteam schedule. Assign a driver in Scheduling: ${schedulingLink(today)}`,
        ].join("\n"),
      ).catch(() => {});
    } else if (alert === "recovered") {
      void slackNotify("Route auto-assign: every present route that needs a driver now has one assigned. Driver-gap alarm cleared.").catch(() => {});
    }
  }

  const seniorityNote = seniorityAssigned ? ` (${seniorityAssigned} by seniority)` : "";
  const expandedNote = windowsExpanded ? `, ${windowsExpanded} shift${windowsExpanded === 1 ? "" : "s"} adjusted to the route` : "";
  const driverRowNote = driverRowsSet ? `, ${driverRowsSet} route driver${driverRowsSet === 1 ? "" : "s"} reconciled` : "";
  const driverlessNote = driverlessRequiredRoutes ? `, ${driverlessRequiredRoutes} route${driverlessRequiredRoutes === 1 ? "" : "s"} still need a driver` : "";
  const adoptedNote = ctAdopted ? `, ${ctAdopted} matched to an existing Connecteam shift` : "";
  const detail = reachableDays === 0
    ? `Connecteam unreachable (${unreachable}/${dates.length} days) — skipped, nothing written`
    : `${reachableDays}/${dates.length} days: ${autoAssigned} auto-assigned${seniorityNote}${expandedNote}${driverRowNote}, ${ctCreated} Connecteam shift${ctCreated === 1 ? "" : "s"} created (silent)${adoptedNote}, ${flagged} flagged${driverlessNote}${unreachable ? `, ${unreachable} day(s) unreachable` : ""}`;
  return { ok, detail, days: reachableDays, autoAssigned, seniorityAssigned, windowsExpanded, ctCreated, ctAdopted, flagged, unreachableDays: unreachable, driverRowsSet, driverlessRequiredRoutes };
}
