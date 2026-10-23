// FI Stage 4 — GPS visit polling tick (forward-only, quota-safe). Polls the CURRENT position of ACTIVE
// trucks only (a truck with a non-done route today) and stores each fix in gps_positions. This is the
// ONLY thing that builds the GPS presence history — we never backfill, because the provider is
// live-position-only (eta/zonar.ts exposes a single current fix) and daily-quota'd.
//
// QUOTA DISCIPLINE: we poll a vehicle at most once per `gpsPollSeconds` (checked against its last stored
// fix), and we reuse getTruckPosition's EXISTING daily-quota + 429-backoff guard — a 429/unreachable
// returns null and we simply skip (never a fabricated fix). So however often the runtime tick fires, the
// provider is never hammered.

import { visitReconcileConfig } from "./config";
import { getTruckPosition, zonarConfigured } from "@/lib/eta/zonar";
import { getActiveVehicles } from "@/lib/vehicles";
import { getRoutesForDate, getLastGpsPositionTs, saveGpsPosition } from "@/lib/db/repo";
import { todayInOpsTz } from "@/lib/dates";

const SOURCE = "gpstrackit";

/** Trucks with a non-done route today (ops tz) — the only vehicles worth polling. */
function activeTruckIdsToday(today: string): string[] {
  const out: string[] = [];
  for (const v of getActiveVehicles()) {
    const routes = getRoutesForDate(v.truckId, today);
    if (routes.some((r) => r.status !== "done")) out.push(v.truckId);
  }
  return out;
}

export interface GpsPollResult {
  ok: boolean;
  detail: string;
}

/** Poll + store one current fix per active truck, honouring the per-vehicle cadence. Never throws. */
export async function runGpsVisitPoll(now: Date = new Date()): Promise<GpsPollResult> {
  const cfg = visitReconcileConfig();
  if (!cfg.enabled) return { ok: false, detail: "visit layer disabled" };
  if (!zonarConfigured()) return { ok: false, detail: "GPS not configured" };

  const today = todayInOpsTz(now);
  const trucks = activeTruckIdsToday(today);
  if (trucks.length === 0) return { ok: true, detail: "no active trucks to poll" };

  let stored = 0;
  let skippedCadence = 0;
  let noFix = 0;
  const cadenceMs = cfg.gpsPollSeconds * 1000;

  for (const truckId of trucks) {
    // Cadence gate: skip if we stored a fix for this vehicle within gpsPollSeconds (stays under quota).
    const lastTs = getLastGpsPositionTs(truckId);
    if (lastTs && now.getTime() - Date.parse(lastTs) < cadenceMs) {
      skippedCadence++;
      continue;
    }
    let pos;
    try {
      pos = await getTruckPosition(truckId); // null when unconfigured / backing off / unreachable
    } catch {
      pos = null;
    }
    if (!pos) {
      noFix++; // honest: quota/429/unreachable → no fix stored, never fabricated
      continue;
    }
    // Use the provider's own fix time when present; else the poll instant. Both are stored idempotently.
    const ts = pos.ts && !Number.isNaN(Date.parse(pos.ts)) ? new Date(pos.ts).toISOString() : now.toISOString();
    saveGpsPosition({ vehicleId: truckId, lat: pos.lat, lng: pos.lng, ts, source: SOURCE });
    stored++;
  }

  const detail = `${trucks.length} active truck${trucks.length === 1 ? "" : "s"}: ${stored} fix${stored === 1 ? "" : "es"} stored${skippedCadence ? `, ${skippedCadence} within-cadence` : ""}${noFix ? `, ${noFix} no-fix` : ""}`;
  // ok even when nothing stored: a within-cadence skip or a transient no-fix is a healthy no-op, not a failure.
  return { ok: true, detail };
}
