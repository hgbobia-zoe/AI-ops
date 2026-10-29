// Gusto payroll SUBMIT + wire-confirm — the pure, deterministic core of the owner's end-to-end
// "Run payroll + Confirm wire" automation. The actual network write is done by the Auto-Pull extension
// (extension/gusto-submit.js), which replays Gusto's internal SubmitDraftPayroll / ConfirmWireIn GraphQL
// from a logged-in app.gusto.com tab (Gusto has no public API; Cloudflare blocks server-side calls — the
// same browser-replay pattern as the read sync + the DRAFT hours push).
//
// ╔══════════════════════════════════════════════════════════════════════════════════════════════════════╗
// ║ HIGH STAKES — NOT the DRAFT-only hours push. SubmitDraftPayroll ACTUALLY RUNS REAL PAYROLL: it commits ║
// ║ the draft run and creates a WIRE OBLIGATION, and it is IRREVERSIBLE. So the whole feature is           ║
// ║ HUMAN-TRIGGERED (no scheduler/outbox auto-run), HARD-CONFIRMED with the real numbers, IDEMPOTENT       ║
// ║ (a period is never submitted twice; a wire never confirmed twice — enforced by the ledger in           ║
// ║ gustoSubmitState.ts), and WIRE-ONLY.                                                                   ║
// ╚══════════════════════════════════════════════════════════════════════════════════════════════════════╝
//
// This module has NO IO. It builds the EXACT mutation inputs (so the endpoint + the extension agree on the
// shape), discovers/validates the draft's uniqueIdentifier, and makes the gating + verification decisions —
// all pure + unit-tested. The extension mirrors these shapes in JS; this TS is the tested source of truth.
//
// WIRE-ONLY INVARIANT (encoded + tested): buildSubmitDraftPayrollInput ALWAYS sets requestedPayoutRail =
// null and subscribeAndRunWithNextDayAch = false. We NEVER set an ACH/expedite rail. That is the standard
// "pay by wire transfer" path; an ACH/next-day rail would change how money moves and is forbidden.

import { addDays } from "./period";
import type { PayPeriod, PayrollReadinessModel } from "./types";

// ── RUN PAYROLL: SubmitDraftPayroll(input) ──────────────────────────────────────────────────────────────
export interface SubmitDraftPayrollInput {
  requestedPayoutRail: null; // WIRE ONLY — never an ACH/expedite rail. Invariant, tested.
  subscribeAndRunWithNextDayAch: false; // WIRE ONLY — never next-day ACH. Invariant, tested.
  uniqueIdentifier: string; // Gusto's draft-payroll key: regular.<paySchedule>.<payGroup>.<checkDate>
}

/** Build the EXACT SubmitDraftPayroll input for the standard WIRE path. requestedPayoutRail is ALWAYS null
 *  and subscribeAndRunWithNextDayAch ALWAYS false — the never-ACH invariant. Pure. */
export function buildSubmitDraftPayrollInput(uniqueIdentifier: string): SubmitDraftPayrollInput {
  return { requestedPayoutRail: null, subscribeAndRunWithNextDayAch: false, uniqueIdentifier };
}

/** Compose the draft-payroll uniqueIdentifier from its parts (as it appears in the "Run payroll" link).
 *  The extension PREFERS discovering the real id from that link (parseRunPayrollUniqueIdentifier); this is
 *  the tested shape + a fallback composer. Pure. */
export function buildSubmitUniqueIdentifier(payScheduleUuid: string, payGroupUuid: string, checkDate: string): string {
  return `regular.${payScheduleUuid}.${payGroupUuid}.${checkDate}`;
}

// The draft-payroll key as it appears inside the Gusto home/pay-page "Run payroll" link href. Shape:
// regular.<paySchedule-uuid>.<payGroup-uuid>.<YYYY-MM-DD>. uuids are hex-with-dashes; we only need to find
// and slice the token, not fully validate the uuids.
const UNIQUE_ID_RE = /regular\.[0-9a-f][0-9a-f-]{7,}\.[0-9a-f][0-9a-f-]{7,}\.\d{4}-\d{2}-\d{2}/i;

