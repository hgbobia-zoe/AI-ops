// AI Command Center — the top-level control room for every AI employee and session across Zoe Operations.
// Answers "what are my AI employees doing right now?" Distinct from the business Command Center (/dashboard),
// from AI Org (who the employees are) and from Admin → AI Configuration (how the system is governed). Any
// signed staff may view and operate; guests have no AI access.

import { redirect } from "next/navigation";
import { viewerRole } from "@/lib/auth/getSession";
import { canViewAi, canOperateAi, canApproveAi, canSeeFinancials } from "@/lib/auth/roles";
import { aiCommandOverview } from "@/lib/ai/control";
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

  return (
    <main className="mx-auto max-w-[1500px] p-4 pb-16 md:p-5">
      <header className="mb-5">
        <h1 className="text-[24px] font-semibold tracking-tight">AI Command Center</h1>
        <p className="text-[12.5px] text-meta">Real-time control center for AI work across Zoe Operations. AI interprets and proposes; the app and a human decide.</p>
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
