// FI Stage 4 — GPS visit + dispatch reconciliation (the PURE, deterministic core). This module turns the
// two INDEPENDENT on-site evidence sources into labeled visit windows and chooses an authoritative one by
// the documented two-evidence rule (audit §5.2). It never touches the money-allocation math; it only
// produces an honest on-site window + confidence that a separate seam feeds into the labor cascade's
// EXISTING ACTUAL_STOP slot — and ONLY from a genuine GPS-derived window.
//
// Design law (RULES CALCULATE, NEVER FABRICATE):
//   • A GPS window = evidence the VEHICLE was physically on site (geofenced polled fixes).
//   • A dispatch window = evidence of a CREW ACTION (arrived_at/completed_at — SERVER-RECEIVE times, so
//     offline-queue skew is possible; hence always the LOWER-confidence source).
//   • Neither source overwrites the other; both are stored. We only CHOOSE a display/feed window.
//   • No fix inside the geofence → NO gps window (never a fabricated presence). All-historical and any
//     poll-gap days fall back to dispatch-only, labeled LOW / PROVISIONAL — the honest launch majority.

import type { LatLng } from "@/lib/eta/geo";
import { haversineMiles } from "@/lib/pricing/routeDistance";

const METRES_PER_MILE = 1609.344;

export type VisitSource = "gps" | "dispatch";
export type VisitConfidence = "HIGH" | "MEDIUM" | "LOW";

/** One on-site window from ONE evidence source. enter/exit are ISO; null = unknown. */
export interface VisitWindow {
  stopId: string;
  routeId: string;
  txId?: string;
  source: VisitSource;
  enterTs: string | null;
  exitTs: string | null;
  confidence: VisitConfidence;
  note?: string;
}

/** A raw GPS fix (geofence input). */
export interface GpsFix {
  ts: string;
  lat: number;
  lng: number;
}

/** The minimal stop shape the dispatch deriver needs. */
export interface DispatchStopInput {
  stopId: string;
  routeId: string;
  txId?: string;
  arrivedAt?: string | null;
  completedAt?: string | null;
}

/** True when `point` is within `radiusM` metres of `center`. Haversine (straight-line) distance:
 *  straight-line ≤ driving, and for a presence check the straight-line radius is exactly what we want. */
export function withinRadius(center: LatLng, point: LatLng, radiusM: number): boolean {
  if (radiusM <= 0) return false;
  return haversineMiles(center, point) * METRES_PER_MILE <= radiusM;
}

/**
 * Dispatch-reported visit window from a stop's arrived/completed timestamps. Confidence is always LOW:
 * these are server-receive times (offline-queue skew per audit §2.7.2), not a real on-site clock. Returns
 * null when the stop never reached ARRIVED (no crew-action evidence at all). Pure + idempotent (a given
 * stop always derives the same window). Runs for PAST and present projects alike.
 */
export function deriveDispatchVisit(stop: DispatchStopInput): VisitWindow | null {
  const enterTs = stop.arrivedAt?.trim() || null;
  if (!enterTs) return null; // no arrival → no dispatch evidence of a visit
  const exitTs = stop.completedAt?.trim() || null;
  return {
    stopId: stop.stopId,
    routeId: stop.routeId,
    txId: stop.txId,
    source: "dispatch",
    enterTs,
    exitTs,
    confidence: "LOW",
    note: "dispatch arrived→completed (server-receive times)",
  };
}

/**
 * Geofence a vehicle's GPS fixes against one stop's geocoded address into an on-site window. Only fixes
 * WITHIN `radiusM` of `center` (and within the optional time `window`) count. The window is [first inside
 * fix → last inside fix]. Returns null when NO fix is inside — forward-only, never a fabricated presence.
 *
 * Confidence: HIGH when ≥2 inside fixes span real time (a genuine dwell); MEDIUM for a single ping
 * (presence, but not a measurable dwell → not a usable duration). Pure + deterministic.
 */
export function geofenceVisit(
  fixes: GpsFix[],
  center: LatLng,
  radiusM: number,
  window?: { startMs: number; endMs: number },
): { enterTs: string; exitTs: string; fixCount: number; confidence: VisitConfidence } | null {
  const inside = fixes
    .map((f) => ({ ts: f.ts, ms: Date.parse(f.ts), lat: f.lat, lng: f.lng }))
    .filter((f) => Number.isFinite(f.ms))
    .filter((f) => !window || (f.ms >= window.startMs && f.ms <= window.endMs))
    .filter((f) => withinRadius(center, { lat: f.lat, lng: f.lng }, radiusM))
    .sort((a, b) => a.ms - b.ms);
  if (inside.length === 0) return null;
  const enterTs = inside[0].ts;
  const exitTs = inside[inside.length - 1].ts;
  const dwell = inside.length >= 2 && inside[inside.length - 1].ms > inside[0].ms;
  return { enterTs, exitTs, fixCount: inside.length, confidence: dwell ? "HIGH" : "MEDIUM" };
}

/** Build the GPS VisitWindow from a geofence result (or null when there was no inside fix). */
export function gpsVisitFrom(
  stop: { stopId: string; routeId: string; txId?: string },
  geo: ReturnType<typeof geofenceVisit>,
): VisitWindow | null {
  if (!geo) return null;
  return {
    stopId: stop.stopId,
    routeId: stop.routeId,
    txId: stop.txId,
    source: "gps",
    enterTs: geo.enterTs,
    exitTs: geo.exitTs,
    confidence: geo.confidence,
    note: `geofenced GPS presence (${geo.fixCount} fix${geo.fixCount === 1 ? "" : "es"})`,
  };
}

