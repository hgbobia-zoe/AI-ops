// The Zoe Auto-Pull browser extension's id. The STORE build (published UNLISTED to the Chrome Web Store) is
// uploaded WITHOUT a manifest "key", so the store owns the id. Pages listed in the extension's
// externally_connectable (zoe-dispatch.fly.dev) call chrome.runtime.sendMessage(EXTENSION_ID, …) to drive a
// pull or the Gusto push on demand. Single source of truth so the handshake (ExtensionSync) and the manual
// "Pull routes" / "Sync Gusto" / "Push hours" buttons never drift.
//
// CUTOVER NOTE: the old UNPACKED build's key-derived id was "mpneeiibeccfhenemglnfenogbgmkiep". Switch to the
// store id below ONLY once the store version is installed on the office machine AND the user's Chrome (and the
// unpacked copy removed) — otherwise the app would message an extension that isn't there and the on-demand
// buttons would silently miss.
export const EXTENSION_ID = "amjnclgiidnijgedjhhfbcflofnmicbj";
