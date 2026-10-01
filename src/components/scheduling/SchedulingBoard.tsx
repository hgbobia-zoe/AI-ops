"use client";

// Scheduling board — the app-owned staffing schedule for a day. Shows the built shifts grouped by role
// (Driver / Field / Prep), each with its headcount, time window (or a "Set time" pill when unknown —
// never a fabricated time), internal coverage and the Instawork top-up. "Build / refresh from routes"
// materializes the day's route demand into draft shifts; a shift opens in the side panel for editing.
//
// Server-rendered figures + date nav live in the page; this component owns the interactions (generate,
// add, edit) and refreshes the server data after any change.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, RefreshCw, Plus, Truck, Users, PackageCheck } from "lucide-react";
import { SidePanelOverlay } from "@/components/SidePanelOverlay";
import { Provenance } from "@/components/console-primitives";
import { ShiftEditor } from "@/components/scheduling/ShiftEditor";
import type { CrewMember } from "@/lib/connecteam";
import { formatClockTime } from "@/lib/dates";
import { shiftGap, type ShiftRole, type StaffShift } from "@/lib/scheduling/types";
import type { ShiftCoverage } from "@/lib/scheduling/coverage";
import type { CrewRecommendation } from "@/lib/scheduling/availability";
import type { InstaworkRoleSummary } from "@/lib/instawork/reconcile";

const BTN = "inline-flex items-center gap-1.5 rounded border border-border px-3 py-1.5 text-[12.5px] text-tertiary-text transition-colors hover:bg-[var(--row-hover)] hover:text-foreground disabled:opacity-50 disabled:pointer-events-none";

const ROLE_META: Record<ShiftRole, { label: string; icon: typeof Truck }> = {
  driver: { label: "Driver", icon: Truck },
  field: { label: "Field", icon: Users },
  prep: { label: "Prep", icon: PackageCheck },
};
const ROLE_ORDER: ShiftRole[] = ["driver", "field", "prep"];

function timeWindow(s: StaffShift): string {
  if (!s.windowKnown || !s.startTime) return "";
  const start = formatClockTime(s.startTime);
  const end = s.endTime ? formatClockTime(s.endTime) : "";
  return end ? `${start} – ${end}` : start;
}

