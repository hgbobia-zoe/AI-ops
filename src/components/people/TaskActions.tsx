"use client";

// Per-task action buttons in the provisioning table. The button set is DERIVED from the task (mode +
// status), never hard-coded per system: an automated task that isn't done gets Approve & run; a
// manual/future task gets Mark Complete; a failed task gets Retry; an optional task gets Skip. The server
// owns the approval gate + the real write; this just triggers it and refreshes.

import { useState } from "react";
import { useRouter } from "next/navigation";

export interface TaskView {
  id: string;
  mode: "automated" | "partial" | "manual" | "future";
  kind: "provision" | "revoke";
  status: string;
  required: boolean;
}

export function TaskActions({ task }: { task: TaskView }): React.JSX.Element {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ text: string; tone: "ok" | "bad" } | null>(null);

  async function run(action: string): Promise<void> {
    setBusy(action);
    setMsg(null);
    try {
      const res = await fetch("/api/people/task", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ taskId: task.id, action }),
      });
      const data = (await res.json().catch(() => null)) as { ok?: boolean; message?: string; error?: string } | null;
      if (!res.ok || !data?.ok) setMsg({ text: data?.message ?? data?.error ?? "Failed.", tone: "bad" });
      else { setMsg({ text: data.message ?? "Done.", tone: "ok" }); router.refresh(); }
    } catch {
      setMsg({ text: "Network error.", tone: "bad" });
    } finally {
      setBusy(null);
    }
  }

  const done = task.status === "completed" || task.status === "skipped";
  const isAutomated = task.mode === "automated";
  const btn = "inline-flex h-7 items-center rounded px-2.5 text-[11.5px] font-medium transition-colors disabled:opacity-50";
  const verb = task.kind === "provision" ? "provision" : "revoke";

  if (done) {
    return <span className="text-[11.5px] text-meta">{task.status === "skipped" ? "Skipped" : "Done"}</span>;
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {isAutomated ? (
        <button onClick={() => run("approve_execute")} disabled={busy !== null}
          className={`${btn} bg-foreground text-background hover:opacity-90`}>
          {busy === "approve_execute" ? "Running…" : `Approve & ${verb}`}
        </button>
      ) : (
        <button onClick={() => run("mark_complete")} disabled={busy !== null}
          className={`${btn} border border-border text-secondary-text hover:bg-[var(--row-hover)] hover:text-foreground`}>
          {busy === "mark_complete" ? "Saving…" : "Mark complete"}
        </button>
      )}
      {task.status === "failed" && (
        <button onClick={() => run("retry")} disabled={busy !== null} className={`${btn} border border-border text-attention hover:bg-[var(--row-hover)]`}>Retry</button>
      )}
      {!task.required && (
        <button onClick={() => run("skip")} disabled={busy !== null} className={`${btn} text-meta hover:text-foreground`}>Skip</button>
      )}
      {msg && <span className={`text-[11px] ${msg.tone === "ok" ? "text-positive" : "text-critical"}`}>{msg.text}</span>}
    </div>
  );
}
