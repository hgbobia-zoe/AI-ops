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
import { fetchRoute } from "./tablesRead";
import { buildAction, flushQueue, getGps, sendAction } from "./webhookClient";
import { queueSize } from "./offlineQueue";

export type RoutePhase = "loading" | "stops" | "headingBack" | "returned" | "empty";

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
  refresh: () => Promise<void>;
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

  const refresh = useCallback(async () => {
    try {
      const r = await fetchRoute(truckId);
      if (!r) {
        setPhase("empty");
        return;
      }
      // M1: only adopt the fetched route the first time, so local progress isn't
      // clobbered by the stateless mock. M2 seam: replace with reconciliation.
      if (!loadedRef.current) {
        setRoute(r);
        loadedRef.current = true;
        setPhase(r.stops.length ? "stops" : "empty");
      }
      setError(null);
    } catch {
      setError("Could not load route.");
    }
  }, [truckId]);

  // Initial load + light polling for the (future) live data path.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
    const id = setInterval(() => void refresh(), appConfig.routePollMs);
    return () => clearInterval(id);
  }, [refresh]);

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

        const gps = await getGps();
        const req = buildAction({
          truckId,
          routeId: route.routeId,
          stopId: stop?.stopId ?? route.routeId,
          action,
          fromState,
          gps,
          payload,
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
      } finally {
        setBusy(false);
      }
    },
    [route, phase, truckId, syncQueue, receipt],
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
    perform,
    sendSide,
  };
}
