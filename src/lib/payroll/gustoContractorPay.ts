// Gusto CONTRACTOR pay — the pure, deterministic core of the owner's end-to-end contractor-payout automation,
// the contractor cousin of the W2 "Run payroll + Confirm wire" core (gustoSubmit.ts). Gusto has NO public API;
// the actual network writes are replayed by the Auto-Pull extension from a logged-in tab on
// graphql.app.gusto.com (Cloudflare blocks server-side calls — same browser-replay pattern as the rest). This
// module has NO IO: it builds the EXACT GraphQL inputs and parses the responses, so the endpoint, the tests,
// and the extension all agree on one shape.
//
// ╔══════════════════════════════════════════════════════════════════════════════════════════════════════╗
// ║ HIGH STAKES — SubmitPayGroup ACTUALLY PAYS contractors and is IRREVERSIBLE. The feature stays           ║
// ║ HUMAN-TRIGGERED (no scheduler/outbox auto-run), HARD-CONFIRMED with the real numbers, and IDEMPOTENT    ║
// ║ (a contractor pay group is never submitted twice). requestedPayoutRail is ALWAYS null (standard rail,   ║
// ║ never an expedite rail) — the contractor analog of the W2 never-expedite invariant.                     ║
// ╚══════════════════════════════════════════════════════════════════════════════════════════════════════╝
//
// FLOW (captured live 2026-10-30 from a real payment):
//   1. load pay items      — query UseContractorPayPayItemsByMemberIds(ids, payGroupId)
//   2. push hours          — mutation UpdateContractorPayItemWorkedHours (per pay item)   [input shape PROVISIONAL]
//   3. review              — mutation ReviewPayGroup(payGroupId) -> dataHash (+ excl. funding) + risk/funding
//   4. submit (PAY)        — mutation SubmitPayGroup(input{ payGroupId, expectedDataHash, ... })
// The dataHash from step 3 MUST be passed as expectedDataHash in step 4, so you can only submit EXACTLY what
// was reviewed. payGroupId shape: `contractor_adhoc.<companyPayGroupUuid>.<adhocUuid>`.

// ── payGroupId (the contractor ad-hoc pay group key) ────────────────────────────────────────────────────
// `contractor_adhoc.<uuid>.<uuid>`. uuids are hex-with-dashes; we locate+slice the token, we don't fully
// validate the uuids. The employee analog is `regular.<paySchedule>.<payGroup>.<checkDate>`.
const CONTRACTOR_PAY_GROUP_RE = /contractor_adhoc\.[0-9a-f][0-9a-f-]{7,}\.[0-9a-f][0-9a-f-]{7,}/i;

/** True when the string is a well-formed contractor ad-hoc pay group id. Pure. */
export function isContractorPayGroupId(id: string | null | undefined): boolean {
  return !!id && CONTRACTOR_PAY_GROUP_RE.test(id) && new RegExp(`^${CONTRACTOR_PAY_GROUP_RE.source}$`, "i").test(id);
}

/** Extract the contractor pay group id from a URL/href (or any string containing it). Null when absent.
 *  The extension uses this to DISCOVER the id from the /pay/contractors/ad-hoc/<id>/… URL. Pure. */
export function parseContractorPayGroupId(href: string | null | undefined): string | null {
  if (!href) return null;
  const m = String(href).match(CONTRACTOR_PAY_GROUP_RE);
  return m ? m[0] : null;
}

// ── SubmitPayGroup(input) — the PAY mutation (captured exact) ────────────────────────────────────────────
export interface SubmitPayGroupInput {
  acknowledgedBlockedMemberIds: string[] | null; // null normally; ids only when a human acknowledged blockers
  bankScreenshot: null; // never set by us
  expectedDataHash: string; // from ReviewPayGroup.dataHash — integrity guard: submit only what was reviewed
  expectedDataHashExcludingFundingMethod: string; // from ReviewPayGroup.dataHashExcludingFundingMethod
  payGroupId: string;
  requestedPayoutRail: null; // ALWAYS null — standard rail, never expedite (invariant, tested)
  selectedUnblockOptionType: null; // never set by us
}

