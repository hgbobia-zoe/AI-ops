"use client";

// Scheduling page HEADER actions (doc §13) — Auto Staff (primary), Refresh from routes, Add Shift. Moved
// out of the board toolbar into the page header so the day's verbs sit with the day's title. These REUSE the
// existing workflows unchanged: Auto Staff / Refresh POST /api/scheduling/generate (propose only, never
// commits — the dispatcher approves in the proposed-plan card); Add Shift opens the existing ShiftEditor.
//
// Auto Staff is prominent but NOT styled as destructive or externally-committing (it only proposes a plan).

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, RefreshCw, Plus, Wand2 } from "lucide-react";
import { SidePanelOverlay } from "@/components/SidePanelOverlay";
import { ShiftEditor } from "@/components/scheduling/ShiftEditor";
import type { CrewMember } from "@/lib/connecteam";
import type { WorkerDayEligibilityData } from "@/components/scheduling/RouteStaffBoard";

const BTN =
  "inline-flex items-center gap-1.5 rounded border border-border px-3 py-1.5 text-[12.5px] text-tertiary-text transition-colors hover:bg-[var(--row-hover)] hover:text-foreground disabled:opacity-50 disabled:pointer-events-none";
const PRIMARY =
  "inline-flex items-center gap-1.5 rounded border border-foreground bg-foreground/[0.08] px-3.5 py-1.5 text-[12.5px] font-medium text-foreground transition-colors hover:bg-foreground/[0.14] disabled:opacity-50 disabled:pointer-events-none";

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
      else if (j.note === "no routes") setNote("No routes for this day — nothing to build.");
      else {
        const n = j.shifts?.length ?? 0;
        setNote(`Proposed a plan over ${n} shift${n === 1 ? "" : "s"}. Review and approve below.`);
      }
      router.refresh();
      setTimeout(() => document.getElementById("staffing-plan")?.scrollIntoView({ behavior: "smooth", block: "start" }), 350);
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
          className={PRIMARY}
          title="Build the day's demand from routes and propose the best internal-first plan. Review and approve to commit."
        >
          {generating ? <Loader2 className="size-3.5 animate-spin" /> : <Wand2 className="size-3.5" />} Auto staff
        </button>
        <button onClick={autoStaff} disabled={generating} className={BTN} title="Rebuild demand from the latest routes.">
          <RefreshCw className="size-3.5" /> Refresh from routes
        </button>
        <button onClick={() => setAddingShift(true)} className={BTN}>
          <Plus className="size-3.5" /> Add shift
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
