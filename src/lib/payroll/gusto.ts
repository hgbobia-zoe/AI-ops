// Gusto — the payroll SYSTEM OF RECORD (destination). The rest of HR/Payroll never calls Gusto directly;
// it goes through this provider abstraction, so the sync engine, reconciliation and UI stay independent of
// the raw API. Modeled on src/lib/connecteam.ts: key-gated, never throws from the read paths, returns
// empty/"not configured" when unset.
//
// There is NO live Gusto integration yet. The official Gusto Embedded/Partner API is the intended path
// (NOT browser automation — Gusto does not block server IPs). Credentials will be configured in HR → Settings
// (stored write-only like other provider secrets) or via the GUSTO_API_TOKEN env/Fly secret. Until a token
// is present, `gustoConfigured()` is false and the engine records gusto_ok = null (never pushes).

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

export function gustoConfigured(): boolean {
  return Boolean(process.env.GUSTO_API_TOKEN);
}

// The default provider: safe no-op reads, writes refused. Swapped for a real API-backed provider once the
// Gusto integration lands (same interface, so nothing else changes).
class UnconfiguredGustoProvider implements GustoPayrollProvider {
  readonly id = "gusto";
  configured(): boolean {
    return gustoConfigured();
  }
  async validateConnection(): Promise<ConnectionResult> {
    return { configured: false, ok: false, detail: "not connected" };
  }
  async getWorkers(): Promise<GustoWorker[]> {
    return [];
  }
  async getTimeEntries(): Promise<GustoTimeEntry[]> {
    return [];
  }
  async createTimeEntries(): Promise<{ created: GustoTimeEntry[] }> {
    throw new Error("Gusto is not configured — cannot create time entries.");
  }
  async updateTimeEntries(): Promise<{ updated: GustoTimeEntry[] }> {
    throw new Error("Gusto is not configured — cannot update time entries.");
  }
  async getPayPeriods(): Promise<GustoPayPeriodRef[]> {
    return [];
  }
}

let _provider: GustoPayrollProvider | null = null;

/** The active Gusto provider. Today this is always the unconfigured stub; when the real API-backed
 *  provider is implemented it is selected here (behind `gustoConfigured()`), leaving every caller unchanged. */
export function getGustoProvider(): GustoPayrollProvider {
  if (!_provider) _provider = new UnconfiguredGustoProvider();
  return _provider;
}
