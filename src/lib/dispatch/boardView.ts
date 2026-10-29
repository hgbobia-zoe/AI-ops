// Dispatch board — pure view logic (no DB, no React), so it is unit-testable in the node vitest env.
//
// This is the "rules calculate" layer for the Dispatch redesign: it maps route/stop/staffing/message
// states onto the shared Nocturne tone vocabulary, scopes the message feed to the routes actually on
// the board (keeping general sales follow-ups OUT of dispatch), summarises exceptions by affected route
// and severity, and reports route-source freshness honestly (distinguishing "never pulled" from "stale"
// from "fresh"). Nothing here fabricates: every value is derived from inputs the caller already has.

import type { Tone } from "@/lib/tone";
import type { StopState, RouteStatus, ExceptionType } from "@/lib/types";
import type { RouteStaffingState } from "@/lib/scheduling/routeStaffing";
import type { MessageRow, ExceptionRow } from "@/lib/db/repo";
import type { SourceFreshness } from "@/lib/pull/state";

// ── Stop state → tone ────────────────────────────────────────────────────────
// Completed/Returned = done (positive); Exception = blocked (critical); the in-flight states read as
// "in progress" (info); Waiting is not-yet-started (neutral). Colour sits on the indicator only.
export function stopStateTone(state: StopState): Tone {
  switch (state) {
    case "Completed":
    case "Returned":
      return "positive";
    case "Exception":
      return "critical";
    case "EnRoute":
    case "Arrived":
    case "HeadingBack":
      return "info";
    case "Waiting":
    default:
      return "neutral";
  }
}

// ── Route status → tone + label (mirrors the previous routeStatusLabel, now tone-aware) ──────────────
export function routeStatusView(status: RouteStatus, done: number, total: number): { tone: Tone; label: string } {
  if (status === "done") return { tone: "positive", label: "Closed" };
  if (status === "scraping") return { tone: "info", label: "Loading route…" };
  if (status === "failed") return { tone: "critical", label: "Route failed — manual entry" };
  if (total === 0) return { tone: "neutral", label: "Ready to start" };
  if (done === total) return { tone: "positive", label: "Route complete" };
  return { tone: "info", label: "In progress" };
}

// ── Staffing → tone (agrees with the shared staffing engine's own status) ────────────────────────────
export function staffingTone(s: Pick<RouteStaffingState, "requiresCrew" | "status" | "nobody">): Tone {
  if (!s.requiresCrew) return "neutral";
  if (s.status === "ok") return "positive";
  if (s.nobody) return "critical";
  return "attention";
}

// ── Message delivery status → tone ───────────────────────────────────────────────────────────────────
export function messageStatusTone(status: string | null): Tone {
  const s = (status ?? "").toLowerCase();
  if (!s) return "neutral";
  if (s.includes("deliver") && !s.includes("undeliver")) return "positive";
  if (s === "sent" || s === "ok") return "positive";
  if (s.includes("fail") || s.includes("undeliver") || s.includes("error") || s.includes("reject")) return "critical";
  if (s.includes("queue") || s.includes("send") || s.includes("pending")) return "info";
  return "neutral";
}

// ── Exception severity (deterministic classification by type) ────────────────────────────────────────
// Operational blockers (something is physically wrong with the vehicle, address, access, inventory, or
// the route/automation) are critical; soft exceptions (customer not there, unspecified) are attention.
const CRITICAL_EXCEPTIONS: ReadonlySet<string> = new Set<ExceptionType>([
  "Wrong address",
  "Access denied",
  "Vehicle issue",
  "Missing inventory",
  "Damaged inventory",
  "Route issue",
  "Automation failure",
]);

export function exceptionSeverity(type: string | null): { severity: "critical" | "attention"; tone: Tone } {
  const severity = type && CRITICAL_EXCEPTIONS.has(type) ? "critical" : "attention";
  return { severity, tone: severity };
}

// ── Message scoping ────────────────────────────────────────────────────────────────────────────────
// Dispatch shows ONLY messages reliably tied to a route on today's board — i.e. the message belongs to a
// stop (stop_id) that is on one of these routes. Everything else (no stop, or a stop not on the board —
// e.g. a sales quote follow-up) is kept OUT of the dispatch feed and surfaced as a count that links to
// Communications, so general sales chatter never pollutes route execution.
export function scopeDispatchMessages(
  messages: MessageRow[],
  routeStopIds: ReadonlySet<string>,
): { scoped: MessageRow[]; generalCount: number } {
  const scoped = messages.filter((m) => m.stopId != null && routeStopIds.has(m.stopId));
  return { scoped, generalCount: messages.length - scoped.length };
}

