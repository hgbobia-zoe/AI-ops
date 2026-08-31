# Zoe Dispatch — Kiosk (Android)

The **truck-tablet kiosk** for Zoe Dispatch. It is the Android counterpart of the
Electron kiosk in [`../kiosk-shell/`](../kiosk-shell) and does the same job on a
tablet that a locked-down Chromium does on a laptop:

1. Loads the **Zoe Dispatch** web app (a Next.js PWA) full-screen in a WebView.
2. Shows **Goodshuffle Pro** beside it in a second, real WebView — a real Chromium,
   so it passes Cloudflare bot checks and holds a persistent login (server-side
   scraping can't). Route data can only be read from a real logged-in browser.
3. Keeps a third, **hidden Zonar Ignition** WebView alive (same persistent-login
   config) so its logged-in session is always warm for generating customer **ETA
   links**. It is not shown in the split, but can be revealed behind a PIN for
   sign-in / troubleshooting.
4. **Pins the app** (Lock Task / screen pinning) so a driver can't leave it.

The two visible panes sit in a responsive 50/50 split, mirroring the Electron
`/kiosk` view (dispatch app + Goodshuffle); Ignition rides along hidden.

> **Why a native shell at all?** Same reason as the Electron one: operational sites
> block iframing and demand a real, logged-in browser. A WebView is a real Chromium
> we control, with persistent cookies, so the driver signs in once and stays in.

---

## What's in here

```
android/
├── settings.gradle.kts            Gradle settings (module list, repos)
├── build.gradle.kts               Top-level plugins/versions
├── gradle.properties              JVM/AndroidX/Gradle flags
├── gradlew / gradlew.bat          Gradle wrapper scripts
├── gradle/wrapper/
│   ├── gradle-wrapper.properties  Pins Gradle 8.9
│   └── README.txt                 How to generate gradle-wrapper.jar
├── kiosk.properties.example       Optional build-time URL/PIN overrides
└── app/
    ├── build.gradle.kts           App module: SDKs, deps, BuildConfig fields
    ├── proguard-rules.pro         Keeps the JS bridge + receivers from R8
    └── src/main/
        ├── AndroidManifest.xml    Activity, BootReceiver, perms
        ├── java/com/zoeevents/dispatch/kiosk/
        │   ├── KioskApp.kt         Application; WebView debug (debug) + OTA install-result receiver
        │   ├── Config.kt           URLs + exit/unhide PINs (BuildConfig defaults + runtime override)
        │   ├── KioskActivity.kt    The kiosk: 3 WebViews, immersive, screen pinning, PIN exit + reveal
        │   ├── WebViewFactory.kt   WebView/cookie config for logins + Cloudflare
        │   ├── KioskJsBridge.kt    window.ZoeKiosk bridge (importGoodshuffleRoute + createEtaLink)
        │   ├── OtaUpdater.kt       Self-update: poll /api/kiosk/latest → download → verify → install
        │   └── BootReceiver.kt     Best-effort relaunch on boot
        └── res/…                   layout, theme (black), strings, launcher icon
```

### Key files, briefly

- **KioskActivity.kt** — inflates the split layout, configures all three WebViews,
  injects the `ZoeKiosk` bridge into the dispatch WebView, hides the system bars
  (immersive sticky) + keeps the screen on, enters **Lock Task**, blocks Back, and
  wires the hidden **long-press → PIN** gestures (top-left = exit, top-right = reveal
  Ignition). Persists cookies on pause.
- **WebViewFactory.kt** — the login-critical settings: JS/DOM storage/database on,
  `CookieManager` accepting first- **and third-party** cookies + flushing on pause,
  cache on, `mediaPlaybackRequiresUserGesture=false`, multiple-windows/popup support,
  and the **default user agent left untouched** (spoofing trips bot detection). Grants
  geolocation/media permission requests. Keeps all navigation in-WebView.
- **KioskJsBridge.kt** — `window.ZoeKiosk` in the dispatch page. Plumbing to run JS
  inside the Goodshuffle **and hidden Ignition** WebViews and return results
  asynchronously (`window.__zoeKioskResolve(id, json)`), plus `requestExit(pin)`.
  See **Stubbed**.
- **Config.kt / BuildConfig** — `APP_URL`, `GSPRO_URL`, `IGNITION_URL`, `EXIT_PIN`,
  `UNHIDE_PIN` with sensible defaults, overridable at build time (`kiosk.properties`)
  and at runtime (prefs).

---

## Build & run in Android Studio

1. **Open** `C:\Git\ZER\AI-OPS\android\` in Android Studio (Ladybug / any version with
   AGP 8.7 support). Use JDK 17.
2. On first sync, if prompted about the Gradle wrapper, let Studio generate it — or
   run `gradle wrapper --gradle-version 8.9` in this folder once (see
   `gradle/wrapper/README.txt`; the binary `gradle-wrapper.jar` is not committed).
3. Let Gradle sync and download the Android SDK 35 platform if needed.
4. Pick the **app** run configuration, choose a device/emulator (API 26+), and **Run**.

Command line (after the wrapper jar exists):

```powershell
cd C:\Git\ZER\AI-OPS\android
.\gradlew.bat assembleDebug         # build APK -> app\build\outputs\apk\debug\
.\gradlew.bat installDebug          # build + install to the connected tablet
```

### Setting the URLs / PIN

- **Defaults** are baked into `app/build.gradle.kts` (`APP_URL`, `GSPRO_URL`,
  `EXIT_PIN`) and surface as `BuildConfig` fields.
- **Per-build override (no source edit):** copy `kiosk.properties.example` to
  `kiosk.properties` and set any of `APP_URL`, `GSPRO_URL`, `IGNITION_URL`,
  `EXIT_PIN`, `UNHIDE_PIN`. Env vars of the same names also work. The file is
  git-ignored.
- **Runtime override on a deployed tablet:** values are stored in SharedPreferences
  and read by `Config.kt`, so they can be changed without a rebuild (e.g. rotate the
  exit PIN) — wire a config broadcast if you need it in the field.

---

## Kiosk locking — screen pinning (no device owner)

This app is deliberately **not** a device owner / device admin. Device owner would give
a fully silent, unbreakable lock, but it requires a factory-reset + ADB provisioning
dance, and its device-admin component makes **Play Protect quietly uninstall a sideloaded
build**. We skip all of that and use Android's built-in **screen pinning**, which needs
no ADB and works on any tablet.

The app calls `startLockTask()` on launch → the OS shows the one-time "pin this app?"
confirmation, then gates Back / Home / Recents. A determined user can still unpin via the
system gesture, so it stops *accidental* navigation rather than being airtight — which is
the right trade for a trusted driver.

Per-tablet setup (once):

1. **Stop Play Protect removing the app** — Play Store → profile → **Play Protect** →
   gear → turn off "Scan apps with Play Protect" (or allowlist this app). *This is what
   fixes the "APK keeps disappearing" problem.*
2. **Enable pinning** — Settings → Security (or Security & privacy → More) →
   **App pinning / Screen pinning → On**. The app requests the pin automatically on launch.
3. **Allow self-update** — the first OTA update prompts to allow "install unknown apps"
   for the kiosk; allow it once so future updates self-install with a single tap.

> Stronger lock without device owner: set the app as the default **Home** app (it
> declares the HOME intent filter), so pressing Home returns to the kiosk instead of the
> launcher.

> Note on logins: the driver still signs into Goodshuffle / Ignition with **Google SSO**
> — that happens *inside the WebViews* and is unrelated to whether a Google account is on
> the device, so keeping the tablet account-free (to calm Play Protect) does not block it.

---

## Preventing exit

- **Immersive sticky** hides the status + navigation bars; they only peek on a swipe
  and re-hide. `FLAG_KEEP_SCREEN_ON` keeps the display awake for the whole shift.
- **Back is blocked** — it navigates the dispatch WebView's history if any, otherwise
  it's swallowed, so Back never leaves the app.
- **Hidden exit:** long-press the **top-left corner** (a transparent 72dp hotspot) to
  open a PIN prompt. The correct **exit PIN** (default **`1379`**, mirrors the Electron
  `EXIT_PIN`) calls `stopLockTask()` and finishes. The dispatch web app can also exit
  via `window.ZoeKiosk.requestExit(pin)`.

---

## The hidden Ignition WebView + reveal PIN

A third WebView loads **Zonar Ignition** (`IGNITION_URL`, default
`https://ignition.zonarsystems.com/app/realtimemaps/main`) with the **same
persistent-login config** as the others, but it is **hidden by default**: it lives in
an `INVISIBLE` full-screen overlay, so it is attached, laid out, loaded, logged in,
and able to run JS — it just isn't drawn and doesn't take touches (the dispatch +
Goodshuffle panes behind it stay fully interactive). Its job is to keep a warm,
logged-in Zonar session on the tablet for minting customer **ETA links**.

- **Once-only sign-in:** the first time (and only the first time), reveal it and sign
  into Ignition. Cookies/storage persist and flush on pause, so the session survives
  restarts and reboots — the driver never signs in again.
- **Reveal (PIN-gated):** long-press the **top-right corner** (a transparent 72dp
  hotspot, deliberately the opposite corner from the exit gesture). Enter the
  **`UNHIDE_PIN`** (default **`1379`**). On success the Ignition overlay appears
  full-screen with a **“Hide Ignition”** button to dismiss it (Back also hides it).
  A wrong or empty code does nothing — no error, no reveal.
- Hiding only changes visibility; the session stays alive underneath.

---

## Driver sign-in (one time, persists)

On first launch the driver signs into **Goodshuffle** in the right pane once, and
into **Ignition** once via the reveal gesture above. Cookies and WebView storage
persist (and are flushed on every pause), so both logins survive app restarts and
reboots — exactly like the Electron shell's persistent partition. SSO/"Sign in with
Google" popups open in a small in-app dialog and close themselves.

---

## What's done vs stubbed

**Done (real, working shell):**
- Two visible side-by-side WebViews (dispatch app + Goodshuffle), responsive 50/50
  split, plus a hidden-but-alive Ignition WebView revealable behind the `UNHIDE_PIN`.
- Login-grade WebView config on all three: persistent first/third-party cookies, DOM
  storage, default UA, popups/SSO, geolocation grant, cache — for Cloudflare +
  persistent login.
- Full kiosk hardening: immersive fullscreen, keep-awake, Lock Task (device owner
  **and** screen-pinning fallback), Back blocked, PIN exit, boot relaunch, device
  admin receiver + provisioning docs.
- The `window.ZoeKiosk` JS bridge **plumbing**: `ping`, `log`, `evalInGoodshuffle`,
  `evalInIgnition`, `requestExit`, and the async `__zoeKioskResolve` result channel.

**Stubbed (plumbing only — no extraction logic yet):**
- `ZoeKiosk.importGoodshuffleRoute(requestId)` — returns
  `{ ok:false, error:"not_implemented" }`. The plan (read the route/orders from the
  logged-in Goodshuffle session, normalise to the dispatch Route shape) is documented
  inline in `KioskJsBridge.kt`. Wire it via `evalInGoodshuffle(...)` when ready.
- `ZoeKiosk.createEtaLink(requestId, unitId, address)` — returns
  `{ ok:false, error:"not_implemented" }`. The plan: run Zonar's own `createEtaLink`
  **GraphQL mutation** via `evalInIgnition(...)` **inside the hidden Ignition WebView**
  (reusing that page's logged-in session to clear Cloudflare + auth), then resolve the
  ETA-share URL back to the dispatch WebView. Documented inline in `KioskJsBridge.kt`.
