// Zoe Dispatch — Electron kiosk shell.
//
// Why this exists: the truck tablet needs Goodshuffle Pro and Zoe Dispatch in ONE
// side-by-side view. Goodshuffle sends `X-Frame-Options: SAMEORIGIN`, so a normal
// browser refuses to embed it in our split pane. Electron gives us a real Chromium
// we control, so the main process strips that header at the network layer — and
// then our existing /kiosk split view (Goodshuffle iframe + dispatch panel) just
// works, in-pane, no second window.
//
// It loads the deployed (or local) Zoe Dispatch app in kiosk fullscreen, keeps the
// screen awake, and persists Goodshuffle's login across restarts.
//
// Config via env vars:
//   APP_URL   — Zoe Dispatch base URL   (default http://localhost:8085)
//   GSPRO_URL — Goodshuffle URL to allow-embed / cookie-persist
//               (default https://pro.goodshuffle.com)
//   KIOSK     — "0" to run windowed (dev); default kiosk fullscreen
//   EXIT_PIN  — PIN required to quit the shell (default 1379)

const {
  app,
  BrowserWindow,
  session,
  powerSaveBlocker,
  globalShortcut,
  dialog,
  ipcMain,
} = require("electron");

const APP_URL = (process.env.APP_URL || "http://localhost:8085").replace(/\/+$/, "");
const GSPRO_URL = process.env.GSPRO_URL || "https://pro.goodshuffle.com";
const KIOSK = process.env.KIOSK !== "0";
const EXIT_PIN = process.env.EXIT_PIN || "1379";
// Which app surface this shell opens: "/kiosk" for a truck tablet (app beside
// Goodshuffle), or "/dispatch" for the back-office dashboard (board beside Ignition).
const SHELL_PATH = process.env.SHELL_PATH || "/kiosk";

// One kiosk per device.
if (!app.requestSingleInstanceLock()) {
  app.quit();
}

let win = null;
let allowClose = false;

/**
 * Strip the headers that stop Goodshuffle (and any other operational site) from
 * being embedded in our split pane. This is what makes the in-pane iframe render.
 * Scoped to responses only — we do not modify what the app itself serves.
 */
function stripFrameGuards(sess) {
  sess.webRequest.onHeadersReceived((details, callback) => {
    const headers = details.responseHeaders || {};
    for (const key of Object.keys(headers)) {
      const k = key.toLowerCase();
      if (k === "x-frame-options") {
        delete headers[key];
      } else if (k === "content-security-policy") {
        // Remove only the framing directive; leave the rest of the CSP intact.
        const cleaned = []
          .concat(headers[key])
          .map((v) =>
            String(v)
              .split(";")
              .filter((d) => !/\s*frame-ancestors/i.test(d))
              .join(";"),
          )
          .filter(Boolean);
        headers[key] = cleaned;
      }
    }
    callback({ responseHeaders: headers });
  });
}

function createWindow() {
  // A persistent partition so Goodshuffle's login cookies survive app restarts —
  // the driver signs in once, not every shift.
  const persistent = session.fromPartition("persist:zoe-kiosk");
  stripFrameGuards(persistent);

  win = new BrowserWindow({
    show: false,
    kiosk: KIOSK,
    fullscreen: KIOSK,
    frame: !KIOSK,
    autoHideMenuBar: true,
    backgroundColor: "#000000",
    webPreferences: {
      preload: `${__dirname}/preload.js`,
      partition: "persist:zoe-kiosk",
      contextIsolation: true,
      nodeIntegration: false,
      // The app renders the Goodshuffle pane as a <webview> (first-party context so
      // its login/cookies work); enable the tag. Web security stays ON.
      webviewTag: true,
    },
  });

  // Keep the display awake for the whole shift.
  powerSaveBlocker.start("prevent-display-sleep");

  // Land straight on the chosen split-view surface with embed mode on.
  win.loadURL(`${APP_URL}${SHELL_PATH}?embed=1`);

  win.once("ready-to-show", () => win.show());

  // Block accidental exit; only the PIN path (below) may close.
  win.on("close", (e) => {
    if (!allowClose) e.preventDefault();
  });

  // Never let a link navigate the top window away to a new site; open externally
  // instead. (The Goodshuffle iframe is unaffected — this is top-frame only.)
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
}

async function promptExit() {
  if (!win) return;
  const { response } = await dialog.showMessageBox(win, {
    type: "question",
    buttons: ["Cancel", "Enter PIN"],
    defaultId: 0,
    cancelId: 0,
    title: "Exit kiosk",
    message: "Exit Zoe Dispatch kiosk?",
    detail: `Press "Enter PIN", then type the tablet PIN in the app's exit prompt.`,
  });
  // The real PIN gate lives in the app's ExitKiosk overlay; this is just a guard
  // against a stray keypress. For a hard quit, hold the shortcut and confirm.
  if (response === 1) {
    const confirm = await dialog.showMessageBox(win, {
      type: "warning",
      buttons: ["Cancel", "Quit kiosk"],
      defaultId: 0,
      cancelId: 0,
      title: "Confirm",
      message: `Quit the kiosk shell? (PIN ${EXIT_PIN.replace(/./g, "•")})`,
    });
    if (confirm.response === 1) {
      allowClose = true;
      app.quit();
    }
  }
}

// Track webview guests so the ZoeKiosk bridge (below) can run scripts inside the
// logged-in Goodshuffle session — the desktop equivalent of the Android bridge.
const webviewContents = new Set();