/** Build the EXACT SubmitPayGroup input. requestedPayoutRail is ALWAYS null and the bank/unblock fields are
 *  ALWAYS null — the never-expedite, human-stays-in-charge invariant. Pure. */
export function buildSubmitPayGroupInput(p: {
  payGroupId: string;
  dataHash: string;
  dataHashExcludingFundingMethod: string;
  acknowledgedBlockedMemberIds?: string[] | null;
}): SubmitPayGroupInput {
  return {
    acknowledgedBlockedMemberIds: p.acknowledgedBlockedMemberIds ?? null,
    bankScreenshot: null,
    expectedDataHash: p.dataHash,
    expectedDataHashExcludingFundingMethod: p.dataHashExcludingFundingMethod,
    payGroupId: p.payGroupId,
    requestedPayoutRail: null,
    selectedUnblockOptionType: null,
  };
}

export type ContractorSubmitOutcome = "submitted" | "blocked" | "already_submitted" | "failed";
export interface BlockedMember {
  memberId: string | null;
  name: string | null;
  blockers: { code: string | null; message: string }[];
}
export interface ParsedContractorSubmitResult {
  outcome: ContractorSubmitOutcome;
  payGroupId: string | null;
  blockedMembers: BlockedMember[];
  errors: { code: string | null; message: string }[];
}

const ALREADY_RE = /already\s+(submitted|processed|paid|run)|not\s+(a\s+)?draft|no\s+draft|already\s+in\s+progress/i;

function readErrorFields(e: unknown): { code: string | null; message: string } {
  const o = (e ?? {}) as Record<string, unknown>;
  // The union members name their code field differently (submitContractorPayGroupErrorCode, …) but every
  // variant carries `message` and some `code`. Accept any *code key, then fall back to `code`.
  const codeKey = Object.keys(o).find((k) => /code$/i.test(k) && typeof o[k] === "string");
  const code = codeKey ? String(o[codeKey]) : typeof o.code === "string" ? o.code : null;
  return { code, message: String(o.message ?? "error") };
}

function readBlockedMembers(raw: unknown): BlockedMember[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((b) => {
    const o = (b ?? {}) as Record<string, unknown>;
    const member = (o.member ?? {}) as Record<string, unknown>;
    const blockers = Array.isArray(o.payBlockers) ? o.payBlockers : [];
    return {
      memberId: member.id != null ? String(member.id) : null,
      name: member.preferredFullName != null ? String(member.preferredFullName) : null,
      blockers: blockers.map((pb) => {
        const p = (pb ?? {}) as Record<string, unknown>;
        return { code: typeof p.code === "string" ? p.code : null, message: String(p.message ?? "blocked") };
      }),
    };
  });
}

/** Classify a SubmitPayGroup response. Success = SubmitPayGroupSuccess{ payGroup{ id } }. Blocked members =>
 *  `blocked` (a human must acknowledge). A failure that reads "already submitted / not a draft" => idempotent
 *  `already_submitted` (reported WITHOUT resubmitting). Defensive: a shape change yields `failed` with the raw
 *  errors, never a false success. Pure. */
