"use client";

// Week schedule, laid out like the Connecteam Job Scheduler week the office already uses: people down the
// side, Monday to Sunday across, each day's shifts and unavailability as cards, the day's hours, shifts and
// people in its header, and a weekly summary at the bottom. Same colors as the Day schedule.
//
//   Click a Dispatch shift card   → edit it right here (the same ShiftEditor as the Day schedule).
//   Click an empty spot in a day  → Add shift for that person and day (Unassigned row: nobody yet).
//   Click a day header, a Connecteam-only card or unavailability → that day's Day schedule.
//
// The model is src/lib/scheduling/weekGrid.ts (built from the same day model as the Day schedule).

import Link from "next/link";
import { useMemo, useState } from "react";
import { Clock, Layers, Plus, Search, Users } from "lucide-react";
import { SidePanelOverlay } from "@/components/SidePanelOverlay";
import { ShiftEditor, type NewShiftPrefill } from "@/components/scheduling/ShiftEditor";
import type { WorkerDayEligibilityData } from "@/components/scheduling/RouteStaffBoard";
import type { CrewMember } from "@/lib/connecteam";
import type { RouteOption } from "@/lib/scheduling/routeOptions";
import type { StaffShift } from "@/lib/scheduling/types";
import type { WeekCard, WeekGrid } from "@/lib/scheduling/weekGrid";
import { hoursLabel } from "@/lib/scheduling/weekGrid";

/** What the shift editor needs for one day of the week (same inputs the Day schedule gives it). */
export interface WeekEditDay {
  eligibilityData: WorkerDayEligibilityData;
  routeOptions: RouteOption[];
}

const NAME_COL = "w-[220px] min-w-[220px]";

function cardClass(c: WeekCard): string {
  if (c.kind === "unavailable") return "bg-unavailable text-on-fill";
  if (c.kind === "connecteam") return "bg-foreground text-background";
  return c.published ? "bg-shift text-on-fill" : "border border-dashed border-on-fill/70 bg-shift-open text-on-fill";
}

function Card({ c, href, onEdit }: { c: WeekCard; href: string; onEdit?: () => void }): React.JSX.Element {
  const unavailable = c.kind === "unavailable";
  const tip = `${c.title}, ${c.timeLabel}${c.override ? ". Override: not the route time" : ""}${c.kind === "app" && !c.published ? ". Not in Connecteam yet" : ""}${c.kind === "connecteam" ? ". Entered in Connecteam" : ""}`;
  const cls = `block w-full rounded px-2 py-1 text-left transition-opacity hover:opacity-85 ${cardClass(c)} ${unavailable ? "text-center" : ""}`;
  const body = (
    <>
      <div className="flex items-center justify-between gap-1 text-[11.5px] font-semibold leading-tight">
        <span className="truncate">{unavailable ? c.title : c.timeLabel}</span>
        {c.override && <span className="shrink-0 rounded-sm bg-background/80 px-1 text-[9px] font-semibold uppercase tracking-[0.04em] text-attention">Override</span>}
        {c.total != null && <span className="shrink-0 tabular-nums">{c.filled}/{c.total}</span>}
      </div>
      <div className="truncate text-[11px] font-medium leading-tight">{unavailable ? c.timeLabel : c.title}</div>
    </>
  );
  if (onEdit) {
    return (
      <button type="button" data-card onClick={onEdit} title={`${tip}. Click to edit`} className={cls}>
        {body}
      </button>
    );
  }
  return (
    <Link href={href} data-card title={`${tip}. Open the day`} className={cls}>
      {body}
    </Link>
  );
}

