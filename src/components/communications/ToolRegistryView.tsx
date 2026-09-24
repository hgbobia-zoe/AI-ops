// The voice-agent tool registry, laid out by permission class. Every tool the agent can ever attempt is
// declared here with an EXPLICIT permission class and whether it's implemented or a declared-but-gated
// stub. This is the visible contract boundary: the agent never gets unrestricted access. Server
// component — no interactivity, just the truth of what's wired.

import { Wrench } from "lucide-react";
import { PERMISSION_LABEL, type ToolSpec, type PermissionClass } from "@/lib/comms/toolRegistry";

const ORDER: PermissionClass[] = ["READ_ONLY", "CUSTOMER_CONFIRMED_ACTION", "HUMAN_APPROVAL_REQUIRED", "ADMIN_ONLY", "DISABLED"];

const TONE: Record<PermissionClass, string> = {
  READ_ONLY: "text-positive border-positive/40",
  CUSTOMER_CONFIRMED_ACTION: "text-attention border-attention/40",
  HUMAN_APPROVAL_REQUIRED: "text-attention border-attention/40",
  ADMIN_ONLY: "text-attention border-attention/40",
  DISABLED: "text-critical border-critical/40",
};

const BLURB: Record<PermissionClass, string> = {
  READ_ONLY: "Safe reads over verified data — the agent may call these freely.",
  CUSTOMER_CONFIRMED_ACTION: "A side effect allowed only after the customer confirms in-call.",
  HUMAN_APPROVAL_REQUIRED: "A side effect allowed only after a Zoe human approves. The agent can never self-authorize.",
  ADMIN_ONLY: "Operator-only, owner/admin scope.",
  DISABLED: "Declared for the roadmap, but hard-disabled — never executable yet.",
};

export function ToolRegistryView({ tools }: { tools: ToolSpec[] }): React.JSX.Element {
  return (
    <main className="max-w-[1000px] p-6">
      <header className="mb-4">
        <h1 className="flex items-center gap-2 text-[22px] font-medium tracking-tight">
          <Wrench className="size-5 text-meta" /> Voice-agent tool registry
        </h1>
        <p className="mt-1 max-w-[720px] text-[13px] text-meta">
          The complete set of tools a voice agent could attempt, each with an explicit permission class. The Tower enforces every class server-side — the agent is given the Context Pack and this registry, never unrestricted access. AI can never bypass a permission.
        </p>
      </header>

      <div className="space-y-5">
        {ORDER.map((cls) => {
          const group = tools.filter((t) => t.permission === cls);
          if (group.length === 0) return null;
          return (
            <section key={cls}>
              <div className="mb-2 flex flex-wrap items-baseline gap-2">
                <span className={`rounded border px-2 py-0.5 text-[11px] font-medium uppercase tracking-[0.06em] ${TONE[cls]}`}>{PERMISSION_LABEL[cls]}</span>
                <span className="text-[12px] text-meta">{BLURB[cls]}</span>
              </div>
              <div className="overflow-hidden rounded border border-border">
                {group.map((t, i) => (
                  <div key={t.name} className={`flex flex-col gap-1 px-3 py-2.5 sm:flex-row sm:items-center sm:gap-4 ${i > 0 ? "border-t border-[var(--row-rule)]" : ""}`}>
                    <div className="w-52 shrink-0">
                      <span className="font-mono text-[13px] text-foreground">{t.name}</span>
                      <span className="ml-2 text-[10.5px] uppercase tracking-wide text-meta">{t.implemented ? "live" : "stub"}</span>
                    </div>
                    <p className="min-w-0 flex-1 text-[12.5px] text-tertiary-text">{t.description}</p>
                    <div className="hidden shrink-0 gap-1 md:flex">
                      {t.args.map((a) => <span key={a} className="rounded border border-border px-1.5 py-0.5 text-[10px] text-meta">{a}</span>)}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          );
        })}
      </div>

      <p className="mt-5 text-[11px] text-meta">
        Read-only tools run against real data (Unavailable where a source isn&apos;t connected — e.g. inventory, knowledge base). Controlled actions are gated behind explicit approval and never fire from the agent. Disabled tools exist only to make the boundary explicit.
      </p>
    </main>
  );
}
