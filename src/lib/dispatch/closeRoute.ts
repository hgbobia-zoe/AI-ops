// Shared "close one route" logic behind both the single dispatch close and the bulk "close all past
// routes" action. Closing marks the route done (preserving each stop's real state — it never fabricates
// completions) and records the post-event outcome (completed vs total stops) per event. It does NOT post
// Slack: the caller decides (the single close posts a per-route note; the bulk close posts one summary).

import { closeRoute, getRouteById, recordStopCloseResolution, updateStopState, type IncompleteStop } from "@/lib/db/repo";
import { recordEventOutcome, logChange } from "@/lib/history/store";
import { scheduleScanSoon } from "@/lib/risk/scan";
import type { CloseResolutionInput } from "@/lib/dispatch/onTime";
import { isResolved } from "@/lib/dispatch/onTime";

export interface AppliedResolution {
  stopId: string;
  sequence: number;
  custName: string;
  resolution: "marked_completed" | "reason" | "none";
  reason?: string;
}

/**
 * Before closing a route, record what the closer chose for each stop that is still not completed: mark it
 * completed now, or leave it open with a reason. A stop with no acceptable resolution (an older tablet
 * build, an offline replay, the bulk close) is recorded as "none" with `fallbackReason`, so the close is
 * never blocked but the gap stays visible. "Mark completed" sets the stop Completed with the close time and
 * records resolution "marked_completed", so it never reads as a real driver tap. No-op on a route that is
 * already closed (a repeat close never rewrites the first closer's record). `by` names who closed it.
 */
export function applyCloseResolutions(
  routeId: string,
  resolutions: CloseResolutionInput[] | undefined,
  by: string,
  fallbackReason: string | null = null,
  now: string = new Date().toISOString(),
): AppliedResolution[] {
  const route = getRouteById(routeId);
  if (!route || route.status === "done") return [];
  const byId = new Map((resolutions ?? []).map((r) => [r.stopId, r]));
  const out: AppliedResolution[] = [];
  for (const s of route.stops) {
    if (s.state === "Completed" || s.state === "Returned") continue;
    const r = byId.get(s.stopId);
    if (r && isResolved(r) && r.action === "completed") {
      updateStopState(s.stopId, "Completed", { completedAt: now });
      recordStopCloseResolution(s.stopId, { resolution: "marked_completed", reason: r.reason ?? null, by, at: now });
      out.push({ stopId: s.stopId, sequence: s.sequence, custName: s.custName, resolution: "marked_completed" });
    } else if (r && isResolved(r)) {
      const reason = (r.reason ?? "").trim();
      recordStopCloseResolution(s.stopId, { resolution: "reason", reason, by, at: now });
      out.push({ stopId: s.stopId, sequence: s.sequence, custName: s.custName, resolution: "reason", reason });
    } else {
      recordStopCloseResolution(s.stopId, { resolution: "none", reason: fallbackReason, by, at: now });
      out.push({ stopId: s.stopId, sequence: s.sequence, custName: s.custName, resolution: "none", reason: fallbackReason ?? undefined });
    }
  }
  return out;
}

/** Normalize an untrusted `stopResolutions` body field into well-formed inputs (drops junk). */
export function parseCloseResolutions(raw: unknown): CloseResolutionInput[] {
  if (!Array.isArray(raw)) return [];
  const out: CloseResolutionInput[] = [];
  for (const x of raw) {
    if (!x || typeof x !== "object") continue;
    const o = x as Record<string, unknown>;
    if (typeof o.stopId !== "string" || !o.stopId) continue;
    if (o.action !== "completed" && o.action !== "reason") continue;
    out.push({ stopId: o.stopId, action: o.action, reason: typeof o.reason === "string" ? o.reason.slice(0, 500) : undefined });
  }
  return out;
}

export interface CloseOneResult {
  ok: boolean;
  routeId?: string;
  truckId?: string;
  date?: string;
  already?: boolean;
  incomplete?: IncompleteStop[];
}

export function closeOneRoute(routeId: string): CloseOneResult {
  const result = closeRoute(routeId);
  if (!result.ok) return { ok: false };
  const route = getRouteById(routeId);

  // First close only: record how each event on the route went (completed vs total stops).
  if (!result.already && route) {
    const groups = new Map<string, { total: number; done: number }>();
    for (const s of route.stops) {
      const key = s.txId || routeId;
      const g = groups.get(key) ?? { total: 0, done: 0 };
      g.total++;
      if (s.state === "Completed" || s.state === "Returned") g.done++;
      groups.set(key, g);
    }
    for (const [eventId, g] of groups) {
      recordEventOutcome({ eventId, routeId, date: route.date, totalStops: g.total, completedStops: g.done });
      logChange({
        source: "dispatch",
        entity: "event",
        entityId: eventId,
        eventId: eventId === routeId ? undefined : eventId,
        kind: "event_completed",
        field: `${g.done}/${g.total} stops`,
        toValue: g.done >= g.total ? "complete" : "partial",
        changeKey: `outcome|${routeId}|${eventId}`,
      });
    }

    // The key fix for the prep-window incident: finishing today's route (office close OR the driver's
    // ARRIVED_WAREHOUSE closeout, which routes through here) is exactly when tomorrow's prep window may
    // open — the truck is now free. Debounced re-scan so the opportunity surfaces within seconds instead
    // of waiting for the next scheduled sweep. Best-effort; a scan failure never fails the close.
    try {
      scheduleScanSoon();
    } catch (e) {
      console.error("[closeRoute] scheduleScanSoon threw (ignored):", e);
    }
  }

  return { ...result, date: route?.date };
}

/**
 * The "needs rescheduling" Slack line for a route closed with unfinished stops, or null when there's
 * nothing to flag (closed clean, or a repeat close of an already-done route). Shared so EVERY close path
 * — the office single close, the bulk past-routes close, AND the driver's ARRIVED_WAREHOUSE closeout —
 * emits the SAME alert. PURE (builds the text only; the caller posts it), so closeRoute.ts stays free of
 * Slack. `by` names who closed it (an office actor, or "the driver" for the warehouse-arrival path).
 */
/** Slack line for stops the closer marked completed at close time (no driver tap), or null if none. */
export function markedCompletedLine(applied: AppliedResolution[], truckLabel: string, by: string): string | null {
  const marked = applied.filter((a) => a.resolution === "marked_completed");
  if (marked.length === 0) return null;
  const list = marked.map((a) => `#${a.sequence} ${a.custName || "unnamed stop"}`).join(", ");
  return `${truckLabel}: ${by} marked ${marked.length} stop${marked.length === 1 ? "" : "s"} completed at closeout without a driver tap: ${list}.`;
}

export function rescheduleAlertLine(result: CloseOneResult, by: string): string | null {
  if (result.already || !result.incomplete || result.incomplete.length === 0) return null;
  const n = result.incomplete.length;
  const list = result.incomplete
    .map((s) => `#${s.sequence} ${s.custName || "—"} (${s.state})${s.closeReason ? `: "${s.closeReason}"` : ", no reason given"}`)
    .join(", ");
  return `⚠️ *${result.truckId ?? "Route"} route closed by ${by} with ${n} unfinished stop${n === 1 ? "" : "s"}* — needs rescheduling: ${list}`;
}
