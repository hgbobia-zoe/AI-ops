// Dispatch dashboard — the back-office view. Read-mostly: every truck's live route
// and progress, the current stop, open exceptions, the outbound message log, and
// proof-of-delivery photos/signatures. One supervisor action: reopen a completed
// stop (guarded). Auto-refreshes so it stays live.

import { AlertTriangle, CircleCheck, MessageSquare, Truck as TruckIcon, ExternalLink } from "lucide-react";
import { AutoRefresh } from "@/components/AutoRefresh";
import { ReopenButton } from "@/components/ReopenButton";
import { CompleteStopButton } from "@/components/CompleteStopButton";
import { RemoveStopButton } from "@/components/RemoveStopButton";
import { CloseRouteButton } from "@/components/CloseRouteButton";
import { ReopenRouteButton } from "@/components/ReopenRouteButton";
import { DriverAssign } from "@/components/DriverAssign";
import { QuoteReviewButton } from "@/components/QuoteReviewButton";
import { ResolveExceptionButton } from "@/components/ResolveExceptionButton";
import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { DatePicker } from "@/components/DatePicker";
import {
  getOpenExceptions,
  getRecentMessages,
  getRouteForDate,
} from "@/lib/db/repo";
import { findRouteHealthIssues } from "@/lib/dispatch/routeHealth";
import { ClosePastRoutesButton } from "@/components/ClosePastRoutesButton";
import { viewerRole } from "@/lib/auth/getSession";
import { canManageSettings } from "@/lib/auth/roles";
import { DISPLAY_TZ, todayInOpsTz, shiftYmd, formatYmdLong, formatClockTime } from "@/lib/dates";
import { reviewStopAddress } from "@/lib/addressReview";
import { getSettings } from "@/lib/settings";
import { getActiveVehicles } from "@/lib/vehicles";
import { STATE_VISUAL } from "@/lib/stateVisual";
import type { Route, Stop } from "@/lib/types";
import { FigureStrip, type Figure } from "@/components/console-primitives";

export const dynamic = "force-dynamic";

// Full-width board. Ignition (fleet telematics) can't be iframed (X-Frame-Options), so
// when its URL is set we surface a compact "Open Ignition" link — the office big-screen
// gets Ignition side-by-side via the native kiosk board mode instead.
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

