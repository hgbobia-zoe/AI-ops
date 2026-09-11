"use client";

// Continuous name-enrichment loop. While the Coaching blade is open, it keeps asking the server to
// resolve names for calls that still show only a number (from our bookings, else the OpenPhone
// address book), draining the due backlog and then refreshing so the newly-named calls update.
// Silent — no UI. Unnameable numbers are throttled server-side and retried on a later visit.

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";

export function NameEnricher(): null {
  const router = useRouter();
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    let cancelled = false;

    (async () => {
      let resolvedAny = false;
      for (let i = 0; i < 100 && !cancelled; i++) {
        let res: Response;
        try {
          res = await fetch("/api/coaching/enrich-names", { method: "POST" });
        } catch {
          break;
        }
        if (!res.ok) break;
        const j = (await res.json().catch(() => null)) as { resolved?: number; done?: boolean } | null;
        if (!j) break;
        if ((j.resolved ?? 0) > 0) resolvedAny = true;
        if (j.done) break;
      }
      if (!cancelled && resolvedAny) router.refresh();
    })();

    return () => {
      cancelled = true;
    };
  }, [router]);

  return null;
}
