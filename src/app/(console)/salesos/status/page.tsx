// Pipeline Status — the on-demand executive summary of every OPEN quote. A dense, sortable, filterable
// view so the owner can see, without opening each project: stage, amount due, quote sent -> opened, the
// last activity across ALL channels, and the last time a rep actually reached out. Every figure is
// COMPUTED from stored facts (buildPipelineStatus); nothing is fabricated. Owner/Admin (financial) view.

import { buildPipelineStatus } from "@/lib/salesos/execSummary";
import { viewerRole } from "@/lib/auth/getSession";
import { canSeeFinancials } from "@/lib/auth/roles";
import { PipelineStatusView } from "@/components/PipelineStatusView";

export const dynamic = "force-dynamic";

export default async function PipelineStatusPage(): Promise<React.JSX.Element> {
  const showMoney = canSeeFinancials(await viewerRole());
  const { summary, rows } = buildPipelineStatus();
  return <PipelineStatusView summary={summary} rows={rows} showMoney={showMoney} />;
}
