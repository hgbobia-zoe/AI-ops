// Dispatch — the back-office route EXECUTION workspace (Nocturne redesign). Route/vehicle execution is
// FIRST: a compact PageHeader (title + operational date + readable summary + primary Pull action +
// compact route-source freshness), a 4-tile operational metric row, a staffing-readiness summary, the
// scheduled time board, and the compact single-column route list that expands inline. Exceptions are
// summarised by affected route + severity (individual evidence preserved); the message feed is SCOPED to
// stops on today's board (general sales chatter links out to Communications instead). Live fleet access
// (Ignition) stays contextual — no fake map, no fabricated GPS. Every prior action is preserved — stop
// complete/reopen/remove, quote review, driver assign, route resync/remove/close/reopen, proof-of-delivery,
// open-exception resolve, pull, auto-assign, re-sync, date navigation. Auto-refreshes so it stays live.

import { Truck, MessageSquare, ExternalLink, Users, ArrowRight } from "lucide-react";
import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { AutoRefresh } from "@/components/AutoRefresh";
import { ResolveExceptionButton } from "@/components/ResolveExceptionButton";
import { DatePicker } from "@/components/DatePicker";
import {
  getOpenExceptions,
  getRecentMessages,
  getRoutesForDate,
  getNextRouteDate,
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
import { getPullState } from "@/lib/pull/state";
import type { Route } from "@/lib/types";
import { BladeMain } from "@/components/ui/layouts";
import { PageHeader } from "@/components/ui/page-header";
import { Metric, MetricGrid } from "@/components/ui/metric";
import { StatusBadge } from "@/components/ui/status";
import { StatusBanner, EmptyState, ErrorState, StaleBadge } from "@/components/ui/states";
import { STATUS_DOT } from "@/lib/tone";
import {
  scopeDispatchMessages,
  summarizeExceptionsByRoute,
  routePullFreshness,
  messageStatusTone,
  exceptionSeverity,
  type RouteRef,
} from "@/lib/dispatch/boardView";
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
  const overdue = findRouteHealthIssues();
  const canClose = canManageSettings(await viewerRole());
  return (
    <BladeMain>
      {overdue.length > 0 && <OverdueRoutesBanner issues={overdue} canClose={canClose} />}
      {/* Operational Opportunity: tomorrow's prep window (reads the OPPORTUNITY risk findings). */}
      <PrepWindowCallout />
      <DispatchBoard date={date} today={today} />
    </BladeMain>
  );
}

