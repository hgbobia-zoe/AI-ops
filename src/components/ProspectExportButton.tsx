"use client";

// Prospecting — export due email steps to the cold-email sequencer: downloads a CSV (imports into
// Instantly / Smartlead / Apollo / lemlist) and pushes to the configured provider when one is set.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Download } from "lucide-react";
import { toast } from "sonner";

export function ProspectExportButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  async function run() {
    setBusy(true);
    try {
      const res = await fetch("/api/prospecting/export", { method: "POST" });
      const data = (await res.json()) as { csv?: string; count?: number; pushed?: number; pushSkipped?: boolean; provider?: string; error?: string };
      if (!res.ok) throw new Error(data.error);
      if (!data.count) { toast.message("No email steps are due for export"); return; }
      // Download the CSV.
      const blob = new Blob([data.csv ?? ""], { type: "text/csv" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = `zoe-prospecting-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click(); URL.revokeObjectURL(url);
      toast.success(data.pushSkipped ? `${data.count} exported to CSV (no sequencer connected)` : `${data.count} exported · ${data.pushed} pushed to ${data.provider}`);
      router.refresh();
    } catch (e) {
      toast.error((e as Error).message || "Export failed");
    } finally {
      setBusy(false);
    }
  }
  return <button onClick={run} disabled={busy} className="inline-flex items-center gap-1.5 rounded border border-border px-2.5 py-1 text-[12px] text-tertiary-text transition-colors hover:bg-[var(--row-hover)] hover:text-foreground disabled:opacity-50"><Download className="size-3.5" /> {busy ? "Exporting…" : "Export email steps"}</button>;
}
