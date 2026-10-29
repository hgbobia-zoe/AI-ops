// Employee Lifecycle Detail — the per-person provisioning board. Organized into identity + employment/
// lifecycle state, the readiness summary, the ACCESS CHECKLIST (the provisioning actions, driven entirely
// by the policy + tasks — never hard-coded), the de-provisioning checklist when offboarding, the linked
// identities (owners/evidence), and the audit history. Owner/admin only.
//
// HONESTY is central: each checklist row names whether the access is Automated (a real in-app capability,
// Zoe only) or a Manual tracked step in another system — and a manual "Mark complete" is a human attesting
// they did it, never a faked "provisioned" state. OFFBOARDED does not auto-complete revokes. RULES
// CALCULATE; this renders + triggers the engine via the client action components.

import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import {
  ArrowLeft, Mail, Phone, Link2, Calendar, ShieldCheck, History, ListChecks, LogOut,
} from "lucide-react";
import { viewerRole } from "@/lib/auth/getSession";
import { canManageUsers } from "@/lib/auth/roles";
import { Surface } from "@/components/ui/surface";
import { StatusBadge } from "@/components/ui/status";
import { StatusBanner } from "@/components/ui/states";
import {
  compactTableFrameCls, compactTableCls, compactTheadRowCls, compactThCls, compactRowCls,
} from "@/components/console-primitives";
import { getEmployee, getPolicy, listEmployeeAudit, listTasks } from "@/lib/people/store";
import { computeReadiness } from "@/lib/people/lifecycle";
import type { Tone } from "@/lib/tone";
import type { LifecycleState, LifecycleTask, TaskStatus, AdapterMode } from "@/lib/people/types";
import { LifecycleActions } from "@/components/people/LifecycleActions";
import { TaskActions } from "@/components/people/TaskActions";

export const dynamic = "force-dynamic";

const STATE_LABEL: Record<LifecycleState, string> = {
  HIRE: "Starting soon", ONBOARD: "Onboarding", READY: "Ready", ACTIVE: "Active", OFFBOARD: "Offboarding", OFFBOARDED: "Offboarded",
};
const STATE_TONE: Record<LifecycleState, Tone> = {
  HIRE: "neutral", ONBOARD: "attention", READY: "positive", ACTIVE: "positive", OFFBOARD: "attention", OFFBOARDED: "neutral",
};
const STATUS_TONE: Record<TaskStatus, Tone> = {
  completed: "positive", failed: "critical", blocked: "critical", manual_required: "attention", pending: "neutral", in_progress: "info", skipped: "neutral",
};
const STATUS_LABEL: Record<TaskStatus, string> = {
  completed: "Completed", failed: "Failed", blocked: "Blocked", manual_required: "Manual required", pending: "Pending approval", in_progress: "In progress", skipped: "Skipped",
};
// The honest access-type label per adapter mode — automated is a real Zoe in-app capability; the rest are
// tracked steps a human performs in the external system.
const ACCESS_TYPE: Record<AdapterMode, { label: string; hint: string }> = {
  automated: { label: "Automated · Zoe", hint: "Performed in-app behind the approval gate" },
  partial: { label: "Partial", hint: "Some steps automatable; a human finishes it" },
  manual: { label: "Manual step", hint: "A human does it in the external system, then marks it complete" },
  future: { label: "Future", hint: "No admin API yet — tracked as a manual step for now" },
};

