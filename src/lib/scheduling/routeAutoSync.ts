// Route auto-sync — the effectful half of the Connecteam <-> Dispatch ROUTE bridge. It does two things each
// cycle, both idempotently and both under the CONNECTEAM_AUTOSYNC_DISABLED kill switch:
//
//   1. Connecteam -> route AUTO-ASSIGN. Takes the scheduledUnrouted detector's output, keeps only the
//      UNAMBIGUOUS matches (planRouteAutoAssign), and performs a REAL app assignment through the SAME path
//      the dispatcher's one-click uses (create/attach the route+role shift, add the assignee, dual-write the
//      per-worker row). Ambiguous people are left for the existing prompt. The staffing gate stays honest —
//      a Connecteam schedule is never credited as coverage; only the real assignment clears the gap.
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
import { getRoutesForDate } from "@/lib/db/repo";
import { insertAudit } from "@/lib/db/repo";
import { todayInOpsTz, shiftYmd, DISPLAY_TZ } from "@/lib/dates";
import { viktorAnnounce } from "@/lib/notify/slack";
import { createShift, getShiftById, getShiftsForDate, updateShift } from "./store";
import { syncInternalAssignments } from "./assignments";
import { routeAssignWindow, requiredCrewForRoute, assignedCrewForRoute, computeRouteGap } from "./preCheck";
import { scheduledUnroutedForDate } from "./scheduledUnrouted";
import { planRouteAutoAssign, type RouteAutoAssignPlan } from "./routeAutoAssign";
import { resolveDriverSeniority, type SeniorityRouteMeta } from "./driverSeniority";
import { routeSpecialty } from "./routeSpecialty";
import { ratchetWindow, routeOwnWindow } from "./routeRatchet";
import { getSettings } from "@/lib/settings";
import type { ShiftRole, StaffShift } from "./types";
import type { Route } from "@/lib/types";

/** How many days forward (including today) the sweep reconciles. Bounds the write surface (mirrors #48). */
const SYNC_HORIZON_DAYS = 14;

const ROLE_LABEL: Record<ShiftRole, string> = { driver: "Driver", field: "Field", prep: "Prep" };

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

export interface AutoAssignApplyResult {
  assigned: number;
  /** Already on the seat (idempotent no-op) or the route vanished since planning. */
  skipped: number;
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
  }

  return { assigned, skipped };
}

// ── 2. App route -> Connecteam auto-create (plan + apply) ──────────────────────────────────────────────

export interface RouteCreatePlan {
  /** Route app shifts with NO assignee in Connecteam today -> create one silent Connecteam shift for all. */
  creates: { shiftId: string }[];
  /** Mixed presence (some assignees in Connecteam, some not) -> flag needs_review, never auto-write. */
  flags: { shiftId: string; note: string }[];
  /** Eligible to create but no time window yet -> retry a later cycle (never a fabricated window). */
  deferred: { shiftId: string; reason: string }[];
  /** All assignees already in Connecteam (invariant satisfied) or not a route seat. */
  skipped: number;
}

const MIXED_NOTE =
  "Some of this route's assignees already have a Connecteam shift today and some don't. Auto-creating one " +
  "Connecteam shift could duplicate or drop people, so it was left for a human. Publish this shift from " +
  "Dispatch to push it deliberately.";

/**
 * PURE. Decide, per route app shift, whether to auto-create its Connecteam copy. A "route seat" is a shift
 * with a routeId and a driver/field role. `connecteamUserIds` is the set of users who have ANY Connecteam
 * shift that day (their real Connecteam presence). Idempotent: an already-linked shift (connecteam_shift_id
 * set) or an already-needs_review shift is skipped.
 */
