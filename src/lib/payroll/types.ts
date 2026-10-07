// HR / Payroll — domain types for the Zoe Payroll Control Plane. Pure types, no DB/IO, so both server
// services and (serializable) client views can import them. Money is in the worker's own currency;
// an unknown value stays null (FACTS ONLY — never a fabricated 0).

export type WorkerType = "EMPLOYEE" | "US_CONTRACTOR" | "INTERNATIONAL_CONTRACTOR" | "UNKNOWN";
export type EmploymentStatus = "ACTIVE" | "INACTIVE";
export type PayType = "hourly" | "salary" | "fixed";
export type GustoEntityType = "employee" | "contractor";

export const WORKER_TYPE_LABEL: Record<WorkerType, string> = {
  EMPLOYEE: "Employee",
  US_CONTRACTOR: "US Contractor",
  INTERNATIONAL_CONTRACTOR: "International Contractor",
  UNKNOWN: "Unclassified",
};

// A stored worker-identity override row (the mapping HR owns on top of Connecteam / Instawork / Gusto).
export interface WorkerRecord {
  id: string;
  name: string;
  email: string | null;
  workerType: WorkerType;
  employmentStatus: EmploymentStatus;
  connecteamUserId: number | null;
  instaworkWorker: string | null;
  gustoId: string | null;
  gustoEntityType: GustoEntityType | null;
  payType: PayType | null;
  payRate: number | null;
  currency: string | null;
  country: string | null;
  active: boolean;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

// The merged view HR sees — a stored record (if any) fused with the LIVE Connecteam roster + rate. This is
// what the Workers/Contractors tables render; `persisted` says whether a stored override row exists yet.
export interface UnifiedWorker {
  key: string; // stable key: `ct:<userId>` | `iw:<name>` | `hw:<id>`
  recordId: string | null; // hr_workers.id when persisted
  name: string;
  email: string | null;
  workerType: WorkerType;
  typeInferred: boolean; // true when the type is a default (no human classification yet)
  country: string | null;
  connecteamUserId: number | null;
  instaworkWorker: string | null;
  inConnecteam: boolean;
  gustoId: string | null;
  gustoMapped: boolean;
  payType: PayType | null;
  payRate: number | null; // worker's currency; from override, else live Connecteam rate
  currency: string;
  active: boolean;
  persisted: boolean;
  periodHours: number | null; // actual hours in the active period (null = source unavailable)
}

export type PayrollStatus = "READY_FOR_REVIEW" | "REQUIRES_REVIEW" | "NOT_READY" | "SYNCED" | "NO_DATA";

export const PAYROLL_STATUS_LABEL: Record<PayrollStatus, string> = {
  READY_FOR_REVIEW: "Ready for review",
  REQUIRES_REVIEW: "Requires review",
  NOT_READY: "Not ready",
  SYNCED: "Synced",
  NO_DATA: "No data",
};

export interface PayPeriod {
  start: string; // YYYY-MM-DD (inclusive)
  end: string; // YYYY-MM-DD (inclusive)
  label: string; // e.g. "Oct 1 – Oct 7"
}

// The Payroll Command Center snapshot — every number is real or null. "Is payroll ready?" in one object.
export interface PayrollOverview {
  period: PayPeriod;
  totalHours: number | null; // null = Connecteam unavailable (UNVERIFIED, never 0)
  connecteamOk: boolean;
  estimatedLabor: { amount: number | null; currency: string; partial: boolean }; // partial = some rates unknown
  workers: number;
  employees: number;
  contractors: number;
  internationalContractors: number;
  exceptions: number;
  unmatchedWorkers: number; // have hours but no Gusto mapping
  lastSync: { at: string; status: string; trigger: string } | null;
  nextAutomaticSync: string | null; // null until the scheduler is enabled
  status: PayrollStatus;
  gustoConfigured: boolean;
  // Instawork temps — a separate labor-cost line (paid via Instawork, NOT in the Gusto run).
  tempLabor: { amount: number | null; basis: "actual" | "estimated" | "none"; hours: number | null };
}

export type ExceptionSeverity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
export type ExceptionStatus = "OPEN" | "IN_REVIEW" | "RESOLVED" | "IGNORED";

export interface PayrollException {
  id: string;
  syncRunId: string | null;
  workerId: string | null;
  workerLabel: string | null;
  severity: ExceptionSeverity;
  type: string;
  description: string;
  source: string | null;
  status: ExceptionStatus;
  resolution: string | null;
  resolvedBy: string | null;
  resolvedAt: string | null;
  detectedAt: string;
}

export type SyncTrigger = "manual" | "scheduled";
export type SyncStatus = "RUNNING" | "READY" | "REQUIRES_REVIEW" | "FAILED" | "SYNCED";

export interface SyncRun {
  id: string;
  periodStart: string;
  periodEnd: string;
  trigger: SyncTrigger;
  initiatedBy: string | null;
  status: SyncStatus;
  workersProcessed: number | null;
  totalHours: number | null;
  hoursReady: number | null;
  exceptionsCount: number | null;
  reviewCount: number | null;
  gustoCreated: number | null;
  gustoUpdated: number | null;
  skipped: number | null;
  connecteamOk: boolean | null;
  gustoOk: boolean | null; // null = not configured (never pushed)
  detail: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export type TimeEntryStatus = "NORMALIZED" | "MATCHED" | "RECONCILED" | "SYNCED" | "SKIPPED" | "FAILED";
export type HoursType = "REGULAR" | "OVERTIME" | "DOUBLE_OVERTIME" | "PTO" | "OTHER";

// ── Instawork temp pay (paid via Instawork, NOT Gusto) ───────────────────────────────────────────────
// One temp worker's pay for a period: the ESTIMATE from booked gigs, plus the ACTUAL once imported.
export interface TempWorkerPay {
  name: string;
  gigs: number;
  hours: number | null; // scheduled window hours (null = window unknown)
  estCost: number | null; // USD estimate from the gig seat price
  actualHours: number | null; // imported from Instawork timesheets (null = not imported)
  actualCost: number | null;
}
export interface TempPayResult {
  ok: boolean; // Instawork snapshot available
  asOf: string | null; // snapshot fetch time (point-in-time)
  periodGigs: number; // booked gigs falling in the period
  workers: TempWorkerPay[];
  totalHours: number | null;
  totalEstCost: number | null;
  totalActualCost: number | null;
  hasActuals: boolean;
  partial: boolean; // some seat price/window unknown, or unnamed seats
  note: string;
}
