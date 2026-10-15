// needs_review conflict SURFACE + RESOLVE — the on-screen counterpart to #48's two-way-sync conflict flag.
// When a shift is flagged staff_shifts.sync_status = 'needs_review' (both sides edited and we can't safely
// pick a winner, or the Connecteam copy vanished, or a route-sync mixed-presence case), Lisa needs to SEE
// the conflict and CHOOSE a winner. This module:
//   - builds a serializable APP-vs-CONNECTEAM comparison per flagged shift (buildConflictViews, pure), and
//   - resolves one shift to a chosen winner (planResolve pure + applyResolveAction effectful), reusing the
//     SAME write primitives as the reconcile/publish paths: pull Connecteam -> app via updateShift, push
//     app -> Connecteam SILENTLY (notifyUsers=false) via create/updatePublishedShift.
//
// HONESTY: when Connecteam is unreachable we show the STORED bookkeeping (link id, last-modified, synced-at,
// note) and REFUSE "keep Connecteam" (we won't guess the authoritative version). Every resolve clears the
// flag back to 'synced' ONLY after its write actually succeeds, and audits the outcome.

import {
  getCrewForDateSafe,
  getDefaultScheduler,
  getSchedulers,
  createPublishedShift,
  updatePublishedShift,
  type CrewShift,
  type PublishShiftInput,
  type PublishShiftResult,
  type Scheduler,
} from "@/lib/connecteam";
import { insertAudit } from "@/lib/db/repo";
import { getShiftById, updateShift } from "./store";
import { normalizeForImport, type ImportableShift } from "./connecteamImport";
import type { ShiftRole, StaffShift } from "./types";

const ROLE_LABEL: Record<ShiftRole, string> = { driver: "Driver", field: "Field", prep: "Prep" };

// ── 1. Conflict view (pure) ────────────────────────────────────────────────────────────────────────

/** One side (app or Connecteam) of a conflict, flattened for display. */
export interface ConflictSide {
  roleLabel: string | null;
  title: string | null;
  assignees: { userId: number; name: string }[];
  startTime: string | null; // ISO
  endTime: string | null;
  windowKnown: boolean;
  /** app: updated_at · Connecteam: its edit time (updateTime / lastModified) when exposed, else null. */
  updatedAt: string | null;
}

/** A flagged shift rendered as app-vs-Connecteam, with enough to pick a winner. Serializable. */
export interface SyncConflictView {
  shiftId: string;
  date: string;
  routeId: string | null;
  connecteamShiftId: string | null;
  linked: boolean;
  syncNote: string | null;
  /** Did the whole day's Connecteam read succeed? false -> we only have the stored snapshot. */
  connecteamReachable: boolean;
  /** Did we find a LIVE Connecteam shift for this link? false when unreachable OR the copy vanished. */
  connecteamLive: boolean;
  app: ConflictSide;
  /** The live Connecteam side; null when unreachable or vanished (then show the stored snapshot instead). */
  connecteam: ConflictSide | null;
  /** Stored bookkeeping shown when the live side is absent. */
  storedLastModified: string | null;
  storedSyncedAt: string | null;
  /** Which side is newer by timestamp, for the "which wins" hint. "unknown" when a time is missing. */
  newerSide: "app" | "connecteam" | "unknown";
  /** keep-Connecteam is offerable: reachable AND (a live version to pull OR a linked copy to accept-remove). */
  canKeepConnecteam: boolean;
  /** keep-app is offerable: Connecteam reachable (we must write the app version into Connecteam). */
  canKeepApp: boolean;
}

function appSide(shift: StaffShift, nameOf: (userId: number) => string | null): ConflictSide {
  return {
    roleLabel: ROLE_LABEL[shift.role] ?? shift.role,
    title: shift.eventLabel,
    assignees: shift.assignees.map((userId) => ({ userId, name: nameOf(userId) ?? `#${userId}` })),
    startTime: shift.startTime,
    endTime: shift.endTime,
    windowKnown: shift.windowKnown,
    updatedAt: shift.updatedAt,
  };
}

