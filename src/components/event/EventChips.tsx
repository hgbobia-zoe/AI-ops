// Event Command Center chips — presentational only (Nocturne tokens). These RENDER engine outputs; they
// compute nothing. Governing law: reserved STATUS colours (good/warning/serious/critical) carry the
// readiness condition + requirement statuses, each with an ICON + LABEL so meaning is never colour-alone.
// The lifecycle chip is deliberately NEUTRAL / structural (no status colour) — lifecycle is a stage, not a
// verdict. An UNVERIFIED requirement reads "Unverified" in a neutral tone; it is never shown as a pass.

import type React from "react";
import {
  CheckCircle2,
  AlertTriangle,
  Ban,
  CircleHelp,
  ShieldAlert,
  Eye,
  CircleDot,
  Clock,
  Minus,
  type LucideIcon,
} from "lucide-react";
import type { EventCondition, RequirementStatus } from "@/lib/event/types";
import type { LifecycleState } from "@/lib/event/machine";
import type { MilestoneStatus } from "@/lib/event/timeline";
import { StatusBadge } from "@/components/ui/status";
import type { Tone } from "@/lib/tone";

// Status = a SATURATED coloured indicator (distinct-shape icon) + a crisp white label on the inherited
// surface, via the shared StatusBadge. No pill, no outline, no pastel tint; `filled` is the reserved
// exceptional case (ESCALATED). Meaning is icon-shape + text, so it never depends on colour alone.
const BADGE_CLS = "uppercase tracking-[0.05em]";

// ── Readiness condition (the independent risk axis) ─────────────────────────────────────────────────────
const CONDITION_META: Record<EventCondition, { tone: Tone; icon: LucideIcon; label: string; filled?: boolean }> = {
  NORMAL: { tone: "positive", icon: CheckCircle2, label: "On track" },
  WATCH: { tone: "attention", icon: Eye, label: "Watch" },
  AT_RISK: { tone: "attention", icon: AlertTriangle, label: "At risk" },
  BLOCKED: { tone: "critical", icon: Ban, label: "Blocked" },
  ESCALATED: { tone: "critical", icon: ShieldAlert, label: "Escalated", filled: true },
};

export function ConditionChip({ condition }: { condition: EventCondition }): React.JSX.Element {
  const m = CONDITION_META[condition];
  return (
    <StatusBadge tone={m.tone} icon={m.icon} filled={m.filled} size="sm" className={BADGE_CLS}>
      {m.label}
    </StatusBadge>
  );
}

// ── Requirement status ─────────────────────────────────────────────────────────────────────────────────
const REQ_META: Record<RequirementStatus, { tone: Tone; icon: LucideIcon; label: string }> = {
  OK: { tone: "positive", icon: CheckCircle2, label: "OK" },
  WARNING: { tone: "attention", icon: AlertTriangle, label: "Warning" },
  BLOCKED: { tone: "critical", icon: Ban, label: "Blocked" },
  UNVERIFIED: { tone: "neutral", icon: CircleHelp, label: "Unverified" },
};

export function RequirementChip({ status }: { status: RequirementStatus }): React.JSX.Element {
  const m = REQ_META[status];
  return (
    <StatusBadge tone={m.tone} icon={m.icon} size="sm" className={BADGE_CLS}>
      {m.label}
    </StatusBadge>
  );
}

// ── Lifecycle (NEUTRAL / structural — a stage, not a verdict) ────────────────────────────────────────────
const TERMINAL = new Set<LifecycleState>(["CLOSED", "CANCELLED", "LOST"]);

export function LifecycleChip({ state }: { state: LifecycleState }): React.JSX.Element {
  const dim = TERMINAL.has(state);
  return (
    <span className={`inline-flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[11px] font-medium uppercase tracking-[0.05em] ${dim ? "text-meta" : "text-tertiary-text"}`}>
      <CircleDot className="size-3 shrink-0 text-meta" aria-hidden />
      {titleCase(state)}
    </span>
  );
}

// ── Timeline milestone status dot (done/due/upcoming/overdue/na) ─────────────────────────────────────────
const MILESTONE_META: Record<MilestoneStatus, { dot: string; icon: React.ComponentType<{ className?: string }>; label: string; text: string }> = {
  done: { dot: "bg-positive", icon: CheckCircle2, label: "Done", text: "text-positive" },
  due: { dot: "bg-attention", icon: Clock, label: "Due", text: "text-attention" },
  overdue: { dot: "bg-critical", icon: AlertTriangle, label: "Overdue", text: "text-critical" },
  upcoming: { dot: "bg-[var(--bar)]", icon: CircleDot, label: "Upcoming", text: "text-tertiary-text" },
  na: { dot: "bg-[var(--bar)]", icon: Minus, label: "n/a", text: "text-meta" },
};

export function MilestoneMark({ status }: { status: MilestoneStatus }): React.JSX.Element {
  const m = MILESTONE_META[status];
  return (
    <span className={`inline-flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.05em] ${m.text}`}>
      <m.icon className="size-3.5 shrink-0" aria-hidden />
      {m.label}
    </span>
  );
}

export function milestoneDot(status: MilestoneStatus): string {
  return MILESTONE_META[status].dot;
}

function titleCase(s: string): string {
  return s.charAt(0) + s.slice(1).toLowerCase();
}
