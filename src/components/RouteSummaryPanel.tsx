"use client";

import {
  CheckCircle2,
  MessageSquare,
  AlertTriangle,
  Send,
  Clock,
  ClipboardCheck,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import type { RouteSummary } from "@/lib/useRouteMachine";
import type { CloseoutResult } from "@/lib/types";

// Human labels for the closeout items, in checklist order (mirrors the fanout summary).
const CLOSEOUT_LABELS: [keyof CloseoutResult, string][] = [
  ["refueled", "Refueled"],
  ["itemsUnloaded", "Rentals unloaded"],
  ["discrepanciesReported", "Discrepancies reported"],
  ["damageInspected", "Inspected for damage"],
  ["securedKeysReturned", "Secured & keys returned"],
  ["notesSubmitted", "Route notes submitted"],
];

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

/** End-of-route wrap-up: automation KPIs + the closeout recap. */
export function RouteSummaryPanel({
  summary,
  closeout,
}: {
  summary: RouteSummary;
  closeout: CloseoutResult | null;
}) {
  const missing = closeout ? CLOSEOUT_LABELS.filter(([k]) => !closeout[k]).map(([, l]) => l) : [];
  const flagged = closeout ? missing.length > 0 || closeout.hasIssue : false;

  return (
    <div className="space-y-5">
      <Card className="shadow-sm">
        <CardContent className="flex flex-col items-center gap-2 px-8 py-8 text-center">
          <div className="flex size-16 items-center justify-center rounded-2xl bg-white/10 text-foreground">
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

      {/* Closeout recap — what the driver confirmed on arrival, and anything flagged. */}
      {closeout && (
        <Card className="shadow-sm">
          <CardContent className="space-y-4 px-6 py-6">
            <div className="flex items-center gap-3">
              <span
                className={`flex size-11 items-center justify-center rounded-xl ${
                  flagged ? "bg-amber-400/15 text-amber-300" : "bg-primary/15 text-primary"
                }`}
              >
                <ClipboardCheck className="size-6" />
              </span>
              <div>
                <h2 className="text-lg font-semibold">
                  {flagged ? "Closeout submitted — flagged for the office" : "Closeout complete"}
                </h2>
                <p className="text-sm text-muted-foreground">
                  {flagged ? "The office was notified of what's below." : "All items confirmed. Truck's ready for tomorrow."}
                </p>
              </div>
            </div>

            <ul className="space-y-2">
              {CLOSEOUT_LABELS.map(([key, label]) => (
                <li key={key} className="flex items-center gap-3 text-base">
                  {closeout[key] ? (
                    <CheckCircle2 className="size-5 shrink-0 text-primary" />
                  ) : (
                    <AlertTriangle className="size-5 shrink-0 text-amber-400" />
                  )}
                  <span className={closeout[key] ? "" : "text-amber-300"}>{label}</span>
                </li>
              ))}
            </ul>

            {closeout.overrideReason && (
              <p className="rounded-xl bg-white/5 p-3 text-sm text-muted-foreground">
                <span className="font-medium text-foreground">Reason: </span>
                {closeout.overrideReason}
              </p>
            )}
            {closeout.hasIssue && (
              <p className="rounded-xl bg-amber-400/[0.08] p-3 text-sm text-amber-200">
                <span className="font-medium">Issue reported: </span>
                {closeout.issueNote || "(no note)"}
              </p>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
