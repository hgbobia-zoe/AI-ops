// BladeAgents — the compact "AI employees working here" strip, dropped at the top of an operating blade
// so each human sees their own AI team IN CONTEXT. It reads the SAME aiOrg aggregation (via bladeAgents),
// so status/metrics stay honest: a "coming" agent shows "not wired yet", never a fabricated number. One
// tight, collapsible row of dense chips — status dot, one key signal, pending-approval + open-exception
// counts, and a link into the agent's AI Org detail. Read/status only: visible to anyone who can see the
// blade; $-bearing signals are redacted unless the viewer can see financials (reused from the aggregation).

import type React from "react";
import Link from "next/link";
import { viewerRole } from "@/lib/auth/getSession";
import { canSeeFinancials } from "@/lib/auth/roles";
import { bladeAgents } from "@/lib/aiorg/service";
import type { BladeKey } from "@/lib/aiorg/types";
import { BackingBadge, StateDot } from "./AiOrgBits";

const SIGNAL_TONE: Record<string, string> = {
  critical: "text-critical",
  attention: "text-attention",
  positive: "text-positive",
  default: "text-foreground",
};

/** The in-blade AI-employee strip. `blade` selects which agents surface (see BLADE_AGENTS). Renders
 *  nothing when the blade has no mapped agents. */
export async function BladeAgents({ blade, className }: { blade: BladeKey; className?: string }): Promise<React.JSX.Element | null> {
  const showMoney = canSeeFinancials(await viewerRole());
  const { agents } = await bladeAgents(blade, { showMoney });
  if (agents.length === 0) return null;

  const needingAttention = agents.filter((a) => a.view.state === "attention").length;
  const pending = agents.reduce((n, a) => n + a.pendingApprovals, 0);

  return (
    <details open className={`group border border-border bg-panel ${className ?? ""}`}>
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2">
        <span className="flex items-center gap-2">
          <span className="text-[11px] font-medium uppercase tracking-[0.1em] text-tertiary-text">AI employees working here</span>
          <span className="text-[11px] tabular-nums text-meta">{agents.length}</span>
          {needingAttention > 0 && <span className="text-[11px] tabular-nums text-attention">{needingAttention} need attention</span>}
          {pending > 0 && (
            <Link href="/ai-org/approvals" className="text-[11px] tabular-nums text-attention underline-offset-2 hover:underline">
              {pending} to approve
            </Link>
          )}
        </span>
        <span className="text-[11px] text-meta transition-colors group-hover:text-foreground">AI Org →</span>
      </summary>

      <div className="flex flex-wrap gap-px border-t border-[var(--row-rule)] bg-border">
        {agents.map(({ view, keySignal, pendingApprovals, openExceptions }) => (
          <Link
            key={view.id}
            href={`/ai-org/${view.id}`}
            title={view.mission}
            className="flex min-w-[180px] flex-1 items-center gap-2.5 bg-panel px-3 py-2 transition-colors hover:bg-[var(--row-hover)]"
          >
            <StateDot state={view.state} />
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-2">
                <span className="truncate text-[13px] font-medium text-foreground">{view.name}</span>
                <BackingBadge backing={view.backing} />
              </span>
              <span className="mt-0.5 block text-[11.5px] text-meta">
                {view.backing === "coming" || !keySignal ? (
                  "not wired yet"
                ) : (
                  <>
                    <span className={`tabular-nums ${SIGNAL_TONE[keySignal.tone ?? "default"]}`}>{keySignal.value}</span>{" "}
                    {keySignal.label.toLowerCase()}
                  </>
                )}
              </span>
            </span>
            {(pendingApprovals > 0 || openExceptions > 0) && (
              <span className="flex shrink-0 flex-col items-end gap-0.5 text-[10.5px] tabular-nums">
                {pendingApprovals > 0 && <span className="text-attention">{pendingApprovals} appr</span>}
                {openExceptions > 0 && <span className="text-attention">{openExceptions} exc</span>}
              </span>
            )}
          </Link>
        ))}
      </div>
    </details>
  );
}
