// Pure VIEW logic for the Communications queue — filtering, sorting, active-filter accounting and the
// label helpers the table/cards render. Kept framework-free (no React, no JSX) so it is unit-testable
// in the node test environment and reused by both the desktop table and the mobile list/detail flow.
//
// RULES CALCULATE, AI INTERPRETS: nothing here fabricates a value. Disposition "Unresolved" means we
// genuinely do NOT know the outcome (disposition === UNKNOWN) — never that a call was marked resolved;
// a completed call is not a resolved complaint. Caller identity and the matched customer stay distinct.

import type { QueueRow } from "./types";
import { REASON_DESK, REASON_LABEL, type CallReason } from "./reasons";

// ── Filters ────────────────────────────────────────────────────────────────────────────────────────
// The same four dimensions the blade has always filtered on (handled-by / state / desk / time), plus a
// primary CHANNEL quick-filter. Every field is a closed enum so a URL/query round-trip stays lossless.
export interface QueueFilters {
  handled: "" | "AI" | "HUMAN" | "TRANSFERRED";
  disposition: "" | "UNRESOLVED" | "ESCALATED";
  desk: "" | "SALES" | "OPERATIONS" | "BILLING";
  day: "" | "today" | "yesterday";
  channel: "" | "call" | "sms";
}

export const EMPTY_FILTERS: QueueFilters = { handled: "", disposition: "", desk: "", day: "", channel: "" };

/** How many secondary filters are active (channel is a primary control, counted separately in the UI). */
export function activeFilterCount(f: QueueFilters): number {
  return [f.handled, f.disposition, f.desk, f.day].filter(Boolean).length;
}

/** Any filter at all set (used to decide whether to show the active-filter / clear-all row). */
export function anyFilterActive(f: QueueFilters): boolean {
  return Boolean(f.handled || f.disposition || f.desk || f.day || f.channel);
}

// ── Sorting ───────────────────────────────────────────────────────────────────────────────────────
export type SortKey = "time" | "caller" | "reason" | "risk";
export type SortDir = "asc" | "desc";

/** Local date key (YYYY-MM-DD) in the viewer's timezone — used for the today/yesterday filter. */
export function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const rowDay = (r: QueueRow): string => (r.occurredAt ?? r.ts).slice(0, 10);

/**
 * Filter the queue. Semantics are preserved exactly from the original client filter:
 *  - handled: exact handledBy match
 *  - disposition ESCALATED → disposition === "ESCALATED"; UNRESOLVED → disposition === "UNKNOWN"
 *    (we only ever KNOW escalated/unknown — "unresolved" is honestly "outcome not known", not "resolved")
 *  - desk: the reason's routing desk
 *  - day: today / yesterday against occurredAt (fallback ts)
 *  - channel: exact channel match (primary quick filter)
 *  - q: case-insensitive substring over caller name, caller phone, matched customer and event
 */
export function filterRows(
  rows: QueueRow[],
  f: QueueFilters,
  q: string,
  today: string,
  yesterday: string,
): QueueRow[] {
  const needle = q.trim().toLowerCase();
  return rows.filter((r) => {
    if (f.handled && r.handledBy !== f.handled) return false;
    if (f.disposition === "ESCALATED" && r.disposition !== "ESCALATED") return false;
    if (f.disposition === "UNRESOLVED" && r.disposition !== "UNKNOWN") return false;
    if (f.desk && REASON_DESK[r.reason] !== f.desk) return false;
    if (f.channel && r.channel !== f.channel) return false;
    if (f.day) {
      const d = rowDay(r);
      if (f.day === "today" && d !== today) return false;
      if (f.day === "yesterday" && d !== yesterday) return false;
    }
    if (needle) {
      const hay = `${r.callerName} ${r.callerPhone ?? ""} ${r.customerName ?? ""} ${r.eventName ?? ""}`.toLowerCase();
      if (!hay.includes(needle)) return false;
    }
    return true;
  });
}

/** Stable sort by the chosen key/direction. Time (default) sorts on occurredAt, then ts. */
export function sortRows(rows: QueueRow[], key: SortKey, dir: SortDir): QueueRow[] {
  const m = dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    if (key === "caller") return m * a.callerName.localeCompare(b.callerName);
    if (key === "reason") return m * reasonText(a.reason).localeCompare(reasonText(b.reason));
    if (key === "risk") return m * (a.riskCount - b.riskCount);
    return m * ((Date.parse(a.occurredAt ?? a.ts) || 0) - (Date.parse(b.occurredAt ?? b.ts) || 0));
  });
}

// ── Label helpers (expand the old "Chan"/"Disp." abbreviations into real words) ──────────────────────
export const reasonText = (r: CallReason): string => REASON_LABEL[r];

/** Accessible channel descriptor: a short visible label plus a full screen-reader/tooltip sentence. */
export function channelDescriptor(r: QueueRow): { short: string; full: string } {
  if (r.channel === "sms") return { short: "SMS", full: "Text message (SMS)" };
  const dir = r.direction === "outgoing" ? "Outgoing" : r.direction === "incoming" ? "Incoming" : "";
  return { short: dir ? `${dir} call` : "Call", full: dir ? `${dir} phone call` : "Phone call" };
}

export function handledText(h: QueueRow["handledBy"]): string {
  return h === "HUMAN" ? "Human" : h === "AI" ? "AI" : h === "TRANSFERRED" ? "Transferred" : "Unknown";
}

export function statusText(s: QueueRow["status"]): string {
  return s.charAt(0) + s.slice(1).toLowerCase().replace(/_/g, " ");
}

/** The real disposition label — never implies "resolved" when we only know escalated / unknown. */
export function dispositionText(d: QueueRow["disposition"]): string {
  switch (d) {
    case "ESCALATED": return "Escalated";
    case "RESOLVED": return "Resolved";
    case "UNRESOLVED": return "Unresolved";
    case "FOLLOW_UP": return "Follow-up";
    default: return "Outcome unknown";
  }
}

export type StatusTone = "positive" | "attention" | "critical";

/** Tone for the call status mark. Missed = critical, completed = positive, in-flight = attention. These
 *  are all valid shared Tone values, so the result drops straight into <StatusBadge tone=…>. */
export function statusTone(s: QueueRow["status"]): StatusTone {
  if (s === "COMPLETED") return "positive";
  if (s === "MISSED") return "critical";
  return "attention";
}