export type VisitLabel = "GPS_CONFIRMED" | "GPS_DISPATCH" | "DISPATCH_ONLY" | "DISPATCH_FLAGGED" | "NONE";

export interface ReconciledVisit {
  stopId: string;
  routeId: string;
  txId?: string;
  gps: VisitWindow | null;
  dispatch: VisitWindow | null;
  /** The chosen authoritative on-site window. null when neither source has one. */
  authoritative: { enterTs: string | null; exitTs: string | null; source: "gps" | "dispatch" | "gps+dispatch" } | null;
  /** |gps.enter − dispatch.enter| in minutes when both enters exist, else null. */
  discrepancyMinutes: number | null;
  /** Within tolerance? null when it can't be compared (a source missing an enter). */
  agree: boolean | null;
  /** Diverged beyond tolerance → surfaced for human review. */
  flagged: boolean;
  confidence: VisitConfidence;
  label: VisitLabel;
  note: string;
}

const minutesBetween = (a: string, b: string): number | null => {
  const am = Date.parse(a);
  const bm = Date.parse(b);
  if (Number.isNaN(am) || Number.isNaN(bm)) return null;
  return Math.abs(am - bm) / 60000;
};

/**
 * The two-evidence reconcile rule (audit §5.2). NON-DESTRUCTIVE — both windows are returned untouched;
 * this only chooses an authoritative window + a label/confidence for display and for the ACTUAL_STOP feed:
 *
 *   • both exist & AGREE (|enter diff| ≤ tolerance): authoritative = GPS enter → dispatch complete
 *     (vehicle-in to work-done), confidence HIGH, label GPS_DISPATCH.
 *   • both exist & DIVERGE: FLAG for review, keep the DISPATCH window as the labeled default (the crew
 *     action is the billing anchor), confidence MEDIUM, label DISPATCH_FLAGGED.
 *   • GPS only: authoritative = the GPS window, confidence = the GPS window's own, label GPS_CONFIRMED.
 *   • dispatch only (ALL historical + any poll gap): authoritative = the dispatch window, confidence LOW
 *     / PROVISIONAL, label DISPATCH_ONLY. This is the honest launch-day majority — say so in the UI.
 *   • neither: authoritative null, label NONE.
 */
export function reconcileVisit(
  gps: VisitWindow | null,
  dispatch: VisitWindow | null,
  discrepancyMinutes: number,
  ids: { stopId: string; routeId: string; txId?: string },
): ReconciledVisit {
  const base = { stopId: ids.stopId, routeId: ids.routeId, txId: ids.txId, gps, dispatch };

  if (gps && dispatch) {
    const disc = gps.enterTs && dispatch.enterTs ? minutesBetween(gps.enterTs, dispatch.enterTs) : null;
    const agree = disc == null ? null : disc <= discrepancyMinutes;
    if (agree === true) {
      return {
        ...base,
        authoritative: { enterTs: gps.enterTs, exitTs: dispatch.exitTs ?? gps.exitTs, source: "gps+dispatch" },
        discrepancyMinutes: disc,
        agree: true,
        flagged: false,
        confidence: "HIGH",
        label: "GPS_DISPATCH",
        note: "GPS presence and dispatch agree; window = GPS enter → dispatch complete",
      };
    }
    // Diverged (or incomparable) → flag, keep dispatch as the labeled default (crew action = billing anchor).
    return {
      ...base,
      authoritative: { enterTs: dispatch.enterTs, exitTs: dispatch.exitTs, source: "dispatch" },
      discrepancyMinutes: disc,
      agree,
      flagged: true,
      confidence: "MEDIUM",
      label: "DISPATCH_FLAGGED",
      note: disc == null ? "GPS and dispatch present but not comparable; kept dispatch window" : `GPS and dispatch diverge by ${Math.round(disc)} min (> ${discrepancyMinutes}); kept dispatch window, flagged for review`,
    };
  }

  if (gps) {
    return {
      ...base,
      authoritative: { enterTs: gps.enterTs, exitTs: gps.exitTs, source: "gps" },
      discrepancyMinutes: null,
      agree: null,
      flagged: false,
      confidence: gps.confidence,
      label: "GPS_CONFIRMED",
      note: "GPS presence only (no dispatch action recorded)",
    };
  }

  if (dispatch) {
    return {
      ...base,
      authoritative: { enterTs: dispatch.enterTs, exitTs: dispatch.exitTs, source: "dispatch" },
      discrepancyMinutes: null,
      agree: null,
      flagged: false,
      confidence: "LOW",
      label: "DISPATCH_ONLY",
      note: "dispatch-only (no GPS fix stored for this visit) — PROVISIONAL",
    };
  }

  return { ...base, authoritative: null, discrepancyMinutes: null, agree: null, flagged: false, confidence: "LOW", label: "NONE", note: "no on-site evidence" };
}

/**
 * The GENUINE GPS-derived on-stop span to feed the labor cascade's ACTUAL_STOP slot — and ONLY when a real
 * GPS window exists with a measurable dwell (enter < exit). Dispatch times NEVER yield a span here, so a
 * dispatch-only visit can never lift a route to ACTUAL_STOP (it stays DERIVED/PLANNED exactly as today).
 * Returns null otherwise. This is the single, deliberately narrow boundary into the untouched cascade.
 */
export function actualStopSpan(r: ReconciledVisit): { enterTs: string; exitTs: string } | null {
  const g = r.gps;
  if (!g || !g.enterTs || !g.exitTs) return null;
  if (Date.parse(g.exitTs) <= Date.parse(g.enterTs)) return null; // a single-ping window is presence, not a dwell
  return { enterTs: g.enterTs, exitTs: g.exitTs };
}
