"use client";

// Apply the optimizer's plan (Opt-Phase C). Owner/admin only (the API re-checks); confirm-gated here.
// The server RECOMPUTES from current state, so what applies is always the live plan, and it writes only
// the internal picks + records temp seats (no Instawork post). Disabled when there is nothing to improve.
//
// Comms style: no em-dashes, no emoji.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";

export function ApplyPlanButton({ date, enabled }: { date: string; enabled: boolean }): React.JSX.Element {
  const router = useRouter();
  const [working, setWorking] = useState(false);

  async function apply(): Promise<void> {
    if (!window.confirm("Apply the optimized plan? Internal crew are reassigned to the recommended routes. Temp seats are recorded as a recommendation only (nothing is posted to Instawork).")) return;
    setWorking(true);
    try {
      const res = await fetch("/api/scheduling/optimize/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date }),
      });
      const j = (await res.json().catch(() => null)) as
        | { ok?: boolean; applied?: boolean; alreadyOptimal?: boolean; internalPlaced?: number; tempRecorded?: number; note?: string; error?: string }
        | null;
      if (!res.ok || !j?.ok) {
        toast.error(j?.error === "forbidden" ? "Only an owner or admin can apply a plan." : "Couldn't apply the plan. Try again.");
        return;
      }
      if (!j.applied) {
        toast.message(j.note || "Current staffing is already optimal.");
      } else {
        toast.success(`Applied: ${j.internalPlaced ?? 0} internal placed${j.tempRecorded ? `, ${j.tempRecorded} temp seat(s) recorded` : ""}.`);
      }
      router.refresh();
    } catch {
      toast.error("Couldn't apply the plan. Try again.");
    } finally {
      setWorking(false);
    }
  }

  return (
    <button
      type="button"
      onClick={apply}
      disabled={!enabled || working}
      title={enabled ? "Reassign internal crew to the recommended routes and record the temp recommendation." : "Current staffing is already optimal."}
      className="inline-flex items-center gap-1.5 rounded border border-foreground px-3 py-1.5 text-[12px] text-foreground transition-colors hover:bg-foreground/[0.08] disabled:cursor-not-allowed disabled:border-border disabled:text-meta disabled:opacity-60"
    >
      {working && <Loader2 className="size-3.5 animate-spin" />}
      {enabled ? "Apply plan" : "Already optimal"}
    </button>
  );
}
