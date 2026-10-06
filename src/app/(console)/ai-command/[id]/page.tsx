// AI session workspace — the operational workspace for one session. Header (AI employee, blade, session,
// objective, status) + controls (instruct / pause / resume / rename / objective / archive), a chronological
// typed activity stream (user request, AI analysis, data retrieved, tool call, recommendation, action,
// approval required, completed, error — each visually distinct), the tools it ran, and any action requests
// rendered as full approval cards so a human can APPROVE / REJECT inline. Auto-refreshes while live. Not a
// chat UI — an operations workspace. The session never executes; approvals route through the governed path.

import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ArrowLeft, Wrench, ShieldCheck, Target, Lightbulb, Zap, MessageSquare, Flag, Play, Activity, Database, CircleDot } from "lucide-react";
import { viewerRole } from "@/lib/auth/getSession";
import { canViewAi, canApproveAi, canSeeFinancials } from "@/lib/auth/roles";
import { getSession as getAiSession, listSessionEvents, listSessionTools, listSessionApprovalIds, type SessionEventKind } from "@/lib/ai/sessions";
import { getApproval, type AiApproval } from "@/lib/aiorg/approvals";
import { agentDisplayName } from "@/lib/ai/control";
import { AutoRefresh } from "@/components/AutoRefresh";
import { AiSessionControls } from "@/components/aiorg/AiSessionControls";
import { ApprovalCard, type ApprovalCardData } from "@/components/aiorg/ApprovalCard";
import { STATUS_META } from "@/lib/ai/sessionDisplay";

export const dynamic = "force-dynamic";

function when(iso: string): string {
  try {
    return new Date(iso).toLocaleString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit", month: "short", day: "numeric" });
  } catch {
    return iso;
  }
}

// Typed activity-stream rendering — every event kind reads as its own operational type.
const EVENT_META: Record<SessionEventKind, { label: string; icon: React.ReactNode; accent: "gold" | "attention" | "positive" | "critical" | "tertiary" | "meta" }> = {
  started: { label: "Session started", icon: <Play className="size-3.5" />, accent: "meta" },
  instruction: { label: "User request", icon: <MessageSquare className="size-3.5" />, accent: "tertiary" },
  step: { label: "AI analysis", icon: <Activity className="size-3.5" />, accent: "meta" },
  tool_call: { label: "Tool call", icon: <Wrench className="size-3.5" />, accent: "meta" },
  message: { label: "Message", icon: <MessageSquare className="size-3.5" />, accent: "meta" },
  recommendation: { label: "AI recommendation", icon: <Lightbulb className="size-3.5" />, accent: "gold" },
  action_available: { label: "Action available", icon: <Zap className="size-3.5" />, accent: "gold" },
  approval_raised: { label: "Approval required", icon: <ShieldCheck className="size-3.5" />, accent: "attention" },
  state_change: { label: "State change", icon: <CircleDot className="size-3.5" />, accent: "meta" },
  finished: { label: "Completed", icon: <Flag className="size-3.5" />, accent: "positive" },
  error: { label: "Error", icon: <Flag className="size-3.5" />, accent: "critical" },
};
const ACCENT_TEXT: Record<string, string> = { gold: "text-[var(--gold)]", attention: "text-attention", positive: "text-positive", critical: "text-critical", tertiary: "text-tertiary-text", meta: "text-meta" };
const ACCENT_BLOCK: Record<string, string> = { gold: "border-[var(--gold)]/25 bg-[var(--gold)]/[0.04]", attention: "border-attention/25 bg-attention/[0.03]", critical: "border-critical/30 bg-critical/[0.04]", tertiary: "border-[var(--row-rule)] bg-[var(--panel)]" };

function toCardData(a: AiApproval): ApprovalCardData {
  return {
    id: a.id, agentId: a.agentId, owner: a.owner, title: a.title, actionType: a.actionType, status: a.status, financial: a.financial, card: a.card,
    payload: {
      transactionId: typeof a.actionPayload.transactionId === "string" ? a.actionPayload.transactionId : undefined,
      leadId: typeof a.actionPayload.leadId === "string" ? a.actionPayload.leadId : undefined,
      body: typeof a.actionPayload.body === "string" ? a.actionPayload.body : undefined,
      subject: typeof a.actionPayload.subject === "string" ? a.actionPayload.subject : undefined,
    },
    createdAt: a.createdAt, decidedBy: a.decidedBy, decidedAt: a.decidedAt, decisionNote: a.decisionNote, outboxOpId: a.outboxOpId,
  };
}