function connecteamSide(ct: ImportableShift, nameOf: (userId: number) => string | null): ConflictSide {
  return {
    roleLabel: ROLE_LABEL[ct.role] ?? ct.role,
    title: ct.eventLabel,
    assignees: ct.assignees.map((userId) => ({ userId, name: nameOf(userId) ?? `#${userId}` })),
    startTime: ct.startTime,
    endTime: ct.endTime,
    windowKnown: ct.windowKnown,
    updatedAt: ct.lastModifiedIso,
  };
}

function newer(appIso: string | null, ctIso: string | null): "app" | "connecteam" | "unknown" {
  if (!appIso || !ctIso) return "unknown";
  const a = Date.parse(appIso);
  const c = Date.parse(ctIso);
  if (!Number.isFinite(a) || !Number.isFinite(c)) return "unknown";
  return a > c ? "app" : c > a ? "connecteam" : "unknown";
}

/**
 * PURE. Build a conflict view per flagged shift, matching each to its live Connecteam shift by id (when the
 * read succeeded). `crewShifts` is the day's Connecteam read; `reachable` says whether that read succeeded.
 */
export function buildConflictViews(input: {
  flagged: StaffShift[];
  crewShifts: CrewShift[];
  reachable: boolean;
  nameOf: (userId: number) => string | null;
}): SyncConflictView[] {
  const liveById = new Map<string, ImportableShift>();
  if (input.reachable) {
    for (const s of input.flagged) {
      if (!s.connecteamShiftId) continue;
      const match = input.crewShifts.find((c) => String(c.id) === s.connecteamShiftId);
      if (match) {
        const [ct] = normalizeForImport([match], s.date);
        if (ct) liveById.set(s.connecteamShiftId, ct);
      }
    }
  }

  return input.flagged.map((shift) => {
    const linked = Boolean(shift.connecteamShiftId);
    const live = shift.connecteamShiftId ? liveById.get(shift.connecteamShiftId) ?? null : null;
    const app = appSide(shift, input.nameOf);
    const connecteam = live ? connecteamSide(live, input.nameOf) : null;
    // keep-Connecteam: pull a live version, OR accept the removal of a linked-but-vanished copy.
    const canKeepConnecteam = input.reachable && (connecteam != null || linked);
    const canKeepApp = input.reachable; // writing the app version into Connecteam needs it reachable
    return {
      shiftId: shift.id,
      date: shift.date,
      routeId: shift.routeId,
      connecteamShiftId: shift.connecteamShiftId,
      linked,
      syncNote: shift.syncNote,
      connecteamReachable: input.reachable,
      connecteamLive: connecteam != null,
      app,
      connecteam,
      storedLastModified: shift.connecteamLastModified,
      storedSyncedAt: shift.connecteamSyncedAt,
      newerSide: connecteam ? newer(app.updatedAt, connecteam.updatedAt) : "unknown",
      canKeepConnecteam,
      canKeepApp,
    };
  });
}

// ── 2. Resolve (pure plan + effectful apply) ─────────────────────────────────────────────────────────

export type ResolveWinner = "app" | "connecteam";

export type ResolveAction =
  | { kind: "pull"; ct: ImportableShift } // keep Connecteam: apply the live Connecteam content onto the app shift
  | { kind: "accept_removal" } //            keep Connecteam: the copy vanished -> cancel the app shift, unlink
  | { kind: "push_update" } //               keep app: update the linked Connecteam shift to match the app (silent)
  | { kind: "push_create" } //               keep app: create a Connecteam shift for an unlinked/vanished app shift
  | { kind: "error"; reason: string };

/**
 * PURE. Decide the resolve action for a chosen winner, given reachability and the matched live Connecteam
 * shift (null when unreachable or vanished). Never writes. Refuses "keep Connecteam" when Connecteam is
 * unreachable (we won't guess), and refuses any resolve that would need a write while unreachable.
 */
