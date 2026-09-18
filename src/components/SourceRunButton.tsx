"use client";

// Sources — "Run now" for an API source (SAM.gov). Pulls live data server-side when the key is set;
// reports clearly when the source is dormant.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Play } from "lucide-react";
import { toast } from "sonner";

export function SourceRunButton({ sourceId }: { sourceId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  async function run() {
    setBusy(true);
    try {
      const res = await fetch("/api/radar/source/run", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sourceId }) });
      const data = (await res.json()) as { dormant?: boolean; message?: string; stored?: number; error?: string };
      if (!res.ok) throw new Error(data.error);
      if (data.dormant) toast.message(data.message ?? "Source is dormant");
      else toast.success(`Pulled ${data.stored ?? 0} opportunit${data.stored === 1 ? "y" : "ies"}`);
      router.refresh();
    } catch (e) {
      toast.error((e as Error).message || "Run failed");
    } finally {
      setBusy(false);
    }
  }
  return <button onClick={run} disabled={busy} className="inline-flex items-center gap-1 rounded border border-border px-2 py-0.5 text-[11.5px] text-tertiary-text hover:bg-[var(--row-hover)] hover:text-foreground disabled:opacity-50"><Play className="size-3" /> {busy ? "…" : "Run now"}</button>;
}
