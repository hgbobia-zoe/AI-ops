// Client hook that owns the tablet's working copy of the route and drives the
// state machine. Every driver action flows through performAction():
//   optimistic local transition → one webhook → (offline-safe) queue+replay.
//
// NOTE (M1): the mock backend does not persist state, so the local working copy
// is authoritative during M1 testing. At M2, once the Zapier Tables hold real
// state, the polled route becomes the source of truth and this overlay reconciles
// against it. That seam is marked below.

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { appConfig } from "./config";
import { STATE_VISUAL } from "./stateVisual";
import { getAvailableActions, resolveTransition } from "./stateMachine";
import type {
  AvailableAction,
} from "./stateMachine";
import type { ActionType, Route, Stop, StopState } from "./types";
import { fetchRoute } from "./tablesRead";
import {
  buildAction,
  flushQueue,
  getGps,
  sendAction,
} from "./webhookClient";
import { queueSize } from "./offlineQueue";

export type RoutePhase = "loading" | "stops" | "headingBack" | "returned" | "empty";

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
  refresh: () => Promise<void>;
  perform: (action: ActionType, payload?: Record<string, unknown>) => Promise<void>;
}

function firstActiveIndex(stops: Stop[]): number {
  const idx = stops.findIndex((s) => s.state !== "Completed");
  return idx;
}

export function useRouteMachine(truckId: string): RouteMachine {
  const [route, setRoute] = useState<Route | null>(null);
  const [phase, setPhase] = useState<RoutePhase>("loading");
  const [online, setOnline] = useState(true);
  const [queuedCount, setQueuedCount] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loadedRef = useRef(false);

  const syncQueue = useCallback(() => setQueuedCount(queueSize()), []);

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

  // Initial load + light polling for the (future) live data path. refresh()
  // only setStates after an awaited fetch, so this isn't a synchronous cascade.
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
  const activeStop =
    route && activeIndex >= 0 ? route.stops[activeIndex] : null;

  // Derive the actions to show for the current context.
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
        const fromState: StopState = isHeadingBack
          ? "HeadingBack"
          : stop!.state;
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

        // Apply the optimistic local transition + side effects.
        applyLocal(action, toState, idx);

        if (res.error === "queued_offline") {
          toast.warning("Saved offline — will sync when reconnected");
        } else {
          toast.success(`${STATE_VISUAL[toState].label}`);
        }
      } finally {
        setBusy(false);
      }
    },
    [route, phase, truckId, syncQueue],
  );

  function applyLocal(
    action: ActionType,
    toState: StopState,
    idx: number,
  ) {
    setRoute((prev) => {
      if (!prev) return prev;
      const stops = prev.stops.map((s) => ({ ...s }));
      if (idx >= 0 && idx < stops.length) {
        stops[idx].state = toState;
        if (action === "ARRIVED") stops[idx].arrivedAt = new Date().toISOString();
        if (toState === "Completed")
          stops[idx].completedAt = new Date().toISOString();
        // HEADING_NEXT: backend also moves the next stop to EnRoute + SMS.
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
    refresh,
    perform,
  };
}