export function planRouteConnecteamCreate(input: { appShifts: StaffShift[]; connecteamUserIds: number[] }): RouteCreatePlan {
  const ct = new Set(input.connecteamUserIds);
  const plan: RouteCreatePlan = { creates: [], flags: [], deferred: [], skipped: 0 };

  for (const s of input.appShifts) {
    if (!s.routeId || (s.role !== "driver" && s.role !== "field")) continue; // not a route seat
    if (s.connecteamShiftId) continue; // already linked — never create twice (idempotent)
    if (s.syncStatus === "needs_review") continue; // never fight a human
    if (s.status === "cancelled") continue; // a called-off shift is not pushed to Connecteam
    if (s.assignees.length === 0) continue; // nothing to push

    const present = s.assignees.filter((u) => ct.has(u)).length;
    if (present === s.assignees.length) {
      plan.skipped += 1; // everyone is already in Connecteam — invariant already satisfied
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
  /** Injectable publisher (defaults to the real silent create). Tests pass a fake to assert notifyUsers. */
  publish?: (input: PublishShiftInput) => Promise<PublishShiftResult>;
  actor?: string;
}

export interface RouteCreateApplyResult {
  created: number;
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
  let created = 0;
  let flagged = 0;
  let failed = 0;

  for (const f of plan.flags) {
    updateShift(f.shiftId, { syncStatus: "needs_review", syncNote: f.note });
    flagged += 1;
    audit(actor, "ROUTE_SYNC_NEEDS_REVIEW", f.shiftId, { reason: "mixed_connecteam_presence" });
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
  }

  return { created, flagged, deferred: plan.deferred.length, failed };
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
  mixedFlagged: number; // route shifts flagged needs_review (mixed presence / no id)
  createDeferred: number; // eligible to create but no window yet
  createFailed: number; // Connecteam rejected/unreachable this cycle
  alreadyInCt: number; // route shifts whose crew are already in Connecteam
}

const EMPTY_DAY = (date: string): RouteAutoSyncDayResult => ({
  date,
  reachable: false,
  autoAssigned: 0,
  seniorityAssigned: 0,
  windowsExpanded: 0,
  promptOnly: 0,
  ctCreated: 0,
  mixedFlagged: 0,
  createDeferred: 0,
  createFailed: 0,
  alreadyInCt: 0,
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
 * ROUTE-CHANGE RATCHET (expand-only). For each route-tied app shift, if the route's own window now exceeds
 * the shift's window, GROW the shift to cover it; a shorter route is held as-is (never shrink a worker's
 * hours). For a Connecteam-linked shift the grown window is pushed to Connecteam FIRST (silent); only on a
 * successful push is the app side expanded, so the Connecteam-wins importer can never flap it back
 * (connecteamContentHash=null makes the next import RE-BASELINE to the grown window — no conflict, no flag).
 * Every expansion is announced in Slack (viktorAnnounce) so a human can see it and override. Returns the
 * count of shifts expanded. Honest-when-unreachable: a failed Connecteam push skips that shift (retry next tick).
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
      const out = ratchetWindow({ start: shift.startTime, end: shift.endTime, windowKnown: shift.windowKnown }, rw);
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
      void viktorAnnounce(
        `🗓️ *Scheduling bot* — Extended ${who}'s ${truck} shift to ${hhmm(out.start)}–${hhmm(out.end)} (was ${hhmm(shift.startTime)}–${hhmm(shift.endTime)}) because ${out.reason}.` +
          `${shift.connecteamShiftId ? " Updated Connecteam so their hours/pay reflect it." : ""} Reply here if that's wrong.`,
      ).catch(() => {});
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
  try {
    const users = await getUsers();
    nameOf = (uid) => users.get(uid)?.name ?? null;
    seniorityOf = (uid) => users.get(uid)?.seniorityDate ?? null;
  } catch {
    /* Connecteam roster unreachable — names/seniority stay null, filled on a later tick. */
  }

  // SENIORITY ROUTING: resolve the ambiguous DRIVERS (fit >= 2 same-time routes) by putting senior drivers on
  // specialty routes and newer drivers on easier ones. These become real auto-assigns alongside the
  // unambiguous ones; whatever the rule can't place stays in the one-click prompt (promptOnly).
  const seniorityPlan = resolveDriverSeniority(
    aaPlan.prompt
      .filter((p) => p.fillRole === "driver")
      .map((p) => ({ userId: p.userId, name: p.name, eligibleRouteIds: p.eligibleRouteIds, seniorityDate: seniorityOf(p.userId) })),
    buildSeniorityRouteMeta(date, routesById),
  );
  const resolvedSet = new Set(seniorityPlan.resolvedUserIds);
  out.promptOnly = aaPlan.prompt.filter((p) => !resolvedSet.has(p.userId)).length;

  const combined: RouteAutoAssignPlan = { ...aaPlan, autoAssign: [...aaPlan.autoAssign, ...seniorityPlan.autoAssign] };
  const aaRes = applyRouteAutoAssign(combined, { date, routesById, nameOf, actor });
  out.autoAssigned = aaRes.assigned;
  out.seniorityAssigned = seniorityPlan.autoAssign.length;

  // The scheduler is needed for both the route-change ratchet (silent Connecteam updates) and the auto-create
  // below — fetch it once. Null (unreachable) → the ratchet only touches unlinked shifts; linked ones retry.
  const scheduler = await getDefaultScheduler();

  // 1b. ROUTE-CHANGE RATCHET: a route that grew expands its workers' shifts (and their Connecteam hours),
  //     never shrinks. Announced in Slack so a human can override.
  out.windowsExpanded = await applyRouteWindowRatchet({ date, routesById, scheduler, truckNameOf, nameOf, actor });

  // 2. App route -> Connecteam auto-create (silent). Needs the real Connecteam presence set; if we can't
  //    read it, skip (we must not create blind — that is how duplicates happen).
  const crew = await getCrewForDateSafe(date);
  if (!crew.ok) return out; // reachable for auto-assign (cache) but can't confirm presence now — skip create
  const ctUserIds = new Set<number>();
  for (const s of crew.shifts) for (const a of s.assignees) ctUserIds.add(a.userId);

  const appShifts = getShiftsForDate(date);
  const createPlan = planRouteConnecteamCreate({ appShifts, connecteamUserIds: [...ctUserIds] });
  out.alreadyInCt = createPlan.skipped;
  out.createDeferred = createPlan.deferred.length;

  const applied = await applyRouteConnecteamCreate(createPlan, { scheduler, truckNameOf, actor });
  out.ctCreated = applied.created;
  out.mixedFlagged = applied.flagged;
  out.createFailed = applied.failed;

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
  flagged: number;
  unreachableDays: number;
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
      flagged: 0,
      unreachableDays: 0,
    };
  }
  const today = todayInOpsTz();
  const dates = Array.from({ length: SYNC_HORIZON_DAYS }, (_, i) => shiftYmd(today, i));
  let autoAssigned = 0;
  let seniorityAssigned = 0;
  let windowsExpanded = 0;
  let ctCreated = 0;
  let flagged = 0;
  let unreachable = 0;
  let reachableDays = 0;
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
      flagged += r.mixedFlagged;
    } catch {
      unreachable += 1; // a thrown day is an unknown, not a zero — skip it
    }
  }
  const ok = reachableDays > 0;
  const seniorityNote = seniorityAssigned ? ` (${seniorityAssigned} by seniority)` : "";
  const expandedNote = windowsExpanded ? `, ${windowsExpanded} shift${windowsExpanded === 1 ? "" : "s"} expanded` : "";
  const detail = reachableDays === 0
    ? `Connecteam unreachable (${unreachable}/${dates.length} days) — skipped, nothing written`
    : `${reachableDays}/${dates.length} days: ${autoAssigned} auto-assigned${seniorityNote}${expandedNote}, ${ctCreated} Connecteam shift${ctCreated === 1 ? "" : "s"} created (silent), ${flagged} flagged${unreachable ? `, ${unreachable} day(s) unreachable` : ""}`;
  return { ok, detail, days: reachableDays, autoAssigned, seniorityAssigned, windowsExpanded, ctCreated, flagged, unreachableDays: unreachable };
}
