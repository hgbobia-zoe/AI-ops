"use client";

// One-click "Connect Instawork". APP-SIDE ONLY: Instawork now syncs via BROWSER session replay (like
// Goodshuffle) — the Auto-Pull extension pulls a logged-in app.instawork.com tab and POSTs to
// /api/instawork/import. This button just (1) opens Instawork so the user can log in, then (2) nudges the
// extension's zoe-sync-now handshake (which ensures + pulls the Instawork tab too in v1.5.x), and (3)
// refreshes the view a few seconds later so the real snapshot's status lands. It NEVER claims "connected":
// actual connection still comes from a real snapshot the pull writes. Mirrors PullRoutesButton's
// chrome.runtime feature-detect + lastError / not-found handling, and reuses EXTENSION_ID.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Plug, Loader2 } from "lucide-react";
import { EXTENSION_ID } from "@/lib/extensionId";

const INSTAWORK_URL = "https://app.instawork.com";
const REFRESH_DELAY_MS = 6000;

interface ChromeRuntimeLike {
  runtime?: {
    sendMessage?: (extensionId: string, message: unknown, callback?: (response: unknown) => void) => void;
    lastError?: { message?: string };
  };
}

export function ConnectInstaworkButton({
  variant = "button",
  onSynced,
}: {
  variant?: "button" | "link";
  // When provided (e.g. the Connections dashboard's live /api/health re-fetch), called instead of
  // router.refresh() once the pull has had a moment to land the snapshot.
  onSynced?: () => void;
}): React.JSX.Element {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  function refreshView(): void {
    if (onSynced) onSynced();
    else router.refresh();
  }

  function connect(): void {
    // Step 1: open Instawork so the user can log in. The app can do this directly, no extension needed.
    window.open(INSTAWORK_URL, "_blank", "noopener,noreferrer");

    const chromeApi = (window as unknown as { chrome?: ChromeRuntimeLike }).chrome;
    const hasExtension = !!chromeApi?.runtime && typeof chromeApi.runtime.sendMessage === "function";

    if (!hasExtension) {
      // Extension not in this browser: still opened login, but be honest — don't claim it synced.
      toast.message("Log into Instawork here.", {
        description:
          "If it stays not connected, install/update the Auto-Pull extension (v1.5.1) on the office machine. See Admin, Pull Routes.",
      });
      return;
    }

    // Step 2: nudge the pull. zoe-sync-now ensures + pulls the Instawork tab too (extension v1.5.x).
    setBusy(true);
    toast.loading("Opening Instawork - log in there, then we'll sync it. Give it a minute.", { id: "connect-instawork" });

    let settled = false;
    const done = (): void => {
      if (settled) return;
      settled = true;
      setBusy(false);
    };

    try {
      chromeApi!.runtime!.sendMessage!(EXTENSION_ID, { type: "zoe-sync-now" }, (response) => {
        if (chromeApi!.runtime?.lastError) {
          toast.error("Couldn't reach the Auto-Pull extension", {
            id: "connect-instawork",
            description: "Make sure it's installed and enabled in this browser.",
          });
          done();
          return;
        }
        void response;
        // The pull is now running in the extension's tab; give it a moment, then refresh so the real
        // snapshot status shows. We do NOT assert "connected" — the status reflects the actual snapshot.
        setTimeout(() => {
          refreshView();
          toast.success("Syncing Instawork - the status will update when it lands.", { id: "connect-instawork" });
          done();
        }, REFRESH_DELAY_MS);
      });
    } catch {
      toast.error("Couldn't start the sync", { id: "connect-instawork" });
      done();
    }
    // Safety: never leave the button spinning if the extension never calls back.
    setTimeout(done, 15000);
  }

  if (variant === "link") {
    return (
      <button
        onClick={connect}
        disabled={busy}
        className="inline-flex items-center gap-1 underline underline-offset-2 hover:text-foreground disabled:opacity-50"
      >
        {busy ? <Loader2 className="size-3 animate-spin" /> : <Plug className="size-3" />} Connect Instawork
      </button>
    );
  }

  return (
    <button
      onClick={connect}
      disabled={busy}
      title="Open Instawork to log in, then sync it"
      className="flex items-center gap-1 rounded border border-white/15 px-2 py-1 text-muted-foreground transition-colors hover:bg-white/5 hover:text-foreground disabled:opacity-50"
    >
      {busy ? <Loader2 className="size-3 animate-spin" /> : <Plug className="size-3" />} Connect
    </button>
  );
}
