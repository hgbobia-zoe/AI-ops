// People Lifecycle — onboarding & offboarding command surface. Owner/admin only (canManageUsers; the proxy
// also gates /people). In-page tabs: Onboarding queue · Offboarding · Access policies · Activity. FACTS
// ONLY — statuses + systems come from the access-policy config + the lifecycle tasks, never hard-coded.
// RULES CALCULATE (the engine); this renders.

import Link from "next/link";
import { redirect } from "next/navigation";
import { Contact, UserPlus, LogOut, ShieldCheck, History, ArrowRight, AlertTriangle, CheckCircle2 } from "lucide-react";
import { viewerRole } from "@/lib/auth/getSession";
import { canManageUsers } from "@/lib/auth/roles";
import { FigureStrip, StatusMark } from "@/components/console-primitives";
import { peopleOverview, type EmployeeSummary } from "@/lib/people/overview";
import { listPolicies } from "@/lib/people/store";
import { getRecentAudit } from "@/lib/db/repo";
import { NewEmployeeForm } from "@/components/people/NewEmployeeForm";

export const dynamic = "force-dynamic";

type Tab = "onboarding" | "offboarding" | "policies" | "activity";
const TABS: { key: Tab; label: string; icon: React.ReactNode }[] = [
  { key: "onboarding", label: "Onboarding", icon: <UserPlus className="size-3.5" /> },
  { key: "offboarding", label: "Offboarding", icon: <LogOut className="size-3.5" /> },
  { key: "policies", label: "Access Policies", icon: <ShieldCheck className="size-3.5" /> },
  { key: "activity", label: "Activity", icon: <History className="size-3.5" /> },
];

const MODE_LABEL: Record<string, string> = { automated: "Automated", partial: "Partial", manual: "Manual", future: "Future" };

