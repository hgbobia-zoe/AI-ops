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

import type { Stop, StopState } from "@/lib/types";

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

// ── Force re-sync ──────────────────────────────────────────────────────────────
//
// forceReconcileStops is the EXPLICIT "Re-sync from Goodshuffle" variant. Unlike reconcileStops (which
// protects in-progress work and only reorders the Waiting tail), this makes the route match Goodshuffle's
// CURRENT order exactly — even for an in-progress route — because the office/driver asked for it on
// purpose. It is still honest and safe: a delivery that actually happened (Completed/Returned, with its
// POD + timestamps) is NEVER erased.
//
// Semantics (matched by Goodshuffle txId, never array position):
//  - Output order IS the incoming (Goodshuffle) order, one stop per incoming row.
//  - Incoming row matches an existing Completed/Returned stop → keep it AS-IS (same stopId, state,
//    arrivedAt/completedAt, proof/POD); only renumber to the GS position and overlay the mutable
//    customer/address fields from incoming.
//  - Incoming row matches an existing stop in ANY OTHER state (Waiting/EnRoute/Exception/HeadingBack/…)
//    → REDIRECT: keep its stopId + txId but reset state to "Waiting" and clear arrivedAt/completedAt,
//    at the GS position, overlaying the mutable fields. (So moving a stop ahead of the one the driver is
//    EnRoute to resets that driver stop to Waiting — the route literally re-orders.)
//  - Incoming row with no existing match → a brand-new Waiting stop at that position.
//  - A stop in existing but NOT in incoming is DROPPED (Goodshuffle removed it) — EXCEPT a
//    Completed/Returned stop, which is appended at the END keeping its done state + POD, so a delivery
//    that happened is never silently erased from the record.
//  - keptCount = number of Completed/Returned stops preserved (both repositioned and appended).
//
// Pure (no DB), like reconcileStops.
export function forceReconcileStops(existing: Stop[], incoming: Partial<Stop>[], routeId: string): ReconcileResult {
  const withRoute = (s: Stop): Stop => ({ ...s, routeId });
  const isDone = (st: StopState): boolean => st === "Completed" || st === "Returned";

  // Match by STABLE identity (Goodshuffle txId), never by array position.
  const existingByTx = new Map<string, Stop>();
  for (const s of existing) if (s.txId) existingByTx.set(s.txId, s);

  // Reserve EVERY existing stopId so a brand-new stop can never be minted with a colliding id — a matched
  // stop keeps its id wherever Goodshuffle moved it, and a done stop missing from the pull is appended
  // keeping its id too. Reserving a dropped stop's id as well is harmless and keeps this simple.
  const reserved = new Set<string>(existing.map((s) => s.stopId));

  const matchedTx = new Set<string>();
  const out: Stop[] = [];

  incoming.forEach((inc, i) => {
    const sequence = i + 1;
    const match = inc.txId ? existingByTx.get(inc.txId) : undefined;
    if (match && inc.txId) matchedTx.add(inc.txId);

    if (match && isDone(match.state)) {
      // Finished delivery: keep state/timestamps/POD/stopId; only reposition + overlay mutable fields.
      out.push(withRoute({ ...overlay(match, inc), sequence }));
    } else if (match) {
      // REDIRECT an in-progress/upcoming stop to Goodshuffle's position: keep identity, reset to Waiting.
      out.push(withRoute({ ...overlay(match, inc), state: "Waiting", arrivedAt: undefined, completedAt: undefined, sequence }));
    } else {
      // Brand-new Goodshuffle stop at this position. Dedupe the id against preserved stopIds.
      let stopId = `${routeId}-S${sequence}`;
      while (reserved.has(stopId)) stopId += "x";
      reserved.add(stopId);
      out.push(withRoute(buildStop(inc, { stopId, customerId: `${routeId}-C${sequence}`, sequence })));
    }
  });

  // Never silently erase a delivery that happened: a Completed/Returned stop missing from the pull is
  // appended at the end (done state + POD intact). Non-done stops missing from the pull are dropped.
  for (const s of existing) {
    if (!isDone(s.state)) continue;
    if (s.txId && matchedTx.has(s.txId)) continue;
    out.push(withRoute({ ...s }));
  }

  // Renumber contiguously (covers the appended done tail too).
  const stops = out.map((s, i) => ({ ...s, sequence: i + 1 }));
  const keptCount = stops.filter((s) => isDone(s.state)).length;
  return { stops, keptCount };
}
