// Event Risk — blade-local PRESENTATION helpers (pure, deterministic, no DB/network). These shape the
// stored risk queue for the /risk board: how a severity maps to a Nocturne tone, how a lifecycle state
// reads, what the single next valid action is, how to describe the thing a risk affects WITHOUT
// implying a specific event identity when the risk is really a day-level/operational problem, and how
// the severity/state/freshness filters narrow the queue.
//
// RULES CALCULATE, AI INTERPRETS — nothing here invents a score, a risk, or a successful action. It
// only renders what the engine already decided. Kept separate from the components so it is unit-tested
// in isolation (see present.test.ts).

import type { StoredRisk } from "./store";
import type { RiskSeverity, RiskStatus } from "./types";
import type { Tone } from "@/lib/tone";

// ── Severity → tone ─────────────────────────────────────────────────────────────
// CRITICAL = blocked (critical), HIGH/MEDIUM = requires review (attention), LOW = neutral. Colour only
// ever rides the small indicator; the label stays the high-contrast text (see tone.ts / StatusBadge).
export function severityTone(sev: RiskSeverity): Tone {
  if (sev === "CRITICAL") return "critical";
  if (sev === "HIGH" || sev === "MEDIUM") return "attention";
  return "neutral";
}

export const SEVERITY_LABEL: Record<RiskSeverity, string> = {
  CRITICAL: "Critical",
  HIGH: "High",
  MEDIUM: "Medium",
  LOW: "Low",
};

// ── Lifecycle state → label + tone ──────────────────────────────────────────────
export const STATUS_LABEL_TEXT: Record<RiskStatus, string> = {
  OPEN: "Open",
  ACKNOWLEDGED: "Acknowledged",
  IN_PROGRESS: "In progress",
  RESOLVED: "Resolved",
  DISMISSED: "Dismissed",
};

export function statusTone(status: RiskStatus): Tone {
  if (status === "IN_PROGRESS") return "info";
  if (status === "ACKNOWLEDGED") return "attention";
  if (status === "RESOLVED") return "positive";
  if (status === "DISMISSED") return "neutral";
  return "neutral"; // OPEN — unworked, no status colour of its own (severity carries the weight)
}

// ── Unverified / stale source ───────────────────────────────────────────────────
// A risk the engine could NOT verify (Connecteam unreachable) surfaces as the dedicated
// `staffing_unverified` type: an UNKNOWN, never a confirmed deficiency. The freshness filter keys off
// this so a manager can isolate "what do we actually not know" from confirmed problems.
export function isUnverified(r: Pick<StoredRisk, "riskType">): boolean {
  return r.riskType === "staffing_unverified" || r.riskType === "route_schedule_unverified";
}

// ── Affected scope — the heart of "label day-level risks as operational dates" ────
// A risk tied to a Goodshuffle event (eventId) is about THAT event. A risk with a route/truck but no
// event is about a route. A risk with only a date is a DAY-LEVEL / operational problem (e.g. a driver
// shortage across the day) — we must NOT render it as if it were one specific event.
export type AffectedScope =
  | { tier: "event"; eventId: string; detail?: string }
  | { tier: "route"; routeId?: string; truckId?: string; detail?: string }
  | { tier: "day"; detail?: string }
  | { tier: "none" };

export function affectedScope(r: Pick<StoredRisk, "eventId" | "routeId" | "truckId" | "affectedEntity" | "date">): AffectedScope {
  if (r.eventId) return { tier: "event", eventId: r.eventId, detail: r.affectedEntity };
  if (r.routeId || r.truckId) return { tier: "route", routeId: r.routeId, truckId: r.truckId, detail: r.affectedEntity };
  if (r.date) return { tier: "day", detail: r.affectedEntity };
  return { tier: "none" };
}

/** Short human label for the affected scope's KIND (the chip beside the date). Day-level risks read as
 *  "Operational date", never as a named event. */
export function scopeKindLabel(scope: AffectedScope): string {
  switch (scope.tier) {
    case "event":
      return "Event";
    case "route":
      return scope.truckId ? `Route · ${scope.truckId}` : "Route";
    case "day":
      return "Operational date";
    case "none":
      return "No date";
  }
}

