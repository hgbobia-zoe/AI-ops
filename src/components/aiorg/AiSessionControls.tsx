"use client";

// AI session workspace controls — the operating surface for one session: send a new instruction, set the
// objective, rename, pause/resume, archive. Writes go to /api/ai/sessions/manage (operate level). Nothing
// here executes an operational action — an AI-proposed mutation still flows through the approval queue.

import { useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Send, Pause, Play, Pencil, Archive, Target, Check, X, AlertTriangle, CheckCircle2 } from "lucide-react";
import type { SessionStatus } from "@/lib/ai/sessions";

const TERMINAL: SessionStatus[] = ["done", "failed", "cancelled"];

export function AiSessionControls({
  sessionId,
  status,
  title,
  objective,
  archived,
}: {
  sessionId: string;
  status: SessionStatus;
  title: string;
  objective: string | null;
  archived: boolean;
}): React.JSX.Element {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [instruction, setInstruction] = useState("");
  const [editTitle, setEditTitle] = useState<string | null>(null);
  const [editObjective, setEditObjective] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  const terminal = TERMINAL.includes(status);

  // Returns true on success so callers can react (clear the box, confirm). Errors are surfaced, never
  // swallowed — a dropped request used to look identical to a delivered one.
  const call = useCallback(
    async (op: string, extra: Record<string, unknown> = {}): Promise<boolean> => {
      setBusy(op);
      setError(null);
      try {
        const r = await fetch("/api/ai/sessions/manage", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sessionId, op, ...extra }),
        });
        if (r.ok) {
          router.refresh();
          return true;
        }
        let msg = `Request failed (${r.status}).`;
        try {
          const j = (await r.json()) as { error?: string };
          if (j?.error) msg = `Request failed: ${j.error}.`;
        } catch {
          /* non-JSON error body */
        }
        setError(msg);
        return false;
      } catch {
        setError("Could not reach the server — your instruction was not sent. Check your connection and try again.");
        return false;
      } finally {
        setBusy(null);
      }
    },
    [sessionId, router],
  );

  const sendInstruction = useCallback(async () => {
    const text = instruction.trim();
    if (!text) return;
    setSent(false);
    const ok = await call("instruct", { text });
    if (ok) {
      setInstruction("");
      setSent(true);
    }
  }, [instruction, call]);

  return (
    <div className="space-y-3">
      {/* Instruction box */}
      {!terminal && (
        <div className="surface border p-3">
          <label className="mb-1.5 block text-[11px] uppercase tracking-[0.1em] text-meta">Send a new instruction</label>
          <textarea
            value={instruction}
            onChange={(e) => { setInstruction(e.target.value); setSent(false); }}
            rows={2}
            placeholder="Tell this session what to do next…"
            className="w-full resize-y rounded border border-border bg-[var(--panel)] px-2.5 py-2 text-[13px] text-foreground placeholder:text-meta focus:border-foreground/30 focus:outline-none"
          />
          <div className="mt-2 flex items-center justify-between gap-2">
            <span aria-live="polite" className="min-w-0 text-[11.5px]">
              {error ? (
                <span className="inline-flex items-center gap-1 text-critical"><AlertTriangle className="size-3.5 shrink-0" /> {error}</span>
              ) : sent ? (
                <span className="inline-flex items-center gap-1 text-positive"><CheckCircle2 className="size-3.5 shrink-0" /> Sent. Recorded in the activity stream — see the status above.</span>
              ) : null}
            </span>
            <button
              onClick={sendInstruction}
              disabled={busy === "instruct" || !instruction.trim()}
              className="inline-flex shrink-0 items-center gap-1.5 border border-attention/50 px-2.5 py-1 text-[12.5px] font-medium text-attention transition-colors hover:bg-attention/10 disabled:opacity-50"
            >
              {busy === "instruct" ? <Loader2 className="size-3.5 animate-spin" /> : <Send className="size-3.5" />} Send
            </button>
          </div>
        </div>
      )}

      {/* Lifecycle controls */}
      <div className="flex flex-wrap items-center gap-2">
        {!terminal && status === "paused" && (
          <Btn onClick={() => call("resume")} busy={busy === "resume"} icon={<Play className="size-3.5" />}>Resume</Btn>
        )}
        {!terminal && status !== "paused" && (
          <Btn onClick={() => call("pause")} busy={busy === "pause"} icon={<Pause className="size-3.5" />}>Pause</Btn>
        )}
        <Btn onClick={() => setEditTitle(title)} icon={<Pencil className="size-3.5" />}>Rename</Btn>
        <Btn onClick={() => setEditObjective(objective ?? "")} icon={<Target className="size-3.5" />}>{objective ? "Edit objective" : "Set objective"}</Btn>
        <Btn onClick={() => call("archive", { archived: !archived })} busy={busy === "archive"} icon={<Archive className="size-3.5" />}>{archived ? "Unarchive" : "Archive"}</Btn>
      </div>

      {/* Inline rename */}
      {editTitle !== null && (
        <InlineEdit
          value={editTitle}
          onChange={setEditTitle}
          placeholder="Session name"
          busy={busy === "rename"}
          onSave={async () => { if (editTitle.trim()) { await call("rename", { title: editTitle.trim() }); } setEditTitle(null); }}
          onCancel={() => setEditTitle(null)}
        />
      )}

      {/* Inline objective */}
      {editObjective !== null && (
        <InlineEdit
          value={editObjective}
          onChange={setEditObjective}
          placeholder="What should this session achieve?"
          textarea
          busy={busy === "objective"}
          onSave={async () => { await call("objective", { objective: editObjective.trim() }); setEditObjective(null); }}
          onCancel={() => setEditObjective(null)}
        />
      )}
    </div>
  );
}

