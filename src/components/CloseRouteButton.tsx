"use client";

// Office action on the dispatch board: force-close a truck's route. For when the
// driver couldn't finish it on the tablet (dead battery / tablet down). Closing marks
// the route done — it clears the active board and the truck can load today's route fresh.
// Stops still not completed must each get a choice first (mark completed now, or a reason),
// which is recorded on the stop and shown on the board.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { CircleX, Check } from "lucide-react";
import { IncompleteStopsResolver, type IncompleteStopRef } from "@/components/IncompleteStopsResolver";
import { unresolvedStops, type CloseResolutionInput } from "@/lib/dispatch/onTime";

export function CloseRouteButton({ routeId, incompleteStops = [] }: { routeId: string; incompleteStops?: IncompleteStopRef[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [done, setDone] = useState(false);
  const [resolutions, setResolutions] = useState<CloseResolutionInput[]>([]);
  const missing = unresolvedStops(incompleteStops.map((s) => s.stopId), resolutions);

  async function close() {
    if (missing.length > 0) return;
    setBusy(true);
    try {
      const r = await fetch("/api/route/close", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ routeId, stopResolutions: resolutions }),
      });
      if (r.ok) {
        // Show closed immediately so there's no "did it work?" gap while the board
        // re-renders; router.refresh() then syncs the rest of the card.
        setDone(true);
        router.refresh();
      }
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  }

  if (done) {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <Check className="size-3.5" /> Route closed
      </span>
    );
  }

  if (confirming) {
    return (
      <span className="inline-flex w-full flex-col gap-2 text-xs">
        <IncompleteStopsResolver stops={incompleteStops} value={resolutions} onChange={setResolutions} size="sm" />
        <span className="inline-flex items-center gap-2">
          <span className="text-muted-foreground">
            {missing.length > 0 ? `${missing.length} stop${missing.length === 1 ? "" : "s"} still need a choice.` : "Close this route?"}
          </span>
          <button
            onClick={close}
            disabled={busy || missing.length > 0}
            className="rounded-md bg-foreground px-2.5 py-1 font-medium text-background disabled:opacity-50"
          >
            {busy ? "…" : "Yes, close"}
          </button>
          <button
            onClick={() => setConfirming(false)}
            disabled={busy}
            className="rounded-md border border-white/15 px-2.5 py-1 text-muted-foreground hover:text-foreground"
          >
            Cancel
          </button>
        </span>
      </span>
    );
  }

  return (
    <button
      onClick={() => setConfirming(true)}
      className="inline-flex items-center gap-1.5 rounded-md border border-white/15 px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground"
    >
      <CircleX className="size-3.5" /> Close route
    </button>
  );
}