export function parseSubmitPayGroupResponse(json: unknown): ParsedContractorSubmitResult {
  const empty: ParsedContractorSubmitResult = { outcome: "failed", payGroupId: null, blockedMembers: [], errors: [] };
  if (!json || typeof json !== "object") return empty;
  const j = json as {
    errors?: { message?: unknown }[];
    data?: { submitPayGroup?: { result?: Record<string, unknown> } };
  };
  const topErrors = Array.isArray(j.errors) ? j.errors.map((e) => ({ code: null, message: String((e as { message?: unknown })?.message ?? "error") })) : [];
  const result = j.data?.submitPayGroup?.result;
  if (!result) {
    if (topErrors.length) {
      return { outcome: topErrors.some((e) => ALREADY_RE.test(e.message)) ? "already_submitted" : "failed", payGroupId: null, blockedMembers: [], errors: topErrors };
    }
    return empty;
  }
  const typename = String(result.__typename ?? "");
  if (/Success/i.test(typename)) {
    const pg = (result.payGroup ?? {}) as Record<string, unknown>;
    return { outcome: "submitted", payGroupId: pg.id != null ? String(pg.id) : null, blockedMembers: [], errors: [] };
  }
  if (/BlockedMembers/i.test(typename)) {
    return { outcome: "blocked", payGroupId: null, blockedMembers: readBlockedMembers(result.blockedMembers), errors: [] };
  }
  // Failure / MemberFailure
  const errors: { code: string | null; message: string }[] = [];
  if (result.error) errors.push(readErrorFields(result.error));
  if (Array.isArray(result.memberErrorDetails)) {
    for (const d of result.memberErrorDetails as Record<string, unknown>[]) {
      const errs = Array.isArray(d.errors) ? d.errors : d.error ? [d.error] : [];
      for (const e of errs) errors.push(readErrorFields(e));
    }
  }
  const all = errors.length ? errors : topErrors;
  const already = all.some((e) => ALREADY_RE.test(e.message));
  return { outcome: already ? "already_submitted" : "failed", payGroupId: null, blockedMembers: [], errors: all };
}

// ── ReviewPayGroup — the mutation that mints the dataHash + exposes funding/risk (captured exact) ────────
export interface ContractorFunding {
  wireInFunded: boolean | null; // the run is wire-in funded (the "wire" that CAN apply to contractors)
  isReverseWireFunded: boolean | null;
  achSpeed: string | null;
  isBankScreenshotRequired: boolean | null;
  wireCutoffTime: string | null;
  wireInReason: string | null;
  submitBlockers: { blockerType: string | null; status: string | null }[];
}
export type ContractorReviewOutcome = "reviewed" | "blocked" | "fx_refreshing" | "failed";
export interface ParsedContractorReviewResult {
  outcome: ContractorReviewOutcome;
  dataHash: string | null; // => SubmitPayGroup.expectedDataHash
  dataHashExcludingFundingMethod: string | null; // => SubmitPayGroup.expectedDataHashExcludingFundingMethod
  funding: ContractorFunding | null;
  blockedMembers: BlockedMember[];
  errors: { code: string | null; message: string }[];
}

/** Parse a ReviewPayGroup response. Success => the two data hashes + the funding/risk result (which tells us
 *  wire-in vs ACH). Blocked members => `blocked`. FX refresh in progress => `fx_refreshing` (the caller retries
 *  review, never submits). Defensive. Pure. */
