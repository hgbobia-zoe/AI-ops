// Dispatch dashboard — the back-office view. Read-mostly: every truck's live route
// and progress, the current stop, open exceptions, the outbound message log, and
// proof-of-delivery photos/signatures. One supervisor action: reopen a completed
// stop (guarded). Auto-refreshes so it stays live.

import { AlertTriangle, CircleCheck, MessageSquare, Truck as TruckIcon } from "lucide-react";
import { AutoRefresh } from "@/components/AutoRefresh";
import { IgnitionPane } from "@/components/IgnitionPane";
import { ReopenButton } from "@/components/ReopenButton";
import { CloseRouteButton } from "@/components/CloseRouteButton";
import { ResolveExceptionButton } from "@/components/ResolveExceptionButton";
import Link from "next/link";
import { ChevronLeft, ChevronRight, CalendarDays, Settings } from "lucide-react";
import {
  getOpenExceptions,
  getRecentMessages,
  getRouteForDate,
} from "@/lib/db/repo";
import { DISPLAY_TZ, todayInOpsTz, shiftYmd, formatYmdLong } from "@/lib/dates";
import { getSettings } from "@/lib/settings";
import { getActiveVehicles } from "@/lib/vehicles";
import { STATE_VISUAL } from "@/lib/stateVisual";
import type { Route, Stop } from "@/lib/types";

export const dynamic = "force-dynamic";

// The dashboard is a split view — our board beside Ignition (fleet telematics) —
// mirroring how the delivery kiosk splits the app beside Goodshuffle. The split
// only appears when NEXT_PUBLIC_IGNITION_URL is set; otherwise the board is full-width.
export default async function DispatchPage({
  searchParams,
}: {
  searchParams: Promise<{ date?: string; native?: string; embed?: string }>;
}) {
  const sp = await searchParams;
  const today = todayInOpsTz();
  const date = sp?.date && /^\d{4}-\d{2}-\d{2}$/.test(sp.date) ? sp.date : today;
  const ignitionUrl = getSettings().ignitionUrl;
  // In the native kiosk's board mode the shell already shows the live Ignition map in
  // the pane beside us — so render the board full-width and skip our own IgnitionPane
  // (which would just try, and fail, to iframe Ignition).
  const embeddedInKiosk = sp?.native === "android" || sp?.embed === "1";
  if (!ignitionUrl || embeddedInKiosk) {
    return (
      <main className="mx-auto max-w-6xl p-5 pb-16">
        <DispatchBoard date={date} today={today} />
      </main>
    );
  }
  return (
    <div className="flex h-dvh w-full flex-col lg:flex-row">
      {/* Ignition — live fleet, the operational reference. */}
      <section className="min-h-0 flex-1 border-b border-white/10 lg:border-b-0 lg:border-r">
        <IgnitionPane url={ignitionUrl} forceEmbed={process.env.IGNITION_EMBED === "true"} />
      </section>
      {/* Our dispatch board — the action layer. */}
      <section className="min-h-0 flex-1 overflow-y-auto p-5 pb-16">
        <DispatchBoard date={date} today={today} />
      </section>
    </div>
  );
}

