"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { RotateCcw } from "lucide-react";
import { Header } from "@/components/Header";
import { CurrentStopView } from "@/components/CurrentStopView";
import { RouteOverview } from "@/components/RouteOverview";
import { RouteSummaryPanel } from "@/components/RouteSummaryPanel";
import { RouteStartStates } from "@/components/RouteStartStates";
import { useRouteMachine } from "@/lib/useRouteMachine";
import { canCheckForUpdate, checkForUpdateViaKiosk } from "@/lib/kioskBridge";
import type { TruckBinding } from "@/lib/device";

/**
 * The driver's route/action surface. Rendered full-screen at /route and inside a
 * pane at /kiosk (kiosk trims outer chrome so it sits beside Goodshuffle Pro).
 */
export function RouteScreen({
  truck,
  onChangeTruck,
  kiosk = false,
}: {
  truck: TruckBinding;
  onChangeTruck: () => void;
  kiosk?: boolean;
}) {
  const m = useRouteMachine(truck.truckId);
  const stops = m.route?.stops ?? [];

  // "Check for updates" only appears inside the Android kiosk build that supports it.
  const [canUpdate, setCanUpdate] = useState(false);
  useEffect(() => setCanUpdate(canCheckForUpdate()), []);

  const onCheckUpdate = useCallback(async () => {
    toast.loading("Checking for updates…", { id: "ota" });
    const msg = await checkForUpdateViaKiosk();
    toast.dismiss("ota");
    toast.message(msg ?? "Couldn't check for updates.");
  }, []);

  // Driver "Re-sync from Goodshuffle": force this route to match Goodshuffle's current order, even while
  // it's in progress. Guarded by a confirm because it can change the next stop.
  const onResync = useCallback(() => {
    if (!window.confirm("Pull the latest route order from Goodshuffle? This can change your next stop.")) return;
    toast.loading("Re-syncing from Goodshuffle…", { id: "resync" });
    void m.resyncFromGoodshuffle().finally(() => toast.dismiss("resync"));
  }, [m]);

  const routeLoaded = m.phase === "stops" || m.phase === "headingBack" || m.phase === "returned";

  return (
    <div className={kiosk ? "flex h-full flex-col bg-background" : "min-h-dvh bg-background"}>
      <Header
        truckName={truck.name}
        stops={stops}
        activeIndex={m.activeIndex}
        online={m.online}
        queuedCount={m.queuedCount}
        onChangeTruck={onChangeTruck}
        onRefresh={m.resync}
        onPullRoute={m.startRoute}
        onCheckUpdate={canUpdate ? onCheckUpdate : undefined}
      />

      <main
        className={
          kiosk
            ? "mx-auto w-full max-w-xl flex-1 space-y-6 overflow-y-auto p-4 pb-10"
            : "mx-auto max-w-2xl space-y-6 p-4 pb-24"
        }
      >
        {m.phase === "needsStart" ||
        m.phase === "scraping" ||
        m.phase === "failed" ||
        m.phase === "loading" ? (
          <RouteStartStates
            phase={m.phase}
            busy={m.busy}
            onStart={m.startRoute}
            onManualSubmit={m.submitManual}
          />
        ) : m.phase === "returned" ? (
          <RouteSummaryPanel
            summary={m.summary}
            closeout={m.lastCloseout}
            nextRoute={m.nextRoute}
            onStartNext={m.startNextRoute}
          />
        ) : (
          <>
            <CurrentStopView
              phase={m.phase}
              activeStop={m.activeStop}
              totalStops={stops.length}
              truckId={truck.truckId}
              actions={m.actions}
              busy={m.busy}
              onPerform={m.perform}
              notif={m.activeStop ? m.notif[m.activeStop.stopId] : undefined}
              onMessageDispatch={(message) =>
                m.sendSide("NOTIFY_DISPATCH", { message }, "Message sent to dispatch")
              }
            />

            {stops.length > 0 && (
              <RouteOverview stops={stops} activeIndex={m.activeIndex} />
            )}
          </>
        )}

        {routeLoaded && (
          <button
            onClick={onResync}
            disabled={m.busy}
            className="inline-flex w-full items-center justify-center gap-2 rounded-lg border border-border px-4 py-2.5 text-sm text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
          >
            <RotateCcw className="size-4" /> Re-sync from Goodshuffle
          </button>
        )}
      </main>
    </div>
  );
}
