// AI Control Plane — the Control tab (owner/admin). Configure the active provider, connect the Claude
// session bridge, and toggle per-blade AI. All writes go through the manage-gated /api/ai/* endpoints.

import { redirect } from "next/navigation";
import { viewerRole } from "@/lib/auth/getSession";
import { canManageAi } from "@/lib/auth/roles";
import { aiProviderCatalog, bridgeConnected, aiConfigured } from "@/lib/ai/provider";
import { allBladeAiConfig } from "@/lib/ai/bladeConfig";
import { OrgTabs } from "@/components/aiorg/AiOrgBits";
import { AiControlPanel } from "@/components/aiorg/AiControlPanel";

export const dynamic = "force-dynamic";

export default async function AiControlPage(): Promise<React.JSX.Element> {
  const role = await viewerRole();
  if (!canManageAi(role)) redirect("/dashboard");

  return (
    <main className="max-w-[1000px] p-6">
      <header className="mb-4">
        <h1 className="text-[22px] font-medium tracking-tight">AI Control</h1>
        <p className="text-[12.5px] text-meta">Provider, session bridge and per-blade AI. The app only ever talks to one provider interface; these settings pick which one and where AI shows up.</p>
      </header>

      <OrgTabs active="/ai-org/control" canManage />

      <AiControlPanel
        initialProviders={aiProviderCatalog()}
        initialBridgeConnected={bridgeConnected()}
        initialInlineReady={aiConfigured()}
        initialBlades={allBladeAiConfig()}
      />
    </main>
  );
}
