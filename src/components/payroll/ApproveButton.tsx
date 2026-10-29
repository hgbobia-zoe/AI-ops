"use client";

// Approve payroll — records the human (Zoe) sign-off of the approvable workers for the period. The decision +
// its snapshot live server-side (the /approve endpoint re-derives the unified model and enforces the SAME
// gating, so this can't be bypassed); this is the trigger + confirmation. Approving is explicit, never
// automated, and it does NOT submit payroll to Gusto — that is a later, separate step.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, ShieldAlert } from "lucide-react";

export function ApproveButton({
  period, readyCount, acknowledgeableCount = 0, ackReason = null,
}: {
  period: { start: string; end: string };
  readyCount: number;
  acknowledgeableCount?: number;
  ackReason?: string | null;
}): React.JSX.Element {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; tone: "ok" | "bad" } | null>(null);

  // Strictly-ready workers can be approved with one click. When none are strictly ready but some are held
  // ONLY by the unverified-timesheet gate, the button becomes an explicit "acknowledge + approve".
  const ackOnly = readyCount === 0 && acknowledgeableCount > 0;
  const disabled = busy || (readyCount === 0 && acknowledgeableCount === 0);

  async function run(): Promise<void> {
    const acknowledge = ackOnly;
    const prompt = ackOnly
      ? `Approve ${acknowledgeableCount} worker${acknowledgeableCount === 1 ? "" : "s"} whose timesheets are NOT verified-approved in Connecteam?\n\n${ackReason ?? ""}\n\nThis records that you deliberately accepted the unverified timesheets. It does NOT submit payroll.`
      : `Approve payroll for ${readyCount} ready worker${readyCount === 1 ? "" : "s"}?\n\nBlocked and unverified workers are excluded. This records the Zoe sign-off only — it does NOT submit or run payroll in Gusto.`;
    if (!confirm(prompt)) return;
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/payroll/approve", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ start: period.start, end: period.end, acknowledge }),
      });
      const data = (await res.json().catch(() => null)) as { readyCount?: number; error?: string; requiresAck?: boolean } | null;
      if (!res.ok) {
        setMsg({ text: data?.error ?? "Approval failed.", tone: "bad" });
      } else {
        setMsg({ text: `Approved ${data?.readyCount ?? readyCount} worker(s). Sign-off recorded — payroll is NOT yet submitted to Gusto.`, tone: "ok" });
        router.refresh();
      }
    } catch {
      setMsg({ text: "Approval failed — network error.", tone: "bad" });
    } finally {
      setBusy(false);
    }
  }

  const label = ackOnly ? `Acknowledge & approve ${acknowledgeableCount}` : `Approve ${readyCount} ready`;

  return (
    <div className="flex flex-col items-start gap-1.5 sm:items-end">
      <button
        onClick={run}
        disabled={disabled}
        className={`inline-flex h-9 items-center justify-center gap-2 rounded-md px-4 text-[13px] font-medium transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40 ${
          ackOnly ? "bg-attention text-[#2a1e05]" : "bg-positive text-[#0b1f16]"
        }`}
      >
        {ackOnly ? <ShieldAlert className="size-4" /> : <CheckCircle2 className="size-4" />}
        {busy ? "Approving…" : label}
      </button>
      <span className="max-w-[16rem] text-right text-[11px] leading-snug text-meta">
        Records the Zoe sign-off. Does not submit, run, or pay in Gusto.
        {readyCount > 0 && acknowledgeableCount > 0 ? ` ${acknowledgeableCount} unverified excluded.` : ""}
      </span>
      {msg && <span className={`text-[11.5px] ${msg.tone === "ok" ? "text-positive" : "text-critical"}`}>{msg.text}</span>}
    </div>
  );
}
