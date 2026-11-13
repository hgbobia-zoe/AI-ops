// Gas tank refill. Owner rule 2026-11-13: patio and tent heater tanks came back to the warehouse unfilled.
// So every route that PICKS UP a gas tank gets a refill stop as its last stop before the warehouse, at the
// refill place (an admin setting; default 12025 Parklawn Dr, Rockville). The place closes at 8:00 PM ET:
// when the truck is projected to get there at 8:00 PM or later, there is no stop, and the office gets a
// next-day task ("refill the tanks from route X") instead, announced in the dispatch Slack channel.
//
// This file is pure (no DB, no network) so the rules are tested directly. gasRefillApply.ts wires it into
// the route import; the risk scan checks every gas pickup route has the stop or the task.
//
// The refill stop lives only in Dispatch (stopId "<routeId>-GAS"). Writing it into the Goodshuffle route is
// a separate, captured write. It carries no customer phone and no line items, so no customer text, rule or
// item count ever treats it as a customer stop. What triggered it is spelled out in its name.

import type { Stop } from "@/lib/types";
import { opsWallTimeToMs } from "@/lib/dates";
import { DEFAULT_ON_SITE_MIN } from "@/lib/dispatch/onTime";

export interface GasRefillSettings {
  /** Where the tanks get filled. */
  address: string;
  /** Closing time, 24h "HH:MM" Eastern. Arriving at or after it means no stop, a next-day task instead. */
  closeTime: string;
  /** Line-item name keywords (case-insensitive substrings) that mean a gas tank is on the truck. */
  keywords: string[];
}

export const DEFAULT_GAS_REFILL: GasRefillSettings = {
  address: "12025 Parklawn Dr, Rockville, MD 20852",
  closeTime: "20:00",
  keywords: ["patio heater", "tent heater", "propane"],
};

/** Geocoded once (US Census, 2026-11-13): "12025 PARKLAWN DR, ROCKVILLE, MD, 20852". Used while the setting
 *  still holds the default address, so the drive estimate needs no geocode call. */
export const DEFAULT_REFILL_COORDS = { lat: 39.054247, lng: -77.106722 };

/** Minutes planned at the refill place. */
export const REFILL_ON_SITE_MIN = 20;
/** Drive time used when the real one can't be looked up (honest, conservative for the DMV area). */
export const FALLBACK_DRIVE_MIN = 30;

export const gasStopId = (routeId: string): string => `${routeId}-GAS`;
export const isRefillStop = (s: Pick<Stop, "stopId">): boolean => s.stopId.endsWith("-GAS");
export const gasTaskDedupeKey = (routeId: string): string => `gas-refill:${routeId}`;

export interface GasTrigger {
  stopId: string;
  custName: string;
  txId?: string;
  items: { name: string; quantity: number }[];
}

/** The pickup stops that bring a gas tank back, and which line items say so. Deliveries never need a refill. */
export function gasTriggers(stops: Stop[], keywords: string[]): GasTrigger[] {
  const keys = keywords.map((k) => k.trim().toLowerCase()).filter(Boolean);
  if (keys.length === 0) return [];
  const out: GasTrigger[] = [];
  for (const s of stops) {
    if (isRefillStop(s) || s.kind !== "pickup") continue;
    const items = (s.items ?? [])
      .filter((it) => keys.some((k) => it.name.toLowerCase().includes(k)))
      .map((it) => ({ name: it.name, quantity: it.quantity && it.quantity > 0 ? it.quantity : 1 }));
    if (items.length) out.push({ stopId: s.stopId, custName: s.custName, txId: s.txId, items });
  }
  return out;
}

/** "Patio Heater x3, Tent Heater" across all triggering stops. */
export function triggerSummary(triggers: GasTrigger[]): string {
  const total = new Map<string, number>();
  for (const t of triggers) for (const it of t.items) total.set(it.name, (total.get(it.name) ?? 0) + it.quantity);
  return [...total].map(([name, n]) => (n > 1 ? `${name} x${n}` : name)).join(", ");
}

