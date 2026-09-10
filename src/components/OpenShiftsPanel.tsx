// Open-shift coverage panel for /staffing. Flags shifts on the Connecteam schedule with nobody
// assigned, and for each suggests crew who are free at that time (no conflicting shift), role-matched,
// least-loaded first. Advisory only — assignment happens in Connecteam (we don't write to it).

import { UserX, MapPin, Clock } from "lucide-react";
import { shiftClock, type CrewRole } from "@/lib/connecteam";
import type { OpenShiftView, NeededRole } from "@/lib/staffing/openShifts";

const NEEDED_LABEL: Record<NeededRole, string> = { driver: "driver", prep: "warehouse/prep", other: "crew", any: "anyone" };
const ROLE_BADGE: Record<CrewRole, string> = { driver: "border-sky-500/40 text-sky-200", prep: "border-amber-500/40 text-amber-200", other: "border-white/20 text-muted-foreground" };

export function OpenShiftsPanel({ openShifts, verified }: { openShifts: OpenShiftView[]; verified: boolean }): React.JSX.Element | null {
  if (!verified) return null; // staffing page shows its own "couldn't verify Connecteam" notice
  if (openShifts.length === 0) {
    return (
      <div className="mb-5 border border-emerald-500/25 bg-emerald-500/[0.05] p-3 text-sm text-emerald-200">
        Every scheduled shift has someone assigned.
      </div>
    );
  }

  return (
    <section className="mb-6">
      <h2 className="mb-2 flex items-center gap-2 text-lg font-semibold">
        <UserX className="size-5 text-amber-300" />
        {openShifts.length} open shift{openShifts.length === 1 ? "" : "s"} — nobody assigned
      </h2>
      <div className="space-y-3">
        {openShifts.map((o) => (
          <div key={o.shift.id} className="border border-amber-500/30 bg-amber-500/[0.05] p-3">
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
              <div className="font-medium">{o.shift.title || "Untitled shift"}</div>
              <div className="flex items-center gap-1 text-xs text-muted-foreground">
                <Clock className="size-3.5" />
                {shiftClock(o.shift.startUnix, o.shift.timezone)}–{shiftClock(o.shift.endUnix, o.shift.timezone)}
              </div>
            </div>
            {o.shift.address && (
              <div className="mt-0.5 flex items-center gap-1 text-[11px] text-muted-foreground">
                <MapPin className="size-3" /> {o.shift.address}
              </div>
            )}

            <div className="mt-2 text-[11px] uppercase tracking-wide text-muted-foreground">
              Suggested — free at this time, {NEEDED_LABEL[o.neededRole]} first
            </div>
            {o.suggestions.length === 0 ? (
              <p className="mt-1 text-sm text-muted-foreground">No one is free at this time on the schedule.</p>
            ) : (
              <div className="mt-1.5 flex flex-wrap gap-2">
                {o.suggestions.map((s) => (
                  <span
                    key={s.member.userId}
                    title={s.reason}
                    className={`flex items-center gap-1.5 border px-2 py-1 text-sm ${s.roleMatch ? ROLE_BADGE[s.member.role] : "border-white/15 text-muted-foreground"}`}
                  >
                    {s.member.name}
                    <span className="text-[10px] opacity-70">{s.bookedHours <= 0 ? "free" : `${s.bookedHours % 1 === 0 ? s.bookedHours : s.bookedHours.toFixed(1)}h`}</span>
                  </span>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
      <p className="mt-2 text-[11px] text-muted-foreground">
        Suggestions are crew with no conflicting shift at that time on the Connecteam schedule (least-loaded first) — a schedule
        read, not a personal-availability guarantee. Assign the shift in Connecteam.
      </p>
    </section>
  );
}
