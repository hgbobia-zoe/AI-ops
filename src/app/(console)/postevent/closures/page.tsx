// Post-Event Closure Reasons — the structured breakdown of WHY projects closed. Every close carries a
// reason (never a generic "archived"), so this is a real dataset: how post-event work actually ends.

import { ClipboardCheck } from "lucide-react";
import { closureBreakdown } from "@/lib/postevent/metrics";
import { CLOSURE_REASON_LABEL, CLOSURE_GROUPS, type ClosureReason } from "@/lib/postevent/types";

export const dynamic = "force-dynamic";

function groupOf(reason: string): string {
  return CLOSURE_GROUPS.find((g) => (g.reasons as string[]).includes(reason))?.group ?? "Other";
}

export default function PostEventClosuresPage(): React.JSX.Element {
  const { total, rows } = closureBreakdown();
  const max = Math.max(1, ...rows.map((r) => r.count));

  return (
    <main className="max-w-[800px] p-6">
      <div className="mb-4 text-[12px] text-meta">
        <span className="text-tertiary-text">Post-Event</span> / Closure Reasons
      </div>
      <header className="mb-4">
        <h1 className="flex items-center gap-2 text-[22px] font-medium tracking-tight">
          <ClipboardCheck className="size-5 text-meta" /> Closure reasons
        </h1>
        <p className="mt-1 text-[12.5px] text-meta">{total === 0 ? "No projects closed yet." : `${total} project${total === 1 ? "" : "s"} closed, by structured reason.`}</p>
      </header>

      {rows.length === 0 ? (
        <p className="text-[13px] text-meta">Nothing closed yet. When a project closes it always records one of the structured reasons.</p>
      ) : (
        <ul className="space-y-2">
          {rows.map((r) => (
            <li key={r.reason} className="rounded border border-border p-3">
              <div className="flex items-center justify-between text-[13px]">
                <span className="text-foreground">
                  {CLOSURE_REASON_LABEL[r.reason as ClosureReason] ?? r.reason}
                  <span className="ml-2 text-[11px] text-meta">{groupOf(r.reason)}</span>
                </span>
                <span className="tabular-nums text-tertiary-text">
                  {r.count} <span className="text-meta">({Math.round((r.count / total) * 100)}%)</span>
                </span>
              </div>
              <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded bg-[var(--bar)]">
                <div className="h-full bg-positive" style={{ width: `${Math.round((r.count / max) * 100)}%` }} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
