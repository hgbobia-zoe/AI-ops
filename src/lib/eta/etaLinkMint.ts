// Ignition etaLink mint — the OFFICE-MACHINE path (no tablet, no driver device).
//
// Zonar Ignition has no server API we can call (Cloudflare + a Cognito-gated AppSync endpoint), so we
// mint Ignition's own hosted live-tracking "etaLink" by replaying the app's own `createEtaLink` GraphQL
// mutation from INSIDE a logged-in ignition.zonarsystems.com tab on the office machine (the Auto-Pull
// extension's new Ignition content script + in-page injected script). This mirrors exactly how we drive
// Goodshuffle: a logged-in browser replays an internal call, the extension feeds our server.
//
// This module holds the PURE pieces (no DB, no network) that the server + the unit tests share: the
// mint-request builder, the unit-label→unitId resolver, the public etaLink URL builder, the primary-vs-
// fallback link selector, and the notify-line constant. The extension's in-page script mirrors this
// shape (see extension/ignition-injected.js) — keep the two in sync, as gsPull.ts mirrors pull-injected.js.
//
// Full captured contract: android/IGNITION_ETALINK.md.

/**
 * HARD RULE (memory: zonar-etalink-notify-line). `sharedWith.sms` is who ZONAR texts its own unbranded
 * link to — it MUST be the Zoe main line, NEVER the customer. The customer only ever gets Zoe's branded
 * Quo SMS, which embeds the `etaLink/<code>` URL we build. This constant is the single source of truth
 * on the server; the extension hardcodes the same value as defense-in-depth so a customer number can
 * never reach Zonar even if a request were malformed.
 */
export const ETA_NOTIFY_PHONE_E164 = "+13012915296";

/** Ignition's own live-tracking page origin. */
export const IGNITION_ETALINK_ORIGIN = "https://ignition.zonarsystems.com";

/**
 * truckId → Ignition unit id, captured from Zonar's `searchUnits` (android/IGNITION_ETALINK.md). The
 * extension resolves the LIVE unit id by label at runtime; this is the fallback hint and the tested map.
 * NB: this id space is DISTINCT from GPSTRACKIT_UNITS_JSON (the GPS-position REST path) — do not confuse
 * them.
 */
export const DEFAULT_IGNITION_UNITS: Record<string, number> = {
  E450: 200149627,
  "NPR-1": 200149626,
  "NPR-2": 200214102,
};

/** Resolve the Ignition unit id for a truck, with an optional override map (object or JSON string, e.g.
 *  from IGNITION_UNITS_JSON). Returns null when the truck has no known unit. */
export function resolveIgnitionUnitId(
  truckId: string,
  override?: Record<string, number> | string | null,
): number | null {
  let map: Record<string, number> = DEFAULT_IGNITION_UNITS;
  if (override) {
    try {
      const parsed = typeof override === "string" ? (JSON.parse(override) as Record<string, number>) : override;
      if (parsed && typeof parsed === "object") map = { ...DEFAULT_IGNITION_UNITS, ...parsed };
    } catch {
      /* malformed override → keep the default map */
    }
  }
  const v = map[truckId];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** The public live-tracking page for a minted code, e.g. https://ignition.zonarsystems.com/etaLink/11e38c7d61 */
export function etaLinkUrl(code: string): string {
  return `${IGNITION_ETALINK_ORIGIN}/etaLink/${code}`;
}

export interface EtaLinkMintInput {
  stopId: string;
  truckId: string;
  /** The Ignition unit LABEL to match at runtime via searchUnits (e.g. "Ford E450"). */
  truckLabel: string;
  address: string;
  lat: number;
  lng: number;
  /** Rough initial estimate in HOURS; the Ignition page recomputes a live ETA. Optional. */
  etaHours?: number | null;
  startISO: string;
  endISO: string;
  /** Precomputed unit-id hint; defaults to resolveIgnitionUnitId(truckId). */
  unitIdHint?: number | null;
}

/** What the extension fetches per pending mint. `notifySms` is fixed to the Zoe line here AND in the
 *  extension — a customer number can never reach `sharedWith.sms`. */
export interface EtaLinkMintRequest {
  id: string;
  stopId: string;
  truckLabel: string;
  unitIdHint: number | null;
  address: string;
  latitude: number;
  longitude: number;
  etaHours: string | null;
  startISO: string;
  endISO: string;
  notifySms: string; // always ETA_NOTIFY_PHONE_E164
}

/** Build the normalized mint request the extension will replay. The notify line is forced to the Zoe
 *  main line regardless of input — the customer is never a Zonar notify target. */
export function buildEtaLinkMintRequest(id: string, input: EtaLinkMintInput): EtaLinkMintRequest {
  const eta =
    input.etaHours != null && Number.isFinite(input.etaHours)
      ? Number(input.etaHours).toFixed(2)
      : null;
  return {
    id,
    stopId: input.stopId,
    truckLabel: input.truckLabel,
    unitIdHint: input.unitIdHint ?? resolveIgnitionUnitId(input.truckId),
    address: input.address,
    latitude: input.lat,
    longitude: input.lng,
    etaHours: eta,
    startISO: input.startISO,
    endISO: input.endISO,
    notifySms: ETA_NOTIFY_PHONE_E164,
  };
}

/**
 * SMS link selection: the REAL Ignition live map is primary; our /track page (real server-side GPS +
 * labeled ETA) is the only fallback. Never a fabricated or dead link — the fallback is always a working
 * link, and /track upgrades itself to the Ignition map if the mint lands later.
 */
export function selectTrackingLink(opts: {
  ignitionUrl?: string | null;
  fallbackUrl: string;
}): { url: string; source: "ignition" | "track" } {
  if (opts.ignitionUrl) return { url: opts.ignitionUrl, source: "ignition" };
  return { url: opts.fallbackUrl, source: "track" };
}

/** The shift window (hours) used for a mint's dateRange.end (now → now + window). */
export function shiftWindowHours(): number {
  const n = Number(process.env.ETA_LINK_SHIFT_WINDOW_H || 8);
  return Number.isFinite(n) && n > 0 ? n : 8;
}
