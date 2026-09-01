// Truck live GPS position — via the GPS TrackIt API (the REST API behind the
// customer's Zonar Ignition portal).
//
//   Base:  https://cloud-api.gpstrackit.com/
//   Auth:  header `x-api-key: <key>`   (key lives in Ignition → Account → API)
//   Unit:  GET {base}unit/{unitId}     → the vehicle, incl. its last position
//
// We pull the position and compute the ETA ourselves (geocode + routing in
// liveEta.ts). Key-gated: returns null when unconfigured, so the app falls back to
// the planned ETA. Function names kept generic (getTruckPosition/zonarConfigured)
// so callers don't care which telematics vendor is behind them.

import { alertOps } from "@/lib/notify/alert";

const BASE = (process.env.GPSTRACKIT_BASE_URL || "https://cloud-api.gpstrackit.com/").replace(
  /\/?$/,
  "/",
);

export function zonarConfigured(): boolean {
  return Boolean(process.env.GPSTRACKIT_API_KEY);
}

// Map our truckId → the GPS TrackIt unit id. Configured via GPSTRACKIT_UNITS_JSON,
// e.g. {"NPR-1":"1","NPR-2":"2"}. Falls back to the truckId itself.
function unitId(truckId: string): string {
  try {
    const map = JSON.parse(process.env.GPSTRACKIT_UNITS_JSON || "{}") as Record<string, string>;
    return map[truckId] || truckId;
  } catch {
    return truckId;
  }
}

function headers(): Record<string, string> {
  return {
    "x-api-key": process.env.GPSTRACKIT_API_KEY || "",
    "Content-Type": "application/json",
  };
}

export interface TruckPosition {
  lat: number;
  lng: number;
  ts?: string;
}

// GPS TrackIt caps calls per day; when we hit 429 (rate-limited / quota reached) there's
// no point retrying every 45s — that keeps us throttled and burns whatever's left. So we
// stop calling until `rateLimitedUntil`, degrading to the planned ETA in the meantime.
// A 429 is self-healing (the quota resets), so we do NOT page ops for it. Stored on
// globalThis so the backoff survives Next's per-bundle module copies.
const DEFAULT_BACKOFF_MS = Number(process.env.GPSTRACKIT_RATELIMIT_BACKOFF_SECONDS || 900) * 1000;
const rl = globalThis as unknown as { __gpstrackitRateLimitedUntil?: number };

export function rateLimitedUntil(): number {
  return rl.__gpstrackitRateLimitedUntil ?? 0;
}

/** Fetch a truck's current GPS position from GPS TrackIt. Null if unconfigured/unavailable. */
export async function getTruckPosition(truckId: string): Promise<TruckPosition | null> {
  if (!zonarConfigured()) return null;
  // Backing off after a recent 429 — skip the call, fall back to the planned ETA.
  if (Date.now() < rateLimitedUntil()) return null;
  try {
    const res = await fetch(`${BASE}unit/${encodeURIComponent(unitId(truckId))}`, {
      headers: headers(),
      cache: "no-store",
    });
    if (res.status === 429) {
      const retryAfter = Number(res.headers.get("retry-after")) || 0;
      const backoff = retryAfter > 0 ? retryAfter * 1000 : DEFAULT_BACKOFF_MS;
      rl.__gpstrackitRateLimitedUntil = Date.now() + backoff;
      console.warn(`[gpstrackit] 429 rate-limited — backing off ${Math.round(backoff / 1000)}s`);
      return null; // quiet degrade: a rate limit is transient, don't page ops
    }
    if (!res.ok) {
      console.error("[gpstrackit] unit HTTP", res.status);
      void alertOps("GPS TrackIt (Zonar)", `unit ${truckId}: HTTP ${res.status} — live ETA/tracking unavailable`);
      return null;
    }
    return parsePosition(await res.json());
  } catch (e) {
    console.error("[gpstrackit] error", e);
    void alertOps("GPS TrackIt (Zonar)", `unit ${truckId}: ${String(e)}`);
    return null;
  }
}

/**
 * List all units (vehicles) — used once to discover unit ids for GPSTRACKIT_UNITS_JSON.
 * Returns the raw API payload; the caller inspects id/label/position.
 */
export async function listUnits(): Promise<unknown | null> {
  if (!zonarConfigured()) return null;
  try {
    const res = await fetch(`${BASE}unit/search`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ openSearch: "", limit: 200, offset: 0 }),
      cache: "no-store",
    });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    return await res.json();
  } catch (e) {
    return { error: String(e) };
  }
}

// GPS TrackIt nests the position inside the unit object (and the exact path can vary
// by device), so walk the tree and grab the first real lat/long pair. Exported for tests.
export function parsePosition(data: unknown): TruckPosition | null {
  return findLatLng(data, 0);
}

const LAT_KEYS = new Set(["lat", "latitude"]);
const LNG_KEYS = new Set(["long", "lng", "lon", "longitude"]);
const TS_KEYS = new Set(["time", "timestamp", "fetchtime", "datetime", "eventtime", "lastupdate"]);

function isNum(v: unknown): boolean {
  return v !== null && v !== "" && !Number.isNaN(Number(v));
}

function findLatLng(node: unknown, depth: number): TruckPosition | null {
  if (!node || typeof node !== "object" || depth > 8) return null;
  const obj = node as Record<string, unknown>;
  let lat: number | undefined;
  let lng: number | undefined;
  let ts: string | undefined;
  for (const key of Object.keys(obj)) {
    const kl = key.toLowerCase();
    const val = obj[key];
    if (lat === undefined && LAT_KEYS.has(kl) && isNum(val)) lat = Number(val);
    if (lng === undefined && LNG_KEYS.has(kl) && isNum(val)) lng = Number(val);
    if (!ts && TS_KEYS.has(kl) && (typeof val === "string" || typeof val === "number")) {
      ts = String(val);
    }
  }
  // A valid pair, in plausible range, and not the (0,0) null-island 'no fix' value.
  if (
    lat !== undefined &&
    lng !== undefined &&
    !(lat === 0 && lng === 0) &&
    Math.abs(lat) <= 90 &&
    Math.abs(lng) <= 180
  ) {
    return { lat, lng, ts };
  }
  for (const key of Object.keys(obj)) {
    const child = findLatLng(obj[key], depth + 1);
    if (child) return child;
  }
  return null;
}
