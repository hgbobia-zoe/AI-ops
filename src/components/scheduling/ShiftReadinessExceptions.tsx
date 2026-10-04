// Read-only Shift READINESS + EXCEPTION QUEUE surface (scheduling/readiness.ts + scheduling/exceptions.ts).
// The dispatcher sees exceptions SURFACED (RED first), not hunted, and a per-shift readiness roll-up with
// the exact blockers. Deterministic; no actions wired here (reassign/publish live in the existing board).
//
// Comms style: no em-dashes, no emoji.

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

const LEVEL_DOT: Record<ShiftReadinessLevel, string> = {
  READY: "bg-positive",
  BLOCKED: "bg-critical",
  UNVERIFIED: "bg-attention",
};
const SEV_DOT: Record<ShiftException["severity"], string> = { RED: "bg-critical", YELLOW: "bg-attention" };

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
      <div className="rounded-lg border border-border bg-surface p-4">
        <h2 className="mb-2 text-[13px] font-medium uppercase tracking-[0.08em] text-meta">Shift readiness</h2>
        {rows.length === 0 ? (
          <p className="text-[12.5px] text-meta">No shifts to assess yet.</p>
        ) : (
          <ul className="space-y-1.5">
            {rows.map((r) => (
              <li key={r.shiftId} className="flex items-start justify-between gap-3 text-[12.5px]">
                <span className="inline-flex items-center gap-1.5">
                  <span className={`mt-0.5 size-1.5 rounded-full ${LEVEL_DOT[r.level]}`} aria-hidden />
                  <span className="text-foreground">{routeLabel(r.routeId)}</span>
                  <span className="text-meta">{r.roleLabel}</span>
                </span>
                <span className="text-right">
                  <span className="tabular-nums text-meta">{r.score}/100</span>
                  {r.blockers.length > 0 && <span className="ml-2 text-attention">{r.blockers.join(", ")}</span>}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Exception queue */}
      <div className="rounded-lg border border-border bg-surface p-4">
        <h2 className="mb-2 text-[13px] font-medium uppercase tracking-[0.08em] text-meta">
          Exceptions {exceptions.length > 0 && <span className="text-foreground">({reds} red, {yellows} yellow)</span>}
        </h2>
        {exceptions.length === 0 ? (
          <p className="inline-flex items-center gap-1.5 text-[12.5px] text-positive">
            <span className="size-1.5 rounded-full bg-positive" aria-hidden /> No open exceptions.
          </p>
        ) : (
          <ul className="space-y-1.5">
            {exceptions.map((e) => (
              <li key={e.signature} className="flex items-start justify-between gap-3 text-[12.5px]">
                <span className="inline-flex items-start gap-1.5">
                  <span className={`mt-0.5 size-1.5 rounded-full ${SEV_DOT[e.severity]}`} aria-hidden />
                  <span>
                    <span className="text-foreground">{e.title}</span>
                    <span className="text-meta"> · {routeLabel(e.routeId)}</span>
                    <div className="text-[11px] text-meta">{e.detail}</div>
                  </span>
                </span>
                <span className="whitespace-nowrap text-[11px] text-tertiary-text">{e.fixLabel}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