export function parseReviewPayGroupResponse(json: unknown): ParsedContractorReviewResult {
  const empty: ParsedContractorReviewResult = { outcome: "failed", dataHash: null, dataHashExcludingFundingMethod: null, funding: null, blockedMembers: [], errors: [] };
  if (!json || typeof json !== "object") return empty;
  const j = json as {
    errors?: { message?: unknown }[];
    data?: { reviewPayGroup?: { result?: Record<string, unknown> } };
  };
  const topErrors = Array.isArray(j.errors) ? j.errors.map((e) => ({ code: null, message: String((e as { message?: unknown })?.message ?? "error") })) : [];
  const result = j.data?.reviewPayGroup?.result;
  if (!result) return topErrors.length ? { ...empty, errors: topErrors } : empty;
  const typename = String(result.__typename ?? "");
  if (/Success/i.test(typename)) {
    const risk = (result.riskResult ?? null) as Record<string, unknown> | null;
    const funding: ContractorFunding | null = risk
      ? {
          wireInFunded: typeof risk.wireInFunded === "boolean" ? risk.wireInFunded : null,
          isReverseWireFunded: typeof risk.isReverseWireFunded === "boolean" ? risk.isReverseWireFunded : null,
          achSpeed: typeof risk.achSpeed === "string" ? risk.achSpeed : null,
          isBankScreenshotRequired: typeof risk.isBankScreenshotRequired === "boolean" ? risk.isBankScreenshotRequired : null,
          wireCutoffTime: typeof risk.wireCutoffTime === "string" ? risk.wireCutoffTime : null,
          wireInReason: typeof risk.wireInReason === "string" ? risk.wireInReason : null,
          submitBlockers: Array.isArray(risk.submitBlockers)
            ? (risk.submitBlockers as Record<string, unknown>[]).map((b) => ({
                blockerType: typeof b.blockerType === "string" ? b.blockerType : null,
                status: typeof b.status === "string" ? b.status : null,
              }))
            : [],
        }
      : null;
    return {
      outcome: "reviewed",
      dataHash: result.dataHash != null ? String(result.dataHash) : null,
      dataHashExcludingFundingMethod: result.dataHashExcludingFundingMethod != null ? String(result.dataHashExcludingFundingMethod) : null,
      funding,
      blockedMembers: [],
      errors: [],
    };
  }
  if (/BlockedMembers/i.test(typename)) {
    return { ...empty, outcome: "blocked", blockedMembers: readBlockedMembers(result.blockedMembers) };
  }
  if (/FxRateRefresh/i.test(typename)) {
    return { ...empty, outcome: "fx_refreshing" };
  }
  const errors: { code: string | null; message: string }[] = [];
  if (result.error) errors.push(readErrorFields(result.error));
  if (Array.isArray(result.memberErrorDetails)) {
    for (const d of result.memberErrorDetails as Record<string, unknown>[]) {
      const errs = Array.isArray(d.errors) ? d.errors : d.error ? [d.error] : [];
      for (const e of errs) errors.push(readErrorFields(e));
    }
  }
  return { ...empty, outcome: "failed", errors: errors.length ? errors : topErrors };
}

// ── Pay items (UseContractorPayPayItemsByMemberIds) — the worksheet rows (captured exact) ────────────────
export interface ContractorPayItem {
  payItemId: string;
  memberId: string | null;
  name: string | null;
  country: string | null; // US / PH / …
  isInternational: boolean;
  included: boolean; // isIncludedInPayGroup
  regularHours: number | null; // workedHours.regularHours — the field the hours-push sets
  workedHoursId: string | null; // workedHours.id — the push target (provisional)
  fixedPaymentAmount: number | null; // when paid a flat amount instead of hours
  totalDebitAmount: number | null; // calculatedAmounts.totalDebitAmount.amount (what Zoe is debited)
  currency: string | null;
  payBlockers: { code: string | null; message: string }[];
}

const numAmt = (v: unknown): number | null => {
  const o = (v ?? null) as Record<string, unknown> | null;
  const raw = o && "amount" in o ? o.amount : v;
  const n = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() ? Number(raw) : NaN;
  return Number.isFinite(n) ? n : null;
};

/** Parse the contractor pay items out of a UseContractorPayPayItemsByMemberIds response. Returns one row per
 *  ContractorPayItem with the member, country, current regular hours, the workedHours id (push target), any
 *  flat payment, the total debit, and pay blockers. Defensive — a malformed row is skipped. Pure. */
