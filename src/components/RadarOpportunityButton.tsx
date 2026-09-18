"use client";

// Event Radar → Sales OS handoff control. Creates (or shows) the opportunity bridge for an event.
// The event stays the source record — this does not duplicate it. Once created, it offers a jump into
// Sales OS. Kept honest: the label reflects whether an opportunity already exists.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowUpRight, Send } from "lucide-react";
import { toast } from "sonner";

export function RadarOpportunityButton({
  eventId,
  salesStatus,
  bookingId,
}: {
  eventId: string;
  salesStatus: "NONE" | "OPPORTUNITY_CREATED" | "LINKED";
  bookingId: string | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const created = salesStatus !== "NONE";

  async function create() {
    setBusy(true);
    try {
      const res = await fetch("/api/radar/opportunity", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ eventId, nextAction: "Identify planner and open a relationship" }),
      });
      if (!res.ok) throw new Error(String(res.status));
      toast.success("Sales opportunity created — handed to Sales OS");
      router.refresh();
    } catch {
      toast.error("Could not create the opportunity");
    } finally {
      setBusy(false);
    }
  }

  if (created) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center rounded border border-positive/40 px-2 py-1 text-[12px] font-medium text-positive">
          {salesStatus === "LINKED" ? "Linked to Sales OS" : "Opportunity created"}
        </span>
        <a
          href={bookingId ? `/salesos/${bookingId}` : "/salesos"}
          className="inline-flex items-center gap-1.5 rounded border border-border px-2.5 py-1 text-[12px] text-tertiary-text transition-colors hover:bg-[var(--row-hover)] hover:text-foreground"
        >
          Open in Sales OS <ArrowUpRight className="size-3.5" />
        </a>
      </div>
    );
  }

  return (
    <button
      onClick={create}
      disabled={busy}
      className="inline-flex items-center gap-2 rounded border border-foreground/25 bg-foreground/[0.06] px-3 py-1.5 text-[12.5px] font-medium text-foreground transition-colors hover:bg-foreground/[0.12] disabled:opacity-50"
    >
      <Send className="size-3.5" /> {busy ? "Creating…" : "Create sales opportunity"}
    </button>
  );
}
