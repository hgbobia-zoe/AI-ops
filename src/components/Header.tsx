"use client";

import { Truck, Wifi, WifiOff, RefreshCw, MoreHorizontal } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
}: {
  truckName: string;
  stops: Stop[];
  activeIndex: number;
  online: boolean;
  queuedCount: number;
  onChangeTruck: () => void;
  onRefresh: () => void;
}) {
  return (
    <header className="sticky top-0 z-20 border-b bg-card/80 backdrop-blur-sm">
      <div className="mx-auto flex max-w-2xl items-center justify-between gap-3 px-4 py-3">
        <div className="flex items-center gap-2.5">
          <span className="flex size-9 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-sm">
            <Truck className="size-5" />
          </span>
          <div className="leading-tight">
            <div className="text-sm font-semibold">{truckName}</div>
            <div className="text-[11px] text-muted-foreground">Zoe Dispatch</div>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <OnlinePill online={online} queuedCount={queuedCount} />
          <DropdownMenu>
            <DropdownMenuTrigger
              aria-label="Menu"
              className="flex size-9 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <MoreHorizontal className="size-5" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-44">
              <DropdownMenuLabel>{truckName}</DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={onRefresh}>
                <RefreshCw className="size-4" /> Refresh route
              </DropdownMenuItem>
              <DropdownMenuItem onClick={onChangeTruck}>
                <Truck className="size-4" /> Change truck
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
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
                    ? "bg-emerald-500"
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
          ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-200"
          : "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-200"
      }`}
      title={online ? "Online" : "Offline — actions sync when reconnected"}
    >
      {online ? <Wifi className="size-3.5" /> : <WifiOff className="size-3.5" />}
      {online ? "Online" : "Offline"}
      {queuedCount > 0 && (
        <span className="ml-0.5 rounded-full bg-amber-500 px-1.5 text-[10px] font-bold text-white">
          {queuedCount}
        </span>
      )}
    </span>
  );
}
