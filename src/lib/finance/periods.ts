// Financial Intelligence — reporting periods, in the ops timezone. Weeks are Sun–Sat.
import { todayInOpsTz, shiftYmd } from "@/lib/dates";

export type PeriodKey = "today" | "thisWeek" | "nextWeek" | "thisMonth" | "lastMonth";

export interface Period {
  key: PeriodKey;
  label: string;
  start: string; // YYYY-MM-DD inclusive
  end: string; // YYYY-MM-DD inclusive
  /** True for the ~7-day periods a weekly revenue target applies to. */
  isWeek: boolean;
}

export const PERIOD_KEYS: PeriodKey[] = ["today", "thisWeek", "nextWeek", "thisMonth", "lastMonth"];

function monthBounds(ymd: string, monthOffset: number): { start: string; end: string } {
  const [y, m] = ymd.split("-").map(Number);
  const firstOfTarget = new Date(Date.UTC(y, m - 1 + monthOffset, 1));
  const start = firstOfTarget.toISOString().slice(0, 10);
  const firstOfNext = new Date(Date.UTC(firstOfTarget.getUTCFullYear(), firstOfTarget.getUTCMonth() + 1, 1));
  const end = new Date(firstOfNext.getTime() - 86400_000).toISOString().slice(0, 10);
  return { start, end };
}

export function getPeriod(key: PeriodKey, today: string = todayInOpsTz()): Period {
  const dow = new Date(`${today}T00:00:00Z`).getUTCDay(); // 0 = Sunday
  const weekStart = shiftYmd(today, -dow);
  switch (key) {
    case "today":
      return { key, label: "Today", start: today, end: today, isWeek: false };
    case "thisWeek":
      return { key, label: "This Week", start: weekStart, end: shiftYmd(weekStart, 6), isWeek: true };
    case "nextWeek":
      return { key, label: "Next Week", start: shiftYmd(weekStart, 7), end: shiftYmd(weekStart, 13), isWeek: true };
    case "thisMonth": {
      const { start, end } = monthBounds(today, 0);
      return { key, label: "This Month", start, end, isWeek: false };
    }
    case "lastMonth": {
      const { start, end } = monthBounds(today, -1);
      return { key, label: "Last Month", start, end, isWeek: false };
    }
  }
}
