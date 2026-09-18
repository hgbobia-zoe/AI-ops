"use client";

// Prospecting — route an opportunity into the outreach motion (does NOT touch Goodshuffle). Shows the
// tier it will land in before enrolling, then enrolls and reveals the cadence tasks.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Radar } from "lucide-react";
import { toast } from "sonner";

export function RouteToProspecting({ opportunityId, tierPreview, reasons }: { opportunityId: string; tierPreview: "A" | "B" | "C"; reasons: string[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  const label = tierPreview === "A" ? "Tier A — call first" : tierPreview === "B" ? "Tier B — email sequence" : "Tier C — monitor only";

  async function enroll() {
    setBusy(true);
    try {
      const res = await fetch("/api/prospecting/enroll", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ opportunityId }) });
      const data = (await res.json()) as { enrolled?: boolean; tier?: string; error?: string };
      if (!res.ok) throw new Error(data.error);
      if (!data.enrolled) toast.message(`Tier ${data.tier} — monitor only, not enrolled`);
      else toast.success(`Routed to prospecting (Tier ${data.tier})`);
      router.refresh();
    } catch (e) {
      toast.error((e as Error).message || "Could not route");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded border border-border p-3 text-[13px]">
      <div className="mb-1 flex items-center gap-2">
        <span className={`text-[11px] font-semibold uppercase tracking-[0.06em] ${tierPreview === "A" ? "text-positive" : tierPreview === "B" ? "text-attention" : "text-meta"}`}>{label}</span>
      </div>
      <ul className="mb-2 space-y-0.5 text-meta">{reasons.map((r, i) => <li key={i}>· {r}</li>)}</ul>
      {tierPreview === "C" ? (
        <p className="text-[12.5px] text-meta">Below the outreach bar — kept on the radar; no sequence started.</p>
      ) : (
        <button onClick={enroll} disabled={busy} className="inline-flex items-center gap-2 rounded border border-foreground/25 bg-foreground/[0.06] px-3 py-1.5 text-[12.5px] font-medium text-foreground transition-colors hover:bg-foreground/[0.12] disabled:opacity-50">
          <Radar className="size-3.5" /> {busy ? "Routing…" : "Route to prospecting"}
        </button>
      )}
      <p className="mt-2 text-[11.5px] text-meta">This starts cold outreach (calls / email sequence). Goodshuffle is only used later, once they respond.</p>
    </div>
  );
}
