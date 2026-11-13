// Cancelled (or deleted) shifts are pulled from Connecteam. Owner rule 2026-11-13: "Cancelled shifts should
// be pulled." Before this, cancelling in Dispatch only changed the status here: the worker still saw the
// shift in Connecteam, and the next Connecteam import found a live shift no active Dispatch shift claimed and
// brought it straight back as a new active shift. Now the Connecteam copy is taken down first, and only when
// that works does Dispatch cancel and unlink it, so the two can never drift apart silently.

import type { StaffShift } from "./types";

export interface PullDeps {
  deleteShift: (input: { schedulerId: number; shiftId: string }) => Promise<{ ok: boolean; gone?: boolean; error?: string }>;
  defaultSchedulerId: () => Promise<number | null>;
}

export type PullResult =
  | { ok: true; removed: boolean; reason: "not_in_connecteam" | "removed" | "already_gone" | "shared" }
  | { ok: false; error: string };

/** Take `shift`'s Connecteam copy down, unless it isn't in Connecteam or another live Dispatch shift still
 *  points at the same Connecteam shift (one shift, one record: never delete someone else's shift). */
export async function pullFromConnecteam(shift: StaffShift, sameDay: StaffShift[], deps: PullDeps): Promise<PullResult> {
  const ctId = shift.connecteamShiftId;
  if (!ctId) return { ok: true, removed: false, reason: "not_in_connecteam" };
  if (sameDay.some((o) => o.id !== shift.id && o.status !== "cancelled" && o.connecteamShiftId === ctId)) {
    return { ok: true, removed: false, reason: "shared" };
  }
  const schedulerId = shift.connecteamSchedulerId ?? (await deps.defaultSchedulerId());
  if (!schedulerId) return { ok: false, error: "No Connecteam scheduler is reachable, so the shift was not taken down there. Try again." };
  const r = await deps.deleteShift({ schedulerId, shiftId: ctId });
  if (!r.ok) return { ok: false, error: `Connecteam did not take the shift down (${r.error ?? "unknown error"}). Nothing was cancelled. Try again.` };
  return { ok: true, removed: true, reason: r.gone ? "already_gone" : "removed" };
}

/** The Dispatch side once the Connecteam copy is gone: unlinked, so no import can bring it back. */
export const UNLINKED = {
  connecteamShiftId: null,
  connecteamContentHash: null,
  syncStatus: null,
  syncNote: null,
} as const;
