// Plain, honest wording for a Gusto attempt: a DRAFT update (hours written into the draft, nothing paid) is a
// different thing from a SUBMIT (payroll actually run). A failed or partial attempt never reads as success.
// Used by the Overview's latest-attempt line and the payroll activity feed. Pure.

import type { PayrollTone } from "./types";

export interface AttemptLine {
  kind: "draft" | "submit";
  tone: PayrollTone;
  title: string;
  detail: string | null;
}

const ABORT: Record<string, string> = {
  not_logged_in: "Gusto was signed out",
  no_response: "the Gusto tab never started",
  claimed_no_result: "the Gusto tab never finished",
  could_not_reach_inputs: "couldn't reach the hours page",
  could_not_find_run: "couldn't find this week's run",
  not_a_draft: "the run is no longer a draft",
  no_draft_payroll_id: "couldn't read the draft",
  no_entries: "there were no hours to send",
};
export function abortReason(raw: string): string {
  if (raw.startsWith("exception:")) return `error: ${raw.slice(10)}`;
  const code = raw.split("@")[0];
  return ABORT[code] ?? code.replace(/_/g, " ");
}

export function draftAttemptLine(r: { ok?: boolean | null; aborted?: string | null; pushed?: number | null; failed?: number | null; skipped?: number | null }): AttemptLine {
  const pushed = r.pushed ?? 0;
  const failed = r.failed ?? 0;
  const skipped = r.skipped ?? 0;
  if (r.aborted) return { kind: "draft", tone: "critical", title: "Gusto draft update stopped", detail: abortReason(r.aborted) };
  if (failed > 0 && pushed === 0) return { kind: "draft", tone: "critical", title: "Gusto draft update failed", detail: `0 pushed, ${failed} failed` };
  if (failed > 0) return { kind: "draft", tone: "attention", title: "Gusto draft partly updated", detail: `${pushed} pushed, ${failed} failed` };
  return {
    kind: "draft",
    tone: "positive",
    title: "Gusto draft updated",
    detail: `${pushed} pushed${skipped ? `, ${skipped} already set or not in the draft` : ""}`,
  };
}

export function submitAttemptLine(r: { ok?: boolean | null; aborted?: string | null; submitted?: boolean | null; alreadySubmitted?: boolean | null; errors?: { message: string }[] | null }): AttemptLine {
  if (r.submitted || r.alreadySubmitted) {
    return { kind: "submit", tone: "positive", title: "Payroll submitted in Gusto", detail: r.alreadySubmitted ? "it was already submitted" : "wire the amount Gusto shows" };
  }
  if (r.aborted) return { kind: "submit", tone: "critical", title: "Payroll submit stopped", detail: abortReason(r.aborted) };
  return { kind: "submit", tone: "critical", title: "Payroll submit failed", detail: r.errors?.[0]?.message ?? "Gusto did not accept the submit" };
}
