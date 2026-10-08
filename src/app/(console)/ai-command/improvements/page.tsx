// AI Command Center → Improvements. The observability surface (audit gate 11) for the self-improvement
// controller: every run, its state, budget use, and PR. Any signed staff may view. Reads are server-side.

import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowLeft, Wrench } from "lucide-react";
import { viewerRole } from "@/lib/auth/getSession";
import { canViewAi, canManageAi } from "@/lib/auth/roles";
import { listRuns, countRunsByState } from "@/lib/ai/improvement/store";
import { ImprovementRunsBoard } from "@/components/aiorg/ImprovementRunsBoard";
import { ImprovementGovernance } from "@/components/aiorg/ImprovementGovernance";
import { PrReviewPanel } from "@/components/aiorg/PrReviewPanel";

export const dynamic = "force-dynamic";

export default async function ImprovementsPage(): Promise<React.JSX.Element> {
  const role = await viewerRole();
  if (!canViewAi(role)) redirect("/dashboard");
  const runs = listRuns({ limit: 500 });
  const counts = countRunsByState();

  return (
    <main className="mx-auto max-w-[1100px] p-4 pb-16 md:p-5">
      <Link href="/ai-command" className="mb-3 inline-flex items-center gap-1 text-[12px] text-meta transition-colors hover:text-foreground">
        <ArrowLeft className="size-3.5" /> AI Command Center
      </Link>
      <header className="mb-5">
        <h1 className="flex items-center gap-2 text-[22px] font-semibold tracking-tight">
          <Wrench className="size-5 text-meta" /> Improvements
        </h1>
        <p className="text-[12.5px] text-meta">
          Each self-improvement run, carried through a controlled loop: investigate, plan, code, validate, PR, CI, merge, deploy, and verify. The controller owns scope, the change budget, and the merge/deploy/rollback gates — nothing reaches production without passing them.
        </p>
      </header>
      {canManageAi(role) && (
        <div className="mb-4 space-y-4">
          <PrReviewPanel />
          <ImprovementGovernance />
        </div>
      )}
      <ImprovementRunsBoard runs={runs} counts={counts} />
    </main>
  );
}
