// AI Org — the org command center (§5.1), slimmed to an EXEC OVERVIEW. The detailed per-agent presence now
// lives INSIDE each blade (the BladeAgents strip); this landing is the per-human manager rollup, org-wide
// pending approvals, the ranked exceptions feed and measured outcomes — fewer, higher-signal elements, not
// a wall of 19 agent cards. The full roster stays at /ai-org/employees. Owner/admin only; $ reuses canSeeFinancials.

import Link from "next/link";
import { redirect } from "next/navigation";
import { AutoRefresh } from "@/components/AutoRefresh";
import { viewerRole } from "@/lib/auth/getSession";
import { canManageSettings, canSeeFinancials } from "@/lib/auth/roles";
import { aiOrg } from "@/lib/aiorg/service";
import { AI_EMPLOYEES, HUMANS } from "@/lib/aiorg/registry";
import { authoritySplit } from "@/lib/aiorg/types";
import { buildOrgTree, type OrgAgentInput } from "@/lib/aiorg/orgTree";
import { OrgChart } from "@/components/aiorg/OrgChart";
import { FigureStrip, type Figure } from "@/components/console-primitives";
import { OrgTabs, StateDot } from "@/components/aiorg/AiOrgBits";

export const dynamic = "force-dynamic";

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

  const totalApprovals = org.humans.reduce((n, h) => n + h.openApprovals, 0);

  // The org chart (the first thing you see here now). Same enriched tree the AI Employees tab renders, so
  // a tile click opens the full detail panel. Real data throughout (honest backing/state carried through).
  const cfgById = new Map(AI_EMPLOYEES.map((c) => [c.id, c]));
  const agents: OrgAgentInput[] = org.employees.map((e) => {
    const c = cfgById.get(e.id);
    const split = c ? authoritySplit(c.toolbox) : { can: [], requiresApproval: [] };
    return {
      id: e.id,
      name: e.name,
      department: e.department,
      backing: e.backing,
      state: e.state,
      mission: e.mission,
      responsibilities: c?.responsibilities ?? [],
      inputs: (c?.inputs ?? []).map((i) => ({ label: i.label, href: i.href })),
      canCount: split.can.length,
      approvalCount: split.requiresApproval.length,
      metrics: e.metrics.map((m) => ({ label: m.label, value: m.value, tone: m.tone })),
      lastRunAt: e.lastRunAt,
      valueMeasure: c?.valueMeasure ?? "",
      paused: e.paused,
    };
  });
  const tree = buildOrgTree(HUMANS, agents);
  const canManage = canManageSettings(role);

  const figures: Figure[] = [
    { label: "Live", value: org.counts.live, tone: "positive" },
    { label: "Seed", value: org.counts.seed, tone: org.counts.seed ? "attention" : "default" },
    { label: "Partial", value: org.counts.partial },
    { label: "Coming", value: org.counts.coming },
    { label: "Approvals", value: totalApprovals, tone: totalApprovals ? "attention" : "default", sep: true },
    { label: "Exceptions", value: org.exceptions.length, tone: org.exceptions.length ? "attention" : "default" },
  ];

  return (
    <main className="p-6">
      <AutoRefresh seconds={90} />
      <header className="mb-4 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-[22px] font-medium tracking-tight">AI Org</h1>
          <p className="text-[12.5px] text-meta">Exec overview of Zoe&apos;s AI workforce. Each AI team now works inside its own blade; this is the manager rollup, approvals and exceptions. Rules calculate, AI interprets, humans decide.</p>
        </div>
        <FigureStrip figures={figures} />
      </header>

      <OrgTabs active="/ai-org" />

      {/* ── ORG CHART (the headline — the real top-down tree, click a tile for detail) ── */}
      <Band title="Org chart" subtitle="Ownership, team leads, and the AI employees reporting to each — click any tile for detail">
        <OrgChart tree={tree} canManage={canManage} />
      </Band>

      {/* ── MANAGERS (per-human rollup) ── */}
      <Band title="Managers" subtitle="Each human and the AI team they own — open the agent in context from its blade">
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

      {/* ── APPROVALS + ROSTER (where the detail now lives) ── */}
      <Band title="Pending approvals" subtitle="AI-prepared actions awaiting a human decision">
        <div className="flex flex-wrap items-center gap-4 border border-border px-4 py-3 text-[13px]">
          <span className="text-[20px] font-medium tabular-nums text-foreground">{totalApprovals}</span>
          <span className="text-meta">{totalApprovals === 1 ? "action waits" : "actions wait"} for approve / reject / edit.</span>
          <Link href="/ai-org/approvals" className="ml-auto text-[12.5px] text-tertiary-text transition-colors hover:text-foreground">Open Approvals →</Link>
        </div>
        <p className="mt-2 text-[12px] text-meta">Per-agent detail now lives inside each blade (the &ldquo;AI employees working here&rdquo; strip). The full roster is at <Link href="/ai-org/employees" className="text-tertiary-text underline-offset-2 hover:text-foreground hover:underline">AI Employees</Link>.</p>
      </Band>

      {/* ── ACTIVE WORK ── */}
      <Band title="Active work" subtitle="Recent attributed activity (sales audit trail)">
        {org.activeWork.length === 0 ? (
          <Empty>No recent AI activity recorded yet.</Empty>
        ) : (
          <div className="border border-border">
            {org.activeWork.slice(0, 6).map((a, i) => {
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
