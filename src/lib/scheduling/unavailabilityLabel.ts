// One wording for a Connecteam time-off / unavailability block, in Eastern time, used everywhere Dispatch
// tells someone a worker is off. Team report (2026-11-13): workers mark themselves unavailable "until" or
// "after" a certain time, but Dispatch only said "unavailable", which reads as the whole day. The feed and
// the overlap rule were already right (a block only blocks a shift it overlaps); the hours just never made
// it onto the screen. Client safe (no server imports).

import { opsWallTimeToMs, opsYmdOfMs, shiftYmd, DISPLAY_TZ } from "@/lib/dates";

export interface UnavailabilityLike {
  kind: "unavailability" | "timeOff";
  startUnix: number;
  endUnix: number;
  reason?: string;
}

function clock(ms: number, tz: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(new Date(ms));
}

/** The block's hours on `day` (default: the Eastern day it starts): "all day", "until 2:00 PM",
 *  "after 3:00 PM" or "2:30 PM to 3:30 PM". Connecteam ends an all day block at 11:59 PM, so a block that
 *  reaches the last minute of the day counts as running to the end of it. */
export function unavailabilityWindow(b: UnavailabilityLike, opts: { day?: string; tz?: string } = {}): string {
  const tz = opts.tz ?? DISPLAY_TZ;
  const startMs = b.startUnix * 1000;
  const endMs = b.endUnix * 1000;
  const day = opts.day ?? opsYmdOfMs(startMs, tz);
  const dayStart = opsWallTimeToMs(day, 0, 0, tz);
  const dayEnd = opsWallTimeToMs(shiftYmd(day, 1), 0, 0, tz);
  const openStart = startMs <= dayStart;
  const openEnd = endMs >= dayEnd - 60_000;
  if (openStart && openEnd) return "all day";
  if (openStart) return `until ${clock(endMs, tz)}`;
  if (openEnd) return `after ${clock(startMs, tz)}`;
  return `${clock(startMs, tz)} to ${clock(endMs, tz)}`;
}

/** "Unavailable until 2:00 PM", "Time off 2:30 PM to 3:30 PM (Court)", "Unavailable all day". */
export function unavailabilityLabel(b: UnavailabilityLike, opts: { day?: string; tz?: string } = {}): string {
  const word = b.kind === "timeOff" ? "Time off" : "Unavailable";
  const reason = b.reason?.trim() ? ` (${b.reason.trim()})` : "";
  return `${word} ${unavailabilityWindow(b, opts)}${reason}`;
}
