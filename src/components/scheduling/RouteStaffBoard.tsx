"use client";

// Route-centric scheduling board — mirrors Dispatch's layout: one card per route (truck header, the
// route window + stop count + event, then the PEOPLE on the route as a single list — not grouped by role)
// with a per-route "Add worker" flow. Shifts still live in the staff_shifts model (one per route+role);
// this view just groups them by route and renders people, remaining need, and the Instawork gap.
//
// FACTS ONLY: a shift with no known window shows "Set time"; Instawork workers are the ACTUAL booked temp
// workers from matched gigs (never fabricated); a gig isn't truck-specific, so it's labelled an
// availability match (it can show under more than one route). The ShiftEditor (edit / Connecteam publish /
// delete) is kept — clicking a role chip opens it; "Add worker" is the new per-route assignment path.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, RefreshCw, Plus, Truck as TruckIcon, UserPlus, Users } from "lucide-react";
import { SidePanelOverlay } from "@/components/SidePanelOverlay";
import { ShiftEditor } from "@/components/scheduling/ShiftEditor";
import { AddWorkerPanel } from "@/components/scheduling/AddWorkerPanel";
import type { CrewMember } from "@/lib/connecteam";
import { formatClockTime } from "@/lib/dates";
import { shiftGap, type ShiftRole, type StaffShift } from "@/lib/scheduling/types";
import type { ShiftCoverage } from "@/lib/scheduling/coverage";
import type { CrewRecommendation } from "@/lib/scheduling/availability";
import type { InstaworkRoleSummary } from "@/lib/instawork/reconcile";

const BTN =
  "inline-flex items-center gap-1.5 rounded border border-border px-3 py-1.5 text-[12.5px] text-tertiary-text transition-colors hover:bg-[var(--row-hover)] hover:text-foreground disabled:opacity-50 disabled:pointer-events-none";

export const ROLE_LABEL: Record<ShiftRole, string> = { driver: "Driver", field: "Field", prep: "Prep" };
const ROLE_ORDER: ShiftRole[] = ["driver", "field", "prep"];

/** An Instawork gig matched to a route (availability, not allocation). */
export interface MatchedGig {
  id: string;
  position: string;
  workers: string[];
  filled: number;
  total: number;
  pending: number;
}

/** One route's card payload (serializable — crosses the server→client boundary). */
export interface RouteCardData {
  routeId: string;
  truckId: string;
  truckName: string;
  stopCount: number;
  driverName: string | null;
  eventLabel: string | null;
  startTime: string | null;
  endTime: string | null;
  windowKnown: boolean;
  roles: ShiftRole[]; // roles this route staffs (drives Instawork gig matching)
  gigs: MatchedGig[];
}

export type RouteRecs = Record<string, Partial<Record<ShiftRole, CrewRecommendation[]>>>;

function windowLabel(start: string | null, end: string | null, known: boolean): string {
  if (!known || !start) return "";
  const s = formatClockTime(start);
  const e = end ? formatClockTime(end) : "";
  return e ? `${s} – ${e}` : s;
}

