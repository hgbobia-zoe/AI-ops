"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { getBoundTruck } from "@/lib/device";

// Entry point: route the tablet to its bound truck's route, or to truck select.
export default function Home() {
  const router = useRouter();

  useEffect(() => {
    router.replace(getBoundTruck() ? "/route" : "/select");
  }, [router]);

  return (
    <main className="flex min-h-dvh items-center justify-center text-muted-foreground">
      Loading…
    </main>
  );
}
