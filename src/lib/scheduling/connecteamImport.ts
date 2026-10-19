// Connecteam -> app IMPORTER + reconciliation PLANNER (two-way sync, Lisa's workflow). PURE + deterministic:
// given the day's Connecteam shifts and the app's shifts for that day, it computes WHAT to do (create /
// update / flag) without touching the DB or the network. A thin wrapper (connecteamReconcile.ts) does the
// reads/writes and applies this plan idempotently.
//
// FEASIBILITY GATE (resolved honestly, see docs/connecteam-two-way-sync.md): the user chose "last-edit-wins
// by timestamp". That REQUIRES a reliable per-shift last-modified from Connecteam. Connecteam has NO public
// API docs, and the pre-existing reader never captured such a field — so its existence is UNVERIFIED. We do
// NOT fabricate one. Instead:
//   - the reader now captures a last-modified SHAPE-TOLERANTLY (CrewShift.lastModifiedUnix) if the payload
//     exposes one, and
//   - the real conflict engine is CONTENT-HASH change detection, which needs no timestamp: we remember the
//     Connecteam content we last synced, so we can tell WHICH side changed. Last-edit-wins is applied ONLY
//     when a genuine Connecteam last-modified is present; otherwise a true both-sides conflict is flagged
//     needs_review for a human, never silently clobbered.
//
// DAY-LEVEL ROLES: an ingested shift's role is derived from its Connecteam title/assignees; it is NEVER
// attached to a Zoe route (the importer does not guess route assignments — the existing schedule->route
// prompt, scheduledUnrouted.ts, nudges scheduled crew onto routes).
//
// HONESTY: when Connecteam is unreachable the plan is empty + reachable:false; the caller must then do
// NOTHING (never delete/overwrite app shifts on an unknown). An unknown is never a zero.

import { createHash } from "node:crypto";
import { roleFromTitle, type CrewRole, type CrewShift } from "@/lib/connecteam";
import type { ShiftRole, StaffShift } from "./types";

/** Map Connecteam's Title-derived ops role onto the app's ShiftRole. office/admin ("other") -> "office"
 *  (a NON-CREW bucket — never driver/field/prep, never counted as route coverage). */
export function shiftRoleFromCrewRole(role: CrewRole): ShiftRole {
  if (role === "driver") return "driver";
  if (role === "prep") return "prep";
  return "office";
}

/** How much later an app edit must be than the last sync to count as a genuine LOCAL edit (absorbs the
 *  intra-reconcile skew between updateShift's own `now` and the synced-at we write in the same pass). */
const LOCAL_EDIT_TOLERANCE_MS = 5_000;

/** A Connecteam shift normalized into the app's shape, with the content hash the reconciler compares on. */
export interface ImportableShift {
  connecteamShiftId: string;
  schedulerId: number;
  date: string; // the reconcile day (YYYY-MM-DD)
  role: ShiftRole;
  headcount: number;
  startTime: string | null; // ISO
  endTime: string | null; // ISO
  windowKnown: boolean;
  location: string | null;
  eventLabel: string | null;
  assignees: number[]; // sorted ascending (stable hashing + stable storage)
  isOpen: boolean;
  /** Deterministic hash of the fields that define the shift's meaning (see contentHashOf). */
  contentHash: string;
  /** ISO last-modified FROM Connecteam when the payload exposed one; null otherwise (never fabricated). */
  lastModifiedIso: string | null;
}

/** The meaning-bearing content of a Connecteam shift, hashed so a later reconcile can tell whether the
 *  Connecteam side changed since we last synced. Deliberately EXCLUDES ids/timestamps (those are not the
 *  shift's "content") and uses sorted assignees so assignee order can't spuriously flip the hash. */
export function contentHashOf(parts: {
  startTime: string | null;
  endTime: string | null;
  title: string | null;
  assignees: number[];
  isOpen: boolean;
}): string {
  const canonical = JSON.stringify({
    s: parts.startTime ?? null,
    e: parts.endTime ?? null,
    t: (parts.title ?? "").trim(),
    a: [...parts.assignees].sort((x, y) => x - y),
    o: Boolean(parts.isOpen),
  });
  return createHash("sha1").update(canonical).digest("hex");
}

/** The ops role for an ingested shift: prefer the Connecteam shift TITLE's role; if that is the catch-all
 *  "other", fall back to the DOMINANT crew role among its assignees (driver beats prep) so an office person
 *  on an otherwise driver/prep shift still follows that crew role; else "office" (a non-crew office/admin
 *  shift — never field). Day-level only — this never implies a route. */
