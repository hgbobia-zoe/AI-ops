// Admin → AI Configuration — GOVERN the AI system (owner/admin). The counterpart to the AI Command
// Center, which OPERATES it. Here you choose the AI provider, connect the Claude session bridge, and
// toggle per-blade AI. Operating sessions (open / resume / instruct / approve) happens in /ai-command.

import { redirect } from "next/navigation";
import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { viewerRole } from "@/lib/auth/getSession";
import { canManageAi } from "@/lib/auth/roles";
import { aiProviderCatalog, bridgeConnected, aiConfigured } from "@/lib/ai/provider";
import { allBladeAiConfig } from "@/lib/ai/bladeConfig";
import { AiControlPanel } from "@/components/aiorg/AiControlPanel";

export const dynamic = "force-dynamic";

export default async function AdminAiConfigPage(): Promise<React.JSX.Element> {
  const role = await viewerRole();
  if (!canManageAi(role)) redirect("/dashboard");

  return (
    <main className="mx-auto max-w-[1000px] p-5 pb-16 md:p-8">
      <header className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[22px] font-semibold tracking-tight">AI Configuration</h1>
          <p className="text-[12.5px] text-meta">Govern the AI system: provider, session bridge, per-blade AI. Operating sessions happens in the AI Command Center.</p>
        </div>
        <Link href="/ai-command" className="inline-flex items-center gap-1.5 border border-border px-3 py-1.5 text-[12.5px] text-tertiary-text transition-colors hover:bg-[var(--row-hover)] hover:text-foreground">
          AI Command Center <ArrowUpRight className="size-3.5" />
        </Link>
      </header>

      <AiControlPanel
        initialProviders={aiProviderCatalog()}
        initialBridgeConnected={bridgeConnected()}
        initialInlineReady={aiConfigured()}
        initialBlades={allBladeAiConfig()}
      />
    </main>
  );
}
