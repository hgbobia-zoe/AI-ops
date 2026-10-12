// Employee Lifecycle Detail — the per-person provisioning board. Info + role + dates + access policy, the
// provisioning-actions table (System | Mode | Status | Action) driven entirely by the policy + tasks (never
// hard-coded), completion % + blockers, outstanding-revokes callout, and the audit history. Owner/admin
// only. RULES CALCULATE; this renders + triggers the engine via the client action components.

import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ArrowLeft, CheckCircle2, AlertTriangle, Mail, Link2 } from "lucide-react";
import { viewerRole } from "@/lib/auth/getSession";
import { canManageUsers } from "@/lib/auth/roles";
import { tableCls, theadCls, thCls, tdCls, rowCls } from "@/components/console-primitives";
import { getEmployee, getPolicy, listEmployeeAudit, listTasks } from "@/lib/people/store";
import { computeReadiness } from "@/lib/people/lifecycle";
import { LifecycleActions } from "@/components/people/LifecycleActions";
import { TaskActions } from "@/components/people/TaskActions";
import type { LifecycleTask } from "@/lib/people/types";

export const dynamic = "force-dynamic";

const MODE_LABEL: Record<string, string> = { automated: "Automated", partial: "Partial", manual: "Manual", future: "Future" };
const STATUS_TONE: Record<string, string> = {
  completed: "text-positive",
  failed: "text-critical",
  blocked: "text-critical",
  manual_required: "text-attention",
  pending: "text-attention",
  in_progress: "text-attention",
  skipped: "text-meta",
};

