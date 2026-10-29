"use client";

// Route staffing board — STRICT PER-FIELD COLUMNS (doc §16). Each route is a compact collapsed row with
// aligned columns [Route | Window | Required | Assigned | Gap | Readiness | Action] that EXPANDS to reveal
// the full detail (stops, the people on the route, the proposed plan, remaining need, Instawork context, the
// shift chips, and the Add-worker / Override controls). Required / Assigned / Gap come from the SHARED
// selector (lib/scheduling/routeStaffing.ts) — the same pre-check math Dispatch reads — so the two blades
// agree by construction. Readiness is the AUTHORITATIVE per-route readiness level (not derived from coverage).
//
// FACTS ONLY: a shift with no known window shows "Set time"; Instawork workers are the ACTUAL booked temp
// workers from matched gigs (never fabricated). The page HEADER now owns Auto Staff / Refresh / Add Shift
// (SchedulingHeaderActions); this board owns the per-route planning surface.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Loader2, Truck as TruckIcon, UserPlus, Users, ArrowRight, Wand2, MapPin, SlidersHorizontal, ChevronRight, Briefcase } from "lucide-react";
import { SidePanelOverlay } from "@/components/SidePanelOverlay";
import { ShiftEditor } from "@/components/scheduling/ShiftEditor";
import { AddWorkerPanel } from "@/components/scheduling/AddWorkerPanel";
import { OverridePanel } from "@/components/scheduling/OverridePanel";
import { StatusBadge } from "@/components/ui/status";
import { StatusMark } from "@/components/console-primitives";
import { STATUS_DOT } from "@/lib/tone";
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
import type { RouteStaffingState } from "@/lib/scheduling/routeStaffing";
import type { RoleCount } from "@/lib/scheduling/preCheck";

export type { WorkerDayEligibilityData } from "@/lib/scheduling/eligibilityLabel";

const BTN =
  "inline-flex items-center gap-1.5 rounded border border-border px-3 py-1.5 text-[12.5px] text-tertiary-text transition-colors hover:bg-[var(--row-hover)] hover:text-foreground disabled:opacity-50 disabled:pointer-events-none";

/** A compact stop descriptor surfaced on the route card (from the Route already in hand — no new fetch). */
export interface RouteStopBrief {
  custName: string;
  kind: "delivery" | "pickup";
  address: string | null;
}

export const ROLE_LABEL: Record<ShiftRole, string> = { driver: "Driver", field: "Field", prep: "Prep", office: "Office" };
const ROLE_SHORT: Record<ShiftRole, string> = { driver: "Drv", field: "Fld", prep: "Prp", office: "Off" };
// ROUTE/WAREHOUSE crew roles only — "office" is non-crew and never appears in the route grid or chips.
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
  readiness: ShiftReadinessLevel | null; // worst readiness across the route's shifts (authoritative)
  /** Shared-selector staffing state (Required / Assigned / Gap) — the same math Dispatch reads. */
  staffing: RouteStaffingState;
  /** This route has a two-way-sync conflict awaiting review (drives the "Resolve Sync" action). */
  hasSyncConflict: boolean;
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

// Column template shared by the header and every row, so the per-field columns line up exactly.
const COLS = "grid grid-cols-[minmax(170px,1.5fr)_120px_118px_118px_96px_104px_132px] items-center gap-3";

// Readiness level → shared StatusBadge tone. UNVERIFIED is "requires review" (attention), not a false red.
const READINESS_BADGE: Record<ShiftReadinessLevel, { label: string; tone: "positive" | "critical" | "attention" }> = {
  READY: { label: "Ready", tone: "positive" },
  BLOCKED: { label: "Blocked", tone: "critical" },
  UNVERIFIED: { label: "Unverified", tone: "attention" },
};

/** Render a RoleCount as compact role chips (driver + field). Counts stay FOREGROUND (never tinted); a
 *  small attention indicator dot carries the "this is a gap" state when `attention` is set (Nocturne rule:
 *  the number is a figure, the colour lives on an indicator). */