function roleForShift(shift: CrewShift): ShiftRole {
  const titleRole = roleFromTitle(shift.title);
  if (titleRole !== "other") return shiftRoleFromCrewRole(titleRole);
  const counts: Record<CrewRole, number> = { driver: 0, prep: 0, other: 0 };
  for (const a of shift.assignees) counts[a.role] += 1;
  if (counts.driver > 0 && counts.driver >= counts.prep) return "driver";
  if (counts.prep > 0) return "prep";
  return "office";
}

function isoFromUnix(unix: number): string {
  return new Date(unix * 1000).toISOString();
}

/**
 * Normalize the day's Connecteam shifts into importable shifts, PUBLISHED ONLY. A shift is treated as
 * published when isPublished is true OR absent (the endpoint may only return published shifts, and no
 * public docs confirm the flag — so we drop only EXPLICIT drafts, never guess a missing flag into one).
 * Pure: pass CrewShift[] (from getCrewForDateSafe) + the reconcile date.
 */
export function normalizeForImport(shifts: CrewShift[], date: string): ImportableShift[] {
  const out: ImportableShift[] = [];
  for (const s of shifts) {
    if (s.isPublished === false) continue; // explicit draft — not ingested
    if (!s.id) continue;
    const windowKnown = Number.isFinite(s.startUnix) && Number.isFinite(s.endUnix) && s.endUnix > s.startUnix;
    const startTime = windowKnown ? isoFromUnix(s.startUnix) : null;
    const endTime = windowKnown ? isoFromUnix(s.endUnix) : null;
    const assignees = [...s.assignees.map((a) => a.userId)].sort((x, y) => x - y);
    const title = s.title || "";
    out.push({
      connecteamShiftId: String(s.id),
      schedulerId: s.schedulerId,
      date,
      role: roleForShift(s),
      headcount: Math.max(assignees.length, 1),
      startTime,
      endTime,
      windowKnown,
      location: s.address || null,
      eventLabel: title || null,
      assignees,
      isOpen: Boolean(s.isOpen),
      contentHash: contentHashOf({ startTime, endTime, title, assignees, isOpen: Boolean(s.isOpen) }),
      lastModifiedIso: typeof s.lastModifiedUnix === "number" ? isoFromUnix(s.lastModifiedUnix) : null,
    });
  }
  return out;
}

/** Why a reconcile decision was made (audit + the needs_review note). */
export type ReconcileReason =
  | "connecteam_changed" // only Connecteam changed since last sync -> Connecteam wins
  | "baseline" // an app-pushed shift reconciled for the first time -> record the hash, don't touch content
  | "last_edit_wins_connecteam" // both changed, Connecteam's last-modified is newer -> Connecteam wins
  | "last_edit_wins_app" // both changed, the app edit is newer -> app wins, re-publish needed (needs_review)
  | "both_changed_no_timestamp" // both changed and Connecteam exposes no last-modified -> can't pick, needs_review
  | "connecteam_copy_vanished"; // the linked Connecteam shift is no longer returned -> needs_review, never deleted

export interface CreateDecision {
  ct: ImportableShift;
}
export interface UpdateDecision {
  appShiftId: string;
  ct: ImportableShift;
  /** false = bookkeeping only (baseline): record hash/synced-at, leave the app content untouched. */
  applyContent: boolean;
  reason: ReconcileReason;
}
export interface FlagDecision {
  appShiftId: string;
  connecteamShiftId: string;
  ct: ImportableShift | null; // null when the Connecteam copy vanished
  reason: ReconcileReason;
  note: string;
}

export interface ReconcilePlan {
  reachable: boolean;
  date: string;
  creates: CreateDecision[];
  updates: UpdateDecision[];
  flags: FlagDecision[]; // -> sync_status = needs_review
  unchanged: number;
}

const EMPTY_PLAN = (date: string, reachable: boolean): ReconcilePlan => ({
  reachable,
  date,
  creates: [],
  updates: [],
  flags: [],
  unchanged: 0,
});

/** Was the app shift edited LOCALLY since its last Connecteam sync? (updatedAt meaningfully after syncedAt) */
function appLocallyEdited(app: StaffShift): boolean {
  if (!app.connecteamSyncedAt) return false;
  const u = Date.parse(app.updatedAt);
  const s = Date.parse(app.connecteamSyncedAt);
  if (!Number.isFinite(u) || !Number.isFinite(s)) return false;
  return u - s > LOCAL_EDIT_TOLERANCE_MS;
}

/** True when `a` is strictly newer than `b` (both ISO). */
function isNewer(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  const pa = Date.parse(a);
  const pb = Date.parse(b);
  return Number.isFinite(pa) && Number.isFinite(pb) && pa > pb;
}