export function planResolve(input: {
  shift: Pick<StaffShift, "connecteamShiftId">;
  winner: ResolveWinner;
  reachable: boolean;
  live: ImportableShift | null;
}): ResolveAction {
  if (!input.reachable) {
    return { kind: "error", reason: "Connecteam is unreachable right now — resolution is paused so we don't guess. Try again when it's back." };
  }
  const linked = Boolean(input.shift.connecteamShiftId);
  if (input.winner === "connecteam") {
    if (input.live) return { kind: "pull", ct: input.live };
    if (linked) return { kind: "accept_removal" }; // linked but no live copy -> it was removed in Connecteam
    return { kind: "error", reason: "There is no Connecteam version to keep (this shift isn't linked to a Connecteam shift)." };
  }
  // winner === "app": push the app version into Connecteam.
  return linked && input.live ? { kind: "push_update" } : { kind: "push_create" };
}

export interface ResolveApplyDeps {
  scheduler: Scheduler | null;
  createFn?: (input: PublishShiftInput) => Promise<PublishShiftResult>;
  updateFn?: (input: PublishShiftInput & { shiftId: string }) => Promise<PublishShiftResult>;
  actor?: string;
}

export interface ResolveResult {
  ok: boolean;
  action: ResolveAction["kind"];
  message?: string;
}

function audit(actor: string, action: string, entityId: string, after: Record<string, unknown>): void {
  try {
    insertAudit({ actor, action, entity: "staff_shift", entityId, after });
  } catch {
    /* audit must never block a resolve */
  }
}

function publishInputFor(shift: StaffShift, scheduler: Scheduler): PublishShiftInput {
  const startUnix = Math.floor(Date.parse(shift.startTime!) / 1000);
  const endUnix = Math.floor(Date.parse(shift.endTime!) / 1000);
  return {
    schedulerId: scheduler.schedulerId,
    title: `${ROLE_LABEL[shift.role]} — ${shift.eventLabel || shift.date}`,
    startUnix,
    endUnix,
    timezone: scheduler.timezone,
    assignedUserIds: shift.assignees,
  };
}

/**
 * Apply a resolve action to a flagged shift. DB writes are immediate; Connecteam writes are SILENT
 * (notifyUsers=false) and injectable for tests. Clears sync_status to 'synced' ONLY after the required
 * write succeeds. Honest: a failed Connecteam write leaves the flag in place and returns ok:false.
 */
