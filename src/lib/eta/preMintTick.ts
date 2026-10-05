// The runtime PRE-MINT tick — enqueue Ignition etaLink mints for UPCOMING stops ahead of departure, so
// the real live link is already minted while the office Ignition session is fresh (not at the split-
// second of departure). Side-effecting but SAFE: it only geocodes + enqueues mint requests (the extension
// drains them via the existing /api/etalink/pending loop — NO extension change) and runs the Ignition
// health probe that fires the "signed out" Slack alert. No customer sends, no Ignition write from here.
//
// WHICH stops: for each active truck's routes TODAY (every upcoming stop) and EARLY TOMORROW (only stops
// scheduled within the next ~12h), a stop that is still Waiting/EnRoute, has a usable address + someone to
// text, and isn't already covered by a current minted/pending link. See selection rules in ./preMint.
//
// WINDOW: from now through the stop's scheduled time + a buffer, floored at ETA_LINK_SHIFT_WINDOW_H and
// clamped to PREMINT_MAX_WINDOW_H (≤24h). A stop with no scheduled time uses end-of-day. Never fabricated.
//
// Gated by the existing RUNTIME_TOKEN cadence (registered in RUNTIME_JOBS). Honest: if the office session
// is down all day, nothing mints and departure still falls back to the functional /track link.

import { geocode } from "./geo";
import { shiftWindowHours } from "./etaLinkMint";
import { selectStopsToPreMint, preMintWindow, hasUpcomingDeliveries, type RouteForPreMint } from "./preMint";
import { getActiveVehicles } from "@/lib/vehicles";
import { getRoutesForDate, enqueueEtaLinkMint, hasCurrentEtaLinkForStop } from "@/lib/db/repo";
import { todayInOpsTz, shiftYmd, endOfOpsDayISO } from "@/lib/dates";
import { ignitionHealth, recordIgnitionProbe } from "@/lib/pull/state";
import { slackNotify } from "@/lib/notify/slack";
import type { Route } from "@/lib/types";

export interface PreMintTickResult {
  ok: boolean;
  detail: string;
}

/** Gather today's + tomorrow's routes for every active truck, tagged for the selector. */
function gatherRoutes(today: string, tomorrow: string): { routes: RouteForPreMint[]; todayRoutes: Route[] } {
  const routes: RouteForPreMint[] = [];
  const todayRoutes: Route[] = [];
  for (const v of getActiveVehicles()) {
    for (const [date, isToday] of [
      [today, true],
      [tomorrow, false],
    ] as const) {
      for (const route of getRoutesForDate(v.truckId, date)) {
        routes.push({ route, truckId: v.truckId, truckLabel: v.name, isToday });
        if (isToday) todayRoutes.push(route);
      }
    }
  }
  return { routes, todayRoutes };
}

/**
 * Run one pre-mint tick. Never throws; returns a short human detail. Also runs the Ignition health probe
 * so a lapsed office session Slack-alerts (gated on there being deliveries to track today).
 */
export async function runEtaPreMintTick(now: Date = new Date()): Promise<PreMintTickResult> {
  // Respect the global mint escape hatch (ETA_LINK_MINT=0 → pure /track, no minting at all).
  if (process.env.ETA_LINK_MINT === "0") return { ok: true, detail: "minting disabled" };

  const today = todayInOpsTz(now);
  const tomorrow = shiftYmd(today, 1);
  const { routes, todayRoutes } = gatherRoutes(today, tomorrow);

  // ── Ignition health probe + "signed out" alert (only matters when there are deliveries to track) ──
  const hasDeliveriesToday = hasUpcomingDeliveries(todayRoutes);
  const health = ignitionHealth(20, now.getTime());
  const { alert } = recordIgnitionProbe(health.ok, hasDeliveriesToday, health.configured, now);
  if (alert) void slackNotify(alert);

  // ── Pre-mint the upcoming stops ──
  const plan = selectStopsToPreMint({ routes, now });
  const minWindowH = shiftWindowHours();
  let enqueued = 0;
  let alreadyCovered = 0;
  let noGeo = 0;

  for (const item of plan) {
    // Idempotency guard: skip a stop already covered by a current minted/pending link (also avoids an
    // unnecessary geocode). enqueueEtaLinkMint re-checks this atomically, so a race can't double-mint.
    if (hasCurrentEtaLinkForStop(item.stop.stopId, now.getTime())) {
      alreadyCovered += 1;
      continue;
    }
    const coords = await geocode(item.stop.address).catch(() => null);
    if (!coords) {
      noGeo += 1;
      continue; // no coordinates → createEtaLink can't run; departure's /track fallback still works
    }
    const win = preMintWindow({
      now,
      stopTimeISO: item.stopTimeISO,
      // Fallback end for an untimed stop = end of today in the ops tz. (Only today stops can be untimed:
      // the selector skips tomorrow stops that have no real scheduled time, so this is always `today`.)
      fallbackEndISO: endOfOpsDayISO(today),
      minWindowH,
    });
    const state = enqueueEtaLinkMint({
      stopId: item.stop.stopId,
      routeId: item.routeId,
      truckId: item.truckId,
      truckLabel: item.truckLabel,
      address: item.stop.address,
      lat: coords.lat,
      lng: coords.lng,
      etaHours: null, // pre-mint: no live ETA yet — Ignition recomputes live (never a fabricated estimate)
      startISO: win.startISO,
      endISO: win.endISO,
    });
    if (state.status === "pending") enqueued += 1;
    else alreadyCovered += 1; // enqueue found a current row (raced with another writer)
  }

  const parts = [`${enqueued} pre-minted`, `${alreadyCovered} already set`];
  if (noGeo) parts.push(`${noGeo} no geo`);
  parts.push(health.ok ? "ignition ok" : hasDeliveriesToday ? "ignition signed out" : "ignition idle");
  return { ok: true, detail: parts.join(", ") };
}
