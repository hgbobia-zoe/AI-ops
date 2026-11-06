// The Zoe Auto-Pull browser extension's id. The STORE build (published UNLISTED to the Chrome Web Store) is
// uploaded WITHOUT a manifest "key", so the store owns the id. Pages listed in the extension's
// externally_connectable (zoe-dispatch.fly.dev) call chrome.runtime.sendMessage(EXTENSION_ID, …) to drive a
// pull or the Gusto push on demand. Single source of truth so the handshake (ExtensionSync) and the manual
// "Pull routes" / "Sync Gusto" / "Run payroll" buttons never drift.
//
// The "Load unpacked" copy (C:\Git\zoe-autopull-extension, from `npm run drop:extension`) keeps the OLD key,
// so it installs as LEGACY_UNPACKED_EXTENSION_ID. Use sendToExtension() to reach whichever one is installed:
// it tries the store id first and falls back to the unpacked id.
export const EXTENSION_ID = "amjnclgiidnijgedjhhfbcflofnmicbj";
export const LEGACY_UNPACKED_EXTENSION_ID = "mpneeiibeccfhenemglnfenogbgmkiep";
export const EXTENSION_IDS: readonly string[] = [EXTENSION_ID, LEGACY_UNPACKED_EXTENSION_ID];

interface ChromeRuntimeLike {
  runtime?: {
    sendMessage?: (extensionId: string, message: unknown, callback?: (response: unknown) => void) => void;
    lastError?: { message?: string };
  };
}

/** True when this page can message extensions at all (Chrome, with at least one externally connectable). */
export function canMessageExtension(): boolean {
  const c = (globalThis as unknown as { chrome?: ChromeRuntimeLike }).chrome;
  return !!c?.runtime && typeof c.runtime.sendMessage === "function";
}

/** Send a message to the installed Auto-Pull extension, store build first, then the unpacked build.
 *  Resolves { ok: false } when neither answers (not installed, disabled, or not Chrome). */
export function sendToExtension(message: unknown): Promise<{ ok: true; response: unknown; id: string } | { ok: false }> {
  const c = (globalThis as unknown as { chrome?: ChromeRuntimeLike }).chrome;
  if (!c?.runtime || typeof c.runtime.sendMessage !== "function") return Promise.resolve({ ok: false });
  const tryAt = (i: number): Promise<{ ok: true; response: unknown; id: string } | { ok: false }> =>
    new Promise((resolve) => {
      const id = EXTENSION_IDS[i];
      if (!id) return resolve({ ok: false });
      try {
        c.runtime!.sendMessage!(id, message, (response) => {
          if (c.runtime?.lastError) return resolve(tryAt(i + 1));
          resolve({ ok: true, response, id });
        });
      } catch {
        resolve(tryAt(i + 1));
      }
    });
  return tryAt(0);
}
