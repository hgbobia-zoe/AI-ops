// AI Org — the org command center (§5.1). Top-down bands: HUMANS -> AI EMPLOYEES -> ACTIVE WORK ->
// EXCEPTIONS -> OUTCOMES. A governance surface over Zoe's AI workforce; it SURFACES what the modules
// already compute and never fabricates. Owner/admin only; $ metrics reuse canSeeFinancials.

import Link from "next/link";
import { redirect } from "next/navigation";
import { AutoRefresh } from "@/components/AutoRefresh";
import { viewerRole } from "@/lib/auth/getSession";
import { canManageSettings, canSeeFinancials } from "@/lib/auth/roles";
import { aiOrg } from "@/lib/aiorg/service";
import { HUMANS } from "@/lib/aiorg/registry";
import { FigureStrip, type Figure } from "@/components/console-primitives";
import { BackingBadge, HealthMark, MetricRow, OrgTabs, StateDot } from "@/components/aiorg/AiOrgBits";

export const dynamic = "force-dynamic";

const DEPT_LABEL: Record<string, string> = { sales: "Sales", backoffice: "Back Office", marketing: "Marketing", ops_exec: "Ops / Exec" };
const P_TONE: Record<string, string> = { P0: "text-critical", P1: "text-attention", P2: "text-attention", P3: "text-meta" };