function RoleCounts({ counts, attention = false }: { counts: RoleCount; attention?: boolean }): React.JSX.Element {
  const roles: ShiftRole[] = ["driver", "field"];
  const nonZero = roles.filter((r) => counts[r as "driver" | "field"] > 0);
  if (nonZero.length === 0) return <span className="text-[12px] text-meta">—</span>;
  return (
    <span className="flex flex-wrap items-center gap-1" title={nonZero.map((r) => `${counts[r as "driver" | "field"]} ${ROLE_LABEL[r]}`).join(", ")}>
      {attention && <span className={`size-1.5 shrink-0 rounded-full ${STATUS_DOT.attention}`} aria-hidden />}
      {nonZero.map((r) => (
        <span key={r} className="tabular-nums text-[12.5px] text-foreground">
          {counts[r as "driver" | "field"]} {ROLE_SHORT[r]}
        </span>
      ))}
    </span>
  );
}

/** The single contextual action for a collapsed row (doc §16). */
function rowAction(card: RouteCardData): { label: string; kind: "add" | "expand" | "sync" } {
  const s = card.staffing;
  if (s.requiresCrew && s.nobody) return { label: "Assign Worker", kind: "add" };
  if (s.totalGap > 0) return { label: "Fill Gap", kind: "add" };
  if (card.hasSyncConflict) return { label: "Resolve Sync", kind: "sync" };
  if (card.readiness && card.readiness !== "READY") return { label: "Review Readiness", kind: "expand" };
  return { label: "View Details", kind: "expand" };
}

