// Route reconciliation — merges a fresh Goodshuffle pull into the route the driver may already be
// running, WITHOUT losing progress. Pure + unit-tested because getting it wrong loses completed
// deliveries or misroutes the driver.
//
// Rules:
//  - Preserve EVERY stop the driver has acted on (any non-Waiting state), wherever it sits — not
//    just a leading prefix. Out-of-order completions must never revert to Waiting (keeps state,
//    timestamps, and proof-of-delivery, which live on the stop row by stopId).
//  - Match incoming↔existing by STABLE IDENTITY (Goodshuffle txId), never by array position —
//    Goodshuffle can reorder/insert/remove waypoints overnight.
//  - The stop the driver is actively EnRoute to gets corrected contact/address overlaid from its
//    txId-matched incoming stop (the emergency-address-change path).
//  - Refresh the not-yet-started tail from the pull; drop upcoming stops Goodshuffle removed.

import type { Stop } from "@/lib/types";

function buildStop(s: Partial<Stop>, ids: { stopId: string; customerId: string; sequence: number }): Stop {
  return {
    stopId: ids.stopId,
    routeId: "", // filled in by withRoute() in the caller
    customerId: ids.customerId,
    sequence: ids.sequence,
    state: "Waiting",
    custName: s.custName ?? "",
    custFirstName: s.custFirstName ?? undefined,
    custLastName: s.custLastName ?? undefined,
    kind: s.kind === "pickup" ? "pickup" : s.kind === "delivery" ? "delivery" : undefined,
    custPhone: s.custPhone ?? "",
    address: s.address ?? "",
    dayOfName: s.dayOfName,
    dayOfPhone: s.dayOfPhone,
    plannedWindow: s.plannedWindow,
    eta: s.eta,
    items: Array.isArray(s.items) ? s.items : undefined,
    txId: s.txId ?? undefined,
    contactId: s.contactId ?? undefined,
  };
}

/** Overlay an incoming stop's mutable customer/address fields onto an existing stop, preserving
 *  its identity, state, timestamps, and POD. Used for the active EnRoute stop only. */
function overlay(existingStop: Stop, incoming?: Partial<Stop>): Stop {
  if (!incoming) return existingStop;
  return {
    ...existingStop,
    custName: incoming.custName ?? existingStop.custName,
    custFirstName: incoming.custFirstName ?? existingStop.custFirstName,
    custLastName: incoming.custLastName ?? existingStop.custLastName,
    kind: incoming.kind ?? existingStop.kind,
    custPhone: incoming.custPhone ?? existingStop.custPhone,
    address: incoming.address ?? existingStop.address,
    dayOfName: incoming.dayOfName ?? existingStop.dayOfName,
    dayOfPhone: incoming.dayOfPhone ?? existingStop.dayOfPhone,
    plannedWindow: incoming.plannedWindow ?? existingStop.plannedWindow,
    eta: incoming.eta ?? existingStop.eta,
    items: incoming.items ?? existingStop.items,
    txId: incoming.txId ?? existingStop.txId,
    contactId: incoming.contactId ?? existingStop.contactId,
  };
}

export interface ReconcileResult {
  stops: Stop[];
  keptCount: number; // number of already-actioned stops preserved
}

export function reconcileStops(existing: Stop[], incoming: Partial<Stop>[], routeId: string): ReconcileResult {
  const withRoute = (s: Stop): Stop => ({ ...s, routeId });

  // Every acted-on stop is preserved (not just a leading prefix).
  const actioned = existing.filter((s) => s.state !== "Waiting");

  if (actioned.length === 0) {
    // Nothing started — full replace from the pull.
    const stops = incoming.map((s, i) =>
      withRoute(buildStop(s, { stopId: `${routeId}-S${i + 1}`, customerId: `${routeId}-C${i + 1}`, sequence: i + 1 })),
    );
    return { stops, keptCount: 0 };
  }

  // Index incoming by txId — the reliable match key.
  const incomingByTx = new Map<string, Partial<Stop>>();
  for (const s of incoming) if (s.txId) incomingByTx.set(s.txId, s);

  // Keep each actioned stop; overlay the EnRoute one from its txId-matched incoming.
  const kept = actioned.map((s) => {
    const match = s.txId ? incomingByTx.get(s.txId) : undefined;
    return s.state === "EnRoute" ? overlay(s, match) : s;
  });

  // Upcoming = incoming NOT already represented by a kept stop (matched by txId). Untxed incoming
  // can't be matched, so they pass through (legacy pulls without ids).
  const keptTx = new Set(kept.map((s) => s.txId).filter((t): t is string => Boolean(t)));
  const upcoming = incoming.filter((s) => !s.txId || !keptTx.has(s.txId));

  // Kept stops preserve their original stopId (POD refs travel with it); only sequence renumbers.
  // Upcoming get a distinct "-U" id prefix so they can never collide with a kept "-S" id.
  const keptRenum = kept.map((s, i) => withRoute({ ...s, sequence: i + 1 }));
  const upcomingStops = upcoming.map((s, i) =>
    withRoute(buildStop(s, { stopId: `${routeId}-U${i + 1}`, customerId: `${routeId}-UC${i + 1}`, sequence: kept.length + i + 1 })),
  );

  return { stops: [...keptRenum, ...upcomingStops], keptCount: kept.length };
}
