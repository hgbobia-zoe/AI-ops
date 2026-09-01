"use client";

// Client-side bridge to the Android kiosk shell (window.ZoeKiosk, injected by
// KioskJsBridge.kt). In a plain browser or the Electron shell, window.ZoeKiosk is
// undefined and every call here no-ops and returns null — so callers transparently
// fall back to the self-hosted /track link, exactly as before.

interface ZoeKioskBridge {
  createEtaLink: (requestId: string, paramsJson: string) => void;
  importGoodshuffleRoute?: (requestId: string, truckId: string) => void;
  // Generic escape hatch: run web-provided JS inside the logged-in Goodshuffle
  // WebView and resolve its (synchronous) return value. Present in every native
  // build — it's what lets the EXTRACTION LOGIC live here in the web (shipped by a
  // Fly deploy) instead of being baked into the APK.
  evalInGoodshuffle?: (requestId: string, script: string) => void;
  checkForUpdate?: (requestId: string) => void;
  // Switch the kiosk shell into full-screen "dispatch board" mode: the dispatch
  // WebView expands to the left half showing /dispatch, the live Ignition map fills
  // the right half, and Goodshuffle is hidden. For the office display. Fire-and-forget
  // — the native side owns the reflow. Absent in older builds (caller falls back to a
  // plain navigation to /dispatch).
  openDispatchBoard?: () => void;
  // Open the native admin panel: switch the Goodshuffle / Ignition logins on this
  // tablet, or open web settings. Absent in older builds.
  openAdminPanel?: () => void;
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

/**
 * Enter full-screen dispatch-board mode in the native kiosk (board + live Ignition
 * side-by-side, Goodshuffle hidden). Returns true if the native shell handled it;
 * false in a plain browser / older APK, where the caller should navigate to /dispatch
 * itself. Synchronous fire-and-forget — the native side owns the layout change.
 */
export function openDispatchBoardViaKiosk(): boolean {
  const b = bridge();
  if (b && typeof b.openDispatchBoard === "function") {
    try {
      b.openDispatchBoard();
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * Open the native admin panel (switch Goodshuffle / Ignition logins). Returns true if
 * the native shell handled it; false in a plain browser / older APK, where the caller
 * should open /admin (web settings) instead.
 */
export function openAdminPanelViaKiosk(): boolean {
  const b = bridge();
  if (b && typeof b.openAdminPanel === "function") {
    try {
      b.openAdminPanel();
      return true;
    } catch {
      return false;
    }
  }
  return false;
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

// Which Goodshuffle vehicle.title substring this truck maps to.
function goodshuffleMatch(truckId: string): string {
  const t = truckId.toLowerCase();
  if (t.includes("e450") || t.includes("ford")) return "ford";
  if (t.includes("npr") || t.includes("isuzu")) return "isuzu";
  return t;
}

type GsResult = {
  ok?: boolean;
  stops?: ImportedStop[];
  error?: string;
  total?: number;
  matched?: number;
};

/**
 * The Goodshuffle route-extraction script, run INSIDE the logged-in Goodshuffle
 * WebView. It replays Goodshuffle's own internal API (same-origin, session cookies)
 * to read today's route for this truck, and stashes the normalized stops on
 * `window.__gsRoute[key]` when the async fetches finish. Living here (web) instead of
 * in the APK is what makes route/extraction fixes ship by a Fly deploy — no new APK.
 *
 * Customer phone: the inlined `transaction.renter` (validated e164 → raw phone), then
 * the on-site contact. Never dispatcher/storeLocation (those are the Zoe main line).
 */
function goodshuffleExtractionScript(key: string, match: string): string {
  const KEY = JSON.stringify(key);
  const MATCH = JSON.stringify(match);
  return `(function(){
    window.__gsRoute = window.__gsRoute || {};
    var KEY = ${KEY}, MATCH = ${MATCH};
    function fail(m){ try { window.__gsRoute[KEY] = {ok:false, error:String(m).slice(0,300)}; } catch(x){} }
    function done(stops, routes, total, matched){ window.__gsRoute[KEY] = {ok:true, stops:stops, routeNames:routes, total:total, matched:matched}; }
    try {
      var now = new Date();
      var startLocal = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0,0,0);
      var endLocal = new Date(startLocal.getTime() + 24*3600*1000);
      var body = { from:startLocal.toISOString(), to:endLocal.toISOString(), warehouseCanonicalIDs:null, crew:null, vehicles:null, statuses:null };
      function extractStops(route){
        var wps = (route.waypoints||[]).filter(function(w){ return !w.isOriginWarehouse && !w.isDestinationWarehouse; });
        wps.sort(function(a,b){ return (a.waypointIndex||0) - (b.waypointIndex||0); });
        return wps.map(function(w){
          var tl = (w.logisticRelation && w.logisticRelation.targetLocation) || {};
          var tx = w.transaction || {};
          var line = [tl.streetAddressLine1, tl.streetAddressLine2].filter(Boolean).join(" ");
          var cityState = [tl.city, tl.state].filter(Boolean).join(", ");
          var address = [line, cityState, tl.zipCode].filter(Boolean).join(", ");
          var renter = tx.renter || {};
          var sv = renter.smsValidation || {};
          var name = tl.contactName || (tx.eventName ? String(tx.eventName).split(" - ")[0].trim() : "") || renter.name;
          var doc = tx.dayOfContact || null;
          var s = {
            custName: name || "",
            custFirstName: renter.firstName || undefined,
            custPhone: sv.e164PhoneNumber || renter.phone || tl.contactPhoneNumber || "",
            address: address,
            plannedWindow: w.scheduledArrivalTime || undefined,
            eta: w.scheduledArrivalTime || undefined
          };
          if (doc) { s.dayOfName = doc.name || doc.fullName || undefined; s.dayOfPhone = doc.phoneNumber || doc.phone || undefined; }
          return s;
        });
      }
      fetch("/app/routing/listRoutes", { method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify(body), credentials:"include" })
        .then(function(r){ return r.json(); })
        .then(function(routes){
          var mine = (routes||[]).filter(function(rt){ return rt.vehicle && String(rt.vehicle.title||"").toLowerCase().indexOf(MATCH) >= 0; });
          mine.sort(function(a,b){ return new Date(a.startDate) - new Date(b.startDate); });
          var total = (routes||[]).length;
          if (!mine.length) { done([], [], total, 0); return; }
          return Promise.all(mine.map(function(rt){
            return fetch("/app/routing/getRoute?routeID=" + rt.id + "&includeAttributes=true", { headers:{accept:"application/json"}, credentials:"include" })
              .then(function(r){ return r.json(); });
          })).then(function(full){
            var stops = []; var names = [];
            full.forEach(function(route){ names.push(route.name); stops = stops.concat(extractStops(route)); });
            done(stops, names, total, mine.length);
          });
        })
        .catch(function(e){ fail(e); });
    } catch(e) { fail(e); }
  })();`;
}

/** Run a script in the Goodshuffle WebView and resolve its return value (or null). */
async function evalInGoodshuffle(script: string, timeoutMs = 20000): Promise<unknown> {
  return callBridge((b, id) => b.evalInGoodshuffle!(id, script), timeoutMs);
}

// Pull today's route by shipping the extraction script to the Goodshuffle WebView and
// polling its result global — the whole extraction lives in the web (Fly-deployable).
async function importViaEval(truckId: string): Promise<GsResult | null> {
  const key = `r${Date.now()}${Math.random().toString(36).slice(2, 8)}`;
  const match = goodshuffleMatch(truckId);
  // Kick off the async extraction (returns immediately; stashes to window.__gsRoute[key]).
  await evalInGoodshuffle(goodshuffleExtractionScript(key, match), 15000);
  const pollScript = `(function(){try{return (window.__gsRoute && window.__gsRoute[${JSON.stringify(
    key,
  )}]) || null;}catch(e){return null;}})()`;
  // Poll until the fetches complete (~15s budget).
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const res = (await evalInGoodshuffle(pollScript, 8000)) as GsResult | null;
    if (res && (res.ok !== undefined || res.error)) return res;
  }
  return null;
}

/**
 * Pull today's route for this truck from the kiosk's logged-in Goodshuffle session.
 * Returns a diagnostic result so the caller can tell the driver WHY nothing loaded
 * (old app build, timeout, Goodshuffle signed out, or simply no route today) instead of
 * silently dropping to manual entry.
 *
 * PRIMARY path is the native `importGoodshuffleRoute` (proven end-to-end on-device).
 * The web-owned extraction via `evalInGoodshuffle` (which would let route/phone fixes
 * ship by a Fly deploy) is kept behind `NEXT_PUBLIC_GS_WEB_EXTRACT=1` until it's
 * verified against a real logged-in tablet — a first cut regressed the on-device pull,
 * so it must not be the default.
 */
export async function importGoodshuffleRouteViaKiosk(truckId: string): Promise<ImportResult> {
  const b = bridge();
  if (!b) return { inKiosk: false, ok: false, stops: [] };

  const shape = (res: GsResult | null, fallbackError: string): ImportResult =>
    res
      ? {
          inKiosk: true,
          ok: Boolean(res.ok),
          stops: Array.isArray(res.stops) ? res.stops : [],
          error: res.error,
          total: res.total,
          matched: res.matched,
        }
      : { inKiosk: true, ok: false, stops: [], error: fallbackError };

  // Opt-in web-owned extraction (still being validated on real hardware).
  if (process.env.NEXT_PUBLIC_GS_WEB_EXTRACT === "1" && typeof b.evalInGoodshuffle === "function") {
    const res = await importViaEval(truckId);
    if (res && (res.ok || res.error)) return shape(res, "no_response_timeout");
  }

  // Primary: native extraction baked into the APK (proven path).
  if (typeof b.importGoodshuffleRoute === "function") {
    const res = (await callBridge((bo, id) => bo.importGoodshuffleRoute!(id, truckId))) as GsResult | null;
    return shape(res, "no_response_timeout");
  }

  return { inKiosk: true, ok: false, stops: [], error: "old_app_build_no_import" };
}
