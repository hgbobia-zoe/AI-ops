// Gusto hours PUSH — the pure, deterministic core of the Zoe → Gusto payroll-hours push. This writes the
// reconciled per-worker hours into the CURRENT Gusto DRAFT payroll run; the actual network write is done by
// the Auto-Pull extension (extension/gusto-push.js) replaying Gusto's internal `AutoSaveWorkedHours`
// GraphQL mutation from a logged-in app.gusto.com tab (Gusto's official API is pending; Cloudflare blocks
// server-side calls — same browser-replay pattern as the read sync). This module has NO IO: it builds the
// push ENTRIES from the deterministic payroll review, and builds the exact mutation-variable shape so both
// the endpoint and the extension (which mirrors this logic in JS) agree. RULES CALCULATE / NEVER FABRICATE:
// a worker with no mapping, a blocking issue, or no hours is never pushed.
//
// SAFETY: this is DRAFT-ONLY. Nothing here (or in the extension) submits/runs/approves payroll — it only
// sets hours on the draft. The extension aborts if the open run is not a DRAFT.

import type { ReviewWorker, UnifiedWorker } from "./types";

// ── One worker's hours to push ────────────────────────────────────────────────────────────────────────
export interface GustoPushEntry {
  gustoMemberId: string; // Gusto companyMemberUuid == hr_workers.gusto_id (how the extension matches the employee)
  name: string; // for the audit trail + result summary (never used to match)
  regularHours: number;
  overtimeHours: number;
  doubleOvertimeHours: number; // always 0 — we don't compute double-OT (honest: no rule for it yet)
}

