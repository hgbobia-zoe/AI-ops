"use client";

// Day schedule grid, shaped like the Connecteam Job Scheduler so the office feels at home: an
// "Unassigned shifts" row, then one row per person (initials, name, hours, shift count), hours across the
// top, shifts as bars and unavailability as a shaded block.
//
//   Click a Dispatch shift bar        → edit that shift (assign people, times, publish to Connecteam).
//   Click an empty spot on a row      → Add shift, prefilled with that person and hour.
//   Click an empty spot on Unassigned → Add shift at that hour.
//
// Connecteam shifts that were entered directly in Connecteam are shown for reference (dark bars) and are
// edited in Connecteam. Everything here reuses the existing ShiftEditor and save paths.

import { useMemo, useState } from "react";
import { Clock, Layers, Search, UserPlus } from "lucide-react";
import { SidePanelOverlay } from "@/components/SidePanelOverlay";
import { ShiftEditor, type NewShiftPrefill } from "@/components/scheduling/ShiftEditor";
import type { CrewMember } from "@/lib/connecteam";
import type { CrewRecommendation } from "@/lib/scheduling/availability";
import type { StaffShift } from "@/lib/scheduling/types";
import { opsWallTimeToMs } from "@/lib/dates";
import { routeNearest, type RouteOption } from "@/lib/scheduling/routeOptions";
import type { WorkerDayEligibilityData } from "@/components/scheduling/RouteStaffBoard";
import type { DayTimeline as Timeline, TimelineBar } from "@/lib/scheduling/dayTimeline";

const LANE_H = 40;
const ROW_PAD = 8;
const NAME_COL = "w-[260px] min-w-[260px]";

function hourLabel(h: number): string {
  if (h === 0 || h === 24) return "12am";
  if (h === 12) return "12pm";
  return h < 12 ? `${h}am` : `${h - 12}pm`;
}

