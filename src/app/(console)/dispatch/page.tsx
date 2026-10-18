// Dispatch — the back-office route EXECUTION board. Redesigned: a compact header, a 4-metric operational
// row, a staffing-readiness summary (distinct from execution exceptions), the scheduled time board, and a
// COMPACT single-column route list that expands inline (replacing the old big 2-column cards). Every prior
// action is preserved — stop complete/reopen/remove, quote review, driver assign, route resync/remove/close/
// reopen, proof-of-delivery, open exceptions, and the outbound message log. Auto-refreshes so it stays live.

import { AlertTriangle, MessageSquare, ExternalLink, Users } from "lucide-react";
import { AutoRefresh } from "@/components/AutoRefresh";
import { ResolveExceptionButton } from "@/components/ResolveExceptionButton";
import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { DatePicker } from "@/components/DatePicker";
import {
  getOpenExceptions,
  getRecentMessages,
  getRoutesForDate,
} from "@/lib/db/repo";
import { findRouteHealthIssues } from "@/lib/dispatch/routeHealth";
import { ClosePastRoutesButton } from "@/components/ClosePastRoutesButton";
import { PullRoutesButton } from "@/components/PullRoutesButton";
import { ResyncAllButton } from "@/components/ResyncAllButton";
import { AutoAssignButton } from "@/components/AutoAssignButton";
import { viewerRole } from "@/lib/auth/getSession";
import { canManageSettings } from "@/lib/auth/roles";
import { DISPLAY_TZ, todayInOpsTz, shiftYmd, formatYmdLong } from "@/lib/dates";
import { reviewStopAddress } from "@/lib/addressReview";
import { getSettings } from "@/lib/settings";
import { getActiveVehicles } from "@/lib/vehicles";
import type { Route } from "@/lib/types";
import { FigureStrip, type Figure } from "@/components/console-primitives";
import { BladeAgents } from "@/components/aiorg/BladeAgents";
import { PrepWindowCallout } from "@/components/PrepWindowCallout";
import { getDayStaffingSummary, type RouteStaffingState } from "@/lib/scheduling/routeStaffing";
import {
  DispatchExecution,
  type DispatchRouteView,
  type DispatchStopView,
  type NoRouteTruck,
} from "@/components/dispatch/DispatchExecution";

export const dynamic = "force-dynamic";

