"use client";

// "Sync Gusto now" — ON-DEMAND payroll pull. Payroll is not a continuous job, so the Auto-Pull extension
// no longer keeps an app.gusto.com tab open on the 10-min loop. This button fires the dedicated
// {type:"zoe-gusto-sync"} handshake (same chrome.runtime idiom as ConnectInstaworkButton / PullRoutesButton,
// reusing EXTENSION_ID): the extension opens ONE background Gusto tab, gusto.js pulls once + posts the
// snapshot, and the extension closes that tab. HONEST: it never claims "synced" — the real status comes
// from the import ledger (lastSyncedAt / lastOk, passed from the server). If the extension isn't in this
// browser, or Gusto is signed out, we say so and the status simply won't advance.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { RefreshCw, Loader2 } from "lucide-react";
import { EXTENSION_ID } from "@/lib/extensionId";

const REFRESH_DELAY_MS = 9000; // the pull loops pay per member; give it a moment before we re-read status

interface ChromeRuntimeLike {
  runtime?: {
    sendMessage?: (extensionId: string, message: unknown, callback?: (response: unknown) => void) => void;
    lastError?: { message?: string };
  };
}

function relTime(iso: string | null): string | null {
  if (!iso) return null;
  const d = Date.parse(iso);
  if (!Number.isFinite(d)) return null;
  const m = Math.round((Date.now() - d) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export function SyncGustoButton({
  lastSyncedAt = null,
  lastOk = false,
}: {
  lastSyncedAt?: string | null;
  lastOk?: boolean;
}): React.JSX.Element {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  function sync(): void {
    const chromeApi = (window as unknown as { chrome?: ChromeRuntimeLike }).chrome;
    const hasExtension = !!chromeApi?.runtime && typeof chromeApi.runtime.sendMessage === "function";

    if (!hasExtension) {
      toast.error("Auto-Pull extension not found in this browser", {
        description: "Gusto syncs from the office machine that has the extension and a signed-in Gusto. See Admin, Pull Routes.",
      });
      return;
    }

    setBusy(true);
    toast.loading("Syncing Gusto — opening a tab and pulling the roster + pay rates…", { id: "sync-gusto" });

    let settled = false;
    const done = (): void => {
      if (settled) return;
      settled = true;
      setBusy(false);
    };

    try {
      chromeApi!.runtime!.sendMessage!(EXTENSION_ID, { type: "zoe-gusto-sync" }, (response) => {
        if (chromeApi!.runtime?.lastError) {
          toast.error("Couldn't reach the Auto-Pull extension", {
            id: "sync-gusto",
            description: "Make sure it's installed and enabled in this browser (v1.6.8+).",
          });
          done();
          return;
        }
        void response;
        // The sync is now running in the extension's Gusto tab; give it a moment, then refresh so the real
        // import-ledger status shows. We never assert "synced" — status reflects the actual snapshot.
        setTimeout(() => {
          router.refresh();
          toast.success("Gusto sync started — status updates when the pull lands.", { id: "sync-gusto" });
          done();
        }, REFRESH_DELAY_MS);
      });
    } catch {
      toast.error("Couldn't start the Gusto sync", { id: "sync-gusto" });
      done();
    }
    // Safety: never leave the button spinning if the extension never calls back.
    setTimeout(done, 20000);
  }

  const last = relTime(lastSyncedAt);

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        onClick={sync}
        disabled={busy}
        title="Open Gusto, pull the roster + pay rates once, then close the tab"
        className="inline-flex h-8 items-center justify-center gap-2 rounded-md border border-border px-3 text-[12.5px] font-medium text-secondary-text transition-colors hover:bg-[var(--row-hover)] hover:text-foreground disabled:opacity-60"
      >
        {busy ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
        {busy ? "Syncing…" : "Sync Gusto now"}
      </button>
      <span className="text-[11px] text-meta">
        {last ? (
          <>
            Last pull {last}
            {lastOk ? "" : " · needs attention"}
          </>
        ) : (
          "Never pulled"
        )}
      </span>
    </div>
  );
}