function fmtHours(h: number): string {
  if (h <= 0) return "0";
  const whole = Math.floor(h);
  const min = Math.round((h - whole) * 60);
  return `${String(whole).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

function barClass(b: TimelineBar): string {
  if (b.kind === "unavailable") return "bg-status-blocked/10 text-status-blocked border border-status-blocked/20";
  if (b.kind === "connecteam") return "bg-foreground text-background";
  return b.published ? "bg-info text-background" : "border border-dashed border-info bg-info/15 text-foreground";
}

export function DayTimeline({
  timeline,
  date,
  shifts,
  routeOptions,
  roster,
  eligibilityData,
  recommendations,
}: {
  timeline: Timeline;
  date: string;
  shifts: StaffShift[];
  routeOptions: RouteOption[];
  roster: CrewMember[];
  eligibilityData: WorkerDayEligibilityData;
  recommendations: Record<string, CrewRecommendation[]>;
}): React.JSX.Element {
  const [query, setQuery] = useState("");
  const [workingOnly, setWorkingOnly] = useState(false);
  const [editing, setEditing] = useState<StaffShift | null>(null);
  const [adding, setAdding] = useState<NewShiftPrefill | null>(null);

  const { startHour, endHour } = timeline;
  const spanMin = (endHour - startHour) * 60;
  const hours = useMemo(() => Array.from({ length: endHour - startHour }, (_, i) => startHour + i), [startHour, endHour]);
  const pos = (b: TimelineBar): React.CSSProperties => {
    const s = Math.max(b.startMin, startHour * 60);
    const e = Math.min(b.endMin, endHour * 60);
    return {
      left: `${((s - startHour * 60) / spanMin) * 100}%`,
      width: `max(${((e - s) / spanMin) * 100}%, 28px)`,
      top: ROW_PAD / 2 + b.lane * LANE_H,
      height: LANE_H - 6,
    };
  };

  const people = timeline.people.filter((r) => {
    if (workingOnly && r.shiftCount === 0) return false;
    const q = query.trim().toLowerCase();
    return !q || r.name.toLowerCase().includes(q) || (r.title ?? "").toLowerCase().includes(q);
  });

  const shiftById = (id: string | undefined): StaffShift | null => (id ? shifts.find((s) => s.id === id) ?? null : null);

  // Tap on an empty part of a row → Add shift for that person. Owner rule: shifts match the route, so the
  // tapped column never invents a time. On a day with routes the form opens on the route nearest the tap
  // (its time comes from the route); with no routes the times start blank for the person to pick.
  function addAt(e: React.MouseEvent<HTMLDivElement>, assignees: number[]): void {
    if ((e.target as HTMLElement).closest("[data-bar]")) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    const minutes = (startHour + frac * (endHour - startHour)) * 60;
    const tapMs = opsWallTimeToMs(date, Math.floor(minutes / 60), Math.floor(minutes % 60));
    const route = routeNearest(routeOptions, tapMs);
    setAdding({ assignees, routeId: route?.routeId ?? null });
  }

  const grid = (
    <div className="pointer-events-none absolute inset-0 flex" aria-hidden>
      {hours.map((h) => (
        <div key={h} className="flex-1 border-l border-dashed border-[var(--row-rule)]" />
      ))}
    </div>
  );

  const renderBar = (b: TimelineBar): React.JSX.Element => {
    const shift = b.kind === "app" ? shiftById(b.shiftId) : null;
    const body = (
      <>
        <div className="flex items-center justify-between gap-1 text-[11.5px] font-semibold leading-tight">
          <span className="truncate">{b.allDay ? b.title : b.timeLabel}</span>
          {b.override && <span className="shrink-0 rounded-sm bg-background/80 px-1 text-[9.5px] font-semibold uppercase tracking-[0.04em] text-attention">Override</span>}
          {b.total != null && <span className="shrink-0 tabular-nums opacity-80">{b.filled}/{b.total}</span>}
        </div>
        <div className="truncate text-[11px] leading-tight opacity-90">{b.allDay ? "All day" : b.title}</div>
      </>
    );
    const cls = `absolute overflow-hidden rounded px-2 py-1 text-left ${barClass(b)} ${b.kind === "unavailable" ? "text-center" : ""}`;
    const tip = `${b.title}, ${b.timeLabel}${b.override ? ". Override: not the route time" : ""}${b.kind === "app" && !b.published ? ". Not in Connecteam yet" : ""}${b.kind === "connecteam" ? ". Entered in Connecteam" : ""}`;
    if (shift) {
      return (
        <button key={b.id} type="button" data-bar style={pos(b)} className={`${cls} transition-opacity hover:opacity-85`} title={`${tip}. Click to edit`} onClick={() => setEditing(shift)}>
          {body}
        </button>
      );
    }
    return (
      <div key={b.id} data-bar style={pos(b)} className={cls} title={tip}>
        {body}
      </div>
    );
  };

  return (
    <div>
      <div className="overflow-x-auto">
        <div className="min-w-[1000px]">
          {/* Header: people search + hour scale */}
          <div className="flex border-b border-border">
            <div className={`${NAME_COL} flex items-center gap-2 border-r border-border px-3 py-2`}>
              <label className="flex min-w-0 flex-1 items-center gap-1.5 rounded-full border border-border px-2.5 py-1">
                <Search className="size-3.5 shrink-0 text-meta" aria-hidden />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search people"
                  aria-label="Search people"
                  className="min-w-0 flex-1 bg-transparent text-[12.5px] outline-none placeholder:text-meta"
                />
              </label>
              <button
                type="button"
                onClick={() => setWorkingOnly((v) => !v)}
                aria-pressed={workingOnly}
                title={workingOnly ? "Show everyone" : "Show only people working this day"}
                className={`rounded-full border px-2 py-1 text-[11px] transition-colors ${workingOnly ? "border-foreground text-foreground" : "border-border text-meta hover:text-foreground"}`}
              >
                {workingOnly ? "Working" : "Everyone"}
              </button>
            </div>
            <div className="flex flex-1">
              {hours.map((h) => (
                <div key={h} className="flex-1 border-l border-[var(--row-rule)] py-2 text-center text-[12px] text-meta">
                  {hourLabel(h)}
                </div>
              ))}
            </div>
          </div>

          {/* Unassigned shifts */}
          <div className="flex border-b border-border bg-[var(--row-hover)]/30">
            <div className={`${NAME_COL} flex items-center border-r border-border px-3 text-[13px] font-medium`}>Unassigned shifts</div>
            <div
              className="relative flex-1 cursor-copy"
              style={{ height: timeline.unassigned.lanes * LANE_H + ROW_PAD }}
              onClick={(e) => addAt(e, [])}
              title="Click an empty spot to add a shift at that hour"
            >
              {grid}
              {timeline.unassigned.bars.map(renderBar)}
            </div>
          </div>

          {/* People */}
          {people.map((r) => (
            <div key={r.userId} className="group flex border-b border-[var(--row-rule)]">
              <div className={`${NAME_COL} flex items-center gap-2.5 border-r border-border px-3 py-1.5`}>
                <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-foreground/10 text-[11px] font-semibold text-foreground">{r.initials}</span>
                <div className="min-w-0">
                  <div className="truncate text-[13px] text-foreground" title={r.title ? `${r.name}, ${r.title}` : r.name}>{r.name}</div>
                  <div className="flex items-center gap-2.5 text-[11px] text-meta">
                    <span className="inline-flex items-center gap-1 tabular-nums" title="Scheduled hours"><Clock className="size-3" aria-hidden />{r.hours > 0 ? fmtHours(r.hours) : "--"}</span>
                    <span className="inline-flex items-center gap-1 tabular-nums" title="Shifts"><Layers className="size-3" aria-hidden />{r.shiftCount}</span>
                  </div>
                </div>
              </div>
              <div
                className="relative flex-1 cursor-copy"
                style={{ height: r.lanes * LANE_H + ROW_PAD }}
                onClick={(e) => addAt(e, [r.userId])}
                title={`Click an empty spot to add a shift for ${r.name}`}
              >
                {grid}
                {r.bars.map(renderBar)}
                <UserPlus className="pointer-events-none absolute right-2 top-1/2 size-3.5 -translate-y-1/2 text-meta opacity-0 transition-opacity group-hover:opacity-60" aria-hidden />
              </div>
            </div>
          ))}
          {people.length === 0 && (
            <p className="px-4 py-6 text-[13px] text-meta">{query ? "Nobody matches that search." : "Nobody is working this day yet. Click a row or use Add shift."}</p>
          )}
        </div>
      </div>

      {timeline.untimed.length > 0 && (
        <div className="border-t border-border px-4 py-3">
          <p className="mb-1.5 text-[12px] font-medium text-foreground">No time set yet</p>
          <div className="flex flex-wrap gap-2">
            {timeline.untimed.map((u) => {
              const s = shiftById(u.shiftId);
              return (
                <button
                  key={u.shiftId}
                  type="button"
                  disabled={!s}
                  onClick={() => s && setEditing(s)}
                  className="rounded border border-dashed border-status-warning/60 px-2.5 py-1 text-left text-[12px] transition-colors hover:bg-[var(--row-hover)]"
                >
                  <span className="font-medium">{u.title}</span>
                  <span className="text-meta"> · {u.people.length > 0 ? u.people.join(", ") : "nobody yet"} · {u.filled}/{u.total} · Set time</span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border px-4 py-2 text-[11.5px] text-meta">
        <span className="inline-flex items-center gap-1.5"><span className="inline-block h-2.5 w-4 rounded-sm bg-info" />Dispatch shift, in Connecteam</span>
        <span className="inline-flex items-center gap-1.5"><span className="inline-block h-2.5 w-4 rounded-sm border border-dashed border-info bg-info/15" />Dispatch shift, not in Connecteam yet</span>
        <span className="inline-flex items-center gap-1.5"><span className="inline-block h-2.5 w-4 rounded-sm bg-foreground" />Entered in Connecteam</span>
        <span className="inline-flex items-center gap-1.5"><span className="inline-block h-2.5 w-4 rounded-sm border border-status-blocked/20 bg-status-blocked/10" />Unavailable or time off</span>
      </div>

      {editing && (
        <SidePanelOverlay onClose={() => setEditing(null)}>
          <ShiftEditor
            shift={editing}
            date={date}
            roster={roster}
            eligibilityData={eligibilityData}
            recommendations={recommendations[editing.id] ?? []}
            onClose={() => setEditing(null)}
            routeOptions={routeOptions}
          />
        </SidePanelOverlay>
      )}
      {adding && (
        <SidePanelOverlay onClose={() => setAdding(null)}>
          <ShiftEditor shift={null} date={date} roster={roster} eligibilityData={eligibilityData} recommendations={[]} prefill={adding} routeOptions={routeOptions} onClose={() => setAdding(null)} />
        </SidePanelOverlay>
      )}
    </div>
  );
}
