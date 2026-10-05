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
import { toast } from "sonner";
import { Loader2, RefreshCw, Plus, Truck as TruckIcon, UserPlus, Users, ArrowRight, Wand2, MapPin, SlidersHorizontal } from "lucide-react";
import { SidePanelOverlay } from "@/components/SidePanelOverlay";
import { ShiftEditor } from "@/components/scheduling/ShiftEditor";
import { AddWorkerPanel } from "@/components/scheduling/AddWorkerPanel";
import { OverridePanel } from "@/components/scheduling/OverridePanel";
import type { CrewMember } from "@/lib/connecteam";
import { formatClockTime } from "@/lib/dates";
import { shiftGap, type ShiftRole, type StaffShift } from "@/lib/scheduling/types";
import type { ShiftCoverage } from "@/lib/scheduling/coverage";
import type { CrewRecommendation } from "@/lib/scheduling/availability";
import type { PlannedAssignment } from "@/lib/scheduling/optimize";
import type { ShiftReadinessLevel } from "@/lib/scheduling/readiness";
import type { MoveEligibility, MoveFit } from "@/lib/scheduling/planView";
import type { WorkerDayEligibilityData } from "@/lib/scheduling/eligibilityLabel";
import type { InstaworkRoleSummary } from "@/lib/instawork/reconcile";

export type { WorkerDayEligibilityData } from "@/lib/scheduling/eligibilityLabel";

const BTN =
  "inline-flex items-center gap-1.5 rounded border border-border px-3 py-1.5 text-[12.5px] text-tertiary-text transition-colors hover:bg-[var(--row-hover)] hover:text-foreground disabled:opacity-50 disabled:pointer-events-none";
const PRIMARY =
  "inline-flex items-center gap-1.5 rounded border border-foreground bg-foreground/[0.08] px-3.5 py-1.5 text-[12.5px] font-medium text-foreground transition-colors hover:bg-foreground/[0.14] disabled:opacity-50 disabled:pointer-events-none";

/** A compact stop descriptor surfaced on the route card (from the Route already in hand — no new fetch). */
export interface RouteStopBrief {
  custName: string;
  kind: "delivery" | "pickup";
  address: string | null;
}

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
  stops: RouteStopBrief[]; // the route's stops (customer/kind/address) for a richer card
  readiness: ShiftReadinessLevel | null; // worst readiness across the route's shifts (day-of chip)
}

export type RouteRecs = Record<string, Partial<Record<ShiftRole, CrewRecommendation[]>>>;

