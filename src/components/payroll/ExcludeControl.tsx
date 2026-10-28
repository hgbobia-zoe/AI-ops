"use client";

// Exclude a worker from payroll, or re-include them, from the Payroll Review table. Two exclude modes:
// "permanent" (drops them from every run until re-included) and "period" (skips just this pay period). A
// reason is required to exclude, captured in an INLINE field (never a native window.prompt — that blocks the
// tab and reads poorly). Owner/admin only (the API gates it); this is just the trigger + feedback.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Ban, UserPlus, ChevronDown } from "lucide-react";

export interface ExcludeControlProps {
  workerKey: string;
  recordId: string | null;
  connecteamUserId: number | null;
  name: string;
  periodStart: string;
  periodEnd: string;
  excluded?: boolean; // true when this row is already excluded (render "Include")
  excludeMode?: "permanent" | "period";
}

export function ExcludeControl(props: ExcludeControlProps): React.JSX.Element {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<null | "permanent" | "period">(null); // which mode is awaiting a reason
  const [reason, setReason] = useState("");
  const [err, setErr] = useState<string | null>(null);

  function reset(): void {
    setOpen(false);
    setPending(null);
    setReason("");
    setErr(null);
  }

  async function post(body: Record<string, unknown>): Promise<void> {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/payroll/worker/exclude", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      });
      const data = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) setErr(data?.error ?? "Failed.");
      else { reset(); router.refresh(); }
    } catch {
      setErr("Network error.");
    } finally {
      setBusy(false);
    }
  }

  function submit(): void {
    if (!pending) return;
    const r = reason.trim();
    if (!r) { setErr("A reason is required."); return; }
    void post({
      action: "exclude", mode: pending, reason: r,
      recordId: props.recordId ?? undefined, connecteamUserId: props.connecteamUserId ?? undefined,
      workerKey: props.workerKey, name: props.name,
      periodStart: props.periodStart, periodEnd: props.periodEnd,
    });
  }

  function include(): void {
    void post({
      action: "include", mode: props.excludeMode ?? "permanent",
      recordId: props.recordId ?? undefined, connecteamUserId: props.connecteamUserId ?? undefined,
      workerKey: props.workerKey, name: props.name,
      periodStart: props.periodStart, periodEnd: props.periodEnd,
    });
  }

  if (props.excluded) {
    return (
      <div className="flex flex-col items-start gap-0.5">
        <button
          onClick={include}
          disabled={busy}
          className="inline-flex h-7 items-center gap-1.5 rounded border border-border px-2 text-[11.5px] text-secondary-text transition-colors hover:bg-[var(--row-hover)] disabled:opacity-40"
        >
          <UserPlus className="size-3.5" /> {busy ? "…" : "Include"}
        </button>
        {err && <span className="text-[10.5px] text-critical">{err}</span>}
      </div>
    );
  }

  return (
    <div className="relative flex flex-col items-start gap-0.5">
      <button
        onClick={() => (open ? reset() : setOpen(true))}
        disabled={busy}
        className="inline-flex h-7 items-center gap-1 rounded border border-border px-2 text-[11.5px] text-meta transition-colors hover:bg-[var(--row-hover)] hover:text-secondary-text disabled:opacity-40"
      >
        <Ban className="size-3.5" /> {busy ? "…" : "Exclude"} <ChevronDown className="size-3" />
      </button>
      {open && (
        <div className="absolute right-0 top-8 z-10 w-60 overflow-hidden rounded-md border border-border bg-[var(--surface)] shadow-lg">
          {pending === null ? (
            <>
              <button onClick={() => { setPending("period"); setErr(null); }} className="block w-full px-3 py-2 text-left text-[11.5px] text-secondary-text hover:bg-[var(--row-hover)]">
                Skip this period only
              </button>
              <button onClick={() => { setPending("permanent"); setErr(null); }} className="block w-full border-t border-rule px-3 py-2 text-left text-[11.5px] text-secondary-text hover:bg-[var(--row-hover)]">
                Exclude permanently
              </button>
            </>
          ) : (
            <div className="flex flex-col gap-2 p-2.5">
              <span className="text-[11px] leading-snug text-meta">
                {pending === "permanent"
                  ? `Exclude ${props.name} from ALL payroll runs until re-included.`
                  : `Skip ${props.name} for this pay period only.`}
              </span>
              <input
                autoFocus
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") submit(); else if (e.key === "Escape") reset(); }}
                placeholder="Reason (required)"
                className="h-7 rounded border border-border bg-transparent px-2 text-[11.5px] text-secondary-text outline-none focus:border-foreground"
              />
              <div className="flex items-center gap-1.5">
                <button
                  onClick={submit}
                  disabled={busy || !reason.trim()}
                  className="inline-flex h-7 items-center rounded bg-foreground px-2.5 text-[11.5px] font-medium text-[var(--surface)] transition-opacity hover:opacity-90 disabled:opacity-40"
                >
                  {busy ? "…" : "Confirm"}
                </button>
                <button
                  onClick={() => { setPending(null); setReason(""); setErr(null); }}
                  disabled={busy}
                  className="inline-flex h-7 items-center rounded border border-border px-2.5 text-[11.5px] text-meta hover:text-secondary-text disabled:opacity-40"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      )}
      {err && <span className="text-[10.5px] text-critical">{err}</span>}
    </div>
  );
}
