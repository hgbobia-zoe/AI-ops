"use client";

// Office action on the dispatch board: remove a route that was CANCELLED in Goodshuffle. Distinct from
// Close (which keeps it as a done record) — this deletes the route so it stops showing in Dispatch and
// Scheduling. Needed because the pull can't always prune a cancelled route on its own (if it was the only
// route on its date, that date drops out of the sweep). It will not return unless Goodshuffle still has it.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Trash2 } from "lucide-react";

export function RemoveRouteButton({ routeId }: { routeId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);

  async function remove() {
    setBusy(true);
    try {
      const r = await fetch("/api/route/remove", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ routeId }),
      });
      if (r.ok) router.refresh();
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  }

  if (confirming) {
    return (
      <span className="inline-flex flex-wrap items-center gap-2 text-xs">
        <span className="text-muted-foreground">Remove this cancelled route? It will not come back unless Goodshuffle still has it.</span>
        <button
          onClick={remove}
          disabled={busy}
          className="rounded-md bg-red-500/90 px-2.5 py-1 font-medium text-white disabled:opacity-50"
        >
          {busy ? "…" : "Yes, remove"}
        </button>
        <button
          onClick={() => setConfirming(false)}
          disabled={busy}
          className="rounded-md border border-white/15 px-2.5 py-1 text-muted-foreground hover:text-foreground"
        >
          Cancel
        </button>
      </span>
    );
  }

  return (
    <button
      onClick={() => setConfirming(true)}
      title="Remove a route that was cancelled in Goodshuffle"
      className="inline-flex items-center gap-1.5 rounded-md border border-white/15 px-2.5 py-1 text-xs text-muted-foreground hover:border-red-500/40 hover:text-red-300"
    >
      <Trash2 className="size-3.5" /> Remove route
    </button>
  );
}