export default async function AiSessionWorkspacePage({ params }: { params: Promise<{ id: string }> }): Promise<React.JSX.Element> {
  const role = await viewerRole();
  if (!canViewAi(role)) redirect("/dashboard");
  const canApprove = canApproveAi(role);
  const showMoney = canSeeFinancials(role);
  const { id } = await params;

  const session = getAiSession(id);
  if (!session) notFound();
  const events = listSessionEvents(id, 300);
  const tools = listSessionTools(id);
  const approvalIds = listSessionApprovalIds(id);
  const approvals = approvalIds.map((aid) => getApproval(aid)).filter((a): a is AiApproval => a !== null).filter((a) => showMoney || !a.financial);
  const pending = approvals.filter((a) => a.status === "pending" || a.status === "info_requested" || a.status === "edited");
  const live = session.status === "running" || session.status === "awaiting_approval";
  const m = STATUS_META[session.status];

  return (
    <main className="mx-auto max-w-[1300px] p-4 pb-16 md:p-5">
      {live && <AutoRefresh seconds={15} />}
      <Link href="/ai-command" className="mb-4 inline-flex items-center gap-1.5 text-[12px] text-meta transition-colors hover:text-foreground">
        <ArrowLeft className="size-3.5" /> AI Command Center
      </Link>

      {/* Header */}
      <header className="mb-5 border border-border bg-panel p-4">
        <div className="flex flex-wrap items-start gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="text-[13.5px] font-semibold uppercase tracking-[0.02em] text-foreground">{agentDisplayName(session.agentId)}</span>
              {session.blade && <span className="rounded border border-border px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-meta">{session.blade}</span>}
              <span className={`ml-auto inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide ${m.text}`}>
                <span className={`size-1.5 rounded-full ${m.dot}`} aria-hidden /> {m.label}
              </span>
            </div>
            <h1 className="mt-1 text-[19px] font-semibold tracking-tight">{session.title}</h1>
            <p className="mt-0.5 text-[12px] text-meta">
              {session.owner ? `owner ${session.owner}` : "unassigned"}
              {session.startedBy ? ` · opened by ${session.startedBy}` : ""}
              {session.provider ? ` · via ${session.provider}` : ""}
            </p>
          </div>
          <div className="text-right text-[11px] text-meta">
            <div>started {when(session.createdAt)}</div>
            {session.endedAt && <div>ended {when(session.endedAt)}</div>}
          </div>
        </div>
        <div className="mt-3 flex items-start gap-2 border-t border-rule pt-3">
          <Target className="mt-0.5 size-4 shrink-0 text-tertiary-text" />
          <div className="min-w-0">
            <div className="text-[10px] uppercase tracking-[0.1em] text-meta">Objective</div>
            <div className="text-[13px] text-secondary-text">{session.objective || "No objective set yet. Set one below so the session has a clear goal."}</div>
          </div>
        </div>
      </header>

      {session.error && <div className="mb-4 border border-critical/40 bg-critical/[0.04] px-3 py-2 text-[12.5px] text-critical">{session.error}</div>}

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-12">
        {/* Left: controls + action requests + tools */}
        <section className="space-y-5 lg:col-span-5">
          <div>
            <h2 className="mb-2 text-[12px] font-semibold uppercase tracking-[0.06em] text-tertiary-text">Controls</h2>
            <AiSessionControls sessionId={session.id} status={session.status} title={session.title} objective={session.objective} archived={session.archived} />
          </div>

          <div>
            <h2 className="mb-2 flex items-center gap-2 text-[12px] font-semibold uppercase tracking-[0.06em] text-tertiary-text"><ShieldCheck className="size-4" /> Action requests ({pending.length})</h2>
            {approvals.length === 0 ? (
              <div className="surface border p-3"><p className="text-[12.5px] text-meta">No action requests. AI recommendations become actions here, and every action needs a human OK before anything is sent.</p></div>
            ) : (
              <div className="space-y-3">
                {approvals.map((a) => <ApprovalCard key={a.id} data={toCardData(a)} actionable={canApprove && (a.status === "pending" || a.status === "info_requested" || a.status === "edited")} />)}
              </div>
            )}
          </div>

          <div>
            <h2 className="mb-2 flex items-center gap-2 text-[12px] font-semibold uppercase tracking-[0.06em] text-tertiary-text"><Wrench className="size-4" /> Tools run ({tools.length})</h2>
            <div className="surface border p-3">
              {tools.length === 0 ? (
                <p className="text-[12.5px] text-meta">No tools recorded.</p>
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
            </div>
          </div>
        </section>

        {/* Right: typed activity stream */}
        <section className="lg:col-span-7">
          <h2 className="mb-2 flex items-center gap-2 text-[12px] font-semibold uppercase tracking-[0.06em] text-tertiary-text"><Activity className="size-4" /> Activity stream</h2>
          <div className="surface border p-4">
            {events.length === 0 ? (
              <p className="text-[12.5px] text-meta">No activity yet.</p>
            ) : (
              <ol className="space-y-3">
                {[...events].reverse().map((e) => {
                  const meta = EVENT_META[e.kind] ?? EVENT_META.step;
                  const highlighted = meta.accent === "gold" || meta.accent === "attention" || meta.accent === "critical" || e.kind === "instruction";
                  return (
                    <li key={e.id} className="flex gap-3">
                      <span className={`flex size-6 shrink-0 items-center justify-center rounded-full border border-border bg-[var(--panel)] ${ACCENT_TEXT[meta.accent]}`}>{meta.icon}</span>
                      <div className={`min-w-0 flex-1 ${highlighted ? `rounded border ${ACCENT_BLOCK[meta.accent]} p-2.5` : ""}`}>
                        <div className="flex items-center gap-2">
                          <span className={`text-[10px] font-semibold uppercase tracking-[0.07em] ${ACCENT_TEXT[meta.accent]}`}>{meta.label}</span>
                          {e.actor && e.kind === "instruction" && <span className="text-[10.5px] text-meta">· {e.actor}</span>}
                          <span className="ml-auto tabular-nums text-[10.5px] text-meta">{when(e.ts)}</span>
                        </div>
                        {e.label && <div className={`mt-0.5 break-words text-[13px] ${highlighted ? "font-medium text-foreground" : "text-secondary-text"}`}>{e.label}</div>}
                      </div>
                    </li>
                  );
                })}
              </ol>
            )}
          </div>
          {tools.some((t) => t.toolId.startsWith("read")) && (
            <p className="mt-2 flex items-center gap-1.5 text-[11px] text-meta"><Database className="size-3" /> Data reads are recorded as tool calls above; results feed the AI analysis, not the customer.</p>
          )}
        </section>
      </div>
    </main>
  );
}
