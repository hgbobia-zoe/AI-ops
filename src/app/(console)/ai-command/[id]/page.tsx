// AI session workspace (Phase 4) — the operational workspace for one session: objective, the append-only
// activity timeline (instructions, steps, tool calls, recommendations, actions), tools run, and the
// actions it raised (linked to the Approvals queue — the session never executes). Operating controls
// (instruct / pause / resume / rename / objective / archive) sit alongside. Auto-refreshes while live.

import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ArrowLeft, Wrench, ShieldCheck, Target, Lightbulb, Zap, MessageSquare, Flag, Play } from "lucide-react";
import { viewerRole } from "@/lib/auth/getSession";
import { canViewAi } from "@/lib/auth/roles";
import { getSession as getAiSession, listSessionEvents, listSessionTools, listSessionApprovalIds, type SessionEventKind } from "@/lib/ai/sessions";
import { getApproval } from "@/lib/aiorg/approvals";
import { agentDisplayName } from "@/lib/ai/control";
import { AutoRefresh } from "@/components/AutoRefresh";
import { AiSessionControls } from "@/components/aiorg/AiSessionControls";
import { STATUS_META } from "@/lib/ai/sessionDisplay";

export const dynamic = "force-dynamic";

function when(iso: string): string {
  try {
    return new Date(iso).toLocaleString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit", month: "short", day: "numeric" });
  } catch {
    return iso;
  }
}

const EVENT_ICON: Partial<Record<SessionEventKind, React.ReactNode>> = {
  started: <Play className="size-3.5 text-meta" />,
  instruction: <MessageSquare className="size-3.5 text-tertiary-text" />,
  tool_call: <Wrench className="size-3.5 text-meta" />,
  recommendation: <Lightbulb className="size-3.5 text-attention" />,
  action_available: <Zap className="size-3.5 text-attention" />,
  approval_raised: <ShieldCheck className="size-3.5 text-attention" />,
  finished: <Flag className="size-3.5 text-positive" />,
  error: <Flag className="size-3.5 text-critical" />,
};