function relTime(iso: string | null): string {
  if (!iso) return "—";
  const d = Date.parse(iso);
  if (!Number.isFinite(d)) return "—";
  const m = Math.round((Date.now() - d) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

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
  const openRevokes = revoke.filter((t) => t.status !== "completed" && t.status !== "skipped").length;

  return (
    <main className="mx-auto max-w-[1120px] p-3 pb-12 leading-[1.35] md:p-5">
      <Link href="/people" className="mb-3 inline-flex items-center gap-1.5 text-[12px] text-meta transition-colors hover:text-foreground">
        <ArrowLeft className="size-3.5" aria-hidden /> People Lifecycle
      </Link>

      {/* Identity + lifecycle state + the valid transitions */}
      <header className="mb-5 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2.5">
            <h1 className="text-[22px] font-semibold tracking-tight text-foreground">{emp.displayName}</h1>
            <StatusBadge tone={STATE_TONE[emp.lifecycleState]}>{STATE_LABEL[emp.lifecycleState]}</StatusBadge>
          </div>
          <dl className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12.5px] text-meta">
            <div className="inline-flex items-center gap-1.5"><ShieldCheck className="size-3.5" aria-hidden /> <span className="capitalize text-secondary-text">{emp.role}</span></div>
            <div className="inline-flex items-center gap-1.5">Policy: <span className="text-secondary-text">{policy?.name ?? emp.department ?? "—"}</span></div>
            {emp.workEmail && <div className="inline-flex items-center gap-1.5"><Mail className="size-3.5" aria-hidden /> {emp.workEmail}</div>}
            {emp.phone && <div className="inline-flex items-center gap-1.5"><Phone className="size-3.5" aria-hidden /> {emp.phone}</div>}
            {emp.startDate && <div className="inline-flex items-center gap-1.5"><Calendar className="size-3.5" aria-hidden /> Start {emp.startDate}</div>}
            {emp.endDate && <div className="inline-flex items-center gap-1.5 text-attention"><Calendar className="size-3.5" aria-hidden /> End {emp.endDate}</div>}
          </dl>
        </div>
        <LifecycleActions id={emp.id} state={emp.lifecycleState} name={emp.displayName} openRevokes={openRevokes} />
      </header>

      {/* Readiness summary */}
      <Surface className="mb-5" aria-labelledby="readiness-h">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id="readiness-h" className="sr-only">Onboarding readiness</h2>
          {readiness.ready
            ? <StatusBadge tone="positive">Ready — all required access provisioned</StatusBadge>
            : <StatusBadge tone={readiness.blockers.some((b) => b.status === "failed") ? "critical" : "attention"}>
                Not ready — {readiness.blockers.length} blocker{readiness.blockers.length === 1 ? "" : "s"}
              </StatusBadge>}
          <span className="text-[12px] text-meta tabular-nums">{readiness.completed}/{readiness.totalRequired} required · {readiness.completionPct}% of all steps</span>
        </div>
        <div className="mt-2.5 h-2 w-full overflow-hidden rounded bg-[var(--row)]">
          <div className="h-full bg-foreground/55" style={{ width: `${readiness.completionPct}%` }} />
        </div>
        {readiness.blockers.length > 0 && (
          <p className="mt-2.5 text-[12px] text-secondary-text">
            Blocked on: {readiness.blockers.map((b) => `${b.system} (${STATUS_LABEL[b.status as TaskStatus] ?? b.status})`).join(", ")}
          </p>
        )}
      </Surface>

      <ChecklistTable
        title="Access checklist · onboarding"
        icon={<ListChecks className="size-4 text-meta" aria-hidden />}
        tasks={provision}
        emptyLabel="No tasks — start onboarding to materialize the checklist from the policy."
      />

      {revoke.length > 0 && (
        <ChecklistTable
          title="De-provisioning · offboarding"
          icon={<LogOut className="size-4 text-meta" aria-hidden />}
          tasks={revoke}
          note={<StatusBanner tone={openRevokes > 0 ? "attention" : "neutral"} title="Revokes are tracked, not implied" edge={false}>
            Marking someone offboarded does not complete these. Each manual revoke stays open until a human confirms it in the external system.
          </StatusBanner>}
          emptyLabel="No revoke tasks."
        />
      )}

      {/* Linked identities — owners/evidence */}
      <section className="mb-6">
        <h2 className="mb-2 flex items-center gap-1.5 text-[11.5px] font-medium uppercase tracking-[0.08em] text-tertiary-text"><Link2 className="size-3.5" aria-hidden /> Linked identities</h2>
        <div className="grid gap-px overflow-hidden rounded-lg border border-border bg-border text-[12.5px] sm:grid-cols-2 lg:grid-cols-3">
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
              <span className={val ? "truncate text-foreground" : "text-meta"}>{val ?? "not linked"}</span>
            </div>
          ))}
        </div>
      </section>

      {/* Audit history */}
      <section>
        <h2 className="mb-2 flex items-center gap-1.5 text-[11.5px] font-medium uppercase tracking-[0.08em] text-tertiary-text"><History className="size-3.5" aria-hidden /> Audit history</h2>
        {audit.length === 0 ? (
          <Surface className="text-[12.5px] text-meta">No recorded actions yet.</Surface>
        ) : (
          <Surface pad="none" className="divide-y divide-[var(--row-rule)] overflow-hidden">
            {audit.map((a, i) => (
              <div key={i} className="flex items-center justify-between gap-3 px-3.5 py-2.5">
                <span className="min-w-0 text-[12.5px] text-foreground">
                  {a.action.replace(/_/g, " ").toLowerCase()}
                  {a.detail?.detail ? <span className="ml-2 text-[11.5px] text-meta">{String(a.detail.detail)}</span> : null}
                </span>
                <span className="shrink-0 text-right text-[11px] text-meta">{a.actor} · {new Date(a.ts).toLocaleString()}</span>
              </div>
            ))}
          </Surface>
        )}
      </section>
    </main>
  );
}