/**
 * Compute the reconciliation for one day. PURE.
 *  - `connecteam.ok=false` -> empty plan, reachable:false (caller does NOTHING: honest unknown, never wipe).
 *  - A Connecteam shift with no linked app shift -> CREATE.
 *  - A linked app shift whose Connecteam content is unchanged -> unchanged (idempotent no-op).
 *  - A linked app shift never baselined (no stored hash, app-origin) -> baseline bookkeeping (no content change).
 *  - Only Connecteam changed -> UPDATE (Connecteam wins).
 *  - Both sides changed -> last-edit-wins IF a Connecteam last-modified exists, else FLAG needs_review.
 *  - A linked app shift whose Connecteam copy is no longer returned -> FLAG needs_review (never delete).
 */
export function planReconcile(input: {
  date: string;
  connecteam: { ok: boolean; shifts: CrewShift[] };
  appShifts: StaffShift[];
}): ReconcilePlan {
  if (!input.connecteam.ok) return EMPTY_PLAN(input.date, false);

  const plan = EMPTY_PLAN(input.date, true);
  const imported = normalizeForImport(input.connecteam.shifts, input.date);
  const byCtId = new Map<string, ImportableShift>();
  for (const i of imported) byCtId.set(i.connecteamShiftId, i);

  const linkedApp = new Map<string, StaffShift>();
  for (const a of input.appShifts) {
    if (a.connecteamShiftId) linkedApp.set(a.connecteamShiftId, a);
  }

  // Connecteam -> app: create unlinked, reconcile linked.
  for (const ct of imported) {
    const app = linkedApp.get(ct.connecteamShiftId);
    if (!app) {
      plan.creates.push({ ct });
      continue;
    }
    // Never fight a human: a shift already flagged needs_review stays flagged until a human resolves it.
    if (app.syncStatus === "needs_review") {
      plan.unchanged += 1;
      continue;
    }
    if (app.connecteamContentHash == null) {
      // First time we see this app-pushed shift from the Connecteam side: baseline the hash so future
      // Connecteam edits are detectable, WITHOUT overwriting the app's own content.
      plan.updates.push({ appShiftId: app.id, ct, applyContent: false, reason: "baseline" });
      continue;
    }
    if (app.connecteamContentHash === ct.contentHash) {
      plan.unchanged += 1;
      continue;
    }
    // Connecteam content changed since last sync.
    if (!appLocallyEdited(app)) {
      plan.updates.push({ appShiftId: app.id, ct, applyContent: true, reason: "connecteam_changed" });
      continue;
    }
    // Both sides changed -> try last-edit-wins, else flag.
    if (ct.lastModifiedIso && isNewer(ct.lastModifiedIso, app.updatedAt)) {
      plan.updates.push({ appShiftId: app.id, ct, applyContent: true, reason: "last_edit_wins_connecteam" });
    } else if (ct.lastModifiedIso && isNewer(app.updatedAt, ct.lastModifiedIso)) {
      plan.flags.push({
        appShiftId: app.id,
        connecteamShiftId: ct.connecteamShiftId,
        ct,
        reason: "last_edit_wins_app",
        note: "Edited in Dispatch more recently than in Connecteam. Re-publish this shift from Dispatch to push your change, or edit it in Connecteam. Not overwritten.",
      });
    } else {
      plan.flags.push({
        appShiftId: app.id,
        connecteamShiftId: ct.connecteamShiftId,
        ct,
        reason: "both_changed_no_timestamp",
        note: "Changed in both Connecteam and Dispatch since the last sync, and Connecteam gives no last-modified time to pick a winner. Resolve by hand. Not overwritten.",
      });
    }
  }

  // app -> (missing) Connecteam: a linked app shift whose Connecteam copy is no longer returned. Conservative:
  // flag, never delete (it may have been unpublished, moved, or deleted — a human decides).
  for (const app of input.appShifts) {
    if (!app.connecteamShiftId) continue;
    if (byCtId.has(app.connecteamShiftId)) continue;
    if (app.syncStatus === "needs_review") {
      plan.unchanged += 1;
      continue;
    }
    // Only flag shifts we have actually synced/ingested before — an app shift published this very cycle
    // (never reconciled) that isn't in today's read yet shouldn't be flagged as vanished.
    if (app.source !== "connecteam" && !app.connecteamSyncedAt) continue;
    plan.flags.push({
      appShiftId: app.id,
      connecteamShiftId: app.connecteamShiftId,
      ct: null,
      reason: "connecteam_copy_vanished",
      note: "The linked Connecteam shift is no longer returned for this day (deleted, unpublished, or moved). Review before removing. Not deleted.",
    });
  }

  return plan;
}
