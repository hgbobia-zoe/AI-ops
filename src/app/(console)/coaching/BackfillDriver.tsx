"use client";

// Drains the coaching backlog automatically while the owner is on the page — no per-call button.
// Loops the batched /api/coaching/backfill endpoint until it reports done, then refreshes so the
// freshly-analyzed calls flip to "Recap ready". Silent once the backlog is clear.

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";

export function BackfillDriver({ initialRemaining }: { initialRemaining: number }): React.JSX.Element | null {
  const router = useRouter();
  const [remaining, setRemaining] = useState(initialRemaining);
  const [running, setRunning] = useState(initialRemaining > 0);
  const started = useRef(false);

  useEffect(() => {
    if (started.current || initialRemaining <= 0) return;
    started.current = true;
    let cancelled = false;

    (async () => {
      let analyzedAny = false;
      // Loop batches until the endpoint says done.
      for (let i = 0; i < 200 && !cancelled; i++) {
        let res: Response;
        try {
          res = await fetch("/api/coaching/backfill?limit=3", { method: "POST" });
        } catch {
          break;
        }
        if (!res.ok) break;
        const j = (await res.json().catch(() => null)) as { done?: boolean; analyzed?: number; remaining?: number; disabled?: boolean } | null;
        if (!j || j.disabled) break;
        if (typeof j.remaining === "number" && !cancelled) setRemaining(j.remaining);
        if ((j.analyzed ?? 0) > 0) analyzedAny = true;
        if (j.done) break;
      }
      if (!cancelled) {
        setRunning(false);
        if (analyzedAny) router.refresh(); // show the newly-analyzed calls
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [initialRemaining, router]);

  if (!running || remaining <= 0) return null;

  return (
    <div className="surface mb-4 flex items-center gap-2 border border-white/10 p-3 text-sm text-muted-foreground">
      <Loader2 className="size-4 animate-spin" />
      Analyzing calls automatically… {remaining} left. You can keep working; this runs in the background.
    </div>
  );
}