export function RouteStaffBoard({
  date,
  routeCards,
  shifts,
  otherShifts,
  officeShifts,
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
  /** Office/admin shifts (role "office") — NON-CREW, shown in their own section, never route crew. */
  officeShifts: StaffShift[];
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
  const [editing, setEditing] = useState<StaffShift | null>(null);
  const [adding, setAdding] = useState<RouteCardData | null>(null);
  const [overriding, setOverriding] = useState<RouteCardData | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const nameOf = (userId: number): CrewMember | undefined => roster.find((m) => m.userId === userId);
  const toggle = (routeId: string): void =>
    setExpanded((cur) => {
      const next = new Set(cur);
      if (next.has(routeId)) next.delete(routeId);
      else next.add(routeId);
      return next;
    });

  return (
    <>
      {!hasRoutes && (
        <p className="mb-4 rounded border border-border bg-[var(--row-hover)]/40 px-3 py-2.5 text-[12.5px] text-tertiary-text">
          No routes for this day — pull routes first, or add a shift from the header.
        </p>
      )}

      {routeCards.length === 0 && otherShifts.length === 0 && officeShifts.length === 0 && prepCrewToday.length === 0 && prepNeed === 0 ? (
        <p className="text-[13px] text-meta">No shifts built for this day yet.</p>
      ) : (
        <div className="space-y-6">
          {/* Route staffing board — strict per-field columns, one row per route; click to expand. */}
          {routeCards.length > 0 && (
            <section className="overflow-x-auto rounded-lg border border-border" aria-label="Route staffing board">
              <div className="min-w-[940px]">
                {/* Column header */}
                <div className={`${COLS} border-b border-border bg-background px-4 py-2 text-[10.5px] font-medium uppercase tracking-[0.08em] text-meta`}>
                  <span>Route</span>
                  <span>Window</span>
                  <span>Required</span>
                  <span>Assigned</span>
                  <span>Gap</span>
                  <span>Readiness</span>
                  <span className="text-right">Action</span>
                </div>
                {routeCards.map((rc) => (
                  <RouteRow
                    key={rc.routeId}
                    card={rc}
                    expanded={expanded.has(rc.routeId)}
                    onToggle={() => toggle(rc.routeId)}
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
              </div>
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

          {/* Office / admin shifts — people scheduled in Connecteam who are NOT route crew (Operations
              Coordinator, Executive Assistant, Digital Sales Marketer, managers). Shown for awareness so
              they are visibly scheduled that day, but never counted as coverage and never route-assignable. */}
          {officeShifts.length > 0 && (
            <section>
              <h2 className="mb-1.5 flex items-center gap-1.5 text-[13px] font-medium uppercase tracking-[0.1em] text-tertiary-text">
                <Briefcase className="size-3.5" /> Office / admin
                <span className="font-normal normal-case text-meta">(not route crew)</span>
              </h2>
              <div className="surface border border-border">
                {officeShifts.map((s) => (
                  <OfficeShiftRow key={s.id} shift={s} nameOf={nameOf} onEdit={() => setEditing(s)} />
                ))}
              </div>
            </section>
          )}
        </div>
      )}

      {editing !== null && (
        <SidePanelOverlay onClose={() => setEditing(null)}>
          <ShiftEditor
            shift={editing}
            date={date}
            roster={roster}
            eligibilityData={eligibilityData}
            recommendations={recommendations[editing.id] ?? []}
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

// ── Route row (collapsed per-field columns + expandable detail) ──────────────────────────────────
function RouteRow({
  card,
  expanded,
  onToggle,
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
  expanded: boolean;
  onToggle: () => void;
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
  const s = card.staffing;
  const action = rowAction(card);

  function onAction(): void {
    if (action.kind === "add") onAdd();
    else if (action.kind === "sync") document.getElementById("sync-conflicts")?.scrollIntoView({ behavior: "smooth", block: "start" });
    else if (!expanded) onToggle();
  }

  return (
    <div className="border-t border-[var(--row-rule)] first:border-t-0">
      {/* Collapsed row — click anywhere (except the action) to expand. */}
      <div
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        onClick={onToggle}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onToggle(); } }}
        className={`${COLS} cursor-pointer px-4 py-2.5 text-[13px] transition-colors hover:bg-[var(--row-hover)] ${expanded ? "bg-[var(--row-hover)]/60" : ""}`}
      >
        {/* Route (vehicle + id) */}
        <span className="flex min-w-0 items-center gap-2">
          <ChevronRight className={`size-3.5 shrink-0 text-meta transition-transform ${expanded ? "rotate-90" : ""}`} aria-hidden />
          <TruckIcon className="size-4 shrink-0 text-tertiary-text" aria-hidden />
          <span className="min-w-0">
            <span className="block truncate font-medium text-foreground">{card.truckName}</span>
            <span className="block truncate text-[11px] text-meta">
              {card.stopCount} stop{card.stopCount === 1 ? "" : "s"}
              {card.eventLabel ? ` · ${card.eventLabel}` : ""}
            </span>
          </span>
        </span>

        {/* Window (ET) */}
        <span className="tabular-nums text-[12.5px]">
          {win ? win : <StatusMark tone="attention" label="Set time" />}
        </span>

        {/* Required (by role) */}
        <RoleCounts counts={s.requiredByRole} />

        {/* Assigned (actual) */}
        <RoleCounts counts={s.assignedByRole} />

        {/* Gap (unfilled) */}
        <span>
          {s.totalGap > 0 ? <RoleCounts counts={s.gapByRole} attention /> : <StatusMark tone="positive" label="None" />}
        </span>

        {/* Readiness (authoritative) */}
        <span>
          {card.readiness ? (
            <StatusBadge tone={READINESS_BADGE[card.readiness].tone} size="sm">{READINESS_BADGE[card.readiness].label}</StatusBadge>
          ) : (
            <span className="text-[11px] text-meta">—</span>
          )}
        </span>

        {/* Action (contextual) */}
        <span className="flex justify-end">
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onAction(); }}
            className="inline-flex items-center gap-1 rounded border border-border px-2.5 py-1 text-[11.5px] text-tertiary-text transition-colors hover:bg-[var(--row-hover)] hover:text-foreground"
          >
            {action.label}
          </button>
        </span>
      </div>

      {/* Expanded detail — the full existing route detail. */}
      {expanded && (
        <RouteDetail
          card={card}
          shifts={shifts}
          coverage={coverage}
          proposed={proposed}
          nameOf={nameOf}
          iwConfigured={iwConfigured}
          onEdit={onEdit}
          onAdd={onAdd}
          onOverride={onOverride}
        />
      )}
    </div>
  );
}

// ── Expanded route detail (preserves all prior RouteCard functionality) ──────────────────────────
function RouteDetail({
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
  const deliveries = card.stops.filter((st) => st.kind === "delivery").length;
  const pickups = card.stops.filter((st) => st.kind === "pickup").length;
  const firstVenue = card.stops.find((st) => st.address || st.custName) ?? null;

  // People on the route: explicit internal assignees (deduped), the Connecteam crew the coverage engine
  // auto-credits, and the actual Instawork workers from matched gigs. One list — not grouped by role.
  const seen = new Set<number>();
  const internal: { key: string; name: string; role: ShiftRole; title: string | null; status: StaffShift["status"] }[] = [];
  for (const sh of shifts) {
    for (const uid of sh.assignees) {
      if (seen.has(uid)) continue;
      seen.add(uid);
      const m = nameOf(uid);
      internal.push({ key: `a-${uid}`, name: m?.name ?? `#${uid}`, role: sh.role, title: m?.title ?? null, status: sh.status });
    }
  }
  const scheduledNames = new Map<string, ShiftRole>();
  for (const sh of shifts) {
    const c = coverage[sh.id];
    for (const n of c?.scheduledNames ?? []) if (!scheduledNames.has(n)) scheduledNames.set(n, sh.role);
  }
  const gigWorkers = new Map<string, string>(); // name → position
  for (const g of card.gigs) for (const w of g.workers) if (!gigWorkers.has(w)) gigWorkers.set(w, g.position);

  // Remaining need per role (from coverage): "needs N more Driver".
  const needByRole = ROLE_ORDER.map((role) => {
    const roleShifts = shifts.filter((sh) => sh.role === role);
    if (roleShifts.length === 0) return null;
    const headcount = roleShifts.reduce((n, sh) => n + sh.headcount, 0);
    const covered = roleShifts.reduce((n, sh) => n + (coverage[sh.id]?.covered ?? sh.assignees.length), 0);
    const gap = roleShifts.reduce((n, sh) => n + (coverage[sh.id]?.gap ?? shiftGap(sh)), 0);
    return { role, headcount, covered, gap };
  }).filter((x): x is { role: ShiftRole; headcount: number; covered: number; gap: number } => x !== null);

  const totalGap = needByRole.reduce((n, r) => n + r.gap, 0);
  const booked = card.gigs.reduce((n, g) => n + g.filled, 0);
  const pending = card.gigs.reduce((n, g) => n + g.pending, 0);
  const peopleCount = internal.length + scheduledNames.size + gigWorkers.size;

  return (
    <div className="space-y-3 border-t border-[var(--row-rule)] bg-[var(--row-hover)]/20 px-4 py-4">
      {/* Stops / destination + per-route actions */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 text-xs text-muted-foreground">
          {(deliveries > 0 || pickups > 0) && (
            <span>
              {deliveries > 0 ? `${deliveries} delivery` : ""}
              {deliveries > 0 && pickups > 0 ? ", " : ""}
              {pickups > 0 ? `${pickups} pickup` : ""}
            </span>
          )}
          {firstVenue && (firstVenue.address || firstVenue.custName) && (
            <div className="mt-0.5 flex items-center gap-1 truncate text-[11px] text-meta">
              <MapPin className="size-3 shrink-0" />
              <span className="truncate">{firstVenue.address || firstVenue.custName}</span>
            </div>
          )}
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
                <StatusMark tone="positive" label="Connecteam" />
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
              <span className="shrink-0"><StatusMark tone="positive" label="Connecteam · scheduled" /></span>
            </li>
          ))}
          {[...gigWorkers].map(([name, position]) => (
            <li key={`g-${name}`} className="flex items-center justify-between gap-2 text-[13px]">
              <span className="min-w-0 truncate">
                <span className="font-medium text-foreground">{name}</span>
                <span className="ml-1.5 text-[11px] text-meta">{position}</span>
              </span>
              <span className="shrink-0"><StatusMark tone="attention" label="Instawork · booked" /></span>
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
                    <StatusMark tone="positive" label={p.name} />
                    <span className="text-[10.5px] uppercase tracking-[0.05em] text-meta">{ROLE_LABEL[p.role]}</span>
                    {p.moved && <span className="text-[10.5px] text-meta">moved here</span>}
                  </>
                ) : (
                  <>
                    <StatusMark tone="attention" label="Open seat" />
                    <span className="text-[10.5px] uppercase tracking-[0.05em] text-meta">{ROLE_LABEL[p.role]} · Instawork</span>
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
              <StatusBadge key={r.role} tone="attention" size="sm">needs {r.gap} more {ROLE_LABEL[r.role]}</StatusBadge>
            ))}
          {totalGap > 0 && <StatusBadge tone="attention" size="sm">Gap to Instawork: {totalGap}</StatusBadge>}
        </div>
      )}

      {/* Instawork context for the route */}
      {iwConfigured && card.gigs.length > 0 && (
        <p className="text-[11.5px] text-meta">
          Instawork (matched by day + role + time):{" "}
          <span className="text-foreground">{booked} booked</span>
          {pending > 0 && <span className="text-foreground"> · {pending} pending</span>}
          {" "}across {card.gigs.length} gig{card.gigs.length === 1 ? "" : "s"}.
        </p>
      )}

      {/* Role shift chips — click to edit a shift (ShiftEditor: time, headcount, publish, delete). */}
      <div className="flex flex-wrap items-center gap-1.5 border-t border-[var(--row-rule)] pt-2.5">
        <span className="text-[11px] uppercase tracking-[0.08em] text-meta">Shifts</span>
        {shifts.length === 0 ? (
          <span className="text-[12px] text-meta">none — use “Add worker”</span>
        ) : (
          ROLE_ORDER.filter((role) => shifts.some((sh) => sh.role === role)).map((role) => {
            const roleShifts = shifts.filter((sh) => sh.role === role);
            const headcount = roleShifts.reduce((n, sh) => n + sh.headcount, 0);
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

// ── Warehouse / Prep section ────────────────────────────────────────────────────
// Day-level warehouse crew (prep isn't route-tied). Shows who's on the ground today + the day's prep need,
// and lets the dispatcher MOVE a warehouse person onto a route as a field helper: picks a route → assigns
// them to that route's field shift (creating it if needed). The moved person then renders on the route
// card and drops out of this list, so pulling someone off warehouse shows as a prep shortfall here — the
// honest tradeoff, surfaced rather than hidden.
// Move-eligibility fit → shared StatusMark tone (coloured indicator + crisp label, never tinted text).
const FIT_MARK: Record<MoveFit, "positive" | "attention" | "idle"> = {
  "good-fit": "positive",
  "exceeds-availability": "attention",
  "qualification-mismatch": "idle",
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
                <StatusMark tone="positive" label="Connecteam · scheduled" />
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
                        {need > 0 && <span className="text-meta">needs {need}</span>}
                        {elig && <StatusMark tone={FIT_MARK[elig.fit]} label={elig.label} />}
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
            <span className="shrink-0"><StatusMark tone="attention" label="Unfilled" /></span>
          </div>
        )}
      </div>
      {error && <p className="mt-2 text-[12.5px] text-critical">{error}</p>}
    </section>
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
        <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-meta">
          {win ? (
            <span className="tabular-nums">{win}</span>
          ) : (
            <StatusMark tone="attention" label="Set time" />
          )}
          {names.length > 0 && <span className="text-foreground">{names.join(", ")}</span>}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <span className="inline-flex items-center gap-1.5 text-[13px] tabular-nums text-foreground">
          {covered >= shift.headcount && <span className={`size-1.5 shrink-0 rounded-full ${STATUS_DOT.positive}`} aria-hidden />}
          {covered}/{shift.headcount}
        </span>
        {gap > 0 && <StatusBadge tone="attention" size="sm">Instawork: {gap}</StatusBadge>}
      </div>
    </button>
  );
}

// ── Office / admin shift row (NON-CREW) ──────────────────────────────────────────
// An office/admin person scheduled in Connecteam. Deliberately shows NO coverage / gap / Instawork framing
// (they are not a route or warehouse seat): just who is scheduled and when, so the day's schedule is honest
// without ever implying they staff a route. Clickable to edit the underlying shift like the others.
function OfficeShiftRow({
  shift,
  nameOf,
  onEdit,
}: {
  shift: StaffShift;
  nameOf: (userId: number) => CrewMember | undefined;
  onEdit: () => void;
}): React.JSX.Element {
  const win = windowLabel(shift.startTime, shift.endTime, shift.windowKnown);
  const names = shift.assignees.map((u) => nameOf(u)?.name ?? `#${u}`);
  return (
    <button
      onClick={onEdit}
      className="flex w-full flex-wrap items-center justify-between gap-3 border-t border-[var(--row-rule)] px-3 py-2.5 text-left transition-colors first:border-t-0 hover:bg-[var(--row-hover)]"
    >
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[14px] font-medium text-foreground">{shift.eventLabel || (names.length > 0 ? names.join(", ") : "Office / admin")}</span>
          <span className="text-[11px] uppercase tracking-[0.06em] text-meta">Office</span>
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-3 text-[12px] text-meta">
          {win ? <span className="tabular-nums">{win}</span> : <span className="text-meta">Time not set</span>}
          {shift.eventLabel && names.length > 0 && <span>{names.join(", ")}</span>}
        </div>
      </div>
      <span className="shrink-0 text-[11px] text-meta">Not route crew</span>
    </button>
  );
}
