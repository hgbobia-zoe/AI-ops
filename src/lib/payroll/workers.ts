// Unified worker identity — the heart of the control plane. Fuses the LIVE Connecteam roster (internal
// SoR for people, time, rate) with the stored hr_workers overrides (classification, Gusto mapping, pay
// overrides, international contractors). People appear here before any stored row exists; HR's edits (the
// "match + classify" step) persist as overrides. FACTS ONLY — unknown hours stay null, never 0, when the
// time source is unavailable.

import { getUsers, getPayRates, rateForUserOn, getActualHours } from "@/lib/connecteam";
import { listWorkerRecords } from "./store";
import { readGustoSnapshot, type GustoSnapshotMember } from "./gustoSnapshot";
import { getPayrollConfig } from "./config";
import type { PayPeriod, RateSource, UnifiedWorker, WorkerRecord, WorkerType } from "./types";

export interface UnifiedWorkersResult {
  workers: UnifiedWorker[];
  connecteamOk: boolean; // false = time source unavailable → hours are UNVERIFIED (null), not zero
}

function isContractor(t: WorkerType): boolean {
  return t === "US_CONTRACTOR" || t === "INTERNATIONAL_CONTRACTOR";
}

/** A Gusto payUnit is hourly when it's "Hour" (Gusto uses "Hour" | "Year" | "Month" | …). */
function isHourlyUnit(unit: string | null | undefined): boolean {
  return typeof unit === "string" && /hour/i.test(unit);
}

const WORK_HOURS_PER_YEAR = 2080; // 40h × 52w — only used when gustoSalaryToHourly is explicitly enabled

export interface ResolvedRate {
  payRate: number | null;
  rateSource: RateSource | null;
  gustoRate: number | null; // raw Gusto amount (hourly or salary figure), for diagnostics
  gustoRateUnit: string | null;
  connecteamRate: number | null;
  currency: string;
}

/** Resolve a worker's effective pay rate with GUSTO AS THE AUTHORITATIVE SOURCE (that's where they're
 *  hired). Precedence: Gusto hourly rate → manual override → live Connecteam hourly rate → unknown.
 *  Salary (non-hourly) Gusto comp is NOT fabricated into an hourly number unless salaryToHourly is on
 *  (default off). Also surfaces each source's raw value so the UI can say WHERE a rate is missing from. */
export function resolveRate(
  rec: WorkerRecord | null,
  gm: GustoSnapshotMember | null,
  connecteamRate: number | null,
  salaryToHourly: boolean,
): ResolvedRate {
  const gustoRate = gm?.payRate ?? null;
  const gustoRateUnit = gm?.payUnit ?? null;
  const gustoCurrency = gm?.payCurrency ?? null;
  const gustoHourly = gustoRate != null && isHourlyUnit(gustoRateUnit) ? gustoRate : null;
  // Salary → hourly only when explicitly enabled (material payroll-calc change, default off).
  const gustoSalaryHourly =
    salaryToHourly && gustoRate != null && gustoRateUnit != null && /year/i.test(gustoRateUnit)
      ? Math.round((gustoRate / WORK_HOURS_PER_YEAR) * 100) / 100
      : null;

  let payRate: number | null;
  let rateSource: RateSource | null;
  if (gustoHourly != null) { payRate = gustoHourly; rateSource = "gusto"; }
  else if (gustoSalaryHourly != null) { payRate = gustoSalaryHourly; rateSource = "gusto"; }
  else if (rec?.payRate != null) { payRate = rec.payRate; rateSource = "override"; }
  else if (connecteamRate != null) { payRate = connecteamRate; rateSource = "connecteam"; }
  else { payRate = null; rateSource = null; }

  const currency = rec?.currency ?? (rateSource === "gusto" ? gustoCurrency : null) ?? "USD";
  return { payRate, rateSource, gustoRate, gustoRateUnit, connecteamRate, currency };
}

/** Build the merged worker directory for a pay period. Connecteam roster + stored overrides, with actual
 *  period hours and the applicable hourly rate attached. */
