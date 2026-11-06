// Live step of the running Gusto push/submit, reported by the extension (/api/payroll/gusto/progress) and read
// by the Run payroll dialog (via /api/payroll/gusto/status). Only the latest step per kind is kept. Persisted
// in the settings KV so it works across machines/instances like the result ledgers.

import { getJson, setJson } from "@/lib/kv";

export interface GustoProgress {
  kind: "push" | "submit";
  stage: string; // short code: opened | opening_run | choosing_wire | wire_terms | hours_page | writing | submitting
  detail: string | null; // e.g. "3 of 8"
  at: string; // ISO
}

const key = (kind: GustoProgress["kind"]): string => `gusto.progress.${kind}`;

export function recordGustoProgress(p: Omit<GustoProgress, "at">): void {
  setJson(key(p.kind), { ...p, at: new Date().toISOString() });
}

export function readGustoProgress(kind: GustoProgress["kind"]): GustoProgress | null {
  const p = getJson<GustoProgress | null>(key(kind), null);
  return p && typeof p.at === "string" ? p : null;
}
