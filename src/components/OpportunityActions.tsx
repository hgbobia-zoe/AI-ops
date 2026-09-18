"use client";

// Opportunity Radar — detail actions: advance the lifecycle stage (manual override) and hand the
// opportunity to Sales OS. The opportunity stays the source record; the handoff is a bridge.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowUpRight, Send } from "lucide-react";
import { toast } from "sonner";
import { STAGE_LABEL, STAGE_ORDER, type LifecycleStage } from "@/lib/opportunity/types";

const SELECTABLE: LifecycleStage[] = [...STAGE_ORDER, "QUOTED", "WON", "LOST", "ARCHIVED"].filter((s, i, a) => a.indexOf(s) === i) as LifecycleStage[];

export function OpportunityActions({
  id,
  stage,
  salesStatus,
  bookingId,
}: {
  id: string;
  stage: LifecycleStage;
  salesStatus: "NONE" | "OPPORTUNITY_CREATED" | "LINKED";
  bookingId: string | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const created = salesStatus !== "NONE";

  async function setStage(next: string) {
    if (next === stage) return;
    setBusy(true);
    try {
      const res = await fetch("/api/opportunity/stage", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, stage: next }) });
      if (!res.ok) throw new Error();
      toast.success(`Stage set to ${STAGE_LABEL[next as LifecycleStage]}`);
      router.refresh();
    } catch {
      toast.error("Could not update the stage");
    } finally {
      setBusy(false);
    }
  }

  async function handoff() {
    setBusy(true);
    try {
      const res = await fetch("/api/opportunity/handoff", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, nextAction: "Identify contact and open a relationship" }) });
      if (!res.ok) throw new Error();
      toast.success("Handed to Sales OS");
      router.refresh();
    } catch {
      toast.error("Could not create the opportunity");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <label className="flex items-center gap-1.5 text-[12px] text-meta">
        Stage
        <select
          value={stage}
          disabled={busy}
          onChange={(e) => setStage(e.target.value)}
          className="rounded border border-border bg-transparent px-2 py-1 text-[12.5px] text-foreground disabled:opacity-50"
        >
          {SELECTABLE.map((s) => <option key={s} value={s} className="bg-background">{STAGE_LABEL[s]}</option>)}
        </select>
      </label>
      {created ? (
        <a href={bookingId ? `/salesos/${bookingId}` : "/salesos"} className="inline-flex items-center gap-1.5 rounded border border-positive/40 px-2.5 py-1.5 text-[12.5px] font-medium text-positive transition-colors hover:bg-[var(--row-hover)]">
          {salesStatus === "LINKED" ? "Linked to Sales OS" : "In Sales OS"} <ArrowUpRight className="size-3.5" />
        </a>
      ) : (
        <button onClick={handoff} disabled={busy} title="For after a prospect responds — creates the Sales OS / Goodshuffle quote" className="inline-flex items-center gap-2 rounded border border-foreground/25 bg-foreground/[0.06] px-3 py-1.5 text-[12.5px] font-medium text-foreground transition-colors hover:bg-foreground/[0.12] disabled:opacity-50">
          <Send className="size-3.5" /> {busy ? "Working…" : "Convert to Goodshuffle"}
        </button>
      )}
    </div>
  );
}
