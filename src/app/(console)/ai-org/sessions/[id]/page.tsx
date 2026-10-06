// AI session detail / workspace (Phase 4) — the full record of one session: header (status, agent, blade,
// provider, owner), the bounded input it was given, its interpreted result, the append-only timeline, the
// tools it ran, and any actions it raised (linked to the Approvals queue — the session never executes).
// Auto-refreshes while the session is live. Any signed staff may view.

import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ArrowLeft, CircleDot, Wrench, ShieldCheck, FileText } from "lucide-react";
import { viewerRole } from "@/lib/auth/getSession";
import { canViewAi, canManageAi } from "@/lib/auth/roles";
import { getSession as getAiSession, listSessionEvents, listSessionTools, listSessionApprovalIds, type SessionStatus } from "@/lib/ai/sessions";
import { getApproval } from "@/lib/aiorg/approvals";
import { agentDisplayName } from "@/lib/ai/control";
import { OrgTabs } from "@/components/aiorg/AiOrgBits";
import { AutoRefresh } from "@/components/AutoRefresh";

export const dynamic = "force-dynamic";

const STATUS_CHIP: Record<SessionStatus, string> = {
  running: "border-positive/40 text-positive",
  awaiting_approval: "border-attention/50 text-attention",
  done: "border-border text-meta",
  failed: "border-critical/50 text-critical",
  cancelled: "border-border text-meta",
};
const STATUS_LABEL: Record<SessionStatus, string> = {
  running: "Running",
  awaiting_approval: "Awaiting approval",
  done: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
};

function when(iso: string): string {
  try {
    return new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit" });
  } catch {
    return iso;
  }
}

