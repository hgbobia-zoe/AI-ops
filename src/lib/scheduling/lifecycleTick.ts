// The runtime shift-lifecycle tick (Lifecycle section G / Opt-Phase D). Side-effecting but SAFE: it reads the
// integrations, reconciles the per-worker rows, recomputes readiness, advances lifecycle states, and
// persists the exception queue idempotently. It NEVER sends a worker anything and makes NO external write
// (no Connecteam publish, no Instawork post) — it only reconciles our own derived state from the systems
// of record, so a missed signal self-heals on the next tick. Gated by the existing RUNTIME_TOKEN cadence.
//
// What it does each run, for the look-ahead window of days that actually have shifts:
//   1. backfill per-worker assignments from assignees (first tick)
//   2. reconcile booked Instawork workers from a FRESH snapshot into instawork assignments (drop/no-show)
//   3. mirror Connecteam timesheets READ-ONLY for internal TIMEKEEPING (day-grain)
//   4. recompute readiness, derive + persist the lifecycle state (lifecycle_state + readiness_json)
//   5. scan exceptions, enrich replacement-needed with the est. additional temp cost, persist idempotently
//   6. Slack newly-opened RED exceptions (reuses slackNotify)
// On an internal cancellation / no-show reopening a seat, the replacement-needed exception is surfaced
// (priority: other internal, then Instawork) with the est. additional temp cost. It does NOT auto-book.

import { getDb } from "@/lib/db";
import { todayInOpsTz, shiftYmd } from "@/lib/dates";
import { getShiftsForDate } from "./store";
import { computeCoverage } from "./coverage";
import { computeShiftReadiness } from "./readiness";
import { deriveShiftLifecycle } from "./lifecycle";
import { scanShiftExceptions } from "./exceptions";
import { buildReadinessInput, buildLifecycleFacts } from "./tick";
import { shiftWindowHours } from "./cost";
import { shiftCommsEnabled } from "./commsFlag";
import {
  getAssignmentsForShift,
  backfillInternalAssignments,
  syncInstaworkAssignments,
  updateAssignment,
  writeShiftLifecycle,
  logShiftEvent,
} from "./assignments";
import { isLiveAssignment } from "./lifecycle";
import { reconcileShiftExceptions, type ExceptionFinding } from "./exceptionStore";
import {
  getCrewForDateSafe,
  getUsers,
  getActualHours,
  connecteamConfigured,
  type CrewMember,
} from "@/lib/connecteam";
import { getInstaworkShifts, instaworkConfigured } from "@/lib/instawork/client";
import { INSTAWORK_STALE_MIN } from "@/lib/instawork/store";
import { instaworkShiftsForDate, instaworkGigsForRoute, instaworkCoversRole } from "@/lib/instawork/reconcile";
import type { InstaworkShift } from "@/lib/instawork/types";
import { slackNotify } from "@/lib/notify/slack";

const LOOKAHEAD_DAYS = 7;

/** Distinct dates with built shifts in [today-1, today+LOOKAHEAD]. today-1 keeps in-progress/complete
 *  shifts advancing; future days get their readiness/exceptions kept current. */
function windowDates(today: string): string[] {
  const from = shiftYmd(today, -1);
  const to = shiftYmd(today, LOOKAHEAD_DAYS);
  const rows = getDb()
    .prepare("SELECT DISTINCT date FROM staff_shifts WHERE date BETWEEN ? AND ? ORDER BY date")
    .all(from, to) as { date: string }[];
  return rows.map((r) => r.date);
}

/** A rough per-seat temp rate for the est. additional cost on a replacement (avg of the day's known gig
 *  base-price per hour). Null when we can't derive one honestly (never fabricated). */
function avgTempHourlyRate(gigs: InstaworkShift[]): number | null {
  const rates: number[] = [];
  for (const g of gigs) {
    if (g.basePrice == null) continue;
    const s = Date.parse(g.startsAt);
    const e = Date.parse(g.endsAt);
    if (Number.isNaN(s) || Number.isNaN(e) || e <= s) continue;
    const h = (e - s) / 3_600_000;
    if (h > 0) rates.push(g.basePrice / h);
  }
  if (rates.length === 0) return null;
  return rates.reduce((a, b) => a + b, 0) / rates.length;
}

export interface TickResult {
  ok: boolean;
  detail: string;
}