/** A warehouse/prep person scheduled this day (Connecteam) — carries userId so they can be moved to a route. */
export interface PrepPerson {
  userId: number;
  name: string;
  title: string | null;
  window: string;
}

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
  eligibilityData,
  coverage,
  recommendations,
  routeRecs,
  prepCrewToday,
  prepNeed,
  routeFieldNeed,
  proposedByRoute,
  moveEligibilityByPerson,
  instawork,
  iwConfigured,
  hasRoutes,
}: {
  date: string;
  routeCards: RouteCardData[];
  shifts: StaffShift[];
  otherShifts: StaffShift[];
  roster: CrewMember[];
  eligibilityData: WorkerDayEligibilityData;
  coverage: Record<string, ShiftCoverage>;
  recommendations: Record<string, CrewRecommendation[]>;
  routeRecs: RouteRecs;
  prepCrewToday: PrepPerson[];
  prepNeed: number;
  routeFieldNeed: Record<string, number>;
  proposedByRoute: Record<string, PlannedAssignment[]>;
  moveEligibilityByPerson: Record<number, Record<string, MoveEligibility>>;
  instawork: Record<ShiftRole, InstaworkRoleSummary> | null;
  iwConfigured: boolean;
  hasRoutes: boolean;
}): React.JSX.Element {
  const router = useRouter();
  const [generating, setGenerating] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [editing, setEditing] = useState<StaffShift | "new" | null>(null);
  const [adding, setAdding] = useState<RouteCardData | null>(null);
  const [overriding, setOverriding] = useState<RouteCardData | null>(null);

  const nameOf = (userId: number): CrewMember | undefined => roster.find((m) => m.userId === userId);

  // AUTO STAFF (propose): refresh demand from routes, then let the server recompute + render the proposed
  // optimizer plan. This PROPOSES only; committing is the dispatcher's explicit Approve in the plan card.
  async function autoStaff(): Promise<void> {
    setGenerating(true);
    setNote(null);
    try {
      const res = await fetch("/api/scheduling/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date }),
      });
      const j = (await res.json()) as { shifts?: StaffShift[]; note?: string };
      if (!res.ok) setNote("Couldn't build the plan from routes.");
      else if (j.note === "no routes") setNote("No routes for this day — nothing to build.");
      else setNote(`Proposed a plan over ${j.shifts?.length ?? 0} shift${(j.shifts?.length ?? 0) === 1 ? "" : "s"}. Review and approve below.`);
      router.refresh();
      // Scroll to the proposed plan once it has rendered (it sits above the board).
      setTimeout(() => document.getElementById("staffing-plan")?.scrollIntoView({ behavior: "smooth", block: "start" }), 350);
    } catch {
      setNote("Couldn't build the plan from routes.");
    } finally {
      setGenerating(false);
    }
  }

  return (
    <>
      {/* Toolbar — AUTO STAFF is the headline action (propose the best internal-first plan). */}
      <div className="mb-1.5 flex flex-wrap items-center gap-2">
        <button onClick={autoStaff} disabled={generating} className={PRIMARY} title="Build the day's demand from routes and propose the best internal-first plan. Review and approve to commit.">
          {generating ? <Loader2 className="size-3.5 animate-spin" /> : <Wand2 className="size-3.5" />} Auto staff
        </button>
        <button onClick={autoStaff} disabled={generating} className={BTN} title="Rebuild demand from the latest routes.">
          <RefreshCw className="size-3.5" /> Refresh from routes
        </button>
        <button onClick={() => setEditing("new")} className={BTN}>
          <Plus className="size-3.5" /> Add shift
        </button>
        {note && <span className="text-[12px] text-meta">{note}</span>}
      </div>
      <p className="mb-4 text-[11.5px] text-meta">
        Auto staff proposes an internal-first plan for the day. It never commits on its own — you approve it in the proposed-plan card.
      </p>

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
                  proposed={proposedByRoute[rc.routeId] ?? []}
                  nameOf={nameOf}
                  iwConfigured={iwConfigured}
                  onEdit={(s) => setEditing(s)}
                  onAdd={() => setAdding(rc)}
                  onOverride={() => setOverriding(rc)}
                />
              ))}
            </section>
          )}

          {/* Warehouse / Prep crew scheduled in Connecteam today — prep isn't route-tied, so it's shown at
              the day level (this is where the "N prep scheduled" count becomes the actual people + times). */}
          {(prepCrewToday.length > 0 || prepNeed > 0) && (
            <WarehousePrepSection
              date={date}
              prepCrew={prepCrewToday}
              prepNeed={prepNeed}
              routes={routeCards}
              routeFieldNeed={routeFieldNeed}
              moveEligibilityByPerson={moveEligibilityByPerson}
              shifts={shifts}
            />
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
            eligibilityData={eligibilityData}
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
            eligibilityData={eligibilityData}
            recsByRole={routeRecs[adding.routeId] ?? {}}
            instawork={instawork}
            iwConfigured={iwConfigured}
            onClose={() => setAdding(null)}
          />
        </SidePanelOverlay>
      )}

      {overriding !== null && (
        <SidePanelOverlay onClose={() => setOverriding(null)}>
          <OverridePanel
            date={date}
            card={overriding}
            shifts={shifts.filter((s) => s.routeId === overriding.routeId)}
            roster={roster}
            recsByRole={routeRecs[overriding.routeId] ?? {}}
            routeOptions={routeCards.filter((r) => r.routeId !== overriding.routeId)}
            onClose={() => setOverriding(null)}
          />
        </SidePanelOverlay>
      )}
    </>
  );
}

