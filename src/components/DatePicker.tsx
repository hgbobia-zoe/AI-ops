"use client";

// Click-to-pick date control for the day-navigable boards (Dispatch, Staffing). Renders the current
// day as a label with a native date input overlaid transparently — tapping it opens the OS calendar,
// and picking a day navigates to ?date=YYYY-MM-DD (or the base path when it's today).

import { useRouter } from "next/navigation";
import { CalendarDays } from "lucide-react";
import { formatYmdLong } from "@/lib/dates";

export function DatePicker({ date, today, basePath }: { date: string; today: string; basePath: string }): React.JSX.Element {
  const router = useRouter();
  return (
    <label className="relative inline-flex cursor-pointer items-center gap-2 rounded-lg border border-white/10 px-3 py-1.5 text-sm font-medium hover:border-white/25">
      <CalendarDays className="size-4 text-muted-foreground" />
      {date === today ? "Today" : formatYmdLong(date)}
      <input
        type="date"
        value={date}
        aria-label="Pick a date"
        onChange={(e) => {
          const d = e.target.value;
          if (!d) return;
          router.push(d === today ? basePath : `${basePath}?date=${d}`);
        }}
        className="absolute inset-0 cursor-pointer opacity-0"
      />
    </label>
  );
}