/** Extract the draft-payroll uniqueIdentifier from a "Run payroll" link href (or any string that contains
 *  it). Returns null when not present. The extension uses this to DISCOVER the id for the target period.
 *  Pure. */
export function parseRunPayrollUniqueIdentifier(href: string | null | undefined): string | null {
  if (!href) return null;
  const m = String(href).match(UNIQUE_ID_RE);
  return m ? m[0] : null;
}

/** The check date (YYYY-MM-DD) embedded at the tail of a uniqueIdentifier, or null. Pure. */
export function uniqueIdentifierCheckDate(uniqueIdentifier: string | null | undefined): string | null {
  if (!uniqueIdentifier) return null;
  const m = String(uniqueIdentifier).match(/(\d{4}-\d{2}-\d{2})$/);
  return m ? m[1] : null;
}

/** Does a discovered uniqueIdentifier match the target check date we asked for? When no target is given
 *  (null), accept (the single-draft case). The extension uses this to pick the RIGHT draft and never submit
 *  a wrong week. Pure. */
export function matchesTargetCheckDate(uniqueIdentifier: string, checkDate: string | null): boolean {
  if (!checkDate) return true;
  return uniqueIdentifierCheckDate(uniqueIdentifier) === checkDate;
}

// ── Parse the SubmitDraftPayroll response ───────────────────────────────────────────────────────────────
export type SubmitOutcome = "submitted" | "already_submitted" | "failed";
export interface ParsedSubmitResult {
  outcome: SubmitOutcome;
  draftPayrollId: string | null;
  payrollId: string | null;
  errors: { argument: string | null; message: string }[];
}

const ALREADY_RE = /already\s+(submitted|processed|run|paid)|not\s+(a\s+)?draft|no\s+draft|already\s+in\s+progress/i;

/** Classify a SubmitDraftPayroll GraphQL response. Success = SubmitDraftPayrollSuccess { draftPayroll{ id,
 *  payroll{ id } } }; Failure = SubmitDraftPayrollFailure { errors[{ argument, message }] }. A failure whose
 *  message reads like "already submitted / not a draft" is classified `already_submitted` (idempotent — the
 *  extension reports it WITHOUT resubmitting). Defensive: a shape change yields a `failed` with the raw
 *  errors rather than a false success. Pure. */
export function parseSubmitDraftPayrollResponse(json: unknown): ParsedSubmitResult {
  const empty: ParsedSubmitResult = { outcome: "failed", draftPayrollId: null, payrollId: null, errors: [] };
  if (!json || typeof json !== "object") return empty;
  const j = json as {
    errors?: { message?: unknown }[];
    data?: { submitDraftPayroll?: { result?: Record<string, unknown> } };
  };
  // Top-level GraphQL errors (auth/network-shaped) → failed with the messages.
  const topErrors = Array.isArray(j.errors) ? j.errors.map((e) => ({ argument: null, message: String(e?.message ?? "error") })) : [];
  const result = j.data?.submitDraftPayroll?.result;
  if (!result) {
    if (topErrors.length) {
      return { outcome: topErrors.some((e) => ALREADY_RE.test(e.message)) ? "already_submitted" : "failed", draftPayrollId: null, payrollId: null, errors: topErrors };
    }
    return empty;
  }
  const typename = String(result.__typename ?? "");
  const draft = result.draftPayroll as { id?: unknown; payroll?: { id?: unknown } } | undefined;
  const failureErrors = Array.isArray(result.errors)
    ? (result.errors as { argument?: unknown; message?: unknown }[]).map((e) => ({
        argument: typeof e.argument === "string" ? e.argument : null,
        message: String(e?.message ?? "error"),
      }))
    : [];

  // Success when we got a draft/payroll id back, or the typename says Success.
  if (/Success/i.test(typename) || (draft && (draft.id != null || draft.payroll?.id != null))) {
    return {
      outcome: "submitted",
      draftPayrollId: draft?.id != null ? String(draft.id) : null,
      payrollId: draft?.payroll?.id != null ? String(draft.payroll.id) : null,
      errors: [],
    };
  }
  const errors = failureErrors.length ? failureErrors : topErrors;
  const already = errors.some((e) => ALREADY_RE.test(e.message));
  return { outcome: already ? "already_submitted" : "failed", draftPayrollId: null, payrollId: null, errors };
}