// ── Source / signal of the finding (for the detail panel + external jump) ─────────
const SOURCE_LABEL: Record<string, string> = {
  connecteam: "Connecteam (crew scheduling)",
  dispatch: "Dispatch board (route assignment)",
  goodshuffle: "Goodshuffle (booking data)",
};
export function sourceLabel(actionTarget?: string): string {
  return (actionTarget && SOURCE_LABEL[actionTarget]) || "Risk engine (derived)";
}

/** External/internal resolution destination for a risk, if the engine named one. We NEVER invent a
 *  deep link — only the three the engine already emits are mapped, and following one does NOT resolve
 *  the risk (that stays a human lifecycle decision). */
export const RESOLUTION_TARGET: Record<string, { label: string; href: string; external: boolean }> = {
  connecteam: { label: "Open Connecteam", href: "https://app.connecteam.com", external: true },
  dispatch: { label: "Open dispatch", href: "/dispatch", external: false },
  goodshuffle: { label: "Open Goodshuffle", href: "https://pro.goodshuffle.com", external: true },
};
export function resolutionTarget(actionTarget?: string): { label: string; href: string; external: boolean } | undefined {
  return actionTarget ? RESOLUTION_TARGET[actionTarget] : undefined;
}

// ── Lifecycle actions ─────────────────────────────────────────────────────────────
// ONE next valid action is promoted to a primary button; everything else is a secondary action in the
// overflow menu. The server (api/risk/status) is the only authority — this just decides what to offer.
export type RiskAction = {
  status: RiskStatus;
  label: string;
  /** A consequential, closing action needs a confirm step before it fires. */
  confirm: boolean;
};

const ACK: RiskAction = { status: "ACKNOWLEDGED", label: "Acknowledge", confirm: false };
const START: RiskAction = { status: "IN_PROGRESS", label: "Start", confirm: false };
const RESOLVE: RiskAction = { status: "RESOLVED", label: "Resolve", confirm: true };
const DISMISS: RiskAction = { status: "DISMISSED", label: "Dismiss", confirm: true };

/** The single next valid step forward in the lifecycle (OPEN→Ack→Start→Resolve). */
export function nextAction(status: RiskStatus): RiskAction | undefined {
  if (status === "OPEN") return ACK;
  if (status === "ACKNOWLEDGED") return START;
  if (status === "IN_PROGRESS") return RESOLVE;
  return undefined; // RESOLVED / DISMISSED are terminal on the active board
}

/** Secondary lifecycle actions (everything valid that ISN'T the promoted next action). */
export function overflowActions(status: RiskStatus): RiskAction[] {
  const next = nextAction(status);
  const all: RiskAction[] = [];
  if (status === "OPEN") all.push(START, RESOLVE, DISMISS);
  else if (status === "ACKNOWLEDGED") all.push(ACK, RESOLVE, DISMISS);
  else if (status === "IN_PROGRESS") all.push(ACK, DISMISS);
  else all.push(RESOLVE, DISMISS);
  return all.filter((a) => a.status !== next?.status);
}

// ── Filtering ───────────────────────────────────────────────────────────────────
export type SeverityFilter = "ALL" | RiskSeverity;
export type StateFilter = "ALL" | RiskStatus;
export type FreshnessFilter = "ALL" | "VERIFIED" | "UNVERIFIED";

export interface RiskFilters {
  severity: SeverityFilter;
  state: StateFilter;
  freshness: FreshnessFilter;
}

export const DEFAULT_FILTERS: RiskFilters = { severity: "ALL", state: "ALL", freshness: "ALL" };

export function filterRisks(queue: StoredRisk[], f: RiskFilters): StoredRisk[] {
  return queue.filter((r) => {
    if (f.severity !== "ALL" && r.severity !== f.severity) return false;
    if (f.state !== "ALL" && r.status !== f.state) return false;
    if (f.freshness === "VERIFIED" && isUnverified(r)) return false;
    if (f.freshness === "UNVERIFIED" && !isUnverified(r)) return false;
    return true;
  });
}

// ── Dates ─────────────────────────────────────────────────────────────────────────
export function daysUntilLabel(date: string, today: string): string {
  const d = Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
  if (Number.isNaN(d)) return "";
  if (d < 0) return `${-d}d ago`;
  if (d === 0) return "today";
  if (d === 1) return "tomorrow";
  return `in ${d}d`;
}

/** Relative "as of" for a timestamp — used for data-freshness markers. */
export function relTime(iso: string, now: number = Date.now()): string {
  const d = Date.parse(iso);
  if (!Number.isFinite(d)) return "—";
  const m = Math.round((now - d) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}
