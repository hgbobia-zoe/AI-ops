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
import type { ActionType, Route, Stop, StopState } from "./types";
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
  refresh: (force?: boolean) => Promise<void>;
  resync: () => Promise<void>;
  startRoute: () => Promise<void>;
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
  const loadedRef = useRef(false);

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
      // Background polling must not clobber the driver's in-progress state. Only a
      // FORCED resync (the Refresh button, or advancing to the next stop) re-adopts
      // the server route — which dispatch may have updated overnight or mid-day.
      // The server preserves completed/active stops on re-import, so adopting it is
      // safe: it reflects finished deliveries plus any updated upcoming stops.
      if (loadedRef.current && !force) {
        setError(null);
        return;
      }
      if (!r) {
        if (!loadedRef.current) setPhase("needsStart");
      } else if (r.status === "scraping") {
        setPhase("scraping");
      } else if (r.status === "failed") {
        if (!loadedRef.current) setPhase("failed");
      } else if (r.status === "ready" || r.status === "active") {
        setRoute(r);
        loadedRef.current = true;
        setPhase(r.stops.length ? "stops" : "empty");
      }
      setError(null);
    } catch {
      setError("Could not load route.");
    }
  }, [truckId]);

  /** Force-pull the current server route (Refresh button / on advancing). */
  const resync = useCallback(() => refresh(true), [refresh]);

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
            body: JSON.stringify({ truckId, stops: res.stops }),
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
      }
      await triggerIngestion(truckId);
    } catch {
      setPhase("failed");
    }
  }, [truckId, refresh]);
  // Keep a live ref so the toast's "Try again" always calls the latest startRoute.
  startRouteRef.current = startRoute;

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

  // Initial load + light polling for the (future) live data path.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
    const id = setInterval(() => void refresh(), appConfig.routePollMs);
    return () => clearInterval(id);
  }, [refresh]);

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

        // In the Android kiosk, mint a Zonar ETA link for the customer this action's
        // "on the way" SMS will reach, and pass it on the payload (fanout prefers it
        // over the self-hosted /track link). No-op — and instant — outside the kiosk.
        let payloadOut = payload;
        if (action === "LEAVING_WAREHOUSE" || action === "HEADING_NEXT") {
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

        // Heading to the next customer: pull the current route so any overnight /
        // mid-day change dispatch made to the upcoming stops is reflected before the
        // driver rolls. Only when processed online (offline stays on optimistic state).
        if (action === "HEADING_NEXT" && res.error !== "queued_offline") {
          void refresh(true);
        }
      } finally {
        setBusy(false);
      }
    },
    [route, phase, truckId, syncQueue, receipt, refresh],
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
    refresh,
    resync,
    startRoute,
    submitManual,
    perform,
    sendSide,
  };
}
