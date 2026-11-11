"use client";

// Goodshuffle write-backs that will not land on their own: failed after every retry, or stuck in the
// queue with nothing sending them. Each row says what it was and why it stopped. A manager can dismiss
// one with a reason (it never retries and stops counting toward the alarm). To still make the change,
// redo it in the app first (for example push the delivery fee again), then dismiss the old one.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { StatusBadge } from "@/components/ui/status";
import { Button } from "@/components/ui/button";

export interface NeedsPersonRow {
  id: string;
  kind: string; // plain label of the op type, e.g. "Delivery fee set"
  label: string | null;
  state: "failed" | "stuck";
  since: string; // ISO created_at
  lastError: string | null;
}

function shortDate(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/New_York" });
}

function Row({ row, canDismiss }: { row: NeedsPersonRow; canDismiss: boolean }): React.JSX.Element {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [state, setState] = useState<{ busy: boolean; error?: string }>({ busy: false });

  const submit = async (): Promise<void> => {
    setState({ busy: true });
    try {
      const res = await fetch("/api/automation/writebacks/dismiss", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: row.id, reason }),
      });
      const j = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !j.ok) {
        setState({ busy: false, error: j.error ?? "Could not dismiss it." });
        return;
      }
      setOpen(false);
      router.refresh();
    } catch {
      setState({ busy: false, error: "Could not reach the server." });
    }
  };

  return (
    <li className="border-b border-rule/60 px-3 py-2.5 last:border-0">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-[13px] text-foreground">{row.label || row.kind}</div>
          <div className="mt-0.5 flex flex-wrap gap-x-3 text-[11.5px] text-meta">
            <span>{row.kind}</span>
            <span>Queued {shortDate(row.since)}</span>
            {row.lastError ? <span className="truncate">Last error: {row.lastError}</span> : null}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <StatusBadge tone={row.state === "failed" ? "critical" : "attention"} size="sm">
            {row.state === "failed" ? "Failed" : "Stuck"}
          </StatusBadge>
          {canDismiss && !open ? (
            <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
              Dismiss
            </Button>
          ) : null}
        </div>
      </div>
      {open ? (
        <div className="mt-2 space-y-2 border-l-2 border-border pl-3">
          <input
            type="text"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Why is it no longer needed? This goes on the record."
            className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-[13px]"
            maxLength={500}
          />
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={submit} disabled={state.busy || reason.trim().length < 3}>
              {state.busy ? "Dismissing" : "Dismiss it"}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setOpen(false)} disabled={state.busy}>
              Cancel
            </Button>
            {state.error ? <span className="text-[12px] text-critical">{state.error}</span> : null}
          </div>
        </div>
      ) : null}
    </li>
  );
}

export function WriteBacksNeedingPerson({ rows, canDismiss }: { rows: NeedsPersonRow[]; canDismiss: boolean }): React.JSX.Element | null {
  if (rows.length === 0) return null;
  return (
    <ul className="border-t border-rule">
      <li className="px-3 pt-2 text-[10.5px] uppercase tracking-[0.06em] text-meta">Need a person</li>
      <li className="px-3 pb-1 text-[12px] text-secondary-text">
        These will not land on their own. If the change is still needed, redo it in the app first, then dismiss the old one.
      </li>
      {rows.map((r) => (
        <Row key={r.id} row={r} canDismiss={canDismiss} />
      ))}
    </ul>
  );
}
