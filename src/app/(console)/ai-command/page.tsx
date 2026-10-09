// AI Command Center — the top-level control room for every AI employee and session across Zoe Operations.
// Answers "what are my AI employees doing right now?" Distinct from the business Command Center (/dashboard),
// from AI Org (who the employees are) and from Admin → AI Configuration (how the system is governed). Any
// signed staff may view and operate; guests have no AI access.

import Link from "next/link";
import { redirect } from "next/navigation";
import { Inbox, ArrowRight, Wrench } from "lucide-react";
import { viewerRole } from "@/lib/auth/getSession";
import { canViewAi, canOperateAi, canApproveAi, canSeeFinancials } from "@/lib/auth/roles";
import { aiCommandOverview } from "@/lib/ai/control";
import { countOpenRequests } from "@/lib/ai/requests";
import { listActiveRuns } from "@/lib/ai/improvement/store";
import { todayInOpsTz } from "@/lib/dates";
import { AI_EMPLOYEES } from "@/lib/aiorg/registry";
import { AiCommandConsole } from "@/components/aiorg/AiCommandConsole";

export const dynamic = "force-dynamic";

export default async function AiCommandPage({ searchParams }: { searchParams: Promise<{ blade?: string }> }): Promise<React.JSX.Element> {
  const role = await viewerRole();
  if (!canViewAi(role)) redirect("/dashboard");

  const overview = aiCommandOverview(canSeeFinancials(role));
  const agents = AI_EMPLOYEES.filter((e) => e.backing !== "coming").map((e) => ({ id: e.id, name: e.name, blade: e.blade ?? null }));
  const nameById: Record<string, string> = {};
  for (const e of AI_EMPLOYEES) nameById[e.id] = e.name;
  const { blade } = await searchParams;
  const openRequests = countOpenRequests();
  const activeImprovements = listActiveRuns().length;

  return (
    <main className="mx-auto max-w-[1500px] p-4 pb-16 md:p-5">
      <header className="mb-5 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-[24px] font-semibold tracking-tight">AI Command Center</h1>
          <p className="text-[12.5px] text-meta">Real-time control center for AI work across Zoe Operations. AI interprets and proposes; the app and a human decide.</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Link
            href="/ai-command/improvements"
            className="inline-flex items-center gap-1.5 rounded border border-border px-2.5 py-1.5 text-[12.5px] text-tertiary-text transition-colors hover:bg-[var(--row-hover)] hover:text-foreground"
          >
            <Wrench className="size-4" /> Improvements
            {activeImprovements > 0 && <span className="rounded-full bg-[var(--gold)]/15 px-1.5 py-0.5 text-[11px] font-medium tabular-nums text-[var(--gold)]">{activeImprovements}</span>}
          </Link>
          <Link
            href="/ai-command/requests"
            className="inline-flex items-center gap-1.5 rounded border border-border px-2.5 py-1.5 text-[12.5px] text-tertiary-text transition-colors hover:bg-[var(--row-hover)] hover:text-foreground"
          >
            <Inbox className="size-4" /> Requests
            {openRequests > 0 && <span className="rounded-full bg-attention/15 px-1.5 py-0.5 text-[11px] font-medium tabular-nums text-attention">{openRequests}</span>}
            <ArrowRight className="size-3.5" />
          </Link>
        </div>
      </header>

      <AiCommandConsole
        initial={overview}
        agents={agents}
        nameById={nameById}
        canOperate={canOperateAi(role)}
        canApprove={canApproveAi(role)}
        initialBlade={blade}
        today={todayInOpsTz()}
        playbooks={[{ id: "salesos-lost-quotes", label: "Lost Quote Recovery", endpoint: "/api/ai/blades/salesos/run", blade: "salesos" }]}
      />
    </main>
  );
}
