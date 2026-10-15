"use client";

// Dispatch execution surface (redesign): the scheduled time board + a COMPACT single-column route list that
// expands inline. Replaces the old big 2-column TruckCards. Every existing action is preserved — stop
// complete/reopen/remove, quote review, driver assign, route resync/remove/close/reopen, proof-of-delivery —
// just reorganized into a dense, scannable list with inline detail. Selecting a timeline event selects and
// expands that route in the list below.

import { useCallback, useRef, useState } from "react";
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  CircleCheck,
  Truck as TruckIcon,
  Users,
} from "lucide-react";
import { ReopenButton } from "@/components/ReopenButton";
import { CompleteStopButton } from "@/components/CompleteStopButton";
import { RemoveStopButton } from "@/components/RemoveStopButton";
import { CloseRouteButton } from "@/components/CloseRouteButton";
import { RemoveRouteButton } from "@/components/RemoveRouteButton";
import { ResyncRouteButton } from "@/components/ResyncRouteButton";
import { ReopenRouteButton } from "@/components/ReopenRouteButton";
import { DriverAssign } from "@/components/DriverAssign";
import { QuoteReviewButton } from "@/components/QuoteReviewButton";
import { STATE_VISUAL } from "@/lib/stateVisual";
import { DISPLAY_TZ, formatClockTime } from "@/lib/dates";
import type { StopState, RouteStatus } from "@/lib/types";
import type { RouteStaffingState } from "@/lib/scheduling/routeStaffing";

// ── Serializable view types (built on the server, passed down) ───────────────────────────────────────
export interface DispatchStopView {
  stopId: string;
  sequence: number;
  custName: string;
  kind: "delivery" | "pickup";
  state: StopState;
  address: string;
  dayOfName: string | null;
  dayOfPhone: string | null;
  plannedWindow: string | null;
  eta: string | null;
  photoIds: string[];
  signatureId: string | null;
  addrClass: "business" | "venue" | "residential";
  addrHoursRisk: boolean;
  addrNote: string;
  finished: boolean;
  canPull: boolean;
}

export interface DispatchRouteView {
  routeId: string;
  truckId: string;
  truckName: string;
  status: RouteStatus;
  date: string;
  driverName: string | null;
  done: number;
  total: number;
  items: { name: string; quantity?: number }[];
  executionExceptions: number;
  stops: DispatchStopView[];
  staffing: RouteStaffingState;
}

export interface NoRouteTruck {
  truckId: string;
  truckName: string;
}

// ── Timeline constants (ported from the previous TimeBoard) ──────────────────────────────────────────
const BOARD_START = 7;
const BOARD_END = 19;
const BOARD_HOURS = BOARD_END - BOARD_START;
const LABEL_W = 176;
const LANE_H = 26;
const MARKER_PCT = 10;

function hourInTz(iso: string | null): number | null {
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

function packLanes(xs: number[]): { lanes: number[]; count: number } {
  const order = xs.map((x, i) => ({ i, x })).sort((a, b) => a.x - b.x);
  const laneEnds: number[] = [];
  const lanes = new Array<number>(xs.length).fill(0);
  for (const { i, x } of order) {
    let L = 0;
    while (L < laneEnds.length && x < laneEnds[L]) L++;
    lanes[i] = L;
    laneEnds[L] = x + MARKER_PCT;
  }
  return { lanes, count: Math.max(1, laneEnds.length) };
}

function StateBadge({ state }: { state: StopState }): React.JSX.Element {
  const v = STATE_VISUAL[state];
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-[var(--row-hover)] px-2 py-0.5 text-[11px] font-medium">
      <span className={`size-2 rounded-full ${v.dot}`} />
      {v.label}
    </span>
  );
}

// Staffing tone → dot + text (text label always present, never color-only).
function staffingTone(s: RouteStaffingState): { dot: string; text: string } {
  if (!s.requiresCrew) return { dot: "bg-[var(--bar)]", text: "text-meta" };
  if (s.status === "ok") return { dot: "bg-positive", text: "text-tertiary-text" };
  if (s.nobody) return { dot: "bg-critical", text: "text-critical" };
  return { dot: "bg-attention", text: "text-attention" };
}

