// Unified worker identity — the heart of the control plane. Fuses the LIVE Connecteam roster (internal
// SoR for people, time, rate) with the stored hr_workers overrides (classification, Gusto mapping, pay
// overrides, international contractors). People appear here before any stored row exists; HR's edits (the
// "match + classify" step) persist as overrides. FACTS ONLY — unknown hours stay null, never 0, when the
// time source is unavailable.

import { getUsers, getPayRates, rateForUserOn, getActualHours } from "@/lib/connecteam";
import { listWorkerRecords } from "./store";
import type { PayPeriod, UnifiedWorker, WorkerType } from "./types";

export interface UnifiedWorkersResult {
  workers: UnifiedWorker[];
  connecteamOk: boolean; // false = time source unavailable → hours are UNVERIFIED (null), not zero
}

function isContractor(t: WorkerType): boolean {
  return t === "US_CONTRACTOR" || t === "INTERNATIONAL_CONTRACTOR";
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

  const out: UnifiedWorker[] = [];
  const seenRecordIds = new Set<string>();

  // 1) Everyone on the live Connecteam roster (merged with their override row, if any).
  for (const m of roster.values()) {
    const rec = byCt.get(m.userId) ?? null;
    if (rec) seenRecordIds.add(rec.id);
    const typeInferred = !rec || rec.workerType === "UNKNOWN";
    const workerType: WorkerType = rec && rec.workerType !== "UNKNOWN" ? rec.workerType : "EMPLOYEE";
    const liveRate = rateForUserOn(rates, m.userId, period.end);
    const payRate = rec?.payRate ?? liveRate;
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
      payRate,
      currency: rec?.currency ?? "USD",
      active: rec ? rec.active : true,
      persisted: Boolean(rec),
      periodHours: hours,
      mappingStatus: rec?.gustoId ? "MATCHED" : "UNMATCHED",
    });
  }

  // 2) Stored workers NOT on the live roster (Instawork / manual / ex-Connecteam) — still part of payroll.
  for (const rec of stored) {
    if (seenRecordIds.has(rec.id)) continue;
    if (rec.connecteamUserId != null && byCt.has(rec.connecteamUserId)) continue;
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
      payRate: rec.payRate,
      currency: rec.currency ?? "USD",
      active: rec.active,
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