async function DispatchBoard({ date, today }: { date: string; today: string }) {
  const trucks = getActiveVehicles();
  const fleet = trucks.map((t) => ({ truck: t, route: getRouteForDate(t.truckId, date) }));
  const isToday = date === today;
  const exceptions = isToday ? getOpenExceptions() : [];
  const messages = isToday ? getRecentMessages(30) : [];
  const anyRoute = fleet.some((f) => f.route);

  const truckName = (id: string | null) =>
    trucks.find((t) => t.truckId === id)?.name ?? id ?? "—";

  return (
    <div className="mx-auto w-full max-w-6xl space-y-6">
      {isToday && <AutoRefresh seconds={15} />}

      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Dispatch</h1>
          <p className="text-sm text-muted-foreground">
            {trucks.length} trucks ·{" "}
            {isToday ? "live view · refreshes automatically" : "history view"}
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          <DateNav date={date} today={today} />
          <Link
            href="/admin"
            aria-label="Settings"
            title="Settings"
            className="flex size-9 items-center justify-center rounded-lg border border-white/10 text-muted-foreground hover:text-foreground"
          >
            <Settings className="size-4" />
          </Link>
        </div>
      </header>

      {!anyRoute && (
        <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4 text-sm text-muted-foreground">
          No routes scheduled for {isToday ? "today" : formatYmdLong(date)}.
        </div>
      )}

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
                className="flex items-start gap-3 rounded-xl border border-white/10 bg-white/[0.03] p-3 text-sm"
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
          <div className="divide-y divide-white/5 rounded-xl border border-white/10">
            {messages.map((m, i) => (
              <div key={i} className="flex items-center gap-3 p-3 text-sm">
                <MessageSquare className="size-4 shrink-0 text-muted-foreground" />
                <span className="w-32 shrink-0 tabular-nums text-muted-foreground">
                  {m.toPhone}
                </span>
                <span className="flex-1 truncate">{m.body}</span>
                <StatusTag status={m.status} />
              </div>
            ))}
          </div>
        )}
      </section>
        </>
      )}
    </div>
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
        className="flex size-9 items-center justify-center rounded-lg border border-white/10 text-muted-foreground hover:text-foreground"
      >
        <ChevronLeft className="size-4" />
      </Link>
      <span className="inline-flex items-center gap-2 rounded-lg border border-white/10 px-3 py-1.5 text-sm font-medium">
        <CalendarDays className="size-4 text-muted-foreground" />
        {isToday ? "Today" : formatYmdLong(date)}
      </span>
      <Link
        href={href(next)}
        aria-label="Next day"
        aria-disabled={isToday}
        className={`flex size-9 items-center justify-center rounded-lg border border-white/10 ${
          isToday ? "pointer-events-none opacity-40" : "text-muted-foreground hover:text-foreground"
        }`}
      >
        <ChevronRight className="size-4" />
      </Link>
      {!isToday && (
        <Link
          href="/dispatch"
          className="ml-1 rounded-lg border border-white/10 px-2.5 py-1.5 text-sm text-muted-foreground hover:text-foreground"
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
      className={`surface space-y-4 rounded-2xl border border-white/5 p-5 ${
        route?.status === "done" ? "opacity-60" : ""
      }`}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <span className="btn-hero flex size-9 items-center justify-center rounded-xl">
            <TruckIcon className="size-5" />
          </span>
          <div>
            <div className="font-semibold">{name}</div>
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
        <div className="h-1.5 overflow-hidden rounded-full bg-white/10">
          <div className="h-full bg-foreground transition-all" style={{ width: `${pct}%` }} />
        </div>
      )}

      {active && (
        <div className="rounded-xl border border-white/10 bg-white/[0.03] p-3">
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
            <StopLine key={s.stopId} stop={s} truckId={route.truckId} routeId={route.routeId} />
          ))}
        </ul>
      )}

      {/* Office control: force-close a route the driver couldn't finish on the tablet. */}
      {route && (
        <div className="flex items-center justify-between gap-2 border-t border-white/5 pt-3">
          {route.status === "done" ? (
            <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
              <CircleCheck className="size-3.5" /> Route closed — loads fresh on next pull
            </span>
          ) : (
            <span className="text-xs text-muted-foreground">Tablet down / dead battery?</span>
          )}
          {route.status !== "done" && <CloseRouteButton truckId={route.truckId} />}
        </div>
      )}
    </div>
  );
}

function StopLine({
  stop,
  truckId,
  routeId,
}: {
  stop: Stop;
  truckId: string;
  routeId: string;
}) {
  const hasProof = (stop.photoIds?.length ?? 0) > 0 || Boolean(stop.signatureId);
  return (
    <li className="rounded-lg border border-white/5 p-2.5">
      <div className="flex items-center gap-2">
        <span className="w-5 shrink-0 text-center text-xs text-muted-foreground">{stop.sequence}</span>
        <span className="flex-1 truncate text-sm">{stop.custName}</span>
        <StateBadge state={stop.state} />
        {stop.state === "Completed" && (
          <ReopenButton truckId={truckId} routeId={routeId} stopId={stop.stopId} />
        )}
      </div>
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
                className="h-14 w-24 rounded border border-white/10 bg-white object-contain"
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
    <span className="flex items-center gap-1 rounded-full bg-white/10 px-2 py-0.5 text-[11px] font-medium">
      <span className={`size-2 rounded-full ${v.dot}`} />
      {v.label}
    </span>
  );
}

function StatusTag({ status }: { status: string | null }) {
  const label = status ?? "—";
  return (
    <span className="shrink-0 rounded bg-white/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
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
