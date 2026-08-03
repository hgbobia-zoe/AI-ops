"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { RouteScreen } from "@/components/RouteScreen";
import { getBoundTruck, clearTruck, type TruckBinding } from "@/lib/device";

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

  return (
    <RouteScreen
      truck={truck}
      onChangeTruck={() => {
        clearTruck();
        router.replace("/select");
      }}
    />
  );
}
