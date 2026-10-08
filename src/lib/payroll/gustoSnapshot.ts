// Gusto snapshot — the browser Auto-Pull extension (extension/gusto.js) runs INSIDE a logged-in
// app.gusto.com tab, replays Gusto's GraphQL operations same-origin (carrying the operator's session), and
// POSTs the raw responses to /api/payroll/gusto/import. We parse + snapshot them here; the server NEVER
// calls Gusto directly (the official API is pending approval, and this mirrors the Goodshuffle/Instawork
// browser-pull pattern). Persisted in the settings KV. Never throws. FACTS ONLY — unknowns stay null.

import { getDb } from "@/lib/db";

const KEY = "gusto.snapshot";

/** How recent the browser pull must be for Gusto to count as fresh/connected (same cadence as Instawork). */
export const GUSTO_STALE_MIN = 120;

export interface GustoSnapshotMember {
  id: string; // Gusto member id → stored as hr_workers.gusto_id
  firstName: string;
  lastName: string;
  preferredName: string | null;
  businessName: string | null;
  personType: "employee" | "contractor" | string;
  department: string | null;
  jobTitle: string | null;
  country: string | null;
  employmentEntityUuid: string | null;
  // Compensation from the per-worker pay query (CompanyMemberDashboardPeopleShowPay), when pulled.
  payRate: number | null; // the amount (hourly rate, or salary figure when payUnit is not hourly)
  payCurrency: string | null;
  payUnit: string | null; // "Hour" (hourly) | "Year" | "Month" | …
}
export interface GustoSnapshotPayPeriod {
  id: string;
  displayName: string | null;
  startDate: string | null;
  endDate: string | null;
  status: string | null;
  approvalsStatus: string | null;
  payScheduleId: string | null;
  lastExportedToPayroll: string | null;
}
export interface GustoSnapshot {
  members: GustoSnapshotMember[];
  payPeriods: GustoSnapshotPayPeriod[];
  fetchedAt: string; // ISO of the browser pull
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);

/** Parse a raw MembersTable GraphQL response into normalized members. Defensive to field changes. */
export function parseGustoMembers(raw: unknown): GustoSnapshotMember[] {
  const nodes = (raw as { data?: { company?: { members?: { nodes?: unknown[] } } } })?.data?.company?.members?.nodes;
  if (!Array.isArray(nodes)) return [];
  const out: GustoSnapshotMember[] = [];
  for (const n of nodes) {
    const m = n as Record<string, unknown>;
    const id = str(m.id);
    if (!id) continue;
    const pt = String(m.personType ?? "").toLowerCase();
    // Country may live at a few places depending on employment; try the common ones, else null (honest).
    const emp = (m.latestEmployment ?? {}) as Record<string, unknown>;
    const country = str(m.country) ?? str(m.workCountry) ?? str((emp.workAddress as Record<string, unknown> | undefined)?.country) ?? str(emp.country);
    out.push({
      id,
      firstName: str(m.legalFirstName) ?? "",
      lastName: str(m.lastName) ?? "",
      preferredName: str(m.preferredFullName),
      businessName: str(m.businessName),
      personType: pt || "unknown",
      department: str(m.department),
      jobTitle: str(m.jobTitle),
      country,
      employmentEntityUuid: str(m.currentEmploymentTypeEntityUuid),
      payRate: null,
      payCurrency: null,
      payUnit: null,
    });
  }
  return out;
}

/** Parse one CompanyMemberDashboardPeopleShowPay response → the worker's current compensation. Employee
 *  rate lives at company.memberCompensationEmployeeCard.jobs[0].currentCompensation.details. Defensive;
 *  returns nulls when absent (e.g. a contractor, whose rate is on a different card). */
export function parseGustoPayRate(raw: unknown): { amount: number | null; currency: string | null; unit: string | null } {
  type Card = { jobs?: Array<{ currentCompensation?: { details?: Record<string, unknown> } }> } | undefined;
  const company = (raw as { data?: { member?: { company?: { memberCompensationEmployeeCard?: Card; memberCompensationCard?: Card } } } })?.data?.member?.company;
  // Employees live on memberCompensationEmployeeCard; contractors (incl. international) on
  // memberCompensationCard — same currentCompensation.details shape.
  const details =
    company?.memberCompensationEmployeeCard?.jobs?.[0]?.currentCompensation?.details ??
    company?.memberCompensationCard?.jobs?.[0]?.currentCompensation?.details;
  if (!details) return { amount: null, currency: null, unit: null };
  const pa = (details.paymentAmount ?? {}) as Record<string, unknown>;
  const amt = Number(pa.amount);
  return {
    amount: Number.isFinite(amt) ? amt : null,
    currency: str(pa.currencyCode),
    unit: str(details.paymentUnit),
  };
}

/** Attach per-member pay rates (parsed from a { memberId: rawPayResponse } map) onto the members. */
export function attachPayRates(members: GustoSnapshotMember[], payByMember: Record<string, unknown> | undefined): GustoSnapshotMember[] {
  if (!payByMember) return members;
  for (const m of members) {
    const raw = payByMember[m.id];
    if (!raw) continue;
    const r = parseGustoPayRate(raw);
    if (r.amount != null) {
      m.payRate = r.amount;
      m.payCurrency = r.currency;
      m.payUnit = r.unit;
    }
  }
  return members;
}

/** Parse a raw TimeTrackingDashboard GraphQL response into normalized pay periods. */
export function parseGustoPayPeriods(raw: unknown): GustoSnapshotPayPeriod[] {
  const periods = (raw as { data?: { company?: { timeTrackingPayPeriods?: unknown[] } } })?.data?.company?.timeTrackingPayPeriods;
  if (!Array.isArray(periods)) return [];
  const out: GustoSnapshotPayPeriod[] = [];
  for (const p of periods) {
    const r = p as Record<string, unknown>;
    const id = str(r.id);
    if (!id) continue;
    out.push({
      id,
      displayName: str(r.displayName),
      startDate: str(r.startDate),
      endDate: str(r.endDate),
      status: str(r.status),
      approvalsStatus: str(r.approvalsStatus),
      payScheduleId: str(r.payScheduleId),
      lastExportedToPayroll: str(r.lastExportedToPayroll),
    });
  }
  return out;
}

export function saveGustoSnapshot(snap: GustoSnapshot): void {
  try {
    getDb()
      .prepare(
        `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(KEY, JSON.stringify(snap), new Date().toISOString());
  } catch {
    /* best-effort */
  }
}

export function readGustoSnapshot(): GustoSnapshot | null {
  try {
    const row = getDb().prepare("SELECT value FROM settings WHERE key = ?").get(KEY) as { value: string } | undefined;
    if (!row) return null;
    const parsed = JSON.parse(row.value) as GustoSnapshot;
    if (!parsed || !Array.isArray(parsed.members) || typeof parsed.fetchedAt !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Freshness: true when a pull landed within GUSTO_STALE_MIN. */
export function gustoSnapshotFresh(now: number = Date.now()): boolean {
  const s = readGustoSnapshot();
  if (!s) return false;
  const age = now - Date.parse(s.fetchedAt);
  return Number.isFinite(age) && age <= GUSTO_STALE_MIN * 60_000;
}
