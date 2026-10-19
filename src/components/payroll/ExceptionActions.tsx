"use client";

// Resolve / Ignore / Verify a payroll exception — an explicit human action (never silent). Posts to
// /api/payroll/exception and refreshes. "Verify" re-checks the authoritative Connecteam record (spec §6):
// it only clears the exception when the live record actually passes — a click alone is not proof.

import { useState } from "react";
import { useRouter } from "next/navigation";

export function ExceptionActions({ id, reconcilable = false }: { id: string; reconcilable?: boolean }): React.JSX.Element {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  async function act(status: "RESOLVED" | "IGNORED"): Promise<void> {
    setBusy(true);
    try {
      const res = await fetch("/api/payroll/exception", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, status }),
      });
      if (res.ok) router.refresh();
    } catch {
      /* ignore — the row stays, user can retry */
    } finally {
      setBusy(false);
    }
  }

  async function reconcile(): Promise<void> {
    setBusy(true);
    setNote(null);
    try {
      const res = await fetch("/api/payroll/exception", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, action: "reconcile" }),
      });
      const data = (await res.json().catch(() => ({}))) as { cleared?: boolean; detail?: string };
      if (data.cleared) { router.refresh(); return; }
      setNote(data.detail ?? "Not cleared — the underlying record still fails.");
    } catch {
      setNote("Could not verify — try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex shrink-0 flex-col items-end gap-1">
      <div className="flex items-center gap-1.5">
        {reconcilable && (
          <button onClick={reconcile} disabled={busy} className="rounded border border-border px-2 py-0.5 text-[11px] text-secondary-text transition-colors hover:bg-[var(--row-hover)] hover:text-foreground disabled:opacity-50" title="Re-check the Connecteam record">Verify</button>
        )}
        <button onClick={() => act("RESOLVED")} disabled={busy} className="rounded border border-border px-2 py-0.5 text-[11px] text-secondary-text transition-colors hover:bg-[var(--row-hover)] hover:text-foreground disabled:opacity-50">Resolve</button>
        <button onClick={() => act("IGNORED")} disabled={busy} className="rounded border border-border px-2 py-0.5 text-[11px] text-meta transition-colors hover:bg-[var(--row-hover)] hover:text-foreground disabled:opacity-50">Ignore</button>
      </div>
      {note && <span className="max-w-[220px] text-right text-[10.5px] text-attention">{note}</span>}
    </div>
  );
}
