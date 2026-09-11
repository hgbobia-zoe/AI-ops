"use client";

// Drives the batched historical-call import while the Coaching blade is open, and shows a subtle
// progress bar. It resumes across sessions (the cursor lives server-side), refreshing periodically so
// imported calls appear in the list as they land. Stops when the crawl is done.

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";

export function HistoryImporter(): React.JSX.Element | null {
  const router = useRouter();
  const [state, setState] = useState<{ running: boolean; imported: number; checked: number; total: number }>({ running: true, imported: 0, checked: 0, total: 0 });
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    let cancelled = false;
    let imported = 0;
    let lastRefresh = Date.now();

    (async () => {
      for (let i = 0; i < 6000 && !cancelled; i++) {
        let res: Response;
        try {
          res = await fetch("/api/coaching/import-history", { method: "POST" });
        } catch {
          break;
        }
        if (!res.ok) break;
        const j = (await res.json().catch(() => null)) as { done?: boolean; imported?: number; checked?: number; total?: number } | null;
        if (!j) break;
        imported += j.imported ?? 0;
        if (!cancelled) setState({ running: !j.done, imported, checked: j.checked ?? 0, total: j.total ?? 0 });
        // Show newly-imported calls periodically, and once at the end.
        if ((j.imported ?? 0) > 0 && Date.now() - lastRefresh > 12000) {
          lastRefresh = Date.now();
          router.refresh();
        }
        if (j.done) {
          if (imported > 0) router.refresh();
          break;
        }
      }
      if (!cancelled) setState((s) => ({ ...s, running: false }));
    })();

    return () => {
      cancelled = true;
    };
  }, [router]);

  if (!state.running) return null;
  return (
    <div className="surface flex items-center gap-2 border-b border-white/10 px-4 py-2 text-xs text-muted-foreground">
      <Loader2 className="size-3.5 shrink-0 animate-spin" />
      Importing past calls…{state.imported > 0 ? ` ${state.imported} added` : ""}
      {state.total > 0 ? ` · scanning ${state.checked}/${state.total} leads` : ""}
    </div>
  );
}