export function parseContractorPayItems(json: unknown): ContractorPayItem[] {
  const j = json as { data?: { company?: { payGroupInterface?: { payItemInterfacesByMemberIds?: unknown } } } };
  const rows = j?.data?.company?.payGroupInterface?.payItemInterfacesByMemberIds;
  if (!Array.isArray(rows)) return [];
  const out: ContractorPayItem[] = [];
  for (const r of rows as Record<string, unknown>[]) {
    if (!r || r.id == null) continue;
    const member = (r.member ?? {}) as Record<string, unknown>;
    const nameObj = (member.name ?? {}) as Record<string, unknown>;
    const name = typeof nameObj.fullName === "string" ? nameObj.fullName
      : [member.preferredFirstName ?? member.legalFirstName, member.lastName].filter(Boolean).join(" ").trim() || (typeof member.businessName === "string" ? member.businessName : null);
    const contractor = (r.contractor ?? {}) as Record<string, unknown>;
    const workedHours = (r.workedHours ?? {}) as Record<string, unknown>;
    const fixed = Array.isArray(r.fixedPayments) && r.fixedPayments.length ? (r.fixedPayments[0] as Record<string, unknown>) : null;
    const calc = (r.calculatedAmounts ?? {}) as Record<string, unknown>;
    const country = typeof contractor.country === "string" ? contractor.country : null;
    const blockers = Array.isArray(r.payBlockers) ? (r.payBlockers as Record<string, unknown>[]) : [];
    out.push({
      payItemId: String(r.id),
      memberId: member.id != null ? String(member.id) : null,
      name: name || null,
      country,
      isInternational: /International/i.test(String(contractor.__typename ?? "")) || (country != null && country.toUpperCase() !== "US" && country.toUpperCase() !== "USA" && country !== "United States"),
      included: r.isIncludedInPayGroup !== false,
      regularHours: typeof workedHours.regularHours === "number" ? workedHours.regularHours : workedHours.regularHours != null && String(workedHours.regularHours).trim() ? Number(workedHours.regularHours) : null,
      workedHoursId: workedHours.id != null ? String(workedHours.id) : null,
      fixedPaymentAmount: fixed ? numAmt(fixed.paymentAmount) : null,
      totalDebitAmount: numAmt(calc.totalDebitAmount),
      currency: (() => {
        const td = (calc.totalDebitAmount ?? {}) as Record<string, unknown>;
        return typeof td.currencyCode === "string" ? td.currencyCode : typeof r.inputCurrency === "string" ? r.inputCurrency : null;
      })(),
      payBlockers: blockers.map((b) => ({ code: typeof b.code === "string" ? b.code : null, message: String(b.message ?? "blocked") })),
    });
  }
  return out;
}

// ── Push hours (UpdateContractorPayItemWorkedHours) — PROVISIONAL input shape ────────────────────────────
// The mutation NAME + its error type are captured (UpdateContractorPayItemWorkedHours / …Error), but the exact
// input VARIABLES were NOT captured yet (it only fires when an hours value is edited). This builder is the
// best-effort shape from the pay-item model (workedHours.id + regularHours); it MUST be reconciled against a
// real UpdateContractorPayItemWorkedHours capture before the push is wired to the extension. Pushing hours to
// a DRAFT moves no money (it is caught at the human review step and the pay is separately hard-confirmed), so
// verifying this on a throwaway draft is safe.
export interface UpdateWorkedHoursInput {
  payGroupId: string;
  payItemId: string;
  workedHoursId: string | null;
  regularHours: number;
}
/** PROVISIONAL — see the note above. Build the worked-hours push input for one pay item. Pure. */
export function buildUpdateWorkedHoursInput(p: { payGroupId: string; payItemId: string; workedHoursId?: string | null; regularHours: number }): UpdateWorkedHoursInput {
  return { payGroupId: p.payGroupId, payItemId: p.payItemId, workedHoursId: p.workedHoursId ?? null, regularHours: p.regularHours };
}

// ── Gating (mirrors runPayrollGate / confirmWireGate from gustoSubmit.ts) ────────────────────────────────
export interface ContractorPayGate {
  canPay: boolean;
  reason: string;
}
/** Whether the "Pay contractors" trigger may arm. Blocked when disabled, already submitted, or not yet
 *  confirmed by a human in the app. The UI and the submit-payload endpoint use the SAME decision so the gate
 *  can't be bypassed by the client. Pure + tested. */
export function contractorPayGate(a: { confirmed: boolean; alreadySubmitted: boolean; disabled: boolean }): ContractorPayGate {
  if (a.disabled) return { canPay: false, reason: "Contractor pay is disabled." };
  if (a.alreadySubmitted) return { canPay: false, reason: "This contractor pay group has already been submitted." };
  if (!a.confirmed) return { canPay: false, reason: "Confirm the reviewed hours before paying contractors." };
  return { canPay: true, reason: "" };
}