// ── CONFIRM WIRE: WireInInstructions (read) → ConfirmWireIn(input) ───────────────────────────────────────
export const WIRE_BANK_NAME = "Mercury / Choice Financial Group";

export interface ConfirmWireInInput {
  amount: number; // the wire $ (dollars)
  bankName: string; // always WIRE_BANK_NAME (Mercury / Choice Financial Group)
  note: string; // always "" (as captured)
  wireDate: string; // YYYY-MM-DD the wire was sent
  wireId: string; // the wire's uuid, read from WireInInstructions
  wireType: "WIRE_IN_REQUEST"; // always, as captured
}

/** Build the EXACT ConfirmWireIn input from the captured spec. Pure. */
export function buildConfirmWireInInput(p: { amount: number; wireDate: string; wireId: string }): ConfirmWireInInput {
  return { amount: p.amount, bankName: WIRE_BANK_NAME, note: "", wireDate: p.wireDate, wireId: p.wireId, wireType: "WIRE_IN_REQUEST" };
}

export interface WireAmountCheck {
  ok: boolean;
  amount: number | null; // the amount to confirm (null when unusable)
  mismatch: boolean;
  reason?: string;
}

/** Reconcile the app-provided expected amount with Gusto's own wire amount (from WireInInstructions).
 *  PREFERS the app-provided amount, but when BOTH are known and they disagree beyond epsilon it REFUSES
 *  (ok:false, mismatch:true) rather than confirm a wrong amount — a hard financial safety. When only one is
 *  known, that one is used. Pure. */
export function verifyWireAmount(appAmount: number | null | undefined, gustoAmount: number | null | undefined, epsilon = 0.01): WireAmountCheck {
  const a = typeof appAmount === "number" && Number.isFinite(appAmount) && appAmount > 0 ? appAmount : null;
  const g = typeof gustoAmount === "number" && Number.isFinite(gustoAmount) && gustoAmount > 0 ? gustoAmount : null;
  if (a == null && g == null) return { ok: false, amount: null, mismatch: false, reason: "no wire amount from the app or Gusto" };
  if (a != null && g != null) {
    if (Math.abs(a - g) > epsilon) {
      return { ok: false, amount: a, mismatch: true, reason: "the app amount does not match the Gusto wire amount" };
    }
    return { ok: true, amount: a, mismatch: false };
  }
  return { ok: true, amount: (a ?? g) as number, mismatch: false };
}

export type ConfirmWireOutcome = "confirmed" | "already_confirmed" | "failed";
export interface ParsedConfirmWireResult {
  outcome: ConfirmWireOutcome;
  errors: { argument: string | null; message: string }[];
}

/** Classify a ConfirmWireIn GraphQL response: { data: { confirmWireIn: { success, errors[{argument,message}] } } }.
 *  success:true → confirmed. A failure whose message reads "already confirmed" → already_confirmed
 *  (idempotent). Pure. */
export function parseConfirmWireResponse(json: unknown): ParsedConfirmWireResult {
  if (!json || typeof json !== "object") return { outcome: "failed", errors: [] };
  const j = json as {
    errors?: { message?: unknown }[];
    data?: { confirmWireIn?: { success?: unknown; errors?: { argument?: unknown; message?: unknown }[] } };
  };
  const cw = j.data?.confirmWireIn;
  const errs = [
    ...(Array.isArray(cw?.errors) ? cw!.errors! : []).map((e) => ({ argument: typeof e.argument === "string" ? e.argument : null, message: String(e?.message ?? "error") })),
    ...(Array.isArray(j.errors) ? j.errors.map((e) => ({ argument: null, message: String(e?.message ?? "error") })) : []),
  ];
  if (cw && cw.success === true) return { outcome: "confirmed", errors: [] };
  const already = errs.some((e) => /already\s+(confirmed|recorded|submitted)/i.test(e.message));
  return { outcome: already ? "already_confirmed" : "failed", errors: errs };
}

