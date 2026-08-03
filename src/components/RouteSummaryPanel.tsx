"use client";

import { useState } from "react";
import {
  CheckCircle2,
  MessageSquare,
  AlertTriangle,
  Send,
  Fuel,
  Clock,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import type { RouteSummary } from "@/lib/useRouteMachine";

function elapsedLabel(startedAt: string | null): string {
  if (!startedAt) return "—";
  const mins = Math.max(
    0,
    Math.round((Date.now() - new Date(startedAt).getTime()) / 60000),
  );
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function Stat({
  icon,
  value,
  label,
}: {
  icon: React.ReactNode;
  value: string | number;
  label: string;
}) {
  return (
    <div className="surface flex flex-col items-center gap-1 rounded-2xl border border-white/5 p-4 text-center">
      <span className="text-primary">{icon}</span>
      <span className="text-2xl font-bold">{value}</span>
      <span className="text-xs text-muted-foreground">{label}</span>
    </div>
  );
}

/** End-of-route wrap-up: automation KPIs + a fuel check. */
export function RouteSummaryPanel({
  summary,
  onGas,
}: {
  summary: RouteSummary;
  onGas: (putGas: boolean) => void;
}) {
  const [gas, setGas] = useState<boolean | null>(null);

  function answer(putGas: boolean) {
    setGas(putGas);
    onGas(putGas);
  }

  return (
    <div className="space-y-5">
      <Card className="shadow-sm">
        <CardContent className="flex flex-col items-center gap-2 px-8 py-8 text-center">
          <div className="flex size-16 items-center justify-center rounded-2xl bg-emerald-500/15 text-emerald-400">
            <CheckCircle2 className="size-8" />
          </div>
          <h1 className="text-2xl font-bold">Route complete</h1>
          <p className="text-muted-foreground">
            All stops delivered and the truck is back at the warehouse. Nice work.
          </p>
        </CardContent>
      </Card>

      <div className="grid grid-cols-2 gap-3">
        <Stat
          icon={<CheckCircle2 className="size-5" />}
          value={`${summary.stopsCompleted}/${summary.totalStops}`}
          label="Stops completed"
        />
        <Stat
          icon={<MessageSquare className="size-5" />}
          value={summary.textsSent}
          label="Customer texts"
        />
        <Stat
          icon={<Send className="size-5" />}
          value={summary.dispatchMsgs}
          label="Dispatch messages"
        />
        <Stat
          icon={<AlertTriangle className="size-5" />}
          value={summary.exceptions}
          label="Exceptions"
        />
        <div className="col-span-2">
          <Stat
            icon={<Clock className="size-5" />}
            value={elapsedLabel(summary.startedAt)}
            label="Total time on route"
          />
        </div>
      </div>

      {/* Fuel check */}
      <Card className="shadow-sm">
        <CardContent className="space-y-4 px-6 py-6">
          <div className="flex items-center gap-3">
            <span className="flex size-11 items-center justify-center rounded-xl bg-primary/15 text-primary">
              <Fuel className="size-6" />
            </span>
            <div>
              <h2 className="text-lg font-semibold">Did you put gas in the truck?</h2>
              <p className="text-sm text-muted-foreground">
                Logged for the fleet team.
              </p>
            </div>
          </div>

          {gas === null ? (
            <div className="grid grid-cols-2 gap-3">
              <Button
                onClick={() => answer(true)}
                className="h-14 rounded-xl text-lg"
              >
                Yes
              </Button>
              <Button
                variant="secondary"
                onClick={() => answer(false)}
                className="h-14 rounded-xl text-lg"
              >
                No
              </Button>
            </div>
          ) : (
            <div
              className={`rounded-xl p-3 text-center text-sm font-medium ${
                gas
                  ? "bg-emerald-500/15 text-emerald-400"
                  : "bg-amber-500/15 text-amber-400"
              }`}
            >
              {gas ? "Logged: fueled up ✓" : "Logged: not fueled — fleet notified"}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