function routeStatusLabel(status: RouteStatus, done: number, total: number): string {
  if (status === "done") return "Closed";
  if (status === "scraping") return "Loading route…";
  if (status === "failed") return "Route failed — manual entry";
  if (total === 0) return "Ready to start";
  if (done === total) return "Route complete";
  return "In progress";
}

// ── Timeline ──────────────────────────────────────────────────────────────────────────────────────────
function DispatchTimeline({
  routes,
  isToday,
  selectedRouteId,
  onSelect,
}: {
  routes: DispatchRouteView[];
  isToday: boolean;
  selectedRouteId: string | null;
  onSelect: (routeId: string) => void;
}): React.JSX.Element {
  const nowH = isToday ? hourInTz(new Date().toISOString()) : null;
  const nowPct = nowH != null && nowH >= BOARD_START && nowH <= BOARD_END ? ((nowH - BOARD_START) / BOARD_HOURS) * 100 : null;
  const hours = Array.from({ length: BOARD_HOURS + 1 }, (_, i) => BOARD_START + i);
  const label = (h: number): string => (h === 12 ? "12p" : h < 12 ? `${h}a` : `${h - 12}p`);

  return (
    <section className="overflow-x-auto border border-border" aria-label="Scheduled route timeline">
      <div className="min-w-[900px]">
        <div className="flex border-b border-[var(--row-rule)]">
          <div className="shrink-0" style={{ width: LABEL_W }} />
          <div className="flex flex-1">
            {hours.slice(0, -1).map((h) => (
              <div key={h} className="flex-1 border-l border-[var(--grid-rule)] px-1 py-1 text-[10.5px] text-meta">{label(h)}</div>
            ))}
          </div>
        </div>

        {routes.map((r) => {
          const track = BOARD_END - 0.5 - BOARD_START;
          const positioned = r.stops.map((s, i) => {
            const h = hourInTz(s.plannedWindow || s.eta);
            const timed = h != null;
            const hour = timed ? h : BOARD_START + ((i + 0.5) / Math.max(1, r.stops.length)) * track;
            const clamped = Math.max(BOARD_START, Math.min(BOARD_END - 0.5, hour));
            return { s, timed, leftPct: ((clamped - BOARD_START) / BOARD_HOURS) * 100 };
          });
          const { lanes, count } = packLanes(positioned.map((p) => p.leftPct));
          const rowH = Math.max(44, count * LANE_H + 8);
          const selected = selectedRouteId === r.routeId;
          return (
            <div key={r.routeId} className={`flex border-b border-[var(--row-rule)] last:border-b-0 ${selected ? "bg-[var(--row-hover)]" : ""}`}>
              <button
                type="button"
                onClick={() => onSelect(r.routeId)}
                className="flex shrink-0 flex-col justify-center px-3 text-left transition-colors hover:bg-[var(--row-hover)]"
                style={{ width: LABEL_W }}
                aria-label={`Select ${r.truckName} route`}
              >
                <div className="truncate text-[13px] font-medium">{r.truckName}</div>
                <div className="truncate text-[11.5px] text-meta">{r.driverName ? "Driver assigned" : "No driver assigned"} · {r.done}/{r.total}</div>
              </button>
              <div className="relative flex-1" style={{ height: rowH }}>
                {hours.slice(1, -1).map((h) => (
                  <div key={h} className="absolute inset-y-0 w-px bg-[var(--grid-rule)]" style={{ left: `${((h - BOARD_START) / BOARD_HOURS) * 100}%` }} />
                ))}
                {nowPct != null && <div className="absolute inset-y-0 z-10 w-px bg-[#cfd3e5]/70" style={{ left: `${nowPct}%` }} />}
                {positioned.map(({ s, timed, leftPct }, i) => {
                  const finished = s.state === "Completed" || s.state === "Returned";
                  const exception = s.state === "Exception";
                  const pickup = s.kind === "pickup";
                  const fill = finished ? "bg-[#244a35] text-[#e9e9ed] ring-1 ring-inset ring-positive/70" : exception ? "bg-[#4a2a2e] text-[#e9e9ed] ring-1 ring-inset ring-critical" : "bg-[#3f424d] text-[#e9e9ed]";
                  const ring = !finished && !exception && pickup ? "ring-1 ring-inset ring-attention/60" : "";
                  return (
                    <button
                      type="button"
                      key={s.stopId}
                      onClick={() => onSelect(r.routeId)}
                      title={`${s.sequence}. ${s.custName} · ${pickup ? "Pickup" : "Delivery"} · ${timed ? formatClockTime(s.plannedWindow || s.eta || "") : "no scheduled time"} · ${s.state}`}
                      className={`absolute flex h-[22px] items-center gap-1 overflow-hidden rounded-[2px] px-1.5 text-[11px] ${fill} ${ring} ${timed ? "" : "border border-dashed border-meta/60"}`}
                      style={{ left: `${leftPct}%`, top: lanes[i] * LANE_H + 4, width: `max(${(0.7 / BOARD_HOURS) * 100}%, 72px)` }}
                    >
                      <span className={`shrink-0 text-[9px] font-semibold uppercase ${pickup ? "text-attention" : "text-tertiary-text"}`}>{pickup ? "P" : "D"}</span>
                      <span className="truncate">{s.custName}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      <div className="flex flex-wrap items-center gap-4 border-t border-[var(--row-rule)] px-3 py-2 text-[11.5px] text-meta">
        <span className="flex items-center gap-1.5"><span className="size-2.5 rounded-[2px] bg-[#3f424d]" /> Scheduled</span>
        <span className="flex items-center gap-1.5"><span className="size-2.5 rounded-[2px] bg-[#3f424d] ring-1 ring-inset ring-attention/60" /> Pickup (P)</span>
        <span className="flex items-center gap-1.5"><span className="size-2.5 rounded-[2px] bg-[#244a35] ring-1 ring-inset ring-positive/70" /> Done</span>
        <span className="flex items-center gap-1.5"><span className="size-2.5 rounded-[2px] bg-[#4a2a2e] ring-1 ring-inset ring-critical" /> Exception</span>
        <span className="flex items-center gap-1.5"><span className="size-2.5 rounded-[2px] border border-dashed border-meta/60" /> No scheduled time</span>
        {isToday && <span className="flex items-center gap-1.5"><span className="h-3 w-px bg-[#cfd3e5]/70" /> Now</span>}
      </div>
    </section>
  );
}

// ── Stop line (inside the expanded Route & stop progress section) ─────────────────────────────────────
function StopLine({ stop, routeId, truckId, routeDone, canSupervise }: { stop: DispatchStopView; routeId: string; truckId: string; routeDone: boolean; canSupervise: boolean }): React.JSX.Element {
  const hasProof = stop.photoIds.length > 0 || Boolean(stop.signatureId);
  return (
    <li className="rounded border border-border p-2.5">
      <div className="flex items-center gap-2">
        <span className="w-5 shrink-0 text-center text-xs text-meta">{stop.sequence}</span>
        <span className="flex-1 truncate text-[13px]">{stop.custName}</span>
        {stop.kind === "pickup" && <span className="shrink-0 text-[10px] font-semibold uppercase tracking-[0.08em] text-attention">Pickup</span>}
        {stop.addrClass === "business" && (
          <span title={stop.addrNote} className={`shrink-0 text-[10px] font-semibold uppercase tracking-[0.08em] ${stop.addrHoursRisk ? "text-critical" : "text-attention"}`}>
            {stop.addrHoursRisk ? "May be closed" : "Business"}
          </span>
        )}
        <StateBadge state={stop.state} />
        {!routeDone && !stop.finished && <CompleteStopButton stopId={stop.stopId} custName={stop.custName} />}
        {stop.state === "Completed" && canSupervise && <ReopenButton truckId={truckId} routeId={routeId} stopId={stop.stopId} />}
        {stop.canPull && canSupervise && <RemoveStopButton routeId={routeId} stopId={stop.stopId} custName={stop.custName} gsLinked={false} />}
      </div>
      {stop.addrHoursRisk && <div className="mt-1 pl-7 text-[11px] text-critical">⚠ {stop.addrNote}</div>}
      {hasProof && (
        <div className="mt-2 flex flex-wrap items-center gap-2 pl-7">
          {stop.photoIds.map((id) => (
            <a key={id} href={`/api/pod/${id}`} target="_blank" rel="noopener noreferrer">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={`/api/pod/${id}`} alt="delivery photo" className="size-14 rounded object-cover" />
            </a>
          ))}
          {stop.signatureId && (
            <a href={`/api/pod/${stop.signatureId}`} target="_blank" rel="noopener noreferrer">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={`/api/pod/${stop.signatureId}`} alt="signature" className="h-14 w-24 rounded border border-border bg-white object-contain" />
            </a>
          )}
        </div>
      )}
    </li>
  );
}

// ── Expanded route detail (3 compact horizontal sections) ────────────────────────────────────────────
function RouteDetail({ route, canSupervise }: { route: DispatchRouteView; canSupervise: boolean }): React.JSX.Element {
  const s = route.staffing;
  const win = (() => {
    const timed = route.stops.map((st) => st.plannedWindow || st.eta).filter(Boolean) as string[];
    if (timed.length === 0) return "No scheduled times";
    const first = formatClockTime(timed[0]);
    const last = formatClockTime(timed[timed.length - 1]);
    return first === last ? first : `${first} – ${last}`;
  })();
  const pickups = route.stops.filter((st) => st.kind === "pickup").length;
  const deliveries = route.total - pickups;
  const routeDone = route.status === "done";

  return (
    <div className="grid gap-5 border-t border-border bg-panel/40 p-4 lg:grid-cols-3">
      {/* A — Route & stop progress */}
      <div className="min-w-0 space-y-2 lg:col-span-1">
        <h4 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-meta">Route &amp; stop progress</h4>
        <div className="text-[12px] text-tertiary-text">
          {win} · {route.total} stop{route.total === 1 ? "" : "s"} · {deliveries} delivery{pickups > 0 ? ` · ${pickups} pickup` : ""}
        </div>
        {route.stops.length > 0 ? (
          <ul className="space-y-1.5">
            {route.stops.map((st) => (
              <StopLine key={st.stopId} stop={st} routeId={route.routeId} truckId={route.truckId} routeDone={routeDone} canSupervise={canSupervise} />
            ))}
          </ul>
        ) : (
          <p className="text-[12px] text-meta">No stops on this route yet.</p>
        )}
        {route.items.length > 0 && !routeDone && (
          <div className="pt-1">
            <QuoteReviewButton items={route.items} eventName={`${route.truckName} route`} />
          </div>
        )}
      </div>

      {/* B — Driver & staffing */}
      <div className="min-w-0 space-y-2">
        <h4 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-meta">Driver &amp; staffing</h4>
        <dl className="space-y-1 text-[12.5px]">
          <div className="flex justify-between gap-2"><dt className="text-meta">Driver required</dt><dd>{s.requiredByRole.driver}</dd></div>
          <div className="flex justify-between gap-2"><dt className="text-meta">Driver assigned</dt><dd>{s.hasDriver ? (s.driverName ?? "Yes") : <span className="text-attention">None</span>}</dd></div>
          {s.requiredByRole.field > 0 && (
            <div className="flex justify-between gap-2"><dt className="text-meta">Helpers</dt><dd>{s.assignedByRole.field}/{s.requiredByRole.field} assigned{s.gapByRole.field > 0 ? <span className="text-attention"> · {s.gapByRole.field} open</span> : ""}</dd></div>
          )}
          <div className="flex justify-between gap-2">
            <dt className="text-meta">Staffing</dt>
            <dd className={staffingTone(s).text}><span className={`mr-1.5 inline-block size-2 rounded-full align-middle ${staffingTone(s).dot}`} />{s.label}</dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt className="text-meta">Confirmations</dt>
            <dd className="text-tertiary-text">{s.confirmationsKnown ? (s.pendingConfirmations > 0 ? <span className="text-attention">{s.pendingConfirmations} pending</span> : "All confirmed") : <span className="text-meta">Unverified</span>}</dd>
          </div>
        </dl>
        {canSupervise && !routeDone && (
          <div className="flex items-center gap-2 pt-1">
            <DriverAssign routeId={route.routeId} date={route.date} driverName={route.driverName ?? undefined} />
            <a href={`/scheduling?date=${route.date}&focus=${encodeURIComponent(route.routeId)}`} className="text-[11.5px] text-meta underline-offset-2 hover:text-foreground hover:underline">Plan in Scheduling →</a>
          </div>
        )}
      </div>

      {/* C — Route management (secondary) */}
      {canSupervise && (
        <div className="min-w-0 space-y-2">
          <h4 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-meta">Route management</h4>
          {routeDone ? (
            <p className="inline-flex items-center gap-1.5 text-[12px] text-meta"><CircleCheck className="size-3.5" /> Route closed — reopen to adjust stops</p>
          ) : (
            <p className="text-[12px] text-meta">Tablet down / dead battery? Office controls:</p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            {!routeDone && <ResyncRouteButton routeId={route.routeId} />}
            <RemoveRouteButton routeId={route.routeId} />
            {routeDone ? <ReopenRouteButton routeId={route.routeId} /> : <CloseRouteButton routeId={route.routeId} />}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Collapsed route row ───────────────────────────────────────────────────────────────────────────────
const GRID = "grid grid-cols-[1.9fr_1fr_1.9fr_1.7fr_1.7fr_1.8fr] items-center gap-2";

function RouteRow({ route, expanded, onToggle, canSupervise, rowRef }: { route: DispatchRouteView; expanded: boolean; onToggle: () => void; canSupervise: boolean; rowRef: (el: HTMLDivElement | null) => void }): React.JSX.Element {
  const tone = staffingTone(route.staffing);
  const exec = route.executionExceptions;
  const routeDone = route.status === "done";
  return (
    <div ref={rowRef} className={`border-b border-[var(--row-rule)] last:border-b-0 ${routeDone ? "opacity-70" : ""} ${expanded ? "bg-[var(--row-hover)]" : ""}`}>
      <div className={`${GRID} px-3`}>
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          className="flex items-center gap-2 py-2.5 text-left"
        >
          {expanded ? <ChevronDown className="size-4 shrink-0 text-meta" /> : <ChevronRight className="size-4 shrink-0 text-meta" />}
          <span className="flex size-7 shrink-0 items-center justify-center rounded border border-border text-tertiary-text"><TruckIcon className="size-3.5" /></span>
          <span className="min-w-0">
            <span className="block truncate text-[13px] font-medium">{route.truckName}</span>
            <span className="block truncate text-[11px] text-meta">{routeStatusLabel(route.status, route.done, route.total)}</span>
          </span>
        </button>

        <div className="text-[13px] tabular-nums"><span className="font-medium">{route.done}/{route.total}</span></div>

        <div className="min-w-0 truncate text-[12.5px]">
          {route.driverName ? <span className="inline-flex items-center gap-1"><Users className="size-3 text-meta" />{route.driverName}</span> : <span className="text-attention">No driver</span>}
        </div>

        <div className={`flex min-w-0 items-center gap-1.5 text-[12px] ${tone.text}`}>
          <span className={`size-2 shrink-0 rounded-full ${tone.dot}`} />
          <span className="truncate">{route.staffing.label}</span>
        </div>

        <div className="text-[12px]">
          {exec > 0 ? <span className="inline-flex items-center gap-1 text-critical"><AlertTriangle className="size-3.5" />{exec} exception{exec === 1 ? "" : "s"}</span> : <span className="text-meta">On track</span>}
        </div>

        <div className="flex items-center justify-end gap-2">
          {canSupervise && !routeDone && <DriverAssign routeId={route.routeId} date={route.date} driverName={route.driverName ?? undefined} />}
          <button type="button" onClick={onToggle} aria-expanded={expanded} className="text-[11.5px] text-meta hover:text-foreground">{expanded ? "Hide" : "Details"}</button>
        </div>
      </div>
      {expanded && <RouteDetail route={route} canSupervise={canSupervise} />}
    </div>
  );
}

// ── Parent ──────────────────────────────────────────────────────────────────────────────────────────
export function DispatchExecution({
  routes,
  superseded,
  noRouteTrucks,
  isToday,
  canSupervise,
}: {
  routes: DispatchRouteView[];
  superseded: DispatchRouteView[];
  noRouteTrucks: NoRouteTruck[];
  isToday: boolean;
  canSupervise: boolean;
}): React.JSX.Element {
  const [selected, setSelected] = useState<string | null>(null);
  const rowRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  const selectRoute = useCallback((routeId: string) => {
    setSelected(routeId);
    const el = rowRefs.current.get(routeId);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
  }, []);

  const toggle = useCallback((routeId: string) => {
    setSelected((cur) => (cur === routeId ? null : routeId));
  }, []);

  const hasTimed = routes.length > 0;

  return (
    <div className="space-y-5">
      {hasTimed && <DispatchTimeline routes={routes} isToday={isToday} selectedRouteId={selected} onSelect={selectRoute} />}

      {/* Compact route execution list */}
      <section aria-label="Route execution list" className="border border-border">
        <div className={`${GRID} border-b border-border bg-background px-3 py-2 text-[10.5px] font-medium uppercase tracking-[0.08em] text-meta`}>
          <span>Vehicle / route</span>
          <span>Stops</span>
          <span>Driver</span>
          <span>Staffing</span>
          <span>Execution</span>
          <span className="text-right">Actions</span>
        </div>
        {routes.length === 0 && noRouteTrucks.length === 0 && (
          <div className="px-3 py-4 text-[13px] text-meta">No routes scheduled.</div>
        )}
        {routes.map((r) => (
          <RouteRow
            key={r.routeId}
            route={r}
            expanded={selected === r.routeId}
            onToggle={() => toggle(r.routeId)}
            canSupervise={canSupervise}
            rowRef={(el) => { if (el) rowRefs.current.set(r.routeId, el); else rowRefs.current.delete(r.routeId); }}
          />
        ))}
        {/* Trucks with no route — keep the full fleet visible */}
        {noRouteTrucks.map((t) => (
          <div key={t.truckId} className={`${GRID} border-b border-[var(--row-rule)] px-3 py-2.5 last:border-b-0`}>
            <span className="flex items-center gap-2 text-[13px] text-meta">
              <span className="flex size-7 shrink-0 items-center justify-center rounded border border-border text-meta"><TruckIcon className="size-3.5" /></span>
              {t.truckName}
            </span>
            <span className="text-[12px] text-meta">—</span>
            <span className="text-[12px] text-meta">—</span>
            <span className="text-[12px] text-meta">No route</span>
            <span className="text-[12px] text-meta">—</span>
            <span />
          </div>
        ))}
      </section>

      {superseded.length > 0 && (
        <details className="group border border-border bg-panel/40">
          <summary className="cursor-pointer select-none px-3 py-2.5 text-[12.5px] text-meta transition-colors hover:text-foreground">
            {superseded.length} earlier closed route{superseded.length === 1 ? "" : "s"} today · replaced by a newer route — show
          </summary>
          <div className="border-t border-border">
            {superseded.map((r) => (
              <RouteRow
                key={r.routeId}
                route={r}
                expanded={selected === r.routeId}
                onToggle={() => toggle(r.routeId)}
                canSupervise={canSupervise}
                rowRef={(el) => { if (el) rowRefs.current.set(r.routeId, el); else rowRefs.current.delete(r.routeId); }}
              />
            ))}
          </div>
        </details>
      )}
    </div>
  );
}
