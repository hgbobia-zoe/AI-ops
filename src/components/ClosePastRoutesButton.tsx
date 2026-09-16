"use client";

// Office action in the overdue-routes banner: bulk-close every route still open past its delivery date.
// Owner/Admin only (the parent decides whether to render it). Confirms first, since it closes several
// routes at once; unfinished stops are preserved and move to the "needs rescheduling" list.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { CircleX, Check } from "lucide-react";

export function ClosePastRoutesButton({ count }: { count: number }): React.JSX.Element {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  async function run(): Promise<void> {
    setBusy(true);
    try {
      const r = await fetch("/api/dispatch/close-past-routes", { method: "POST" });
      const j = (await r.json()) as { ok?: boolean; closed?: number; needRescheduling?: number; error?: string };
      if (j.ok) {
        setDone(`Closed ${j.closed ?? 0}${j.needRescheduling ? ` · ${j.needRescheduling} to reschedule` : ""}`);
        router.refresh();
      } else {
        setDone(j.error === "unauthorized" ? "Not allowed" : "Failed");
      }
    } catch {
      setDone("Failed");
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  }

  if (done) return <span className="inline-flex items-center gap-1.5 text-[12px] font-medium text-rose-100"><Check className="size-3.5" /> {done}</span>;

  if (confirming) {
    return (
      <span className="inline-flex flex-wrap items-center gap-2 text-[12px]">
        <span>Close {count} past route{count === 1 ? "" : "s"}? Unfinished stops move to rescheduling.</span>
        <button onClick={run} disabled={busy} className="rounded border border-rose-400/60 bg-rose-500/20 px-2 py-1 font-medium text-rose-50 disabled:opacity-60">{busy ? "Closing…" : "Yes, close all"}</button>
        <button onClick={() => setConfirming(false)} disabled={busy} className="rounded border border-white/20 px-2 py-1 text-rose-100/80">Cancel</button>
      </span>
    );
  }

  return (
    <button onClick={() => setConfirming(true)} className="inline-flex items-center gap-1.5 rounded border border-rose-400/50 px-2.5 py-1 text-[12px] font-medium text-rose-50 transition-colors hover:bg-rose-500/20">
      <CircleX className="size-3.5" /> Close all past routes
    </button>
  );
}
