"use client";

// Client hook: polls the live-ETA endpoint (real truck location → real ETA) for
// the active stop while the truck is en route. Returns null when Zonar isn't
// configured or the truck/stop isn't trackable — callers fall back to the plan.

import { useEffect, useState } from "react";

export interface LiveEtaClient {
  etaText: string;
  minutesAway: number;
  distanceMiles?: number;
}

export function useLiveEta(
  truckId: string,
  stopId: string | undefined,
  active: boolean,
): LiveEtaClient | null {
  const [eta, setEta] = useState<LiveEtaClient | null>(null);

  useEffect(() => {
    if (!active || !stopId) {
      setEta(null);
      return;
    }
    let alive = true;
    const load = async () => {
      try {
        const r = await fetch(
          `/api/eta?truckId=${encodeURIComponent(truckId)}&stopId=${encodeURIComponent(stopId)}`,
          { cache: "no-store" },
        );
        const d = await r.json();
        if (alive) setEta((d?.eta as LiveEtaClient | null) ?? null);
      } catch {
        /* keep the last value on a transient failure */
      }
    };
    void load();
    // Refresh the UI every 60s. Note this does NOT set the GPS-TrackIt call rate — the
    // server caches upstream results (ETA_CACHE_SECONDS), so most polls are cache hits.
    const id = setInterval(load, 60_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [truckId, stopId, active]);

  return eta;
}
