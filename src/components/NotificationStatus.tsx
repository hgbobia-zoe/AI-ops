"use client";

import { Check, MessageSquare, MapPin, Bell } from "lucide-react";
import type { StopNotif } from "@/lib/useRouteMachine";

function fmt(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function Row({
  icon,
  label,
  at,
}: {
  icon: React.ReactNode;
  label: string;
  at?: string;
}) {
  const done = Boolean(at);
  return (
    <div className="flex items-center gap-2.5 py-1.5">
      <span
        className={`flex size-6 shrink-0 items-center justify-center rounded-full ${
          done
            ? "bg-emerald-500/20 text-emerald-400"
            : "bg-muted text-muted-foreground"
        }`}
      >
        {done ? <Check className="size-3.5" /> : icon}
      </span>
      <span className={`flex-1 text-sm ${done ? "" : "text-muted-foreground"}`}>
        {label}
      </span>
      <span className="text-xs text-muted-foreground">
        {done ? fmt(at) : "pending"}
      </span>
    </div>
  );
}

/**
 * Shows what OUR tool did for the customer at this stop — the automation layer
 * Goodshuffle doesn't provide. Only rendered once something has fired.
 */
export function NotificationStatus({ notif }: { notif?: StopNotif }) {
  if (!notif || (!notif.onWay && !notif.tracking && !notif.arrived)) return null;
  return (
    <section className="rounded-2xl border border-white/5 bg-card/60 p-4">
      <h2 className="mb-1 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        <Bell className="size-3.5" /> Customer notifications
      </h2>
      <Row
        icon={<MessageSquare className="size-3.5" />}
        label="On-the-way text sent"
        at={notif.onWay}
      />
      <Row
        icon={<MapPin className="size-3.5" />}
        label="Live tracking link active"
        at={notif.tracking}
      />
      <Row
        icon={<MessageSquare className="size-3.5" />}
        label="Arrived text sent"
        at={notif.arrived}
      />
    </section>
  );
}
