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

/** Whether to try embedding GSPRO in an iframe (default false — they block it). */
export function gsproEmbed(): boolean {
  return process.env.NEXT_PUBLIC_GSPRO_EMBED === "true";
}

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
 * Open (or focus) Goodshuffle Pro in its OWN window (not a background tab) so it
 * can be tiled beside the app. Goodshuffle blocks iframe embedding, so a separate
 * window is the only way to show both. Sized to the left half of the screen and
 * best-effort snaps our own window to the right half.
 */
export function openGoodshuffle(): void {
  const availW = (typeof screen !== "undefined" && screen.availWidth) || 1280;
  const availH = (typeof screen !== "undefined" && screen.availHeight) || 800;
  const half = Math.floor(availW / 2);
  const features = `popup=yes,left=0,top=0,width=${half},height=${availH}`;
  const win = window.open(gsproUrl(), "gspro", features);
  win?.focus();
  // Best-effort: move our own window to the right half (works when this window
  // was itself script-opened; a normal browser tab ignores it — snap manually).
  try {
    window.moveTo(half, 0);
    window.resizeTo(availW - half, availH);
  } catch {
    /* ignored — the user snaps the window manually */
  }
}
