"use client";

// Sync Now — posts to the shared payroll sync engine and refreshes the page with the result. The real
// mutation + idempotency live server-side; this is just the trigger + status readout.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw } from "lucide-react";

export function SyncButton({
  which,
  label = "Sync Hours",
  variant = "primary",
}: {
  which: "current" | "previous";
  label?: string;
  variant?: "primary" | "secondary";
}): React.JSX.Element {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; tone: "ok" | "warn" | "bad" } | null>(null);

  async function run(): Promise<void> {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/payroll/sync", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ which }),
      });
      const data = (await res.json().catch(() => null)) as { summary?: { status: string; message: string } } | null;
      if (!res.ok || !data?.summary) {
        setMsg({ text: data && "error" in data ? String((data as { error: unknown }).error) : "Sync failed.", tone: "bad" });
      } else {
        const s = data.summary;
        setMsg({ text: s.message, tone: s.status === "READY" ? "ok" : s.status === "FAILED" ? "bad" : "warn" });
        router.refresh();
      }
    } catch {
      setMsg({ text: "Sync failed — network error.", tone: "bad" });
    } finally {
      setBusy(false);
    }
  }

  const base =
    variant === "primary"
      ? "bg-foreground text-background hover:opacity-90"
      : "border border-border text-secondary-text hover:bg-[var(--row-hover)] hover:text-foreground";
  const toneCls = msg?.tone === "ok" ? "text-positive" : msg?.tone === "warn" ? "text-attention" : "text-critical";

  return (
    <div className="flex flex-col gap-1.5">
      <button
        onClick={run}
        disabled={busy}
        className={`inline-flex h-9 items-center justify-center gap-2 rounded-md px-4 text-[13px] font-medium transition-colors disabled:opacity-60 ${base}`}
      >
        <RefreshCw className={`size-4 ${busy ? "animate-spin" : ""}`} />
        {busy ? "Syncing…" : label}
      </button>
      {msg && <span className={`text-[11.5px] ${toneCls}`}>{msg.text}</span>}
    </div>
  );
}