export default async function AiSessionDetailPage({ params }: { params: Promise<{ id: string }> }): Promise<React.JSX.Element> {
  const role = await viewerRole();
  if (!canViewAi(role)) redirect("/dashboard");
  const { id } = await params;

  const session = getAiSession(id);
  if (!session) notFound();
  const events = listSessionEvents(id);
  const tools = listSessionTools(id);
  const approvalIds = listSessionApprovalIds(id);
  const approvals = approvalIds.map((aid) => getApproval(aid)).filter((a): a is NonNullable<typeof a> => a !== null);
  const live = session.status === "running" || session.status === "awaiting_approval";

  const inputEntries = Object.entries(session.input ?? {});
  const resultEntries = session.result ? Object.entries(session.result) : [];

  return (
    <main className="max-w-[1000px] p-6">
      {live && <AutoRefresh seconds={15} />}
      <Link href="/ai-org/sessions" className="mb-4 inline-flex items-center gap-1.5 text-[12px] text-meta transition-colors hover:text-foreground">
        <ArrowLeft className="size-3.5" /> Command Center
      </Link>

      <OrgTabs active="/ai-org/sessions" canManage={canManageAi(role)} />

      {/* Header */}
      <header className="mb-5 flex flex-wrap items-start gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <CircleDot className="size-4 text-tertiary-text" />
            <h1 className="truncate text-[20px] font-medium tracking-tight">{session.title}</h1>
            <span className={`rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${STATUS_CHIP[session.status]}`}>
              {STATUS_LABEL[session.status]}
            </span>
          </div>
          <p className="mt-1 text-[12.5px] text-meta">
            {agentDisplayName(session.agentId)}
            {session.blade ? ` · ${session.blade}` : ""}
            {session.owner ? ` · owner ${session.owner}` : ""}
            {session.provider ? ` · via ${session.provider}` : ""}
          </p>
        </div>
        <div className="ml-auto text-right text-[11px] text-meta">
          <div>started {when(session.createdAt)}</div>
          {session.endedAt && <div>ended {when(session.endedAt)}</div>}
          {session.startedBy && <div>by {session.startedBy}</div>}
        </div>
      </header>

      {session.error && (
        <div className="mb-4 border border-critical/40 bg-critical/[0.04] px-3 py-2 text-[12.5px] text-critical">{session.error}</div>
      )}

      <div className="grid gap-5 lg:grid-cols-2">
        {/* Input + result */}
        <section className="space-y-5">
          <Panel icon={<FileText className="size-4" />} title="Input (rule-computed facts)">
            {inputEntries.length === 0 ? (
              <Empty>No input context recorded.</Empty>
            ) : (
              <dl className="space-y-1.5 text-[12.5px]">
                {inputEntries.map(([k, v]) => (
                  <div key={k} className="flex gap-2">
                    <dt className="shrink-0 font-mono text-meta">{k}</dt>
                    <dd className="min-w-0 break-words text-secondary-text">{typeof v === "string" ? v : JSON.stringify(v)}</dd>
                  </div>
                ))}
              </dl>
            )}
          </Panel>

          <Panel icon={<FileText className="size-4" />} title="Interpreted result">
            {resultEntries.length === 0 ? (
              <Empty>{live ? "No result yet." : "No result recorded."}</Empty>
            ) : (
              <dl className="space-y-1.5 text-[12.5px]">
                {resultEntries.map(([k, v]) => (
                  <div key={k} className="flex gap-2">
                    <dt className="shrink-0 font-mono text-meta">{k}</dt>
                    <dd className="min-w-0 break-words text-secondary-text">{typeof v === "string" ? v : JSON.stringify(v)}</dd>
                  </div>
                ))}
              </dl>
            )}
          </Panel>

          <Panel icon={<ShieldCheck className="size-4" />} title={`Proposed actions (${approvals.length})`}>
            {approvals.length === 0 ? (
              <Empty>This session has not proposed any action.</Empty>
            ) : (
              <ul className="space-y-2">
                {approvals.map((a) => (
                  <li key={a.id} className="flex items-center gap-2 text-[12.5px]">
                    <span className="rounded border border-border px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-tertiary-text">{a.actionType}</span>
                    <span className="min-w-0 truncate text-secondary-text">{a.title}</span>
                    <span className="ml-auto text-[11px] text-meta">{a.status}</span>
                    <Link href="/ai-org/approvals" className="text-[11px] text-tertiary-text hover:text-foreground">review →</Link>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </section>

        {/* Timeline + tools */}
        <section className="space-y-5">
          <Panel icon={<Wrench className="size-4" />} title={`Tools run (${tools.length})`}>
            {tools.length === 0 ? (
              <Empty>No tools recorded.</Empty>
            ) : (
              <ul className="space-y-1.5 text-[12.5px]">
                {tools.map((t) => (
                  <li key={t.id} className="flex items-center gap-2">
                    <span className={`size-1.5 rounded-full ${t.status === "error" ? "bg-critical" : "bg-positive"}`} aria-hidden />
                    <span className="font-mono text-tertiary-text">{t.toolId}</span>
                    {t.category && <span className="text-[10px] uppercase tracking-wide text-meta">{t.category}</span>}
                    <span className="ml-auto tabular-nums text-meta">{when(t.startedAt)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          <Panel icon={<CircleDot className="size-4" />} title="Timeline">
            {events.length === 0 ? (
              <Empty>No events.</Empty>
            ) : (
              <ol className="space-y-2 text-[12.5px]">
                {events.map((e) => (
                  <li key={e.id} className="flex gap-2">
                    <span className="mt-1 size-1.5 shrink-0 rounded-full bg-[var(--bar)]" aria-hidden />
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] uppercase tracking-wide text-meta">{e.kind}</span>
                        {e.actor && <span className="text-[11px] text-meta">{e.actor}</span>}
                      </div>
                      {e.label && <div className="break-words text-secondary-text">{e.label}</div>}
                      <div className="tabular-nums text-[10.5px] text-meta">{when(e.ts)}</div>
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </Panel>
        </section>
      </div>
    </main>
  );
}

function Panel({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="surface border p-4">
      <h2 className="mb-3 flex items-center gap-2 text-[12px] font-semibold uppercase tracking-[0.06em] text-tertiary-text">{icon} {title}</h2>
      {children}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <p className="text-[12.5px] text-meta">{children}</p>;
}
