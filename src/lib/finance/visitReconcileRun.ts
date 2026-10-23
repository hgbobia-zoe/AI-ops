// FI Stage 4 — visit-reconciliation RECOMPUTE (the impure WIRING glue). Called from the risk scan right
// after saveDerivedLabor, so the two on-site evidence sources recompute idempotently on the same cadence
// as attributed labor. This module is the impure boundary: it reads the DB + geocodes stop addresses; the
// deterministic logic lives in the PURE, tested visitReconcile.ts.
//
// HONESTY / FORWARD-ONLY: the DISPATCH source derives for PAST and present days alike (it reads stored
// arrived/completed times). The GPS source only ever appears for days we actually polled — there is NO
// historical backfill (the provider is live-position-only + quota'd). A stop with no inside fix gets NO
// gps window (UNAVAILABLE, never a fabricated presence). The whole recompute is wrapped by the caller in
// try/catch — a failure here must never break the core scan.

import { visitReconcileConfig } from "./config";
import { deriveDispatchVisit, geofenceVisit, gpsVisitFrom, type VisitWindow } from "./visitReconcile";
import { getVisitStops, getGpsPositionsBetween, saveVisitEvents, type VisitEventInput } from "@/lib/db/repo";
import { geocode, type LatLng } from "@/lib/eta/geo";
import { endOfOpsDayISO, shiftYmd } from "@/lib/dates";

export interface VisitRecomputeResult {
  dispatchRows: number;
  gpsRows: number;
  skipped?: string;
}

/** Ops-calendar-day bounds (UTC ms) for a YYYY-MM-DD — tz-correct via endOfOpsDayISO. */
function dayBoundsMs(day: string): { startMs: number; endMs: number; startISO: string; endISO: string } {
  const startISO = endOfOpsDayISO(shiftYmd(day, -1)); // 23:59:59.999 of the PRIOR ops day
  const endISO = endOfOpsDayISO(day);
  return { startMs: Date.parse(startISO) + 1, endMs: Date.parse(endISO), startISO, endISO };
}

/**
 * Recompute + persist both visit sources for the given scanned days. Deterministic given the DB + geocode
 * results. `geo` is injectable for tests; defaults to the real geocoder (process-wide cached in geo.ts).
 */
export async function recomputeVisitReconciliation(
  days: string[],
  geo: (a: string) => Promise<LatLng | null> = geocode,
): Promise<VisitRecomputeResult> {
  const cfg = visitReconcileConfig();
  if (!cfg.enabled) return { dispatchRows: 0, gpsRows: 0, skipped: "disabled" };
  const scanDays = [...new Set(days)].filter(Boolean);
  if (scanDays.length === 0) return { dispatchRows: 0, gpsRows: 0, skipped: "no-days" };

  const stops = getVisitStops(scanDays);
  if (stops.length === 0) return { dispatchRows: 0, gpsRows: 0, skipped: "no-stops" };

  // ── Geocode each unique address once (the geofence centre). A miss → no gps window for that stop. ──
  const centreByAddress = new Map<string, LatLng | null>();
  for (const s of stops) {
    const key = s.address.trim();
    if (key && !centreByAddress.has(key)) centreByAddress.set(key, await geo(key));
  }

  // ── Fetch each vehicle's stored fixes per day once (dedupe by vehicle|day). ──
  const fixesByVehicleDay = new Map<string, Array<{ ts: string; lat: number; lng: number }>>();
  for (const s of stops) {
    const vdKey = `${s.truckId}|${s.day}`;
    if (!fixesByVehicleDay.has(vdKey)) {
      const b = dayBoundsMs(s.day);
      fixesByVehicleDay.set(vdKey, getGpsPositionsBetween(s.truckId, b.startISO, b.endISO));
    }
  }

  const items: VisitEventInput[] = [];
  let dispatchRows = 0;
  let gpsRows = 0;

  for (const s of stops) {
    const ids = { stopId: s.stopId, routeId: s.routeId, txId: s.txId ?? undefined };

    // DISPATCH source — past + present. arrived→completed, LOW confidence (server-receive times).
    const dispatch = deriveDispatchVisit({ ...ids, arrivedAt: s.arrivedAt, completedAt: s.completedAt });
    if (dispatch) {
      items.push(toInput(dispatch));
      dispatchRows++;
    }

    // GPS source — forward-only. Needs a geocoded centre AND at least one stored fix inside the geofence
    // within the visit's time window (dispatch-bounded when we have it, else the full ops day).
    //
    // ── HISTORICAL-BACKFILL SEAM (UNVERIFIED, account-gated — DO NOT wire speculatively) ──────────────
    // We only ever geofence fixes we POLLED ourselves (gps_positions). The telematics vendor MAY expose a
    // historical track/trip endpoint, but it is unconfirmed + likely retention-limited (audit §2.7.1), so
    // nothing here calls one. IF a GPS-history endpoint is later confirmed against live credentials, the
    // ONLY change needed is to backfill gps_positions for the target days (one import), after which this
    // same geofence path derives the historical gps windows with no edit here — the presence logic stays
    // forward-only by construction and never fabricates a fix.
    const centre = centreByAddress.get(s.address.trim()) ?? null;
    if (centre) {
      const fixes = fixesByVehicleDay.get(`${s.truckId}|${s.day}`) ?? [];
      const b = dayBoundsMs(s.day);
      const arrivedMs = s.arrivedAt ? Date.parse(s.arrivedAt) : NaN;
      const completedMs = s.completedAt ? Date.parse(s.completedAt) : NaN;
      const window = Number.isFinite(arrivedMs)
        ? { startMs: Math.max(b.startMs, arrivedMs), endMs: Number.isFinite(completedMs) ? completedMs : b.endMs }
        : { startMs: b.startMs, endMs: b.endMs };
      const geofenced = geofenceVisit(fixes, centre, cfg.geofenceRadiusM, window);
      const gps = gpsVisitFrom(ids, geofenced);
      if (gps) {
        items.push(toInput(gps));
        gpsRows++;
      }
    }
  }

  // Persist non-destructively, scoped to the scanned stops + both sources (so a visit that no longer
  // derives is cleared, but another day's rows are untouched).
  saveVisitEvents(
    stops.map((s) => s.stopId),
    ["gps", "dispatch"],
    items,
  );

  return { dispatchRows, gpsRows };
}

function toInput(w: VisitWindow): VisitEventInput {
  return { txId: w.txId, routeId: w.routeId, stopId: w.stopId, source: w.source, enterTs: w.enterTs, exitTs: w.exitTs, confidence: w.confidence, note: w.note };
}
