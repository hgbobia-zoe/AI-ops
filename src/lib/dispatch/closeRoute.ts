// Shared "close one route" logic behind both the single dispatch close and the bulk "close all past
// routes" action. Closing marks the route done (preserving each stop's real state — it never fabricates
// completions) and records the post-event outcome (completed vs total stops) per event. It does NOT post
// Slack: the caller decides (the single close posts a per-route note; the bulk close posts one summary).

import { closeRoute, getRouteById, type IncompleteStop } from "@/lib/db/repo";
import { recordEventOutcome, logChange } from "@/lib/history/store";

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
  }

  return { ...result, date: route?.date };
}