export default async function EmployeeDetailPage({ params }: { params: Promise<{ id: string }> }): Promise<React.JSX.Element> {
  const role = await viewerRole();
  if (!canManageUsers(role)) redirect("/dashboard");
  const { id } = await params;
  const emp = getEmployee(id);
  if (!emp) notFound();

  const policy = emp.department ? getPolicy(emp.department) : null;
  const provision = listTasks(emp.id, "provision");
  const revoke = listTasks(emp.id, "revoke");
  const readiness = computeReadiness(provision);
  const audit = listEmployeeAudit(emp.id, 60);

  return (
    <main className="mx-auto max-w-[1100px] p-3 pb-10 leading-[1.3] md:p-4">
      <Link href="/people" className="mb-3 inline-flex items-center gap-1.5 text-[12px] text-meta hover:text-foreground"><ArrowLeft className="size-3.5" /> People Lifecycle</Link>

      <header className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-[22px] font-semibold tracking-tight">{emp.displayName}</h1>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12.5px] text-meta">
            <span className="rounded border border-border px-1.5 py-0.5 text-[11px] uppercase tracking-[0.06em] text-foreground">{emp.lifecycleState}</span>
            <span>Role: {emp.role}</span>
            <span>Policy: {policy?.name ?? emp.department ?? "—"}</span>
            {emp.workEmail && <span className="inline-flex items-center gap-1"><Mail className="size-3.5" /> {emp.workEmail}</span>}
            {emp.startDate && <span>Start {emp.startDate}</span>}
            {emp.endDate && <span className="text-attention">End {emp.endDate}</span>}
          </div>
        </div>
        <LifecycleActions id={emp.id} state={emp.lifecycleState} />
      </header>

      {/* Readiness summary */}
      <section className="mb-5 rounded-lg border border-border bg-[var(--panel)] p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          {readiness.ready
            ? <span className="inline-flex items-center gap-2 text-[15px] font-semibold text-positive"><CheckCircle2 className="size-4" /> READY — all required access provisioned</span>
            : <span className="inline-flex items-center gap-2 text-[15px] font-semibold text-critical"><AlertTriangle className="size-4" /> NOT READY — {readiness.blockers.length} BLOCKER{readiness.blockers.length === 1 ? "" : "S"}</span>}
          <span className="text-[12.5px] text-meta">{readiness.completed}/{readiness.totalRequired} required · {readiness.completionPct}% of all steps</span>
        </div>
        <div className="mt-2 h-2 w-full overflow-hidden rounded bg-[var(--row)]"><div className="h-full bg-foreground/60" style={{ width: `${readiness.completionPct}%` }} /></div>
        {readiness.blockers.length > 0 && (
          <p className="mt-2 text-[12px] text-meta">Blocked on: {readiness.blockers.map((b) => `${b.system} (${b.status})`).join(", ")}</p>
        )}
      </section>

      <TaskTable title="Provisioning (onboarding)" tasks={provision} />
      {revoke.length > 0 && <TaskTable title="De-provisioning (offboarding)" tasks={revoke} note="OFFBOARDED does not auto-complete these — manual revokes stay open until a human confirms." />}

      {/* Identity links */}
      <section className="mb-5">
        <h2 className="mb-2 text-[12.5px] font-medium uppercase tracking-[0.08em] text-tertiary-text"><Link2 className="mr-1.5 inline size-3.5" /> Linked identities</h2>
        <div className="grid gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-2 lg:grid-cols-3 text-[12.5px]">
          {([
            ["Zoe login", emp.userId],
            ["HR worker", emp.hrWorkerId],
            ["Connecteam", emp.connecteamUserId],
            ["Quo / OpenPhone", emp.openphoneUserId],
            ["Gusto", emp.gustoId],
            ["AI-org human", emp.aiOrgHumanName],
          ] as [string, string | number | null][]).map(([label, val]) => (
            <div key={label} className="flex items-center justify-between gap-2 bg-[var(--panel)] px-3 py-2">
              <span className="text-meta">{label}</span>
              <span className={val ? "text-foreground" : "text-meta"}>{val ?? "—"}</span>
            </div>
          ))}
        </div>
      </section>

      {/* Audit history */}
      <section>
        <h2 className="mb-2 text-[12.5px] font-medium uppercase tracking-[0.08em] text-tertiary-text">Audit history</h2>
        {audit.length === 0 ? (
          <p className="text-[12.5px] text-meta">No recorded actions yet.</p>
        ) : (
          <ul className="divide-y divide-[var(--row-rule)] rounded-lg border border-border bg-[var(--panel)]">
            {audit.map((a, i) => (
              <li key={i} className="flex items-center justify-between gap-3 px-3 py-2">
                <span className="text-[12.5px] text-foreground">{a.action.replace(/_/g, " ")}{a.detail?.detail ? <span className="ml-2 text-[11.5px] text-meta">{String(a.detail.detail)}</span> : null}</span>
                <span className="shrink-0 text-right text-[11px] text-meta">{a.actor} · {new Date(a.ts).toLocaleString()}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}

function TaskTable({ title, tasks, note }: { title: string; tasks: LifecycleTask[]; note?: string }): React.JSX.Element {
  return (
    <section className="mb-5">
      <h2 className="mb-2 text-[12.5px] font-medium uppercase tracking-[0.08em] text-tertiary-text">{title}</h2>
      {note && <p className="mb-2 text-[12px] text-attention">{note}</p>}
      {tasks.length === 0 ? (
        <p className="text-[12.5px] text-meta">No tasks — start onboarding to materialize them from the policy.</p>
      ) : (
        <div className="overflow-hidden rounded-lg border border-border">
          <table className={tableCls}>
            <thead className={theadCls}>
              <tr>
                <th className={`${thCls} w-[34%]`}>System</th>
                <th className={`${thCls} w-[14%]`}>Mode</th>
                <th className={`${thCls} w-[20%]`}>Status</th>
                <th className={`${thCls}`}>Action</th>
              </tr>
            </thead>
            <tbody>
              {tasks.map((t) => (
                <tr key={t.id} className={rowCls}>
                  <td className={tdCls}>
                    <div className="text-foreground">{t.system}</div>
                    {t.required && <div className="text-[10.5px] uppercase tracking-[0.05em] text-meta">required</div>}
                    {t.externalRef && <div className="truncate text-[11px] text-positive">{t.externalRef}</div>}
                  </td>
                  <td className={tdCls}><span className="text-[12px] text-meta">{MODE_LABEL[t.mode] ?? t.mode}</span></td>
                  <td className={tdCls}><span className={`text-[12.5px] ${STATUS_TONE[t.status] ?? "text-foreground"}`}>{t.status.replace(/_/g, " ")}</span>{t.error && <div className="text-[11px] text-critical">{t.error}</div>}</td>
                  <td className={tdCls}><TaskActions task={{ id: t.id, mode: t.mode, kind: t.kind, status: t.status, required: t.required }} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
