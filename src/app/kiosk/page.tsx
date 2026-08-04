"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ExternalLink, Maximize2, Lock, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { RouteScreen } from "@/components/RouteScreen";
import { getBoundTruck, verifyPin, type TruckBinding } from "@/lib/device";
import {
  acquireWakeLock,
  enterFullscreen,
  exitFullscreen,
  gsproEmbed,
  gsproUrl,
  keepAwake,
  openGoodshuffle,
} from "@/lib/kiosk";

export default function KioskPage() {
  const router = useRouter();
  const [truck, setTruck] = useState<TruckBinding | null | undefined>(undefined);
  const [started, setStarted] = useState(false);

  useEffect(() => {
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
  async function startShift() {
    await enterFullscreen();
    await acquireWakeLock();
    openGoodshuffle();
    setStarted(true);
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
  const [pin, setPin] = useState("");
  const [err, setErr] = useState(false);

  function attempt() {
    if (verifyPin(pin)) {
      void exitFullscreen();
      onExit();
    } else {
      setErr(true);
    }
  }

  return (
    <>
      <button
        onClick={() => {
          setPin("");
          setErr(false);
          setPrompting(true);
        }}
        aria-label="Exit kiosk"
        className="fixed bottom-3 right-3 z-30 flex size-9 items-center justify-center rounded-full bg-card/70 text-muted-foreground backdrop-blur hover:text-foreground"
      >
        <Lock className="size-4" />
      </button>

      {prompting && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-6">
          <div className="w-full max-w-xs space-y-4 rounded-2xl border bg-card p-6">
            <div className="flex items-center gap-2">
              <Maximize2 className="size-5 text-muted-foreground" />
              <h3 className="text-lg font-semibold">Exit kiosk</h3>
            </div>
            <p className="text-sm text-muted-foreground">
              Enter the tablet PIN to leave kiosk mode.
            </p>
            <Input
              inputMode="numeric"
              value={pin}
              autoFocus
              onChange={(e) => {
                setPin(e.target.value);
                setErr(false);
              }}
              placeholder="PIN"
            />
            {err && <p className="text-sm text-destructive">Incorrect PIN.</p>}
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
