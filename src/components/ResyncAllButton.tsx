"use client";

// Dispatch header action: force EVERY route for the viewed day to match Goodshuffle's CURRENT order —
// the global counterpart to the per-route ResyncRouteButton. A normal "Pull routes" protects in-progress
// stops and does NOT reorder them, so a force re-sync is a distinct, needed action (it can change a driver's
// current stop). It arms a one-shot server-side flag for every routeId (/api/route/resync { routeIds }),
// then triggers the Auto-Pull extension ONCE (same handshake as "Pull routes") so the browser pull POSTs
// the routes back through /api/route/import, which consumes each flag and force-applies.

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

export function ResyncAllButton({ routeIds }: { routeIds: string[] }): React.JSX.Element | null {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);

  // No routes to re-sync — nothing to render.
  if (routeIds.length === 0) return null;

  async function resyncAll(): Promise<void> {
    setBusy(true);
    try {
      // 1) Arm the one-shot force flag for every route. The next pull applies Goodshuffle's exact order.
      const r = await fetch("/api/route/resync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ routeIds }),
      });
      if (!r.ok) {
        toast.error("Couldn't arm the re-sync. Try again.");
        return;
      }

      // 2) Trigger the pull via the Auto-Pull extension in this office browser. The pull POSTs the routes
      //    to /api/route/import, which consumes each flag and force-applies the Goodshuffle order.
      const chromeApi = (window as unknown as { chrome?: ChromeRuntimeLike }).chrome;
      if (!chromeApi?.runtime || typeof chromeApi.runtime.sendMessage !== "function") {
        toast.warning("Re-sync armed. Run the pull from the office machine.", {
          description: "This browser has no Auto-Pull extension. Open the office machine (Admin, Pull Routes) to apply the Goodshuffle order.",
        });
        return;
      }

      toast.loading("Re-syncing all routes from Goodshuffle…", { id: "resync-all" });
      chromeApi.runtime.sendMessage(EXTENSION_ID, { type: "zoe-sync-now" }, (response) => {
        if (chromeApi.runtime?.lastError) {
          toast.error("Couldn't reach the Auto-Pull extension", {
            id: "resync-all",
            description: "Re-sync is armed. Run the pull from the office machine to apply it.",
          });
          return;
        }
        const resp = response as { last?: { status?: string } } | undefined;
        if (resp?.last?.status === "not_logged_in") {
          toast.warning("Sign in to Goodshuffle", {
            id: "resync-all",
            description: "A Goodshuffle login tab was opened. Sign in, then re-sync again.",
          });
          return;
        }
        // Pull is running in the extension's Goodshuffle tab; give it a few seconds, then refresh.
        setTimeout(() => {
          router.refresh();
          toast.success("All routes re-synced to Goodshuffle's order", { id: "resync-all" });
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
        <span className="text-muted-foreground">Apply Goodshuffle&apos;s current order to ALL routes? This can change drivers&apos; current stops.</span>
        <button
          onClick={resyncAll}
          disabled={busy}
          className="rounded-md bg-foreground px-2.5 py-1 font-medium text-background disabled:opacity-50"
        >
          {busy ? "…" : "Yes, re-sync all"}
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
      title="Force every route for this day to match Goodshuffle's current order"
      className="inline-flex items-center gap-1.5 rounded border border-border px-3 py-1.5 text-[12.5px] text-tertiary-text transition-colors hover:bg-[var(--row-hover)] hover:text-foreground disabled:opacity-50 disabled:pointer-events-none"
    >
      <RotateCcw className="size-3.5" /> Re-sync all from Goodshuffle
    </button>
  );
}
