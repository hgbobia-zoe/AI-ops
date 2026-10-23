// Client hook that owns the tablet's working copy of the route and drives the
// state machine. Every driver action flows through perform():
//   optimistic local transition → one webhook → (offline-safe) queue+replay.
//
// It also tracks the AUTOMATION layer that makes this tool complementary to
// Goodshuffle (which stays the source of truth for route/stop/inventory detail):
//   - per-stop notification status (texts, tracking link, dispatch pings),
//   - an action "receipt" of what each tap triggered,
//   - side actions (message dispatch, fuel log) that fan out without a transition.
//
// NOTE (M1): the mock backend does not persist state, so the local working copy
// is authoritative during M1 testing. At M2 the polled route becomes the source
// of truth and this overlay reconciles against it. That seam is marked below.

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { appConfig } from "./config";
import { STATE_VISUAL } from "./stateVisual";
import { automationsFor } from "./automations";
import { getAvailableActions, resolveTransition } from "./stateMachine";
import type { AvailableAction } from "./stateMachine";
import type { ActionType, CloseoutResult, Route, Stop, StopState } from "./types";
import { fetchRoute, triggerIngestion } from "./tablesRead";
import { buildAction, flushQueue, getGps, sendAction } from "./webhookClient";
import { queueSize } from "./offlineQueue";
import { todayInOpsTz } from "./dates";
import { createEtaLinkViaKiosk, importGoodshuffleRouteViaKiosk } from "./kioskBridge";

export type RoutePhase =
  | "loading" // initial fetch in flight
  | "needsStart" // no route yet → show Start Route
  | "scraping" // ingestion running → "Loading route…"
  | "failed" // ingestion failed → manual entry fallback
  | "stops"
  | "headingBack"
  | "returned"
  | "empty";

/** The automations our tool fired for one stop, with timestamps. */
export interface StopNotif {
  onWay?: string;
  tracking?: string;
  arrived?: string;
}

export interface RouteSummary {
  stopsCompleted: number;
  totalStops: number;
  textsSent: number;
  exceptions: number;
  dispatchMsgs: number;
  startedAt: string | null;
}

export interface RouteMachine {
  route: Route | null;
  phase: RoutePhase;
  activeStop: Stop | null;
  activeIndex: number;
  actions: AvailableAction[];
  online: boolean;
  queuedCount: number;
  busy: boolean;
  error: string | null;
  notif: Record<string, StopNotif>;
  summary: RouteSummary;
  /** The closeout the driver submitted on arriving back (drives the summary recap). */
  lastCloseout: CloseoutResult | null;
  /** The truck's next route of the day, surfaced on the closeout screen once this one is closed. */
  nextRoute: Route | null;
  refresh: (force?: boolean) => Promise<void>;
  resync: () => Promise<void>;
  /** Explicit "Re-sync from Goodshuffle": arm the server-side one-shot force flag for this route, then
   *  re-pull — so the DB adopts Goodshuffle's CURRENT order even for in-progress stops. */
  resyncFromGoodshuffle: () => Promise<void>;
  startRoute: () => Promise<void>;
  /** Advance to nextRoute (the "Start next route" action on the closeout screen). */
  startNextRoute: () => void;
  submitManual: (stops: Stop[]) => void;
  perform: (action: ActionType, payload?: Record<string, unknown>) => Promise<void>;
  sendSide: (
    action: ActionType,
    payload?: Record<string, unknown>,
    title?: string,
  ) => Promise<void>;
}

function firstActiveIndex(stops: Stop[]): number {
  return stops.findIndex((s) => s.state !== "Completed");
}

/** A stop the driver actually worked (arrived at / completed / returned / flagged) — i.e. real progress
 *  on this route, as opposed to a route the office closed before the driver ever touched it. */
function wasWorked(s: Stop): boolean {
  return (
    s.state === "Completed" ||
    s.state === "Returned" ||
    s.state === "Arrived" ||
    s.state === "Exception"
  );
}