export interface BuildPushResult {
  entries: GustoPushEntry[]; // the workers we WILL push (mapped + not blocked, hours > 0)
  skipped: { key: string; name: string; reason: string }[]; // everyone excluded, with why (honest)
  mappedCount: number; // entries.length (mapped + pushable)
  totalRegular: number;
  totalOvertime: number;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Split a week's hours into regular + overtime at the overtime threshold (default 40). Mirrors the review
 *  engine's OVERTIME rule (review.ts flags > threshold as an exception). Double-overtime is always 0: we do
 *  not compute it (no deterministic rule), so we never fabricate it. Pure. */
export function splitOvertime(hours: number, overtimeThreshold: number): { regular: number; overtime: number } {
  const h = Math.max(0, hours);
  const t = Math.max(0, overtimeThreshold);
  if (h <= t) return { regular: round2(h), overtime: 0 };
  return { regular: round2(t), overtime: round2(h - t) };
}

/** Does a worker's reconciled row qualify to push into the DRAFT? MAPPED (gusto_id present) AND NOT BLOCKED
 *  (no blocking issue — no mapping/no rate) AND has real hours. REQUIRES_REVIEW (e.g. overtime, unconfirmed
 *  type) still pushes — the hours are valid and overtime is exactly what we split. Pure + conservative. */
export function isPushable(review: ReviewWorker, gustoId: string | null): { ok: boolean; reason?: string } {
  if (review.status === "BLOCKED") return { ok: false, reason: "blocked (resolve blocking issues first)" };
  if (!gustoId) return { ok: false, reason: "no Gusto mapping" };
  if (review.hours == null) return { ok: false, reason: "hours unavailable (time source down)" };
  if (review.hours <= 0) return { ok: false, reason: "no hours this period" };
  return { ok: true };
}

/** Build the push entries from the reconciled review + the unified roster (which carries gusto_id). Only
 *  mapped + non-blocked workers with hours are pushed; everyone else is listed in `skipped` with the reason.
 *  Pure — takes already-fetched data, so it's fully unit-testable. */
export function buildPushEntries(
  reviewWorkers: ReviewWorker[],
  unified: UnifiedWorker[],
  overtimeThreshold: number,
): BuildPushResult {
  const gustoByKey = new Map<string, string | null>();
  for (const u of unified) gustoByKey.set(u.key, u.gustoId);

  const entries: GustoPushEntry[] = [];
  const skipped: { key: string; name: string; reason: string }[] = [];
  let totalRegular = 0;
  let totalOvertime = 0;

  for (const w of reviewWorkers) {
    const gustoId = gustoByKey.get(w.key) ?? null;
    const check = isPushable(w, gustoId);
    if (!check.ok) {
      skipped.push({ key: w.key, name: w.name, reason: check.reason ?? "excluded" });
      continue;
    }
    const { regular, overtime } = splitOvertime(w.hours ?? 0, overtimeThreshold);
    entries.push({
      gustoMemberId: gustoId!,
      name: w.name,
      regularHours: regular,
      overtimeHours: overtime,
      doubleOvertimeHours: 0,
    });
    totalRegular = round2(totalRegular + regular);
    totalOvertime = round2(totalOvertime + overtime);
  }

  return { entries, skipped, mappedCount: entries.length, totalRegular, totalOvertime };
}

// ── The captured Gusto mutation (reverse-engineered live 2026-10-26) ────────────────────────────────────
// `AutoSaveWorkedHours` is Gusto's "save hours" mutation. The extension PREFERS capturing the app's own
// request as the template (query doc + required x-gusto-* headers + a valid session id), because the exact
// query string + headers are only reliably obtained from a live request. This literal is the fallback doc.
export const AUTO_SAVE_WORKED_HOURS_DOC =
  "mutation AutoSaveWorkedHours($employeeUuid: ID!, $input: UpdateDraftPayrollInput!) { updateDraftPayroll(input: $input) { draftPayroll { id } } }";

export interface AutoSaveSessionIds {
  // HYPOTHESIS (UNVERIFIED — the integrator must validate live): these two are NOT in the load queries, so
  // they appear to be CLIENT-GENERATED correlation ids. The extension generates them; if Gusto rejects a
  // generated session, the fallback is to reuse the session id from a captured live AutoSaveWorkedHours.
  payrollActivitySessionId: string; // a UUID
  uniqueIdentifier: string; // a ~92-char unique string
}

export interface AutoSaveJobHours {
  employeeJobUuid: string;
  regularHours: number;
  overtimeHours: number;
  doubleOvertimeHours: number;
}

/** Build the EXACT `AutoSaveWorkedHours` GraphQL variables for one employee, matching the captured spec:
 *  { employeeUuid, input: { payrollActivitySessionId, uniqueIdentifier, workedHours: [ { employeeUuid,
 *  workedHours: [ { employeeJobUuid, regularHours, overtimeHours, doubleOvertimeHours, missedBreakHours } ] } ] } }
 *  Pure — the extension mirrors this shape in JS; this TS version is the tested source of truth for the shape.
 *  `missedBreakHours` is the literal string "0.0" (as captured). Single-job assumption: one job per employee. */
export function buildAutoSaveWorkedHoursVariables(
  employeeUuid: string,
  job: AutoSaveJobHours,
  session: AutoSaveSessionIds,
): Record<string, unknown> {
  return {
    employeeUuid,
    input: {
      payrollActivitySessionId: session.payrollActivitySessionId,
      uniqueIdentifier: session.uniqueIdentifier,
      workedHours: [
        {
          employeeUuid,
          workedHours: [
            {
              employeeJobUuid: job.employeeJobUuid,
              regularHours: job.regularHours,
              overtimeHours: job.overtimeHours,
              doubleOvertimeHours: job.doubleOvertimeHours,
              missedBreakHours: "0.0",
            },
          ],
        },
      ],
    },
  };
}

// ── member → employee matching (mirrors the extension's map from the inputs query) ─────────────────────
// The inputs page fires `PayrollInputStepDraftEmployeePayrollsByIds`; each draftEmployeePayroll carries
// employee.companyMemberUuid (== our gusto_id), employee.uuid, and the primary job uuid. The extension builds
// a map companyMemberUuid → { employeeUuid, employeeJobUuid }; this pure version is the tested matcher.
export interface EmployeeIdMapEntry {
  employeeUuid: string;
  employeeJobUuid: string;
}

export interface MatchedPush {
  matched: { entry: GustoPushEntry; ids: EmployeeIdMapEntry }[];
  unmatched: GustoPushEntry[]; // a payload worker whose gusto_id isn't in the draft (report, never guess)
}

/** Match push entries to the draft's employees by companyMemberUuid == gustoMemberId. A worker not present
 *  in the draft is reported as unmatched (never pushed to a guessed employee). Pure. */
export function matchEntriesToEmployees(
  entries: GustoPushEntry[],
  memberMap: Map<string, EmployeeIdMapEntry>,
): MatchedPush {
  const matched: { entry: GustoPushEntry; ids: EmployeeIdMapEntry }[] = [];
  const unmatched: GustoPushEntry[] = [];
  for (const e of entries) {
    const ids = memberMap.get(e.gustoMemberId);
    if (ids) matched.push({ entry: e, ids });
    else unmatched.push(e);
  }
  return { matched, unmatched };
}

/** Idempotency: do the CURRENT draft hours already equal what we'd push? (skip the write if so). The
 *  extension reads each draftEmployeePayroll's allWorkedHours for the primary job and compares with a small
 *  epsilon. Pure. `current` is null when the draft has no hours row yet (→ not a match, we should write). */
export function hoursAlreadyMatch(
  target: { regularHours: number; overtimeHours: number; doubleOvertimeHours: number },
  current: { regularHours: number; overtimeHours: number; doubleOvertimeHours: number } | null,
  epsilon = 0.001,
): boolean {
  if (!current) return false;
  return (
    Math.abs(target.regularHours - current.regularHours) < epsilon &&
    Math.abs(target.overtimeHours - current.overtimeHours) < epsilon &&
    Math.abs(target.doubleOvertimeHours - current.doubleOvertimeHours) < epsilon
  );
}
