"use client";

// Approve a REQUIRES_REVIEW worker INTO this period's run (promote to READY / pushable), or un-approve.
// One click each (no reason needed) — the human reviewed the row and accepts it. Owner/admin (the API
// gates it); this is just the trigger + feedback. Reversible per period via "Un-approve".

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Check, RotateCcw } from "lucide-react";

export interface ApproveControlProps {
  workerKey: string;
  name: string;
  periodStart: string;
  periodEnd: string;
  accepted?: boolean; // true when already accepted (render "Un-approve")
  acceptedBy?: string | null;
}

export function ApproveControl(props: ApproveControlProps): React.JSX.Element {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function post(action: "accept" | "unaccept"): Promise<void> {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/payroll/worker/accept", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, workerKey: props.workerKey, name: props.name, periodStart: props.periodStart, periodEnd: props.periodEnd }),
      });
      const data = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) setErr(data?.error ?? "Failed.");
      else router.refresh();
    } catch {
      setErr("Network error.");
    } finally {
      setBusy(false);
    }
  }

  if (props.accepted) {
    // Attribution ("Accepted by X") lives in the button tooltip so the Actions cell stays one aligned line,
    // the way Gusto/Connecteam keep row-level metadata on hover rather than stacked under the control.
    return (
      <div className="flex flex-col items-end gap-0.5">
        <button
          onClick={() => post("unaccept")}
          disabled={busy}
          title={props.acceptedBy ? `Accepted by ${props.acceptedBy}` : undefined}
          className="inline-flex h-7 items-center gap-1.5 whitespace-nowrap rounded border border-border px-2 text-[11.5px] text-meta transition-colors hover:bg-[var(--row-hover)] hover:text-secondary-text disabled:opacity-40"
        >
          <RotateCcw className="size-3.5" /> {busy ? "…" : "Un-approve"}
        </button>
        {err && <span className="text-[10.5px] text-critical">{err}</span>}
      </div>
    );
  }

  return (
    <div className="flex flex-col items-end gap-0.5">
      <button
        onClick={() => post("accept")}
        disabled={busy}
        className="inline-flex h-7 items-center gap-1.5 whitespace-nowrap rounded border border-positive/40 px-2 text-[11.5px] text-positive transition-colors hover:bg-positive/10 disabled:opacity-40"
      >
        <Check className="size-3.5" /> {busy ? "…" : "Approve"}
      </button>
      {err && <span className="text-[10.5px] text-critical">{err}</span>}
    </div>
  );
}
