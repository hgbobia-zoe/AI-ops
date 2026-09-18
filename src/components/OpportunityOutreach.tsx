"use client";

// Opportunity Radar — outreach panel (§10). Draft (template floor + optional AI), edit, approve, then
// record a send (no automated blast). Recording a send advances the opportunity to CONTACTED.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Mail } from "lucide-react";
import { toast } from "sonner";

interface Outreach {
  id: string;
  subject: string | null;
  body: string | null;
  callScript: string | null;
  followUps: string[];
  reason: string | null;
  status: "draft" | "approved" | "sent" | "skipped";
  source: "template" | "ai";
}

const STATUS_TONE: Record<string, string> = { draft: "text-meta", approved: "text-attention", sent: "text-positive", skipped: "text-meta" };

export function OpportunityOutreach({ id, drafts, hasTarget }: { id: string; drafts: Outreach[]; hasTarget: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [edit, setEdit] = useState<Record<string, { subject: string; body: string }>>({});

  async function post(payload: Record<string, unknown>, ok: string) {
    setBusy(true);
    try {
      const res = await fetch("/api/opportunity/outreach", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      if (!res.ok) throw new Error();
      toast.success(ok);
      router.refresh();
    } catch {
      toast.error("Action failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded border border-border p-3 text-[13px]">
      {drafts.length === 0 && (
        <div className="flex items-center justify-between gap-3">
          <span className="text-meta">No outreach yet. Draft a first-touch email + call script for the target.{!hasTarget && " (No target identified yet — draft will address the organizer generically.)"}</span>
          <button onClick={() => post({ action: "draft", id }, "Draft created")} disabled={busy} className="inline-flex shrink-0 items-center gap-2 rounded border border-foreground/25 bg-foreground/[0.06] px-3 py-1.5 text-[12.5px] font-medium text-foreground transition-colors hover:bg-foreground/[0.12] disabled:opacity-50">
            <Mail className="size-3.5" /> {busy ? "Drafting…" : "Draft outreach"}
          </button>
        </div>
      )}
      {drafts.map((d) => {
        const e = edit[d.id] ?? { subject: d.subject ?? "", body: d.body ?? "" };
        return (
          <div key={d.id} className="mb-2 border-t border-[var(--row-rule)] pt-2 first:border-t-0 first:pt-0">
            <div className="mb-1 flex items-center gap-2 text-[11px]">
              <span className={`font-semibold uppercase tracking-[0.06em] ${STATUS_TONE[d.status]}`}>{d.status}</span>
              <span className="text-meta">{d.source === "ai" ? "AI-drafted" : "template"}</span>
            </div>
            <input
              value={e.subject}
              onChange={(ev) => setEdit((p) => ({ ...p, [d.id]: { ...e, subject: ev.target.value } }))}
              className="mb-1 w-full rounded border border-border bg-transparent px-2 py-1 text-[12.5px] font-medium text-foreground"
            />
            <textarea
              value={e.body}
              onChange={(ev) => setEdit((p) => ({ ...p, [d.id]: { ...e, body: ev.target.value } }))}
              rows={5}
              className="w-full rounded border border-border bg-transparent px-2 py-1 text-[12.5px] text-secondary-text"
            />
            {d.callScript && <details className="mt-1 text-[12px] text-meta"><summary className="cursor-pointer">Call script</summary><p className="mt-1 text-tertiary-text">{d.callScript}</p></details>}
            {d.followUps.length > 0 && <details className="mt-1 text-[12px] text-meta"><summary className="cursor-pointer">Follow-up sequence</summary><ul className="mt-1 space-y-0.5 text-tertiary-text">{d.followUps.map((f, i) => <li key={i}>• {f}</li>)}</ul></details>}
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              <button onClick={() => post({ action: "edit", outreachId: d.id, subject: e.subject, body: e.body }, "Saved")} disabled={busy} className="rounded border border-border px-2 py-0.5 text-[11.5px] text-tertiary-text hover:text-foreground disabled:opacity-50">Save edits</button>
              {d.status !== "sent" && <button onClick={() => post({ action: "status", outreachId: d.id, status: "sent" }, "Marked sent — opportunity moved to Contacted")} disabled={busy} className="rounded border border-positive/40 px-2 py-0.5 text-[11.5px] text-positive hover:bg-[var(--row-hover)] disabled:opacity-50">Mark sent</button>}
              {d.status === "draft" && <button onClick={() => post({ action: "status", outreachId: d.id, status: "skipped" }, "Skipped")} disabled={busy} className="rounded border border-border px-2 py-0.5 text-[11.5px] text-meta hover:text-foreground disabled:opacity-50">Skip</button>}
            </div>
          </div>
        );
      })}
    </div>
  );
}
