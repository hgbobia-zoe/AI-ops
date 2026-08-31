// Kiosk helpers: fullscreen, screen wake-lock, and launching Goodshuffle Pro
// alongside the app. Goodshuffle blocks iframe embedding (x-frame-options), so
// the side-by-side view is achieved by launching/tiling GSPRO in its own window
// and hardening our app as a kiosk citizen next to it.

"use client";

// The Wake Lock API isn't in the default TS lib; declare the minimal shape.
interface WakeLockSentinelLike {
  release: () => Promise<void>;
  addEventListener: (type: "release", cb: () => void) => void;
}
interface WakeLockNavigator {
  wakeLock?: { request: (type: "screen") => Promise<WakeLockSentinelLike> };
}

/** Goodshuffle Pro URL to launch beside the app (configurable). */
export function gsproUrl(): string {
  return (
    process.env.NEXT_PUBLIC_GSPRO_URL ||
    "https://pro.goodshuffle.com/app/rms/dashboard"
  );
}

/**
 * Whether to render GSPRO inline in an iframe instead of a separate window.
 *
 * Goodshuffle sends `X-Frame-Options: SAMEORIGIN`, so a plain browser refuses to
 * frame it — that's why the default is false. Inside the Electron kiosk shell
 * (`kiosk-shell/`) the main process strips that header at the network layer, so
 * the iframe renders fully. The shell signals this via `window.__ZOE_KIOSK_EMBED__`
 * (preload) and by loading `/kiosk?embed=1`. `NEXT_PUBLIC_GSPRO_EMBED=true` forces
 * it on for other header-stripping setups (browser extension, reverse proxy).
 */
export function gsproEmbed(): boolean {
  if (process.env.NEXT_PUBLIC_GSPRO_EMBED === "true") return true;
  if (gsproWebview()) return true;
  return envEmbedFlag();
}

// The environment-level "it's safe to iframe cross-origin apps" signal: the Electron
// shell (preload `__ZOE_KIOSK_EMBED__`) or a header-stripping setup (`?embed=1`).
// Applies to any embedded app (Goodshuffle, Ignition), not just one.
export function shellEmbedFlag(): boolean {
  return envEmbedFlag();
}
function envEmbedFlag(): boolean {
  if (typeof window === "undefined") return false;
  const w = window as unknown as { __ZOE_KIOSK_EMBED__?: boolean };
  if (w.__ZOE_KIOSK_EMBED__) return true;
  try {
    return new URLSearchParams(window.location.search).get("embed") === "1";
  } catch {
    return false;
  }
}

/**
 * Whether to render GSPRO as an Electron <webview> rather than an <iframe>.
 *
 * A <webview> is its own top-level browsing context, so Goodshuffle is FIRST-PARTY
 * inside it — its `SameSite` session cookies and storage work exactly like a normal
 * browser tab, so login succeeds and persists. An <iframe>, by contrast, makes GSPRO
 * a third-party frame under our origin, where the browser blocks those cookies and
 * login fails. The kiosk shell sets `window.__ZOE_KIOSK_WEBVIEW__` via preload.
 */
export function gsproWebview(): boolean {
  if (typeof window === "undefined") return false;
  const w = window as unknown as { __ZOE_KIOSK_WEBVIEW__?: boolean };
  return Boolean(w.__ZOE_KIOSK_WEBVIEW__);
}

/** The Electron session partition GSPRO's webview uses (persists login). */
export const GSPRO_PARTITION = "persist:gspro";

/**
 * True ONLY inside the Android kiosk APK. There the NATIVE shell shows Goodshuffle in
 * its own top-level WebView beside us, so the web app must NOT also render a Goodshuffle
 * pane (iframing it fails — Goodshuffle sends X-Frame-Options + CSP frame-ancestors
 * 'none'). The Android shell loads us with `?native=android`.
 *
 * Note: this is deliberately NOT keyed off `window.ZoeKiosk`, because the Electron shell
 * ALSO provides that bridge yet renders Goodshuffle as an in-page <webview> — so Electron
 * must keep the pane (isNativeAndroid = false there).
 */
export function isNativeAndroid(): boolean {
  if (typeof window === "undefined") return false;
  const w = window as unknown as { __ZOE_NATIVE_ANDROID__?: boolean };
  if (w.__ZOE_NATIVE_ANDROID__) return true;
  let android = false;
  try {
    android = new URLSearchParams(window.location.search).get("native") === "android";
  } catch {
    /* ignore */
  }
  if (!android) {
    // Client-side navigation can drop the query param — remember it once seen.
    try {
      android = sessionStorage.getItem("zoeNativeAndroid") === "1";
    } catch {
      /* ignore */
    }
  }
  if (android) {
    w.__ZOE_NATIVE_ANDROID__ = true;
    try {
      sessionStorage.setItem("zoeNativeAndroid", "1");
    } catch {
      /* ignore */
    }
  }
  return android;
}

// Ignition (fleet telematics) is the dispatch dashboard's split-view companion,
// mirroring how Goodshuffle sits beside the delivery app. Its URL is a RUNTIME
// server env (IGNITION_URL), passed to IgnitionPane as a prop — so it can be set
// with `docker run -e IGNITION_URL=…` without a rebuild.

/** Electron session partition for Ignition's webview (persists its login). */
export const IGNITION_PARTITION = "persist:ignition";

export async function enterFullscreen(): Promise<void> {
  try {
    const el = document.documentElement;
    if (!document.fullscreenElement && el.requestFullscreen) {
      await el.requestFullscreen();
    }
  } catch {
    /* fullscreen may be blocked outside a user gesture — non-fatal */
  }
}

export async function exitFullscreen(): Promise<void> {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
  } catch {
    /* non-fatal */
  }
}

let sentinel: WakeLockSentinelLike | null = null;

/** Keep the tablet screen awake for the whole shift. Re-acquires after sleep. */
export async function acquireWakeLock(): Promise<void> {
  const nav = navigator as unknown as WakeLockNavigator;
  if (!nav.wakeLock) return;
  try {
    if (sentinel) {
      try {
        await sentinel.release();
      } catch {
        /* already released */
      }
    }
    sentinel = await nav.wakeLock.request("screen");
  } catch {
    /* denied / unsupported — non-fatal */
  }
}

/** Re-acquire the wake lock when the tab becomes visible again. Returns cleanup. */
export function keepAwake(): () => void {
  const onVisible = () => {
    if (document.visibilityState === "visible") void acquireWakeLock();
  };
  document.addEventListener("visibilitychange", onVisible);
  return () => document.removeEventListener("visibilitychange", onVisible);
}

/**
 * Open (or focus) an external app in its OWN window (not a background tab) tiled to
 * the left half of the screen, and best-effort snap our own window to the right half.
 * Used when the app can't be iframed (X-Frame-Options) and we're not in the shell.
 */
export function openExternalWindow(url: string, name: string): void {
  if (!url) return;
  const availW = (typeof screen !== "undefined" && screen.availWidth) || 1280;
  const availH = (typeof screen !== "undefined" && screen.availHeight) || 800;
  const half = Math.floor(availW / 2);
  const features = `popup=yes,left=0,top=0,width=${half},height=${availH}`;
  const win = window.open(url, name, features);
  win?.focus();
  try {
    window.moveTo(half, 0);
    window.resizeTo(availW - half, availH);
  } catch {
    /* ignored — the user snaps the window manually */
  }
}

export function openGoodshuffle(): void {
  openExternalWindow(gsproUrl(), "gspro");
}
