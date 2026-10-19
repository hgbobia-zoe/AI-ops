// Fire-and-forget nudges to the Zoe Auto-Pull browser extension from an app page. The server CANNOT push
// to the extension (and can't call Goodshuffle at all — Cloudflare blocks it), so "on demand" means: when
// the operator does something in the app that just queued a Goodshuffle write, poke the extension in THIS
// browser to drain it now instead of waiting for its background alarm.
//
// Only works in the office-machine Chrome that actually has the extension installed (externally_connectable
// is declared for this origin). Everywhere else — a salesperson's phone, Safari, an extension-less Chrome —
// this silently no-ops, and the extension's own alarm picks the work up on its next cycle. Never throws.

import { EXTENSION_ID } from "@/lib/extensionId";

interface ChromeRuntimeLike {
  runtime?: {
    sendMessage?: (extensionId: string, message: unknown, callback?: (response: unknown) => void) => void;
    lastError?: { message?: string };
  };
}

/** Ask the extension to drain any pending create_project ops NOW (used right after a guided-intake submit).
 *  Best-effort: resolves true only if the extension answered. Resolves false when it's absent / not Chrome. */
export function nudgeCreateNow(): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const chromeApi = (window as unknown as { chrome?: ChromeRuntimeLike }).chrome;
      if (!chromeApi?.runtime || typeof chromeApi.runtime.sendMessage !== "function") {
        resolve(false);
        return;
      }
      let settled = false;
      const finish = (v: boolean): void => {
        if (settled) return;
        settled = true;
        resolve(v);
      };
      chromeApi.runtime.sendMessage(EXTENSION_ID, { type: "zoe-create-now" }, (resp) => {
        // Swallow "Could not establish connection" (extension absent) — no console noise, no UI.
        void chromeApi.runtime?.lastError;
        finish(Boolean(resp && (resp as { ok?: boolean }).ok));
      });
      // The callback never fires when the extension isn't installed; don't hang the caller.
      setTimeout(() => finish(false), 1500);
    } catch {
      resolve(false);
    }
  });
}
