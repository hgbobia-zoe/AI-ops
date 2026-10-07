// Gusto — the payroll SYSTEM OF RECORD (destination). The rest of HR/Payroll never calls Gusto directly;
// it goes through this provider abstraction, so the sync engine, reconciliation and UI stay independent of
// how Gusto is reached.
//
// Gusto's official API access is pending approval, so (like Goodshuffle + Instawork) we use BROWSER
// TAB-REPLAY: a logged-in app.gusto.com tab replays Gusto's GraphQL operations and POSTs them to
// /api/payroll/gusto/import, which snapshots them (src/lib/payroll/gustoSnapshot.ts). This provider READS
// from that snapshot — the server never calls Gusto itself. WRITES (pushing approved time) go through the
// human-approved gs_outbox drain replayed in-tab (never an auto-submit from here).

import { readGustoSnapshot, gustoSnapshotFresh } from "./gustoSnapshot";

export type GustoEntity = "employee" | "contractor";

export interface GustoWorker {
  id: string;
  firstName: string;
  lastName: string;
  email: string | null;
  entityType: GustoEntity;
  country: string | null;
}

export interface GustoTimeEntry {
  id: string;
  workerId: string;
  periodStart: string; // YYYY-MM-DD
  periodEnd: string;
  hours: number;
  hoursType: string;
}

export interface GustoPayPeriodRef {
  start: string;
  end: string;
  payrollId: string | null;
}

export interface ConnectionResult {
  configured: boolean;
  ok: boolean;
  detail: string;
}

/** The port the control plane depends on. A real implementation wraps the Gusto API; the default
 *  (unconfigured) implementation reports "not configured" and refuses writes. */
export interface GustoPayrollProvider {
  readonly id: string;
  configured(): boolean;
  validateConnection(): Promise<ConnectionResult>;
  getWorkers(): Promise<GustoWorker[]>;
  getTimeEntries(periodStart: string, periodEnd: string): Promise<GustoTimeEntry[]>;
  createTimeEntries(entries: Omit<GustoTimeEntry, "id">[]): Promise<{ created: GustoTimeEntry[] }>;
  updateTimeEntries(entries: GustoTimeEntry[]): Promise<{ updated: GustoTimeEntry[] }>;
  getPayPeriods(): Promise<GustoPayPeriodRef[]>;
}

/** "Connected" = a browser pull has landed a snapshot. (Freshness is a separate health signal.) */
export function gustoConfigured(): boolean {
  return readGustoSnapshot() != null;
}

const COUNTRY_US = new Set(["usa", "us", "united states", "united states of america"]);
function entityOf(personType: string): GustoEntity {
  return personType === "contractor" ? "contractor" : "employee";
}

// Snapshot-backed provider: reads come from the browser-pulled Gusto snapshot; writes are refused here
// (they go through the approved gs_outbox replay, never a direct submit from the server).
class SnapshotGustoProvider implements GustoPayrollProvider {
  readonly id = "gusto";
  configured(): boolean {
    return gustoConfigured();
  }
  async validateConnection(): Promise<ConnectionResult> {
    const snap = readGustoSnapshot();
    if (!snap) return { configured: false, ok: false, detail: "not connected" };
    return { configured: true, ok: gustoSnapshotFresh(), detail: gustoSnapshotFresh() ? `connected · pulled ${snap.fetchedAt}` : "stale — refresh the Gusto pull" };
  }
  async getWorkers(): Promise<GustoWorker[]> {
    const snap = readGustoSnapshot();
    if (!snap) return [];
    return snap.members.map((m) => ({
      id: m.id,
      firstName: m.firstName,
      lastName: m.lastName,
      email: null, // not exposed by the MembersTable operation
      entityType: entityOf(m.personType),
      country: m.country,
    }));
  }
  async getTimeEntries(): Promise<GustoTimeEntry[]> {
    return []; // time entries are not pulled yet (reconciliation reads pay periods; entries come with the write capture)
  }
  async createTimeEntries(): Promise<{ created: GustoTimeEntry[] }> {
    throw new Error("Direct Gusto writes are disabled — push goes through the approved gs_outbox replay.");
  }
  async updateTimeEntries(): Promise<{ updated: GustoTimeEntry[] }> {
    throw new Error("Direct Gusto writes are disabled — push goes through the approved gs_outbox replay.");
  }
  async getPayPeriods(): Promise<GustoPayPeriodRef[]> {
    const snap = readGustoSnapshot();
    if (!snap) return [];
    return snap.payPeriods.map((p) => ({ start: p.startDate ?? "", end: p.endDate ?? "", payrollId: p.payScheduleId }));
  }
}

/** Is this Gusto member a US or international worker, for classification. */
export function gustoIsInternational(country: string | null): boolean {
  if (!country) return false;
  return !COUNTRY_US.has(country.trim().toLowerCase());
}

let _provider: GustoPayrollProvider | null = null;

/** The active Gusto provider (snapshot-backed browser-replay). */
export function getGustoProvider(): GustoPayrollProvider {
  if (!_provider) _provider = new SnapshotGustoProvider();
  return _provider;
}
