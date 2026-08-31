// Signals + bridge exposed to the Zoe Dispatch web app running inside the kiosk shell.
//
// __ZOE_KIOSK_WEBVIEW__ / __ZOE_KIOSK_EMBED__ tell the app to render Goodshuffle as an
// Electron <webview> (first-party → login works and persists), in-pane.
//
// window.ZoeKiosk mirrors the Android JS bridge so the same web code paths (route
// import, ETA links, update check) work on the desktop for testing. Unlike Android —
// which resolves asynchronously via window.__zoeKioskResolve — the Electron bridge
// returns a Promise directly (the web client in src/lib/kioskBridge.ts handles both).
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("__ZOE_KIOSK_EMBED__", true);
contextBridge.exposeInMainWorld("__ZOE_KIOSK_WEBVIEW__", true);

contextBridge.exposeInMainWorld("ZoeKiosk", {
  ping: () => "zoe-electron-ok",
  // requestId is unused here — the Promise return carries the result.
  importGoodshuffleRoute: (_requestId, truckId) =>
    ipcRenderer.invoke("zoe:importRoute", truckId),
  createEtaLink: (_requestId, paramsJson) =>
    ipcRenderer.invoke("zoe:createEtaLink", paramsJson),
  checkForUpdate: (_requestId) => ipcRenderer.invoke("zoe:checkForUpdate"),
});
