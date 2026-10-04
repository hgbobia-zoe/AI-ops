// AI employee detail (§5.2) — owner, mission, status, last-run, today's metrics, the real inputs
// (deep-linked into the backing blade), the AUTHORITY split (CAN vs REQUIRES APPROVAL from the
// toolbox/permission levels), escalate-when, and how value is measured. A "coming" employee shows
// "Not wired yet" and no numbers. Owner/admin only.

import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { viewerRole } from "@/lib/auth/getSession";
import { canManageSettings, canSeeFinancials } from "@/lib/auth/roles";
import { aiEmployeeDetail } from "@/lib/aiorg/service";
import { authoritySplit, type Tool } from "@/lib/aiorg/types";
import { BackingBadge, HealthMark, MetricRow, OrgTabs, StateDot } from "@/components/aiorg/AiOrgBits";

export const dynamic = "force-dynamic";

const PERM_TONE: Record<string, string> = {
  READ: "text-meta",
  ANALYZE: "text-tertiary-text",
  DRAFT: "text-tertiary-text",
  EXECUTE: "text-positive",
  APPROVAL_REQUIRED: "text-attention",
};
const CAT_LABEL: Record<string, string> = { DATA: "Data", ANALYSIS: "Analysis", COMMS_DRAFT: "Comms draft", COMMS_SEND: "Comms send", WORKFLOW: "Workflow", EXTERNAL: "External" };

function ago(ts: string | null): string {
  if (!ts) return "—";
  const min = Math.max(0, Math.round((Date.now() - Date.parse(ts)) / 60_000));
  if (!Number.isFinite(min)) return "—";
  if (min < 60) return `${min}m ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export default async function AiEmployeePage({ params }: { params: Promise<{ id: string }> }): Promise<React.JSX.Element> {
  const role = await viewerRole();
  if (!canManageSettings(role)) redirect("/dashboard");
  const { id } = await params;
  const detail = await aiEmployeeDetail(id, { showMoney: canSeeFinancials(role) });
  if (!detail) notFound();
  const { view, config } = detail;
  if (!config) notFound();

  const { can, requiresApproval } = authoritySplit(config.toolbox);
  const coming = view.backing === "coming";

  return (
    <main className="max-w-[1000px] p-6">
      <OrgTabs active="/ai-org/employees" />

      <Link href="/ai-org" className="text-[12px] text-meta transition-colors hover:text-foreground">&larr; AI Org</Link>

      <header className="mt-2 mb-5 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2.5 text-[22px] font-medium tracking-tight">
            <StateDot state={view.state} /> {view.name} <BackingBadge backing={view.backing} />
          </h1>
          <p className="mt-1 max-w-[640px] text-[13px] text-meta">{config.mission}</p>
          <p className="mt-1 text-[12px] text-meta">Owner: <span className="text-tertiary-text">{config.owner}</span> · Last run: <span className="tabular-nums text-tertiary-text">{ago(view.lastRunAt)}</span></p>
        </div>
        <HealthMark health={view.health} />
      </header>

      {/* Today's metrics */}
      <Section title="Today">
        {coming ? (
          <p className="text-[13px] text-meta">Not wired yet — no data source. This agent is shown to describe the org; it carries no metrics until a real backing lands.</p>
        ) : view.metrics.length === 0 ? (
          <p className="text-[13px] text-meta">No metric resolved right now (&mdash;). The backing source may be unreachable.</p>
        ) : (
          <MetricRow metrics={view.metrics} />
        )}
        {view.lastDetail && <p className="mt-2 text-[12.5px] text-tertiary-text">{view.lastDetail}</p>}
      </Section>

      {/* Responsibilities */}
      <Section title="Responsibilities">
        <ul className="space-y-1 text-[13px]">
          {config.responsibilities.map((r) => (
            <li key={r} className="flex items-start gap-2"><span className="mt-1.5 size-1 shrink-0 rounded-full bg-[var(--bar)]" /><span>{r}</span></li>
          ))}
        </ul>
      </Section>

      {/* Inputs */}
      <Section title="Inputs" subtitle="The real module reads this agent consumes">
        {config.inputs.length === 0 ? (
          <p className="text-[13px] text-meta">None wired yet.</p>
        ) : (
          <div className="border border-border">
            {config.inputs.map((inp) => {
              const body = (
                <div className="flex items-center justify-between gap-3 px-3 py-2 text-[13px]">
                  <span className="text-foreground">{inp.label}</span>
                  <code className="shrink-0 text-[11.5px] text-meta">{inp.ref}</code>
                </div>
              );
              return (
                <div key={inp.ref} className="border-t border-[var(--row-rule)] transition-colors first:border-t-0 hover:bg-[var(--row-hover)]">
                  {inp.href ? <Link href={inp.href}>{body}</Link> : body}
                </div>
              );
            })}
          </div>
        )}
      </Section>

      {/* Authority */}
      <Section title="Authority" subtitle="What it can do unaided vs what waits for a human (v1 declares this model; it is not an execution engine yet)">
        <div className="grid gap-px overflow-hidden border border-border bg-border md:grid-cols-2">
          <ToolColumn title="Can (no approval)" tools={can} empty="No unaided tools." />
          <ToolColumn title="Requires approval" tools={requiresApproval} empty="No approval-gated tools." />
        </div>
      </Section>

      {/* Escalate */}
      <Section title="Escalate when">
        {config.escalationRules.length === 0 ? (
          <p className="text-[13px] text-meta">No escalation rules.</p>
        ) : (
          <ul className="space-y-1 text-[13px]">
            {config.escalationRules.map((e) => (
              <li key={e.when} className="flex items-start gap-2"><span className="mt-1.5 size-1 shrink-0 rounded-full bg-attention" /><span>{e.when}</span></li>
            ))}
          </ul>
        )}
      </Section>

      {/* Performance */}
      <Section title="Performance">
        <p className="text-[13px] text-tertiary-text">{config.valueMeasure}</p>
        <p className="mt-1 text-[12px] text-meta">Trend over time lands as the measurement history accrues (v2+).</p>
      </Section>
    </main>
  );
}

function ToolColumn({ title, tools, empty }: { title: string; tools: Tool[]; empty: string }): React.JSX.Element {
  return (
    <div className="bg-panel p-4">
      <div className="mb-2 text-[11px] font-medium uppercase tracking-[0.1em] text-tertiary-text">{title}</div>
      {tools.length === 0 ? (
        <p className="text-[12.5px] text-meta">{empty}</p>
      ) : (
        <ul className="space-y-2">
          {tools.map((t) => (
            <li key={t.id} className="text-[13px]">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-foreground">{t.label}</span>
                <span className={`shrink-0 text-[10px] font-semibold uppercase tracking-[0.06em] ${PERM_TONE[t.perm] ?? "text-meta"}`}>{t.perm.replace("_", " ")}</span>
              </div>
              <div className="text-[11px] text-meta">{CAT_LABEL[t.category]} · {t.backing}</div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Section({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <section className="mb-7">
      <div className="mb-1.5 flex items-baseline gap-2">
        <h2 className="text-[13px] font-medium uppercase tracking-[0.1em] text-tertiary-text">{title}</h2>
        {subtitle && <span className="text-[11px] text-meta">· {subtitle}</span>}
      </div>
      {children}
    </section>
  );
}
