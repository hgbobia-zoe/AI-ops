// Day timeline: the Connecteam style "people down the side, hours across the top" view of one day.
//
// The office schedules in Connecteam every day, so the Scheduling blade opens on the same shape: an
// "Unassigned shifts" row first, then one row per person with their shifts as bars, and unavailability
// shown as a shaded block. This module is the PURE model behind that grid (no React, no I/O): it merges
//   - the app's own shifts (staff_shifts: the source of truth Dispatch edits and publishes),
//   - the day's Connecteam shifts that did NOT come from the app (so nothing Lisa entered there disappears),
//   - Connecteam unavailability and time off,
// into rows of positioned bars. Facts only: a shift with no known time is never placed on the grid at a
// made up hour; it is listed under "No time set" instead.

import type { CrewMember, CrewShift, UnavailabilityBlock } from "@/lib/connecteam";
import type { ShiftRole, StaffShift } from "@/lib/scheduling/types";
import { opsMinutesIntoDay, opsYmdOfMs } from "@/lib/dates";
import { unavailabilityWindow } from "./unavailabilityLabel";

export type TimelineBarKind = "app" | "connecteam" | "unavailable";

export interface TimelineBar {
  id: string;
  kind: TimelineBarKind;
  /** Minutes from local midnight of the day, clipped to [0, 1440]. */
  startMin: number;
  endMin: number;
  /** "9:00a to 12:30p". */
  timeLabel: string;
  title: string;
  /** App shift to open in the editor (kind "app" only). */
  shiftId?: string;
  /** Unassigned row only: seats filled out of seats needed. */
  filled?: number;
  total?: number;
  /** App shift already in Connecteam (published). false = only in Dispatch so far. */
  published?: boolean;
  /** Unavailable for the whole visible day. */
  allDay?: boolean;
  /** Route shift whose time a person set on purpose (not the route's). */
  override?: boolean;
  /** Stacking lane inside its row (bars that overlap in time sit on separate lanes). */
  lane: number;
  /** A shift's real length in minutes (an overnight shift is not cut at midnight). Used by the week totals. */
  minutes?: number;
}

export interface TimelineRow {
  userId: number;
  name: string;
  initials: string;
  title: string | null;
  /** Scheduled hours this day (shift bars only, never unavailability). */
  hours: number;
  shiftCount: number;
  bars: TimelineBar[];
  lanes: number;
}

export interface UntimedShift {
  shiftId: string;
  title: string;
  people: string[];
  filled: number;
  total: number;
}

export interface DayTimeline {
  startHour: number;
  endHour: number;
  unassigned: { bars: TimelineBar[]; lanes: number };
  people: TimelineRow[];
  untimed: UntimedShift[];
}

export interface DayTimelineInput {
  /** Epoch ms of local midnight for the day being shown. */
  dayStartMs: number;
  roster: CrewMember[];
  appShifts: StaffShift[];
  /** Open seats per app shift (the coverage engine's gap). Missing = headcount minus assignees. */
  gapByShift: Record<string, number>;
  connecteamShifts: CrewShift[];
  unavailability: UnavailabilityBlock[];
  /** Route label for an app shift (truck name), or null when it isn't tied to a route. */
  routeLabel: (routeId: string | null) => string | null;
  /** Clock label for an epoch ms instant, e.g. "9:00a". */
  clock: (ms: number) => string;
}

const DAY_MIN = 24 * 60;
// Own copy on purpose: this model runs in a server component, where a constant exported from a "use client"
// module (RouteStaffBoard's ROLE_LABEL) is only a client reference and reads as undefined.
export const TIMELINE_ROLE_LABEL: Record<ShiftRole, string> = { driver: "Driver", field: "Field", prep: "Prep", office: "Office" };
const DEFAULT_START_HOUR = 6;
const DEFAULT_END_HOUR = 22;