export default async function DispatchPage({
  searchParams,
}: {
  searchParams: Promise<{ date?: string }>;
}) {
  const sp = await searchParams;
  const today = todayInOpsTz();
  const date = sp?.date && /^\d{4}-\d{2}-\d{2}$/.test(sp.date) ? sp.date : today;
  const ignitionUrl = getSettings().ignitionUrl;
  const overdue = findRouteHealthIssues();
  const canClose = canManageSettings(await viewerRole());
  return (
    <main className="p-6">
      <BladeAgents blade="dispatch" className="mb-4" />
      {ignitionUrl && (
        <a
          href={ignitionUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="mb-4 inline-flex items-center gap-1.5 rounded border border-border px-3 py-1.5 text-[12.5px] text-tertiary-text transition-colors hover:bg-[var(--row-hover)] hover:text-foreground"
        >
          <ExternalLink className="size-3.5" /> Open Ignition (live fleet)
        </a>
      )}
      {overdue.length > 0 && <OverdueRoutesBanner issues={overdue} canClose={canClose} />}
      {/* Operational Opportunity: tomorrow's prep window (reads the OPPORTUNITY risk findings). */}
      <PrepWindowCallout />
      <DispatchBoard date={date} today={today} />
    </main>
  );
}

function OverdueRoutesBanner({ issues, canClose }: { issues: ReturnType<typeof findRouteHealthIssues>; canClose: boolean }): React.JSX.Element {
  return (
    <div className="mb-4 rounded border border-rose-500/40 bg-rose-500/[0.08] p-3 text-rose-100">
      <div className="flex flex-wrap items-center gap-2 text-[13px] font-semibold">
        <AlertTriangle className="size-4 shrink-0" />
        {issues.length} route{issues.length === 1 ? "" : "s"} still open past the delivery date — needs action
        {canClose && <span className="ml-auto"><ClosePastRoutesButton count={issues.length} /></span>}
      </div>
      <ul className="mt-2 space-y-1 text-[12.5px]">
        {issues.slice(0, 8).map((i) => {
          const n = i.incompleteStops.length;
          return (
            <li key={i.routeId} className="flex flex-wrap items-baseline gap-x-2">
              <Link href={`/dispatch?date=${i.date}`} className="font-medium underline underline-offset-2 hover:opacity-80">{i.truckLabel}</Link>
              <span className="text-rose-200/80">{i.date} · {i.daysOverdue}d overdue{i.driverName ? ` · ${i.driverName}` : ""}</span>
              <span className="text-rose-100">{n === 0 ? "route not closed" : `${n}/${i.totalStops} stop${n === 1 ? "" : "s"} not completed`}</span>
            </li>
          );
        })}
        {issues.length > 8 && <li className="text-rose-200/70">…and {issues.length - 8} more.</li>}
      </ul>
    </div>
  );
}

/** Build the serializable per-route view for the client execution list, computing address review + proof
 *  on the server (keeps the pure classifiers off the client). Staffing comes from the shared selector. */
function toRouteView(route: Route, staffing: RouteStaffingState, exceptionsForRoute: number): DispatchRouteView {
  const stops: DispatchStopView[] = route.stops.map((s) => {
    const finished = s.state === "Completed" || s.state === "Returned";
    const addr = reviewStopAddress({ address: s.address, name: s.custName, whenIso: s.plannedWindow || s.eta });
    return {
      stopId: s.stopId,
      sequence: s.sequence,
      custName: s.custName,
      kind: s.kind ?? "delivery",
      state: s.state,
      address: s.address,
      dayOfName: s.dayOfName ?? null,
      dayOfPhone: s.dayOfPhone ?? null,
      plannedWindow: s.plannedWindow ?? null,
      eta: s.eta ?? null,
      photoIds: s.photoIds ?? [],
      signatureId: s.signatureId ?? null,
      addrClass: addr.class,
      addrHoursRisk: addr.hoursRisk,
      addrNote: addr.note,
      finished,
      canPull: route.status !== "done" && !finished,
    } satisfies DispatchStopView;
  });
  const done = route.stops.filter((s) => s.state === "Completed" || s.state === "Returned").length;
  return {
    routeId: route.routeId,
    truckId: route.truckId,
    truckName: staffing.truckName,
    status: route.status,
    date: route.date,
    driverName: route.driverName ?? null,
    done,
    total: route.stops.length,
    items: route.stops.flatMap((s) => s.items ?? []).map((i) => ({ name: i.name, quantity: i.quantity })),
    executionExceptions: exceptionsForRoute,
    stops,
    staffing,
  } satisfies DispatchRouteView;
}

/** A trivial "closed" staffing state for a done route (not part of the live staffing summary). */
function closedStaffing(route: Route): RouteStaffingState {
  const zero = { driver: 0, field: 0 };
  return {
    requiredByRole: zero, assignedByRole: zero, gapByRole: zero, totalGap: 0, nobody: false, status: "ok", reason: "Closed",
    routeId: route.routeId, truckId: route.truckId, truckName: route.truckId, requiresCrew: false,
    hasDriver: Boolean(route.driverName), driverName: route.driverName ?? null,
    pendingConfirmations: 0, confirmationsKnown: false, label: "Route closed",
  };
}

async function DispatchBoard({ date, today }: { date: string; today: string }) {
  // Shift Pass (guest) holders drive a read-mostly board: they can mark stops complete, but the
  // supervisor controls (assign driver, close/reopen a route, reopen/remove a stop) are hidden.
  const canSupervise = (await viewerRole()) !== "guest";
  const trucks = getActiveVehicles();
  const fleet = trucks.flatMap((t) => {
    const routes = getRoutesForDate(t.truckId, date);
    return routes.length > 0 ? routes.map((route) => ({ truck: t, route })) : [{ truck: t, route: null as Route | null }];
  });
  const truckHasOpenRoute = new Set(fleet.filter((f) => f.route && f.route.status !== "done").map((f) => f.truck.truckId));
  const isSuperseded = (f: { truck: { truckId: string }; route: Route | null }): boolean =>
    Boolean(f.route) && f.route!.status === "done" && truckHasOpenRoute.has(f.truck.truckId);
  const primaryFleet = fleet.filter((f) => !isSuperseded(f));
  const supersededFleet = fleet.filter(isSuperseded);

  const isToday = date === today;
  const isFuture = date > today;
  const exceptions = isToday ? getOpenExceptions() : [];
  const messages = isToday ? getRecentMessages(30) : [];

  const truckName = (id: string | null) => trucks.find((t) => t.truckId === id)?.name ?? id ?? "—";

  // ── Shared, authoritative staffing state (same engine Scheduling's pre-check uses — they agree). ──
  const staffing = getDayStaffingSummary(date);
  const staffingByRoute = new Map(staffing.routes.map((s) => [s.routeId, s]));

  const withRoute = primaryFleet.filter((f) => f.route);
  const allStops = withRoute.flatMap((f) => f.route!.stops);
  const doneStops = allStops.filter((s) => s.state === "Completed" || s.state === "Returned").length;
  const driversAssigned = staffing.routes.filter((s) => s.requiresCrew && s.hasDriver).length;

  // Per-route execution exception count (matched by the route's own stops, or truck for route-level ones).
  const exceptionsForRoute = (route: Route): number => {
    const ids = new Set(route.stops.map((s) => s.stopId));
    return exceptions.filter((x) => (x.stopId && ids.has(x.stopId)) || (!x.stopId && x.truckId === route.truckId)).length;
  };

  const viewFor = (route: Route): DispatchRouteView =>
    toRouteView(route, staffingByRoute.get(route.routeId) ?? closedStaffing(route), exceptionsForRoute(route));

  const routeViews = withRoute.map((f) => viewFor(f.route!));
  const supersededViews = supersededFleet.filter((f) => f.route).map((f) => viewFor(f.route!));
  const noRouteTrucks: NoRouteTruck[] = primaryFleet.filter((f) => !f.route).map((f) => ({ truckId: f.truck.truckId, truckName: f.truck.name }));

  const figures: Figure[] = [
    { label: "Routes", value: withRoute.length },
    { label: "Stops done", value: `${doneStops}/${allStops.length}` },
    { label: "Exec exceptions", value: exceptions.length, tone: exceptions.length ? "critical" : "default" },
    { label: "Drivers", value: `${driversAssigned}/${staffing.routesRequiringCrew}`, tone: driversAssigned < staffing.routesRequiringCrew ? "attention" : "default", sep: true },
  ];

  return (
    <div className="w-full space-y-5">
      {isToday && <AutoRefresh seconds={15} />}

      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-[22px] font-medium tracking-tight">Dispatch</h1>
          <p className="text-[12.5px] text-meta">
            Live route execution · {trucks.length} trucks · {isToday ? "refreshes automatically" : isFuture ? "upcoming — planning view" : "history view"}
          </p>
        </div>
        <div className="flex items-end gap-6">
          <FigureStrip figures={figures} />
          <div className="flex items-center gap-2">
            <PullRoutesButton />
            {/* Global (all-routes) ops actions — supervisors only, and only for today/future (not history).
                Re-sync all also needs at least one route to force onto. */}
            {canSupervise && !(date < today) && withRoute.length > 0 && (
              <ResyncAllButton routeIds={withRoute.map((f) => f.route!.routeId)} />
            )}
            {canSupervise && !(date < today) && <AutoAssignButton date={date} />}
            <DateNav date={date} today={today} />
          </div>
        </div>
      </header>

      {/* Staffing summary — subordinate to the ops metrics, but surfaces staffing problems distinctly from
          execution exceptions. The numbers come from the shared selector (agree with Scheduling). */}
      <StaffingSummary summary={staffing} date={date} />

      {withRoute.length === 0 && (
        <div className="rounded border border-border bg-panel p-4 text-sm text-muted-foreground">
          No routes scheduled for {isToday ? "today" : formatYmdLong(date)}.
        </div>
      )}

      <DispatchExecution
        routes={routeViews}
        superseded={supersededViews}
        noRouteTrucks={noRouteTrucks}
        isToday={isToday}
        canSupervise={canSupervise}
      />

      {isToday && (
        <>
          {/* Open execution exceptions */}
          <section className="space-y-2">
            <h2 className="text-[15px] font-semibold">Open execution exceptions</h2>
            {exceptions.length === 0 ? (
              <p className="text-sm text-muted-foreground">None. All clear.</p>
            ) : (
              <div className="space-y-2">
                {exceptions.map((x) => (
                  <div key={x.exceptionId} className="flex items-start gap-3 rounded border border-border bg-panel p-3 text-sm">
                    <AlertTriangle className="mt-0.5 size-4 shrink-0 text-critical" />
                    <div className="min-w-0 flex-1">
                      <div className="font-medium">{truckName(x.truckId)} · {x.type}</div>
                      {x.reason && <div className="text-muted-foreground">{x.reason}</div>}
                      <div className="text-xs text-muted-foreground">{fmtTime(x.ts)}</div>
                    </div>
                    <ResolveExceptionButton exceptionId={x.exceptionId} />
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* Recent customer messages */}
          <section className="space-y-2">
            <h2 className="text-[15px] font-semibold">Recent messages</h2>
            {messages.length === 0 ? (
              <p className="text-sm text-muted-foreground">No messages sent yet.</p>
            ) : (
              <div className="divide-y divide-[var(--row-rule)] rounded border border-border">
                {messages.map((m, i) => (
                  <details key={i} className="group [&_summary]:list-none">
                    <summary className="flex cursor-pointer items-center gap-3 p-3 text-sm hover:bg-panel">
                      <MessageSquare className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-90" />
                      <span className="w-36 shrink-0 truncate text-muted-foreground" title={m.toPhone ?? undefined}>
                        {m.recipientName ?? m.toPhone}
                      </span>
                      <span className="flex-1 truncate group-open:hidden">{m.body}</span>
                      <span className="hidden flex-1 group-open:inline">&nbsp;</span>
                      <span className="w-32 shrink-0 text-right text-xs tabular-nums text-muted-foreground">{fmtTime(m.sentAt)}</span>
                      <StatusTag status={m.status} />
                    </summary>
                    <div className="whitespace-pre-wrap px-3 pb-3 pl-10 text-sm">{m.body}</div>
                  </details>
                ))}
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}

function StaffingSummary({ summary, date }: { summary: ReturnType<typeof getDayStaffingSummary>; date: string }): React.JSX.Element | null {
  if (summary.routesRequiringCrew === 0) return null;
  const gaps = summary.routesWithGap;
  const gapRoutes = summary.routes.filter((s) => s.requiresCrew && s.status === "gap");
  // Find Staffing opens Scheduling; when exactly one route has a gap, focus it directly.
  const focus = gapRoutes.length === 1 ? `&focus=${encodeURIComponent(gapRoutes[0].routeId)}` : "";
  return (
    <section className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded border border-border bg-panel px-4 py-2.5">
      <span className="text-[11px] font-semibold uppercase tracking-[0.1em] text-meta">Staffing</span>
      <span className="inline-flex items-center gap-1.5 text-[12.5px]">
        <span className={`size-2 rounded-full ${gaps === 0 ? "bg-positive" : "bg-attention"}`} />
        {summary.routesCovered}/{summary.routesRequiringCrew} routes covered
      </span>
      <span className={`text-[12.5px] ${gaps > 0 ? "text-attention" : "text-meta"}`}>
        {gaps} staffing gap{gaps === 1 ? "" : "s"}
      </span>
      <span className="text-[12.5px] text-meta">
        {summary.confirmationsKnown ? `${summary.pendingConfirmations} confirmation${summary.pendingConfirmations === 1 ? "" : "s"} pending` : "Confirmations unverified"}
      </span>
      <Link
        href={`/scheduling?date=${date}${focus}`}
        className="ml-auto inline-flex items-center gap-1.5 rounded border border-border px-2.5 py-1 text-[11.5px] text-tertiary-text transition-colors hover:bg-[var(--row-hover)] hover:text-foreground"
      >
        <Users className="size-3.5" /> Find staffing →
      </Link>
    </section>
  );
}

function DateNav({ date, today }: { date: string; today: string }) {
  const prev = shiftYmd(date, -1);
  const next = shiftYmd(date, 1);
  const isToday = date === today;
  const href = (d: string) => (d === today ? "/dispatch" : `/dispatch?date=${d}`);
  return (
    <div className="flex items-center gap-1.5">
      <Link href={href(prev)} aria-label="Previous day" className="flex size-9 items-center justify-center rounded-lg border border-border text-muted-foreground hover:text-foreground">
        <ChevronLeft className="size-4" />
      </Link>
      <DatePicker date={date} today={today} basePath="/dispatch" />
      <Link href={href(next)} aria-label="Next day" className="flex size-9 items-center justify-center rounded-lg border border-border text-muted-foreground hover:text-foreground">
        <ChevronRight className="size-4" />
      </Link>
      {!isToday && (
        <Link href="/dispatch" className="ml-1 rounded-lg border border-border px-2.5 py-1.5 text-sm text-muted-foreground hover:text-foreground">
          Today
        </Link>
      )}
    </div>
  );
}

function StatusTag({ status }: { status: string | null }) {
  const label = status ?? "—";
  return (
    <span className="shrink-0 rounded bg-[var(--row-hover)] px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
      {label}
    </span>
  );
}

function fmtTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString("en-US", {
      timeZone: DISPLAY_TZ,
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}
