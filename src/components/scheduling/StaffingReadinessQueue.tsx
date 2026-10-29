"use client";

// STAFFING & READINESS — the single consolidated queue at the top of Scheduling (doc §15). It renders the
// pre-ordered QueueItem[] built by lib/scheduling/staffingQueue.ts (pure merge of pre-check gaps, shift
// readiness/exceptions, sync conflicts, scheduled-but-unrouted prompts). Each row's action scrolls to the
// existing detail panel that owns the real workflow — no placeholder buttons, no new exception rules.
//
// Status is rendered through the SHARED Nocturne vocabulary (StatusBadge / StatusMark): a coloured
// indicator icon + a crisp, untinted label on the inherited neutral surface. Honest empty state: a compact
// all-clear line, not an empty bordered card. Comms style: no em-dashes, no emoji.

import { ArrowRight } from "lucide-react";
import { StatusBadge, STATUS_ICON } from "@/components/ui/status";
import { StatusMark } from "@/components/console-primitives";
import type { QueueItem, QueueSeverity, QueueTarget } from "@/lib/scheduling/staffingQueue";

// Queue severity → shared StatusMark tone. "info" maps to idle (neutral — a quiet, non-coloured note).
const SEV_TONE: Record<QueueSeverity, "critical" | "attention" | "idle"> = {
  critical: "critical",
  attention: "attention",
  info: "idle",
};
const SEV_LABEL: Record<QueueSeverity, string> = {
  critical: "Blocking",
  attention: "Attention",
  info: "Info",
};

const TARGET_ANCHOR: Record<QueueTarget, string> = {
  "board": "staffing-board",
  "scheduled-to-route": "scheduled-to-route",
  "sync-conflicts": "sync-conflicts",
  "shift-readiness": "shift-readiness",
};

function scrollTo(anchor: string): void {
  document.getElementById(anchor)?.scrollIntoView({ behavior: "smooth", block: "start" });
}

export function StaffingReadinessQueue({ items }: { items: QueueItem[] }): React.JSX.Element {
  if (items.length === 0) {
    return (
      <div className="mb-5">
        <StatusBadge tone="positive">Staffing and readiness all clear for this day. Nothing needs attention.</StatusBadge>
      </div>
    );
  }

  return (
    <section className="surface mb-6 border border-border" aria-label="Staffing and readiness queue">
      <header className="flex items-center gap-2 border-b border-border px-4 py-2.5">
        <STATUS_ICON.attention className="size-4 shrink-0 text-status-warning" aria-hidden />
        <h2 className="text-[13px] font-medium uppercase tracking-[0.08em]">Staffing &amp; readiness</h2>
        <span className="text-[12px] text-meta">
          · {items.length} item{items.length === 1 ? "" : "s"} need{items.length === 1 ? "s" : ""} attention
        </span>
      </header>
      <ul className="divide-y divide-[var(--row-rule)]">
        {items.map((item) => (
          <li key={item.id} className="flex flex-wrap items-start justify-between gap-3 px-4 py-2.5">
            <div className="min-w-0">
              <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[13px]">
                <StatusMark tone={SEV_TONE[item.severity]} label={SEV_LABEL[item.severity]} />
                <span className="font-medium text-foreground">{item.problem}</span>
                <span className="text-meta">· {item.routeLabel}</span>
                {item.windowLabel && <span className="tabular-nums text-meta">· {item.windowLabel}</span>}
              </div>
              <p className="mt-0.5 text-[12px] text-meta">{item.detail}</p>
            </div>
            <button
              type="button"
              onClick={() => scrollTo(TARGET_ANCHOR[item.target])}
              className="inline-flex shrink-0 items-center gap-1 rounded border border-border px-2.5 py-1 text-[12px] text-tertiary-text transition-colors hover:bg-[var(--row-hover)] hover:text-foreground"
            >
              {item.actionLabel} <ArrowRight className="size-3" aria-hidden />
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
