"use client";

// The Scheduling work area, laid out like the Connecteam Job Scheduler the office already uses every day:
// one toolbar (view, day, date, actions), a daily summary line, then the view itself.
//   - "Day schedule" (default): people down the side, hours across the top (DayTimeline).
//   - "By route": the route staffing board with auto staff, overrides and the proposed plan.
// Both views are server rendered and kept mounted; switching only toggles `hidden`, so a queue row or the
// Auto staff button can reveal a section in the other view (see reveal.ts) without a page load.

import { useEffect, useState } from "react";
import { CalendarDays, Truck } from "lucide-react";
import { VIEW_EVENT } from "@/components/scheduling/reveal";

export type SchedulingView = "schedule" | "routes";

const TABS: { id: SchedulingView; label: string; icon: React.ReactNode }[] = [
  { id: "schedule", label: "Day schedule", icon: <CalendarDays className="size-3.5" /> },
  { id: "routes", label: "By route", icon: <Truck className="size-3.5" /> },
];

export function SchedulingViews({
  initial,
  dateNav,
  actions,
  summary,
  hint,
  schedule,
  routes,
}: {
  initial: SchedulingView;
  dateNav: React.ReactNode;
  actions: React.ReactNode;
  summary: React.ReactNode;
  hint: React.ReactNode;
  schedule: React.ReactNode;
  routes: React.ReactNode;
}): React.JSX.Element {
  const [view, setView] = useState<SchedulingView>(initial);

  useEffect(() => {
    const onView = (e: Event): void => {
      const next = (e as CustomEvent<string>).detail;
      if (next === "schedule" || next === "routes") setView(next);
    };
    window.addEventListener(VIEW_EVENT, onView);
    return () => window.removeEventListener(VIEW_EVENT, onView);
  }, []);

  return (
    <section className="surface mb-6 rounded-lg border border-border" aria-label="Schedule">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <div role="tablist" aria-label="View" className="flex rounded-full border border-border p-0.5">
            {TABS.map((t) => (
              <button
                key={t.id}
                role="tab"
                type="button"
                aria-selected={view === t.id}
                onClick={() => setView(t.id)}
                className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[12.5px] transition-colors ${
                  view === t.id ? "bg-foreground text-background" : "text-tertiary-text hover:text-foreground"
                }`}
              >
                {t.icon} {t.label}
              </button>
            ))}
          </div>
          {dateNav}
        </div>
        {actions}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 border-b border-border px-4 py-2">
        {summary}
        <div className="text-[12.5px] text-meta">{hint}</div>
      </div>
      <div data-view-panel="schedule" hidden={view !== "schedule"}>
        {schedule}
      </div>
      <div data-view-panel="routes" hidden={view !== "routes"} className="p-4">
        {routes}
      </div>
    </section>
  );
}