/** When the truck leaves its last customer stop: that stop's planned arrival plus its time on site. */
export function lastDepartureMs(stops: Stop[]): number | null {
  let last: number | null = null;
  for (const s of stops) {
    if (isRefillStop(s)) continue;
    const t = Date.parse(s.plannedWindow ?? s.eta ?? "");
    if (Number.isNaN(t)) continue;
    const onSite = s.plannedOnSiteMin ?? DEFAULT_ON_SITE_MIN[s.kind === "pickup" ? "pickup" : "delivery"];
    const dep = t + onSite * 60_000;
    if (last == null || dep > last) last = dep;
  }
  return last;
}

/** "8:00 PM" for "20:00". */
export function closeLabel(closeTime: string): string {
  const [h, m] = closeTime.split(":").map(Number);
  const hh = Number.isFinite(h) ? h : 20;
  const mm = Number.isFinite(m) ? m : 0;
  return `${hh % 12 === 0 ? 12 : hh % 12}:${String(mm).padStart(2, "0")} ${hh < 12 ? "AM" : "PM"}`;
}

/** The refill place's closing instant on the route's day (Eastern). */
export function closeMs(date: string, closeTime: string): number {
  const [h, m] = closeTime.split(":").map(Number);
  return opsWallTimeToMs(date, Number.isFinite(h) ? h : 20, Number.isFinite(m) ? m : 0);
}

export type RefillPlan =
  | { kind: "none" }
  | { kind: "stop"; arrivalMs: number | null; driveAssumed: boolean; kept?: boolean }
  | { kind: "task"; arrivalMs: number; driveAssumed: boolean };

/**
 * Decide the refill for one route and return its stops with the refill stop placed (or removed).
 * Idempotent: the stop always has the same id, so a re-pull updates it in place, never duplicates it. A
 * refill stop the driver already acted on is always kept as it is.
 */
export function planGasRefill(input: {
  routeId: string;
  date: string;
  stops: Stop[];
  settings: GasRefillSettings;
  /** Drive minutes from the last stop to the refill place, or null when it couldn't be looked up. */
  driveMin: number | null;
}): { stops: Stop[]; plan: RefillPlan; triggers: GasTrigger[] } {
  const { routeId, date, settings } = input;
  const base = input.stops.filter((s) => !isRefillStop(s));
  const existing = input.stops.find(isRefillStop);
  const nextSeq = base.reduce((m, s) => Math.max(m, s.sequence), 0) + 1;
  const triggers = gasTriggers(base, settings.keywords);

  if (existing && existing.state !== "Waiting") {
    return { stops: [...base, { ...existing, sequence: nextSeq }], plan: { kind: "stop", arrivalMs: Date.parse(existing.plannedWindow ?? "") || null, driveAssumed: false, kept: true }, triggers };
  }
  if (triggers.length === 0) return { stops: base, plan: { kind: "none" }, triggers };

  const driveAssumed = input.driveMin == null;
  const drive = input.driveMin ?? FALLBACK_DRIVE_MIN;
  const dep = lastDepartureMs(base);
  const arrivalMs = dep == null ? null : dep + Math.round(drive) * 60_000;
  if (arrivalMs != null && arrivalMs >= closeMs(date, settings.closeTime)) {
    return { stops: base, plan: { kind: "task", arrivalMs, driveAssumed }, triggers };
  }

  const at = arrivalMs != null ? new Date(arrivalMs).toISOString() : undefined;
  const stop: Stop = {
    ...(existing ?? {}),
    stopId: gasStopId(routeId),
    routeId,
    customerId: "gas-refill",
    sequence: nextSeq,
    state: existing?.state ?? "Waiting",
    custName: `Gas refill: ${triggerSummary(triggers)}`,
    custPhone: "",
    address: settings.address,
    plannedWindow: at,
    eta: at,
    plannedOnSiteMin: REFILL_ON_SITE_MIN,
    plannedTransitMin: Math.round(drive),
    items: undefined,
    txId: undefined,
  };
  return { stops: [...base, stop], plan: { kind: "stop", arrivalMs, driveAssumed }, triggers };
}

