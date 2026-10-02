"use client";

// Dispatch toolbar action: pull routes from Goodshuffle RIGHT NOW, without leaving the board for the
// /admin/pull instructions page. Drives the Zoe Auto-Pull extension (installed in this office browser)
// via the same externally_connectable handshake ExtensionSync uses. The server can't pull Goodshuffle
// (Cloudflare), so this only works in the browser that has the extension + a signed-in Goodshuffle.
//
// The extension TRIGGERS the pull in its Goodshuffle tab and replies immediately; the DB updates a few
// seconds later when the content script finishes, so we refresh the board on a short delay.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { RefreshCw, Loader2 } from "lucide-react";
import { EXTENSION_ID } from "@/lib/extensionId";

interface ChromeRuntimeLike {
  runtime?: {
    sendMessage?: (extensionId: string, message: unknown, callback?: (response: unknown) => void) => void;
    lastError?: { message?: string };
  };
}

export function PullRoutesButton(): React.JSX.Element {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  function pull(): void {
    const chromeApi = (window as unknown as { chrome?: ChromeRuntimeLike }).chrome;
    if (!chromeApi?.runtime || typeof chromeApi.runtime.sendMessage !== "function") {
      toast.error("Auto-Pull extension not found in this browser", {
        description: "Routes pull from the office machine that has the extension and a signed-in Goodshuffle. See Admin → Pull Routes.",
      });
      return;
    }
    setBusy(true);
    toast.loading("Pulling routes from Goodshuffle…", { id: "pull-routes" });

    let settled = false;
    const done = (): void => {
      if (settled) return;
      settled = true;
      setBusy(false);
    };

    try {
      chromeApi.runtime.sendMessage(EXTENSION_ID, { type: "zoe-sync-now" }, (response) => {
        if (chromeApi.runtime?.lastError) {
          toast.error("Couldn't reach the Auto-Pull extension", {
            id: "pull-routes",
            description: "Make sure it's installed and enabled in this browser.",
          });
          done();
          return;
        }
        const r = response as { ok?: boolean; last?: { status?: string } } | undefined;
        if (r?.last?.status === "not_logged_in") {
          toast.warning("Sign in to Goodshuffle", {
            id: "pull-routes",
            description: "A Goodshuffle login tab was opened. Sign in, then pull again.",
          });
          done();
          return;
        }
        // Pull is now running in the extension's Goodshuffle tab; give it a few seconds, then adopt.
        toast.loading("Syncing — this takes a few seconds…", { id: "pull-routes" });
        setTimeout(() => {
          router.refresh();
          toast.success("Dispatch refreshed from Goodshuffle", { id: "pull-routes" });
          done();
        }, 4500);
      });
    } catch {
      toast.error("Couldn't start the pull", { id: "pull-routes" });
      done();
    }
    // Safety: if the extension never calls back, don't leave the button spinning forever.
    setTimeout(done, 15000);
  }

  return (
    <button
      onClick={pull}
      disabled={busy}
      title="Pull the latest routes from Goodshuffle now"
      className="inline-flex items-center gap-1.5 rounded border border-border px-3 py-1.5 text-[12.5px] text-tertiary-text transition-colors hover:bg-[var(--row-hover)] hover:text-foreground disabled:opacity-50 disabled:pointer-events-none"
    >
      {busy ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />} Pull routes
    </button>
  );
}
