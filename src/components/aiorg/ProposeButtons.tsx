"use client";

// AI Org v2 — the bounded "Draft & propose" affordance. An owner/admin triggers an employee's proposer,
// which creates approval requests from its REAL drafts/signals (capped, idempotent). It never sends.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Sparkles } from "lucide-react";

type RunState = { status: "idle" | "working" | "done" | "error"; message?: string };

function ProposeButton({ agent, label }: { agent: string; label: string }): React.JSX.Element {
  const router = useRouter();
  const [s, setS] = useState<RunState>({ status: "idle" });

  const run = async (): Promise<void> => {
    setS({ status: "working" });
    try {
      const res = await fetch("/api/ai-org/propose", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ agent }) });
      const j = (await res.json()) as { ok?: boolean; result?: { created: number; candidates: number; skipped: number }; error?: string };
      if (j.ok && j.result) {
        setS({ status: "done", message: `${j.result.created} new, ${j.result.skipped} already proposed (of ${j.result.candidates})` });
        router.refresh();
      } else {
        setS({ status: "error", message: j.error ?? "Failed" });
      }
    } catch {
      setS({ status: "error", message: "Failed" });
    }
  };

  return (
    <div className="flex items-center gap-2">
      <button onClick={run} disabled={s.status === "working"} className="flex items-center gap-1.5 border border-border bg-[var(--row)] px-3 py-1.5 text-[12.5px] text-foreground hover:bg-[var(--row-hover)] disabled:opacity-50">
        <Sparkles className="size-3.5" /> {label}
      </button>
      {s.status === "working" && <span className="text-[11.5px] text-meta">Drafting…</span>}
      {s.status === "done" && <span className="text-[11.5px] text-positive">{s.message}</span>}
      {s.status === "error" && <span className="text-[11.5px] text-critical">{s.message}</span>}
    </div>
  );
}

export function ProposeButtons(): React.JSX.Element {
  return (
    <div className="flex flex-wrap items-center gap-4">
      <ProposeButton agent="outreach" label="Draft Outreach proposals" />
      <ProposeButton agent="lost-quote" label="Draft Lost-Quote proposals" />
    </div>
  );
}
