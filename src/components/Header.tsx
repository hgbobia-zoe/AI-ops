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
} from "lucide-react";
import { STATE_VISUAL } from "@/lib/stateVisual";
import type { Stop } from "@/lib/types";

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
  const run = (fn: () => void) => () => {
    setMenuOpen(false);
    fn();
  };

  return (
    <header className="sticky top-0 z-20 border-b border-white/5 bg-background/70 backdrop-blur-xl">
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
              className="flex size-9 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
                </div>
              </>
            )}
          </div>
        </div>
      </div>

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
