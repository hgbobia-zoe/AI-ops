"use client";

// Lifecycle controls for one risk in the /risk queue: acknowledge, start, resolve, dismiss —
// plus a jump-to link to where it gets fixed (Connecteam / Dispatch / Goodshuffle).

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ExternalLink } from "lucide-react";
import type { RiskStatus } from "@/lib/risk/types";

const TARGET: Record<string, { label: string; href: string; external: boolean }> = {
  connecteam: { label: "Open Connecteam", href: "https://app.connecteam.com", external: true },
  dispatch: { label: "Open dispatch", href: "/dispatch", external: false },
  goodshuffle: { label: "Open Goodshuffle", href: "https://pro.goodshuffle.com", external: true },
};

export function RiskActions({
  id,
  status,
  actionTarget,
}: {
  id: string;
  status: RiskStatus;
  actionTarget?: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const target = actionTarget ? TARGET[actionTarget] : undefined;

  async function set(next: RiskStatus) {
    setBusy(true);
    try {
      await fetch("/api/risk/status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, status: next }),
      });
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  const btn = "border border-white/15 px-2 py-0.5 text-[11px] text-muted-foreground hover:text-foreground disabled:opacity-50";

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {target &&
        (target.external ? (
          <a
            href={target.href}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 border border-white/15 px-2 py-0.5 text-[11px] text-muted-foreground hover:text-foreground"
          >
            <ExternalLink className="size-3" /> {target.label}
          </a>
        ) : (
          <a href={target.href} className="border border-white/15 px-2 py-0.5 text-[11px] text-muted-foreground hover:text-foreground">
            {target.label}
          </a>
        ))}
      {status === "OPEN" && (
        <button onClick={() => set("ACKNOWLEDGED")} disabled={busy} className={btn}>
          Acknowledge
        </button>
      )}
      {(status === "OPEN" || status === "ACKNOWLEDGED") && (
        <button onClick={() => set("IN_PROGRESS")} disabled={busy} className={btn}>
          Start
        </button>
      )}
      <button onClick={() => set("RESOLVED")} disabled={busy} className={btn}>
        Resolve
      </button>
      <button onClick={() => set("DISMISSED")} disabled={busy} className={btn}>
        Dismiss
      </button>
    </div>
  );
}
