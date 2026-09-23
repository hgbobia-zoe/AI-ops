// Connections & Data Health — management's "what's wired up, what needs a hand, can I trust these
// numbers?" view. Live status card per integration (with Refresh + per-provider Test) and a
// status-page-style uptime strip of recent imports. Admin/Owner (under /admin, gated by the proxy).

import { HeartPulse } from "lucide-react";
import { computeConnections, summarize } from "@/lib/health/connections";
import { getRecentImports } from "@/lib/pull/state";
import { refreshConnecteamHealth } from "@/lib/connecteam";
import { ConnectionsDashboard } from "@/components/ConnectionsDashboard";

export const dynamic = "force-dynamic";

export default async function HealthPage(): Promise<React.JSX.Element> {
  await refreshConnecteamHealth(); // live Connecteam check (TTL-cached), shared with the top status bar
  const connections = computeConnections();
  const summary = summarize(connections);
  const imports = getRecentImports(200);

  return (
    <main className="mx-auto max-w-3xl p-5 pb-16 md:p-8">
      <header className="mb-6">
        <h1 className="flex items-center gap-2 text-3xl font-bold tracking-tight">
          <HeartPulse className="size-7" /> Connections
        </h1>
        <p className="text-sm text-muted-foreground">What&apos;s connected, what needs attention, and whether the data behind the numbers is fresh.</p>
      </header>

      <ConnectionsDashboard initialConnections={connections} initialSummary={summary} initialImports={imports} />
    </main>
  );
}