/** Route checker verdict for one route: a gas pickup needs the refill stop or the next-day task. */
export function gasRefillCovered(stops: Stop[], keywords: string[], taskExists: boolean): { needed: boolean; covered: boolean; triggers: GasTrigger[] } {
  const triggers = gasTriggers(stops, keywords);
  if (triggers.length === 0) return { needed: false, covered: true, triggers };
  return { needed: true, covered: stops.some(isRefillStop) || taskExists, triggers };
}

/** Coerce an /admin save of the gas refill setting: a missing or bad field keeps the current value, the
 *  closing time must be a real 24h "HH:MM", and keywords are trimmed, lowercased and de-duplicated. */
export function coerceGasRefill(v: unknown, current: GasRefillSettings): GasRefillSettings {
  if (!v || typeof v !== "object") return current;
  const o = v as Record<string, unknown>;
  const address = typeof o.address === "string" && o.address.trim() ? o.address.trim() : current.address;
  const ct = typeof o.closeTime === "string" ? o.closeTime.trim() : "";
  const m = /^(\d{1,2}):(\d{2})$/.exec(ct);
  const closeTime = m && Number(m[1]) <= 23 && Number(m[2]) <= 59 ? `${m[1].padStart(2, "0")}:${m[2]}` : current.closeTime;
  const keywords = Array.isArray(o.keywords)
    ? Array.from(new Set(o.keywords.map((x) => String(x).trim().toLowerCase()).filter(Boolean)))
    : current.keywords;
  return { address, closeTime, keywords };
}

// ── Goodshuffle side (captured live 2026-11-13 on past route 66192, then fully restored) ──────────────
// Adding a stop to a Goodshuffle route is three calls from a logged-in session: saveNewLocation (form:
// streetAddress, _city, _state, _zipCode, _country → locationID), saveWaypoint ({locationID, name,
// arrivalTime, departureTime, notes} → an UNSCHEDULED custom waypoint), scheduleWaypoint ({vehicleID,
// routeID, routeColor, waypointID, logisticID: null, arrivalTime, departureTime}). Removing it is
// unscheduleWaypoint {waypointID} then GET deleteUnscheduledCustomStop?waypointID=. The extension drains
// the "refill_stop" op; the pull skips our own refill waypoint (its name starts with REFILL_NAME_PREFIX).

export const REFILL_NAME_PREFIX = "Gas refill";

export interface GsAddress {
  street: string;
  city: string;
  state: string;
  zip: string;
  country: string;
}

/** "12025 Parklawn Dr, Rockville, MD 20852" → its parts, or null when it isn't "street, city, ST zip". */
export function parseUsAddress(address: string): GsAddress | null {
  const parts = address.split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.length < 3) return null;
  const m = /^([A-Za-z]{2})\s+(\d{5})(?:-\d{4})?$/.exec(parts[parts.length - 1]);
  if (!m) return null;
  const city = parts[parts.length - 2];
  const street = parts.slice(0, parts.length - 2).join(", ");
  if (!street || !city) return null;
  return { street, city, state: m[1].toUpperCase(), zip: m[2], country: "US" };
}

/** What a pull of the Goodshuffle route brings back for our refill waypoint when the puller doesn't know to
 *  skip it (an older extension, the kiosk): a stop with no project, no name and no address, at the time we
 *  scheduled. Dropped so the route never shows a blank stop next to the real refill stop. */
export function isEchoOfRefill(s: Stop, refillAt: string | undefined): boolean {
  if (isRefillStop(s) || s.txId || s.custName.trim() || s.address.trim() || !refillAt) return false;
  const a = Date.parse(s.plannedWindow ?? s.eta ?? "");
  const b = Date.parse(refillAt);
  return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= 2 * 60_000;
}
