// AI Command Center — mission control over AI sessions (Phase 3). Live counts, provider + session-bridge
// status, a start-a-session control, and the auto-refreshing session feed. Any signed staff may view and
// operate; the Control tab (plane config) is owner/admin only. Server loads the snapshot; the client polls.

import { redirect } from "next/navigation";
import { viewerRole } from "@/lib/auth/getSession";
import { canViewAi, canOperateAi, canManageAi } from "@/lib/auth/roles";
import { aiControlOverview } from "@/lib/ai/control";
import { AI_EMPLOYEES } from "@/lib/aiorg/registry";
import { OrgTabs } from "@/components/aiorg/AiOrgBits";
import { AiSessionsConsole } from "@/components/aiorg/AiSessionsConsole";

export const dynamic = "force-dynamic";

export default async function AiSessionsPage(): Promise<React.JSX.Element> {
  const role = await viewerRole();
  if (!canViewAi(role)) redirect("/dashboard");

  const overview = aiControlOverview();
  // Startable agents: everything with a real backing (a "coming" employee has no data source to run on).
  const agents = AI_EMPLOYEES.filter((e) => e.backing !== "coming").map((e) => ({ id: e.id, name: e.name, blade: e.blade ?? null }));
  const nameById: Record<string, string> = {};
  for (const e of AI_EMPLOYEES) nameById[e.id] = e.name;

  return (
    <main className="max-w-[1100px] p-6">
      <header className="mb-4">
        <h1 className="text-[22px] font-medium tracking-tight">AI Command Center</h1>
        <p className="text-[12.5px] text-meta">
          Every AI session, its provider and the human-approval queue in one view. AI interprets and proposes; a human decides. {overview.liveCount} live now.
        </p>
      </header>

      <OrgTabs active="/ai-org/sessions" canManage={canManageAi(role)} />

      <AiSessionsConsole initial={overview} agents={agents} nameById={nameById} canOperate={canOperateAi(role)} />
    </main>
  );
}
