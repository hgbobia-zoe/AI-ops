"use client";

import { useState } from "react";
import { CheckCircle2, Home, MapPin, Navigation, Phone } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { StateBadge } from "@/components/StateBadge";
import { ChecklistDialog } from "@/components/ChecklistDialog";
import { ExceptionDialog } from "@/components/ExceptionDialog";
import { ACTION_ICON, STATE_VISUAL } from "@/lib/stateVisual";
import type { AvailableAction } from "@/lib/stateMachine";
import type { ActionType, ChecklistResult, ExceptionType, Stop } from "@/lib/types";
import type { RoutePhase } from "@/lib/useRouteMachine";

// Shared square-tile styles for the action grid.
const TILE_CLASS =
  "surface flex min-h-28 flex-col items-center justify-center gap-2 rounded-3xl border border-white/5 p-4 text-center transition-all hover:border-primary/40 active:scale-[0.97] disabled:opacity-60";
const TILE_CLASS_DANGER =
  "flex min-h-28 flex-col items-center justify-center gap-2 rounded-3xl border border-destructive/30 bg-destructive/10 p-4 text-center text-red-300 transition-all hover:bg-destructive/15 active:scale-[0.97] disabled:opacity-60";

export function CurrentStopView({
  phase,
  activeStop,
  totalStops,
  actions,
  busy,
  onPerform,
}: {
  phase: RoutePhase;
  activeStop: Stop | null;
  totalStops: number;
  actions: AvailableAction[];
  busy: boolean;
  onPerform: (action: ActionType, payload?: Record<string, unknown>) => void;
}) {
  const [checklistFor, setChecklistFor] = useState<AvailableAction | null>(null);
  const [exceptionOpen, setExceptionOpen] = useState(false);

  function handleActionClick(action: AvailableAction) {
    if (action.action === "REPORT_EXCEPTION") {
      setExceptionOpen(true);
      return;
    }
    if (action.requiresChecklist) {
      setChecklistFor(action);
      return;
    }
    onPerform(action.action);
  }

  if (phase === "returned") {
    return (
      <Panel icon={<CheckCircle2 className="size-8" />} title="Route complete" tone="done">
        All stops delivered and the truck is back at the warehouse. Nice work.
      </Panel>
    );
  }

  if (phase === "headingBack") {
    return (
      <div className="space-y-5">
        <Panel icon={<Home className="size-8" />} title="Heading back to warehouse" tone="info">
          Last stop complete. Drive safe.
        </Panel>
        <ActionButtons actions={actions} busy={busy} onClick={handleActionClick} />
      </div>
    );
  }

  if (phase === "empty" || !activeStop) {
    return (
      <Panel icon={<Navigation className="size-8" />} title="No active route" tone="info">
        Press <strong>Start Route</strong> to load today&apos;s stops from Goodshuffle,
        or ask dispatch to assign this truck.
      </Panel>
    );
  }

  function handleChecklistConfirm(result: ChecklistResult) {
    if (!checklistFor) return;
    onPerform(checklistFor.action, { checklist: result });
    setChecklistFor(null);
  }

  function handleExceptionSubmit(type: ExceptionType, reason: string) {
    onPerform("REPORT_EXCEPTION", { type, reason });
    setExceptionOpen(false);
  }

  const mapsHref = `https://maps.google.com/?q=${encodeURIComponent(activeStop.address)}`;
  const StateIcon = STATE_VISUAL[activeStop.state].icon;

  return (
    <div className="space-y-5">
      <Card className="surface overflow-hidden border-white/5 pt-0">
        {/* gradient accent strip carries the current-stop context */}
        <div className="flex items-center justify-between gap-2 border-b border-white/5 bg-gradient-to-r from-primary/15 via-primary/5 to-transparent px-6 py-3">
          <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Stop {activeStop.sequence} of {totalStops}
          </span>
          <StateBadge state={activeStop.state} />
        </div>

        <CardContent className="space-y-6 px-6 py-2">
          <div className="flex items-center gap-4">
            <span
              className={`flex size-16 shrink-0 items-center justify-center rounded-2xl text-white ${STATE_VISUAL[activeStop.state].dot}`}
            >
              <StateIcon className="size-8" />
            </span>
            <h1 className="text-4xl font-bold leading-[1.05] tracking-tight">
              {activeStop.custName}
            </h1>
          </div>

          <div className="space-y-3">
            <a
              href={mapsHref}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-start gap-3 text-lg text-foreground/90 active:opacity-70"
            >
              <MapPin className="mt-0.5 size-5 shrink-0 text-primary" />
              <span className="underline-offset-2 hover:underline">{activeStop.address}</span>
            </a>
            <a
              href={`tel:${activeStop.custPhone}`}
              className="flex items-center gap-3 text-lg text-foreground/90 active:opacity-70"
            >
              <Phone className="size-5 shrink-0 text-primary" />
              <span>{activeStop.custPhone}</span>
            </a>
          </div>

          <div className="flex gap-3">
            {activeStop.plannedWindow && (
              <InfoTile label="Window" value={activeStop.plannedWindow} />
            )}
            {activeStop.eta && <InfoTile label="ETA" value={activeStop.eta} emphasize />}
          </div>
        </CardContent>
      </Card>

      {/* Action area: big primary tile + a grid of action/quick-action squares. */}
      <div className="space-y-3">
        {actions
          .filter((a) => a.variant === "default")
          .map((a) => {
            const Icon = ACTION_ICON[a.action];
            return (
              <button
                key={a.action}
                onClick={() => handleActionClick(a)}
                disabled={busy}
                className="btn-hero flex min-h-32 w-full flex-col items-center justify-center gap-2.5 rounded-3xl border-0 text-white transition-all active:scale-[0.98] disabled:opacity-70"
              >
                <Icon className="size-9" />
                <span className="text-2xl font-semibold">{a.label}</span>
              </button>
            );
          })}

        <div className="grid grid-cols-2 gap-3">
          <a href={`tel:${activeStop.custPhone}`} className={TILE_CLASS}>
            <Phone className="size-7 text-primary" />
            <span className="text-base font-semibold">Call</span>
          </a>
          <a
            href={mapsHref}
            target="_blank"
            rel="noopener noreferrer"
            className={TILE_CLASS}
          >
            <Navigation className="size-7 text-primary" />
            <span className="text-base font-semibold">Directions</span>
          </a>
          {actions
            .filter((a) => a.variant !== "default")
            .map((a) => {
              const Icon = ACTION_ICON[a.action];
              const danger = a.variant === "destructive";
              return (
                <button
                  key={a.action}
                  onClick={() => handleActionClick(a)}
                  disabled={busy}
                  className={
                    danger ? TILE_CLASS_DANGER : TILE_CLASS
                  }
                >
                  <Icon className={`size-7 ${danger ? "" : "text-primary"}`} />
                  <span className="text-base font-semibold">{a.label}</span>
                </button>
              );
            })}
        </div>
      </div>

      <ChecklistDialog
        open={checklistFor !== null}
        onOpenChange={(o) => !o && setChecklistFor(null)}
        onConfirm={handleChecklistConfirm}
        confirmLabel={checklistFor?.label ?? "Confirm"}
      />
      <ExceptionDialog
        open={exceptionOpen}
        onOpenChange={setExceptionOpen}
        onSubmit={handleExceptionSubmit}
      />
    </div>
  );
}

