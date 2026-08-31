"use client";

import { createElement, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ExternalLink, Maximize2, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { RouteScreen } from "@/components/RouteScreen";
import { clearTruck, getBoundTruck, type TruckBinding } from "@/lib/device";
import {
  acquireWakeLock,
  enterFullscreen,
  exitFullscreen,
  gsproEmbed,
  GSPRO_PARTITION,
  gsproUrl,
  gsproWebview,
  isNativeAndroid,
  keepAwake,
  openGoodshuffle,
} from "@/lib/kiosk";

export default function KioskPage() {
  const router = useRouter();
  const [truck, setTruck] = useState<TruckBinding | null | undefined>(undefined);
  const [started, setStarted] = useState(false);

  useEffect(() => {
    // Detect + cache the native-Android flag FIRST, while `?native=android` is still in
    // the URL. The cold-start redirect below client-navigates to /select and back, which
    // drops the query string — so if we don't persist the flag here, isNativeAndroid()
    // returns false on the way back and the app renders the wrong (web/Electron) layout:
    // StartOverlay + an in-page Goodshuffle pane instead of the native RouteScreen.
    isNativeAndroid();

    // On a fresh app launch (cold start), always return to the truck picker with a
    // clean slate instead of resuming a possibly-stale route. We detect a cold start by
    // sessionStorage being empty — in a native WebView that resets when the app is fully
    // closed and reopened, but survives a background resume or in-app navigation.
    let coldStart = false;
    try {
      coldStart = sessionStorage.getItem("zoeSessionActive") !== "1";
      if (coldStart) sessionStorage.setItem("zoeSessionActive", "1");
    } catch {
      /* ignore */
    }
    if (coldStart) clearTruck();

    const bound = getBoundTruck();
    if (!bound) {
      router.replace("/select");
      return;
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setTruck(bound);
  }, [router]);

  // Keep the screen awake for the whole shift once started.
  useEffect(() => {
    if (!started) return;
    return keepAwake();
  }, [started]);

  if (!truck) {
    return (
      <main className="flex min-h-dvh items-center justify-center text-muted-foreground">
        Loading…
      </main>
    );
  }

  // One user gesture unlocks fullscreen + wake lock + launching Goodshuffle.
  // When GSPRO is embedded in-pane (Electron kiosk shell), we must NOT also spawn
  // a separate window — the iframe pane already shows it.
  // Inside the Android APK the native shell already shows Goodshuffle beside us, so we
  // render ONLY the dispatch UI (full width) — no in-app Goodshuffle pane. (Goodshuffle
  // can't be iframed anyway; the native top-level WebView is what makes its login work.)
  const native = isNativeAndroid();

  async function startShift() {
    await enterFullscreen();
    await acquireWakeLock();
    if (!native && !gsproEmbed()) openGoodshuffle();
    setStarted(true);
  }

  if (native) {
    return (
      <div className="h-dvh w-dvw overflow-hidden">
        <RouteScreen truck={truck} kiosk onChangeTruck={() => router.replace("/select")} />
      </div>
    );
  }

  if (!started) {
    return <StartOverlay truckName={truck.name} onStart={startShift} />;
  }

  return (
    <div className="flex h-dvh w-dvw flex-col overflow-hidden md:flex-row">
      {/* Goodshuffle pane — the operational source of truth. */}
      <section className="min-h-0 flex-1 border-b border-white/10 md:border-b-0 md:border-r">
        <GsproPane />
      </section>

      {/* Our dispatch app — the action + automation layer. */}
      <section className="min-h-0 flex-1 md:w-[460px] md:flex-none">
        <RouteScreen truck={truck} kiosk onChangeTruck={() => router.replace("/select")} />
      </section>

      <ExitKiosk onExit={() => router.replace("/route")} />
    </div>
  );
}

function StartOverlay({
  truckName,
  onStart,
}: {
  truckName: string;
  onStart: () => void;
}) {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-6 p-8 text-center">
      <div className="space-y-2">
        <h1 className="text-3xl font-bold tracking-tight">Kiosk mode</h1>
        <p className="max-w-md text-muted-foreground">
          {truckName} · Goodshuffle Pro and Zoe Dispatch, side by side. Starting
          goes fullscreen, keeps the screen awake, and opens Goodshuffle.
        </p>
      </div>
      <Button onClick={onStart} className="h-16 gap-2 rounded-2xl px-10 text-xl">
        <Play className="size-6" /> Start shift
      </Button>
    </main>
  );
}

function GsproPane() {
  // Electron kiosk shell: a <webview> makes GSPRO first-party, so login works and
  // persists. (<webview> isn't a standard JSX element, so build it via createElement
  // to keep TypeScript happy; it only functions inside the Electron shell.)
  if (gsproWebview()) {
    return createElement("webview", {
      src: gsproUrl(),
      partition: GSPRO_PARTITION,
      allowpopups: "true",
      className: "h-full w-full border-0",
    });
  }
  // Header-stripping setups (browser extension / reverse proxy) can use a plain
  // iframe — but note GSPRO login may fail there due to third-party cookies.
  if (gsproEmbed()) {
    return (
      <iframe
        title="Goodshuffle Pro"
        src={gsproUrl()}
        className="h-full w-full border-0"
      />
    );
  }
  // Goodshuffle blocks iframe embedding, so this pane launches/refocuses it in
  // its own tiled window instead.
  return (
    <div className="flex h-full flex-col items-center justify-center gap-5 p-8 text-center">
      <span className="flex size-16 items-center justify-center rounded-2xl bg-primary/15 text-primary">
        <ExternalLink className="size-8" />
      </span>
      <div className="space-y-1">
        <h2 className="text-2xl font-bold">Goodshuffle Pro</h2>
        <p className="max-w-sm text-muted-foreground">
          Routes, stops, and inventory live in Goodshuffle. It can&apos;t be embedded
          (Goodshuffle blocks it), so it opens as its own window — snap it beside
          this panel.
        </p>
      </div>
      <Button onClick={openGoodshuffle} className="h-14 gap-2 rounded-xl px-8 text-lg">
        <ExternalLink className="size-5" /> Open Goodshuffle window
      </Button>
      <p className="max-w-xs text-xs text-muted-foreground">
        Desktop: <strong>Win + ←</strong> on the Goodshuffle window, then{" "}
        <strong>Win + →</strong> here. Tablets: Fully Kiosk / iPad Split View.
      </p>
    </div>
  );
}

function ExitKiosk({ onExit }: { onExit: () => void }) {
  const [prompting, setPrompting] = useState(false);

  function attempt() {
    void exitFullscreen();
    onExit();
  }

  return (
    <>
      <button
        onClick={() => setPrompting(true)}
        aria-label="Exit kiosk"
        className="fixed bottom-3 right-3 z-30 flex size-9 items-center justify-center rounded-full bg-card/70 text-muted-foreground backdrop-blur hover:text-foreground"
      >
        <Maximize2 className="size-4" />
      </button>

      {prompting && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-6">
          <div className="w-full max-w-xs space-y-4 rounded-2xl border bg-card p-6">
            <div className="flex items-center gap-2">
              <Maximize2 className="size-5 text-muted-foreground" />
              <h3 className="text-lg font-semibold">Exit kiosk?</h3>
            </div>
            <p className="text-sm text-muted-foreground">
              Leave kiosk mode and return to the standard view.
            </p>
            <div className="flex gap-2">
              <Button
                variant="outline"
                className="h-11 flex-1"
                onClick={() => setPrompting(false)}
              >
                Cancel
              </Button>
              <Button className="h-11 flex-1" onClick={attempt}>
                Exit
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