export function WeekSchedule({
  grid,
  shifts = [],
  roster = [],
  editDays = {},
}: {
  grid: WeekGrid;
  /** The week's Dispatch shifts, so a card opens its shift in the editor. */
  shifts?: StaffShift[];
  roster?: CrewMember[];
  editDays?: Record<string, WeekEditDay>;
}): React.JSX.Element {
  const [query, setQuery] = useState("");
  const [workingOnly, setWorkingOnly] = useState(false);
  const [editing, setEditing] = useState<StaffShift | null>(null);
  const [adding, setAdding] = useState<{ date: string; prefill: NewShiftPrefill } | null>(null);
  const dayHref = (d: string): string => `/scheduling?date=${d}`;
  const shiftById = (id: string | undefined): StaffShift | null => (id ? shifts.find((s) => s.id === id) ?? null : null);
  const editFor = (c: WeekCard): (() => void) | undefined => {
    const s = c.kind === "app" ? shiftById(c.shiftId) : null;
    return s && editDays[s.date] ? () => setEditing(s) : undefined;
  };
  // Click on an empty part of a day: Add shift. Owner rule: shifts match the route, so with exactly one
  // route that day the form opens on it (its time comes from the route); otherwise the editor asks for it.
  const addOn = (e: React.MouseEvent<HTMLDivElement>, date: string, assignees: number[]): void => {
    if ((e.target as HTMLElement).closest("[data-card]") || !editDays[date]) return;
    const routes = editDays[date].routeOptions;
    setAdding({ date, prefill: { assignees, routeId: routes.length === 1 ? routes[0].routeId : null } });
  };

  const people = useMemo(() => {
    const q = query.trim().toLowerCase();
    return grid.people.filter((p) => (!q || p.name.toLowerCase().includes(q)) && (!workingOnly || p.shiftCount > 0));
  }, [grid.people, query, workingOnly]);

  const cols = `${grid.days.length}`;
  return (
    <div>
      <div className="overflow-x-auto">
        <div className="min-w-[1100px]">
          {/* Header: search + the seven days with their totals */}
          <div className="flex border-b border-border">
            <div className={`${NAME_COL} flex items-center gap-2 border-r border-border px-3 py-2`}>
              <label className="flex min-w-0 flex-1 items-center gap-1.5 rounded-full border border-border px-2.5 py-1">
                <Search className="size-3.5 shrink-0 text-meta" aria-hidden />
                <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search people" aria-label="Search people" className="min-w-0 flex-1 bg-transparent text-[12.5px] outline-none placeholder:text-meta" />
              </label>
              <button
                type="button"
                onClick={() => setWorkingOnly((v) => !v)}
                aria-pressed={workingOnly}
                title={workingOnly ? "Show everyone" : "Show only people working this week"}
                className={`rounded-full border px-2 py-1 text-[11px] transition-colors ${workingOnly ? "border-foreground text-foreground" : "border-border text-meta hover:text-foreground"}`}
              >
                {workingOnly ? "Working" : "Everyone"}
              </button>
            </div>
            <div className="grid flex-1" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
              {grid.days.map((d) => (
                <Link key={d.date} href={dayHref(d.date)} title={`Open ${d.label}`} className="border-l border-[var(--row-rule)] px-2 py-2 text-center transition-colors hover:bg-[var(--row-hover)]">
                  <div className="text-[13px]">
                    <span className={d.isToday ? "rounded-full bg-shift px-2 py-0.5 font-medium text-on-fill" : "text-foreground"}>{d.label}</span>
                  </div>
                  <div className="mt-1 flex items-center justify-center gap-2.5 text-[11px] tabular-nums text-meta">
                    <span className="inline-flex items-center gap-1" title="Scheduled hours"><Clock className="size-3" aria-hidden />{hoursLabel(d.hours)}</span>
                    <span className="inline-flex items-center gap-1" title="Shifts"><Layers className="size-3" aria-hidden />{d.shifts}</span>
                    <span className="inline-flex items-center gap-1" title="People working"><Users className="size-3" aria-hidden />{d.people}</span>
                  </div>
                </Link>
              ))}
            </div>
          </div>

          {/* Unassigned shifts */}
          <div className="flex border-b border-border bg-[var(--row-hover)]/30">
            <div className={`${NAME_COL} flex items-center border-r border-border px-3 py-2 text-[13px] font-medium`}>Unassigned shifts</div>
            <div className="grid flex-1" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
              {grid.days.map((d) => (
                <div key={d.date} onClick={(e) => addOn(e, d.date, [])} title="Click an empty spot to add a shift this day" className="group/cell min-h-[40px] cursor-copy space-y-1 border-l border-[var(--row-rule)] p-1.5">
                  {(grid.unassigned[d.date] ?? []).map((c) => <Card key={c.id} c={c} href={dayHref(d.date)} onEdit={editFor(c)} />)}
                  <Plus className="pointer-events-none mx-auto size-3.5 text-meta opacity-0 transition-opacity group-hover/cell:opacity-60" aria-hidden />
                </div>
              ))}
            </div>
          </div>

          {/* People */}
          {people.map((r) => (
            <div key={r.userId} className="flex border-b border-[var(--row-rule)]">
              <div className={`${NAME_COL} flex items-center gap-2.5 border-r border-border px-3 py-1.5`}>
                <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-foreground/10 text-[11px] font-semibold text-foreground">{r.initials}</span>
                <div className="min-w-0">
                  <div className="truncate text-[13px] text-foreground" title={r.title ? `${r.name}, ${r.title}` : r.name}>{r.name}</div>
                  <div className="flex items-center gap-2.5 text-[11px] text-meta">
                    <span className="inline-flex items-center gap-1 tabular-nums" title="Scheduled hours this week"><Clock className="size-3" aria-hidden />{r.hours > 0 ? hoursLabel(r.hours) : "--"}</span>
                    <span className="inline-flex items-center gap-1 tabular-nums" title="Shifts this week"><Layers className="size-3" aria-hidden />{r.shiftCount}</span>
                  </div>
                </div>
              </div>
              <div className="grid flex-1" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
                {grid.days.map((d) => (
                  <div
                    key={d.date}
                    onClick={(e) => addOn(e, d.date, [r.userId])}
                    title={`Click an empty spot to add a shift for ${r.name} on ${d.label}`}
                    className={`group/cell min-h-[52px] cursor-copy space-y-1 border-l border-[var(--row-rule)] p-1.5 ${d.isToday ? "bg-shift/[0.04]" : ""}`}
                  >
                    {(r.cells[d.date] ?? []).map((c) => <Card key={c.id} c={c} href={dayHref(d.date)} onEdit={editFor(c)} />)}
                    <Plus className="pointer-events-none mx-auto size-3.5 text-meta opacity-0 transition-opacity group-hover/cell:opacity-60" aria-hidden />
                  </div>
                ))}
              </div>
            </div>
          ))}
          {people.length === 0 && <p className="px-4 py-6 text-[13px] text-meta">{query ? "Nobody matches that search." : "Nobody is working this week yet."}</p>}
        </div>
      </div>

      {/* Weekly summary, like Connecteam's footer */}
      <div className="flex flex-wrap items-center gap-2 border-t border-border px-4 py-2.5 text-[12.5px]">
        <span className="mr-2 font-medium text-foreground">Weekly summary</span>
        <span className="inline-flex items-center gap-1.5 rounded border border-border px-2 py-1"><Clock className="size-3.5 text-meta" aria-hidden />Hours <span className="font-medium tabular-nums">{hoursLabel(grid.summary.hours)}</span></span>
        <span className="inline-flex items-center gap-1.5 rounded border border-border px-2 py-1"><Layers className="size-3.5 text-meta" aria-hidden />Shifts <span className="font-medium tabular-nums">{grid.summary.shifts}</span></span>
        <span className="inline-flex items-center gap-1.5 rounded border border-border px-2 py-1"><Users className="size-3.5 text-meta" aria-hidden />People <span className="font-medium tabular-nums">{grid.summary.people}</span></span>
        <span className="ml-auto flex flex-wrap items-center gap-x-4 gap-y-1 text-[11.5px] text-meta">
          <span className="inline-flex items-center gap-1.5"><span className="inline-block h-2.5 w-4 rounded-sm bg-shift" />Dispatch shift, in Connecteam</span>
          <span className="inline-flex items-center gap-1.5"><span className="inline-block h-2.5 w-4 rounded-sm border border-dashed border-on-fill/70 bg-shift-open" />Not in Connecteam yet</span>
          <span className="inline-flex items-center gap-1.5"><span className="inline-block h-2.5 w-4 rounded-sm bg-foreground" />Entered in Connecteam</span>
          <span className="inline-flex items-center gap-1.5"><span className="inline-block h-2.5 w-4 rounded-sm bg-unavailable" />Unavailable or time off</span>
        </span>
      </div>

      {editing && editDays[editing.date] && (
        <SidePanelOverlay onClose={() => setEditing(null)}>
          <ShiftEditor
            shift={editing}
            date={editing.date}
            roster={roster}
            eligibilityData={editDays[editing.date].eligibilityData}
            recommendations={[]}
            routeOptions={editDays[editing.date].routeOptions}
            onClose={() => setEditing(null)}
          />
        </SidePanelOverlay>
      )}
      {adding && editDays[adding.date] && (
        <SidePanelOverlay onClose={() => setAdding(null)}>
          <ShiftEditor
            shift={null}
            date={adding.date}
            roster={roster}
            eligibilityData={editDays[adding.date].eligibilityData}
            recommendations={[]}
            prefill={adding.prefill}
            routeOptions={editDays[adding.date].routeOptions}
            onClose={() => setAdding(null)}
          />
        </SidePanelOverlay>
      )}
    </div>
  );
}
