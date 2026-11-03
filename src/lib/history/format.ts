// Operational History display helpers. Every time is shown in the operating timezone (Eastern by default),
// never the server's clock: Fly runs in UTC, so a plain toLocaleTimeString() showed times 4 to 5 hours off
// and flipped "Today" at 7 to 8pm Eastern. Pure; the timezone is a parameter so tests are deterministic.

import { DISPLAY_TZ, ymdInTz, shiftYmd, formatYmdLong } from "@/lib/dates";

/** The calendar day (YYYY-MM-DD) an instant falls on in the operating timezone. */
export function opsDayKey(iso: string, tz: string = DISPLAY_TZ): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : ymdInTz(tz, d);
}

/** "Today", "Yesterday", or "Mon, Nov 3" for a change, relative to `todayYmd` (operating timezone). */
export function opsDayLabel(iso: string, todayYmd: string, tz: string = DISPLAY_TZ): string {
  const key = opsDayKey(iso, tz);
  if (!key) return "Unknown date";
  if (key === todayYmd) return "Today";
  if (key === shiftYmd(todayYmd, -1)) return "Yesterday";
  return formatYmdLong(key);
}

/** "9:12 AM" in the operating timezone. */
export function opsTime(iso: string, tz: string = DISPLAY_TZ): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(d);
}

/** "Nov 3, 9:12 AM" in the operating timezone. */
export function opsDateTime(iso: string, tz: string = DISPLAY_TZ): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat("en-US", { timeZone: tz, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(d);
}

/** "$1,250" from a stored dollar string; null when it isn't a number. */
export function formatDollars(v: string | number | null | undefined): string | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return "$" + Math.round(n).toLocaleString("en-US");
}
