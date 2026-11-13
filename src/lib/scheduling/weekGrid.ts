// Week schedule (owner request 2026-11-13: "a weekly view same as Connecteam on top of the daily view").
// People down the side, Monday to Sunday across, each day's shifts and unavailability as cards, a per-day
// header (hours, shifts, people) and a weekly summary, like the Connecteam Job Scheduler week.
//
// Built from the day model: each day goes through buildDayTimeline (the same rules the Day schedule uses,
// so the two views never disagree: Connecteam copies of published shifts shown once, open seats in the
// unassigned row, overrides flagged, unavailability worded "Until 2:00p" / "All day"), then pivoted into
// person x day. Pure: no DB, no network.

import { buildDayTimeline, initialsOf, type DayTimelineInput, type TimelineBar } from "./dayTimeline";
import type { CrewMember } from "@/lib/connecteam";

export interface WeekDayInput {
  date: string;
  dayStartMs: number;
  appShifts: DayTimelineInput["appShifts"];
  gapByShift: DayTimelineInput["gapByShift"];
  connecteamShifts: DayTimelineInput["connecteamShifts"];
  unavailability: DayTimelineInput["unavailability"];
}

export interface WeekCard extends Pick<TimelineBar, "id" | "kind" | "timeLabel" | "title" | "shiftId" | "filled" | "total" | "published" | "allDay" | "override"> {
  /** Sort key inside a day cell (minutes from midnight). */
  startMin: number;
}

export interface WeekDay {
  date: string;
  /** "Mon 11/9". */
  label: string;
  isToday: boolean;
  /** Scheduled hours that day across everyone (shifts only, never unavailability). */
  hours: number;
  /** Distinct shifts that day (an app shift and its Connecteam copy count once). */
  shifts: number;
  /** People with at least one shift that day. */
  people: number;
}

export interface WeekRow {
  userId: number;
  name: string;
  initials: string;
  title: string | null;
  hours: number;
  shiftCount: number;
  cells: Record<string, WeekCard[]>;
}

export interface WeekGrid {
  days: WeekDay[];
  /** Open seats and shifts with no time yet, per day. */
  unassigned: Record<string, WeekCard[]>;
  people: WeekRow[];
  summary: { hours: number; shifts: number; people: number };
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Minutes a shift card really covers: an overnight shift's true length, not the part before midnight. */
function cardMinutes(b: TimelineBar): number {
  return b.minutes ?? b.endMin - b.startMin;
}

function toCard(b: TimelineBar): WeekCard {
  return { id: b.id, kind: b.kind, timeLabel: b.timeLabel, title: b.title, shiftId: b.shiftId, filled: b.filled, total: b.total, published: b.published, allDay: b.allDay, override: b.override, startMin: b.startMin };
}

/** "Mon 11/9" for "2026-11-09" (the calendar date itself, never shifted by a timezone). */
export function weekDayLabel(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const wd = new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" });
  return `${wd} ${m}/${d}`;
}

/** The Monday on or before `ymd` (Connecteam weeks run Monday to Sunday). */
export function weekStartOf(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const back = (dt.getUTCDay() + 6) % 7; // Mon=0 ... Sun=6
  dt.setUTCDate(dt.getUTCDate() - back);
  return dt.toISOString().slice(0, 10);
}

export function buildWeekGrid(input: {
  days: WeekDayInput[];
  roster: CrewMember[];
  routeLabel: DayTimelineInput["routeLabel"];
  clock: DayTimelineInput["clock"];
  today: string;
}): WeekGrid {
  const rows = new Map<number, WeekRow>();
  for (const m of input.roster) rows.set(m.userId, { userId: m.userId, name: m.name, initials: initialsOf(m.name), title: m.title ?? null, hours: 0, shiftCount: 0, cells: {} });
  const unassigned: Record<string, WeekCard[]> = {};
  const days: WeekDay[] = [];
  const weekShiftIds = new Set<string>();
  const weekPeople = new Set<number>();
  let weekMinutes = 0;

  for (const d of input.days) {
    const t = buildDayTimeline({ dayStartMs: d.dayStartMs, roster: input.roster, appShifts: d.appShifts, gapByShift: d.gapByShift, connecteamShifts: d.connecteamShifts, unavailability: d.unavailability, routeLabel: input.routeLabel, clock: input.clock });
    const dayShiftIds = new Set<string>();
    let dayMinutes = 0;
    let dayPeople = 0;
    for (const p of t.people) {
      let row = rows.get(p.userId);
      if (!row) {
        row = { userId: p.userId, name: p.name, initials: p.initials, title: p.title, hours: 0, shiftCount: 0, cells: {} };
        rows.set(p.userId, row);
      }
      if (p.bars.length) row.cells[d.date] = p.bars.map(toCard).sort((a, b) => a.startMin - b.startMin);
      const work = p.bars.filter((b) => b.kind !== "unavailable");
      const mins = work.reduce((n, b) => n + cardMinutes(b), 0);
      row.hours += mins / 60;
      row.shiftCount += work.length;
      dayMinutes += mins;
      if (work.length) {
        dayPeople += 1;
        weekPeople.add(p.userId);
      }
      for (const b of work) dayShiftIds.add(b.shiftId ?? b.id.split(":").slice(0, -1).join(":"));
    }
    const open = [...t.unassigned.bars.map(toCard), ...t.untimed.map((u) => ({ id: `${u.shiftId}:untimed`, kind: "app" as const, timeLabel: "No time yet", title: u.title, shiftId: u.shiftId, filled: u.filled, total: u.total, startMin: 24 * 60 }))];
    for (const b of t.unassigned.bars) dayShiftIds.add(b.shiftId ?? b.id);
    for (const u of t.untimed) dayShiftIds.add(u.shiftId);
    if (open.length) unassigned[d.date] = open.sort((a, b) => a.startMin - b.startMin);
    for (const id of dayShiftIds) weekShiftIds.add(`${d.date}|${id}`);
    weekMinutes += dayMinutes;
    days.push({ date: d.date, label: weekDayLabel(d.date), isToday: d.date === input.today, hours: round2(dayMinutes / 60), shifts: dayShiftIds.size, people: dayPeople });
  }

  const people = [...rows.values()].map((r) => ({ ...r, hours: round2(r.hours) }));
  // Like Connecteam: everyone by name, with the people working this week first and people only marked
  // unavailable next, so the week reads top down.
  const group = (r: WeekRow): number => (r.shiftCount > 0 ? 0 : Object.keys(r.cells).length > 0 ? 1 : 2);
  people.sort((a, b) => group(a) - group(b) || a.name.localeCompare(b.name));

  return { days, unassigned, people, summary: { hours: round2(weekMinutes / 60), shifts: weekShiftIds.size, people: weekPeople.size } };
}

/** "28:00" for 28 hours, "04:30" for 4.5 (Connecteam's hour format, same as the Day schedule). */
export function hoursLabel(hours: number): string {
  const total = Math.round(hours * 60);
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}
