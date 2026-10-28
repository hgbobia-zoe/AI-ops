// Gusto → Connecteam rate-sync engine. Gusto is the authoritative pay-rate source ("that's where we hire
// them"), so this proposes writing each mapped worker's HOURLY Gusto rate INTO Connecteam (the time source
// that funds payroll). PROPOSE-FIRST by design: computing proposals is read-only; a write happens only on an
// explicit approve (approveRateSyncProposal) or, if GUSTO_RATE_SYNC_AUTO is deliberately turned on, via
// applyRateSyncProposals. A Connecteam write funds payroll, so it is treated as a material action — nothing
// here writes on its own. Idempotent: a rate already in sync is never rewritten. Honest: a write is "ok" only
// on a real 2xx; a missing pay_rates.write scope (403) is surfaced, never swallowed.

import { getPayRates, rateForUserOn, setConnecteamPayRate } from "@/lib/connecteam";
import { readGustoSnapshot, type GustoSnapshotMember } from "./gustoSnapshot";
import { listWorkerRecords } from "./store";
import { getPayrollConfig } from "./config";
import type { WorkerRecord } from "./types";

const RATE_EPSILON = 0.005; // rates within half a cent are "the same" (idempotent — no rewrite)

export interface RateSyncProposal {
  workerKey: string; // ct:<userId>
  recordId: string;
  name: string;
  connecteamUserId: number;
  gustoRate: number; // the authoritative hourly rate from Gusto
  connecteamRate: number | null; // current Connecteam hourly rate (null = none yet)
  currency: string | null;
  effectiveDate: string; // YYYY-MM-DD the write would take effect
  kind: "new" | "update"; // new = Connecteam has no rate; update = differs
}

export interface RateSyncPlan {
  asOf: string | null; // the Gusto snapshot's fetch time (null = no pull yet)
  effectiveDate: string;
  proposals: RateSyncProposal[];
  // Diagnostics for the UI: mapped workers whose Gusto comp can't drive an hourly write.
  salaried: number; // mapped workers whose Gusto comp is a salary (non-hourly) — not synced
  noGustoRate: number; // mapped workers with a Gusto id but no rate captured in the snapshot
}

function isHourly(unit: string | null | undefined): boolean {
  return typeof unit === "string" && /hour/i.test(unit);
}

/** PURE diff: given the mapped records, the Gusto members by id, and current Connecteam rates, compute the
 *  proposals (Gusto hourly ≠ Connecteam, or Connecteam missing). Rates in sync are skipped (idempotent). */
export function computeRateSyncProposals(
  records: WorkerRecord[],
  gustoById: Map<string, GustoSnapshotMember>,
  ctRates: Map<number, { hourlyRate: number; effectiveDate: string; userId: number }[]>,
  effectiveDate: string,
): RateSyncPlan {
  const proposals: RateSyncProposal[] = [];
  let salaried = 0;
  let noGustoRate = 0;
  for (const rec of records) {
    if (rec.connecteamUserId == null || !rec.gustoId || !rec.active || rec.excluded) continue;
    const gm = gustoById.get(rec.gustoId);
    if (!gm) continue;
    if (gm.payRate == null) { noGustoRate++; continue; }
    if (!isHourly(gm.payUnit)) { salaried++; continue; } // salary → never fabricated into an hourly write
    const gustoRate = gm.payRate;
    const ctRate = rateForUserOn(ctRates, rec.connecteamUserId, effectiveDate);
    if (ctRate != null && Math.abs(ctRate - gustoRate) < RATE_EPSILON) continue; // already in sync
    proposals.push({
      workerKey: `ct:${rec.connecteamUserId}`,
      recordId: rec.id,
      name: rec.name,
      connecteamUserId: rec.connecteamUserId,
      gustoRate,
      connecteamRate: ctRate,
      currency: gm.payCurrency ?? rec.currency ?? "USD",
      effectiveDate,
      kind: ctRate == null ? "new" : "update",
    });
  }
  return { asOf: null, effectiveDate, proposals, salaried, noGustoRate };
}

/** Build the current proposal plan (read-only). Fetches the Gusto snapshot + the live Connecteam rates. */
export async function buildRateSyncPlan(effectiveDate?: string): Promise<RateSyncPlan> {
  const snap = readGustoSnapshot();
  const eff = effectiveDate ?? new Date().toISOString().slice(0, 10);
  if (!snap) return { asOf: null, effectiveDate: eff, proposals: [], salaried: 0, noGustoRate: 0 };
  const gustoById = new Map<string, GustoSnapshotMember>();
  for (const gm of snap.members) gustoById.set(gm.id, gm);
  const ctRates = await getPayRates(eff, eff);
  const plan = computeRateSyncProposals(listWorkerRecords(), gustoById, ctRates, eff);
  return { ...plan, asOf: snap.fetchedAt };
}

export interface RateWriteResult {
  ok: boolean;
  connecteamUserId: number;
  gustoRate: number;
  error?: string;
}

/** Approve ONE proposal: write the Gusto rate into Connecteam. Honest (ok only on a real 2xx) + audited. */
export async function approveRateSyncProposal(p: {
  connecteamUserId: number; gustoRate: number; effectiveDate: string; actor: string; name?: string | null;
}): Promise<RateWriteResult> {
  const r = await setConnecteamPayRate(p.connecteamUserId, p.gustoRate, p.effectiveDate);
  if (r.ok) {
    try {
      const { insertAudit } = await import("@/lib/db/repo");
      insertAudit({
        actor: p.actor,
        action: "payroll.rate_sync.write",
        entity: "connecteam_user",
        entityId: String(p.connecteamUserId),
        after: { name: p.name ?? null, gustoRate: p.gustoRate, effectiveDate: p.effectiveDate },
      });
    } catch { /* audit is best-effort — never fails the write */ }
    return { ok: true, connecteamUserId: p.connecteamUserId, gustoRate: p.gustoRate };
  }
  return { ok: false, connecteamUserId: p.connecteamUserId, gustoRate: p.gustoRate, error: r.error ?? "write failed" };
}

export interface RateSyncRunResult {
  attempted: number;
  written: number;
  errors: string[];
  skippedDisabled: boolean; // true = GUSTO_RATE_SYNC_AUTO is off, so nothing was written
}

/** Apply ALL current proposals WITHOUT per-proposal approval — gated on GUSTO_RATE_SYNC_AUTO (default OFF).
 *  When the flag is off this writes nothing and reports skippedDisabled. Not wired to any automatic trigger;
 *  exists for a future deliberate "sync all rates now" action once the team trusts the engine. */
export async function applyRateSyncProposals(actor: string): Promise<RateSyncRunResult> {
  if (!getPayrollConfig().gustoRateSyncAuto) {
    return { attempted: 0, written: 0, errors: [], skippedDisabled: true };
  }
  const plan = await buildRateSyncPlan();
  let written = 0;
  const errors: string[] = [];
  for (const p of plan.proposals) {
    const r = await approveRateSyncProposal({ connecteamUserId: p.connecteamUserId, gustoRate: p.gustoRate, effectiveDate: p.effectiveDate, actor, name: p.name });
    if (r.ok) written++;
    else errors.push(`#${p.connecteamUserId} (${p.name}): ${r.error}`);
  }
  return { attempted: plan.proposals.length, written, errors, skippedDisabled: false };
}
