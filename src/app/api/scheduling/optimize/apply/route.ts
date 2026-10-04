// Apply the deterministic staffing optimizer's plan (Opt-Phase C). Owner/admin + confirm-gated (the
// client confirms before calling). The server RECOMPUTES the plan from current DB state (never trusts a
// client-sent plan — manual changes between preview and apply always win), then writes ONLY the half we
// control: INTERNAL picks become real assignments (dual-write to staff_shifts.assignees + shift_assignments),
// and TEMP seats are RECORDED as a recommendation (count + reason + est hours) — NOT a booked assignment
// and NOT an Instawork post (that stays record-only until the gig-post write is captured). All in one
// transaction; every change is logged to shift_assignment_events. Honest: when the current staffing is
// already optimal, nothing is written and we say so (never a manufactured change).

import { NextResponse } from "next/server";
import { viewerRole } from "@/lib/auth/getSession";
import { canManageSettings } from "@/lib/auth/roles";
import { currentActor } from "@/lib/auth/getSession";
import { getDb } from "@/lib/db";
import { getShiftsForDate, updateShift } from "@/lib/scheduling/store";
import { computeCoverage } from "@/lib/scheduling/coverage";
import { optimizeStaffing } from "@/lib/scheduling/optimize";
import { derivePlanWrites } from "@/lib/scheduling/applyPlan";
import { syncInternalAssignments, upsertAssignment, logShiftEvent } from "@/lib/scheduling/assignments";
import { shiftWindowHours, internalRateFor } from "@/lib/scheduling/cost";
import {
  getCrewForDateSafe,
  getUsersList,
  getUsers,
  getPayRates,
  connecteamConfigured,
  type CrewMember,
  type CrewShift,
  type PayRate,
} from "@/lib/connecteam";
import { getInstaworkShifts, instaworkConfigured } from "@/lib/instawork/client";

export const dynamic = "force-dynamic";

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export async function POST(req: Request): Promise<NextResponse> {
  if (!canManageSettings(await viewerRole())) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  let body: { date?: string };
  try {
    body = (await req.json()) as { date?: string };
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const date = body.date;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return NextResponse.json({ error: "date_required" }, { status: 400 });

  // Reassemble the SAME inputs the board uses, from current DB state.
  const shifts = getShiftsForDate(date);
  const configured = connecteamConfigured();
  const [coverage, roster, rates] = configured
    ? await Promise.all([getCrewForDateSafe(date), getUsersList(), getPayRates(date, date)])
    : [{ ok: false, shifts: [] as CrewShift[] }, [] as CrewMember[], new Map<number, PayRate[]>()];
  const scheduledCrew = dedup(coverage.shifts.flatMap((s) => s.assignees));
  const cov = computeCoverage(shifts, scheduledCrew);
  const iw = instaworkConfigured() ? await getInstaworkShifts() : null;

  const plan = optimizeStaffing({
    date,
    shifts,
    coverage: cov,
    roster,
    dayShifts: coverage.shifts,
    rates,
    instawork: { ok: Boolean(iw?.ok), gigs: iw?.ok ? iw.shifts : [] },
  });

  if (!plan.betterThanCurrent) {
    return NextResponse.json({ ok: true, applied: false, alreadyOptimal: true, note: plan.note });
  }

  const writes = derivePlanWrites(plan);
  const actor = (await currentActor()).label;
  const nameMap = await getUsers().catch(() => new Map<number, CrewMember>());
  const nameOf = (uid: number): string | null => nameMap.get(uid)?.name ?? null;
  const shiftById = new Map(shifts.map((s) => [s.id, s]));

  let internalPlaced = 0;
  let tempRecorded = 0;
  const tx = getDb().transaction(() => {
    for (const w of writes) {
      const shift = shiftById.get(w.shiftId);
      if (!shift) continue;

      // INTERNAL — dual-write the new assignee set (assignees SoR + per-worker rows + events).
      const headcount = Math.max(shift.headcount, w.internalUserIds.length);
      updateShift(w.shiftId, { assignees: w.internalUserIds, headcount });
      syncInternalAssignments({ id: w.shiftId, role: shift.role }, w.internalUserIds, nameOf, actor);
      // Economics snapshot on each internal row (a MIRROR for display/audit; rate SoR stays Connecteam).
      for (const seat of w.internal) {
        const hours = seat.hours ?? shiftWindowHours(shift);
        const rate = internalRateFor(rates, seat.userId, date);
        const cost = hours != null && rate != null ? round2(hours * rate) : null;
        upsertAssignment({
          shiftId: w.shiftId,
          workerKind: "internal",
          connecteamUserId: seat.userId,
          displayName: nameOf(seat.userId),
          role: shift.role,
          estHours: hours,
          estRate: rate,
          estCost: cost,
          routeReason: seat.moved ? "dispatcher_choice" : null,
        });
        internalPlaced += 1;
      }

      // TEMP — record the recommendation only (count + reason + est hours). No booked row, no IW post.
      if (w.tempCount > 0) {
        updateShift(w.shiftId, { instaworkHeadcount: w.tempCount });
        logShiftEvent({
          shiftId: w.shiftId,
          actor,
          kind: "assigned",
          field: "temp_recommended",
          toValue: `${w.tempCount} temp seat(s); reason=${w.tempReason ?? "n/a"}; route=${w.routeReason ?? "n/a"}; hours=${w.tempHours ?? "unknown"}`,
          changeKey: `${w.shiftId}:temp_rec:${w.tempCount}:${w.tempReason ?? ""}`,
        });
        tempRecorded += w.tempCount;
      }
    }
  });
  tx();

  // Audit the AUTO STAFF run: one day-level event (considered / assigned / routes / temp / saving). The
  // apply recomputed from live DB state, so any manual override between preview and apply is preserved by
  // construction. No schema change — the event's to_value already carries JSON blobs elsewhere.
  logShiftEvent({
    shiftId: null,
    actor,
    kind: "auto_staff_run",
    field: "plan",
    toValue: JSON.stringify({
      date,
      considered: plan.assignments.length,
      internalPlaced,
      tempRecorded,
      routes: writes.length,
      tempHoursSaved: plan.tempHoursSaved,
      tempCountSaved: plan.tempCountSaved,
      overridesPreserved: true,
    }),
    changeKey: `${date}:auto_staff:${Date.now()}`,
  });

  return NextResponse.json({
    ok: true,
    applied: true,
    internalPlaced,
    tempRecorded,
    tempHoursSaved: plan.tempHoursSaved,
    tempCountSaved: plan.tempCountSaved,
    note: plan.note,
  });
}

function dedup(crew: CrewMember[]): CrewMember[] {
  const m = new Map<number, CrewMember>();
  for (const a of crew) m.set(a.userId, a);
  return [...m.values()];
}
