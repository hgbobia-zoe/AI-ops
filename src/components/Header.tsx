"use client";

import { useState } from "react";
import {
  Truck,
  Wifi,
  WifiOff,
  RefreshCw,
  MoreHorizontal,
  DownloadCloud,
  ArrowUpCircle,
  LayoutDashboard,
  SlidersHorizontal,
} from "lucide-react";
import { STATE_VISUAL } from "@/lib/stateVisual";
import { openDispatchBoardViaKiosk, openAdminPanelViaKiosk } from "@/lib/kioskBridge";
import type { Stop } from "@/lib/types";

// 4-digit code that gates "Dispatch view" (switching the tablet/desktop kiosk from
// the driver stop view to the full dispatch board). Overridable via env without a
// rebuild; defaults to 0000 for now. Not a security boundary — just keeps a driver
// from wandering onto the office board by accident.
const DISPATCH_PIN = process.env.NEXT_PUBLIC_DISPATCH_PIN || "0000";

export function Header({
  truckName,
  stops,
  activeIndex,
  online,
  queuedCount,
  onChangeTruck,
  onRefresh,
  onPullRoute,
  onCheckUpdate,
}: {
  truckName: string;
  stops: Stop[];
  activeIndex: number;
  online: boolean;
  queuedCount: number;
  onChangeTruck: () => void;
  onRefresh: () => void;
  onPullRoute?: () => void;
  onCheckUpdate?: () => void;
}) {
  // Plain, self-contained dropdown — no Base UI menu (its portal + pointer-capture can
  // fail to open inside older Android System WebViews). This uses only onClick + a
  // backdrop, which works everywhere.
  const [menuOpen, setMenuOpen] = useState(false);
  const [pinOpen, setPinOpen] = useState(false);
  const [pinTarget, setPinTarget] = useState<"dispatch" | "admin">("dispatch");
  const [pin, setPin] = useState("");
  const [pinError, setPinError] = useState(false);
  const run = (fn: () => void) => () => {
    setMenuOpen(false);
    fn();
  };

  const promptFor = (target: "dispatch" | "admin") => () => {
    setPinTarget(target);
    setPin("");
    setPinError(false);
    setPinOpen(true);
  };

  const PIN_UI = {
    dispatch: { title: "Switch to dispatch view", body: "Enter the 4-digit code to open the dispatch board." },
    admin: { title: "Admin", body: "Enter the 4-digit code to open admin." },
  } as const;

  function submitPin() {
    if (pin !== DISPATCH_PIN) {
      setPinError(true);
      setPin("");
      return;
    }
    setPinOpen(false);
    if (pinTarget === "dispatch") {
      // Native kiosk: go full-screen board + Ignition side-by-side. Browser/older APK:
      // navigate to the board.
      if (!openDispatchBoardViaKiosk()) window.location.href = "/dispatch";
    } else {
      // Native kiosk: open the native admin panel (switch logins). Browser/older APK:
      // open web settings.
      if (!openAdminPanelViaKiosk()) window.location.href = "/admin";
    }
  }

  // NOTE: no `backdrop-blur` on the header. A backdrop-filter ancestor creates a
  // containing block + stacking context that older Android System WebViews mis-handle —
  // it hid/mispositioned the dropdown so the ⋯ tap "did nothing". Solid bg avoids it.
  return (
    <header className="sticky top-0 z-30 border-b border-white/10 bg-background">
      <div className="mx-auto flex max-w-2xl items-center justify-between gap-3 px-4 py-3">
        <div className="flex items-center gap-2.5">
          <span className="btn-hero flex size-9 items-center justify-center rounded-xl">
            <Truck className="size-5" />
          </span>
          <div className="leading-tight">
            <div className="text-sm font-semibold">{truckName}</div>
            <div className="text-[11px] text-muted-foreground">Zoe Dispatch</div>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <OnlinePill online={online} queuedCount={queuedCount} />
          <div className="relative">
            <button
              type="button"
              aria-label="Menu"
              onClick={() => setMenuOpen((o) => !o)}
              className="flex size-11 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <MoreHorizontal className="size-5" />
            </button>

            {menuOpen && (
              <>
                {/* backdrop closes the menu on any outside tap */}
                <div
                  className="fixed inset-0 z-40"
                  onClick={() => setMenuOpen(false)}
                  aria-hidden
                />
                <div
                  role="menu"
                  className="absolute right-0 top-[calc(100%+6px)] z-50 min-w-52 overflow-hidden rounded-xl border bg-card p-1 shadow-xl"
                >
                  <div className="px-3 py-2 text-xs font-medium text-muted-foreground">
                    {truckName}
                  </div>
                  <div className="my-1 h-px bg-border" />
                  {onPullRoute && (
                    <MenuItem onClick={run(onPullRoute)} icon={<DownloadCloud className="size-4" />}>
                      Pull route from Goodshuffle
                    </MenuItem>
                  )}
                  <MenuItem onClick={run(onRefresh)} icon={<RefreshCw className="size-4" />}>
                    Refresh route
                  </MenuItem>
                  <MenuItem onClick={run(onChangeTruck)} icon={<Truck className="size-4" />}>
                    Switch truck
                  </MenuItem>
                  {onCheckUpdate && (
                    <MenuItem onClick={run(onCheckUpdate)} icon={<ArrowUpCircle className="size-4" />}>
                      Check for updates
                    </MenuItem>
                  )}
                  <div className="my-1 h-px bg-border" />
                  <MenuItem onClick={run(promptFor("dispatch"))} icon={<LayoutDashboard className="size-4" />}>
                    Dispatch view
                  </MenuItem>
                  <MenuItem onClick={run(promptFor("admin"))} icon={<SlidersHorizontal className="size-4" />}>
                    Admin
                  </MenuItem>
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {pinOpen && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4"
          onClick={() => setPinOpen(false)}
        >
          <div
            className="w-full max-w-xs rounded-2xl border bg-card p-5 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2 text-sm font-semibold">
              {pinTarget === "admin" ? (
                <SlidersHorizontal className="size-4" />
              ) : (
                <LayoutDashboard className="size-4" />
              )}{" "}
              {PIN_UI[pinTarget].title}
            </div>
            <p className="mt-1 text-xs text-muted-foreground">{PIN_UI[pinTarget].body}</p>
            <input
              autoFocus
              type="password"
              inputMode="numeric"
              pattern="[0-9]*"
              maxLength={4}
              value={pin}
              onChange={(e) => {
                setPin(e.target.value.replace(/\D/g, "").slice(0, 4));
                setPinError(false);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") submitPin();
              }}
              placeholder="••••"
              className="mt-3 w-full rounded-xl border bg-background px-4 py-3 text-center text-2xl tracking-[0.5em] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
            {pinError && (
              <p className="mt-2 text-center text-xs font-medium text-red-400">
                Wrong code
              </p>
            )}
            <div className="mt-4 flex gap-2">
              <button
                type="button"
                onClick={() => setPinOpen(false)}
                className="flex-1 rounded-xl border px-4 py-2.5 text-sm text-muted-foreground hover:text-foreground"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={submitPin}
                disabled={pin.length !== 4}
                className="btn-hero flex-1 rounded-xl px-4 py-2.5 text-sm font-medium disabled:opacity-50"
              >
                Open
              </button>
            </div>
          </div>
        </div>
      )}

      {stops.length > 0 && (
        <div className="mx-auto flex max-w-2xl items-center gap-1.5 px-4 pb-3">
          {stops.map((s, i) => {
            const v = STATE_VISUAL[s.state];
            const isActive = i === activeIndex;
            return (
              <div
                key={s.stopId}
                className={`h-1.5 flex-1 rounded-full transition-all ${
                  s.state === "Completed"
                    ? "bg-foreground"
                    : isActive
                      ? v.dot
                      : "bg-border"
                } ${isActive ? "ring-2 ring-offset-2 ring-offset-card" : ""}`}
                style={isActive ? { boxShadow: "0 0 0 1px var(--ring)" } : undefined}
                title={`Stop ${s.sequence}: ${v.label}`}
              />
            );
          })}
        </div>
      )}
    </header>
  );
}

function MenuItem({
  onClick,
  icon,
  children,
}: {
  onClick: () => void;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className="flex w-full items-center gap-2 rounded-lg px-3 py-2.5 text-left text-sm text-foreground transition-colors hover:bg-accent active:bg-accent"
    >
      {icon}
      {children}
    </button>
  );
}

function OnlinePill({
  online,
  queuedCount,
}: {
  online: boolean;
  queuedCount: number;
}) {
  return (
    <span
      className={`flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${
        online
          ? "bg-white/10 text-muted-foreground"
          : "bg-white/15 text-foreground"
      }`}
      title={online ? "Online" : "Offline — actions sync when reconnected"}
    >
      {online ? <Wifi className="size-3.5" /> : <WifiOff className="size-3.5" />}
      {online ? "Online" : "Offline"}
      {queuedCount > 0 && (
        <span className="ml-0.5 rounded-full bg-foreground px-1.5 text-[10px] font-bold text-background">
          {queuedCount}
        </span>
      )}
    </span>
  );
}
