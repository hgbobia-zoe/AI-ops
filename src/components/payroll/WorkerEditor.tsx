"use client";

// Worker editor — a per-row dialog to classify a worker and map them to a Gusto member (resolving the
// "no Gusto mapping" + missing-config blockers). Choosing a Gusto member auto-fills the authoritative
// worker type + country from Gusto. Saves to /api/payroll/worker. A mapping set here is a human decision.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Pencil, X } from "lucide-react";
import type { WorkerType, GustoEntityType, PayType } from "@/lib/payroll/types";

export interface EditorWorker {
  recordId: string | null;
  connecteamUserId: number | null;
  name: string;
  workerType: WorkerType;
  payType: PayType | null;
  payRate: number | null;
  currency: string;
  country: string | null;
  gustoId: string | null;
}
export interface GustoPick {
  id: string;
  name: string;
  personType: string; // employee | contractor
  country: string | null;
}

const TYPES: WorkerType[] = ["EMPLOYEE", "US_CONTRACTOR", "INTERNATIONAL_CONTRACTOR", "TEMPORARY_WORKER", "UNKNOWN"];
const TYPE_LABEL: Record<WorkerType, string> = {
  EMPLOYEE: "Employee", US_CONTRACTOR: "US Contractor", INTERNATIONAL_CONTRACTOR: "International Contractor",
  TEMPORARY_WORKER: "Temporary Worker", UNKNOWN: "Unclassified",
};
const field = "h-8 w-full rounded border border-border bg-[var(--panel)] px-2 text-[12.5px] text-foreground";
const lbl = "text-[10.5px] uppercase tracking-[0.08em] text-meta";

export function WorkerEditor({ worker, gustoMembers }: { worker: EditorWorker; gustoMembers: GustoPick[] }): React.JSX.Element {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [f, setF] = useState<EditorWorker>(worker);
  const set = <K extends keyof EditorWorker>(k: K, v: EditorWorker[K]) => setF((s) => ({ ...s, [k]: v }));

  function pickGusto(id: string): void {
    if (!id) { set("gustoId", null); return; }
    const m = gustoMembers.find((x) => x.id === id);
    if (!m) { set("gustoId", id); return; }
    const intl = m.country != null && !/^(usa|us|united states( of america)?)$/i.test(m.country.trim());
    setF((s) => ({
      ...s,
      gustoId: m.id,
      country: m.country ?? s.country,
      workerType: m.personType === "contractor" ? (intl ? "INTERNATIONAL_CONTRACTOR" : "US_CONTRACTOR") : m.personType === "employee" ? "EMPLOYEE" : s.workerType,
    }));
  }

  async function save(): Promise<void> {
    setBusy(true);
    setErr(null);
    try {
      const entity: GustoEntityType | null = f.gustoId ? (f.workerType === "US_CONTRACTOR" || f.workerType === "INTERNATIONAL_CONTRACTOR" || f.workerType === "TEMPORARY_WORKER" ? "contractor" : "employee") : null;
      const res = await fetch("/api/payroll/worker", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          recordId: f.recordId, connecteamUserId: f.connecteamUserId, name: f.name,
          workerType: f.workerType, payRate: f.payRate, currency: f.currency, country: f.country,
          gustoId: f.gustoId, gustoEntityType: entity,
        }),
      });
      if (!res.ok) { const d = await res.json().catch(() => null); setErr((d && d.error) || "Save failed."); return; }
      setOpen(false);
      router.refresh();
    } catch {
      setErr("Save failed — network error.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button onClick={() => setOpen(true)} aria-label={`Edit ${worker.name}`} className="inline-flex size-6 items-center justify-center rounded text-meta transition-colors hover:bg-[var(--row-hover)] hover:text-foreground">
        <Pencil className="size-3.5" />
      </button>
      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={() => setOpen(false)}>
          <div className="surface w-full max-w-md border p-4 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-[13px] font-semibold text-foreground">{worker.name}</h3>
              <button onClick={() => setOpen(false)} aria-label="Close" className="text-meta hover:text-foreground"><X className="size-4" /></button>
            </div>
            <div className="space-y-3">
              <label className="flex flex-col gap-1">
                <span className={lbl}>Gusto mapping</span>
                <select className={field} value={f.gustoId ?? ""} onChange={(e) => pickGusto(e.target.value)}>
                  <option value="">— Unmapped —</option>
                  {gustoMembers.map((m) => <option key={m.id} value={m.id}>{m.name} · {m.personType}{m.country ? ` · ${m.country}` : ""}</option>)}
                </select>
              </label>
              <label className="flex flex-col gap-1">
                <span className={lbl}>Worker type</span>
                <select className={field} value={f.workerType} onChange={(e) => set("workerType", e.target.value as WorkerType)}>
                  {TYPES.map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
                </select>
              </label>
              <div className="grid grid-cols-3 gap-2">
                <label className="flex flex-col gap-1">
                  <span className={lbl}>Pay rate</span>
                  <input type="number" min={0} step="0.01" className={field} value={f.payRate ?? ""} onChange={(e) => set("payRate", e.target.value === "" ? null : Number(e.target.value))} />
                </label>
                <label className="flex flex-col gap-1">
                  <span className={lbl}>Currency</span>
                  <input className={field} value={f.currency} onChange={(e) => set("currency", e.target.value.toUpperCase())} />
                </label>
                <label className="flex flex-col gap-1">
                  <span className={lbl}>Country</span>
                  <input className={field} value={f.country ?? ""} onChange={(e) => set("country", e.target.value || null)} />
                </label>
              </div>
            </div>
            <div className="mt-4 flex items-center gap-3 border-t border-rule pt-3">
              <button onClick={save} disabled={busy} className="inline-flex h-8 items-center rounded-md bg-foreground px-3 text-[12.5px] font-medium text-background transition-opacity hover:opacity-90 disabled:opacity-60">{busy ? "Saving…" : "Save"}</button>
              <button onClick={() => setOpen(false)} className="text-[12px] text-meta hover:text-foreground">Cancel</button>
              {err && <span className="text-[11.5px] text-critical">{err}</span>}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
