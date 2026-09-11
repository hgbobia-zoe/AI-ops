"use client";

// Auto-analyzes the open call — no button. On mount it asks the server to build the recap for this
// call, shows an "Analyzing…" state, then refreshes so the summary/coaching/objections fill in.

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";

export function AutoAnalyze({ callId }: { callId: string }): React.JSX.Element {
  const router = useRouter();
  const [state, setState] = useState<"analyzing" | "failed">("analyzing");
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    (async () => {
      try {
        const res = await fetch("/api/coaching/analyze", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ callId }),
        });
        const j = (await res.json().catch(() => null)) as { ok?: boolean } | null;
        if (j?.ok) router.refresh();
        else setState("failed");
      } catch {
        setState("failed");
      }
    })();
  }, [callId, router]);

  if (state === "failed") return <span className="text-xs text-muted-foreground">Couldn&apos;t generate a recap for this call.</span>;
  return (
    <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
      <Loader2 className="size-4 animate-spin" /> Analyzing…
    </span>
  );
}