// ── Exception summary by affected route + severity (individual evidence preserved) ───────────────────
export interface RouteRef {
  routeId: string;
  truckId: string;
  truckName: string;
  stopIds: readonly string[];
}

export interface ExceptionRouteGroup {
  routeId: string | null; // null = couldn't be tied to a board route
  truckName: string;
  items: ExceptionRow[]; // the raw exceptions — individual evidence is preserved, never collapsed away
  critical: number;
  attention: number;
}

/** Group open exceptions by the route they affect (stop match first, then truck for route-level ones),
 *  counting severity per group. Unattributable exceptions land in a trailing `null`-route group. The
 *  per-exception rows are kept intact so the detail view can still show each reason + timestamp + resolve. */
export function summarizeExceptionsByRoute(
  exceptions: ExceptionRow[],
  routes: readonly RouteRef[],
): ExceptionRouteGroup[] {
  const stopToRoute = new Map<string, RouteRef>();
  const truckToRoute = new Map<string, RouteRef>();
  for (const r of routes) {
    for (const sid of r.stopIds) stopToRoute.set(sid, r);
    if (!truckToRoute.has(r.truckId)) truckToRoute.set(r.truckId, r);
  }

  const groups = new Map<string, ExceptionRouteGroup>();
  const keyFor = (r: RouteRef | undefined): string => r?.routeId ?? "__unassigned__";

  for (const x of exceptions) {
    const route =
      (x.stopId ? stopToRoute.get(x.stopId) : undefined) ??
      (x.truckId ? truckToRoute.get(x.truckId) : undefined);
    const key = keyFor(route);
    let g = groups.get(key);
    if (!g) {
      g = {
        routeId: route?.routeId ?? null,
        truckName: route?.truckName ?? "Unassigned",
        items: [],
        critical: 0,
        attention: 0,
      };
      groups.set(key, g);
    }
    g.items.push(x);
    if (exceptionSeverity(x.type).severity === "critical") g.critical += 1;
    else g.attention += 1;
  }

  // Route groups first (in the board's route order), unassigned last.
  const ordered: ExceptionRouteGroup[] = [];
  for (const r of routes) {
    const g = groups.get(r.routeId);
    if (g) ordered.push(g);
  }
  const unassigned = groups.get("__unassigned__");
  if (unassigned) ordered.push(unassigned);
  return ordered;
}

// ── Route-source freshness (honest: never-pulled vs stale vs fresh) ──────────────────────────────────
export interface RouteFreshness {
  everPulled: boolean; // a route:* source has recorded at least one successful pull
  lastPullAt: string | null; // ISO of the most recent route pull across the given trucks
  ageHours: number | null; // hours since that pull
  stale: boolean; // older than the threshold (only meaningful when everPulled)
}

/** Most-recent route pull across the given trucks, from the pull-state `sources` map. Freshness is
 *  tracked per source as `route:<truckId>`; we report the latest of those. `stale` keys off `staleH`
 *  (default 20h, matching the app-wide pull banner). Honest: no route source ⇒ everPulled false and a
 *  null age — the caller shows "no data retrieved", never a fake timestamp. */
export function routePullFreshness(
  sources: Record<string, SourceFreshness> | undefined,
  truckIds: readonly string[],
  nowMs: number = Date.now(),
  staleH = 20,
): RouteFreshness {
  const ids = new Set(truckIds);
  let latest = NaN;
  let found = false;
  for (const [key, v] of Object.entries(sources ?? {})) {
    if (!key.startsWith("route:")) continue;
    const truck = key.slice("route:".length);
    if (ids.size > 0 && !ids.has(truck)) continue;
    const t = Date.parse(v.at);
    if (Number.isNaN(t)) continue;
    found = true;
    if (Number.isNaN(latest) || t > latest) latest = t;
  }
  if (!found) return { everPulled: false, lastPullAt: null, ageHours: null, stale: false };
  const ageHours = (nowMs - latest) / 3_600_000;
  return { everPulled: true, lastPullAt: new Date(latest).toISOString(), ageHours, stale: ageHours > staleH };
}
