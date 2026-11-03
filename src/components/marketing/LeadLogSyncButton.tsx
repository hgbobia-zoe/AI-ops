"use client";

// "Sync now" for the marketing lead log: reads new #new-leads posts and refreshes the page.

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

export function LeadLogSyncButton(): React.JSX.Element {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [, startTransition] = useTransition();

  async function sync(): Promise<void> {
    setBusy(true);
    try {
      const res = await fetch("/api/marketing/leads/sync", { method: "POST" });
      const r = (await res.json().catch(() => ({}))) as { ok?: boolean; detail?: string; added?: number };
      if (r.ok) toast.success(r.added ? `Saved ${r.added} new ${r.added === 1 ? "lead" : "leads"}` : "Up to date");
      else toast.error(r.detail || "Sync failed");
      startTransition(() => router.refresh());
    } catch {
      toast.error("Sync failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      onClick={sync}
      disabled={busy}
      className="inline-flex items-center gap-1 text-[11.5px] text-meta transition-colors hover:text-foreground disabled:opacity-60"
    >
      <RefreshCw className={cn("size-3.5", busy && "animate-spin")} aria-hidden />
      {busy ? "Syncing" : "Sync now"}
    </button>
  );
}
