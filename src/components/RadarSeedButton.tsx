"use client";

// Reload the Event Radar DEMO dataset. Idempotent on the server (upserts by dedupe_key). Only shown to
// users who can manage settings; every row it writes stays badged "SEED".

import { useState } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw } from "lucide-react";
import { toast } from "sonner";

export function RadarSeedButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  async function reseed() {
    setBusy(true);
    try {
      const res = await fetch("/api/radar/seed", { method: "POST" });
      if (!res.ok) throw new Error(String(res.status));
      toast.success("Demo dataset reloaded");
      router.refresh();
    } catch {
      toast.error("Could not reload demo data");
    } finally {
      setBusy(false);
    }
  }
  return (
    <button
      onClick={reseed}
      disabled={busy}
      className="inline-flex items-center gap-1.5 rounded border border-border px-2.5 py-1 text-[12px] text-tertiary-text transition-colors hover:bg-[var(--row-hover)] hover:text-foreground disabled:opacity-50"
    >
      <RefreshCw className={`size-3.5 ${busy ? "animate-spin" : ""}`} /> Reload demo data
    </button>
  );
}