export function SchedulingBoard({
  date,
  shifts,
  roster,
  busyUserIds,
  coverage,
  recommendations,
  instawork,
  hasRoutes,
}: {
  date: string;
  shifts: StaffShift[];
  roster: CrewMember[];
  busyUserIds: number[];
  coverage: Record<string, ShiftCoverage>;
  recommendations: Record<string, CrewRecommendation[]>;
  instawork: Record<ShiftRole, InstaworkRoleSummary> | null;
  hasRoutes: boolean;
}): React.JSX.Element {
  const router = useRouter();
  const [generating, setGenerating] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  // null = closed; "new" = blank add; otherwise the shift being edited.
  const [editing, setEditing] = useState<StaffShift | "new" | null>(null);

  async function generate(): Promise<void> {
    setGenerating(true);
    setNote(null);
    try {
      const res = await fetch("/api/scheduling/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date }),
      });
      const j = (await res.json()) as { shifts?: StaffShift[]; note?: string; error?: string };
      if (!res.ok) setNote("Couldn't build from routes.");
      else if (j.note === "no routes") setNote("No routes for this day — nothing to build.");
      else setNote(`Built ${j.shifts?.length ?? 0} shift${(j.shifts?.length ?? 0) === 1 ? "" : "s"} from routes.`);
      router.refresh();
    } catch {
      setNote("Couldn't build from routes.");
    } finally {
      setGenerating(false);
    }
  }

  return (
    <>
      {/* Toolbar */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <button onClick={generate} disabled={generating} className={BTN + " border-foreground text-foreground"}>
          {generating ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />} Build / refresh from routes
        </button>
        <button onClick={() => setEditing("new")} className={BTN}>
          <Plus className="size-3.5" /> Add shift
        </button>
        {note && <span className="text-[12px] text-meta">{note}</span>}
      </div>

      {!hasRoutes && (
        <p className="mb-4 rounded border border-border bg-[var(--row-hover)]/40 px-3 py-2.5 text-[12.5px] text-tertiary-text">
          No routes for this day — pull routes first, or add a shift manually.
        </p>
      )}

      {shifts.length === 0 ? (
        <p className="text-[13px] text-meta">No shifts built for this day yet.</p>
      ) : (
        <div className="space-y-6">
          {ROLE_ORDER.map((role) => {
            const group = shifts.filter((s) => s.role === role);
            if (group.length === 0) return null;
            const Icon = ROLE_META[role].icon;
            return (
              <section key={role}>
                <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
                  <h2 className="flex items-center gap-1.5 text-[13px] font-medium uppercase tracking-[0.1em] text-tertiary-text">
                    <Icon className="size-3.5" /> {ROLE_META[role].label}
                  </h2>
                  {instawork && instawork[role].total > 0 && (
                    <span className="text-[11.5px] text-meta">
                      Instawork: <span className="text-positive">{instawork[role].booked} booked</span>
                      {instawork[role].pending > 0 && <span className="text-attention"> · {instawork[role].pending} pending</span>}
                    </span>
                  )}
                </div>
                <div className="border border-border">
                  {group.map((s) => {
                    const c = coverage[s.id];
                    const covered = c ? c.covered : s.assignees.length;
                    const gap = c ? c.gap : shiftGap(s);
                    const scheduledNames = c?.scheduledNames ?? [];
                    const win = timeWindow(s);
                    return (
                      <button
                        key={s.id}
                        onClick={() => setEditing(s)}
                        className="flex w-full flex-wrap items-center justify-between gap-3 border-t border-[var(--row-rule)] px-3 py-2.5 text-left transition-colors first:border-t-0 hover:bg-[var(--row-hover)]"
                      >
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-[14px] font-medium text-foreground">{s.eventLabel || ROLE_META[role].label}</span>
                            <span className="text-[12px] tabular-nums text-meta">×{s.headcount}</span>
                            {s.status !== "draft" && <span className="rounded border border-border px-1.5 py-px text-[10px] uppercase tracking-[0.06em] text-meta">{s.status}</span>}
                          </div>
                          <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[12px] text-meta">
                            {win ? (
                              <span className="tabular-nums">{win}</span>
                            ) : (
                              <span className="rounded border border-attention/40 px-1.5 py-px text-[11px] uppercase tracking-[0.05em] text-attention">Set time</span>
                            )}
                            {s.location && <span>{s.location}</span>}
                            {s.source === "derived" ? <Provenance kind="inferred" detail="rules" /> : <span className="text-[12px] text-meta">Manual</span>}
                          </div>
                          {s.reasons.length > 0 && <div className="mt-0.5 text-[11.5px] text-meta">{s.reasons.join(" · ")}</div>}
                          {scheduledNames.length > 0 && (
                            <div className="mt-0.5 text-[11.5px] text-positive">via Connecteam: {scheduledNames.join(", ")}</div>
                          )}
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                          <span className={`text-[13px] tabular-nums ${covered >= s.headcount ? "text-positive" : "text-foreground"}`}>
                            {covered}/{s.headcount}
                          </span>
                          {gap > 0 && <span className="rounded border border-attention/40 px-1.5 py-px text-[11px] text-attention">Instawork: {gap}</span>}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </section>
            );
          })}
        </div>
      )}

      {editing !== null && (
        <SidePanelOverlay onClose={() => setEditing(null)}>
          <ShiftEditor
            shift={editing === "new" ? null : editing}
            date={date}
            roster={roster}
            busyUserIds={busyUserIds}
            recommendations={editing !== "new" && editing ? recommendations[editing.id] ?? [] : []}
            onClose={() => setEditing(null)}
          />
        </SidePanelOverlay>
      )}
    </>
  );
}
