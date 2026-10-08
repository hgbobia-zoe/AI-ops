"use client";

// AI Command Center — the Requests backlog board. Shows every ask captured from an AI session (a product
// idea, a question, or an operational task), tracked through its lifecycle. Non-technical-friendly: plain
// status chips, a one-row filter, and explicit action buttons (no jargon). Managers (owner/admin) can
// triage, decline, or close; the responder attaches an implementation PR on its own. Reads are server-side;
// this only posts status changes and refreshes.

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Loader2, Lightbulb, HelpCircle, Wrench, ArrowRight, GitPullRequest, AlertTriangle } from "lucide-react";
import type { AiRequest, AiRequestStatus, AiRequestType } from "@/lib/ai/requests";

const TYPE_META: Record<AiRequestType, { label: string; icon: typeof Lightbulb; cls: string }> = {
  feature: { label: "Feature", icon: Lightbulb, cls: "text-[var(--gold)] border-[var(--gold)]/40" },
  question: { label: "Question", icon: HelpCircle, cls: "text-attention border-attention/40" },
  operational: { label: "Task", icon: Wrench, cls: "text-tertiary-text border-border" },
};

const STATUS_META: Record<AiRequestStatus, { label: string; cls: string }> = {
  new: { label: "New", cls: "text-attention bg-attention/10" },
  triaged: { label: "Triaged", cls: "text-foreground bg-[var(--row-hover)]" },
  in_progress: { label: "In progress", cls: "text-[var(--gold)] bg-[var(--gold)]/10" },
  in_review: { label: "In review", cls: "text-positive bg-positive/10" },
  done: { label: "Done", cls: "text-positive bg-positive/10" },
  declined: { label: "Declined", cls: "text-tertiary-text bg-[var(--row-hover)]" },
};

const FILTERS: { key: AiRequestStatus | "all" | "open"; label: string }[] = [
  { key: "open", label: "Open" },
  { key: "all", label: "All" },
  { key: "new", label: "New" },
  { key: "triaged", label: "Triaged" },
  { key: "in_progress", label: "In progress" },
  { key: "in_review", label: "In review" },
  { key: "done", label: "Done" },
  { key: "declined", label: "Declined" },
];

// Which status buttons make sense from the current one (non-technical: short, plain verbs).
function nextActions(status: AiRequestStatus): { to: AiRequestStatus; label: string; tone: "normal" | "good" | "bad" }[] {
  switch (status) {
    case "new":
      return [{ to: "triaged", label: "Accept", tone: "normal" }, { to: "declined", label: "Decline", tone: "bad" }];
    case "triaged":
      return [{ to: "in_progress", label: "Start", tone: "normal" }, { to: "declined", label: "Decline", tone: "bad" }];
    case "in_progress":
      return [{ to: "done", label: "Mark done", tone: "good" }, { to: "declined", label: "Decline", tone: "bad" }];
    case "in_review":
      return [{ to: "done", label: "Mark done", tone: "good" }, { to: "declined", label: "Decline", tone: "bad" }];
    case "done":
    case "declined":
      return [{ to: "triaged", label: "Reopen", tone: "normal" }];
  }
}

