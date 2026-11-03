// One readable line per Operational History change. Shared by the /history feed and the per-event
// timeline so both say the same thing. Deterministic: it only rewords what the change log recorded.
// Dollar amounts are dropped when the viewer can't see money (Members).

import type { Tone } from "@/lib/tone";
import { formatYmdLong } from "@/lib/dates";
import type { ChangeRow } from "./store";
import { formatDollars } from "./format";

export type HistoryArea = "risk" | "crew" | "route" | "booking";

export const AREA_LABEL: Record<HistoryArea, string> = {
  risk: "Risks",
  crew: "Drivers",
  route: "Routes & stops",
  booking: "Bookings",
};

// Which change kinds belong to each filter. A kind missing here still shows under "All".
export const AREA_KINDS: Record<HistoryArea, string[]> = {
  risk: ["risk_detected", "risk_escalated", "risk_resolved", "risk_regressed", "risk_status_changed"],
  crew: ["driver_assigned", "driver_reassigned", "driver_cleared"],
  route: ["stop_removed", "event_completed"],
  booking: ["event_rescheduled", "booking_value_changed", "booking_cancelled", "cancel_linen_safeguard"],
};

export function areaOf(kind: string): HistoryArea | null {
  for (const a of Object.keys(AREA_KINDS) as HistoryArea[]) if (AREA_KINDS[a].includes(kind)) return a;
  return null;
}

export interface ChangeLine {
  area: HistoryArea | null;
  tone: Tone;
  title: string;
  subject: string | null;
  detail: string | null;
}

const cap = (s: string): string => (s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : s);
const ymd = (s: string | null): string => (s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? formatYmdLong(s) : s ?? "");
// Older change-log values used arrows and long dashes; read them as plain words.
const plain = (s: string | null): string | null => (s ? s.replace(/\s*→\s*/g, " to ").replace(/\s*[—–]\s*/g, ", ") : s);

export function describeChange(c: Pick<ChangeRow, "kind" | "field" | "entityId" | "fromValue" | "toValue">, opts: { showMoney: boolean }): ChangeLine {
  const area = areaOf(c.kind);
  const subject = c.field || null;
  switch (c.kind) {
    case "risk_detected":
      return { area, tone: "attention", title: "New risk", subject, detail: c.toValue ? cap(c.toValue) : null };
    case "risk_escalated":
      return { area, tone: "critical", title: "Risk got worse", subject, detail: c.fromValue && c.toValue ? `${cap(c.fromValue)} to ${cap(c.toValue)}` : null };
    case "risk_resolved":
      return { area, tone: "positive", title: "Risk resolved", subject, detail: null };
    case "risk_regressed":
      return { area, tone: "attention", title: "Risk came back", subject, detail: null };
    case "risk_status_changed": {
      // toValue is "acknowledged" or "acknowledged (by Jessie)".
      const m = /^(\w+)(?:\s*\(by (.+)\))?$/.exec(c.toValue ?? "");
      const status = m?.[1] ?? c.toValue ?? "updated";
      const s = status.toLowerCase().replace(/_/g, " ");
      return { area, tone: s === "resolved" ? "positive" : "info", title: s === "open" ? "Risk reopened" : `Risk marked ${s}`, subject, detail: m?.[2] ? `by ${m[2]}` : null };
    }
    case "driver_assigned":
      return { area, tone: "info", title: "Driver assigned", subject: c.entityId ? `route ${c.entityId}` : null, detail: c.toValue };
    case "driver_reassigned":
      return { area, tone: "info", title: "Driver changed", subject: c.entityId ? `route ${c.entityId}` : null, detail: `${c.fromValue ?? "nobody"} to ${c.toValue ?? "nobody"}` };
    case "driver_cleared":
      return { area, tone: "neutral", title: "Driver removed", subject: c.entityId ? `route ${c.entityId}` : null, detail: c.fromValue ? `was ${c.fromValue}` : null };
    case "stop_removed":
      return { area, tone: "neutral", title: "Stop pulled from a route", subject: c.fromValue ? `route ${c.fromValue}` : null, detail: null };
    case "event_completed": {
      const m = /^(\d+)\/(\d+)/.exec(c.field ?? "");
      const done = c.toValue === "complete";
      return { area, tone: done ? "positive" : "attention", title: done ? "Event delivered" : "Event closed, not all stops done", subject: null, detail: m ? `${m[1]} of ${m[2]} stops done` : c.field };
    }
    case "event_rescheduled":
      return { area, tone: "info", title: "Event moved", subject, detail: c.fromValue && c.toValue ? `${ymd(c.fromValue)} to ${ymd(c.toValue)}` : null };
    case "booking_value_changed": {
      const from = formatDollars(c.fromValue);
      const to = formatDollars(c.toValue);
      return { area, tone: "info", title: "Booking value changed", subject, detail: opts.showMoney && from && to ? `${from} to ${to}` : null };
    }
    case "booking_cancelled":
      return { area, tone: "critical", title: "Booking cancelled", subject, detail: c.toValue && c.toValue.toLowerCase() !== "cancelled" ? c.toValue : null };
    case "cancel_linen_safeguard":
      return { area, tone: "attention", title: "Linen check after a cancellation", subject, detail: plain(c.toValue) };
    default: {
      const detail = c.fromValue || c.toValue ? `${plain(c.fromValue) ?? "none"} to ${plain(c.toValue) ?? "none"}` : null;
      return { area, tone: "neutral", title: cap(c.kind.replace(/_/g, " ")), subject: subject ?? c.entityId ?? null, detail };
    }
  }
}
