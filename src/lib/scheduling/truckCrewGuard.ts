// Truck crew guard. OWNER RULE: asset prep (Event Asset Processor) and office staff never go on a route,
// let alone drive. The auto-assign paths already refuse to place them (isAutoRouteEligible and friends), but
// a seat placed BEFORE those fixes, a manual override, or a Connecteam import could still leave one of them
// on a route's driver or helper seat. Nothing downstream re-checked, so that person got a route pass and a
// route debrief. This guard is the backstop that closes the gap no matter how they got there:
//   - finds anyone on a route seat (driver or field shift tied to a route) whose Connecteam title is not
//     truck crew (asset prep or office),
//   - removes them from that route seat in the app (the seat shows as open again, so the gap is honest),
//   - revokes any live route pass minted for them on that truck,
//   - posts one Slack note to the scheduling channel saying who was removed and why.
// It does NOT edit or delete anything in Connecteam (that stays a human call), and an unknown role (roster
// unreachable, name not found) never removes anyone.

import { connecteamConfigured, getUsers, type CrewMember, type CrewRole } from "@/lib/connecteam";
import { getActiveVehicles } from "@/lib/vehicles";
import { getJson, setJson } from "@/lib/kv";
import { insertAudit, listShiftPasses, revokeShiftPass } from "@/lib/db/repo";
import { botAnnounce, appUrl } from "@/lib/notify/aiBots";
import { todayInOpsTz, shiftYmd, formatYmdLong } from "@/lib/dates";
import { getShiftsForDateRange, updateShift } from "./store";
import { syncInternalAssignments } from "./assignments";
import { isAutoRouteEligible } from "./routeAutoAssign";
import type { StaffShift } from "./types";

const ACTOR = "truck-crew-guard";
const ANNOUNCED_KEY = "scheduling.truckCrewGuard.announced";
const LOOKAHEAD_DAYS = 14;

/** A route seat: a driver or field (helper) shift tied to a route. Prep/office shifts are not route seats. */
export function isRouteSeat(s: Pick<StaffShift, "routeId" | "role" | "status">): boolean {
  return !!s.routeId && (s.role === "driver" || s.role === "field") && s.status !== "cancelled";
}

/** True only when we KNOW the worker is not truck crew. Unknown (null) never counts. */
export function knownNotTruckCrew(role: CrewRole | null | undefined): boolean {
  return role != null && !isAutoRouteEligible(role);
}

export interface SeatViolation {
  shiftId: string;
  date: string;
  truckId: string | null;
  seat: "driver" | "field";
  userId: number;
  role: CrewRole;
}

/** Pure: every asset-prep/office worker sitting on a route seat. */
export function findSeatViolations(
  shifts: Pick<StaffShift, "id" | "date" | "routeId" | "truckId" | "role" | "status" | "assignees">[],
  roleOf: (userId: number) => CrewRole | null,
): SeatViolation[] {
  const out: SeatViolation[] = [];
  for (const s of shifts) {
    if (!isRouteSeat(s)) continue;
    for (const uid of s.assignees) {
      const role = roleOf(uid);
      if (knownNotTruckCrew(role)) {
        out.push({ shiftId: s.id, date: s.date, truckId: s.truckId, seat: s.role as "driver" | "field", userId: uid, role: role as CrewRole });
      }
    }
  }
  return out;
}

const ROLE_WORDS: Record<string, string> = { prep: "asset prep (Event Asset Processor)", other: "office / not delivery crew" };

/** Runtime-clock tick. Never throws. */
export async function runTruckCrewGuardTick(): Promise<{ ok: boolean; detail: string }> {
  try {
    if (!connecteamConfigured()) return { ok: true, detail: "Connecteam not configured" };
    const users = await getUsers().catch(() => new Map<number, CrewMember>());
    if (users.size === 0) return { ok: true, detail: "roster unavailable, nothing checked" };

    const today = todayInOpsTz();
    const shifts = getShiftsForDateRange(today, shiftYmd(today, LOOKAHEAD_DAYS));
    const violations = findSeatViolations(shifts, (uid) => users.get(uid)?.role ?? null);
    if (!violations.length) return { ok: true, detail: "no asset prep or office staff on a route seat" };

    const trucks = getActiveVehicles();
    const truckNameOf = (id: string | null): string => (id ? trucks.find((t) => t.truckId === id)?.name ?? id : "the route");
    const nameOf = (uid: number): string | null => users.get(uid)?.name ?? null;
    const byId = new Map(shifts.map((s) => [s.id, s]));
    const removed: string[] = [];

    for (const v of violations) {
      const current = byId.get(v.shiftId);
      if (!current || !current.assignees.includes(v.userId)) continue;
      const nextAssignees = current.assignees.filter((u) => u !== v.userId);
      const updated = updateShift(v.shiftId, { assignees: nextAssignees });
      if (!updated) continue;
      byId.set(v.shiftId, updated);
      try {
        syncInternalAssignments(updated, updated.assignees, nameOf, ACTOR);
      } catch {
        /* the assignees list is what the board reads; a dual-write hiccup must not undo the removal */
      }

      const name = nameOf(v.userId) ?? `Worker ${v.userId}`;
      const truck = truckNameOf(v.truckId);
      // Revoke any live route pass minted for them on this truck (passes are keyed by name + truck).
      let passesRevoked = 0;
      const now = Date.now();
      for (const p of listShiftPasses()) {
        if (p.revokedAt || Date.parse(p.expiresAt) <= now) continue;
        if (p.name.trim() !== name.trim()) continue;
        if (v.truckId && p.truckId && p.truckId !== v.truckId) continue;
        revokeShiftPass(p.id);
        passesRevoked += 1;
      }

      insertAudit({
        actor: ACTOR,
        action: "ROUTE_SEAT_REMOVED_NOT_TRUCK_CREW",
        entity: "staff_shift",
        entityId: v.shiftId,
        before: { assignees: current.assignees },
        after: { assignees: nextAssignees, removedUserId: v.userId, crewRole: v.role, passesRevoked },
      });
      // One Slack note per person per seat, even if a Connecteam re-sync puts them back and we remove again.
      const noteKey = `${v.shiftId}:${v.userId}`;
      const announced = getJson<Record<string, string>>(ANNOUNCED_KEY, {});
      if (announced[noteKey]) {
        removed.push(`${name} off ${truck} ${v.date} (again)`);
        continue;
      }
      announced[noteKey] = new Date().toISOString();
      setJson(ANNOUNCED_KEY, announced);
      void botAnnounce("scheduling", {
        emoji: "⚠️",
        title: "Removed asset prep from a route",
        fields: [
          { label: "Who", value: name },
          { label: "Truck", value: truck },
          { label: "Day", value: formatYmdLong(v.date) },
          { label: "Seat", value: v.seat === "driver" ? "Driver" : "Helper" },
        ],
        body:
          `${name} is ${ROLE_WORDS[v.role] ?? "not truck crew"} in Connecteam, so they never go on a route. I took them off this route seat` +
          `${passesRevoked ? " and turned off their route pass" : ""}. Their Connecteam shift was not changed. Assign a driver or Warehouse Associate instead.`,
        link: { text: "View in Scheduling", url: appUrl("/scheduling") },
        context: "Scheduling Bot · reply here if that's wrong",
      }).catch(() => {});
      removed.push(`${name} off ${truck} ${v.date}`);
    }
    return { ok: true, detail: removed.length ? `removed ${removed.join("; ")}` : "nothing to remove" };
  } catch (e) {
    return { ok: false, detail: `truck crew guard failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}
