// Post-Event Issues / Service Recovery — every open issue across projects, with its state and escalation.
// Deterministic; opens to the project detail where the recovery branch is worked. No fabrication. A
// completed event is NOT a resolved issue: these are OPEN issues, kept distinct from the workflow stage.

import Link from "next/link";
import { LifeBuoy } from "lucide-react";
import { listAllOpenIssues } from "@/lib/postevent/store";
import { projectFacts } from "@/lib/postevent/engine";
import { ISSUE_TYPE_LABEL, ISSUE_STATE_LABEL, ESCALATION_LEVEL_LABEL, type IssueType, type EscalationLevel } from "@/lib/postevent/types";
import { BladeMain } from "@/components/ui/layouts";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/states";
import { StatusBadge } from "@/components/ui/status";

export const dynamic = "force-dynamic";

export default function PostEventIssuesPage(): React.JSX.Element {
  const issues = listAllOpenIssues();

  return (
    <BladeMain className="max-w-[1000px]">
      <PageHeader
        icon={<LifeBuoy className="size-5" />}
        title="Issues & service recovery"
        subtitle="Open issues raised during post-event follow-up. Resolution is worked on the project, through its recovery lifecycle."
      />

      {issues.length === 0 ? (
        <EmptyState
          icon={<LifeBuoy className="size-6" />}
          title="No open issues"
          body="Issues are opened from a project when a customer reports a problem. A resolved issue leaves this list; a completed event never appears here on its own."
        />
      ) : (
        <div className="surface overflow-x-auto border border-border">
          <table className="w-full min-w-[640px] text-[12.5px]">
            <thead>
              <tr className="border-b border-rule text-left text-[10.5px] uppercase tracking-[0.06em] text-meta">
                <th className="px-3 py-2 font-medium">Customer</th>
                <th className="px-3 py-2 font-medium">Type</th>
                <th className="px-3 py-2 font-medium">State</th>
                <th className="px-3 py-2 font-medium">Escalation</th>
              </tr>
            </thead>
            <tbody>
              {issues.map((i) => {
                const f = projectFacts(i.bookingId);
                const escalated = i.escalationLevel !== "none";
                return (
                  <tr key={i.id} className="border-b border-rule/60 last:border-0 transition-colors hover:bg-row-hover">
                    <td className="px-3 py-2">
                      <Link
                        href={`/postevent/project/${i.bookingId}`}
                        className="transition-colors hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <span className="text-foreground">{f.customer}</span>
                        <span className="ml-1.5 text-meta">{f.eventName}</span>
                      </Link>
                    </td>
                    <td className="px-3 py-2 text-secondary-text">{ISSUE_TYPE_LABEL[(i.issueType ?? "other") as IssueType]}</td>
                    <td className="px-3 py-2 text-secondary-text">{ISSUE_STATE_LABEL[i.state]}</td>
                    <td className="px-3 py-2">
                      {escalated ? (
                        <StatusBadge tone="attention" size="sm">
                          {ESCALATION_LEVEL_LABEL[i.escalationLevel as EscalationLevel]}
                        </StatusBadge>
                      ) : (
                        <span className="text-meta">{ESCALATION_LEVEL_LABEL[i.escalationLevel as EscalationLevel]}</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </BladeMain>
  );
}
