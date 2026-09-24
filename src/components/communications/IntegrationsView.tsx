// Observable integration health — the architecture, made visible. QUO/SONA → ZOE COMMUNICATIONS API →
// CONTEXT ENGINE → data → RULES → ACTION. Quo is CONNECTED (real last-event time), Sona is NOT_CONNECTED
// (we never pretend otherwise), the Context API is Available, and the webhook is Built. Honest states only.
// Server component.

import { Plug } from "lucide-react";
import { StatusMark } from "@/components/console-primitives";
import type { IntegrationStatus, IntegrationState } from "@/lib/comms/health";

function fmtWhen(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return isNaN(d.getTime()) ? "—" : d.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
}

const TONE: Record<IntegrationState, "positive" | "attention" | "critical" | "idle"> = {
  CONNECTED: "positive",
  AVAILABLE: "positive",
  BUILT: "attention",
  DEGRADED: "attention",
  NOT_CONNECTED: "critical",
};

const STATE_LABEL: Record<IntegrationState, string> = {
  CONNECTED: "Connected",
  AVAILABLE: "Available",
  BUILT: "Built",
  DEGRADED: "Degraded",
  NOT_CONNECTED: "Not connected",
};

export function IntegrationsView({ integrations }: { integrations: IntegrationStatus[] }): React.JSX.Element {
  return (
    <main className="max-w-[900px] p-6">
      <header className="mb-4">
        <h1 className="flex items-center gap-2 text-[22px] font-medium tracking-tight">
          <Plug className="size-5 text-meta" /> Integrations
        </h1>
        <p className="mt-1 max-w-[720px] text-[13px] text-meta">
          The communications architecture, observable. The Tower is the trusted intermediary — the voice agent never gets direct access to Zoe&apos;s systems.
        </p>
      </header>

      {/* Architecture boundary */}
      <div className="mb-5 overflow-x-auto rounded border border-border p-3">
        <div className="flex min-w-max items-center gap-2 text-[11.5px] text-meta">
          {["Quo / Sona", "Zoe Communications API", "Context Engine", "Data (GSPRO · Tower · Dispatch)", "Rules / Validation", "Action Execution"].map((s, i, arr) => (
            <span key={s} className="flex items-center gap-2">
              <span className="rounded border border-border px-2 py-1 text-tertiary-text">{s}</span>
              {i < arr.length - 1 && <span className="text-meta">→</span>}
            </span>
          ))}
        </div>
      </div>

      <div className="space-y-2">
        {integrations.map((ig) => (
          <div key={ig.key} className="flex flex-col gap-1.5 rounded border border-border p-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-[14px] font-medium text-foreground">{ig.name}</span>
                <span className="text-[11px] text-meta">· {ig.role}</span>
              </div>
              <p className="mt-0.5 text-[12.5px] text-tertiary-text">{ig.detail}</p>
              {ig.lastEventAt && <p className="mt-0.5 text-[11px] text-meta">Last event: {fmtWhen(ig.lastEventAt)}</p>}
            </div>
            <div className="shrink-0">
              <StatusMark tone={TONE[ig.state]} label={STATE_LABEL[ig.state]} />
            </div>
          </div>
        ))}
      </div>
    </main>
  );
}
