// The Zoe Auto-Pull browser extension's STABLE id (derived from the manifest "key" in
// extension/manifest.json). Pages listed in the extension's externally_connectable (zoe-dispatch.fly.dev)
// can chrome.runtime.sendMessage(EXTENSION_ID, …) to drive a pull on demand. Single source of truth so
// the handshake (ExtensionSync) and the manual "Pull routes" button never drift.
export const EXTENSION_ID = "mpneeiibeccfhenemglnfenogbgmkiep";
