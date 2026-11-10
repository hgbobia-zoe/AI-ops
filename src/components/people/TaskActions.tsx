"use client";

// Per-task action buttons in the provisioning table. The button set is DERIVED from the task (mode +
// status), never hard-coded per system: an automated task that isn't done gets Approve & run; a
// manual/future task gets Mark Complete; a failed task gets Retry; an optional task gets Skip. The server
// owns the approval gate + the real write; this just triggers it and refreshes.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { runsInChrome } from "@/lib/people/provisioningEndpoints";
import { runInChrome, useRefreshFor } from "./ChromeSetup";

export interface TaskView {
  id: string;
  employeeId: string;
  adapterId: string;
  externalRef: string | null;
  mode: "automated" | "partial" | "manual" | "future";
  kind: "provision" | "revoke";
  status: string;
  required: boolean;
}

export function TaskActions({ task }: { task: TaskView }): React.JSX.Element {
  const router = useRouter();
  const refreshFor = useRefreshFor();
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

  async function chrome(): Promise<void> {
    setBusy("chrome");
    setMsg(null);
    const r = await runInChrome(task.employeeId, [task.id]);
    setMsg({ text: r.text, tone: r.ok ? "ok" : "bad" });
    setBusy(null);
    if (r.ok) refreshFor(5 * 60_000);
  }

  const done = task.status === "completed" || task.status === "skipped";
  const isAutomated = task.mode === "automated";
  const verb = task.kind === "provision" ? "provision" : "revoke";
  const disabled = busy !== null;

  if (done) {
    return <span className="text-[11.5px] text-meta">{task.status === "skipped" ? "Skipped" : "Done"}</span>;
  }

  // Steps only the hire can finish: signing the SOP, and accepting the Zoe invite. No button closes them.
  const waitingOnHire =
    (task.adapterId === "sop_ack" && task.kind === "provision") ||
    (task.adapterId === "zoe_platform" && task.kind === "provision" && task.status === "in_progress");
  if (waitingOnHire) {
    const ref = task.externalRef;
    // Resolve a relative /join link against this site only on click (window is not there during SSR).
    const copy = (): void => {
      if (!ref) return;
      const link = /^https?:/.test(ref) ? ref : `${window.location.origin}${ref}`;
      void navigator.clipboard?.writeText(link);
      setMsg({ text: "Link copied.", tone: "ok" });
    };
    return (
      <div className="flex flex-wrap items-center justify-end gap-1.5">
        <span className="text-[11.5px] text-meta">{task.adapterId === "sop_ack" ? "Waiting for the hire to sign" : "Waiting for the hire to accept"}</span>
        {ref && (
          <Button variant="outline" size="xs" onClick={copy}>
            Copy link
          </Button>
        )}
        {msg && <span className={`text-[11px] ${msg.tone === "ok" ? "text-positive" : "text-critical"}`}>{msg.text}</span>}
      </div>
    );
  }
  const inChrome = task.kind === "provision" && runsInChrome(task.adapterId) && isAutomated;
  if (inChrome && task.status === "in_progress" && task.externalRef?.startsWith("invited:")) {
    return <span className="text-[11.5px] text-meta">Invite sent, closes when they join</span>;
  }
  if (inChrome && task.status === "in_progress") {
    return (
      <div className="flex flex-wrap items-center justify-end gap-1.5">
        <span className="text-[11.5px] text-meta">Waiting for Chrome</span>
        <Button variant="outline" size="xs" onClick={() => void chrome()} disabled={disabled}>
          {busy === "chrome" ? "Starting…" : "Run again"}
        </Button>
        {msg && <span className={`text-[11px] ${msg.tone === "ok" ? "text-positive" : "text-critical"}`}>{msg.text}</span>}
      </div>
    );
  }
  if (task.status === "in_progress") {
    return <span className="text-[11.5px] text-meta">Running, waits for the system to confirm</span>;
  }

  return (
    <div className="flex flex-wrap items-center justify-end gap-1.5">
      {inChrome ? (
        <>
          <Button size="xs" onClick={() => void chrome()} disabled={disabled}>
            {busy === "chrome" ? "Starting…" : "Run in my Chrome"}
          </Button>
          <Button variant="outline" size="xs" onClick={() => run("mark_complete")} disabled={disabled}>
            {busy === "mark_complete" ? "Saving…" : "Done by hand"}
          </Button>
        </>
      ) : isAutomated ? (
        <Button size="xs" onClick={() => run("approve_execute")} disabled={disabled}>
          {busy === "approve_execute" ? "Running…" : `Approve & ${verb}`}
        </Button>
      ) : (
        <Button variant="outline" size="xs" onClick={() => run("mark_complete")} disabled={disabled}>
          {busy === "mark_complete" ? "Saving…" : "Mark complete"}
        </Button>
      )}
      {task.status === "failed" && (
        <Button variant="outline" size="xs" onClick={() => run("retry")} disabled={disabled}>Retry</Button>
      )}
      {!task.required && (
        <Button variant="ghost" size="xs" onClick={() => run("skip")} disabled={disabled}>Skip</Button>
      )}
      {msg && <span className={`text-[11px] ${msg.tone === "ok" ? "text-positive" : "text-critical"}`}>{msg.text}</span>}
    </div>
  );
}
