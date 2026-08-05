"use client";

import { STATE_VISUAL } from "@/lib/stateVisual";
import type { Stop } from "@/lib/types";

export function RouteOverview({
  stops,
  activeIndex,
}: {
  stops: Stop[];
  activeIndex: number;
}) {
  return (
    <section className="space-y-3">
      <h2 className="px-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Today&apos;s route
      </h2>
      <ol className="relative space-y-1">
        {stops.map((stop, i) => {
          const v = STATE_VISUAL[stop.state];
          const Icon = v.icon;
          const isActive = i === activeIndex;
          const isLast = i === stops.length - 1;
          return (
            <li key={stop.stopId} className="relative flex gap-3">
              {/* connector line */}
              {!isLast && (
                <span
                  className={`absolute left-[15px] top-8 h-full w-0.5 ${
                    stop.state === "Completed" ? "bg-foreground/40" : "bg-border"
                  }`}
                />
              )}
              <span
                className={`relative z-10 mt-1 flex size-8 shrink-0 items-center justify-center rounded-full text-white ${v.dot}`}
              >
                <Icon className="size-4" />
              </span>
              <div
                className={`mb-1 flex-1 rounded-xl border p-3 transition-colors ${
                  isActive
                    ? "border-primary/40 bg-accent/40 shadow-sm"
                    : "border-transparent"
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium">{stop.custName}</span>
                  <span className="text-xs text-muted-foreground">{v.label}</span>
                </div>
                <div className="text-xs text-muted-foreground">{stop.address}</div>
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
