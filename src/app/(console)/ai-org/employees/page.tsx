// AI Employees — the org chart. The AI workforce as a REAL top-down hierarchy: Ownership at the top, the
// human department leads (Jessie / Lisa / Princess) and the cross-functional Executive branch beneath, and
// each team's AI employees hanging underneath their lead. The chart is the centerpiece; a compact legend +
// per-owner roster sit below for the full detail. Owner/admin only.

import Link from "next/link";
import { redirect } from "next/navigation";
import { viewerRole } from "@/lib/auth/getSession";
import { canManageSettings, canSeeFinancials } from "@/lib/auth/roles";
import { aiOrg } from "@/lib/aiorg/service";
import { HUMANS } from "@/lib/aiorg/registry";
import { buildOrgTree, type OrgAgentInput } from "@/lib/aiorg/orgTree";
import { BackingBadge, HealthMark, MetricRow, OrgTabs, StateDot } from "@/components/aiorg/AiOrgBits";
import { OrgChart } from "@/components/aiorg/OrgChart";

export const dynamic = "force-dynamic";

const DEPT_LABEL: Record<string, string> = { sales: "Sales", backoffice: "Back Office", marketing: "Marketing", ops_exec: "Ops / Exec" };

export default async function AiEmployeesPage(): Promise<React.JSX.Element> {
  const role = await viewerRole();
  if (!canManageSettings(role)) redirect("/dashboard");
  const org = await aiOrg({ showMoney: canSeeFinancials(role) });

  // Build the org-chart tree from the REAL roster + the derived agent views (honest backing/state carried
  // through). The leaves link into each agent's detail page.
  const agents: OrgAgentInput[] = org.employees.map((e) => ({
    id: e.id,
    name: e.name,
    department: e.department,
    backing: e.backing,
    state: e.state,
  }));
  const tree = buildOrgTree(HUMANS, agents);

  return (
    <main className="max-w-[1100px] p-6">
      <header className="mb-4">
        <h1 className="text-[22px] font-medium tracking-tight">AI Org Chart</h1>
        <p className="text-[12.5px] text-meta">{org.employees.length} AI employees reporting into {HUMANS.length} human leads. {org.counts.live} live, {org.counts.seed} seed, {org.counts.partial} partial, {org.counts.coming} coming.</p>
      </header>

      <OrgTabs active="/ai-org/employees" />

      {/* ── THE ORG CHART (centerpiece) ── */}
      <OrgChart tree={tree} />

      {/* Legend — what the marks mean (honest states + backing) */}
      <div className="mb-8 mt-2 flex flex-wrap items-center gap-x-5 gap-y-2 text-[11px] text-meta">
        <span className="inline-flex items-center gap-1.5"><StateDot state="ok" /> Active</span>
        <span className="inline-flex items-center gap-1.5"><StateDot state="attention" /> Needs attention</span>
        <span className="inline-flex items-center gap-1.5"><StateDot state="idle" /> Idle / coming</span>
        <span className="text-[var(--bar)]">·</span>
        <span className="inline-flex items-center gap-1.5"><BackingBadge backing="live" /> real wired data</span>
        <span className="inline-flex items-center gap-1.5"><BackingBadge backing="seed" /> seed data</span>
        <span className="inline-flex items-center gap-1.5"><BackingBadge backing="partial" /> partial</span>
        <span className="inline-flex items-center gap-1.5"><BackingBadge backing="coming" /> not wired yet</span>
      </div>

      {/* ── FULL ROSTER (per owner, with today's metrics + data-source health) ── */}
      <h2 className="mb-2 text-[13px] font-medium uppercase tracking-[0.1em] text-tertiary-text">Roster detail</h2>
      {HUMANS.map((h) => {
        const mine = org.employees.filter((e) => e.owner === h.name);
        if (mine.length === 0) return null;
        return (
          <section key={h.name} className="mb-6">
            <h3 className="mb-1.5 text-[12.5px] font-medium uppercase tracking-[0.08em] text-tertiary-text">{h.name} <span className="text-[11px] normal-case text-meta">· {h.role}</span></h3>
            <div className="grid gap-px overflow-hidden border border-border bg-border sm:grid-cols-2">
              {mine.map((e) => (
                <Link key={e.id} href={`/ai-org/${e.id}`} className="bg-panel p-4 transition-colors hover:bg-[var(--row-hover)]">
                  <div className="flex items-center justify-between gap-2">
                    <span className="flex items-center gap-2 text-[14px] font-medium text-foreground"><StateDot state={e.state} /> {e.name}</span>
                    <BackingBadge backing={e.backing} />
                  </div>
                  <div className="mt-1 text-[11px] uppercase tracking-[0.06em] text-meta">{DEPT_LABEL[e.department]}</div>
                  <p className="mt-1.5 line-clamp-2 text-[12.5px] text-meta">{e.mission}</p>
                  <div className="mt-2.5">
                    {e.backing === "coming" ? <span className="text-[12px] text-meta">Not wired yet — no data source</span> : <MetricRow metrics={e.metrics} />}
                  </div>
                  {e.health && <div className="mt-2"><HealthMark health={e.health} /></div>}
                </Link>
              ))}
            </div>
          </section>
        );
      })}
    </main>
  );
}