// ── Warehouse / Prep section ────────────────────────────────────────────────────
// Day-level warehouse crew (prep isn't route-tied). Shows who's on the ground today + the day's prep need,
// and lets the dispatcher MOVE a warehouse person onto a route as a field helper: picks a route → assigns
// them to that route's field shift (creating it if needed). The moved person then renders on the route
// card and drops out of this list, so pulling someone off warehouse shows as a prep shortfall here — the
// honest tradeoff, surfaced rather than hidden.
const FIT_TONE: Record<MoveFit, string> = {
  "good-fit": "text-positive",
  "exceeds-availability": "text-attention",
  "qualification-mismatch": "text-meta",
};

function WarehousePrepSection({
  date,
  prepCrew,
  prepNeed,
  routes,
  routeFieldNeed,
  moveEligibilityByPerson,
  shifts,
}: {
  date: string;
  prepCrew: PrepPerson[];
  prepNeed: number;
  routes: RouteCardData[];
  routeFieldNeed: Record<string, number>;
  moveEligibilityByPerson: Record<number, Record<string, MoveEligibility>>;
  shifts: StaffShift[];
}): React.JSX.Element {
  const router = useRouter();
  const [openFor, setOpenFor] = useState<number | null>(null); // userId whose route picker is open
  const [working, setWorking] = useState<number | null>(null); // userId being moved
  const [error, setError] = useState<string | null>(null);
  const shortfall = prepNeed - prepCrew.length;

  // Routes to offer, field-need-first so the dispatcher sees where a helper is actually wanted.
  const routeOptions = [...routes].sort((a, b) => (routeFieldNeed[b.routeId] ?? 0) - (routeFieldNeed[a.routeId] ?? 0));

  async function moveToRoute(person: PrepPerson, route: RouteCardData): Promise<void> {
    setWorking(person.userId);
    setError(null);
    try {
      // Attach to the route's existing field shift, or create one.
      let shift = shifts.find((s) => s.routeId === route.routeId && s.role === "field") ?? null;
      if (!shift) {
        const res = await fetch("/api/scheduling/shift", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            date,
            role: "field",
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
        if (!res.ok) { setError("Couldn't create the route shift. Try again."); return; }
        shift = ((await res.json()) as { shift?: StaffShift }).shift ?? null;
        if (!shift) { setError("Couldn't create the route shift. Try again."); return; }
      }
      const nextAssignees = shift.assignees.includes(person.userId) ? shift.assignees : [...shift.assignees, person.userId];
      const nextHeadcount = Math.max(shift.headcount, nextAssignees.length);
      const res = await fetch(`/api/scheduling/shift/${shift.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assignees: nextAssignees, headcount: nextHeadcount }),
      });
      if (!res.ok) { setError("Couldn't move to the route. Try again."); return; }
      toast.success(`${person.name} moved to ${route.truckName} as a field helper`);
      setOpenFor(null);
      router.refresh();
    } catch {
      setError("Couldn't move — try again.");
    } finally {
      setWorking(null);
    }
  }

  return (
    <section>
      <h2 className="mb-1.5 flex items-center gap-1.5 text-[13px] font-medium uppercase tracking-[0.1em] text-tertiary-text">
        <Users className="size-3.5" /> Warehouse / Prep · today
        {prepNeed > 0 ? (
          <span className="font-normal normal-case text-meta">
            needs {prepNeed} · {prepCrew.length} scheduled in Connecteam
          </span>
        ) : (
          prepCrew.length > 0 && <span className="font-normal normal-case text-meta">({prepCrew.length} scheduled in Connecteam)</span>
        )}
      </h2>
      <div className="surface border border-border">
        {prepCrew.map((p) => (
          <div key={p.userId} className="border-t border-[var(--row-rule)] px-3 py-2.5 text-[13px] first:border-t-0">
            <div className="flex items-center justify-between gap-3">
              <span className="min-w-0 truncate">
                <span className="font-medium text-foreground">{p.name}</span>
                {p.title && <span className="ml-1.5 text-[11px] text-meta">{p.title}</span>}
              </span>
              <span className="flex shrink-0 items-center gap-2.5 text-[12px] text-meta">
                <span className="tabular-nums">{p.window}</span>
                <span className="text-positive">Connecteam · scheduled</span>
                {routeOptions.length > 0 && (
                  <button
                    type="button"
                    disabled={working !== null}
                    onClick={() => setOpenFor((u) => (u === p.userId ? null : p.userId))}
                    className="inline-flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[11px] text-tertiary-text transition-colors hover:bg-[var(--row-hover)] hover:text-foreground disabled:opacity-50"
                  >
                    {working === p.userId ? <Loader2 className="size-3 animate-spin" /> : <ArrowRight className="size-3" />} Move to a route
                  </button>
                )}
              </span>
            </div>
            {openFor === p.userId && (
              <div className="mt-2 rounded border border-border bg-[var(--row-hover)]/40 p-2">
                <p className="mb-1.5 text-[11px] uppercase tracking-[0.06em] text-meta">Move {p.name} to a route as a field helper</p>
                <div className="flex flex-wrap gap-1.5">
                  {routeOptions.map((r) => {
                    const need = routeFieldNeed[r.routeId] ?? 0;
                    const elig = moveEligibilityByPerson[p.userId]?.[r.routeId];
                    const ok = !elig || elig.fit === "good-fit";
                    return (
                      <button
                        key={r.routeId}
                        type="button"
                        disabled={working !== null || !ok}
                        title={elig ? elig.label : undefined}
                        onClick={() => moveToRoute(p, r)}
                        className="inline-flex items-center gap-1.5 rounded border border-border px-2 py-1 text-[12px] text-tertiary-text transition-colors hover:bg-[var(--row-hover)] hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        <TruckIcon className="size-3" /> {r.truckName}
                        {need > 0 && <span className="text-attention">needs {need}</span>}
                        {elig && <span className={FIT_TONE[elig.fit]}>{elig.label}</span>}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        ))}
        {shortfall > 0 && (
          <div className="flex items-center justify-between gap-3 border-t border-[var(--row-rule)] px-3 py-2.5 text-[13px] first:border-t-0">
            <span className="text-meta">
              {shortfall} more prep {shortfall === 1 ? "person" : "people"} needed on the ground today
            </span>
            <span className="shrink-0 text-[12px] text-amber-300">unfilled</span>
          </div>
        )}
      </div>
      {error && <p className="mt-2 text-[12.5px] text-critical">{error}</p>}
    </section>
  );
}

const READINESS_CHIP: Record<ShiftReadinessLevel, { label: string; cls: string }> = {
  READY: { label: "Ready", cls: "border-positive/40 text-positive" },
  BLOCKED: { label: "Blocked", cls: "border-critical/50 text-critical" },
  UNVERIFIED: { label: "Unverified", cls: "border-attention/40 text-attention" },
};

// ── Route card ────────────────────────────────────────────────────────────────
function RouteCard({
  card,
  shifts,
  coverage,
  proposed,
  nameOf,
  iwConfigured,
  onEdit,
  onAdd,
  onOverride,
}: {
  card: RouteCardData;
  shifts: StaffShift[];
  coverage: Record<string, ShiftCoverage>;
  proposed: PlannedAssignment[];
  nameOf: (userId: number) => CrewMember | undefined;
  iwConfigured: boolean;
  onEdit: (s: StaffShift) => void;
  onAdd: () => void;
  onOverride: () => void;
}): React.JSX.Element {
  const win = windowLabel(card.startTime, card.endTime, card.windowKnown);
  const deliveries = card.stops.filter((s) => s.kind === "delivery").length;
  const pickups = card.stops.filter((s) => s.kind === "pickup").length;
  const firstVenue = card.stops.find((s) => s.address || s.custName) ?? null;

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
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="flex size-9 shrink-0 items-center justify-center rounded border border-border text-tertiary-text">
            <TruckIcon className="size-4" />
          </span>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-[14px] font-medium">{card.truckName}</span>
              {card.readiness && (
                <span className={`rounded border px-1.5 py-px text-[10px] font-medium uppercase tracking-[0.06em] ${READINESS_CHIP[card.readiness].cls}`}>
                  {READINESS_CHIP[card.readiness].label}
                </span>
              )}
            </div>
            <div className="text-xs text-muted-foreground">
              {card.stopCount} stop{card.stopCount === 1 ? "" : "s"}
              {(deliveries > 0 || pickups > 0) && (
                <span>
                  {" "}({deliveries > 0 ? `${deliveries} delivery` : ""}
                  {deliveries > 0 && pickups > 0 ? ", " : ""}
                  {pickups > 0 ? `${pickups} pickup` : ""})
                </span>
              )}
              {win ? ` · ${win}` : " · "}
              {!win && <span className="text-attention">Set time</span>}
            </div>
            {card.eventLabel && <div className="mt-0.5 truncate text-[11.5px] text-meta">{card.eventLabel}</div>}
            {firstVenue && (firstVenue.address || firstVenue.custName) && (
              <div className="mt-0.5 flex items-center gap-1 truncate text-[11px] text-meta">
                <MapPin className="size-3 shrink-0" />
                <span className="truncate">{firstVenue.address || firstVenue.custName}</span>
              </div>
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <button onClick={onAdd} className={BTN}>
            <UserPlus className="size-3.5" /> Add worker
          </button>
          <button onClick={onOverride} className={BTN} title="Override the plan: remove, replace, move or assign a worker (reason required).">
            <SlidersHorizontal className="size-3.5" /> Override
          </button>
        </div>
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

      {/* Proposed plan overlay — what Auto staff would place on this route (internal ✓ / open ○). */}
      {proposed.length > 0 && (
        <div className="border-t border-[var(--row-rule)] pt-2.5">
          <div className="mb-1 flex items-center gap-1.5 text-[11px] uppercase tracking-[0.08em] text-meta">
            <Wand2 className="size-3" /> Proposed
            <span className="font-normal normal-case">
              {proposed.filter((p) => p.kind === "internal").length} internal / {proposed.length} seat{proposed.length === 1 ? "" : "s"}
            </span>
          </div>
          <ul className="space-y-0.5">
            {proposed.map((p, i) => (
              <li
                key={`${p.shiftId}-${i}`}
                title={p.kind === "temp" ? p.whyTemp ?? "" : p.whyThisRoute}
                className="flex items-center gap-1.5 text-[12px]"
              >
                {p.kind === "internal" ? (
                  <>
                    <span className="text-positive">&#10003;</span>
                    <span className="truncate text-foreground">{p.name}</span>
                    <span className="text-[10.5px] uppercase tracking-[0.05em] text-meta">{ROLE_LABEL[p.role]}</span>
                    {p.moved && <span className="text-[10.5px] text-attention">moved here</span>}
                  </>
                ) : (
                  <>
                    <span className="text-attention">&#9675;</span>
                    <span className="text-meta">Open seat</span>
                    <span className="text-[10.5px] uppercase tracking-[0.05em] text-attention">{ROLE_LABEL[p.role]} · Instawork</span>
                  </>
                )}
              </li>
            ))}
          </ul>
        </div>
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
