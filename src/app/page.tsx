"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { getBoundTruck } from "@/lib/device";
import { isNativeAndroid } from "@/lib/kiosk";

// Entry point. Two audiences reach "/":
//  • the Android kiosk tablet (loads us with ?native=android) → its bound truck's route, or truck select.
//  • a back-office person in a browser → the Command Center dashboard.
// The tablet is the ONLY thing that should see the driver/kiosk flow; everyone else is office.
export default function Home() {
  const router = useRouter();

  useEffect(() => {
    if (isNativeAndroid()) {
      router.replace(getBoundTruck() ? "/kiosk" : "/select");
    } else {
      router.replace("/dashboard");
    }
  }, [router]);

  return (
    <main className="flex min-h-dvh items-center justify-center text-muted-foreground">
      Loading…
    </main>
  );
}