async function DispatchBoard({ date, today }: { date: string; today: string }) {
  const trucks = getActiveVehicles();
  const fleet = trucks.map((t) => ({ truck: t, route: getRouteForDate(t.truckId, date) }));
  const isToday = date === today;
  const isFuture = date > today;
  const exceptions = isToday ? getOpenExceptions() : [];
  const messages = isToday ? getRecentMessages(30) : [];
  const anyRoute = fleet.some((f) => f.route);

  const truckName = (id: string | null) =>
    trucks.find((t) => t.truckId === id)?.name ?? id ?? "—";

  const withRoute = fleet.filter((f) => f.route);
  const allStops = withRoute.flatMap((f) => f.route!.stops);
  const doneStops = allStops.filter((s) => s.state === "Completed" || s.state === "Returned").length;
  const driversAssigned = withRoute.filter((f) => f.route!.driverName).length;
  const figures: Figure[] = [
    { label: "Routes", value: withRoute.length },
    { label: "Stops done", value: `${doneStops}/${allStops.length}` },
    { label: "Exceptions", value: exceptions.length, tone: exceptions.length ? "critical" : "default" },
    { label: "Drivers", value: `${driversAssigned}/${withRoute.length}`, tone: driversAssigned < withRoute.length ? "attention" : "default", sep: true },
  ];

  return (
    <div className="w-full space-y-6">
      {isToday && <AutoRefresh seconds={15} />}

      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-[22px] font-medium tracking-tight">Dispatch</h1>
          <p className="text-[12.5px] text-meta">
            {trucks.length} trucks · {isToday ? "live view · refreshes automatically" : isFuture ? "upcoming — planning view" : "history view"}
          </p>
        </div>
        <div className="flex items-end gap-6">
          <FigureStrip figures={figures} />
          <DateNav date={date} today={today} />
        </div>
      </header>

      {!anyRoute && (
        <div className="rounded border border-border bg-panel p-4 text-sm text-muted-foreground">
          No routes scheduled for {isToday ? "today" : formatYmdLong(date)}.
        </div>
      )}

      {/* Scheduled time board — mirrors what's planned in Goodshuffle (not live) */}
      {anyRoute && <TimeBoard fleet={fleet} isToday={isToday} />}

      {/* Fleet */}
      <section className="grid gap-4 lg:grid-cols-2">
        {fleet.map(({ truck, route }) => (
          <TruckCard
            key={truck.truckId}
            name={truck.name}
            route={route}
            noRouteLabel={isToday ? "No route scheduled today" : "No route this day"}
          />
        ))}
      </section>

      {isToday && (
        <>
      {/* Exceptions */}
      <section className="space-y-2">
        <h2 className="text-lg font-semibold">Open exceptions</h2>
        {exceptions.length === 0 ? (
          <p className="text-sm text-muted-foreground">None. All clear.</p>
        ) : (
          <div className="space-y-2">
            {exceptions.map((x) => (
              <div
                key={x.exceptionId}
                className="flex items-start gap-3 rounded border border-border bg-panel p-3 text-sm"
              >
                <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="font-medium">
                    {truckName(x.truckId)} · {x.type}
                  </div>
                  {x.reason && <div className="text-muted-foreground">{x.reason}</div>}
                  <div className="text-xs text-muted-foreground">{fmtTime(x.ts)}</div>
                </div>
                <ResolveExceptionButton exceptionId={x.exceptionId} />
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Message log */}
      <section className="space-y-2">
        <h2 className="text-lg font-semibold">Recent messages</h2>
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
                  <span className="w-32 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                    {fmtTime(m.sentAt)}
                  </span>
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

// ── Scheduled time board ──────────────────────────────────────────────────────
const BOARD_START = 7;
const BOARD_END = 19;
const BOARD_HOURS = BOARD_END - BOARD_START;
const LABEL_W = 184;

function hourInTz(iso: string | undefined | null): number | null {
  if (!iso) return null;
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: DISPLAY_TZ, hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date(iso));
    const h = Number(parts.find((p) => p.type === "hour")?.value);
    const m = Number(parts.find((p) => p.type === "minute")?.value);
    return Number.isNaN(h) ? null : h + (Number.isNaN(m) ? 0 : m) / 60;
  } catch {
    return null;
  }
}

function TimeBoard({ fleet, isToday }: { fleet: { truck: { name: string; truckId: string }; route: Route | null }[]; isToday: boolean }): React.JSX.Element {
  const rows = fleet.filter((f) => f.route);
  const nowH = isToday ? hourInTz(new Date().toISOString()) : null;
  const nowPct = nowH != null && nowH >= BOARD_START && nowH <= BOARD_END ? ((nowH - BOARD_START) / BOARD_HOURS) * 100 : null;
  const hours = Array.from({ length: BOARD_HOURS + 1 }, (_, i) => BOARD_START + i);
  const label = (h: number) => (h === 12 ? "12p" : h < 12 ? `${h}a` : `${h - 12}p`);

  return (
    <section className="overflow-x-auto border border-border">
      <div className="min-w-[900px]">
        {/* axis */}
        <div className="flex border-b border-[var(--row-rule)]">
          <div className="shrink-0" style={{ width: LABEL_W }} />
          <div className="flex flex-1">
            {hours.slice(0, -1).map((h) => (
              <div key={h} className="flex-1 border-l border-[var(--grid-rule)] px-1 py-1 text-[10.5px] text-meta">{label(h)}</div>
            ))}
          </div>
        </div>

        {/* truck rows */}
        {rows.map(({ truck, route }) => {
          const r = route!;
          const done = r.stops.filter((s) => s.state === "Completed" || s.state === "Returned").length;
          return (
            <div key={truck.truckId} className="flex border-b border-[var(--row-rule)] last:border-b-0">
              <div className="flex shrink-0 flex-col justify-center px-3" style={{ width: LABEL_W }}>
                <div className="text-[14px] font-medium">{truck.name}</div>
                <div className="text-[12px] text-meta">{r.driverName || "No driver"} · {done}/{r.stops.length}</div>
              </div>
              <div className="relative flex-1" style={{ height: 48 }}>
                {hours.slice(1, -1).map((h) => (
                  <div key={h} className="absolute inset-y-0 w-px bg-[var(--grid-rule)]" style={{ left: `${((h - BOARD_START) / BOARD_HOURS) * 100}%` }} />
                ))}
                {nowPct != null && <div className="absolute inset-y-0 z-10 w-px bg-[#cfd3e5]/70" style={{ left: `${nowPct}%` }} />}
                {r.stops.map((s) => {
                  const start = hourInTz(s.plannedWindow || s.eta);
                  if (start == null) return null;
                  const clamped = Math.max(BOARD_START, Math.min(BOARD_END - 0.5, start));
                  const leftPct = ((clamped - BOARD_START) / BOARD_HOURS) * 100;
                  const finished = s.state === "Completed" || s.state === "Returned";
                  const exception = s.state === "Exception";
                  const pickup = s.kind === "pickup";
                  const fill = finished ? "bg-[#262834] text-meta" : exception ? "bg-[#4a2a2e] text-[#e9e9ed] ring-1 ring-inset ring-critical" : "bg-[#3f424d] text-[#e9e9ed]";
                  const ring = !finished && !exception && pickup ? "ring-1 ring-inset ring-attention/60" : "";
                  return (
                    <div
                      key={s.stopId}
                      title={`${s.sequence}. ${s.custName} · ${pickup ? "Pickup" : "Delivery"} · ${s.plannedWindow || s.eta ? formatClockTime(s.plannedWindow || s.eta || "") : "no time"} · ${s.state}`}
                      className={`absolute top-1/2 flex h-[26px] -translate-y-1/2 items-center gap-1 overflow-hidden rounded-[2px] px-1.5 text-[11px] ${fill} ${ring}`}
                      style={{ left: `${leftPct}%`, width: `max(${(0.7 / BOARD_HOURS) * 100}%, 72px)` }}
                    >
                      <span className={`shrink-0 text-[9px] font-semibold uppercase ${pickup ? "text-attention" : "text-tertiary-text"}`}>{pickup ? "P" : "D"}</span>
                      <span className="truncate">{s.custName}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      {/* legend */}
      <div className="flex flex-wrap items-center gap-4 border-t border-[var(--row-rule)] px-3 py-2 text-[11.5px] text-meta">
        <span className="flex items-center gap-1.5"><span className="size-2.5 rounded-[2px] bg-[#3f424d]" /> Scheduled</span>
        <span className="flex items-center gap-1.5"><span className="size-2.5 rounded-[2px] bg-[#3f424d] ring-1 ring-inset ring-attention/60" /> Pickup (P)</span>
        <span className="flex items-center gap-1.5"><span className="size-2.5 rounded-[2px] bg-[#262834]" /> Done</span>
        <span className="flex items-center gap-1.5"><span className="size-2.5 rounded-[2px] bg-[#4a2a2e] ring-1 ring-inset ring-critical" /> Exception</span>
        {isToday && <span className="flex items-center gap-1.5"><span className="h-3 w-px bg-[#cfd3e5]/70" /> Now</span>}
      </div>
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
      <Link
        href={href(prev)}
        aria-label="Previous day"
        className="flex size-9 items-center justify-center rounded-lg border border-border text-muted-foreground hover:text-foreground"
      >
        <ChevronLeft className="size-4" />
      </Link>
      <DatePicker date={date} today={today} basePath="/dispatch" />
      <Link
        href={href(next)}
        aria-label="Next day"
        className="flex size-9 items-center justify-center rounded-lg border border-border text-muted-foreground hover:text-foreground"
      >
        <ChevronRight className="size-4" />
      </Link>
      {!isToday && (
        <Link
          href="/dispatch"
          className="ml-1 rounded-lg border border-border px-2.5 py-1.5 text-sm text-muted-foreground hover:text-foreground"
        >
          Today
        </Link>
      )}
    </div>
  );
}

function TruckCard({
  name,
  route,
  noRouteLabel = "No route scheduled",
}: {
  name: string;
  route: Route | null;
  noRouteLabel?: string;
}) {
  const stops = route?.stops ?? [];
  const total = stops.length;
  const done = stops.filter((s) => s.state === "Completed" || s.state === "Returned").length;
  const active = stops.find((s) => s.state === "EnRoute" || s.state === "Arrived" || s.state === "Exception");
  const pct = total ? Math.round((done / total) * 100) : 0;

  return (
    <div
      className={`surface space-y-4 border border-border p-5 ${
        route?.status === "done" ? "opacity-60" : ""
      }`}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <span className="flex size-9 items-center justify-center rounded border border-border text-tertiary-text">
            <TruckIcon className="size-4" />
          </span>
          <div>
            <div className="text-[14px] font-medium">{name}</div>
            <div className="text-xs text-muted-foreground">
              {route ? routeStatusLabel(route, done, total) : noRouteLabel}
            </div>
          </div>
        </div>
        {total > 0 && (
          <div className="text-right">
            <div className="text-lg font-bold tabular-nums">
              {done}/{total}
            </div>
            <div className="text-[11px] text-muted-foreground">stops</div>
          </div>
        )}
      </div>

      {total > 0 && (
        <div className="h-1.5 overflow-hidden rounded-full bg-[var(--row-hover)]">
          <div className="h-full bg-foreground transition-all" style={{ width: `${pct}%` }} />
        </div>
      )}

      {active && (
        <div className="rounded border border-border bg-panel p-3">
          <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
            Current stop
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="font-medium">{active.custName}</span>
            <StateBadge state={active.state} />
          </div>
          {active.dayOfName && (
            <div className="mt-0.5 text-xs text-muted-foreground">
              Day-of: {active.dayOfName}
              {active.dayOfPhone ? ` · ${active.dayOfPhone}` : ""}
            </div>
          )}
        </div>
      )}

      {/* Stops with proof of delivery */}
      {total > 0 && route && (
        <ul className="space-y-2">
          {stops.map((s) => (
            <StopLine
              key={s.stopId}
              stop={s}
              truckId={route.truckId}
              routeId={route.routeId}
              routeDone={route.status === "done"}
            />
          ))}
        </ul>
      )}

      {/* AI quote review (crew-size rules + LLM) — when the route's stops carry line items. */}
      {route &&
        route.status !== "done" &&
        (() => {
          const items = (route.stops ?? []).flatMap((s) => s.items ?? []);
          return items.length > 0 ? (
            <div className="border-t border-border pt-3">
              <QuoteReviewButton items={items} eventName={`${route.truckId} route`} />
            </div>
          ) : null;
        })()}

      {/* Driver assignment (feeds the Event Risk Engine's staffing checks). */}
      {route && route.status !== "done" && (
        <div className="flex items-center justify-between gap-2 border-t border-border pt-3">
          <span className="text-xs text-muted-foreground">Driver</span>
          <DriverAssign routeId={route.routeId} date={route.date} driverName={route.driverName} />
        </div>
      )}

      {/* Office control: force-close a route the driver couldn't finish on the tablet. */}
      {route && (
        <div className="flex items-center justify-between gap-2 border-t border-border pt-3">
          {route.status === "done" ? (
            <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
              <CircleCheck className="size-3.5" /> Route closed — reopen to adjust stops
            </span>
          ) : (
            <span className="text-xs text-muted-foreground">Tablet down / dead battery?</span>
          )}
          {route.status === "done" ? (
            <ReopenRouteButton routeId={route.routeId} />
          ) : (
            <CloseRouteButton routeId={route.routeId} />
          )}
        </div>
      )}
    </div>
  );
}

function StopLine({
  stop,
  truckId,
  routeId,
  routeDone,
}: {
  stop: Stop;
  truckId: string;
  routeId: string;
  routeDone: boolean;
}) {
  const hasProof = (stop.photoIds?.length ?? 0) > 0 || Boolean(stop.signatureId);
  const finished = stop.state === "Completed" || stop.state === "Returned";
  // Dispatch can pull an upcoming/unfinished stop off the route (and Goodshuffle). Not
  // offered on finished stops (keeps their proof-of-delivery) or a closed route.
  const canPull = !routeDone && !finished;
  // Business/office stops with restricted hours — so a truck doesn't show up while closed.
  const addr = reviewStopAddress({ address: stop.address, name: stop.custName, whenIso: stop.plannedWindow || stop.eta });
  return (
    <li className="rounded-lg border border-border p-2.5">
      <div className="flex items-center gap-2">
        <span className="w-5 shrink-0 text-center text-xs text-muted-foreground">{stop.sequence}</span>
        <span className="flex-1 truncate text-sm">{stop.custName}</span>
        {stop.kind === "pickup" && (
          <span className="shrink-0 text-[10px] font-semibold uppercase tracking-[0.08em] text-attention">Pickup</span>
        )}
        {addr.class === "business" && (
          <span title={addr.note} className={`shrink-0 text-[10px] font-semibold uppercase tracking-[0.08em] ${addr.hoursRisk ? "text-critical" : "text-attention"}`}>
            {addr.hoursRisk ? "May be closed" : "Business"}
          </span>
        )}
        <StateBadge state={stop.state} />
        {!routeDone && !finished && (
          <CompleteStopButton stopId={stop.stopId} custName={stop.custName} />
        )}
        {stop.state === "Completed" && (
          <ReopenButton truckId={truckId} routeId={routeId} stopId={stop.stopId} />
        )}
        {canPull && (
          <RemoveStopButton
            routeId={routeId}
            stopId={stop.stopId}
            custName={stop.custName}
            gsLinked={Boolean(stop.txId)}
          />
        )}
      </div>
      {addr.hoursRisk && (
        <div className="mt-1 pl-7 text-[11px] text-critical">⚠ {addr.note}</div>
      )}
      {hasProof && (
        <div className="mt-2 flex flex-wrap items-center gap-2 pl-7">
          {stop.photoIds?.map((id) => (
            <a key={id} href={`/api/pod/${id}`} target="_blank" rel="noopener noreferrer">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={`/api/pod/${id}`} alt="delivery photo" className="size-14 rounded object-cover" />
            </a>
          ))}
          {stop.signatureId && (
            <a href={`/api/pod/${stop.signatureId}`} target="_blank" rel="noopener noreferrer">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={`/api/pod/${stop.signatureId}`}
                alt="signature"
                className="h-14 w-24 rounded border border-border bg-white object-contain"
              />
            </a>
          )}
        </div>
      )}
    </li>
  );
}

function StateBadge({ state }: { state: Stop["state"] }) {
  const v = STATE_VISUAL[state];
  return (
    <span className="flex items-center gap-1 rounded-full bg-[var(--row-hover)] px-2 py-0.5 text-[11px] font-medium">
      <span className={`size-2 rounded-full ${v.dot}`} />
      {v.label}
    </span>
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

function routeStatusLabel(route: Route, done: number, total: number): string {
  if (route.status === "done") return "Closed";
  if (route.status === "scraping") return "Loading route…";
  if (route.status === "failed") return "Route failed — manual entry";
  if (total === 0) return "Ready to start";
  if (done === total) return "Route complete";
  return "In progress";
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
