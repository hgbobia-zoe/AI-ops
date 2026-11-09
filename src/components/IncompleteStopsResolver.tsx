"use client";

// Per-stop choice for stops still not completed when a route is closed (driver closeout + office close).
// For each stop the closer either marks it completed now, or leaves it open with a reason. Closing is never
// blocked forever: the parent enables its Close button once every stop has a choice (unresolvedStops).

import { Textarea } from "@/components/ui/textarea";
import type { CloseResolutionInput } from "@/lib/dispatch/onTime";

export interface IncompleteStopRef {
  stopId: string;
  sequence: number;
  custName: string;
  state?: string;
}

export function IncompleteStopsResolver({
  stops,
  value,
  onChange,
  size = "lg",
}: {
  stops: IncompleteStopRef[];
  value: CloseResolutionInput[];
  onChange: (next: CloseResolutionInput[]) => void;
  size?: "lg" | "sm";
}) {
  if (stops.length === 0) return null;
  const byId = new Map(value.map((r) => [r.stopId, r]));
  const set = (stopId: string, r: CloseResolutionInput | null) => {
    const rest = value.filter((x) => x.stopId !== stopId);
    onChange(r ? [...rest, r] : rest);
  };
  const lg = size === "lg";
  const n = stops.length;

  return (
    <div className={`space-y-2 rounded-lg border border-amber-400/30 bg-amber-400/[0.06] ${lg ? "p-3" : "p-2"}`}>
      <p className={lg ? "text-base font-medium text-foreground" : "text-[12px] font-medium text-foreground"}>
        {n} stop{n === 1 ? " is" : "s are"} not completed. For each one, mark it completed or say why it is still open.
      </p>
      <ul className="space-y-2">
        {stops.map((s) => {
          const r = byId.get(s.stopId);
          const completed = r?.action === "completed";
          return (
            <li key={s.stopId} className={`space-y-1.5 rounded-md border border-white/10 ${lg ? "p-3" : "p-2"}`}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className={lg ? "text-base" : "text-[12px]"}>
                  {s.sequence}. {s.custName || "Unnamed stop"}
                  {s.state ? <span className="text-muted-foreground"> ({s.state})</span> : null}
                </span>
                <button
                  type="button"
                  onClick={() => set(s.stopId, completed ? null : { stopId: s.stopId, action: "completed" })}
                  aria-pressed={completed}
                  className={`rounded-md border font-medium ${lg ? "px-3 py-2 text-sm" : "px-2 py-1 text-[11px]"} ${
                    completed ? "border-primary bg-primary text-primary-foreground" : "border-white/15 text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {completed ? "Marked completed" : "Mark completed now"}
                </button>
              </div>
              {!completed && (
                <Textarea
                  value={r?.action === "reason" ? (r.reason ?? "") : ""}
                  onChange={(e) => set(s.stopId, e.target.value ? { stopId: s.stopId, action: "reason", reason: e.target.value } : null)}
                  placeholder="Why is it still open? For example: customer not home, rescheduled for Monday."
                  rows={lg ? 2 : 1}
                  className={lg ? "" : "min-h-8 text-[12px] md:text-[12px]"}
                />
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