export default async function PeoplePage({ searchParams }: { searchParams: Promise<{ tab?: string }> }): Promise<React.JSX.Element> {
  const role = await viewerRole();
  if (!canManageUsers(role)) redirect("/dashboard");
  const sp = await searchParams;
  const tab: Tab = (TABS.some((t) => t.key === sp.tab) ? sp.tab : "onboarding") as Tab;

  const ov = peopleOverview();
  const policies = listPolicies();

  return (
    <main className="mx-auto max-w-[1200px] p-3 pb-10 leading-[1.3] md:p-4">
      <header className="mb-3">
        <h1 className="flex items-center gap-2 text-[22px] font-semibold tracking-tight"><Contact className="size-5 text-meta" /> People Lifecycle</h1>
        <p className="mt-1 text-[12.5px] text-meta">Onboarding &amp; offboarding with honest, audited access provisioning. Only the Zoe platform login is automated today; every other system is a tracked manual step.</p>
      </header>

      <div className="mb-4">
        <FigureStrip figures={[
          { label: "People", value: ov.counts.total },
          { label: "Active", value: ov.counts.active, tone: "positive" },
          { label: "Onboarding", value: ov.counts.onboarding, sep: true },
          { label: "Offboarding", value: ov.counts.offboarding },
          { label: "Open revokes", value: ov.counts.outstandingRevokes, tone: ov.counts.outstandingRevokes > 0 ? "attention" : "default", sep: true },
        ]} />
      </div>

      <nav className="mb-4 flex flex-wrap gap-1 border-b border-border">
        {TABS.map((t) => (
          <Link key={t.key} href={`/people?tab=${t.key}`}
            className={`-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-[12.5px] font-medium transition-colors ${
              tab === t.key ? "border-foreground text-foreground" : "border-transparent text-meta hover:text-foreground"
            }`}>
            {t.icon} {t.label}
          </Link>
        ))}
      </nav>

      {tab === "onboarding" && (
        <div className="flex flex-col gap-5">
          <NewEmployeeForm policies={policies.map((p) => ({ id: p.id, name: p.name }))} />
          <QueueGroup title="Starting soon" tone="idle" people={ov.startingSoon} empty="No upcoming hires." />
          <QueueGroup title="Onboarding" tone="attention" people={ov.onboarding} empty="No one mid-onboarding." />
          <QueueGroup title="Blocked" tone="critical" people={ov.blocked} empty="No blocked onboardings." />
          <QueueGroup title="Ready" tone="positive" people={ov.ready} empty="No one ready to activate." />
          <QueueGroup title="Active" tone="positive" people={ov.active} empty="No active employees yet." />
        </div>
      )}

      {tab === "offboarding" && (
        <div className="flex flex-col gap-5">
          <p className="rounded-md border border-attention/30 bg-attention/[0.06] px-3 py-2 text-[12px] text-attention">
            OFFBOARDED means the HR process is done — it does NOT mean every access was removed. Manual revokes stay open + escalating until a human confirms them.
          </p>
          <QueueGroup title="Offboarding in progress" tone="attention" people={ov.offboarding} empty="No one offboarding." showRevokes />
          <QueueGroup title="Offboarded" tone="idle" people={ov.offboarded} empty="No offboarded employees." showRevokes />
        </div>
      )}

      {tab === "policies" && (
        <div className="flex flex-col gap-4">
          <p className="text-[12.5px] text-meta">Seeded, config-driven policies. A rule&apos;s mode is the HONEST capability — not a promise the UI invents. Editing is read-only in Phase 1.</p>
          {policies.map((p) => (
            <section key={p.id} className="rounded-lg border border-border bg-[var(--panel)] p-4">
              <h3 className="mb-2 flex items-center gap-2 text-[14px] font-medium">{p.name} <span className="text-[11px] uppercase tracking-[0.06em] text-meta">{p.seeded ? "seeded" : "custom"}</span></h3>
              <div className="grid gap-px overflow-hidden rounded border border-border bg-border sm:grid-cols-2">
                {p.rules.map((r) => (
                  <div key={r.adapterId} className="flex items-center justify-between gap-2 bg-[var(--panel)] px-3 py-2">
                    <span className="text-[13px] text-foreground">{r.system}{r.required && <span className="ml-1.5 text-[10px] uppercase text-meta">required</span>}</span>
                    <ModeBadge mode={r.mode} />
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}

      {tab === "activity" && (
        <div className="rounded-lg border border-border bg-[var(--panel)]">
          <ActivityList />
        </div>
      )}
    </main>
  );
}

function ModeBadge({ mode }: { mode: string }): React.JSX.Element {
  const tone = mode === "automated" ? "border-positive/40 text-positive" : mode === "partial" ? "border-attention/40 text-attention" : "border-border text-meta";
  return <span className={`rounded border px-1.5 py-0.5 text-[10.5px] font-medium uppercase tracking-[0.05em] ${tone}`}>{MODE_LABEL[mode] ?? mode}</span>;
}

function QueueGroup({ title, tone, people, empty, showRevokes }: { title: string; tone: "idle" | "attention" | "critical" | "positive"; people: EmployeeSummary[]; empty: string; showRevokes?: boolean }): React.JSX.Element {
  return (
    <section>
      <h2 className="mb-2 flex items-center gap-2 text-[12.5px] font-medium uppercase tracking-[0.08em] text-tertiary-text"><StatusMark tone={tone} label={`${title} · ${people.length}`} /></h2>
      {people.length === 0 ? (
        <p className="text-[12.5px] text-meta">{empty}</p>
      ) : (
        <div className="grid gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-2 lg:grid-cols-3">
          {people.map((s) => <EmployeeCard key={s.employee.id} s={s} showRevokes={showRevokes} />)}
        </div>
      )}
    </section>
  );
}

function EmployeeCard({ s, showRevokes }: { s: EmployeeSummary; showRevokes?: boolean }): React.JSX.Element {
  const e = s.employee;
  const ready = s.readiness.ready;
  const isOnboarding = e.lifecycleState === "ONBOARD";
  return (
    <Link href={`/people/${e.id}`} className="flex flex-col gap-2 bg-[var(--panel)] p-4 transition-colors hover:bg-[var(--row-hover)]">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-[14px] font-medium text-foreground">{e.displayName}</div>
          <div className="mt-0.5 text-[11px] uppercase tracking-[0.06em] text-meta">{e.department ?? "no policy"} · {e.lifecycleState}</div>
        </div>
      </div>
      {isOnboarding && (
        ready
          ? <span className="inline-flex w-fit items-center gap-1.5 rounded bg-positive/10 px-2 py-1 text-[12px] font-semibold text-positive"><CheckCircle2 className="size-3.5" /> READY</span>
          : <span className="inline-flex w-fit items-center gap-1.5 rounded bg-critical/10 px-2 py-1 text-[12px] font-semibold text-critical"><AlertTriangle className="size-3.5" /> NOT READY — {s.readiness.blockers.length} BLOCKER{s.readiness.blockers.length === 1 ? "" : "S"}</span>
      )}
      {isOnboarding && (
        <div className="h-1.5 w-full overflow-hidden rounded bg-[var(--row)]">
          <div className="h-full bg-foreground/60" style={{ width: `${s.readiness.completionPct}%` }} />
        </div>
      )}
      {showRevokes && (
        s.outstandingRevokes > 0
          ? <span className="text-[12px] text-attention">{s.outstandingRevokes} access revoke{s.outstandingRevokes === 1 ? "" : "s"} still open</span>
          : <span className="text-[12px] text-positive">All access revoked</span>
      )}
      <span className="mt-auto inline-flex items-center gap-1 text-[11.5px] text-meta">Open <ArrowRight className="size-3" /></span>
    </Link>
  );
}

function ActivityList(): React.JSX.Element {
  const rows = getRecentAudit(["ONBOARDING_STARTED", "MARKED_READY", "ACTIVATED", "OFFBOARDING_STARTED", "OFFBOARDED", "ACCESS_GRANTED", "ACCESS_REVOKED", "TASK_RETRIED", "TASK_SKIPPED"], 80);
  if (rows.length === 0) return <p className="p-4 text-[12.5px] text-meta">No lifecycle activity yet.</p>;
  return (
    <ul className="divide-y divide-[var(--row-rule)]">
      {rows.map((r) => (
        <li key={r.auditId} className="flex items-center justify-between gap-3 px-4 py-2.5">
          <div className="min-w-0">
            <span className="text-[12.5px] font-medium text-foreground">{r.action.replace(/_/g, " ")}</span>
            <span className="ml-2 text-[11.5px] text-meta">{r.entityId}</span>
          </div>
          <div className="shrink-0 text-right">
            <div className="text-[11.5px] text-secondary-text">{r.actor}</div>
            <div className="text-[10.5px] text-meta">{new Date(r.ts).toLocaleString()}</div>
          </div>
        </li>
      ))}
    </ul>
  );
}