function OverdueRoutesBanner({ issues, canClose }: { issues: ReturnType<typeof findRouteHealthIssues>; canClose: boolean }): React.JSX.Element {
  return (
    <StatusBanner
      tone="critical"
      className="mb-4"
      title={`${issues.length} route${issues.length === 1 ? "" : "s"} still open past the delivery date — needs action`}
      action={canClose ? <ClosePastRoutesButton count={issues.length} /> : undefined}
    >
      <ul className="space-y-1">
        {issues.slice(0, 8).map((i) => {
          const n = i.incompleteStops.length;
          return (
            <li key={i.routeId} className="flex flex-wrap items-baseline gap-x-2">
              <Link href={`/dispatch?date=${i.date}`} className="font-medium text-foreground underline underline-offset-2 hover:opacity-80">{i.truckLabel}</Link>
              <span className="text-meta">{i.date} · {i.daysOverdue}d overdue{i.driverName ? ` · ${i.driverName}` : ""}</span>
              <span className="text-secondary-text">{n === 0 ? "route not closed" : `${n}/${i.totalStops} stop${n === 1 ? "" : "s"} not completed`}</span>
            </li>
          );
        })}
        {issues.length > 8 && <li className="text-meta">…and {issues.length - 8} more.</li>}
      </ul>
    </StatusBanner>
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
  const ignitionUrl = getSettings().ignitionUrl;
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

  // Route-source freshness (honest): most recent route pull across the active trucks.
  const fresh = routePullFreshness(getPullState().sources, trucks.map((t) => t.truckId));

  const summary = isToday
    ? `${withRoute.length} route${withRoute.length === 1 ? "" : "s"} · ${doneStops}/${allStops.length} stops done`
    : isFuture
      ? `${withRoute.length} route${withRoute.length === 1 ? "" : "s"} planned`
      : `${withRoute.length} route${withRoute.length === 1 ? "" : "s"} · history`;

  return (
    <div className="w-full space-y-5">
      {isToday && <AutoRefresh seconds={15} />}

      <PageHeader
        icon={<Truck className="size-5" />}
        title="Dispatch"
        subtitle={
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-secondary-text">{isToday ? `Today · ${formatYmdLong(date)}` : formatYmdLong(date)}</span>
            <span aria-hidden>·</span>
            <span>{summary}</span>
            <span aria-hidden>·</span>
            <SourceFreshness fresh={fresh} />
          </span>
        }
        actions={
          <>
            <PullRoutesButton />
            {/* Global (all-routes) ops actions — supervisors only, and only for today/future (not history).
                Re-sync all also needs at least one route to force onto. */}
            {canSupervise && !(date < today) && withRoute.length > 0 && (
              <ResyncAllButton routeIds={withRoute.map((f) => f.route!.routeId)} />
            )}
            {canSupervise && !(date < today) && <AutoAssignButton date={date} />}
            <DateNav date={date} today={today} />
          </>
        }
      />

      {/* 4-tile operational row — values stay neutral; colour lives on the small status dot. */}
      <MetricGrid>
        <Metric label="Routes" value={withRoute.length} sub={`${trucks.length} active trucks`} />
        <Metric label="Stops done" value={`${doneStops}/${allStops.length}`} sub={isToday ? "today" : formatYmdLong(date)} />
        <Metric
          label="Exec exceptions"
          value={isToday ? exceptions.length : "—"}
          tone={!isToday ? undefined : exceptions.length ? "critical" : "positive"}
          sub={isToday ? (exceptions.length ? "open" : "all clear") : "today only"}
        />
        <Metric
          label="Drivers"
          value={`${driversAssigned}/${staffing.routesRequiringCrew}`}
          tone={staffing.routesRequiringCrew === 0 ? undefined : driversAssigned < staffing.routesRequiringCrew ? "attention" : "positive"}
          sub="assigned / required"
        />
      </MetricGrid>

      {/* Staffing summary — distinct from execution exceptions. Numbers come from the shared selector. */}
      <StaffingSummary summary={staffing} date={date} />

      {/* Empty-day — DISTINGUISH no data retrieved (never pulled) from a verified empty schedule. */}
      {withRoute.length === 0 && (
        fresh.everPulled ? (
          <EmptyState
            icon={<Truck className="size-6" />}
            title={`No routes scheduled for ${isToday ? "today" : formatYmdLong(date)}`}
            body="Route data is current — nothing is on the schedule for this day."
            action={<NextOperationalDay date={date} />}
          />
        ) : (
          <ErrorState
            tone="attention"
            title="No route data retrieved"
            body="Routes have not been pulled from Goodshuffle yet. Start the Auto-Pull on the office machine, or pull now."
            action={<PullRoutesButton />}
          />
        )
      )}

      {/* Contextual live-fleet access — a link out to Ignition, never a fake in-app map or GPS pin. */}
      {ignitionUrl && (
        <div className="flex justify-end">
          <a
            href={ignitionUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 rounded border border-border px-3 py-1.5 text-[12px] text-tertiary-text transition-colors hover:bg-row-hover hover:text-foreground"
          >
            <ExternalLink className="size-3.5" /> Live fleet: open Ignition
          </a>
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
          {/* Open execution exceptions — summarised by affected route + severity; evidence preserved. */}
          <ExceptionsByRoute exceptions={exceptions} routeViews={routeViews} truckName={truckName} />

          {/* Route-scoped messages — only comms tied to a stop on today's board; general chatter links out. */}
          <RouteMessages messages={messages} routeViews={routeViews} />

          {/* Compact AI activity + approvals access (replaces the oversized top-of-page AI strip). */}
          <BladeAgents blade="dispatch" />
        </>
      )}
    </div>
  );
}

/** Compact route-source freshness for the header. Honest: never-pulled and stale read differently from
 *  fresh, and no timestamp is faked. */
function SourceFreshness({ fresh }: { fresh: ReturnType<typeof routePullFreshness> }): React.JSX.Element {
  if (!fresh.everPulled) return <StaleBadge>Routes not pulled yet</StaleBadge>;
  const h = fresh.ageHours ?? 0;
  const rel = h < 1 ? "under 1h ago" : h < 48 ? `${Math.round(h)}h ago` : `${Math.round(h / 24)}d ago`;
  if (fresh.stale) return <StaleBadge>{`Routes synced ${rel} (stale)`}</StaleBadge>;
  return <span className="text-meta">Routes synced {rel}</span>;
}

/** The next calendar day with routes, linked — or an honest note that none is scheduled ahead. */
function NextOperationalDay({ date }: { date: string }): React.JSX.Element {
  const next = getNextRouteDate(date);
  if (!next) return <span className="text-[12px] text-meta">No upcoming routes scheduled.</span>;
  return (
    <Link
      href={`/dispatch?date=${next}`}
      className="inline-flex items-center gap-1.5 rounded border border-border px-3 py-1.5 text-[12px] text-tertiary-text transition-colors hover:bg-row-hover hover:text-foreground"
    >
      Next scheduled day: {formatYmdLong(next)} <ArrowRight className="size-3.5" />
    </Link>
  );
}

function StaffingSummary({ summary, date }: { summary: ReturnType<typeof getDayStaffingSummary>; date: string }): React.JSX.Element | null {
  if (summary.routesRequiringCrew === 0) return null;
  const gaps = summary.routesWithGap;
  const gapRoutes = summary.routes.filter((s) => s.requiresCrew && s.status === "gap");
  // Find Staffing opens Scheduling; when exactly one route has a gap, focus it directly.
  const focus = gapRoutes.length === 1 ? `&focus=${encodeURIComponent(gapRoutes[0].routeId)}` : "";
  return (
    <section className="surface flex flex-wrap items-center gap-x-5 gap-y-2 border border-border px-4 py-2.5">
      <span className="text-[11px] font-semibold uppercase tracking-[0.1em] text-meta">Staffing</span>
      <StatusBadge tone={gaps === 0 ? "positive" : "attention"} size="sm">
        {summary.routesCovered}/{summary.routesRequiringCrew} routes covered
      </StatusBadge>
      <span className="inline-flex items-center gap-1.5 text-[12.5px] text-secondary-text">
        <span className={`size-2 shrink-0 rounded-full ${gaps > 0 ? STATUS_DOT.attention : STATUS_DOT.neutral}`} aria-hidden />
        {gaps} staffing gap{gaps === 1 ? "" : "s"}
      </span>
      <span className="text-[12.5px] text-meta">
        {summary.confirmationsKnown ? `${summary.pendingConfirmations} confirmation${summary.pendingConfirmations === 1 ? "" : "s"} pending` : "Confirmations unverified"}
      </span>
      <Link
        href={`/scheduling?date=${date}${focus}`}
        className="ml-auto inline-flex items-center gap-1.5 rounded border border-border px-2.5 py-1 text-[11.5px] text-tertiary-text transition-colors hover:bg-row-hover hover:text-foreground"
      >
        <Users className="size-3.5" /> Find staffing →
      </Link>
    </section>
  );
}

/** Exceptions summarised by affected route + severity. Individual evidence (reason, time, resolve) is
 *  preserved under each group — the summary never collapses the raw records away. */
function ExceptionsByRoute({
  exceptions,
  routeViews,
  truckName,
}: {
  exceptions: ReturnType<typeof getOpenExceptions>;
  routeViews: DispatchRouteView[];
  truckName: (id: string | null) => string;
}): React.JSX.Element {
  const routes: RouteRef[] = routeViews.map((r) => ({
    routeId: r.routeId,
    truckId: r.truckId,
    truckName: r.truckName,
    stopIds: r.stops.map((s) => s.stopId),
  }));
  const groups = summarizeExceptionsByRoute(exceptions, routes);
  return (
    <section className="space-y-2">
      <h2 className="text-[15px] font-semibold">Open execution exceptions</h2>
      {exceptions.length === 0 ? (
        <p className="text-sm text-meta">None. All clear.</p>
      ) : (
        <div className="space-y-3">
          {groups.map((g) => (
            <div key={g.routeId ?? "__unassigned__"} className="surface border border-border">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-rule px-3 py-2">
                <span className="text-[13px] font-medium">{g.truckName}</span>
                {g.critical > 0 && <StatusBadge tone="critical" size="sm">{g.critical} critical</StatusBadge>}
                {g.attention > 0 && <StatusBadge tone="attention" size="sm">{g.attention} needs review</StatusBadge>}
              </div>
              <ul className="divide-y divide-[var(--row-rule)]">
                {g.items.map((x) => (
                  <li key={x.exceptionId} className="flex items-start gap-3 px-3 py-2.5 text-sm">
                    {(() => {
                      const { tone } = exceptionSeverity(x.type);
                      return <span className={`mt-1.5 size-2 shrink-0 rounded-full ${STATUS_DOT[tone]}`} aria-hidden />;
                    })()}
                    <div className="min-w-0 flex-1">
                      <div className="font-medium">{truckName(x.truckId)} · {x.type}</div>
                      {x.reason && <div className="text-secondary-text">{x.reason}</div>}
                      <div className="text-xs text-meta">{fmtTime(x.ts)}</div>
                    </div>
                    <ResolveExceptionButton exceptionId={x.exceptionId} />
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

/** Route-scoped message feed. Only messages tied to a stop on today's board appear here; everything else
 *  (general sales follow-ups, off-board stops) is kept OUT and surfaced as a count that links to
 *  Communications — so route execution isn't polluted by unrelated chatter. */
function RouteMessages({
  messages,
  routeViews,
}: {
  messages: ReturnType<typeof getRecentMessages>;
  routeViews: DispatchRouteView[];
}): React.JSX.Element {
  const routeStopIds = new Set(routeViews.flatMap((r) => r.stops.map((s) => s.stopId)));
  const { scoped, generalCount } = scopeDispatchMessages(messages, routeStopIds);
  return (
    <section className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-[15px] font-semibold">Route messages</h2>
        <Link href="/communications" className="text-[12px] text-meta underline-offset-2 hover:text-foreground hover:underline">
          All communications →
        </Link>
      </div>
      {scoped.length === 0 ? (
        <p className="text-sm text-meta">No route-scoped messages{generalCount > 0 ? " on today's board" : ""} yet.</p>
      ) : (
        <div className="surface divide-y divide-[var(--row-rule)] border border-border">
          {scoped.map((m, i) => (
            <details key={i} className="group [&_summary]:list-none">
              <summary className="flex cursor-pointer items-center gap-3 p-3 text-sm hover:bg-row-hover">
                <MessageSquare className="size-4 shrink-0 text-meta transition-transform group-open:rotate-90" />
                <span className="w-36 shrink-0 truncate text-secondary-text" title={m.toPhone ?? undefined}>
                  {m.recipientName ?? m.toPhone}
                </span>
                <span className="flex-1 truncate group-open:hidden">{m.body}</span>
                <span className="hidden flex-1 group-open:inline">&nbsp;</span>
                <span className="w-32 shrink-0 text-right text-xs tabular-nums text-meta">{fmtTime(m.sentAt)}</span>
                <StatusBadge tone={messageStatusTone(m.status)} size="sm">{m.status ?? "—"}</StatusBadge>
              </summary>
              <div className="whitespace-pre-wrap px-3 pb-3 pl-10 text-sm">{m.body}</div>
            </details>
          ))}
        </div>
      )}
      {generalCount > 0 && (
        <p className="text-[12px] text-meta">
          {generalCount} other message{generalCount === 1 ? "" : "s"} not tied to a route on this board (general / sales).{" "}
          <Link href="/communications" className="underline underline-offset-2 hover:text-foreground">View in Communications →</Link>
        </p>
      )}
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
      <Link href={href(prev)} aria-label="Previous day" className="flex size-9 items-center justify-center rounded-lg border border-border text-meta hover:text-foreground">
        <ChevronLeft className="size-4" />
      </Link>
      <DatePicker date={date} today={today} basePath="/dispatch" />
      <Link href={href(next)} aria-label="Next day" className="flex size-9 items-center justify-center rounded-lg border border-border text-meta hover:text-foreground">
        <ChevronRight className="size-4" />
      </Link>
      {!isToday && (
        <Link href="/dispatch" className="ml-1 rounded-lg border border-border px-2.5 py-1.5 text-sm text-meta hover:text-foreground">
          Today
        </Link>
      )}
    </div>
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
