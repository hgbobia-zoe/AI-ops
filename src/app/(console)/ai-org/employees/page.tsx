// AI Employees — the full roster grouped by human owner. A denser view of the command-center grid, with
// every agent's live status, backing, today's metrics and data-source health. Owner/admin only.

import Link from "next/link";
import { redirect } from "next/navigation";
import { viewerRole } from "@/lib/auth/getSession";
import { canManageSettings, canSeeFinancials } from "@/lib/auth/roles";
import { aiOrg } from "@/lib/aiorg/service";
import { HUMANS } from "@/lib/aiorg/registry";
import { BackingBadge, HealthMark, MetricRow, OrgTabs, StateDot } from "@/components/aiorg/AiOrgBits";

export const dynamic = "force-dynamic";

const DEPT_LABEL: Record<string, string> = { sales: "Sales", backoffice: "Back Office", marketing: "Marketing", ops_exec: "Ops / Exec" };

export default async function AiEmployeesPage(): Promise<React.JSX.Element> {
  const role = await viewerRole();
  if (!canManageSettings(role)) redirect("/dashboard");
  const org = await aiOrg({ showMoney: canSeeFinancials(role) });

  return (
    <main className="max-w-[1100px] p-6">
      <header className="mb-4">
        <h1 className="text-[22px] font-medium tracking-tight">AI Employees</h1>
        <p className="text-[12.5px] text-meta">{org.employees.length} agents across {HUMANS.length} owners. {org.counts.live} live, {org.counts.seed} seed, {org.counts.partial} partial, {org.counts.coming} coming.</p>
      </header>

      <OrgTabs active="/ai-org/employees" />

      {HUMANS.map((h) => {
        const mine = org.employees.filter((e) => e.owner === h.name);
        if (mine.length === 0) return null;
        return (
          <section key={h.name} className="mb-6">
            <h2 className="mb-1.5 text-[13px] font-medium uppercase tracking-[0.1em] text-tertiary-text">{h.name} <span className="text-[11px] normal-case text-meta">· {h.role}</span></h2>
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
