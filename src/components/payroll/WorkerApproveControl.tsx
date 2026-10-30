"use client";

// Per-worker approve from the in-app Timesheet Review. Records the Zoe approval for THIS worker and finalizes
// their worked days in Connecteam (the lock-days write) by POSTing the worker's key to the SAME /approve
// endpoint, which re-derives the model and enforces the same approvability gate (this can't be bypassed). It
// does NOT submit or run payroll in Gusto, and it does NOT record the period-level sign-off (that is the bulk
// "Approve" + the run-payroll gate). Lives in the worker's expanded day breakdown so you approve what you
// just reviewed. Reversible via the period "Un-approve".

import { useState } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2 } from "lucide-react";

interface FinalizeResult { locked?: number; failed?: number; na?: number }

export function WorkerApproveControl({
  workerKey, name, periodStart, periodEnd,
}: {
  workerKey: string;
  name: string;
  periodStart: string;
  periodEnd: string;
}): React.JSX.Element {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; tone: "ok" | "bad" } | null>(null);

  function finalizeText(f: FinalizeResult | undefined): string {
    if (!f) return "";
    if (f.failed) return " Connecteam finalize failed. Re-approve to retry.";
    if (f.locked) return ` Locked ${f.locked} day${f.locked === 1 ? "" : "s"} in Connecteam.`;
    if (f.na) return " Approved in Zoe (nothing to lock in Connecteam).";
    return "";
  }

  async function run(): Promise<void> {
    if (!confirm(`Approve ${name}'s timesheet for this period?\n\nThis records the Zoe approval for this worker and locks (finalizes) their worked days in Connecteam. It does NOT submit or run payroll in Gusto.`)) return;
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/payroll/approve", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ start: periodStart, end: periodEnd, workerKeys: [workerKey], acknowledge: true }),
      });
      const data = (await res.json().catch(() => null)) as { error?: string; finalize?: FinalizeResult } | null;
      if (!res.ok) {
        setMsg({ text: data?.error ?? "Approval failed.", tone: "bad" });
      } else {
        setMsg({ text: `Approved ${name}.${finalizeText(data?.finalize)}`, tone: data?.finalize?.failed ? "bad" : "ok" });
        router.refresh();
      }
    } catch {
      setMsg({ text: "Approval failed. Network error.", tone: "bad" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <button
        onClick={run}
        disabled={busy}
        className="inline-flex h-7 items-center gap-1.5 rounded border border-positive/40 px-2.5 text-[11.5px] font-medium text-positive transition-colors hover:bg-positive/10 disabled:opacity-40"
      >
        <CheckCircle2 className="size-3.5" /> {busy ? "Approving…" : `Approve ${name.split(" ")[0]}'s timesheet`}
      </button>
      {msg && <span className={`text-[11px] ${msg.tone === "ok" ? "text-positive" : "text-critical"}`}>{msg.text}</span>}
    </span>
  );
}
