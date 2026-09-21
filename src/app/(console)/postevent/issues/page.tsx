// Post-Event Issues / Service Recovery — every open issue across projects, with its state and escalation.
// Deterministic; opens to the project detail where the recovery branch is worked. No fabrication.

import Link from "next/link";
import { LifeBuoy } from "lucide-react";
import { listAllOpenIssues } from "@/lib/postevent/store";
import { projectFacts } from "@/lib/postevent/engine";
import { ISSUE_TYPE_LABEL, ISSUE_STATE_LABEL, ESCALATION_LEVEL_LABEL, type IssueType, type EscalationLevel } from "@/lib/postevent/types";

export const dynamic = "force-dynamic";

export default function PostEventIssuesPage(): React.JSX.Element {
  const issues = listAllOpenIssues();

  return (
    <main className="max-w-[1000px] p-6">
      <div className="mb-4 text-[12px] text-meta">
        <span className="text-tertiary-text">Post-Event</span> / Issues / Recovery
      </div>
      <header className="mb-4">
        <h1 className="flex items-center gap-2 text-[22px] font-medium tracking-tight">
          <LifeBuoy className="size-5 text-meta" /> Issues &amp; service recovery
        </h1>
        <p className="mt-1 text-[12.5px] text-meta">Open issues raised during post-event follow-up. Resolution is worked on the project, through its recovery lifecycle.</p>
      </header>

      {issues.length === 0 ? (
        <p className="text-[13px] text-meta">No open issues. Issues are opened from a project when a customer reports a problem.</p>
      ) : (
        <div className="overflow-hidden rounded border border-border">
          <div className="grid grid-cols-[1.6fr_1fr_1fr_1fr] gap-2 border-b border-[var(--row-rule)] bg-panel px-3 py-2 text-[11px] uppercase tracking-[0.06em] text-meta">
            <span>Customer</span>
            <span>Type</span>
            <span>State</span>
            <span>Escalation</span>
          </div>
          {issues.map((i) => {
            const f = projectFacts(i.bookingId);
            return (
              <Link key={i.id} href={`/postevent/project/${i.bookingId}`} className="grid grid-cols-[1.6fr_1fr_1fr_1fr] gap-2 border-t border-[var(--row-rule)] px-3 py-2 text-[12.5px] transition-colors first:border-t-0 hover:bg-[var(--row-hover)]">
                <span className="min-w-0 truncate">
                  <span className="text-foreground">{f.customer}</span>
                  <span className="ml-1.5 text-meta">{f.eventName}</span>
                </span>
                <span className="text-tertiary-text">{ISSUE_TYPE_LABEL[(i.issueType ?? "other") as IssueType]}</span>
                <span className="text-tertiary-text">{ISSUE_STATE_LABEL[i.state]}</span>
                <span className={i.escalationLevel !== "none" ? "text-attention" : "text-meta"}>{ESCALATION_LEVEL_LABEL[i.escalationLevel as EscalationLevel]}</span>
              </Link>
            );
          })}
        </div>
      )}
    </main>
  );
}
