// Gusto hours-push state — the kill switch + the honest "last push" status surfaced on /payroll. The push
// itself is done by the browser extension (it replays the mutation in a logged-in Gusto tab); this module
// only persists the RESULT the extension reports back (via /api/payroll/gusto/push-result) and reads it for
// the UI. NEVER claims "pushed" without the extension's confirmation. Persisted in the settings KV.

import { getJson, setJson } from "@/lib/kv";

const KEY = "gusto.push.last";

export interface GustoPushWorkerResult {
  gustoMemberId: string;
  name: string | null;
  outcome: "pushed" | "skipped" | "failed";
  regularHours?: number | null;
  overtimeHours?: number | null;
  reason?: string | null; // why skipped/failed
}

export interface GustoPushResult {
  at: string; // ISO — when the extension reported the result
  ok: boolean; // the run completed and nothing failed (aborted/partial ⇒ false)
  aborted: string | null; // non-null = the extension aborted before writing (e.g. run not a DRAFT, signed out)
  draftPayrollId: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  pushed: number;
  skipped: number;
  failed: number;
  workers: GustoPushWorkerResult[];
  initiatedBy: string | null;
  sessionMode: "generated" | "captured" | null; // which session-id strategy actually worked (HYPOTHESIS validation)
}

/** The kill switch. DRAFT-only writes still touch real payroll, so an env flag can hard-disable the whole
 *  push without a deploy toggle in code. Any truthy-ish value except "0"/"false" disables. */
export function gustoPushDisabled(): boolean {
  const v = (process.env.GUSTO_PUSH_DISABLED ?? "").trim().toLowerCase();
  return v !== "" && v !== "0" && v !== "false" && v !== "off" && v !== "no";
}

export function recordGustoPushResult(r: GustoPushResult): void {
  setJson(KEY, r);
}

export function readGustoPushResult(): GustoPushResult | null {
  const r = getJson<GustoPushResult | null>(KEY, null);
  return r && typeof r.at === "string" ? r : null;
}