function Btn({ onClick, busy, icon, children }: { onClick: () => void; busy?: boolean; icon: React.ReactNode; children: React.ReactNode }): React.JSX.Element {
  return (
    <button
      onClick={onClick}
      disabled={busy}
      className="inline-flex items-center gap-1.5 border border-border px-2.5 py-1 text-[12px] text-muted-foreground transition-colors hover:bg-[var(--row-hover)] hover:text-foreground disabled:opacity-50"
    >
      {busy ? <Loader2 className="size-3.5 animate-spin" /> : icon} {children}
    </button>
  );
}

function InlineEdit({
  value,
  onChange,
  placeholder,
  textarea,
  busy,
  onSave,
  onCancel,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  textarea?: boolean;
  busy?: boolean;
  onSave: () => void;
  onCancel: () => void;
}): React.JSX.Element {
  return (
    <div className="flex items-start gap-2 border border-border bg-panel p-2.5">
      {textarea ? (
        <textarea value={value} onChange={(e) => onChange(e.target.value)} rows={2} placeholder={placeholder} className="min-w-0 flex-1 resize-y rounded border border-border bg-[var(--panel)] px-2.5 py-1.5 text-[13px] text-foreground placeholder:text-meta focus:border-foreground/30 focus:outline-none" />
      ) : (
        <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} className="min-w-0 flex-1 rounded border border-border bg-[var(--panel)] px-2.5 py-1.5 text-[13px] text-foreground placeholder:text-meta focus:border-foreground/30 focus:outline-none" />
      )}
      <button onClick={onSave} disabled={busy} className="inline-flex items-center gap-1 border border-positive/40 px-2 py-1.5 text-[12px] text-positive transition-colors hover:bg-positive/10 disabled:opacity-50">
        {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
      </button>
      <button onClick={onCancel} className="inline-flex items-center gap-1 border border-border px-2 py-1.5 text-[12px] text-meta transition-colors hover:bg-[var(--row-hover)] hover:text-foreground">
        <X className="size-3.5" />
      </button>
    </div>
  );
}