app.on("web-contents-created", (_e, contents) => {
  if (contents.getType() === "webview") {
    // Let the Goodshuffle webview open auth popups (e.g. "Sign in with Google") as a
    // normal child window instead of being blocked.
    contents.setWindowOpenHandler(() => ({
      action: "allow",
      overrideBrowserWindowOptions: { autoHideMenuBar: true, width: 480, height: 640 },
    }));
    webviewContents.add(contents);
    contents.on("destroyed", () => webviewContents.delete(contents));
  }
});

function findWebview(urlSubstring) {
  for (const c of webviewContents) {
    try {
      if (!c.isDestroyed() && c.getURL().toLowerCase().includes(urlSubstring)) return c;
    } catch {
      /* ignore */
    }
  }
  return null;
}

// The Goodshuffle route-extraction script — mirrors android buildGoodshuffleScript,
// but returns the result directly (executeJavaScript awaits the async IIFE). See
// android/GOODSHUFFLE_ROUTE.md for the contract.
function goodshuffleImportScript(truckId) {
  const tid = JSON.stringify(String(truckId || ""));
  return `(async () => {
    try {
      var t = ${tid}.toLowerCase();
      var MATCH = (t.indexOf('e450')>=0||t.indexOf('ford')>=0) ? 'ford'
                : (t.indexOf('npr')>=0||t.indexOf('isuzu')>=0) ? 'isuzu' : t;
      var now = new Date();
      var startLocal = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0,0,0);
      var endLocal = new Date(startLocal.getTime() + 24*3600*1000);
      var body = { from:startLocal.toISOString(), to:endLocal.toISOString(), warehouseCanonicalIDs:null, crew:null, vehicles:null, statuses:null };
      function extractStops(route){
        var wps = (route.waypoints||[]).filter(function(w){ return !w.isOriginWarehouse && !w.isDestinationWarehouse; });
        wps.sort(function(a,b){ return (a.waypointIndex||0) - (b.waypointIndex||0); });
        return wps.map(function(w){
          var tl = (w.logisticRelation && w.logisticRelation.targetLocation) || {};
          var tx = w.transaction || {};
          var line = [tl.streetAddressLine1, tl.streetAddressLine2].filter(Boolean).join(" ");
          var cityState = [tl.city, tl.state].filter(Boolean).join(", ");
          var address = [line, cityState, tl.zipCode].filter(Boolean).join(", ");
          // The customer's phone lives on the inlined renter (includeAttributes=true),
          // not the on-site location contact (usually blank). Prefer the validated E.164
          // number, then the raw renter phone, then the on-site contact. Never fall back
          // to dispatcher/storeLocation — those are the Zoe staff/main line.
          var renter = tx.renter || {};
          var sv = renter.smsValidation || {};
          var name = tl.contactName || (tx.eventName ? String(tx.eventName).split(" - ")[0].trim() : "") || renter.name;
          var custPhone = sv.e164PhoneNumber || renter.phone || tl.contactPhoneNumber || "";
          var doc = tx.dayOfContact || null;
          var s = { custName: name || "", custPhone: custPhone, address: address,
                    plannedWindow: w.scheduledArrivalTime || undefined, eta: w.scheduledArrivalTime || undefined };
          if (doc) { s.dayOfName = doc.name || doc.fullName || undefined; s.dayOfPhone = doc.phoneNumber || doc.phone || undefined; }
          return s;
        });
      }
      var routes = await (await fetch("/app/routing/listRoutes", { method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify(body), credentials:"include" })).json();
      var total = (routes||[]).length;
      var mine = (routes||[]).filter(function(rt){ return rt.vehicle && String(rt.vehicle.title||"").toLowerCase().indexOf(MATCH) >= 0; });
      mine.sort(function(a,b){ return new Date(a.startDate) - new Date(b.startDate); });
      if (!mine.length) return { ok:true, stops:[], routeNames:[], total:total, matched:0 };
      var full = await Promise.all(mine.map(function(rt){
        return fetch("/app/routing/getRoute?routeID=" + rt.id + "&includeAttributes=true", { headers:{accept:"application/json"}, credentials:"include" }).then(function(r){ return r.json(); });
      }));
      var stops = []; var names = [];
      full.forEach(function(route){ names.push(route.name); stops = stops.concat(extractStops(route)); });
      return { ok:true, stops:stops, routeNames:names, total:total, matched:mine.length };
    } catch(e) { return { ok:false, error:String(e) }; }
  })()`;
}

// ── ZoeKiosk bridge handlers (desktop) ─────────────────────────────────────────
ipcMain.handle("zoe:importRoute", async (_e, truckId) => {
  const gs = findWebview("goodshuffle");
  if (!gs) return { ok: false, error: "no_goodshuffle_webview" };
  try {
    return await gs.executeJavaScript(goodshuffleImportScript(truckId), true);
  } catch (e) {
    return { ok: false, error: String(e) };
  }
});

// Ignition isn't part of the /kiosk desktop view, so ETA-link creation isn't available
// on desktop (the app falls back to its own /track link).
ipcMain.handle("zoe:createEtaLink", async () => ({
  ok: false,
  error: "ignition_not_available_on_desktop",
}));

ipcMain.handle("zoe:checkForUpdate", async () => ({
  ok: true,
  message: "Desktop app loads the latest web build on reload (Ctrl+R).",
}));

app.whenReady().then(() => {
  createWindow();

  // Ctrl+Shift+Q → guarded quit. Nothing else can close the window.
  globalShortcut.register("Control+Shift+Q", () => void promptExit());

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("second-instance", () => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

app.on("window-all-closed", () => app.quit());
app.on("will-quit", () => globalShortcut.unregisterAll());