function ChecklistTable({ title, icon, tasks, note, emptyLabel }: {
  title: string; icon: React.ReactNode; tasks: LifecycleTask[]; note?: React.ReactNode; emptyLabel: string;
}): React.JSX.Element {
  return (
    <section className="mb-5">
      <h2 className="mb-2 flex items-center gap-1.5 text-[11.5px] font-medium uppercase tracking-[0.08em] text-tertiary-text">{icon} {title}</h2>
      {note && <div className="mb-2.5">{note}</div>}
      {tasks.length === 0 ? (
        <Surface className="text-[12.5px] text-meta">{emptyLabel}</Surface>
      ) : (
        <div className={compactTableFrameCls}>
          <table className={`${compactTableCls} min-w-[720px]`}>
            <thead>
              <tr className={compactTheadRowCls}>
                <th className={`${compactThCls} w-[26%]`}>System</th>
                <th className={`${compactThCls} w-[18%]`}>Access type</th>
                <th className={`${compactThCls} w-[18%]`}>Status</th>
                <th className={`${compactThCls} w-[20%]`}>Evidence</th>
                <th className={`${compactThCls} text-right`}>Action</th>
              </tr>
            </thead>
            <tbody>
              {tasks.map((t) => {
                const access = ACCESS_TYPE[t.mode];
                return (
                  <tr key={t.id} className={compactRowCls}>
                    <td className="px-3 py-2.5 align-top">
                      <div className="font-medium text-foreground">{t.system}</div>
                      <div className="text-[10.5px] uppercase tracking-[0.05em] text-meta">{t.required ? "required" : "optional"}</div>
                    </td>
                    <td className="px-3 py-2.5 align-top">
                      <div className={t.mode === "automated" ? "font-medium text-foreground" : "text-secondary-text"}>{access.label}</div>
                      <div className="text-[10.5px] text-meta">{access.hint}</div>
                    </td>
                    <td className="px-3 py-2.5 align-top">
                      <StatusBadge tone={STATUS_TONE[t.status]} size="sm" animated={t.status === "in_progress"}>{STATUS_LABEL[t.status]}</StatusBadge>
                      {t.error && <div className="mt-0.5 text-[11px] text-critical">{t.error}</div>}
                    </td>
                    <td className="px-3 py-2.5 align-top text-[11.5px] text-meta">
                      {t.externalRef && <div className="truncate text-positive" title={t.externalRef}>{t.externalRef}</div>}
                      {t.status === "completed" && t.actor && <div>by {t.actor}{t.source === "automated" ? " · automated" : " · manual"}</div>}
                      {t.completedAt && <div>{relTime(t.completedAt)}</div>}
                      {!t.externalRef && t.status !== "completed" && <span>—</span>}
                    </td>
                    <td className="px-3 py-2.5 text-right align-top">
                      <TaskActions task={{ id: t.id, mode: t.mode, kind: t.kind, status: t.status, required: t.required }} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
