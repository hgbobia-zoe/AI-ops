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
} from "lucide-react";
import type { EventCondition, RequirementStatus } from "@/lib/event/types";
import type { LifecycleState } from "@/lib/event/machine";
import type { MilestoneStatus } from "@/lib/event/timeline";

type ChipTone = "good" | "warning" | "serious" | "critical" | "neutral";

// Reserved status tones → Nocturne classes. good=positive, warning/serious=attention, critical=critical,
// neutral=meta (no status colour). Each chip pairs the colour with an icon + text label.
const TONE_CLS: Record<ChipTone, string> = {
  good: "border-positive/40 text-positive bg-positive/10",
  warning: "border-attention/40 text-attention bg-attention/10",
  serious: "border-attention/60 text-attention bg-attention/10",
  critical: "border-critical/45 text-critical bg-critical/10",
  neutral: "border-border text-tertiary-text",
};

function Chip({ tone, icon: Icon, label }: { tone: ChipTone; icon: React.ComponentType<{ className?: string }>; label: string }): React.JSX.Element {
  return (
    <span className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] font-medium uppercase tracking-[0.05em] ${TONE_CLS[tone]}`}>
      <Icon className="size-3 shrink-0" aria-hidden />
      {label}
    </span>
  );
}

// ── Readiness condition (the independent risk axis) ─────────────────────────────────────────────────────
const CONDITION_META: Record<EventCondition, { tone: ChipTone; icon: React.ComponentType<{ className?: string }>; label: string }> = {
  NORMAL: { tone: "good", icon: CheckCircle2, label: "On track" },
  WATCH: { tone: "warning", icon: Eye, label: "Watch" },
  AT_RISK: { tone: "serious", icon: AlertTriangle, label: "At risk" },
  BLOCKED: { tone: "critical", icon: Ban, label: "Blocked" },
  ESCALATED: { tone: "critical", icon: ShieldAlert, label: "Escalated" },
};

export function ConditionChip({ condition }: { condition: EventCondition }): React.JSX.Element {
  const m = CONDITION_META[condition];
  return <Chip tone={m.tone} icon={m.icon} label={m.label} />;
}

// ── Requirement status ─────────────────────────────────────────────────────────────────────────────────
const REQ_META: Record<RequirementStatus, { tone: ChipTone; icon: React.ComponentType<{ className?: string }>; label: string }> = {
  OK: { tone: "good", icon: CheckCircle2, label: "OK" },
  WARNING: { tone: "warning", icon: AlertTriangle, label: "Warning" },
  BLOCKED: { tone: "critical", icon: Ban, label: "Blocked" },
  UNVERIFIED: { tone: "neutral", icon: CircleHelp, label: "Unverified" },
};

export function RequirementChip({ status }: { status: RequirementStatus }): React.JSX.Element {
  const m = REQ_META[status];
  return <Chip tone={m.tone} icon={m.icon} label={m.label} />;
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
