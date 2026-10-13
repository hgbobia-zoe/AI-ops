"use client";

// Schedule → Route bridge PROMPT. Closes the recurring confusion (crew scheduled in Connecteam, but the
// route still shows a gap) by offering a one-click assign of each scheduled-but-unrouted person onto a
// route that actually has a seat for them. It does NOT credit the Connecteam schedule as coverage: the
// assign goes through the SAME path the board uses (create/attach the route+role shift, then PATCH its
// assignees), so the pre-check gap closes on its own because a REAL app assignment now exists.
//
// FACTS ONLY: only routes with a real gap in the person's seat are offered (the server already filtered to
// eligible routes); the suggested route is pre-highlighted. There is no "mark done" — assigning is the
// only way the gap clears.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Loader2, CalendarClock, Truck as TruckIcon } from "lucide-react";
import { formatClockTime } from "@/lib/dates";
import type { StaffShift } from "@/lib/scheduling/types";
import type { RouteCardData } from "@/components/scheduling/RouteStaffBoard";

/** One scheduled-but-unrouted person, ready to render (serializable; built on the server). */
export interface ScheduledToRouteView {
  userId: number;
  name: string;
  /** Human role label (e.g. "Driver", "Warehouse"). */
  roleLabel: string;
  /** The route seat this person fills via the existing assign path. */
  fillRole: "driver" | "field";
  /** The person's Connecteam work window (ISO), null when the shift carried no usable time. */
  startTime: string | null;
  endTime: string | null;
  windowKnown: boolean;
  /** Pre-highlighted default route, else null. */
  suggestedRouteId: string | null;
  /** Routes this person is eligible to fill right now. */
  eligibleRouteIds: string[];
}

function windowLabel(start: string | null, end: string | null, known: boolean): string {
  if (!known || !start) return "work window not set";
  const s = formatClockTime(start);
  const e = end ? formatClockTime(end) : "";
  return e ? `${s} – ${e}` : s;
}

export function ScheduledToRoutePrompt({
  date,
  people,
  routeCards,
  shifts,
}: {
  date: string;
  people: ScheduledToRouteView[];
  routeCards: RouteCardData[];
  shifts: StaffShift[];
}): React.JSX.Element | null {
  const router = useRouter();
  const [working, setWorking] = useState<number | null>(null); // userId being assigned
  const [error, setError] = useState<string | null>(null);

  if (people.length === 0) return null;

  const cardFor = (routeId: string): RouteCardData | undefined => routeCards.find((r) => r.routeId === routeId);

  async function assign(person: ScheduledToRouteView, route: RouteCardData): Promise<void> {
    setWorking(person.userId);
    setError(null);
    try {
      // Attach to the route's existing shift for this seat, or create one — mirrors AddWorkerPanel /
      // WarehousePrepSection so there is ONE assign path (no duplicated logic, no override).
      let shift = shifts.find((s) => s.routeId === route.routeId && s.role === person.fillRole) ?? null;
      if (!shift) {
        const res = await fetch("/api/scheduling/shift", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            date,
            role: person.fillRole,
            headcount: 1,
            startTime: route.startTime,
            endTime: route.endTime,
            windowKnown: route.windowKnown,
            location: null,
            routeId: route.routeId,
            truckId: route.truckId,
            eventLabel: route.eventLabel,
            source: "manual",
          }),
        });
        if (!res.ok) {
          setError("Couldn't create the route shift. Try again.");
          return;
        }
        shift = ((await res.json()) as { shift?: StaffShift }).shift ?? null;
        if (!shift) {
          setError("Couldn't create the route shift. Try again.");
          return;
        }
      }
      const nextAssignees = shift.assignees.includes(person.userId) ? shift.assignees : [...shift.assignees, person.userId];
      const nextHeadcount = Math.max(shift.headcount, nextAssignees.length);
      const res = await fetch(`/api/scheduling/shift/${shift.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assignees: nextAssignees, headcount: nextHeadcount }),
      });
      if (!res.ok) {
        setError("Couldn't assign — try again.");
        return;
      }
      toast.success(`${person.name} assigned to ${route.truckName}`);
      router.refresh();
    } catch {
      setError("Couldn't assign — try again.");
    } finally {
      setWorking(null);
    }
  }

  return (
    <section className="mb-6 rounded-lg border border-attention/40 bg-attention/[0.05]">
      <header className="flex items-center gap-2 border-b border-attention/30 px-4 py-2.5">
        <CalendarClock className="size-4 text-attention" />
        <h2 className="text-[13px] font-medium">Scheduled in Connecteam, not on a route</h2>
        <span className="text-[12px] text-meta">
          {people.length} crew scheduled for this day {people.length === 1 ? "isn’t" : "aren’t"} on a route yet
        </span>
      </header>
      <p className="px-4 pt-2.5 text-[12px] text-meta">
        Crew scheduled in Connecteam still need to be assigned to a route here. Assigning closes the route’s
        staffing gap; a Connecteam schedule on its own is not route coverage.
      </p>
      <ul className="divide-y divide-attention/20">
        {people.map((p) => {
          const suggested = p.suggestedRouteId;
          const options = p.eligibleRouteIds
            .map((id) => cardFor(id))
            .filter((c): c is RouteCardData => c != null)
            .sort((a, b) => (a.routeId === suggested ? -1 : b.routeId === suggested ? 1 : 0));
          return (
            <li key={p.userId} className="px-4 py-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-[13px] font-medium text-foreground">{p.name}</span>
                    <span className="text-[11px] uppercase tracking-[0.06em] text-meta">{p.roleLabel}</span>
                  </div>
                  <p className="mt-0.5 text-[12px] text-meta tabular-nums">{windowLabel(p.startTime, p.endTime, p.windowKnown)}</p>
                </div>
                <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                  <span className="text-[11px] uppercase tracking-[0.06em] text-meta">Assign to</span>
                  {options.map((r) => {
                    const isSuggested = r.routeId === suggested;
                    return (
                      <button
                        key={r.routeId}
                        type="button"
                        disabled={working !== null}
                        onClick={() => assign(p, r)}
                        title={isSuggested ? "Suggested route (largest matching gap)" : undefined}
                        className={`inline-flex items-center gap-1.5 rounded border px-2 py-1 text-[12px] transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                          isSuggested
                            ? "border-foreground bg-foreground/[0.08] text-foreground hover:bg-foreground/[0.14]"
                            : "border-border text-tertiary-text hover:bg-[var(--row-hover)] hover:text-foreground"
                        }`}
                      >
                        {working === p.userId ? <Loader2 className="size-3 animate-spin" /> : <TruckIcon className="size-3" />}
                        {r.truckName}
                        {isSuggested && <span className="text-[10px] uppercase tracking-[0.05em] text-positive">suggested</span>}
                      </button>
                    );
                  })}
                </div>
              </div>
            </li>
          );
        })}
      </ul>
      {error && <p className="px-4 pb-3 text-[12.5px] text-critical">{error}</p>}
    </section>
  );
}