export function RouteStaffBoard({
  date,
  routeCards,
  shifts,
  otherShifts,
  roster,
  busyUserIds,
  coverage,
  recommendations,
  routeRecs,
  prepCrewToday,
  prepNeed,
  instawork,
  iwConfigured,
  hasRoutes,
}: {
  date: string;
  routeCards: RouteCardData[];
  shifts: StaffShift[];
  otherShifts: StaffShift[];
  roster: CrewMember[];
  busyUserIds: number[];
  coverage: Record<string, ShiftCoverage>;
  recommendations: Record<string, CrewRecommendation[]>;
  routeRecs: RouteRecs;
  prepCrewToday: { name: string; title: string | null; window: string }[];
  prepNeed: number;
  instawork: Record<ShiftRole, InstaworkRoleSummary> | null;
  iwConfigured: boolean;
  hasRoutes: boolean;
}): React.JSX.Element {
  const router = useRouter();
  const [generating, setGenerating] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [editing, setEditing] = useState<StaffShift | "new" | null>(null);
  const [adding, setAdding] = useState<RouteCardData | null>(null);

  const nameOf = (userId: number): CrewMember | undefined => roster.find((m) => m.userId === userId);

  async function generate(): Promise<void> {
    setGenerating(true);
    setNote(null);
    try {
      const res = await fetch("/api/scheduling/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date }),
      });
      const j = (await res.json()) as { shifts?: StaffShift[]; note?: string };
      if (!res.ok) setNote("Couldn't build from routes.");
      else if (j.note === "no routes") setNote("No routes for this day — nothing to build.");
      else setNote(`Built ${j.shifts?.length ?? 0} shift${(j.shifts?.length ?? 0) === 1 ? "" : "s"} from routes.`);
      router.refresh();
    } catch {
      setNote("Couldn't build from routes.");
    } finally {
      setGenerating(false);
    }
  }

  return (
    <>
      {/* Toolbar */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <button onClick={generate} disabled={generating} className={BTN + " border-foreground text-foreground"}>
          {generating ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />} Build / refresh from routes
        </button>
        <button onClick={() => setEditing("new")} className={BTN}>
          <Plus className="size-3.5" /> Add shift
        </button>
        {note && <span className="text-[12px] text-meta">{note}</span>}
      </div>

      {!hasRoutes && (
        <p className="mb-4 rounded border border-border bg-[var(--row-hover)]/40 px-3 py-2.5 text-[12.5px] text-tertiary-text">
          No routes for this day — pull routes first, or add a shift manually.
        </p>
      )}

      {routeCards.length === 0 && otherShifts.length === 0 && prepCrewToday.length === 0 && prepNeed === 0 ? (
        <p className="text-[13px] text-meta">No shifts built for this day yet.</p>
      ) : (
        <div className="space-y-6">
          {/* Route cards — one per truck route, like Dispatch. */}
          {routeCards.length > 0 && (
            <section className="grid gap-4 lg:grid-cols-2">
              {routeCards.map((rc) => (
                <RouteCard
                  key={rc.routeId}
                  card={rc}
                  shifts={shifts.filter((s) => s.routeId === rc.routeId)}
                  coverage={coverage}
                  nameOf={nameOf}
                  iwConfigured={iwConfigured}
                  onEdit={(s) => setEditing(s)}
                  onAdd={() => setAdding(rc)}
                />
              ))}
            </section>
          )}

          {/* Warehouse / Prep crew scheduled in Connecteam today — prep isn't route-tied, so it's shown at
              the day level (this is where the "N prep scheduled" count becomes the actual people + times). */}
          {(prepCrewToday.length > 0 || prepNeed > 0) && (
            <section>
              <h2 className="mb-1.5 flex items-center gap-1.5 text-[13px] font-medium uppercase tracking-[0.1em] text-tertiary-text">
                <Users className="size-3.5" /> Warehouse / Prep · today
                {prepNeed > 0 && (
                  <span className="font-normal normal-case text-meta">
                    needs {prepNeed} · {prepCrewToday.length} scheduled in Connecteam
                  </span>
                )}
                {prepNeed === 0 && prepCrewToday.length > 0 && (
                  <span className="font-normal normal-case text-meta">({prepCrewToday.length} scheduled in Connecteam)</span>
                )}
              </h2>
              <div className="surface border border-border">
                {prepCrewToday.map((p) => (
                  <div key={p.name} className="flex items-center justify-between gap-3 border-t border-[var(--row-rule)] px-3 py-2.5 text-[13px] first:border-t-0">
                    <span className="min-w-0 truncate">
                      <span className="font-medium text-foreground">{p.name}</span>
                      {p.title && <span className="ml-1.5 text-[11px] text-meta">{p.title}</span>}
                    </span>
                    <span className="flex shrink-0 items-center gap-2 text-[12px] text-meta">
                      <span className="tabular-nums">{p.window}</span>
                      <span className="text-positive">Connecteam · scheduled</span>
                    </span>
                  </div>
                ))}
                {prepNeed > prepCrewToday.length && (
                  <div className="flex items-center justify-between gap-3 border-t border-[var(--row-rule)] px-3 py-2.5 text-[13px] first:border-t-0">
                    <span className="text-meta">
                      {prepNeed - prepCrewToday.length} more prep {prepNeed - prepCrewToday.length === 1 ? "person" : "people"} needed on the ground today
                    </span>
                    <span className="shrink-0 text-[12px] text-amber-300">unfilled</span>
                  </div>
                )}
              </div>
            </section>
          )}

          {/* Prep + other shifts not tied to a route (e.g. day-before warehouse prep, manual shifts). */}
          {otherShifts.length > 0 && (
            <section>
              <h2 className="mb-1.5 flex items-center gap-1.5 text-[13px] font-medium uppercase tracking-[0.1em] text-tertiary-text">
                <Users className="size-3.5" /> Prep &amp; other shifts
              </h2>
              <div className="surface border border-border">
                {otherShifts.map((s) => (
                  <OtherShiftRow key={s.id} shift={s} coverage={coverage[s.id]} nameOf={nameOf} onEdit={() => setEditing(s)} />
                ))}
              </div>
            </section>
          )}
        </div>
      )}

      {editing !== null && (
        <SidePanelOverlay onClose={() => setEditing(null)}>
          <ShiftEditor
            shift={editing === "new" ? null : editing}
            date={date}
            roster={roster}
            busyUserIds={busyUserIds}
            recommendations={editing !== "new" && editing ? recommendations[editing.id] ?? [] : []}
            onClose={() => setEditing(null)}
          />
        </SidePanelOverlay>
      )}

      {adding !== null && (
        <SidePanelOverlay onClose={() => setAdding(null)}>
          <AddWorkerPanel
            date={date}
            card={adding}
            shifts={shifts.filter((s) => s.routeId === adding.routeId)}
            roster={roster}
            busyUserIds={busyUserIds}
            recsByRole={routeRecs[adding.routeId] ?? {}}
            instawork={instawork}
            iwConfigured={iwConfigured}
            onClose={() => setAdding(null)}
          />
        </SidePanelOverlay>
      )}
    </>
  );
}

