// Dispatch dashboard — the back-office view. Read-mostly: every truck's live route
// and progress, the current stop, open exceptions, the outbound message log, and
// proof-of-delivery photos/signatures. One supervisor action: reopen a completed
// stop (guarded). Auto-refreshes so it stays live.

import { AlertTriangle, MessageSquare, Truck as TruckIcon } from "lucide-react";
import { AutoRefresh } from "@/components/AutoRefresh";
import { IgnitionPane } from "@/components/IgnitionPane";
import { ReopenButton } from "@/components/ReopenButton";
import {
  getOpenExceptions,
  getRecentMessages,
  getRoute,
} from "@/lib/db/repo";
import { DISPLAY_TZ } from "@/lib/dates";
import { getActiveVehicles } from "@/lib/vehicles";
import { STATE_VISUAL } from "@/lib/stateVisual";
import type { Route, Stop } from "@/lib/types";

export const dynamic = "force-dynamic";

// The dashboard is a split view — our board beside Ignition (fleet telematics) —
// mirroring how the delivery kiosk splits the app beside Goodshuffle. The split
// only appears when NEXT_PUBLIC_IGNITION_URL is set; otherwise the board is full-width.
export default function DispatchPage() {
  const ignitionUrl = process.env.IGNITION_URL || "";
  if (!ignitionUrl) {
    return (
      <main className="mx-auto max-w-6xl p-5 pb-16">
        <DispatchBoard />
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
        <DispatchBoard />
      </section>
    </div>
  );
}

async function DispatchBoard() {
  const trucks = getActiveVehicles();
  const fleet = trucks.map((t) => ({ truck: t, route: getRoute(t.truckId) }));
  const exceptions = getOpenExceptions();
  const messages = getRecentMessages(30);

  const truckName = (id: string | null) =>
    trucks.find((t) => t.truckId === id)?.name ?? id ?? "—";

  return (
    <div className="mx-auto w-full max-w-6xl space-y-6">
      <AutoRefresh seconds={15} />

      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Dispatch</h1>
          <p className="text-sm text-muted-foreground">
            {trucks.length} trucks · live view · refreshes automatically
          </p>
        </div>
        {exceptions.length > 0 && (
          <span className="flex items-center gap-1.5 rounded-full bg-white/10 px-3 py-1 text-sm font-medium">
            <AlertTriangle className="size-4" /> {exceptions.length} open
          </span>
        )}
      </header>

      {/* Fleet */}
      <section className="grid gap-4 lg:grid-cols-2">
        {fleet.map(({ truck, route }) => (
          <TruckCard key={truck.truckId} name={truck.name} route={route} />
        ))}
      </section>

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
                <div>
                  <div className="font-medium">
                    {truckName(x.truckId)} · {x.type}
                  </div>
                  {x.reason && <div className="text-muted-foreground">{x.reason}</div>}
                  <div className="text-xs text-muted-foreground">{fmtTime(x.ts)}</div>
                </div>
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
    </div>
  );
}

function TruckCard({ name, route }: { name: string; route: Route | null }) {
  const stops = route?.stops ?? [];
  const total = stops.length;
  const done = stops.filter((s) => s.state === "Completed" || s.state === "Returned").length;
  const active = stops.find((s) => s.state === "EnRoute" || s.state === "Arrived" || s.state === "Exception");
  const pct = total ? Math.round((done / total) * 100) : 0;

  return (
    <div className="surface space-y-4 rounded-2xl border border-white/5 p-5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <span className="btn-hero flex size-9 items-center justify-center rounded-xl">
            <TruckIcon className="size-5" />
          </span>
          <div>
            <div className="font-semibold">{name}</div>
            <div className="text-xs text-muted-foreground">
              {route ? routeStatusLabel(route, done, total) : "No route today"}
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
