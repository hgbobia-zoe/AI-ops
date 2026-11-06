"use client";

// Approve payroll — records the human (Zoe) sign-off of the approvable workers for the period AND finalizes
// their worked days in Connecteam (the lock-days write — the only finalization Connecteam exposes), which
// clears the "Unapproved timesheet" blocker so payroll is managed from one place. The /approve endpoint
// re-derives the unified model and enforces the SAME gating (this can't be bypassed) and performs the
// Connecteam lock server-side; this is the trigger + confirmation. It does NOT submit payroll to Gusto.
// Reversible via "Un-approve". For the week payroll runs for, Run payroll (RunPayrollFlow) approves as its
// first step, so this full button shows only for older weeks; `unapproveOnly` renders just the undo link.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, ShieldAlert, RotateCcw } from "lucide-react";
import { useConfirm } from "@/components/ui/confirm-dialog";

interface FinalizeResult { locked?: number; failed?: number; na?: number }

export function ApproveButton({
  period, readyCount, acknowledgeableCount = 0, ackReason = null, approved = false, approvedCount = 0, unapproveOnly = false,
}: {
  period: { start: string; end: string };
  readyCount: number;
  acknowledgeableCount?: number;
  ackReason?: string | null;
  approved?: boolean;
  approvedCount?: number;
  unapproveOnly?: boolean;
}): React.JSX.Element {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; tone: "ok" | "bad" } | null>(null);
  const [ask, confirmDialog] = useConfirm();

  // Strictly-ready workers can be approved with one click. When none are strictly ready but some are held
  // ONLY by the unverified-timesheet gate, the button becomes an explicit "acknowledge + approve".
  const ackOnly = readyCount === 0 && acknowledgeableCount > 0;
  const disabled = busy || (readyCount === 0 && acknowledgeableCount === 0);

  function finalizeText(f: FinalizeResult | undefined): string {
    if (!f) return "";
    const parts: string[] = [];
    if (f.locked) parts.push(`${f.locked} locked in Connecteam`);
    if (f.na) parts.push(`${f.na} had nothing to lock`);
    if (f.failed) parts.push(`${f.failed} Connecteam finalize failed, re-approve to retry`);
    return parts.length ? ` ${parts.join(", ")}.` : "";
  }

  async function run(): Promise<void> {
    const acknowledge = ackOnly;
    const ok = await ask(ackOnly
      ? {
          title: `Approve ${acknowledgeableCount} unverified worker${acknowledgeableCount === 1 ? "" : "s"}?`,
          body: (
            <>
              {ackReason && <p>{ackReason}</p>}
              <p>Their timesheets are not approved in Connecteam. This records that you accepted them and locks their days in Connecteam. It does not submit payroll.</p>
            </>
          ),
          confirmLabel: "Acknowledge and approve",
        }
      : {
          title: `Approve ${readyCount} ready worker${readyCount === 1 ? "" : "s"}?`,
          body: <p>This records the Zoe sign-off and locks each worker&apos;s days in Connecteam. It does not submit payroll in Gusto. Blocked and unverified workers are left out.</p>,
          confirmLabel: "Approve",
        });
    if (!ok) return;
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/payroll/approve", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ start: period.start, end: period.end, acknowledge }),
      });
      const data = (await res.json().catch(() => null)) as { readyCount?: number; error?: string; requiresAck?: boolean; finalize?: FinalizeResult } | null;
      if (!res.ok) {
        setMsg({ text: data?.error ?? "Approval failed.", tone: "bad" });
      } else {
        const fin = finalizeText(data?.finalize);
        setMsg({ text: `Approved ${data?.readyCount ?? readyCount} worker(s).${fin} Payroll is not submitted to Gusto yet.`, tone: data?.finalize?.failed ? "bad" : "ok" });
        router.refresh();
      }
    } catch {
      setMsg({ text: "Approval failed, network error.", tone: "bad" });
    } finally {
      setBusy(false);
    }
  }

  async function unapprove(): Promise<void> {
    const ok = await ask({
      title: "Un-approve payroll for this period?",
      body: <p>This withdraws the Zoe sign-off and unlocks the days in Connecteam. Days inside an approved Connecteam payroll period may stay locked.</p>,
      confirmLabel: "Un-approve",
      tone: "destructive",
    });
    if (!ok) return;
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/payroll/approve", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ start: period.start, end: period.end, action: "unapprove" }),
      });
      const data = (await res.json().catch(() => null)) as { error?: string; unlock?: { unlocked?: number; conflicts?: number } } | null;
      if (!res.ok) {
        setMsg({ text: data?.error ?? "Un-approve failed.", tone: "bad" });
      } else {
        const c = data?.unlock?.conflicts ?? 0;
        setMsg({ text: `Un-approved ${data?.unlock?.unlocked ?? 0} worker(s)${c ? `; ${c} still locked in Connecteam (in an approved payroll period)` : " and unlocked in Connecteam"}.`, tone: c ? "bad" : "ok" });
        router.refresh();
      }
    } catch {
      setMsg({ text: "Un-approve failed, network error.", tone: "bad" });
    } finally {
      setBusy(false);
    }
  }

  const label = ackOnly ? `Acknowledge & approve ${acknowledgeableCount}` : `Approve ${readyCount} ready`;
  const undo = approved && (
    <button
      onClick={unapprove}
      disabled={busy}
      className="inline-flex h-7 items-center gap-1.5 rounded border border-border px-2 text-[11px] text-meta transition-colors hover:bg-[var(--row-hover)] hover:text-secondary-text disabled:opacity-40"
    >
      <RotateCcw className="size-3.5" /> Un-approve{approvedCount ? ` (${approvedCount} locked)` : ""}
    </button>
  );

  if (unapproveOnly) {
    return (
      <div className="flex flex-col items-end gap-1">
        {undo}
        {msg && <span className={`text-[11.5px] ${msg.tone === "ok" ? "text-positive" : "text-critical"}`}>{msg.text}</span>}
        {confirmDialog}
      </div>
    );
  }

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
        {busy ? "Working…" : label}
      </button>
      {undo}
      <span className="max-w-[16rem] text-right text-[11px] leading-snug text-meta">
        Records the Zoe sign-off and finalizes the hours in Connecteam. Does not submit, run, or pay in Gusto.
        {readyCount > 0 && acknowledgeableCount > 0 ? ` ${acknowledgeableCount} unverified excluded.` : ""}
      </span>
      {msg && <span className={`text-[11.5px] ${msg.tone === "ok" ? "text-positive" : "text-critical"}`}>{msg.text}</span>}
      {confirmDialog}
    </div>
  );
}