function ago(ts: string): string {
  const min = Math.max(0, Math.round((Date.now() - Date.parse(ts)) / 60_000));
  if (!Number.isFinite(min)) return "";
  if (min < 60) return `${min}m ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export default async function AiOrgPage(): Promise<React.JSX.Element> {
  const role = await viewerRole();
  if (!canManageSettings(role)) redirect("/dashboard");
  const showMoney = canSeeFinancials(role);
  const org = await aiOrg({ showMoney });

  const figures: Figure[] = [
    { label: "Live", value: org.counts.live, tone: "positive" },
    { label: "Seed", value: org.counts.seed, tone: org.counts.seed ? "attention" : "default" },
    { label: "Partial", value: org.counts.partial },
    { label: "Coming", value: org.counts.coming },
    { label: "Exceptions", value: org.exceptions.length, tone: org.exceptions.length ? "attention" : "default", sep: true },
  ];

  return (
    <main className="p-6">
      <AutoRefresh seconds={90} />
      <header className="mb-4 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-[22px] font-medium tracking-tight">AI Org</h1>
          <p className="text-[12.5px] text-meta">The control plane over Zoe&apos;s AI workforce. Rules calculate, AI interprets, humans decide. Read and draft only.</p>
        </div>
        <FigureStrip figures={figures} />
      </header>

      <OrgTabs active="/ai-org" />

      {/* ── HUMANS ── */}
      <Band title="Humans">
        <div className="grid gap-px overflow-hidden border border-border bg-border sm:grid-cols-2 lg:grid-cols-4">
          {org.humans.map((h) => (
            <div key={h.name} className="bg-panel p-4">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-[14px] font-medium text-foreground">{h.name}</span>
                <span className="text-[10.5px] uppercase tracking-[0.08em] text-meta">{h.role}</span>
              </div>
              <div className="mt-3 flex flex-wrap gap-1.5">
                {h.employees.map((e) => (
                  <Link key={e.id} href={`/ai-org/${e.id}`} className="inline-flex items-center gap-1.5 rounded border border-border px-1.5 py-0.5 text-[11px] text-tertiary-text transition-colors hover:bg-[var(--row-hover)] hover:text-foreground" title={e.name}>
                    <StateDot state={e.state} /> {e.name}
                  </Link>
                ))}
              </div>
              <dl className="mt-3 grid grid-cols-3 gap-2 border-t border-[var(--row-rule)] pt-3 text-center">
                <Stat label="Agents" value={h.employeeCount} />
                <Stat label="Approvals" value={h.openApprovals} />
                <Stat label="Attention" value={h.openExceptions} tone={h.openExceptions ? "attention" : "default"} />
              </dl>
              <div className="mt-2 text-center text-[11px] text-meta">{h.aiActivityToday} action{h.aiActivityToday === 1 ? "" : "s"} today</div>
            </div>
          ))}
        </div>
      </Band>

      {/* ── AI EMPLOYEES ── */}
      <Band title="AI Employees">
        <div className="border border-border">
          {HUMANS.map((h) => {
            const mine = org.employees.filter((e) => e.owner === h.name);
            if (mine.length === 0) return null;
            return (
              <div key={h.name}>
                <div className="border-t border-[var(--row-rule)] bg-background px-3 py-1.5 text-[10.5px] font-medium uppercase tracking-[0.1em] text-meta first:border-t-0">{h.name}</div>
                {mine.map((e) => (
                  <Link key={e.id} href={`/ai-org/${e.id}`} className="flex flex-wrap items-center gap-x-4 gap-y-1.5 border-t border-[var(--row-rule)] px-3 py-2.5 transition-colors hover:bg-[var(--row-hover)]">
                    <StateDot state={e.state} />
                    <span className="w-[160px] shrink-0 text-[13.5px] font-medium text-foreground">{e.name}</span>
                    <span className="w-[84px] shrink-0 text-[11px] uppercase tracking-[0.06em] text-meta">{DEPT_LABEL[e.department]}</span>
                    <BackingBadge backing={e.backing} />
                    <span className="min-w-[120px] flex-1">
                      {e.backing === "coming" ? <span className="text-[12px] text-meta">Not wired yet — no data source</span> : <MetricRow metrics={e.metrics} />}
                    </span>
                    <HealthMark health={e.health} />
                  </Link>
                ))}
              </div>
            );
          })}
        </div>
      </Band>

      {/* ── ACTIVE WORK ── */}
      <Band title="Active work" subtitle="Recent attributed activity (sales audit trail)">
        {org.activeWork.length === 0 ? (
          <Empty>No recent AI activity recorded yet.</Empty>
        ) : (
          <div className="border border-border">
            {org.activeWork.slice(0, 12).map((a, i) => {
              const row = (
                <div className="flex items-center justify-between gap-3 px-3 py-2 text-[13px]">
                  <span className="min-w-0 truncate"><span className="text-foreground">{a.label}</span> <span className="text-meta">· {a.actor}</span></span>
                  <span className="shrink-0 text-[11.5px] tabular-nums text-meta">{ago(a.ts)}</span>
                </div>
              );
              return (
                <div key={`${a.ts}-${i}`} className="border-t border-[var(--row-rule)] transition-colors first:border-t-0 hover:bg-[var(--row-hover)]">
                  {a.href ? <Link href={a.href}>{row}</Link> : row}
                </div>
              );
            })}
          </div>
        )}
      </Band>

      {/* ── EXCEPTIONS ── */}
      <Band title="Exceptions" subtitle="The Priority / Exception filtered feed, highest signal first">
        {org.exceptions.length === 0 ? (
          <Empty>Nothing needs an owner right now.</Empty>
        ) : (
          <div className="border border-border">
            {org.exceptions.slice(0, 10).map((x) => (
              <Link key={x.key} href={x.href} className="flex items-start gap-3 border-t border-[var(--row-rule)] px-3 py-2.5 transition-colors first:border-t-0 hover:bg-[var(--row-hover)]">
                <span className={`w-7 shrink-0 text-[11px] font-semibold tabular-nums ${P_TONE[x.pLabel]}`}>{x.pLabel}</span>
                <span className="min-w-0">
                  <div className="text-[13.5px] font-medium text-foreground">{x.title}</div>
                  <div className="truncate text-[12px] text-meta" title={x.detail}>{x.detail}</div>
                </span>
              </Link>
            ))}
          </div>
        )}
      </Band>

      {/* ── OUTCOMES ── */}
      <Band title="Outcomes" subtitle="Measured value, only where a real metric exists">
        {org.outcomes.length === 0 ? (
          <Empty>No measured outcomes yet. Outcome tracking grows as each agent&apos;s execute path lands.</Empty>
        ) : (
          <div className="flex flex-wrap gap-3">
            {org.outcomes.map((o) => (
              <div key={o.label} className="rounded border border-border px-4 py-3">
                <div className="text-[20px] font-medium tabular-nums text-foreground">{o.value}</div>
                <div className="mt-0.5 text-[10.5px] uppercase tracking-[0.08em] text-meta">{o.label}</div>
                <div className="text-[11px] text-meta">{o.source}</div>
              </div>
            ))}
          </div>
        )}
      </Band>
    </main>
  );
}

function Band({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <section className="mb-8">
      <div className="mb-1.5 flex items-baseline gap-2">
        <h2 className="text-[13px] font-medium uppercase tracking-[0.1em] text-tertiary-text">{title}</h2>
        {subtitle && <span className="text-[11px] text-meta">· {subtitle}</span>}
      </div>
      {children}
    </section>
  );
}

function Stat({ label, value, tone = "default" }: { label: string; value: number; tone?: "attention" | "default" }): React.JSX.Element {
  return (
    <div>
      <div className={`text-[16px] font-medium tabular-nums ${tone === "attention" ? "text-attention" : "text-foreground"}`}>{value}</div>
      <div className="text-[9.5px] uppercase tracking-[0.07em] text-meta">{label}</div>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <p className="border border-border px-3 py-3 text-[13px] text-muted-foreground">{children}</p>;
}
