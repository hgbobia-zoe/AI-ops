// Event Risk Engine (MVP2) — the scan. Server-side, reads OUR DB (routes/stops, already
// synced from Goodshuffle) + Connecteam (server-reachable) — no Goodshuffle session needed.
// Assesses the horizon, persists via the lifecycle store, recomputes readiness, and Slacks
// ONLY meaningful changes (new HIGH/CRITICAL, escalations, resolutions, regressions).

import { getActiveVehicles } from "@/lib/vehicles";
import { getRouteForDate, getRouteDates, getEventsInRange, saveEventReadiness, getBookingRevenueByIds, saveDayCapacity, saveCostEntries } from "@/lib/db/repo";
import { captureEventSnapshot, logChange, getLatestSnapshotDates } from "@/lib/history/store";
import { getCrewForDateSafe, connecteamConfigured, getPayRates, rateForUserOn, type CrewShift, type CrewRole } from "@/lib/connecteam";
import { allocateDriverLabor, type CostEntryInput } from "@/lib/finance/allocation";
import { todayInOpsTz, shiftYmd } from "@/lib/dates";
import { slackNotify } from "@/lib/notify/slack";
import { recordPull, logImport } from "@/lib/pull/state";
import { classifyCapacity, type CapacityResult } from "@/lib/capacity/capacity";
import { assessDay, daysUntil, routeWindow, peakConcurrency } from "./engine";
import { DEFAULT_RISK_CONFIG, SEVERITY_RANK } from "./types";
import { reconcileRisks, getRiskQueue, type RiskChanges } from "./store";
import { computeReadiness } from "./readiness";
import type { EngineRoute, EngineShift, RiskFinding } from "./types";

function shiftsForRole(crew: CrewShift[], role: CrewRole): EngineShift[] {
  const out: EngineShift[] = [];
  for (const s of crew)
    for (const a of s.assignees)
      if (a.role === role) out.push({ userId: a.userId, name: a.name, startUnix: s.startUnix, endUnix: s.endUnix, isOpen: s.isOpen });
  return out;
}
function distinctFieldCrew(crew: CrewShift[]): number {
  const ids = new Set<number>();
  for (const s of crew) for (const a of s.assignees) if (a.role === "driver" || a.role === "prep") ids.add(a.userId);
  return ids.size;
}
function latestStopUnix(routes: EngineRoute[]): number | null {
  let best = -Infinity;
  for (const r of routes)
    for (const s of r.stops) {
      const raw = s.plannedWindow || s.eta;
      if (!raw) continue;
      const t = Date.parse(raw);
      if (!Number.isNaN(t)) best = Math.max(best, t);
    }
  return best === -Infinity ? null : Math.floor(best / 1000);
}

export interface ScanResult {
  dates: string[];
  findings: number;
  changes: RiskChanges;
  queueSize: number;
  connecteam: boolean;
  throttled?: boolean;
}

const EMPTY_CHANGES: RiskChanges = { created: [], escalated: [], resolved: [], regressed: [] };
const SCAN_THROTTLE_MS = 5 * 60_000;
const g = globalThis as unknown as { __lastRiskScanAt?: number };

/**
 * Run one risk scan over the horizon. Idempotent: only real state changes are persisted/alerted.
 * Throttled to once per 5 min (so a page auto-refresh doesn't hammer Connecteam); `force` bypasses.
 */
export async function runScan(opts: { horizonDays?: number; force?: boolean } = {}): Promise<ScanResult> {
  const nowMs = Date.now();
  if (!opts.force && g.__lastRiskScanAt && nowMs - g.__lastRiskScanAt < SCAN_THROTTLE_MS) {
    return { dates: [], findings: 0, changes: EMPTY_CHANGES, queueSize: getRiskQueue().length, connecteam: connecteamConfigured(), throttled: true };
  }
  // Claim the throttle window up-front (prevents re-entrant/concurrent scans). If this scan
  // then fails, we roll the timestamp back so a broken scan doesn't block retries for 5 min.
  const prevScanAt = g.__lastRiskScanAt;
  g.__lastRiskScanAt = nowMs;
  try {
    return await doScan(opts);
  } catch (e) {
    g.__lastRiskScanAt = prevScanAt;
    console.error("[risk] scan failed:", e);
    return { dates: [], findings: 0, changes: EMPTY_CHANGES, queueSize: getRiskQueue().length, connecteam: connecteamConfigured(), throttled: false };
  }
}

