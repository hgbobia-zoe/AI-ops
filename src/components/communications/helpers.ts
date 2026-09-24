// Small formatting + tone helpers shared by the Communications UI. Pure functions — no JSX, no state —
// so both client components and server pages can import them.

import { REASON_LABEL, type CallReason } from "@/lib/comms/reasons";
import type { IdentityConfidence, LogisticsAvailability } from "@/lib/comms/types";

export function fmtWhen(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return isNaN(d.getTime()) ? "—" : d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export function fmtDuration(sec: number | null | undefined): string {
  if (sec == null || sec <= 0) return "—";
  const t = Math.round(sec);
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
}

export function fmtPhoneDisplay(p: string | null | undefined): string {
  const d = (p ?? "").replace(/\D/g, "");
  const t = d.length === 11 && d.startsWith("1") ? d.slice(1) : d;
  if (t.length === 10) return `(${t.slice(0, 3)}) ${t.slice(3, 6)}-${t.slice(6)}`;
  return (p ?? "").trim() || "—";
}

/** Money for the context/detail panels. Redacted for viewers without financial access; "Unavailable"
 *  (never $0) when the figure genuinely isn't known. */
export function money(n: number | null | undefined, showMoney: boolean): string {
  if (!showMoney) return "•••";
  if (n == null) return "Unavailable";
  return `$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}

export const reasonLabel = (r: CallReason): string => REASON_LABEL[r];

export const IDENTITY_TONE: Record<IdentityConfidence, "positive" | "attention" | "critical"> = {
  CONFIRMED: "positive",
  MULTIPLE_MATCHES: "attention",
  UNKNOWN: "critical",
};
export const IDENTITY_LABEL: Record<IdentityConfidence, string> = {
  CONFIRMED: "Confirmed",
  MULTIPLE_MATCHES: "Multiple matches",
  UNKNOWN: "Unknown",
};

export const LOGISTICS_LABEL: Record<LogisticsAvailability, string> = {
  SCHEDULED: "Scheduled",
  IN_PROGRESS: "In progress",
  COMPLETE: "Complete",
  UNAVAILABLE: "Unavailable",
};

export const SENTIMENT_TONE: Record<string, string> = {
  positive: "text-positive",
  negative: "text-critical",
  neutral: "text-meta",
};