/** Run one lifecycle tick. Never throws (the runner logs failures); returns a short human detail. */
export async function runShiftLifecycleTick(now: Date = new Date()): Promise<TickResult> {
  const today = todayInOpsTz();
  const dates = windowDates(today);
  if (dates.length === 0) return { ok: true, detail: "no shifts in window" };

  const ctOk = connecteamConfigured();
  const nameMap = ctOk ? await getUsers().catch(() => new Map<number, CrewMember>()) : new Map<number, CrewMember>();
  const nameOf = (uid: number): string | null => nameMap.get(uid)?.name ?? null;
  const minDate = dates[0];
  // Day-grain actual hours for the timekeeping mirror (past + today only).
  const actual = ctOk && minDate <= today ? await getActualHours(minDate, today).catch(() => ({ ok: false, hours: new Map<number, number>() })) : { ok: false, hours: new Map<number, number>() };

  const iwRes = instaworkConfigured() ? await getInstaworkShifts().catch(() => null) : null;
  const iwAgeMin = iwRes ? (Date.now() - Date.parse(iwRes.fetchedAt)) / 60_000 : Infinity;
  const iwFresh = Boolean(iwRes?.ok) && Number.isFinite(iwAgeMin) && iwAgeMin <= INSTAWORK_STALE_MIN;
  const iwGigs = iwFresh && iwRes ? iwRes.shifts : [];
  const tempRate = avgTempHourlyRate(iwGigs);

  const findings: ExceptionFinding[] = [];
  const unverifiedDates = new Set<string>();
  let shiftCount = 0;
  let backfilled = 0;
  let mirrored = 0;
  const commsWired = shiftCommsEnabled();

  for (const date of dates) {
    const shifts = getShiftsForDate(date);
    shiftCount += shifts.length;

    const cov = ctOk ? await getCrewForDateSafe(date) : { ok: false, shifts: [] as Awaited<ReturnType<typeof getCrewForDateSafe>>["shifts"] };
    const coverageOk = cov.ok;
    if (!coverageOk) unverifiedDates.add(date);
    // Coverage from explicit route assignments only (doc §2.2) — cov.ok still gates reachability honesty.
    const coverage = computeCoverage(shifts);

    const iwDay = iwFresh ? instaworkShiftsForDate(iwGigs, date) : [];

    for (const s of shifts) {
      if (s.status === "cancelled") {
        writeShiftLifecycle(s.id, "CANCELLED", null);
        continue;
      }
      // 1. Backfill internal assignments from assignees (idempotent).
      backfilled += backfillInternalAssignments(s, nameOf);

      // 2. Reconcile booked Instawork workers from the FRESH snapshot (never on a stale snapshot).
      if (iwFresh && s.routeId && s.windowKnown && (s.role === "driver" || s.role === "field")) {
        const startMs = s.startTime ? Date.parse(s.startTime) : null;
        const endMs = s.endTime ? Date.parse(s.endTime) : null;
        const matched = instaworkGigsForRoute(iwDay, { date, startMs, endMs, roles: [s.role] }).filter((g) => instaworkCoversRole(g.position, s.role));
        const workers = [...new Set(matched.flatMap((g) => g.workers))];
        const gigId = matched[0]?.id ?? null;
        if (workers.length > 0 || getAssignmentsForShift(s.id).some((a) => a.workerKind === "instawork" && isLiveAssignment(a.state))) {
          syncInstaworkAssignments({ id: s.id, role: s.role }, { gigId, workers }, "system (lifecycle tick)", now, startMs);
        }
      }

      // 3. Mirror Connecteam timesheets READ-ONLY for internal timekeeping (day-grain).
      if (actual.ok && date <= today) {
        for (const a of getAssignmentsForShift(s.id)) {
          if (a.workerKind !== "internal" || a.connecteamUserId == null || a.clockInAt) continue;
          if ((actual.hours.get(a.connecteamUserId) ?? 0) > 0) {
            const at = s.startTime ?? `${date}T12:00:00.000Z`;
            updateAssignment(a.id, { clockInAt: at, clockSource: "connecteam" });
            logShiftEvent({ shiftId: s.id, assignmentId: a.id, actor: "system (lifecycle tick)", kind: "clock_in", field: "clock_in_at", toValue: at, changeKey: `${a.id}:clock_in:${date}` }, now);
            mirrored += 1;
          }
        }
      }

      // 4. Recompute readiness + derive/persist the lifecycle state.
      const live = getAssignmentsForShift(s.id).filter((a) => isLiveAssignment(a.state));
      const gap = coverage.byShift[s.id]?.gap ?? Math.max(0, s.headcount - s.assignees.length);
      const readiness = computeShiftReadiness(buildReadinessInput(s, gap, live, { coverageOk, commsWired }));
      const facts = buildLifecycleFacts(s, gap, live, { readinessReady: readiness.level === "READY", blockingException: false, now: now.getTime() });
      const state = deriveShiftLifecycle(facts);
      writeShiftLifecycle(s.id, state, JSON.stringify(readiness));
    }

    // 5. Scan exceptions for the day and enrich replacement-needed with the est. additional temp cost.
    const assignmentsByShift = new Map(shifts.map((s) => [s.id, getAssignmentsForShift(s.id)]));
    const scanned = scanShiftExceptions({ shifts, coverage, now: now.getTime(), staffingVerified: coverageOk, assignmentsByShift, commsWired });
    for (const e of scanned) {
      let detail = e.detail;
      if (e.code === "replacement_needed") {
        const s = shifts.find((x) => x.id === e.shiftId);
        const h = s ? shiftWindowHours(s) : null;
        const est = h != null && tempRate != null ? Math.round(h * tempRate) : null;
        detail = est != null ? `${e.detail} Est. additional temp cost about $${est}.` : `${e.detail} Est. additional temp cost unknown (no temp rate).`;
      }
      findings.push({ ...e, detail, date });
    }
  }

  // 6. Persist the exception queue idempotently + Slack newly-opened REDs.
  const changes = reconcileShiftExceptions(findings, dates, now, unverifiedDates);
  for (const opened of changes.opened) {
    if (opened.severity === "RED") await slackNotify(`Shift exception (RED): ${opened.title} - ${opened.detail}`).catch(() => {});
  }

  const parts = [`${shiftCount} shifts`, `${changes.activeCount} open exc`];
  if (backfilled) parts.push(`${backfilled} backfilled`);
  if (mirrored) parts.push(`${mirrored} clock mirror`);
  if (!iwFresh && instaworkConfigured()) parts.push("IW stale");
  return { ok: true, detail: parts.join(", ") };
}