// ── Best-effort check-date HINT ─────────────────────────────────────────────────────────────────────────
/** The first `payrollDay` (0=Sun..6=Sat) STRICTLY after the period end — a best-effort HINT the app passes
 *  so the extension can match the right draft. The extension discovers the AUTHORITATIVE uniqueIdentifier
 *  (which embeds the real check date) from Gusto's "Run payroll" link and matches by period; this hint only
 *  seeds that match + the confirm UI. Pure (UTC). */
export function expectedCheckDate(periodEnd: string, payrollDay: number): string {
  const want = ((Math.round(payrollDay) % 7) + 7) % 7;
  let d = addDays(periodEnd, 1);
  for (let i = 0; i < 7; i++) {
    const dow = new Date(`${d}T00:00:00.000Z`).getUTCDay();
    if (dow === want) return d;
    d = addDays(d, 1);
  }
  return addDays(periodEnd, 1);
}

// ── Submit context (what the confirm modal shows) + gating ──────────────────────────────────────────────
export interface SubmitContext {
  period: PayPeriod;
  checkDate: string;
  expectedTotal: number | null; // the app-side ESTIMATE of the debit/wire amount — NOT Gusto's authoritative figure
  headcount: number; // workers in the run (the readiness model's included count)
  approved: boolean; // a Zoe approval is recorded for the period
  alreadySubmitted: boolean; // the ledger shows an authoritative successful submit
  disabled: boolean; // GUSTO_SUBMIT_DISABLED
}

/** Build the confirm context purely from the readiness model + config + ledger state. estGross is an
 *  app-side estimate (honest), not the Gusto debit — the confirm UI labels it so. Pure + tested. */
export function buildSubmitContext(args: {
  model: Pick<PayrollReadinessModel, "period" | "counts" | "totals" | "approval">;
  payrollDay: number;
  alreadySubmitted: boolean;
  disabled: boolean;
}): SubmitContext {
  const { model } = args;
  return {
    period: model.period,
    checkDate: expectedCheckDate(model.period.end, args.payrollDay),
    expectedTotal: model.totals.estGross ?? null,
    headcount: model.counts.included,
    approved: model.approval?.status === "APPROVED",
    alreadySubmitted: args.alreadySubmitted,
    disabled: args.disabled,
  };
}

export interface RunGate {
  canRun: boolean;
  reason: string;
}

/** Whether the "Run payroll" trigger may arm. Blocked when disabled, already submitted, or not yet approved
 *  in Zoe. Pure + tested — the UI and the submit-payload endpoint use the SAME decision so the gate can't be
 *  bypassed by the client. */
export function runPayrollGate(a: { approved: boolean; alreadySubmitted: boolean; disabled: boolean }): RunGate {
  if (a.disabled) return { canRun: false, reason: "Payroll submit is disabled (GUSTO_SUBMIT_DISABLED)." };
  if (a.alreadySubmitted) return { canRun: false, reason: "Payroll already submitted for this period." };
  if (!a.approved) return { canRun: false, reason: "Record the Zoe approval before running payroll." };
  return { canRun: true, reason: "" };
}

export interface ConfirmGate {
  canConfirm: boolean;
  reason: string;
}

/** Whether the "Confirm wire in Gusto" trigger may arm: only AFTER an authoritative submit, and only once
 *  (never double-confirm). Pure + tested. */
export function confirmWireGate(
  lastSubmit: { ok: boolean; submitted: boolean } | null,
  lastConfirm: { ok: boolean; confirmed: boolean } | null,
): ConfirmGate {
  if (!lastSubmit || !lastSubmit.ok || !lastSubmit.submitted) return { canConfirm: false, reason: "Payroll has not been submitted for this period yet." };
  if (lastConfirm && lastConfirm.ok && lastConfirm.confirmed) return { canConfirm: false, reason: "The wire is already confirmed in Gusto for this period." };
  return { canConfirm: true, reason: "" };
}