/** What `refresh()` should do with the route the server returned. Pure so the phase decision — the thing
 *  the "no active route on arrival" bug lived in — is unit-testable without React/DB/network.
 *
 *  - `noop`: leave everything exactly as-is (a background poll on an already-loaded route).
 *  - `adopt`: take this server route as the working copy (sets loadedRef); with `phase` for the screen.
 *  - `holdNext`: hold this as the truck's NEXT route on the closeout screen (don't yank the driver in).
 *  - `phase` alone: just move to this phase without adopting a route.
 *  - `{}` (none set): no state change, only clear the error. */
export interface RefreshDecision {
  noop?: boolean;
  adopt?: Route;
  holdNext?: Route;
  phase?: RoutePhase;
}

export function decideRefresh(
  r: Route | null,
  ctx: { loaded: boolean; force: boolean; phase: RoutePhase; routeId: string | null },
): RefreshDecision {
  // Background polling must not clobber the driver's in-progress state. Only a FORCED resync (the Refresh
  // button, advancing to the next stop, or the first load before anything is adopted) re-adopts.
  if (ctx.loaded && !ctx.force) return { noop: true };

  if (!r) {
    // No route for this truck today. Only fall to the Start screen before anything is loaded — never
    // yank a driver who's already working (or just finished) a route onto "Start Route".
    return ctx.loaded ? {} : { phase: "needsStart" };
  }

  if (r.status === "scraping") return { phase: "scraping" };
  if (r.status === "failed") return ctx.loaded ? {} : { phase: "failed" };

  if (r.status === "ready" || r.status === "active") {
    // The driver finished the current route (closeout → it's now `done` server-side) and a DIFFERENT route
    // is the truck's active one — its next dispatch of the day. Don't yank the closeout screen into the new
    // route's stops; hold it and surface an explicit "Start next route".
    const inCloseout = ctx.phase === "headingBack" || ctx.phase === "returned";
    if (inCloseout && ctx.routeId && r.routeId !== ctx.routeId) {
      return { holdNext: r };
    }
    // "headingBack"/"returned" are CLIENT-ONLY phases (the server route stays ready/active with every stop
    // Completed after the last stop). A forced re-pull must NOT stomp them — that drops the driver out of
    // headingBack into "stops" with no active stop and no buttons (the "Arrived at Warehouse" button
    // vanishes, the route can't be closed). Preserve them as long as every stop is still Completed; a
    // genuinely new active stop on the SAME route falls through to "stops".
    const allDone = r.stops.length > 0 && r.stops.every((s) => s.state === "Completed");
    const keep = (ctx.phase === "headingBack" || ctx.phase === "returned") && allDone;
    return { adopt: r, phase: keep ? ctx.phase : r.stops.length ? "stops" : "empty" };
  }

  // r.status === "done"
  if (ctx.loaded) {
    // In-session: the driver just closed out (phase is already "returned"/"headingBack") — leave their
    // screen alone. Adopting here with a phase would stomp the recap.
    return {};
  }
  // Fresh mount (a WebView reload or Android activity resume AFTER the warehouse closeout, which closed the
  // route server-side). The route is finished, not missing: if the driver actually worked it, restore the
  // route-complete recap instead of the bare "no active route / Start Route" screen — THE reported bug.
  // Only a done route the driver never touched (office force-closed before it started) invites a fresh pull.
  const worked = r.stops.some(wasWorked);
  return worked ? { adopt: r, phase: "returned" } : { phase: "needsStart" };
}

