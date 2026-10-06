"use client";

// AI session workspace controls — the operating surface for one session: send a new instruction, set the
// objective, rename, pause/resume, archive. Writes go to /api/ai/sessions/manage (operate level). Nothing
// here executes an operational action — an AI-proposed mutation still flows through the approval queue.

import { useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Send, Pause, Play, Pencil, Archive, Target, Check, X } from "lucide-react";
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

  const terminal = TERMINAL.includes(status);

  const call = useCallback(
    async (op: string, extra: Record<string, unknown> = {}) => {
      setBusy(op);
      try {
        const r = await fetch("/api/ai/sessions/manage", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sessionId, op, ...extra }),
        });
        if (r.ok) router.refresh();
      } finally {
        setBusy(null);
      }
    },
    [sessionId, router],
  );

  const sendInstruction = useCallback(async () => {
    const text = instruction.trim();
    if (!text) return;
    await call("instruct", { text });
    setInstruction("");
  }, [instruction, call]);

  return (
    <div className="space-y-3">
      {/* Instruction box */}
      {!terminal && (
        <div className="surface border p-3">
          <label className="mb-1.5 block text-[11px] uppercase tracking-[0.1em] text-meta">Send a new instruction</label>
          <textarea
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            rows={2}
            placeholder="Tell this session what to do next…"
            className="w-full resize-y rounded border border-border bg-[var(--panel)] px-2.5 py-2 text-[13px] text-foreground placeholder:text-meta focus:border-foreground/30 focus:outline-none"
          />
          <div className="mt-2 flex justify-end">
            <button
              onClick={sendInstruction}
              disabled={busy === "instruct" || !instruction.trim()}
              className="inline-flex items-center gap-1.5 border border-attention/50 px-2.5 py-1 text-[12.5px] font-medium text-attention transition-colors hover:bg-attention/10 disabled:opacity-50"
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
