"use client";

// Office action on the dispatch board: pull a stop OFF a route. This is the two-way
// bridge to Goodshuffle — it removes the stop from our board and, when the stop came
// from a Goodshuffle pull (so we have its waypoint + route ids), queues a Goodshuffle
// removal that a logged-in session replays, dropping the waypoint from the GS route too.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { X } from "lucide-react";

export function RemoveStopButton({
  routeId,
  stopId,
  custName,
  gsLinked,
}: {
  routeId: string;
  stopId: string;
  custName: string;
  gsLinked: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function remove() {
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch("/api/route/stop/remove", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ routeId, stopId }),
      });
      if (r.ok) {
        router.refresh();
      } else {
        const j = (await r.json().catch(() => ({}))) as { error?: string };
        setErr(j.error ?? "Failed");
      }
    } catch {
      setErr("Network error");
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  }

  if (confirming) {
    return (
      <span className="inline-flex flex-wrap items-center justify-end gap-1.5 text-xs">
        <span className="text-muted-foreground">
          Pull {custName || "this stop"}?{" "}
          {gsLinked ? "Also removes it from the Goodshuffle route." : "(local only — not linked to Goodshuffle)"}
        </span>
        <button
          onClick={remove}
          disabled={busy}
          className="bg-red-500/90 px-2 py-0.5 font-medium text-white disabled:opacity-50"
        >
          {busy ? "…" : "Yes, pull"}
        </button>
        <button
          onClick={() => setConfirming(false)}
          disabled={busy}
          className="border border-white/15 px-2 py-0.5 text-muted-foreground hover:text-foreground"
        >
          Cancel
        </button>
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-1.5">
      {err && <span className="text-[11px] text-red-400">{err}</span>}
      <button
        onClick={() => setConfirming(true)}
        title="Pull this stop from the route (and Goodshuffle)"
        className="inline-flex items-center gap-1 border border-white/10 px-1.5 py-0.5 text-[11px] text-muted-foreground hover:border-red-500/40 hover:text-red-300"
      >
        <X className="size-3" /> Pull
      </button>
    </span>
  );
}
