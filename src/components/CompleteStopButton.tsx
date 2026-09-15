"use client";

// Desktop supervisor action: force a stuck stop to Completed (tablet down / stop stuck). Confirms
// first — it's a manual override that skips the field flow (no customer SMS). Owner/admin only.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2 } from "lucide-react";

export function CompleteStopButton({ stopId, custName }: { stopId: string; custName: string }): React.JSX.Element {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function complete() {
    if (!window.confirm(`Mark "${custName || "this stop"}" complete? This overrides the tablet — use it when a stop is stuck.`)) return;
    setBusy(true);
    try {
      await fetch("/api/route/stop/complete", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ stopId }) });
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      onClick={complete}
      disabled={busy}
      title="Force complete (tablet stuck)"
      className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-[11px] text-meta transition-colors hover:bg-[var(--row-hover)] hover:text-foreground disabled:opacity-50"
    >
      <CheckCircle2 className="size-3" /> {busy ? "…" : "Complete"}
    </button>
  );
}
