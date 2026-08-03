"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Header } from "@/components/Header";
import { CurrentStopView } from "@/components/CurrentStopView";
import { RouteOverview } from "@/components/RouteOverview";
import { getBoundTruck, clearTruck, type TruckBinding } from "@/lib/device";
import { useRouteMachine } from "@/lib/useRouteMachine";

export default function RoutePage() {
  const router = useRouter();
  const [truck, setTruck] = useState<TruckBinding | null | undefined>(undefined);

  useEffect(() => {
    const bound = getBoundTruck();
    if (!bound) {
      router.replace("/select");
      return;
    }
    // Deferred to an effect (not a lazy initializer) so the client reads
    // localStorage after mount, avoiding an SSR/CSR hydration mismatch.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setTruck(bound);
  }, [router]);

  if (!truck) {
    return (
      <main className="flex min-h-dvh items-center justify-center text-muted-foreground">
        Loading…
      </main>
    );
  }

  return <RouteScreen truck={truck} onChangeTruck={() => {
    clearTruck();
    router.replace("/select");
  }} />;
}

function RouteScreen({
  truck,
  onChangeTruck,
}: {
  truck: TruckBinding;
  onChangeTruck: () => void;
}) {
  const m = useRouteMachine(truck.truckId);

  const stops = m.route?.stops ?? [];

  return (
    <div className="min-h-dvh bg-background">
      <Header
        truckName={truck.name}
        stops={stops}
        activeIndex={m.activeIndex}
        online={m.online}
        queuedCount={m.queuedCount}
        onChangeTruck={onChangeTruck}
        onRefresh={m.refresh}
      />

      <main className="mx-auto max-w-2xl space-y-6 p-4 pb-24">
        <CurrentStopView
          phase={m.phase}
          activeStop={m.activeStop}
          totalStops={stops.length}
          actions={m.actions}
          busy={m.busy}
          onPerform={m.perform}
        />

        {stops.length > 0 && (
          <RouteOverview stops={stops} activeIndex={m.activeIndex} />
        )}
      </main>
    </div>
  );
}
