"use client";

// The exception engine's open follow-ups, with a way for a person to close one. Each row shows what the
// problem is, its state, who owns it and what should happen next. "Close" asks for a reason and whether
// it was fixed or set aside, then records the signed-in person. Nothing closes without a reason.

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { StatusBadge } from "@/components/ui/status";
import { Button } from "@/components/ui/button";
import type { Tone } from "@/lib/tone";

export interface FollowUpRow {
  key: string;
  source: string;
  status: string;
  severity: string;
  title: string;
  detail: string | null;
  nextAction: string | null;
  assignedRole: string | null;
  escalationTier: string;
  firstDetectedAt: string;
  lastSeenAt: string;
}

const STATUS_LABEL: Record<string, string> = {
  active: "New",
  delegated: "With the team",
  awaiting_approval: "Awaiting approval",
  acting: "Sending",
  failed: "Failed",
  escalated: "Escalated",
  unverifiable: "Needs a check",
};

const STATUS_TONE: Record<string, Tone> = {
  active: "neutral",
  delegated: "info",
  awaiting_approval: "info",
  acting: "info",
  failed: "critical",
  escalated: "attention",
  unverifiable: "attention",
};

const SOURCE_LABEL: Record<string, string> = { risk: "Event Risk", dead_letter: "Write-back" };

function shortDate(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/New_York" });
}

function Row({ row }: { row: FollowUpRow }): React.JSX.Element {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [as, setAs] = useState<"resolved" | "disposed">("resolved");
  const [reason, setReason] = useState("");
  const [state, setState] = useState<{ busy: boolean; error?: string }>({ busy: false });

  const submit = async (): Promise<void> => {
    setState({ busy: true });
    try {
      const res = await fetch("/api/exceptions/dispose", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key: row.key, as, reason }),
      });
      const j = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !j.ok) {
        setState({ busy: false, error: j.error ?? "Could not close it." });
        return;
      }
      setOpen(false);
      router.refresh();
    } catch {
      setState({ busy: false, error: "Could not reach the server." });
    }
  };

  // In-flight items are governed by their approval; closing them here would skip that record.
  const inFlight = row.status === "awaiting_approval" || row.status === "acting";

  return (
    <div className="border-t border-[var(--row-rule)] px-3 py-3 first:border-t-0">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-[13.5px] font-medium text-foreground">{row.title}</div>
          {row.nextAction ? <div className="mt-0.5 text-[12.5px] text-meta">{row.nextAction}</div> : null}
          <div className="mt-1 flex flex-wrap gap-x-3 text-[11.5px] text-meta">
            <span>{SOURCE_LABEL[row.source] ?? row.source}</span>
            <span className="capitalize">{row.severity}</span>
            {row.assignedRole ? <span>Owner: {row.assignedRole}</span> : null}
            {row.escalationTier !== "none" ? <span>Escalated to {row.escalationTier}</span> : null}
            <span>Since {shortDate(row.firstDetectedAt)}</span>
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-2">
          <StatusBadge tone={STATUS_TONE[row.status] ?? "neutral"} size="sm">
            {STATUS_LABEL[row.status] ?? row.status}
          </StatusBadge>
          {inFlight ? (
            <Link href="/ai-org/approvals" className="text-[12px] text-muted-foreground underline-offset-4 hover:underline">
              Open approval
            </Link>
          ) : !open ? (
            <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
              Close
            </Button>
          ) : null}
        </div>
      </div>

      {open ? (
        <div className="mt-3 space-y-2 border-l-2 border-border pl-3">
          <div className="flex flex-wrap gap-4 text-[12.5px]">
            <label className="flex items-center gap-1.5">
              <input type="radio" name={`as-${row.key}`} checked={as === "resolved"} onChange={() => setAs("resolved")} />
              It was fixed
            </label>
            <label className="flex items-center gap-1.5">
              <input type="radio" name={`as-${row.key}`} checked={as === "disposed"} onChange={() => setAs("disposed")} />
              Set aside (no longer needed, duplicate, won&apos;t fix)
            </label>
          </div>
          <input
            type="text"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="What happened? This goes on the record."
            className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-[13px]"
            maxLength={500}
          />
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={submit} disabled={state.busy || reason.trim().length < 3}>
              {state.busy ? "Closing" : "Close it"}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setOpen(false)} disabled={state.busy}>
              Cancel
            </Button>
            {state.error ? <span className="text-[12px] text-critical">{state.error}</span> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function ExceptionFollowUps({ rows }: { rows: FollowUpRow[] }): React.JSX.Element {
  if (rows.length === 0) {
    return <p className="border border-border px-3 py-3 text-[13px] text-positive">No open follow-ups. Every exception the engine tracked is closed.</p>;
  }
  return (
    <div className="border border-border">
      {rows.map((r) => (
        <Row key={r.key} row={r} />
      ))}
    </div>
  );
}
