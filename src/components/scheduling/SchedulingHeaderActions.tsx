"use client";

// Scheduling toolbar actions, right side of the schedule toolbar (Connecteam style: Add is the one filled
// button, everything else is secondary). These REUSE the existing workflows unchanged:
//   Add shift      → the existing ShiftEditor (the daily job, so it is the primary button).
//   Auto staff     → POST /api/scheduling/generate. Proposes only, never commits: the dispatcher approves in
//                    the proposed plan card (By route view, which this reveals).
//   Refresh routes → the same rebuild from the latest routes.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, RefreshCw, Plus, Wand2 } from "lucide-react";
import { revealTarget } from "@/components/scheduling/reveal";
import { SidePanelOverlay } from "@/components/SidePanelOverlay";
import { ShiftEditor } from "@/components/scheduling/ShiftEditor";
import type { CrewMember } from "@/lib/connecteam";
import type { WorkerDayEligibilityData } from "@/components/scheduling/RouteStaffBoard";

const BTN =
  "inline-flex items-center gap-1.5 rounded border border-border px-3 py-1.5 text-[12.5px] text-tertiary-text transition-colors hover:bg-[var(--row-hover)] hover:text-foreground disabled:opacity-50 disabled:pointer-events-none";
const PRIMARY =
  "inline-flex items-center gap-1.5 rounded border border-foreground bg-foreground px-3.5 py-1.5 text-[13px] font-medium text-background transition-opacity hover:opacity-85 disabled:opacity-50 disabled:pointer-events-none";

export function SchedulingHeaderActions({
  date,
  roster,
  eligibilityData,
}: {
  date: string;
  roster: CrewMember[];
  eligibilityData: WorkerDayEligibilityData;
}): React.JSX.Element {
  const router = useRouter();
  const [generating, setGenerating] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [addingShift, setAddingShift] = useState(false);

  // AUTO STAFF (propose): rebuild demand from routes, then let the server recompute + render the proposed
  // optimizer plan. PROPOSES only; committing is the dispatcher's explicit Approve in the plan card below.
  async function autoStaff(): Promise<void> {
    setGenerating(true);
    setNote(null);
    try {
      const res = await fetch("/api/scheduling/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date }),
      });
      const j = (await res.json()) as { shifts?: unknown[]; note?: string };
      if (!res.ok) setNote("Couldn't build the plan from routes.");
      else if (j.note === "no routes") setNote("No routes for this day, so there is nothing to staff.");
      else {
        const n = j.shifts?.length ?? 0;
        setNote(`Suggested crew for ${n} shift${n === 1 ? "" : "s"}. Review and approve it under By route.`);
      }
      router.refresh();
      setTimeout(() => revealTarget("staffing-plan"), 350);
    } catch {
      setNote("Couldn't build the plan from routes.");
    } finally {
      setGenerating(false);
    }
  }

  return (
    <>
      <div className="flex flex-wrap items-center justify-end gap-2">
        {note && <span className="mr-1 max-w-[18rem] text-right text-[12px] text-meta">{note}</span>}
        <button
          onClick={autoStaff}
          disabled={generating}
          className={BTN}
          title="Suggest crew for the day's routes. Nothing is saved until you approve it."
        >
          {generating ? <Loader2 className="size-3.5 animate-spin" /> : <Wand2 className="size-3.5" />} Auto staff
        </button>
        <button onClick={autoStaff} disabled={generating} className={BTN} title="Rebuild the day's shifts from the latest routes.">
          <RefreshCw className="size-3.5" /> Refresh from routes
        </button>
        <button onClick={() => setAddingShift(true)} className={PRIMARY}>
          <Plus className="size-4" /> Add shift
        </button>
      </div>

      {addingShift && (
        <SidePanelOverlay onClose={() => setAddingShift(false)}>
          <ShiftEditor shift={null} date={date} roster={roster} eligibilityData={eligibilityData} recommendations={[]} onClose={() => setAddingShift(false)} />
        </SidePanelOverlay>
      )}
    </>
  );
}
