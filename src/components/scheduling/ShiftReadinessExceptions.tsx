// Read-only Shift READINESS + EXCEPTION QUEUE surface (scheduling/readiness.ts + scheduling/exceptions.ts).
// The dispatcher sees exceptions SURFACED (RED first), not hunted, and a per-shift readiness roll-up with
// the exact blockers. Deterministic; no actions wired here (reassign/publish live in the existing board).
//
// Status is rendered through the SHARED Nocturne vocabulary (StatusMark): a coloured indicator icon + a
// crisp, untinted label. Blockers stay in the neutral meta tier (the mark already carries the colour).
// Comms style: no em-dashes, no emoji.

import { StatusMark } from "@/components/console-primitives";
import { EmptyState } from "@/components/ui/states";
import type { ShiftException } from "@/lib/scheduling/exceptions";
import type { ShiftReadinessLevel } from "@/lib/scheduling/readiness";

export interface ReadinessRow {
  shiftId: string;
  routeId: string | null;
  roleLabel: string;
  level: ShiftReadinessLevel;
  score: number;
  blockers: string[];
}

// Readiness level → shared StatusMark tone. UNVERIFIED is "requires review" (attention), not a false red.
const LEVEL_TONE: Record<ShiftReadinessLevel, "positive" | "critical" | "attention"> = {
  READY: "positive",
  BLOCKED: "critical",
  UNVERIFIED: "attention",
};
const LEVEL_LABEL: Record<ShiftReadinessLevel, string> = {
  READY: "Ready",
  BLOCKED: "Blocked",
  UNVERIFIED: "Unverified",
};
const SEV_TONE: Record<ShiftException["severity"], "critical" | "attention"> = { RED: "critical", YELLOW: "attention" };
const SEV_LABEL: Record<ShiftException["severity"], string> = { RED: "Blocking", YELLOW: "Attention" };

export function ShiftReadinessExceptions({
  rows,
  exceptions,
  routeLabel,
}: {
  rows: ReadinessRow[];
  exceptions: ShiftException[];
  routeLabel: (routeId: string | null) => string;
}): React.JSX.Element | null {
  if (rows.length === 0 && exceptions.length === 0) return null;
  const reds = exceptions.filter((e) => e.severity === "RED").length;
  const yellows = exceptions.length - reds;

  return (
    <section className="mb-5 grid gap-4 lg:grid-cols-2">
      {/* Readiness roll-up */}
      <div className="surface border border-border p-4">
        <h2 className="mb-2.5 text-[13px] font-medium uppercase tracking-[0.08em] text-meta">Shift readiness</h2>
        {rows.length === 0 ? (
          <p className="text-[12.5px] text-meta">No shifts to assess yet.</p>
        ) : (
          <ul className="space-y-1.5">
            {rows.map((r) => (
              <li key={r.shiftId} className="flex items-start justify-between gap-3 text-[12.5px]">
                <span className="inline-flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
                  <StatusMark tone={LEVEL_TONE[r.level]} label={LEVEL_LABEL[r.level]} />
                  <span className="text-foreground">{routeLabel(r.routeId)}</span>
                  <span className="text-meta">{r.roleLabel}</span>
                </span>
                <span className="shrink-0 text-right">
                  <span className="tabular-nums text-meta">{r.score}/100</span>
                  {r.blockers.length > 0 && <span className="ml-2 text-meta">{r.blockers.join(", ")}</span>}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Exception queue */}
      <div className="surface border border-border p-4">
        <h2 className="mb-2.5 text-[13px] font-medium uppercase tracking-[0.08em] text-meta">
          Exceptions {exceptions.length > 0 && <span className="text-foreground">({reds} blocking, {yellows} attention)</span>}
        </h2>
        {exceptions.length === 0 ? (
          <EmptyState title="No open exceptions" body="Every shift this day is clear of blocking and attention items." className="border-0 px-0 py-6" />
        ) : (
          <ul className="space-y-2">
            {exceptions.map((e) => (
              <li key={e.signature} className="flex items-start justify-between gap-3 text-[12.5px]">
                <span className="min-w-0">
                  <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                    <StatusMark tone={SEV_TONE[e.severity]} label={SEV_LABEL[e.severity]} />
                    <span className="text-foreground">{e.title}</span>
                    <span className="text-meta">· {routeLabel(e.routeId)}</span>
                  </span>
                  <span className="mt-0.5 block text-[11px] text-meta">{e.detail}</span>
                </span>
                <span className="shrink-0 whitespace-nowrap text-[11px] text-tertiary-text">{e.fixLabel}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
