"use client";

// Reload the Opportunity Radar DEMO dataset (procurement + facility signals) and re-bridge events.
// Idempotent server-side. Only shown to users who can manage settings; every row stays badged SEED.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw } from "lucide-react";
import { toast } from "sonner";

export function OpportunitySeedButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  async function reseed() {
    setBusy(true);
    try {
      const res = await fetch("/api/opportunity/seed", { method: "POST" });
      if (!res.ok) throw new Error();
      toast.success("Demo dataset reloaded");
      router.refresh();
    } catch {
      toast.error("Could not reload demo data");
    } finally {
      setBusy(false);
    }
  }
  return (
    <button onClick={reseed} disabled={busy} className="inline-flex items-center gap-1.5 rounded border border-border px-2.5 py-1 text-[12px] text-tertiary-text transition-colors hover:bg-[var(--row-hover)] hover:text-foreground disabled:opacity-50">
      <RefreshCw className={`size-3.5 ${busy ? "animate-spin" : ""}`} /> Reload demo data
    </button>
  );
}
