"use client";

// Office action on the dispatch board: reopen a route that was closed, so its stops become
// actionable again (remove/adjust a stop after a Goodshuffle change). The counterpart to
// CloseRouteButton.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { RotateCcw } from "lucide-react";

export function ReopenRouteButton({ routeId }: { routeId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);

  async function reopen() {
    setBusy(true);
    try {
      const r = await fetch("/api/route/reopen", {
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
      <span className="inline-flex items-center gap-2 text-xs">
        <span className="text-muted-foreground">Reopen this route?</span>
        <button
          onClick={reopen}
          disabled={busy}
          className="bg-foreground px-2.5 py-1 font-medium text-background disabled:opacity-50"
        >
          {busy ? "…" : "Yes, reopen"}
        </button>
        <button
          onClick={() => setConfirming(false)}
          disabled={busy}
          className="border border-white/15 px-2.5 py-1 text-muted-foreground hover:text-foreground"
        >
          Cancel
        </button>
      </span>
    );
  }

  return (
    <button
      onClick={() => setConfirming(true)}
      className="inline-flex items-center gap-1.5 border border-white/15 px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground"
    >
      <RotateCcw className="size-3.5" /> Reopen route
    </button>
  );
}
