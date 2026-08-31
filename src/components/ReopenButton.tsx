"use client";

// Supervisor action on the dispatch dashboard: reopen a completed stop. This is the
// guarded REOPEN transition (admin-only), which the intake enforces server-side.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { RotateCcw } from "lucide-react";

export function ReopenButton({
  truckId,
  routeId,
  stopId,
}: {
  truckId: string;
  routeId: string;
  stopId: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function reopen() {
    setBusy(true);
    try {
      await fetch("/api/action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          idempotencyKey: crypto.randomUUID(),
          truckId,
          routeId,
          stopId,
          action: "REOPEN",
          fromState: "Completed",
          clientTs: new Date().toISOString(),
          context: { isAdmin: true },
        }),
      });
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      onClick={reopen}
      disabled={busy}
      className="inline-flex items-center gap-1 rounded-md border border-white/15 px-2 py-1 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
    >
      <RotateCcw className="size-3" />
      {busy ? "…" : "Reopen"}
    </button>
  );
}
