// AI Command Center — the top-level operating layer: mission control over every AI session across the
// platform. Answers "what are all my AI employees doing right now, what needs me, what's active, done,
// waiting or errored." Distinct from the business Command Center (/dashboard) and from governance
// (/admin/ai). Any signed staff may view and operate; guests have no AI access.

import { redirect } from "next/navigation";
import { viewerRole } from "@/lib/auth/getSession";
import { canViewAi, canOperateAi } from "@/lib/auth/roles";
import { aiControlOverview } from "@/lib/ai/control";
import { listRecentSessions } from "@/lib/ai/sessions";
import { AI_EMPLOYEES } from "@/lib/aiorg/registry";
import { AiCommandConsole } from "@/components/aiorg/AiCommandConsole";

export const dynamic = "force-dynamic";

export default async function AiCommandPage({ searchParams }: { searchParams: Promise<{ blade?: string }> }): Promise<React.JSX.Element> {
  const role = await viewerRole();
  if (!canViewAi(role)) redirect("/dashboard");

  const overview = aiControlOverview();
  const sessions = listRecentSessions(200);
  const agents = AI_EMPLOYEES.filter((e) => e.backing !== "coming").map((e) => ({ id: e.id, name: e.name, blade: e.blade ?? null }));
  const nameById: Record<string, string> = {};
  for (const e of AI_EMPLOYEES) nameById[e.id] = e.name;
  const { blade } = await searchParams;

  return (
    <main className="mx-auto max-w-[1400px] p-4 pb-16 md:p-6">
      <header className="mb-5">
        <h1 className="text-[24px] font-semibold tracking-tight">AI Command Center</h1>
        <p className="text-[12.5px] text-meta">
          Every AI session across the platform in one control room. AI interprets and proposes; the app and a human decide. {overview.liveCount} live now.
        </p>
      </header>

      <AiCommandConsole
        initial={overview}
        sessions={sessions}
        agents={agents}
        nameById={nameById}
        canOperate={canOperateAi(role)}
        initialBlade={blade}
        playbooks={[{ id: "salesos-lost-quotes", label: "Lost Quote Recovery", endpoint: "/api/ai/blades/salesos/run", blade: "salesos" }]}
      />
    </main>
  );
}
