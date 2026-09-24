"use client";

// Platform → extension handshake. When the operator loads the console and the Goodshuffle pull looks
// stale/unhealthy, nudge the Zoe Auto-Pull browser extension (if installed in THIS browser) to sync
// right now using the user's own Goodshuffle session — and, if GS is signed out, the extension opens a
// login tab. Unobtrusive and honest: if the extension isn't installed (or this isn't Chrome), nothing
// happens. Fires at most once per tab session, which approximates "right after login" without nagging.
//
// The message goes to the extension's STABLE id (derived from the manifest "key" in
// extension/manifest.json); the extension declares externally_connectable for this origin.

import { useEffect } from "react";

const EXTENSION_ID = "mpneeiibeccfhenemglnfenogbgmkiep";

interface ChromeRuntimeLike {
  runtime?: {
    sendMessage?: (extensionId: string, message: unknown, callback?: (response: unknown) => void) => void;
    lastError?: { message?: string };
  };
}

export function ExtensionSync({ stale }: { stale: boolean }): null {
  useEffect(() => {
    if (!stale) return;
    try {
      if (sessionStorage.getItem("zoeSyncNudged") === "1") return;
      sessionStorage.setItem("zoeSyncNudged", "1");
    } catch {
      /* private mode / blocked storage — proceed this once */
    }
    const chromeApi = (window as unknown as { chrome?: ChromeRuntimeLike }).chrome;
    if (!chromeApi?.runtime || typeof chromeApi.runtime.sendMessage !== "function") return; // not installed / not Chrome
    try {
      chromeApi.runtime.sendMessage(EXTENSION_ID, { type: "zoe-sync-now" }, () => {
        // Swallow "Could not establish connection" (extension absent) — no console noise, no UI.
        void chromeApi.runtime?.lastError;
      });
    } catch {
      /* no-op */
    }
  }, [stale]);

  return null;
}
