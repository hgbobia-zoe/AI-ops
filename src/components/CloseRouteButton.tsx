"use client";

// Office action on the dispatch board: force-close a truck's route. For when the
// driver couldn't finish it on the tablet (dead battery / tablet down). Closing marks
// the route done — it clears the active board and the truck can load today's route fresh.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { CircleX, Check } from "lucide-react";

export function CloseRouteButton({ routeId }: { routeId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [done, setDone] = useState(false);

  async function close() {
    setBusy(true);
    try {
      const r = await fetch("/api/route/close", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ routeId }),
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
      <span className="inline-flex items-center gap-2 text-xs">
        <span className="text-muted-foreground">Close this route?</span>
        <button
          onClick={close}
          disabled={busy}
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