// ── Route card ────────────────────────────────────────────────────────────────
function RouteCard({
  card,
  shifts,
  coverage,
  nameOf,
  iwConfigured,
  onEdit,
  onAdd,
}: {
  card: RouteCardData;
  shifts: StaffShift[];
  coverage: Record<string, ShiftCoverage>;
  nameOf: (userId: number) => CrewMember | undefined;
  iwConfigured: boolean;
  onEdit: (s: StaffShift) => void;
  onAdd: () => void;
}): React.JSX.Element {
  const win = windowLabel(card.startTime, card.endTime, card.windowKnown);

  // People on the route: explicit internal assignees (deduped by userId), plus the Connecteam crew the
  // coverage engine auto-credits (scheduled that day, not explicitly assigned), plus the actual Instawork
  // workers from matched gigs. One list — not grouped by role.
  const seen = new Set<number>();
  const internal: { key: string; name: string; role: ShiftRole; title: string | null; status: StaffShift["status"] }[] = [];
  for (const s of shifts) {
    for (const uid of s.assignees) {
      if (seen.has(uid)) continue;
      seen.add(uid);
      const m = nameOf(uid);
      internal.push({ key: `a-${uid}`, name: m?.name ?? `#${uid}`, role: s.role, title: m?.title ?? null, status: s.status });
    }
  }
  const scheduledNames = new Map<string, ShiftRole>();
  for (const s of shifts) {
    const c = coverage[s.id];
    for (const n of c?.scheduledNames ?? []) if (!scheduledNames.has(n)) scheduledNames.set(n, s.role);
  }
  const gigWorkers = new Map<string, string>(); // name → position
  for (const g of card.gigs) for (const w of g.workers) if (!gigWorkers.has(w)) gigWorkers.set(w, g.position);

  // Remaining need per role (from coverage): "needs N more Driver".
  const needByRole = ROLE_ORDER.map((role) => {
    const roleShifts = shifts.filter((s) => s.role === role);
    if (roleShifts.length === 0) return null;
    const headcount = roleShifts.reduce((n, s) => n + s.headcount, 0);
    const covered = roleShifts.reduce((n, s) => n + (coverage[s.id]?.covered ?? s.assignees.length), 0);
    const gap = roleShifts.reduce((n, s) => n + (coverage[s.id]?.gap ?? shiftGap(s)), 0);
    return { role, headcount, covered, gap };
  }).filter((x): x is { role: ShiftRole; headcount: number; covered: number; gap: number } => x !== null);

  const totalGap = needByRole.reduce((n, r) => n + r.gap, 0);
  const booked = card.gigs.reduce((n, g) => n + g.filled, 0);
  const pending = card.gigs.reduce((n, g) => n + g.pending, 0);
  const peopleCount = internal.length + scheduledNames.size + gigWorkers.size;

  return (
    <div className="surface space-y-3 border border-border p-5">
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <span className="flex size-9 items-center justify-center rounded border border-border text-tertiary-text">
            <TruckIcon className="size-4" />
          </span>
          <div>
            <div className="text-[14px] font-medium">{card.truckName}</div>
            <div className="text-xs text-muted-foreground">
              {card.stopCount} stop{card.stopCount === 1 ? "" : "s"}
              {win ? ` · ${win}` : " · "}
              {!win && <span className="text-attention">Set time</span>}
            </div>
            {card.eventLabel && <div className="mt-0.5 text-[11.5px] text-meta">{card.eventLabel}</div>}
          </div>
        </div>
        <button onClick={onAdd} className={BTN + " shrink-0"}>
          <UserPlus className="size-3.5" /> Add worker
        </button>
      </div>

      {/* People on the route (one list, not grouped by role) */}
      {peopleCount === 0 ? (
        <p className="text-[12.5px] text-meta">No one assigned yet.</p>
      ) : (
        <ul className="space-y-1">
          {internal.map((p) => (
            <li key={p.key} className="flex items-center justify-between gap-2 text-[13px]">
              <span className="min-w-0 truncate">
                <span className="font-medium text-foreground">{p.name}</span>
                <span className="ml-1.5 text-[11px] text-meta">{ROLE_LABEL[p.role]}{p.title ? ` · ${p.title}` : ""}</span>
              </span>
              <span className="flex shrink-0 items-center gap-1.5">
                <span className="text-[11px] text-positive">Connecteam</span>
                {p.status !== "draft" && (
                  <span className="rounded border border-border px-1.5 py-px text-[10px] uppercase tracking-[0.06em] text-meta">{p.status}</span>
                )}
              </span>
            </li>
          ))}
          {[...scheduledNames].map(([name, role]) => (
            <li key={`s-${name}`} className="flex items-center justify-between gap-2 text-[13px]">
              <span className="min-w-0 truncate">
                <span className="font-medium text-foreground">{name}</span>
                <span className="ml-1.5 text-[11px] text-meta">{ROLE_LABEL[role]}</span>
              </span>
              <span className="shrink-0 text-[11px] text-positive">Connecteam · scheduled</span>
            </li>
          ))}
          {[...gigWorkers].map(([name, position]) => (
            <li key={`g-${name}`} className="flex items-center justify-between gap-2 text-[13px]">
              <span className="min-w-0 truncate">
                <span className="font-medium text-foreground">{name}</span>
                <span className="ml-1.5 text-[11px] text-meta">{position}</span>
              </span>
              <span className="shrink-0 text-[11px] text-attention">Instawork · booked</span>
            </li>
          ))}
        </ul>
      )}

      {/* Remaining need per role + Instawork gap */}
      {(needByRole.some((r) => r.gap > 0) || totalGap > 0) && (
        <div className="flex flex-wrap items-center gap-1.5 border-t border-[var(--row-rule)] pt-2.5">
          {needByRole
            .filter((r) => r.gap > 0)
            .map((r) => (
              <span key={r.role} className="rounded border border-attention/40 px-1.5 py-px text-[11px] text-attention">
                needs {r.gap} more {ROLE_LABEL[r.role]}
              </span>
            ))}
          {totalGap > 0 && (
            <span className="rounded border border-attention/40 px-1.5 py-px text-[11px] text-attention">
              Gap → Instawork: {totalGap}
            </span>
          )}
        </div>
      )}

      {/* Instawork context for the route */}
      {iwConfigured && card.gigs.length > 0 && (
        <p className="text-[11.5px] text-meta">
          Instawork (matched by day + role + time):{" "}
          <span className="text-positive">{booked} booked</span>
          {pending > 0 && <span className="text-attention"> · {pending} pending</span>}
          {" "}across {card.gigs.length} gig{card.gigs.length === 1 ? "" : "s"}.
        </p>
      )}

      {/* Role shift chips — click to edit a shift (ShiftEditor: time, headcount, publish, delete). */}
      <div className="flex flex-wrap items-center gap-1.5 border-t border-[var(--row-rule)] pt-2.5">
        <span className="text-[11px] uppercase tracking-[0.08em] text-meta">Shifts</span>
        {shifts.length === 0 ? (
          <span className="text-[12px] text-meta">none — use “Add worker”</span>
        ) : (
          ROLE_ORDER.filter((role) => shifts.some((s) => s.role === role)).map((role) => {
            const roleShifts = shifts.filter((s) => s.role === role);
            const headcount = roleShifts.reduce((n, s) => n + s.headcount, 0);
            return (
              <button
                key={role}
                onClick={() => onEdit(roleShifts[0])}
                className="rounded border border-border px-2 py-0.5 text-[12px] text-tertiary-text transition-colors hover:bg-[var(--row-hover)] hover:text-foreground"
              >
                {ROLE_LABEL[role]} ×{headcount}
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}

// ── Prep / other shift row ──────────────────────────────────────────────────────
function OtherShiftRow({
  shift,
  coverage,
  nameOf,
  onEdit,
}: {
  shift: StaffShift;
  coverage: ShiftCoverage | undefined;
  nameOf: (userId: number) => CrewMember | undefined;
  onEdit: () => void;
}): React.JSX.Element {
  const win = windowLabel(shift.startTime, shift.endTime, shift.windowKnown);
  const covered = coverage?.covered ?? shift.assignees.length;
  const gap = coverage?.gap ?? shiftGap(shift);
  const names = [...shift.assignees.map((u) => nameOf(u)?.name ?? `#${u}`), ...(coverage?.scheduledNames ?? [])];
  return (
    <button
      onClick={onEdit}
      className="flex w-full flex-wrap items-center justify-between gap-3 border-t border-[var(--row-rule)] px-3 py-2.5 text-left transition-colors first:border-t-0 hover:bg-[var(--row-hover)]"
    >
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[14px] font-medium text-foreground">{shift.eventLabel || ROLE_LABEL[shift.role]}</span>
          <span className="text-[11px] uppercase tracking-[0.06em] text-meta">{ROLE_LABEL[shift.role]}</span>
          <span className="text-[12px] tabular-nums text-meta">×{shift.headcount}</span>
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-3 text-[12px] text-meta">
          {win ? (
            <span className="tabular-nums">{win}</span>
          ) : (
            <span className="rounded border border-attention/40 px-1.5 py-px text-[11px] uppercase tracking-[0.05em] text-attention">Set time</span>
          )}
          {names.length > 0 && <span className="text-positive">{names.join(", ")}</span>}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <span className={`text-[13px] tabular-nums ${covered >= shift.headcount ? "text-positive" : "text-foreground"}`}>
          {covered}/{shift.headcount}
        </span>
        {gap > 0 && <span className="rounded border border-attention/40 px-1.5 py-px text-[11px] text-attention">Instawork: {gap}</span>}
      </div>
    </button>
  );
}