export default async function AiSessionWorkspacePage({ params }: { params: Promise<{ id: string }> }): Promise<React.JSX.Element> {
  const role = await viewerRole();
  if (!canViewAi(role)) redirect("/dashboard");
  const { id } = await params;

  const session = getAiSession(id);
  if (!session) notFound();
  const events = listSessionEvents(id, 300);
  const tools = listSessionTools(id);
  const approvalIds = listSessionApprovalIds(id);
  const approvals = approvalIds.map((aid) => getApproval(aid)).filter((a): a is NonNullable<typeof a> => a !== null);
  const live = session.status === "running" || session.status === "awaiting_approval";
  const m = STATUS_META[session.status];

  return (
    <main className="mx-auto max-w-[1200px] p-4 pb-16 md:p-6">
      {live && <AutoRefresh seconds={15} />}
      <Link href="/ai-command" className="mb-4 inline-flex items-center gap-1.5 text-[12px] text-meta transition-colors hover:text-foreground">
        <ArrowLeft className="size-3.5" /> AI Command Center
      </Link>

      {/* Header */}
      <header className="mb-5 border border-border bg-panel p-4">
        <div className="flex flex-wrap items-start gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              {session.blade && <span className="rounded border border-border px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-meta">{session.blade}</span>}
              <span className={`inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide ${m.text}`}>
                <span className={`size-1.5 rounded-full ${m.dot}`} aria-hidden /> {m.label}
              </span>
            </div>
            <h1 className="mt-1.5 text-[20px] font-semibold tracking-tight">{session.title}</h1>
            <p className="mt-0.5 text-[12px] text-meta">
              {agentDisplayName(session.agentId)}
              {session.owner ? ` · owner ${session.owner}` : ""}
              {session.startedBy ? ` · opened by ${session.startedBy}` : ""}
              {session.provider ? ` · via ${session.provider}` : ""}
            </p>
          </div>
          <div className="text-right text-[11px] text-meta">
            <div>started {when(session.createdAt)}</div>
            {session.endedAt && <div>ended {when(session.endedAt)}</div>}
          </div>
        </div>

        {/* Objective */}
        <div className="mt-3 flex items-start gap-2 border-t border-rule pt-3">
          <Target className="mt-0.5 size-4 shrink-0 text-tertiary-text" />
          <div className="min-w-0">
            <div className="text-[10px] uppercase tracking-[0.1em] text-meta">Objective</div>
            <div className="text-[13px] text-secondary-text">{session.objective || "No objective set yet. Set one below so the session has a clear goal."}</div>
          </div>
        </div>
      </header>

      {session.error && (
        <div className="mb-4 border border-critical/40 bg-critical/[0.04] px-3 py-2 text-[12.5px] text-critical">{session.error}</div>
      )}

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-12">
        {/* Left: controls + proposed actions + tools */}
        <section className="space-y-5 lg:col-span-5">
          <div>
            <h2 className="mb-2 text-[12px] font-semibold uppercase tracking-[0.06em] text-tertiary-text">Controls</h2>
            <AiSessionControls sessionId={session.id} status={session.status} title={session.title} objective={session.objective} archived={session.archived} />
          </div>

          <div>
            <h2 className="mb-2 flex items-center gap-2 text-[12px] font-semibold uppercase tracking-[0.06em] text-tertiary-text"><ShieldCheck className="size-4" /> Proposed actions ({approvals.length})</h2>
            <div className="surface border p-3">
              {approvals.length === 0 ? (
                <p className="text-[12.5px] text-meta">This session has not proposed any action. AI recommendations become actions here, and every action needs a human OK.</p>
              ) : (
                <ul className="space-y-2">
                  {approvals.map((a) => (
                    <li key={a.id} className="flex items-center gap-2 text-[12.5px]">
                      <span className="rounded border border-border px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-tertiary-text">{a.actionType}</span>
                      <span className="min-w-0 flex-1 truncate text-secondary-text">{a.title}</span>
                      <span className="shrink-0 text-[11px] text-meta">{a.status}</span>
                      <Link href="/ai-org/approvals" className="shrink-0 text-[11px] text-tertiary-text hover:text-foreground">review →</Link>
                    </li>
                  ))}
                </ul>
              )}
            </div>
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

        {/* Right: activity timeline — the operational workspace feed */}
        <section className="lg:col-span-7">
          <h2 className="mb-2 text-[12px] font-semibold uppercase tracking-[0.06em] text-tertiary-text">AI activity</h2>
          <div className="surface border p-4">
            {events.length === 0 ? (
              <p className="text-[12.5px] text-meta">No activity yet.</p>
            ) : (
              <ol className="space-y-3">
                {[...events].reverse().map((e) => {
                  const isReco = e.kind === "recommendation" || e.kind === "action_available";
                  return (
                    <li key={e.id} className="flex gap-3">
                      <div className="flex shrink-0 flex-col items-center">
                        <span className="flex size-6 items-center justify-center rounded-full border border-border bg-[var(--panel)]">{EVENT_ICON[e.kind] ?? <span className="size-1.5 rounded-full bg-[var(--bar)]" />}</span>
                      </div>
                      <div className={`min-w-0 flex-1 ${isReco ? "border border-attention/25 bg-attention/[0.03] p-2.5" : ""}`}>
                        <div className="flex items-center gap-2">
                          <span className="text-[10px] uppercase tracking-wide text-meta">{e.kind.replace(/_/g, " ")}</span>
                          {e.actor && <span className="text-[10.5px] text-meta">· {e.actor}</span>}
                          <span className="ml-auto tabular-nums text-[10.5px] text-meta">{when(e.ts)}</span>
                        </div>
                        {e.label && <div className={`mt-0.5 break-words text-[13px] ${isReco ? "font-medium text-foreground" : "text-secondary-text"}`}>{e.label}</div>}
                      </div>
                    </li>
                  );
                })}
              </ol>
            )}
          </div>
        </section>
      </div>
    </main>
  );
}