function InfoTile({
  label,
  value,
  emphasize,
}: {
  label: string;
  value: string;
  emphasize?: boolean;
}) {
  return (
    <div
      className={`flex-1 rounded-2xl border px-4 py-2.5 ${
        emphasize
          ? "border-primary/30 bg-primary/10"
          : "border-white/5 bg-white/[0.03]"
      }`}
    >
      <div className="text-[11px] uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div
        className={`text-lg font-semibold ${emphasize ? "text-indigo-300" : ""}`}
      >
        {value}
      </div>
    </div>
  );
}

function ActionButtons({
  actions,
  busy,
  onClick,
}: {
  actions: AvailableAction[];
  busy: boolean;
  onClick: (a: AvailableAction) => void;
}) {
  if (actions.length === 0) return null;
  const primary = actions.filter((a) => a.variant === "default");
  const others = actions.filter((a) => a.variant !== "default");

  return (
    <div className="space-y-3">
      {/* Primary action: a big full-width hero tile. */}
      {primary.map((a) => {
        const Icon = ACTION_ICON[a.action];
        return (
          <button
            key={a.action}
            onClick={() => onClick(a)}
            disabled={busy}
            className="btn-hero flex min-h-32 w-full flex-col items-center justify-center gap-2.5 rounded-3xl border-0 text-white transition-all active:scale-[0.98] disabled:opacity-70"
          >
            <Icon className="size-9" />
            <span className="text-2xl font-semibold">{a.label}</span>
          </button>
        );
      })}
      {/* Secondary actions: a grid of square tiles. */}
      {others.length > 0 && (
        <div className="grid grid-cols-2 gap-3">
          {others.map((a) => {
            const Icon = ACTION_ICON[a.action];
            const danger = a.variant === "destructive";
            const solo = others.length === 1;
            return (
              <button
                key={a.action}
                onClick={() => onClick(a)}
                disabled={busy}
                className={`flex min-h-28 flex-col items-center justify-center gap-2 rounded-3xl border p-4 text-center transition-all active:scale-[0.97] disabled:opacity-60 ${
                  solo ? "col-span-2" : ""
                } ${
                  danger
                    ? "border-destructive/30 bg-destructive/10 text-red-300 hover:bg-destructive/15"
                    : "surface border-white/5 hover:border-primary/40"
                }`}
              >
                <Icon className="size-7" />
                <span className="text-base font-semibold">{a.label}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function Panel({
  icon,
  title,
  children,
  tone,
}: {
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
  tone: "done" | "info";
}) {
  return (
    <Card className="surface border-white/5">
      <CardContent className="flex flex-col items-center gap-3 px-8 py-10 text-center">
        <div
          className={`flex size-16 items-center justify-center rounded-2xl ${
            tone === "done"
              ? "bg-emerald-100 text-emerald-600 dark:bg-emerald-950 dark:text-emerald-300"
              : "bg-primary/10 text-primary"
          }`}
        >
          {icon}
        </div>
        <h1 className="text-xl font-bold">{title}</h1>
        <p className="max-w-sm text-muted-foreground">{children}</p>
      </CardContent>
    </Card>
  );
}
