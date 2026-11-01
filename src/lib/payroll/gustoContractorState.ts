// Gusto CONTRACTOR pay — the kill switch + the honest "last contractor run" status surfaced on /payroll. The
// write itself is done by the Auto-Pull extension (extension/gusto-contractor.js) replaying Gusto's own
// GraphQL in a logged-in app.gusto.com tab; this module only persists what the extension REPORTED (via
// /api/payroll/gusto/contractor-result). It never claims "staged in Gusto" without that report, and it never
// pays: the final "Submit payments" is a human click on Gusto's own review page (reviewUrl).

import { getJson, setJson } from "@/lib/kv";

const KEY = "gusto.contractor.last";

export interface ContractorRunMember {
  key: string | null; // Zoe worker key (ct:<id>) when the extension echoed it
  name: string | null;
  memberUuid: string | null; // Gusto member uuid
  hours: number | null; // hours saved on the draft
  matchedBy: "id" | "name" | null;
  outcome: "staged" | "unmatched" | "failed";
  debit: number | null; // Gusto's computed withdrawal for this contractor (USD), after review
  reason: string | null;
}

export interface ContractorRunResult {
  at: string;
  ok: boolean; // staged + reviewed with no failures
  stage: "staged" | "review_failed" | "aborted";
  aborted: string | null; // e.g. not_logged_in, no_draft, no_members
  payGroupId: string | null;
  reviewUrl: string | null; // where the human clicks "Submit payments"
  periodStart: string | null;
  periodEnd: string | null;
  totalDebit: number | null; // Gusto's computed total (USD) — the number the human confirms against
  achSpeed: string | null; // e.g. four_day_ach
  wireInFunded: boolean | null;
  reviewErrors: string[]; // Gusto's own messages when review failed (e.g. minimum amount, transfer purpose)
  members: ContractorRunMember[];
  initiatedBy: string | null;
}

/** Hard stop for the whole contractor push, independent of the per-row gates. */
export function gustoContractorDisabled(): boolean {
  const v = (process.env.GUSTO_CONTRACTOR_DISABLED ?? "").trim().toLowerCase();
  return v !== "" && v !== "0" && v !== "false" && v !== "off" && v !== "no";
}

export function recordContractorRun(r: ContractorRunResult): void {
  setJson(KEY, r);
}

export function readContractorRun(): ContractorRunResult | null {
  const r = getJson<ContractorRunResult | null>(KEY, null);
  return r && typeof r.at === "string" ? r : null;
}

/** Gusto's review page for a contractor pay group (where the human submits). Null for a malformed id. */
export function contractorReviewUrl(payGroupId: string | null): string | null {
  if (!payGroupId || !/^contractor_adhoc\.[0-9a-f-]{8,}\.[0-9a-f-]{8,}$/i.test(payGroupId)) return null;
  return `https://app.gusto.com/zoe-event-party-rentals-llc/pay/contractors/ad-hoc/${payGroupId}/review`;
}