export async function applyResolveAction(shift: StaffShift, action: ResolveAction, deps: ResolveApplyDeps): Promise<ResolveResult> {
  const actor = deps.actor ?? "sync-resolve";
  const now = new Date().toISOString();
  const createFn = deps.createFn ?? ((input: PublishShiftInput) => createPublishedShift(input, { notifyUsers: false }));
  const updateFn = deps.updateFn ?? ((input: PublishShiftInput & { shiftId: string }) => updatePublishedShift(input, { notifyUsers: false }));

  if (action.kind === "error") return { ok: false, action: "error", message: action.reason };

  if (action.kind === "pull") {
    const ct = action.ct;
    updateShift(shift.id, {
      role: ct.role,
      headcount: ct.headcount,
      startTime: ct.startTime,
      endTime: ct.endTime,
      windowKnown: ct.windowKnown,
      location: ct.location,
      eventLabel: ct.eventLabel,
      assignees: ct.assignees,
      connecteamContentHash: ct.contentHash,
      connecteamSyncedAt: now,
      connecteamLastModified: ct.lastModifiedIso,
      syncStatus: "synced",
      syncNote: null,
    });
    audit(actor, "SYNC_RESOLVED_KEEP_CONNECTEAM", shift.id, { connecteamShiftId: shift.connecteamShiftId, assignees: ct.assignees.length });
    return { ok: true, action: "pull" };
  }

  if (action.kind === "accept_removal") {
    updateShift(shift.id, {
      status: "cancelled",
      connecteamShiftId: null,
      connecteamContentHash: null,
      connecteamSyncedAt: now,
      syncStatus: "synced",
      syncNote: null,
    });
    audit(actor, "SYNC_RESOLVED_ACCEPT_REMOVAL", shift.id, { wasConnecteamShiftId: shift.connecteamShiftId });
    return { ok: true, action: "accept_removal" };
  }

  // push_update / push_create — write the app version into Connecteam, silently.
  if (!deps.scheduler) return { ok: false, action: action.kind, message: "No Connecteam scheduler is reachable." };
  if (!shift.windowKnown || !shift.startTime || !shift.endTime) {
    return { ok: false, action: action.kind, message: "Set a start and end time before keeping the app version." };
  }
  if (shift.assignees.length === 0) {
    return { ok: false, action: action.kind, message: "Assign internal crew before keeping the app version." };
  }
  const input = publishInputFor(shift, deps.scheduler);
  if (!input.startUnix || !input.endUnix || input.endUnix <= input.startUnix) {
    return { ok: false, action: action.kind, message: "The shift's time window is invalid." };
  }

  if (action.kind === "push_update") {
    const res = await updateFn({ ...input, shiftId: shift.connecteamShiftId! });
    if (!res.ok) return { ok: false, action: "push_update", message: res.error ?? "Connecteam rejected the update." };
    updateShift(shift.id, {
      status: "sent",
      connecteamSyncedAt: now,
      connecteamContentHash: null, // re-baselined by the next reconcile; avoids a hash-mismatch re-flag
      connecteamLastModified: null,
      syncStatus: "synced",
      syncNote: null,
    });
    audit(actor, "SYNC_RESOLVED_KEEP_APP", shift.id, { connecteamShiftId: shift.connecteamShiftId, mode: "update", notifyUsers: false });
    return { ok: true, action: "push_update" };
  }

  // push_create
  const res = await createFn(input);
  if (!res.ok) return { ok: false, action: "push_create", message: res.error ?? "Connecteam rejected the shift." };
  if (!res.shiftId) return { ok: false, action: "push_create", message: "Created in Connecteam but no id was returned; resolve again when it's confirmed." };
  updateShift(shift.id, {
    status: "sent",
    connecteamShiftId: res.shiftId,
    connecteamSchedulerId: deps.scheduler.schedulerId,
    connecteamPublishedAt: now,
    connecteamSyncedAt: now,
    connecteamContentHash: null,
    syncStatus: "synced",
    syncNote: null,
  });
  audit(actor, "SYNC_RESOLVED_KEEP_APP", shift.id, { connecteamShiftId: res.shiftId, mode: "create", notifyUsers: false });
  return { ok: true, action: "push_create" };
}

/**
 * Resolve ONE flagged shift to a chosen winner. Reads the day's Connecteam schedule, matches the live shift,
 * plans, resolves the scheduler, and applies. Returns a structured result (never throws for a known failure).
 */
export async function resolveNeedsReview(shiftId: string, winner: ResolveWinner, actor = "sync-resolve"): Promise<ResolveResult & { error?: string }> {
  const shift = getShiftById(shiftId);
  if (!shift) return { ok: false, action: "error", error: "not_found", message: "Shift not found." };
  if (shift.syncStatus !== "needs_review") return { ok: false, action: "error", error: "not_flagged", message: "This shift isn't awaiting review." };

  const crew = await getCrewForDateSafe(shift.date);
  let live: ImportableShift | null = null;
  if (crew.ok && shift.connecteamShiftId) {
    const match = crew.shifts.find((c) => String(c.id) === shift.connecteamShiftId);
    if (match) live = normalizeForImport([match], shift.date)[0] ?? null;
  }

  const action = planResolve({ shift, winner, reachable: crew.ok, live });
  if (action.kind === "error") return { ok: false, action: "error", error: "unresolvable", message: action.reason };

  // Scheduler for a push: stay on the shift's original scheduler when known, else the default.
  let scheduler: Scheduler | null = null;
  if (action.kind === "push_update" || action.kind === "push_create") {
    scheduler = shift.connecteamSchedulerId
      ? (await getSchedulers()).find((s) => s.schedulerId === shift.connecteamSchedulerId) ?? (await getDefaultScheduler())
      : await getDefaultScheduler();
  }

  return applyResolveAction(shift, action, { scheduler, actor });
}