/** Debounced "scan shortly" — coalesces a burst of imports (e.g. the 3 AM all-trucks pull)
 *  into ONE scan after the data settles. */
export function scheduleScanSoon(delayMs = 8000): void {
  const gt = globalThis as unknown as { __scanSoonTimer?: ReturnType<typeof setTimeout> };
  if (gt.__scanSoonTimer) clearTimeout(gt.__scanSoonTimer);
  gt.__scanSoonTimer = setTimeout(() => {
    gt.__scanSoonTimer = undefined;
    void runScan().catch((e) => console.error("[risk] scheduled scan failed:", e));
  }, delayMs);
}

async function doScan(opts: { horizonDays?: number; force?: boolean }): Promise<ScanResult> {
  const horizon = opts.horizonDays ?? 14;
  const today = todayInOpsTz();
  const last = shiftYmd(today, horizon);
  // Anchor "now" to Eastern noon so proximity math (daysUntil) is in ops-time terms.
  const now = new Date(`${today}T12:00:00Z`);

  // Dates in the horizon that actually have routes.
  const dates = getRouteDates().filter((d) => d >= today && d <= last).sort();
  const trucks = getActiveVehicles();
  const ctOn = connecteamConfigured();
  // Pay rates for the horizon — for event-level driver-labor cost allocation.
  const payRates = ctOn ? await getPayRates(dates[0] ?? today, dates[dates.length - 1] ?? today) : new Map();

  const allFindings: RiskFinding[] = [];
  const costEntries: CostEntryInput[] = [];
  const driverByRoute = new Map<string, string | undefined>(); // for history snapshots
  const unverifiedStaffingDates = new Set<string>(); // dates Connecteam couldn't confirm — freeze, don't resolve
  const capacityResults: CapacityResult[] = [];
  for (const date of dates) {
    const rawRoutes = trucks.map((t) => getRouteForDate(t.truckId, date)).filter((r): r is NonNullable<typeof r> => Boolean(r));
    if (rawRoutes.length === 0) continue;
    const routes: EngineRoute[] = rawRoutes.map((r) => ({
      routeId: r.routeId,
      truckId: r.truckId,
      date: r.date,
      status: r.status,
      gsRouteId: r.gsRouteId,
      driverId: r.driverId,
      driverName: r.driverName,
      stops: r.stops.map((s) => ({
        sequence: s.sequence,
        custName: s.custName,
        kind: s.kind,
        plannedWindow: s.plannedWindow,
        eta: s.eta,
        items: s.items,
      })),
    }));
    for (const r of routes) driverByRoute.set(r.routeId, r.driverName);

    // Connecteam: driver shifts on the event day; warehouse (prep) shifts the day BEFORE (Zoe
    // preps/loads the day before). Field crew (drivers+prep) on the event day feeds tent rules.
    // getCrewForDateSafe reports whether Connecteam actually responded — if not, staffing is
    // UNVERIFIED (skip the staffing rules; never fabricate a shortage).
    const crewD = await getCrewForDateSafe(date);
    const crewPrev = await getCrewForDateSafe(shiftYmd(date, -1));
    const staffingVerified = crewD.ok && crewPrev.ok;
    if (!staffingVerified) unverifiedStaffingDates.add(date);

    // Unload coverage after a pickup day: a prep shift still on the clock when the trucks
    // return (same-day evening), OR any next-day prep shift. Only checked when verified.
    let unloadCovered: boolean | undefined;
    const hasPickups = routes.some((r) => r.stops.some((s) => s.kind === "pickup"));
    if (staffingVerified && hasPickups) {
      const routeEnd = latestStopUnix(routes);
      const crewNext = await getCrewForDateSafe(shiftYmd(date, 1));
      const sameDayLate = shiftsForRole(crewD.shifts, "prep").some((s) => routeEnd == null || s.endUnix >= routeEnd);
      const nextDay = shiftsForRole(crewNext.shifts, "prep").length > 0;
      unloadCovered = sameDayLate || nextDay;
    }

    const driverShifts = shiftsForRole(crewD.shifts, "driver");
    const dayFindings = assessDay({
      date,
      routes,
      driverShifts,
      warehouseShifts: shiftsForRole(crewPrev.shifts, "prep"),
      fieldCrewScheduled: distinctFieldCrew(crewD.shifts),
      unloadCovered,
      staffingVerified,
      now,
    });
    allFindings.push(...dayFindings);

    // Capacity verdict for the day (surface-only). Peak simultaneous routes = min drivers needed.
    const windows = routes.map((r) => routeWindow(r, DEFAULT_RISK_CONFIG)).filter((w): w is NonNullable<typeof w> => Boolean(w));
    const scheduledDrivers = new Set(driverShifts.map((s) => String(s.userId))).size;
    const staffingCats = new Set(["STAFFING", "DRIVER", "WAREHOUSE", "SETUP"]);
    const worst = dayFindings
      .filter((f) => staffingCats.has(f.category) && !f.unverified)
      .reduce<"CRITICAL" | "HIGH" | "MEDIUM" | null>((m, f) => {
        const sev = f.severity === "CRITICAL" || f.severity === "HIGH" || f.severity === "MEDIUM" ? f.severity : null;
        if (!sev) return m;
        return m == null || SEVERITY_RANK[sev] > SEVERITY_RANK[m] ? sev : m;
      }, null);
    capacityResults.push(
      classifyCapacity({
        date,
        fleetSize: trucks.length,
        trucksRouted: routes.length,
        peakConcurrentRoutes: peakConcurrency(windows),
        scheduledDrivers,
        staffingVerified,
        worstStaffingSeverity: worst,
      }),
    );

    // Event-level driver-labor cost (only when Connecteam is verified — else rates/shifts are unknown).
    if (staffingVerified) {
      costEntries.push(
        ...allocateDriverLabor(
          rawRoutes.map((r) => ({ routeId: r.routeId, date: r.date, driverId: r.driverId, driverName: r.driverName, stops: r.stops.map((s) => ({ txId: s.txId })) })),
          driverShifts.map((s) => ({ userId: String(s.userId), startUnix: s.startUnix, endUnix: s.endUnix })),
          (uid) => rateForUserOn(payRates, Number(uid), date),
          date,
        ),
      );
    }
  }
  saveDayCapacity(capacityResults);
  if (costEntries.length > 0) saveCostEntries(costEntries);

  // Persist lifecycle + readiness.
  const changes = reconcileRisks(allFindings, dates, now, unverifiedStaffingDates);
  const events = getEventsInRange(dates);
  const readiness = computeReadiness(events, allFindings);
  saveEventReadiness(
    readiness.map((r) => ({ eventId: r.eventId, date: r.date, label: r.label, routeId: r.routeId, score: r.score, riskLevel: r.riskLevel, components: r.components })),
  );

  // Operational History (MVP4): snapshot each event's known state (deduped — only on a real
  // change) so we can later answer "what did we know N days out?", and log risk lifecycle
  // transitions to the append-only change log (idempotent).
  const revByEvent = getBookingRevenueByIds(readiness.map((r) => r.eventId));
  // Reschedule detection (MVP4 P3): the event's last-known date vs its current schedule date.
  const prevDates = getLatestSnapshotDates();
  for (const ev of readiness) {
    const prev = prevDates.get(ev.eventId);
    if (prev && prev !== ev.date) {
      logChange({
        source: "goodshuffle",
        entity: "event",
        entityId: ev.eventId,
        eventId: ev.eventId,
        kind: "event_rescheduled",
        field: ev.label,
        fromValue: prev,
        toValue: ev.date,
        changeKey: `rescheduled|${ev.eventId}|${prev}|${ev.date}`,
      });
    }
  }
  for (const ev of readiness) {
    const affecting = allFindings.filter((f) => f.date === ev.date && (!f.routeId || f.routeId === ev.routeId));
    captureEventSnapshot(
      {
        eventId: ev.eventId,
        eventDate: ev.date,
        label: ev.label,
        routeId: ev.routeId,
        daysOut: daysUntil(ev.date, now),
        driverName: ev.routeId ? driverByRoute.get(ev.routeId) : undefined,
        riskLevel: ev.riskLevel,
        readinessScore: ev.score,
        openRisks: affecting.length,
        revenue: revByEvent.get(ev.eventId) ?? null,
      },
      new Date(),
    );
  }
  const dayKey = todayInOpsTz();
  for (const r of changes.created) logChange({ source: "risk", entity: "risk", entityId: r.signature, kind: "risk_detected", field: r.title, toValue: r.severity, changeKey: `created|${r.signature}` });
  for (const e of changes.escalated) logChange({ source: "risk", entity: "risk", entityId: e.risk.signature, kind: "risk_escalated", field: e.risk.title, fromValue: e.from, toValue: e.to, changeKey: `escalated|${e.risk.signature}|${e.to}` });
  for (const r of changes.resolved) logChange({ source: "risk", entity: "risk", entityId: r.signature, kind: "risk_resolved", field: r.title, changeKey: `resolved|${r.signature}|${dayKey}` });
  for (const r of changes.regressed) logChange({ source: "risk", entity: "risk", entityId: r.signature, kind: "risk_regressed", field: r.title, changeKey: `regressed|${r.signature}|${dayKey}` });

  // Record Connecteam reachability for the Data Health view (was computed then discarded).
  if (ctOn && dates.length > 0) {
    const verifiedDays = dates.length - unverifiedStaffingDates.size;
    logImport("connecteam", verifiedDays > 0, {
      rowsIn: dates.length,
      rowsWritten: verifiedDays,
      detail: verifiedDays > 0 ? undefined : "Connecteam unreachable during scan",
    });
    if (verifiedDays > 0) recordPull("connecteam", verifiedDays);
  }

  // Slack is best-effort — a notification failure must never fail the scan or lose the
  // persisted risk state (already committed above).
  try {
    await notifyChanges(changes);
  } catch (e) {
    console.error("[risk] Slack notify failed (isolated):", e);
  }

  return { dates, findings: allFindings.length, changes, queueSize: getRiskQueue().length, connecteam: ctOn };
}

/** Slack only what changed (reuses the existing webhook). No-op when nothing meaningful moved. */
async function notifyChanges(c: RiskChanges): Promise<void> {
  const lines: string[] = [];
  for (const r of c.created)
    if (r.severity === "CRITICAL" || r.severity === "HIGH") lines.push(`🆕 *${r.severity}* — ${r.title} (${r.date ?? "—"})`);
  for (const e of c.escalated) lines.push(`⬆️ *${e.from}→${e.to}* — ${e.risk.title} (${e.risk.date ?? "—"})`);
  for (const r of c.regressed) lines.push(`↩️ *Regressed* — ${r.title} (${r.date ?? "—"})`);
  for (const r of c.resolved) lines.push(`✅ Resolved — ${r.title} (${r.date ?? "—"})`);
  if (lines.length === 0) return;
  const CAP = 12;
  const shown = lines.slice(0, CAP);
  const more = lines.length > CAP ? `\n…and ${lines.length - CAP} more (see /risk).` : "";
  await slackNotify(`🧭 *Event Risk update*\n${shown.join("\n")}${more}`);
}
