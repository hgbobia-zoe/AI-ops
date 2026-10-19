"use client";

// Dispatch header action: run the route auto-assign engine on demand for the viewed day. The engine
// (reconcileRouteAutoSyncForDate) normally runs on the runtime tick, but that tick is gated behind an unset
// RUNTIME_TOKEN, so in practice nothing auto-assigns today — this gives the office an explicit trigger.
// It performs REAL app assignments server-side (owner/admin gated at the API), then refreshes the board.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Wand2, Loader2 } from "lucide-react";

interface AutoAssignResult {
  reachable?: boolean;
  autoAssigned?: number;
  seniorityAssigned?: number;
  promptOnly?: number;
  windowsExpanded?: number;
}

export function AutoAssignButton({ date }: { date: string }): React.JSX.Element {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function run(): Promise<void> {
    setBusy(true);
    toast.loading("Auto-assigning crew…", { id: "auto-assign" });
    try {
      const r = await fetch("/api/scheduling/route-auto-assign", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date }),
      });
      if (!r.ok) {
        toast.error("Couldn't run auto-assign. Try again.", { id: "auto-assign" });
        return;
      }
      const res = (await r.json()) as AutoAssignResult;
      if (res.reachable === false) {
        toast.warning("Connecteam unreachable — try again", { id: "auto-assign" });
        return;
      }
      const autoAssigned = res.autoAssigned ?? 0;
      const seniorityAssigned = res.seniorityAssigned ?? 0;
      const promptOnly = res.promptOnly ?? 0;
      const windowsExpanded = res.windowsExpanded ?? 0;
      toast.success(
        `Auto-assigned ${autoAssigned} (${seniorityAssigned} by seniority), ${promptOnly} still need a pick${windowsExpanded ? `, ${windowsExpanded} shift(s) adjusted to the route` : ""}`,
        { id: "auto-assign" },
      );
      router.refresh();
    } catch {
      toast.error("Couldn't run auto-assign. Try again.", { id: "auto-assign" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      onClick={run}
      disabled={busy}
      title="Run the route auto-assign engine for this day now"
      className="inline-flex items-center gap-1.5 rounded border border-border px-3 py-1.5 text-[12.5px] text-tertiary-text transition-colors hover:bg-[var(--row-hover)] hover:text-foreground disabled:opacity-50 disabled:pointer-events-none"
    >
      {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Wand2 className="size-3.5" />} Auto-assign crew
    </button>
  );
}
