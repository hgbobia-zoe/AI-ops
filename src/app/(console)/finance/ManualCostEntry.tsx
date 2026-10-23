"use client";

// Manual cost-entry panel (FI Stage 5, G9) — mounted inside the per-project profitability snapshot. Lets
// an owner/admin add / edit / delete a `source='manual'` cost row (sub-rental, subcontractor, vehicle,
// fuel, consumables, event expense, other). Writes go through the gated + audited /api/finance/cost-entry
// route; the snapshot rolls these DIRECT rows up automatically on the next render. `canEdit` is resolved
// server-side (the real security boundary is the API gate); when false the panel is read-only.

import { useCallback, useEffect, useState } from "react";
import { MANUAL_COST_TYPES } from "@/lib/finance/costFamilies";

interface Entry {
  id: string;
  sourceRef: string;
  type: string;
  klass: string;
  amount: number | null;
  note: string | null;
  capturedAt: string;
}

const money = (n: number | null): string => (n == null ? "—" : (n < 0 ? "-$" : "$") + Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));

export function ManualCostEntry({ projectId, canEdit }: { projectId: string; canEdit: boolean }): React.JSX.Element {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [type, setType] = useState<string>(MANUAL_COST_TYPES[0]);
  const [klass, setKlass] = useState<"DIRECT" | "OVERHEAD">("DIRECT");
  const [amount, setAmount] = useState<string>("");
  const [note, setNote] = useState<string>("");
  const [editingRef, setEditingRef] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/finance/cost-entry?projectId=${encodeURIComponent(projectId)}`);
      if (!r.ok) return;
      const j = (await r.json()) as { entries: Entry[] };
      setEntries(j.entries ?? []);
    } catch {
      /* read-only panel; a load failure just shows nothing */
    }
  }, [projectId]);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const r = await fetch(`/api/finance/cost-entry?projectId=${encodeURIComponent(projectId)}`);
        if (!r.ok || !alive) return;
        const j = (await r.json()) as { entries: Entry[] };
        if (alive) setEntries(j.entries ?? []);
      } catch {
        /* read-only panel; a load failure just shows nothing */
      }
    })();
    return () => {
      alive = false;
    };
  }, [projectId]);

  const reset = (): void => {
    setEditingRef(null);
    setType(MANUAL_COST_TYPES[0]);
    setKlass("DIRECT");
    setAmount("");
    setNote("");
  };

  const submit = async (): Promise<void> => {
    const amt = Number(amount);
    if (!Number.isFinite(amt)) {
      setErr("Enter a valid amount.");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch("/api/finance/cost-entry", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId, type, class: klass, amount: amt, note: note || null, sourceRef: editingRef ?? undefined }),
      });
      const j = (await r.json()) as { ok?: boolean; error?: string };
      if (!r.ok || !j.ok) {
        setErr(j.error ?? "Save failed.");
        return;
      }
      reset();
      await load();
    } catch {
      setErr("Save failed.");
    } finally {
      setBusy(false);
    }
  };

  const remove = async (sourceRef: string): Promise<void> => {
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch("/api/finance/cost-entry", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ sourceRef }) });
      if (!r.ok) {
        const j = (await r.json().catch(() => ({}))) as { error?: string };
        setErr(j.error ?? "Delete failed.");
        return;
      }
      if (editingRef === sourceRef) reset();
      await load();
    } catch {
      setErr("Delete failed.");
    } finally {
      setBusy(false);
    }
  };

  const edit = (e: Entry): void => {
    setEditingRef(e.sourceRef);
    setType(e.type);
    setKlass(e.klass === "OVERHEAD" ? "OVERHEAD" : "DIRECT");
    setAmount(e.amount == null ? "" : String(e.amount));
    setNote((e.note ?? "").replace(/\s*\(manual entry by .*\)$/, ""));
  };

  const inputCls = "border border-border bg-panel px-2 py-1 text-[12.5px] text-foreground";

  return (
    <div className="mt-6">
      <h3 className="mb-2 text-[13px] font-medium uppercase tracking-[0.1em] text-tertiary-text">Manual cost entries</h3>
      {entries.length === 0 ? (
        <p className="text-[12.5px] text-meta">No manual costs recorded for this project. Manual entries are real figures a person enters (sub-rental, subcontractor, one-off expenses) and roll into the cost families above as ACTUAL.</p>
      ) : (
        <ul className="mb-3 divide-y divide-[var(--row-rule)] border border-border">
          {entries.map((e) => (
            <li key={e.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-[12.5px]">
              <span>
                <span className="font-medium">{e.type}</span> <span className="text-meta">· {e.klass.toLowerCase()}</span> · <span className="tabular-nums">{money(e.amount)}</span>
                {e.note ? <span className="ml-2 text-meta">{e.note}</span> : null}
              </span>
              {canEdit ? (
                <span className="flex gap-3">
                  <button type="button" onClick={() => edit(e)} disabled={busy} className="text-muted-foreground underline hover:text-foreground">Edit</button>
                  <button type="button" onClick={() => void remove(e.sourceRef)} disabled={busy} className="text-critical underline hover:opacity-80">Delete</button>
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {canEdit ? (
        <div className="flex flex-wrap items-end gap-2 border border-border bg-panel px-3 py-3">
          <label className="flex flex-col gap-1 text-[11px] uppercase tracking-[0.06em] text-meta">
            Type
            <select value={type} onChange={(ev) => setType(ev.target.value)} className={inputCls}>
              {MANUAL_COST_TYPES.map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-[11px] uppercase tracking-[0.06em] text-meta">
            Class
            <select value={klass} onChange={(ev) => setKlass(ev.target.value === "OVERHEAD" ? "OVERHEAD" : "DIRECT")} className={inputCls}>
              <option value="DIRECT">DIRECT</option>
              <option value="OVERHEAD">OVERHEAD</option>
            </select>
          </label>
          <label className="flex flex-col gap-1 text-[11px] uppercase tracking-[0.06em] text-meta">
            Amount ($)
            <input value={amount} onChange={(ev) => setAmount(ev.target.value)} inputMode="decimal" placeholder="0.00" className={`${inputCls} w-28`} />
          </label>
          <label className="flex flex-1 flex-col gap-1 text-[11px] uppercase tracking-[0.06em] text-meta">
            Note
            <input value={note} onChange={(ev) => setNote(ev.target.value)} placeholder="e.g. sub-rented 20x40 tent from Acme" className={`${inputCls} w-full`} />
          </label>
          <button type="button" onClick={() => void submit()} disabled={busy} className="border border-border bg-foreground px-3 py-1.5 text-[12.5px] font-medium text-background hover:opacity-90 disabled:opacity-50">
            {editingRef ? "Save edit" : "Add cost"}
          </button>
          {editingRef ? (
            <button type="button" onClick={reset} disabled={busy} className="px-2 py-1.5 text-[12.5px] text-muted-foreground underline hover:text-foreground">Cancel</button>
          ) : null}
          {err ? <span className="w-full text-[12px] text-critical">{err}</span> : null}
          <p className="w-full text-[11px] text-meta">Only DIRECT entries count toward this project&apos;s contribution; OVERHEAD is recorded but not project-direct. Overhead entries are not shown in the cost-family rollup above.</p>
        </div>
      ) : (
        <p className="text-[11px] text-meta">Adding or editing a manual cost requires owner/admin access.</p>
      )}
    </div>
  );
}