export async function unifiedWorkers(period: PayPeriod): Promise<UnifiedWorkersResult> {
  const stored = listWorkerRecords();
  const byCt = new Map<number, (typeof stored)[number]>();
  for (const w of stored) if (w.connecteamUserId != null) byCt.set(w.connecteamUserId, w);

  const [roster, rates, actual] = await Promise.all([
    getUsers(),
    getPayRates(period.start, period.end),
    getActualHours(period.start, period.end),
  ]);
  const connecteamOk = roster.size > 0 || actual.ok;

  // Gusto is the authoritative rate source. Index the snapshot members by Gusto id (empty when no pull yet).
  const snap = readGustoSnapshot();
  const gustoById = new Map<string, GustoSnapshotMember>();
  for (const gm of snap?.members ?? []) gustoById.set(gm.id, gm);
  const salaryToHourly = getPayrollConfig().gustoSalaryToHourly;

  const out: UnifiedWorker[] = [];
  const seenRecordIds = new Set<string>();

  // 1) Everyone on the live Connecteam roster (merged with their override row, if any).
  for (const m of roster.values()) {
    const rec = byCt.get(m.userId) ?? null;
    if (rec) seenRecordIds.add(rec.id);
    const typeInferred = !rec || rec.workerType === "UNKNOWN";
    const workerType: WorkerType = rec && rec.workerType !== "UNKNOWN" ? rec.workerType : "EMPLOYEE";
    const liveRate = rateForUserOn(rates, m.userId, period.end);
    const gm = rec?.gustoId ? gustoById.get(rec.gustoId) ?? null : null;
    const rr = resolveRate(rec, gm, liveRate, salaryToHourly);
    const hours = actual.ok ? actual.hours.get(m.userId) ?? 0 : null;
    out.push({
      key: `ct:${m.userId}`,
      recordId: rec?.id ?? null,
      name: rec?.name || m.name,
      email: rec?.email ?? m.email ?? null,
      workerType,
      typeInferred,
      country: rec?.country ?? null,
      connecteamUserId: m.userId,
      instaworkWorker: rec?.instaworkWorker ?? null,
      inConnecteam: true,
      gustoId: rec?.gustoId ?? null,
      gustoMapped: Boolean(rec?.gustoId),
      payType: rec?.payType ?? "hourly",
      payRate: rr.payRate,
      currency: rr.currency,
      rateSource: rr.rateSource,
      gustoRate: rr.gustoRate,
      gustoRateUnit: rr.gustoRateUnit,
      connecteamRate: rr.connecteamRate,
      active: rec ? rec.active : true,
      excluded: rec?.excluded ?? false,
      excludeReason: rec?.excludeReason ?? null,
      persisted: Boolean(rec),
      periodHours: hours,
      mappingStatus: rec?.gustoId ? "MATCHED" : "UNMATCHED",
    });
  }

  // 2) Stored workers NOT on the live roster (Instawork / manual / ex-Connecteam) — still part of payroll.
  for (const rec of stored) {
    if (seenRecordIds.has(rec.id)) continue;
    if (rec.connecteamUserId != null && byCt.has(rec.connecteamUserId)) continue;
    const gm = rec.gustoId ? gustoById.get(rec.gustoId) ?? null : null;
    const rr = resolveRate(rec, gm, null, salaryToHourly);
    out.push({
      key: `hw:${rec.id}`,
      recordId: rec.id,
      name: rec.name,
      email: rec.email,
      workerType: rec.workerType,
      typeInferred: rec.workerType === "UNKNOWN",
      country: rec.country,
      connecteamUserId: rec.connecteamUserId,
      instaworkWorker: rec.instaworkWorker,
      inConnecteam: false,
      gustoId: rec.gustoId,
      gustoMapped: Boolean(rec.gustoId),
      payType: rec.payType,
      payRate: rr.payRate,
      currency: rr.currency,
      rateSource: rr.rateSource,
      gustoRate: rr.gustoRate,
      gustoRateUnit: rr.gustoRateUnit,
      connecteamRate: rr.connecteamRate,
      active: rec.active,
      excluded: rec.excluded,
      excludeReason: rec.excludeReason,
      persisted: true,
      periodHours: null, // no live hours source for non-Connecteam workers yet
      mappingStatus: rec.gustoId ? "MATCHED" : "UNMATCHED",
    });
  }

  out.sort((a, b) => a.name.localeCompare(b.name));
  return { workers: out, connecteamOk };
}

/** Classification counts for the overview. */
export function workerCounts(workers: UnifiedWorker[]): {
  total: number; employees: number; contractors: number; international: number;
} {
  const active = workers.filter((w) => w.active);
  return {
    total: active.length,
    employees: active.filter((w) => w.workerType === "EMPLOYEE").length,
    contractors: active.filter((w) => isContractor(w.workerType)).length,
    international: active.filter((w) => w.workerType === "INTERNATIONAL_CONTRACTOR").length,
  };
}
