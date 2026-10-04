"use client";

// Office action on the dispatch board: force a route to match Goodshuffle's CURRENT order, even for an
// in-progress route. Distinct from a normal pull (which protects in-progress stops): this applies the
// Goodshuffle order and can change the driver's current stop. It arms a one-shot server-side flag
// (/api/route/resync), then triggers the Auto-Pull extension (same handshake as "Pull routes") so the
// browser pull POSTs this route back through /api/route/import, which consumes the flag and force-applies.
// No extension change or reload is needed.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { RotateCcw } from "lucide-react";
import { EXTENSION_ID } from "@/lib/extensionId";

interface ChromeRuntimeLike {
  runtime?: {
    sendMessage?: (extensionId: string, message: unknown, callback?: (response: unknown) => void) => void;
    lastError?: { message?: string };
  };
}

export function ResyncRouteButton({ routeId }: { routeId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);

  async function resync() {
    setBusy(true);
    try {
      // 1) Arm the one-shot force flag for this route. The next pull applies Goodshuffle's exact order.
      const r = await fetch("/api/route/resync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ routeId }),
      });
      if (!r.ok) {
        toast.error("Couldn't arm the re-sync. Try again.");
        return;
      }

      // 2) Trigger the pull via the Auto-Pull extension in this office browser. The pull POSTs this route
      //    to /api/route/import, which consumes the flag and force-applies the Goodshuffle order.
      const chromeApi = (window as unknown as { chrome?: ChromeRuntimeLike }).chrome;
      if (!chromeApi?.runtime || typeof chromeApi.runtime.sendMessage !== "function") {
        toast.warning("Re-sync armed. Run the pull from the office machine.", {
          description: "This browser has no Auto-Pull extension. Open the office machine (Admin, Pull Routes) to apply the Goodshuffle order.",
        });
        return;
      }

      toast.loading("Re-syncing from Goodshuffle…", { id: "resync-route" });
      chromeApi.runtime.sendMessage(EXTENSION_ID, { type: "zoe-sync-now" }, (response) => {
        if (chromeApi.runtime?.lastError) {
          toast.error("Couldn't reach the Auto-Pull extension", {
            id: "resync-route",
            description: "Re-sync is armed. Run the pull from the office machine to apply it.",
          });
          return;
        }
        const resp = response as { last?: { status?: string } } | undefined;
        if (resp?.last?.status === "not_logged_in") {
          toast.warning("Sign in to Goodshuffle", {
            id: "resync-route",
            description: "A Goodshuffle login tab was opened. Sign in, then re-sync again.",
          });
          return;
        }
        // Pull is running in the extension's Goodshuffle tab; give it a few seconds, then refresh.
        setTimeout(() => {
          router.refresh();
          toast.success("Route re-synced to Goodshuffle's order", { id: "resync-route" });
        }, 5000);
      });
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  }

  if (confirming) {
    return (
      <span className="inline-flex flex-wrap items-center gap-2 text-xs">
        <span className="text-muted-foreground">Apply Goodshuffle&apos;s current order to this route? This can change the driver&apos;s current stop.</span>
        <button
          onClick={resync}
          disabled={busy}
          className="rounded-md bg-foreground px-2.5 py-1 font-medium text-background disabled:opacity-50"
        >
          {busy ? "…" : "Yes, re-sync"}
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
      title="Force this route to match Goodshuffle's current order"
      className="inline-flex items-center gap-1.5 rounded-md border border-white/15 px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground"
    >
      <RotateCcw className="size-3.5" /> Re-sync from Goodshuffle
    </button>
  );
}