export function useRouteMachine(truckId: string): RouteMachine {
  const [route, setRoute] = useState<Route | null>(null);
  const [phase, setPhase] = useState<RoutePhase>("loading");
  const [online, setOnline] = useState(true);
  const [queuedCount, setQueuedCount] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notif, setNotif] = useState<Record<string, StopNotif>>({});
  const [counters, setCounters] = useState({ exceptions: 0, dispatchMsgs: 0 });
  const [startedAt, setStartedAt] = useState<string | null>(null);
  const [lastCloseout, setLastCloseout] = useState<CloseoutResult | null>(null);
  // The truck's NEXT route, once the current one is closed (a truck can run several routes a day —
  // morning/afternoon/night). Held so the closeout screen can offer an explicit "Start next route"
  // instead of the poll yanking the driver into the next route's stops.
  const [nextRoute, setNextRoute] = useState<Route | null>(null);
  const loadedRef = useRef(false);
  // Live mirrors of route/phase so refresh() can read them without being re-created on every change.
  const routeRef = useRef<Route | null>(null);
  const phaseRef = useRef<RoutePhase>("loading");
  useEffect(() => { routeRef.current = route; }, [route]);
  useEffect(() => { phaseRef.current = phase; }, [phase]);

  const syncQueue = useCallback(() => setQueuedCount(queueSize()), []);

  const receipt = useCallback(
    (action: ActionType, queued: boolean, title: string) => {
      const autos = automationsFor(action);
      const description = autos.length ? autos.join(" · ") : undefined;
      if (queued) {
        toast.warning("Saved offline — will sync when reconnected", { description });
      } else {
        toast.success(title, { description });
      }
    },
    [],
  );

  const refresh = useCallback(async (force = false) => {
    try {
      const r = await fetchRoute(truckId);
      // The phase/adopt decision is a pure function (decideRefresh) so it's unit-testable — see the
      // comments there for why each status maps the way it does. The server preserves completed/active
      // stops on re-import, so adopting a route is safe. KEY: on a FRESH mount (a WebView reload / Android
      // resume after the warehouse closeout) a `done`-today route the driver worked restores the
      // route-complete recap, NOT the bare "Start Route" screen.
      const decision = decideRefresh(r, {
        loaded: loadedRef.current,
        force,
        phase: phaseRef.current,
        routeId: routeRef.current?.routeId ?? null,
      });
      if (decision.noop) {
        setError(null);
        return;
      }
      if (decision.holdNext) {
        setNextRoute(decision.holdNext);
        setError(null);
        return;
      }
      if (decision.adopt) {
        setRoute(decision.adopt);
        loadedRef.current = true;
      }
      if (decision.phase) setPhase(decision.phase);
      setError(null);
    } catch {
      setError("Could not load route.");
    }
  }, [truckId]);

  /** Force-pull the current server route (Refresh button / on advancing). */
  const resync = useCallback(() => refresh(true), [refresh]);

  /** Advance to the truck's next route of the day (offered on the closeout screen). Adopts the held
   *  next route and resets the per-route client state (notifications, counters, closeout) so the new
   *  route starts clean, then force-pulls its freshest copy. */
  const startNextRoute = useCallback(() => {
    if (!nextRoute) return;
    const nextPhase: RoutePhase = nextRoute.stops.length ? "stops" : "empty";
    // Update the refs synchronously too: the forced refresh below reads routeRef/phaseRef, which the
    // effects only sync on the NEXT render — without this it'd see the OLD route/phase and wrongly
    // re-hold the next route instead of adopting it.
    routeRef.current = nextRoute;
    phaseRef.current = nextPhase;
    setRoute(nextRoute);
    setNextRoute(null);
    setStartedAt(null);
    setLastCloseout(null);
    setNotif({});
    setCounters({ exceptions: 0, dispatchMsgs: 0 });
    loadedRef.current = true;
    setPhase(nextPhase);
    void refresh(true);
  }, [nextRoute, refresh]);

  // Start Route → trigger ingestion; polling picks up scraping → ready/failed.
  const startRouteRef = useRef<() => void>(() => {});
  const startRoute = useCallback(async () => {
    setPhase("scraping");
    loadedRef.current = false;
    try {
      // In the Android kiosk, pull today's route straight from the logged-in
      // Goodshuffle session (server-side scraping is Cloudflare-blocked).
      const res = await importGoodshuffleRouteViaKiosk(truckId);
      if (res.inKiosk) {
        if (res.ok && res.stops.length) {
          await fetch("/api/route/import", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ truckId, stops: res.stops, gsRouteId: res.gsRouteId }),
          });
          loadedRef.current = false;
          await refresh(true);
          toast.dismiss("gs-pull-fail");
          toast.success(`Loaded ${res.stops.length} stop${res.stops.length === 1 ? "" : "s"} from Goodshuffle`);
          return;
        }
        // In the kiosk but nothing loaded — make it LOUD: a persistent prompt that
        // names the PRECISE reason (using the route counts) and offers to retry.
        const why =
          res.error === "old_app_build_no_import"
            ? "This app build can't import yet — update the tablet."
            : res.error === "no_response_timeout"
              ? "Goodshuffle didn't respond — check it's signed in (left panel)."
              : res.error
                ? `Goodshuffle import failed: ${res.error}`
                : res.total === 0
                  ? "No routes scheduled in Goodshuffle for today."
                  : res.matched === 0
                    ? `Found ${res.total} route(s) today, but none assigned to this truck.`
                    : res.total != null
                      ? "Found the route, but it has no delivery stops."
                      : "No Goodshuffle route found for this truck today.";
        toast.error(`Couldn't pull the route — ${why}`, {
          id: "gs-pull-fail",
          duration: Infinity,
          action: { label: "Try again", onClick: () => void startRouteRef.current() },
        });
        // In the kiosk, the WebView pull IS the ingestion mechanism. Do NOT fall back to
        // server-side scraping — it's Cloudflare-blocked (always fails) and would flip the
        // route to "failed" and WIPE its stops. Keep whatever route is already loaded and
        // let the driver retry (or use manual entry).
        return;
      }
      // Plain web / Electron (not the native kiosk): use the server-side ingestion path.
      await triggerIngestion(truckId);
    } catch {
      setPhase("failed");
    }
  }, [truckId, refresh]);
  // Keep a live ref so the toast's "Try again" always calls the latest startRoute.
  startRouteRef.current = startRoute;

  // Silent auto re-pull (Goodshuffle → app). Keeps a LOADED route fresh so a change made in
  // Goodshuffle mid-day flows in on its own. Unlike startRoute this is quiet: no toasts, and
  // any failure is swallowed so background sync can never disrupt the driver. The server
  // import reconciles (keeps started/finished stops, refreshes only the upcoming tail), so
  // adopting the re-pulled route via a forced refresh is safe.
  const rePullingRef = useRef(false);
  const rePull = useCallback(async () => {
    if (rePullingRef.current || !loadedRef.current) return; // only refresh an active route
    if (typeof navigator !== "undefined" && !navigator.onLine) return;
    rePullingRef.current = true;
    try {
      // On the kiosk, pull Goodshuffle → DB first (the kiosk is the one device with a logged-in GS
      // session). A failure here is fine and must stay silent — the office Auto-Pull may already have
      // refreshed the DB.
      const res = await importGoodshuffleRouteViaKiosk(truckId);
      if (res.inKiosk && res.ok && res.stops.length) {
        await fetch("/api/route/import", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ truckId, stops: res.stops, gsRouteId: res.gsRouteId }),
        });
      }
      // ALWAYS adopt the latest server route — whether THIS kiosk just pulled it, or the OFFICE pull
      // (or another device) already wrote last night's edit to the DB. Previously this refresh was
      // nested inside the kiosk-pull-succeeded branch, so a kiosk whose own pull hiccuped kept showing
      // a stale route even though the DB was fresh. reconcile makes adopting safe (keeps acted-on
      // stops; only the upcoming tail re-orders).
      await refresh(true);
    } catch {
      /* auto sync must never surface an error to the driver */
    } finally {
      rePullingRef.current = false;
    }
  }, [truckId, refresh]);

  // Explicit "Re-sync from Goodshuffle" (driver button). Arm the server-side one-shot force flag for the
  // loaded route, then re-pull: the kiosk pull POSTs the route to /api/route/import, which consumes the
  // flag and applies Goodshuffle's CURRENT order (even to in-progress stops) before adopting the DB.
  const resyncFromGoodshuffle = useCallback(async () => {
    if (!route) return;
    try {
      await fetch("/api/route/resync", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ routeId: route.routeId }),
      });
    } catch {
      /* if arming fails, the re-pull below still runs the normal (progress-protecting) merge */
    }
    void rePull();
  }, [route, rePull]);

  // Manual fallback when the scrape fails: dispatch enters stops by hand. Persists
  // to the server (so actions → SMS work), then adopts the server route.
  const submitManual = useCallback(
    async (stops: Stop[]) => {
      try {
        await fetch("/api/route/import", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            truckId,
            stops: stops.map((s) => ({
              custName: s.custName,
              custPhone: s.custPhone,
              address: s.address,
              dayOfName: s.dayOfName,
              dayOfPhone: s.dayOfPhone,
              plannedWindow: s.plannedWindow,
              eta: s.eta,
            })),
          }),
        });
        loadedRef.current = false; // let refresh adopt the freshly-written server route
        await refresh();
      } catch {
        // Network failure: render locally so dispatch isn't blocked (note: local-only
        // stops won't drive server actions until connectivity returns).
        const date = todayInOpsTz();
        const routeId = `R-${date}-${truckId}`;
        const normalized: Stop[] = stops.map((s, i) => ({
          ...s,
          routeId,
          stopId: s.stopId || `${routeId}-S${i + 1}`,
          customerId: s.customerId || `${routeId}-C${i + 1}`,
          sequence: i + 1,
          state: "Waiting",
        }));
        setRoute({ routeId, date, truckId, status: "ready", stops: normalized });
        loadedRef.current = true;
        setPhase(normalized.length ? "stops" : "empty");
      }
    },
    [truckId, refresh],
  );

  // Initial load + light polling for the (future) live data path. On open, after the first DB read
  // loads the route, kick ONE Goodshuffle re-pull so the driver starts on the freshest route (an edit
  // made since the last pull shows immediately, not after the first interval).
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh().then(() => void rePull());
    const id = setInterval(() => void refresh(), appConfig.routePollMs);
    return () => clearInterval(id);
  }, [refresh, rePull]);

  // Auto re-pull the route FROM Goodshuffle on an interval, so edits made in Goodshuffle
  // (add/remove/reschedule/re-address an upcoming stop) show up in the app without anyone
  // re-pulling by hand. Silent; only acts on a loaded route in the kiosk.
  useEffect(() => {
    const id = setInterval(() => void rePull(), appConfig.routeRepullMs);
    return () => clearInterval(id);
  }, [rePull]);

  // While a scrape is running, poll fast so "Loading route…" flips to the stops
  // as soon as ingestion finishes, instead of waiting a full poll interval.
  useEffect(() => {
    if (phase !== "scraping") return;
    const id = setInterval(() => void refresh(), 2000);
    return () => clearInterval(id);
  }, [phase, refresh]);

  // Online/offline tracking + flush queued actions on reconnect.
  useEffect(() => {
    const update = () => {
      const isOnline = typeof navigator === "undefined" ? true : navigator.onLine;
      setOnline(isOnline);
      if (isOnline) void flushQueue().then(syncQueue);
    };
    update();
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, [syncQueue]);

  // The native kiosk fires window.__zoeGoodshuffleReady the instant Goodshuffle sign-in
  // completes. Auto-pull the route then — but ONLY when nothing is loaded yet, so a
  // mid-shift re-auth can't clobber a route the driver is already working.
  useEffect(() => {
    const w = window as unknown as { __zoeGoodshuffleReady?: () => void };
    w.__zoeGoodshuffleReady = () => {
      if (!loadedRef.current) void startRouteRef.current();
    };
    return () => {
      if (w.__zoeGoodshuffleReady) delete w.__zoeGoodshuffleReady;
    };
  }, []);

  const activeIndex = route ? firstActiveIndex(route.stops) : -1;
  const activeStop = route && activeIndex >= 0 ? route.stops[activeIndex] : null;

  let actions: AvailableAction[] = [];
  if (phase === "headingBack") {
    actions = getAvailableActions("HeadingBack");
  } else if (phase === "stops" && activeStop) {
    actions = getAvailableActions(activeStop.state, {
      isFirstStop: activeIndex === 0,
      isLastStop: activeIndex === route!.stops.length - 1,
    });
  }

  const perform = useCallback(
    async (action: ActionType, payload?: Record<string, unknown>) => {
      if (!route) return;
      setBusy(true);
      setError(null);
      try {
        const idx = firstActiveIndex(route.stops);
        const isHeadingBack = phase === "headingBack";
        const stop = idx >= 0 ? route.stops[idx] : null;
        const fromState: StopState = isHeadingBack ? "HeadingBack" : stop!.state;
        const isLast = idx === route.stops.length - 1;

        const toState = resolveTransition(fromState, action, {
          isFirstStop: idx === 0,
          isLastStop: isLast,
        });
        if (!toState) {
          setError("That action isn't allowed right now.");
          return;
        }

        // TODO(remove next release): on-device Zonar etaLink minting is the retired device-login path.
        // The "on the way" SMS now carries our own /track link (real server-side GPS), so we no longer
        // mint an Ignition link in the kiosk's logged-in WebView. Kept DORMANT one release as a rollback:
        // NEXT_PUBLIC_GS_ETALINK_LEGACY=1 restores minting (fanout also needs GS_ETALINK_LEGACY=1 to use it).
        let payloadOut = payload;
        if (
          process.env.NEXT_PUBLIC_GS_ETALINK_LEGACY === "1" &&
          (action === "LEAVING_WAREHOUSE" || action === "HEADING_NEXT")
        ) {
          const target = action === "HEADING_NEXT" ? route.stops[idx + 1] : stop;
          const link = await createEtaLinkViaKiosk(truckId, target?.address);
          if (link) payloadOut = { ...(payload ?? {}), etaLink: link };
        }

        const gps = await getGps();
        const req = buildAction({
          truckId,
          routeId: route.routeId,
          stopId: stop?.stopId ?? route.routeId,
          action,
          fromState,
          gps,
          payload: payloadOut,
          context: { isFirstStop: idx === 0, isLastStop: isLast },
        });

        const res = await sendAction(req);
        syncQueue();
        if (!res.accepted) {
          const msg =
            res.error === "invalid_transition"
              ? "That action isn't allowed right now."
              : "Something went wrong. Try again.";
          setError(msg);
          toast.error(msg);
          return;
        }

        setStartedAt((s) => s ?? new Date().toISOString());
        if (action === "ARRIVED_WAREHOUSE" && payload?.closeout) {
          setLastCloseout(payload.closeout as CloseoutResult);
        }
        applyLocal(action, toState, idx);

        // Record the customer automations this action fired.
        const now = new Date().toISOString();
        const curStopId = stop?.stopId;
        const nextStop = route.stops[idx + 1];
        setNotif((prev) => {
          const next = { ...prev };
          if (action === "LEAVING_WAREHOUSE" && curStopId)
            next[curStopId] = { ...next[curStopId], onWay: now, tracking: now };
          if (action === "ARRIVED" && curStopId)
            next[curStopId] = { ...next[curStopId], arrived: now };
          if (action === "HEADING_NEXT" && nextStop)
            next[nextStop.stopId] = {
              ...next[nextStop.stopId],
              onWay: now,
              tracking: now,
            };
          return next;
        });
        if (action === "REPORT_EXCEPTION") {
          setCounters((c) => ({ ...c, exceptions: c.exceptions + 1 }));
        }
        receipt(action, res.error === "queued_offline", STATE_VISUAL[toState].label);

        // Heading to the next customer: re-pull Goodshuffle → DB and adopt it, so any change
        // dispatch made to the upcoming stops (reorder, re-address, add/remove) is reflected before
        // the driver rolls. rePull pulls on the kiosk and always adopts the latest DB (so an office
        // pull is picked up too); refresh(true) guarantees an immediate adopt even if a background
        // rePull is mid-flight. Only when online (offline stays on optimistic state).
        if (action === "HEADING_NEXT" && res.error !== "queued_offline") {
          void refresh(true);
          void rePull();
        }
        // Finished the route (closeout closed it server-side): pull so the truck's NEXT route of the
        // day surfaces as "Start next route" promptly, not on the slow background poll.
        if (action === "ARRIVED_WAREHOUSE" && res.error !== "queued_offline") {
          void refresh(true);
        }
      } finally {
        setBusy(false);
      }
    },
    [route, phase, truckId, syncQueue, receipt, refresh, rePull],
  );

  const sendSide = useCallback(
    async (action: ActionType, payload?: Record<string, unknown>, title?: string) => {
      if (!route) return;
      setBusy(true);
      try {
        const idx = firstActiveIndex(route.stops);
        const stop = idx >= 0 ? route.stops[idx] : null;
        const fromState: StopState =
          phase === "headingBack" ? "HeadingBack" : (stop?.state ?? "Waiting");
        const gps = await getGps();
        const req = buildAction({
          truckId,
          routeId: route.routeId,
          stopId: stop?.stopId ?? route.routeId,
          action,
          fromState,
          gps,
          payload,
        });
        const res = await sendAction(req);
        syncQueue();
        if (!res.accepted) {
          toast.error("Couldn't send. Try again.");
          return;
        }
        if (action === "NOTIFY_DISPATCH") {
          setCounters((c) => ({ ...c, dispatchMsgs: c.dispatchMsgs + 1 }));
        }
        receipt(action, res.error === "queued_offline", title ?? "Sent");
      } finally {
        setBusy(false);
      }
    },
    [route, phase, truckId, syncQueue, receipt],
  );

  function applyLocal(action: ActionType, toState: StopState, idx: number) {
    setRoute((prev) => {
      if (!prev) return prev;
      const stops = prev.stops.map((s) => ({ ...s }));
      if (idx >= 0 && idx < stops.length) {
        stops[idx].state = toState;
        if (action === "ARRIVED") stops[idx].arrivedAt = new Date().toISOString();
        if (toState === "Completed")
          stops[idx].completedAt = new Date().toISOString();
        if (action === "HEADING_NEXT" && idx + 1 < stops.length) {
          stops[idx + 1].state = "EnRoute";
        }
      }
      return { ...prev, stops };
    });

    if (action === "COMPLETE_AND_RETURN" || action === "RETURN_ITEM") {
      setPhase("headingBack");
    } else if (action === "ARRIVED_WAREHOUSE") {
      setPhase("returned");
    }
  }

  const summary: RouteSummary = {
    stopsCompleted: route
      ? route.stops.filter((s) => s.state === "Completed").length
      : 0,
    totalStops: route?.stops.length ?? 0,
    textsSent: Object.values(notif).reduce(
      (n, x) => n + (x.onWay ? 1 : 0) + (x.arrived ? 1 : 0),
      0,
    ),
    exceptions: counters.exceptions,
    dispatchMsgs: counters.dispatchMsgs,
    startedAt,
  };

  return {
    route,
    phase,
    activeStop,
    activeIndex,
    actions,
    online,
    queuedCount,
    busy,
    error,
    notif,
    summary,
    lastCloseout,
    nextRoute,
    refresh,
    resync,
    resyncFromGoodshuffle,
    startRoute,
    startNextRoute,
    submitManual,
    perform,
    sendSide,
  };
}
