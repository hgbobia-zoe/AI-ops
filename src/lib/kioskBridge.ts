"use client";

// Client-side bridge to the Android kiosk shell (window.ZoeKiosk, injected by
// KioskJsBridge.kt). In a plain browser or the Electron shell, window.ZoeKiosk is
// undefined and every call here no-ops and returns null — so callers transparently
// fall back to the self-hosted /track link, exactly as before.

interface ZoeKioskBridge {
  createEtaLink: (requestId: string, paramsJson: string) => void;
  importGoodshuffleRoute?: (requestId: string, truckId: string) => void;
  checkForUpdate?: (requestId: string) => void;
  ping?: () => string;
}

function bridge(): ZoeKioskBridge | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { ZoeKiosk?: ZoeKioskBridge };
  return w.ZoeKiosk && typeof w.ZoeKiosk.createEtaLink === "function" ? w.ZoeKiosk : null;
}

/** True only inside the Android kiosk APK (where the native bridge is present). */
export function inAndroidKiosk(): boolean {
  return bridge() !== null;
}

/** True if the kiosk build supports on-demand OTA checks. */
export function canCheckForUpdate(): boolean {
  const b = bridge();
  return Boolean(b && typeof b.checkForUpdate === "function");
}

/**
 * Trigger an on-demand OTA update check. Resolves a short human status
 * ("You're on the latest version", "Update v1.0.9 found — downloading…", etc.),
 * or null if not in the kiosk / no response.
 */
export async function checkForUpdateViaKiosk(): Promise<string | null> {
  const b = bridge();
  if (!b || typeof b.checkForUpdate !== "function") return null;
  const res = (await callBridge((bo, id) => bo.checkForUpdate!(id), 90000)) as
    | { ok?: boolean; message?: string }
    | null;
  return res && res.message ? res.message : null;
}

// The async-resolve plumbing the native side expects: it calls
// window.__zoeKioskResolve(requestId, result) when a call completes.
//
// IMPORTANT: the Android bridge embeds the result JSON *as a literal* into the resolve
// call, so `result` arrives here already as a JS OBJECT — not a string. (It can also be
// a plain string in some paths.) So accept both: parse only when it's a string, else use
// it directly. Parsing an object was the long-standing bug that made every bridge call
// resolve to null ("Goodshuffle didn't respond" even when signed in; ETA links silently
// falling back).
type Pending = (v: unknown) => void;
function ensurePending(): Record<string, Pending> {
  const w = window as unknown as {
    __zoeKioskPending?: Record<string, Pending>;
    __zoeKioskResolve?: (id: string, result: unknown) => void;
  };
  if (!w.__zoeKioskPending) w.__zoeKioskPending = {};
  if (!w.__zoeKioskResolve) {
    w.__zoeKioskResolve = (id, result) => {
      const p = w.__zoeKioskPending![id];
      if (!p) return;
      delete w.__zoeKioskPending![id];
      let value: unknown = null;
      try {
        value = typeof result === "string" ? JSON.parse(result) : result;
      } catch {
        value = null;
      }
      p(value);
    };
  }
  return w.__zoeKioskPending;
}

function callBridge(
  invoke: (b: ZoeKioskBridge, requestId: string) => unknown,
  timeoutMs = 25000,
): Promise<unknown> {
  const b = bridge();
  if (!b) return Promise.resolve(null);
  const pending = ensurePending();
  const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      delete pending[id];
      resolve(null);
    }, timeoutMs);
    const settle = (v: unknown) => {
      if (!(id in pending) && v === null) return;
      delete pending[id];
      clearTimeout(timer);
      resolve(v);
    };
    pending[id] = settle;
    try {
      const ret = invoke(b, id);
      // Electron bridge returns a Promise directly (no __zoeKioskResolve round-trip);
      // Android returns void and resolves later via window.__zoeKioskResolve.
      if (ret && typeof (ret as { then?: unknown }).then === "function") {
        (ret as Promise<unknown>).then((v) => settle(v)).catch(() => settle(null));
      }
    } catch {
      settle(null);
    }
  });
}

// truckId → Ignition unit id. Captured from Zonar's searchUnits (see
// android/IGNITION_ETALINK.md). Override via NEXT_PUBLIC_IGNITION_UNITS_JSON.
const DEFAULT_UNITS: Record<string, number> = {
  E450: 200149627,
  "NPR-1": 200149626,
  "NPR-2": 200214102,
};

export function ignitionUnitId(truckId: string): number | null {
  try {
    const map = JSON.parse(process.env.NEXT_PUBLIC_IGNITION_UNITS_JSON || "{}") as Record<string, number>;
    return map[truckId] ?? DEFAULT_UNITS[truckId] ?? null;
  } catch {
    return DEFAULT_UNITS[truckId] ?? null;
  }
}

/**
 * Mint a Zonar ETA link for a stop via the kiosk's logged-in Ignition session.
 * Returns the public URL, or null if not in the kiosk / no unit mapping / it failed —
 * in which case the caller keeps the self-hosted /track link. The kiosk forces the
 * notify number to the Zoe main line, so the customer is never texted by Zonar.
 */
export async function createEtaLinkViaKiosk(
  truckId: string,
  address: string | undefined,
  etaHours?: string,
): Promise<string | null> {
  if (!inAndroidKiosk() || !address) return null;
  const unitId = ignitionUnitId(truckId);
  if (unitId == null) return null;
  const res = (await callBridge((b, id) =>
    b.createEtaLink(id, JSON.stringify({ unitId, address, etaHours })),
  )) as { ok?: boolean; url?: string } | null;
  return res && res.ok && res.url ? res.url : null;
}

// Shape the kiosk returns per stop (matches /api/route/import's expected fields).
export interface ImportedStop {
  custName?: string;
  custPhone?: string;
  address?: string;
  dayOfName?: string;
  dayOfPhone?: string;
  plannedWindow?: string;
  eta?: string;
}

export interface ImportResult {
  inKiosk: boolean; // false = plain browser (no native bridge at all)
  ok: boolean;
  stops: ImportedStop[];
  error?: string;
  total?: number; // routes Goodshuffle returned for today (any vehicle)
  matched?: number; // of those, how many were assigned to this truck
}

/**
 * Pull today's route for this truck from the kiosk's logged-in Goodshuffle session.
 * Returns a diagnostic result so the caller can tell the driver WHY nothing loaded
 * (old app build, timeout, Goodshuffle signed out, or simply no route today) instead of
 * silently dropping to manual entry.
 */
export async function importGoodshuffleRouteViaKiosk(truckId: string): Promise<ImportResult> {
  const b = bridge();
  if (!b) return { inKiosk: false, ok: false, stops: [] };
  if (typeof b.importGoodshuffleRoute !== "function") {
    return { inKiosk: true, ok: false, stops: [], error: "old_app_build_no_import" };
  }
  const res = (await callBridge((bridgeObj, id) => bridgeObj.importGoodshuffleRoute!(id, truckId))) as
    | { ok?: boolean; stops?: ImportedStop[]; error?: string; total?: number; matched?: number }
    | null;
  if (!res) return { inKiosk: true, ok: false, stops: [], error: "no_response_timeout" };
  return {
    inKiosk: true,
    ok: Boolean(res.ok),
    stops: Array.isArray(res.stops) ? res.stops : [],
    error: res.error,
    total: res.total,
    matched: res.matched,
  };
}
