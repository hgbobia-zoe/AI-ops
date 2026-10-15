"use client";

// STAFFING & READINESS — the single consolidated queue at the top of Scheduling (doc §15). It renders the
// pre-ordered QueueItem[] built by lib/scheduling/staffingQueue.ts (pure merge of pre-check gaps, shift
// readiness/exceptions, sync conflicts, scheduled-but-unrouted prompts). Each row's action scrolls to the
// existing detail panel that owns the real workflow — no placeholder buttons, no new exception rules.
//
// Honest empty state: a compact all-clear line, not an empty bordered card. Status shows as text + color
// (severity label beside a colored dot), never color alone. Comms style: no em-dashes, no emoji.

import { AlertTriangle, CheckCircle2, ArrowRight } from "lucide-react";
import type { QueueItem, QueueSeverity, QueueTarget } from "@/lib/scheduling/staffingQueue";

const SEV_DOT: Record<QueueSeverity, string> = {
  critical: "bg-critical",
  attention: "bg-attention",
  info: "bg-meta",
};
const SEV_LABEL: Record<QueueSeverity, string> = {
  critical: "Blocking",
  attention: "Attention",
  info: "Info",
};
const SEV_TEXT: Record<QueueSeverity, string> = {
  critical: "text-critical",
  attention: "text-attention",
  info: "text-meta",
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
      <p className="mb-5 inline-flex items-center gap-2 text-[12.5px] text-positive">
        <CheckCircle2 className="size-4" aria-hidden />
        Staffing and readiness all clear for this day. Nothing needs attention.
      </p>
    );
  }

  return (
    <section className="mb-6 rounded-lg border border-border" aria-label="Staffing and readiness queue">
      <header className="flex items-center gap-2 border-b border-border px-4 py-2.5">
        <AlertTriangle className="size-4 text-attention" aria-hidden />
        <h2 className="text-[13px] font-medium uppercase tracking-[0.08em]">Staffing &amp; readiness</h2>
        <span className="text-[12px] text-meta">
          · {items.length} item{items.length === 1 ? "" : "s"} need{items.length === 1 ? "s" : ""} attention
        </span>
      </header>
      <ul className="divide-y divide-[var(--row-rule)]">
        {items.map((item) => (
          <li key={item.id} className="flex flex-wrap items-start justify-between gap-3 px-4 py-2.5">
            <div className="flex min-w-0 items-start gap-2.5">
              <span className={`mt-1 size-1.5 shrink-0 rounded-full ${SEV_DOT[item.severity]}`} aria-hidden />
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[13px]">
                  <span className={`text-[10.5px] font-semibold uppercase tracking-[0.07em] ${SEV_TEXT[item.severity]}`}>
                    {SEV_LABEL[item.severity]}
                  </span>
                  <span className="font-medium text-foreground">{item.problem}</span>
                  <span className="text-meta">· {item.routeLabel}</span>
                  {item.windowLabel && <span className="tabular-nums text-meta">· {item.windowLabel}</span>}
                </div>
                <p className="mt-0.5 text-[12px] text-meta">{item.detail}</p>
              </div>
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
