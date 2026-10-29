// Gusto payroll SUBMIT + wire-confirm state — the kill switch + the idempotent result ledgers for the
// IRREVERSIBLE "Run payroll + Confirm wire" automation. The writes themselves are done by the browser
// extension (extension/gusto-submit.js) replaying Gusto's SubmitDraftPayroll / ConfirmWireIn in a logged-in
// Gusto tab; this module only persists the OUTCOME the extension reports back (via
// /api/payroll/gusto/submit-result and /confirm-wire-result) and reads it for the UI's gating.
//
// IDEMPOTENCY is enforced here: both ledgers are keyed by the pay period (`${start}..${end}`), and a
// recorded authoritative SUCCESS is never overwritten by a later duplicate — so a period can never be
// double-submitted and a wire never double-confirmed, even if the extension fires twice. Persisted in the
// settings KV (same store as gustoPushState). NEVER claims a submit/confirm the extension didn't report.

import { getJson, setJson } from "@/lib/kv";

const SUBMIT_KEY = "gusto.submit.ledger";
const CONFIRM_KEY = "gusto.confirmWire.ledger";

/** The kill switch for the WHOLE submit + confirm feature. SubmitDraftPayroll runs REAL, irreversible
 *  payroll, so an env flag can hard-disable it without a code deploy. Any truthy-ish value except
 *  "0"/"false"/"off"/"no" disables. Mirrors gustoPushDisabled. Fail-open until set (documented): payroll
 *  submit stays ENABLED until an operator explicitly sets GUSTO_SUBMIT_DISABLED — the real guardrails are
 *  human-trigger + hard confirm + idempotency + the Admin gate, not this switch. */
export function gustoSubmitDisabled(): boolean {
  const v = (process.env.GUSTO_SUBMIT_DISABLED ?? "").trim().toLowerCase();
  return v !== "" && v !== "0" && v !== "false" && v !== "off" && v !== "no";
}

/** Stable per-period ledger key. Pure. */
export function periodKey(start: string | null | undefined, end: string | null | undefined): string {
  return `${start ?? "?"}..${end ?? "?"}`;
}

export interface SubmitError {
  argument: string | null;
  message: string;
}

export interface GustoSubmitResult {
  key: string; // periodKey
  at: string; // ISO — when the extension reported
  ok: boolean; // completed and payroll was submitted (or already submitted), no errors
  aborted: string | null; // non-null = aborted before submitting (not_logged_in / not_a_draft / amount/period mismatch / …)
  submitted: boolean; // TRUE once Gusto accepted the submit (or reported already submitted) — the idempotency flag
  alreadySubmitted: boolean; // the extension found it already submitted and did NOT resubmit
  draftPayrollId: string | null;
  payrollId: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  checkDate: string | null;
  uniqueIdentifier: string | null;
  expectedTotal: number | null; // the app-side estimate shown at confirm time (audit)
  headcount: number | null;
  wirePathTaken: boolean | null; // true when the "Safe expedite" step was present and wire was chosen
  errors: SubmitError[];
  initiatedBy: string | null;
}

export interface GustoConfirmWireResult {
  key: string; // periodKey
  at: string;
  ok: boolean;
  aborted: string | null;
  confirmed: boolean; // TRUE once Gusto confirmed the wire (or reported already confirmed) — the idempotency flag
  alreadyConfirmed: boolean;
  periodStart: string | null;
  periodEnd: string | null;
  checkDate: string | null;
  wireId: string | null;
  amount: number | null; // the amount confirmed
  gustoAmount: number | null; // Gusto's own wire amount from WireInInstructions (for the mismatch check)
  wireDate: string | null;
  errors: SubmitError[];
  initiatedBy: string | null;
}

type SubmitStore = Record<string, GustoSubmitResult>;
type ConfirmStore = Record<string, GustoConfirmWireResult>;

// ── Idempotency decisions (PURE — the record authority) ─────────────────────────────────────────────────
/** Keep an authoritative success; never let a later duplicate overwrite a recorded submitted=true/ok=true.
 *  A prior failure/abort CAN be replaced (the operator retried). Pure + tested — the decision depends only
 *  on what is ALREADY recorded. */
export function shouldRecordSubmit(existing: GustoSubmitResult | null): boolean {
  if (!existing) return true;
  if (existing.ok && existing.submitted) return false;
  return true;
}
export function shouldRecordConfirm(existing: GustoConfirmWireResult | null): boolean {
  if (!existing) return true;
  if (existing.ok && existing.confirmed) return false;
  return true;
}

/** True when the ledger already holds an authoritative successful submit for the period. Pure. */
export function isAlreadySubmitted(r: GustoSubmitResult | null): boolean {
  return !!r && r.ok && r.submitted;
}
export function isWireAlreadyConfirmed(r: GustoConfirmWireResult | null): boolean {
  return !!r && r.ok && r.confirmed;
}

// ── Submit ledger IO ────────────────────────────────────────────────────────────────────────────────────
export function readGustoSubmitResult(key: string): GustoSubmitResult | null {
  const store = getJson<SubmitStore>(SUBMIT_KEY, {});
  return store[key] ?? null;
}
export function listGustoSubmitResults(limit = 50): GustoSubmitResult[] {
  const store = getJson<SubmitStore>(SUBMIT_KEY, {});
  return Object.values(store).sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, Math.max(0, limit));
}
/** Record a submit outcome, honoring the idempotency authority. Returns whether it was recorded and the
 *  authoritative result now in effect (so the endpoint can flag a duplicate). */
export function recordGustoSubmitResult(r: GustoSubmitResult): { recorded: boolean; result: GustoSubmitResult } {
  const store = getJson<SubmitStore>(SUBMIT_KEY, {});
  const existing = store[r.key] ?? null;
  if (!shouldRecordSubmit(existing)) return { recorded: false, result: existing as GustoSubmitResult };
  store[r.key] = r;
  setJson(SUBMIT_KEY, store);
  return { recorded: true, result: r };
}

// ── Confirm-wire ledger IO ──────────────────────────────────────────────────────────────────────────────
export function readGustoConfirmWireResult(key: string): GustoConfirmWireResult | null {
  const store = getJson<ConfirmStore>(CONFIRM_KEY, {});
  return store[key] ?? null;
}
export function recordGustoConfirmWireResult(r: GustoConfirmWireResult): { recorded: boolean; result: GustoConfirmWireResult } {
  const store = getJson<ConfirmStore>(CONFIRM_KEY, {});
  const existing = store[r.key] ?? null;
  if (!shouldRecordConfirm(existing)) return { recorded: false, result: existing as GustoConfirmWireResult };
  store[r.key] = r;
  setJson(CONFIRM_KEY, store);
  return { recorded: true, result: r };
}
