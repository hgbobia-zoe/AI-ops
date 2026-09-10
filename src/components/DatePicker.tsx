"use client";

// Click-to-pick date control for the day-navigable boards (Dispatch, Staffing). A visible button shows
// the current day; clicking it calls the date input's showPicker() to open the OS calendar (the reliable
// way — a transparent overlaid input doesn't consistently pop the picker on a click). Picking a day
// navigates to ?date=YYYY-MM-DD (or the base path when it's today).

import { useRef } from "react";
import { useRouter } from "next/navigation";
import { CalendarDays } from "lucide-react";
import { formatYmdLong } from "@/lib/dates";

export function DatePicker({ date, today, basePath }: { date: string; today: string; basePath: string }): React.JSX.Element {
  const router = useRouter();
  const ref = useRef<HTMLInputElement>(null);

  const open = (): void => {
    const el = ref.current;
    if (!el) return;
    try {
      if (typeof el.showPicker === "function") {
        el.showPicker();
        return;
      }
    } catch {
      /* fall through to focus */
    }
    el.focus();
    el.click();
  };

  return (
    <div className="relative inline-flex">
      <button
        type="button"
        onClick={open}
        className="inline-flex items-center gap-2 rounded-lg border border-white/10 px-3 py-1.5 text-sm font-medium hover:border-white/25"
      >
        <CalendarDays className="size-4 text-muted-foreground" />
        {date === today ? "Today" : formatYmdLong(date)}
      </button>
      <input
        ref={ref}
        type="date"
        value={date}
        aria-label="Pick a date"
        tabIndex={-1}
        onChange={(e) => {
          const d = e.target.value;
          if (!d) return;
          router.push(d === today ? basePath : `${basePath}?date=${d}`);
        }}
        className="pointer-events-none absolute bottom-0 left-3 h-0 w-0 opacity-0"
      />
    </div>
  );
}