export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/** Assign each bar the first lane where it doesn't overlap an earlier bar. Mutates lane; returns lane count. */
export function stackLanes(bars: TimelineBar[]): number {
  const sorted = [...bars].sort((a, b) => a.startMin - b.startMin || b.endMin - a.endMin);
  const laneEnds: number[] = [];
  for (const bar of sorted) {
    let lane = laneEnds.findIndex((end) => end <= bar.startMin);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(bar.endMin);
    } else {
      laneEnds[lane] = bar.endMin;
    }
    bar.lane = lane;
  }
  return Math.max(1, laneEnds.length);
}

function shiftTitle(s: StaffShift, input: DayTimelineInput): string {
  const role = TIMELINE_ROLE_LABEL[s.role] ?? s.role;
  const where = input.routeLabel(s.routeId) ?? s.eventLabel ?? s.location ?? null;
  return where ? `${role}, ${where}` : role;
}

export function buildDayTimeline(input: DayTimelineInput): DayTimeline {
  const { dayStartMs } = input;
  // Minutes past Eastern midnight by the WALL CLOCK, so bars sit on the right hour on the two DST switch
  // days too (a plain ms difference would put an 8:00 AM shift at 7:00 or 9:00 on those days).
  const dayYmd = opsYmdOfMs(dayStartMs);
  const minOf = (ms: number): number => opsMinutesIntoDay(ms, dayYmd);
  const clip = (m: number): number => Math.min(DAY_MIN, Math.max(0, m));
  const range = (startMs: number, endMs: number): string => `${input.clock(startMs)} to ${input.clock(endMs)}`;

  const byUser = new Map<number, { name: string; title: string | null; bars: TimelineBar[] }>();
  for (const m of input.roster) byUser.set(m.userId, { name: m.name, title: m.title ?? null, bars: [] });
  const rowFor = (userId: number, fallbackName: string, title?: string | null) => {
    let row = byUser.get(userId);
    if (!row) {
      row = { name: fallbackName, title: title ?? null, bars: [] };
      byUser.set(userId, row);
    }
    return row;
  };
  const nameOf = (userId: number): string => byUser.get(userId)?.name ?? `User ${userId}`;

  const unassigned: TimelineBar[] = [];
  const untimed: UntimedShift[] = [];
  const publishedIds = new Set<string>();

  // 1. App shifts: one bar per assigned person, plus an "unassigned" bar while seats are open. A cancelled
  //    shift is not on the schedule. If its Connecteam copy is still there, step 2 shows that copy as a
  //    plain Connecteam shift, because crew still see it until someone removes it in Connecteam.
  for (const s of input.appShifts) {
    if (s.status === "cancelled") continue;
    if (s.connecteamShiftId) publishedIds.add(s.connecteamShiftId);
    const gap = Math.max(0, input.gapByShift[s.id] ?? s.headcount - s.assignees.length);
    const filled = Math.max(0, s.headcount - gap);
    const title = shiftTitle(s, input);
    const startMs = s.windowKnown && s.startTime ? Date.parse(s.startTime) : NaN;
    const endMsRaw = s.endTime ? Date.parse(s.endTime) : NaN;
    if (Number.isNaN(startMs)) {
      untimed.push({ shiftId: s.id, title, people: s.assignees.map(nameOf), filled, total: s.headcount });
      continue;
    }
    // No end yet: show a one hour stub at the real start rather than inventing a length.
    const endMs = Number.isNaN(endMsRaw) || endMsRaw <= startMs ? startMs + 60 * 60000 : endMsRaw;
    const base = {
      kind: "app" as const,
      startMin: clip(minOf(startMs)),
      endMin: clip(minOf(endMs)),
      timeLabel: Number.isNaN(endMsRaw) ? `${input.clock(startMs)}, no end time` : range(startMs, endMs),
      title,
      shiftId: s.id,
      published: Boolean(s.connecteamShiftId),
      override: Boolean(s.routeOverride),
      lane: 0,
      minutes: Math.round((endMs - startMs) / 60000),
    };
    for (const uid of s.assignees) rowFor(uid, `User ${uid}`).bars.push({ ...base, id: `${s.id}:${uid}` });
    if (gap > 0) unassigned.push({ ...base, id: `${s.id}:open`, filled, total: s.headcount });
  }

  // 2. Connecteam shifts that did not come from the app (an app shift published there is already shown).
  for (const cs of input.connecteamShifts) {
    if (publishedIds.has(cs.id)) continue;
    const startMs = cs.startUnix * 1000;
    const endMs = cs.endUnix * 1000;
    const bar = {
      kind: "connecteam" as const,
      startMin: clip(minOf(startMs)),
      endMin: clip(minOf(endMs)),
      timeLabel: range(startMs, endMs),
      title: cs.title || cs.schedulerName || "Connecteam shift",
      lane: 0,
      minutes: Math.round((endMs - startMs) / 60000),
    };
    if (cs.assignees.length === 0) {
      unassigned.push({ ...bar, id: `ct:${cs.id}:open`, filled: 0, total: 1 });
      continue;
    }
    for (const a of cs.assignees) rowFor(a.userId, a.name, a.title).bars.push({ ...bar, id: `ct:${cs.id}:${a.userId}` });
  }

  // 3. Unavailability and time off (only for people we show; a block outside the day is dropped).
  for (const b of input.unavailability) {
    const startMin = clip(minOf(b.startUnix * 1000));
    const endMin = clip(minOf(b.endUnix * 1000));
    if (endMin <= startMin) continue;
    const row = byUser.get(b.userId);
    if (!row) continue;
    // Same wording as the worker pickers (unavailabilityLabel.ts): a block from midnight reads "Until 2:00p",
    // one running to the end of the day "After 3:00p", so a partial day never looks like the whole day.
    const when = unavailabilityWindow(b, { day: dayYmd });
    const allDay = when === "all day";
    const timeLabel = allDay
      ? "All day"
      : when.startsWith("until ")
        ? `Until ${input.clock(b.endUnix * 1000)}`
        : when.startsWith("after ")
          ? `After ${input.clock(b.startUnix * 1000)}`
          : range(b.startUnix * 1000, b.endUnix * 1000);
    row.bars.push({
      id: `un:${b.userId}:${b.startUnix}`,
      kind: "unavailable",
      startMin,
      endMin,
      timeLabel,
      title: b.kind === "timeOff" ? "Time off" : "Unavailable",
      allDay,
      lane: 0,
    });
  }

  // Visible hours: at least 6am to 10pm, widened to fit any real shift (unavailability never widens it).
  let startHour = DEFAULT_START_HOUR;
  let endHour = DEFAULT_END_HOUR;
  const shiftBars = [...unassigned, ...[...byUser.values()].flatMap((r) => r.bars.filter((b) => b.kind !== "unavailable"))];
  for (const b of shiftBars) {
    startHour = Math.min(startHour, Math.floor(b.startMin / 60));
    endHour = Math.max(endHour, Math.ceil(b.endMin / 60));
  }
  startHour = Math.max(0, startHour);
  endHour = Math.min(24, Math.max(endHour, startHour + 1));

  const people: TimelineRow[] = [...byUser.entries()].map(([userId, r]) => {
    const work = r.bars.filter((b) => b.kind !== "unavailable");
    const hours = Math.round((work.reduce((n, b) => n + (b.endMin - b.startMin), 0) / 60) * 100) / 100;
    const lanes = stackLanes(r.bars);
    return { userId, name: r.name, initials: initialsOf(r.name), title: r.title, hours, shiftCount: work.length, bars: r.bars, lanes };
  });
  // Working people first (by first shift), then people marked unavailable, then everyone else by name.
  const firstStart = (r: TimelineRow): number => Math.min(...r.bars.filter((b) => b.kind !== "unavailable").map((b) => b.startMin));
  const group = (r: TimelineRow): number => (r.shiftCount > 0 ? 0 : r.bars.length > 0 ? 1 : 2);
  people.sort((a, b) => group(a) - group(b) || (group(a) === 0 ? firstStart(a) - firstStart(b) : 0) || a.name.localeCompare(b.name));

  return { startHour, endHour, unassigned: { bars: unassigned, lanes: stackLanes(unassigned) }, people, untimed };
}