export function RequestsBoard({
  requests,
  counts,
  canManage,
}: {
  requests: AiRequest[];
  counts: Record<AiRequestStatus, number>;
  canManage: boolean;
}): React.JSX.Element {
  const router = useRouter();
  const [filter, setFilter] = useState<AiRequestStatus | "all" | "open">("open");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const visible = requests.filter((r) =>
    filter === "all" ? true : filter === "open" ? r.status !== "done" && r.status !== "declined" : r.status === filter,
  );

  const setStatus = useCallback(
    async (requestId: string, status: AiRequestStatus) => {
      setBusy(requestId);
      setError(null);
      try {
        const res = await fetch("/api/ai/requests/manage", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ requestId, op: "status", status }),
        });
        if (res.ok) {
          router.refresh();
        } else {
          const j = (await res.json().catch(() => ({}))) as { error?: string };
          setError(j.error ? `Could not update: ${j.error}.` : "Could not update the request.");
        }
      } catch {
        setError("Could not reach the server. Try again.");
      } finally {
        setBusy(null);
      }
    },
    [router],
  );

  const openCount = counts.new + counts.triaged + counts.in_progress + counts.in_review;

  return (
    <div className="space-y-4">
      {/* Filter row */}
      <div className="flex flex-wrap items-center gap-1.5">
        {FILTERS.map((f) => {
          const n = f.key === "all" ? requests.length : f.key === "open" ? openCount : counts[f.key];
          const active = filter === f.key;
          return (
            <button
              key={f.key}
              onClick={() => setFilter(f.key)}
              className={`inline-flex items-center gap-1.5 rounded px-2.5 py-1 text-[12px] transition-colors ${
                active ? "border border-[var(--gold)] bg-[var(--gold)]/15 text-[var(--gold)]" : "border border-border text-muted-foreground hover:bg-[var(--row-hover)] hover:text-foreground"
              }`}
            >
              {f.label}
              <span className="tabular-nums text-[11px] opacity-70">{n}</span>
            </button>
          );
        })}
      </div>

      {error && (
        <div className="flex items-center gap-1.5 border border-critical/40 bg-critical/[0.04] px-3 py-2 text-[12.5px] text-critical">
          <AlertTriangle className="size-3.5 shrink-0" /> {error}
        </div>
      )}

      {visible.length === 0 ? (
        <p className="border border-dashed border-border px-3 py-8 text-center text-[12.5px] text-meta">
          No requests here yet. When someone asks an AI session for a product change or an answer, it shows up as a tracked request.
        </p>
      ) : (
        <ul className="space-y-2.5">
          {visible.map((r) => {
            const t = TYPE_META[r.type];
            const s = STATUS_META[r.status];
            const TIcon = t.icon;
            return (
              <li key={r.id} className="surface border p-3">
                <div className="flex items-start gap-2.5">
                  <span className={`mt-0.5 inline-flex shrink-0 items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${t.cls}`}>
                    <TIcon className="size-3" /> {t.label}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <h3 className="truncate text-[13.5px] font-medium text-foreground">{r.title}</h3>
                      <span className={`ml-auto shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${s.cls}`}>{s.label}</span>
                    </div>
                    {r.body && <p className="mt-1 line-clamp-2 text-[12px] text-secondary-text">{r.body}</p>}
                    <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-meta">
                      {r.requestedBy && <span>From {r.requestedBy}</span>}
                      {r.blade && <span className="rounded border border-border px-1 py-0.5 uppercase tracking-wide">{r.blade}</span>}
                      {r.sessionId && (
                        <Link href={`/ai-command/${r.sessionId}`} className="inline-flex items-center gap-0.5 transition-colors hover:text-foreground">
                          Session <ArrowRight className="size-3" />
                        </Link>
                      )}
                      {r.prUrl && (
                        <a href={r.prUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-positive transition-colors hover:underline">
                          <GitPullRequest className="size-3" /> PR{r.prNumber ? ` #${r.prNumber}` : ""}
                        </a>
                      )}
                    </div>
                    {r.notes && <p className="mt-1.5 border-l-2 border-border pl-2 text-[11.5px] italic text-meta">{r.notes}</p>}

                    {canManage && (
                      <div className="mt-2.5 flex flex-wrap gap-1.5">
                        {nextActions(r.status).map((a) => (
                          <button
                            key={a.to}
                            onClick={() => setStatus(r.id, a.to)}
                            disabled={busy === r.id}
                            className={`inline-flex items-center gap-1 rounded border px-2 py-0.5 text-[11.5px] transition-colors disabled:opacity-50 ${
                              a.tone === "bad"
                                ? "border-critical/40 text-critical hover:bg-critical/10"
                                : a.tone === "good"
                                  ? "border-positive/40 text-positive hover:bg-positive/10"
                                  : "border-border text-muted-foreground hover:bg-[var(--row-hover)] hover:text-foreground"
                            }`}
                          >
                            {busy === r.id ? <Loader2 className="size-3 animate-spin" /> : null}
                            {a.label}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
