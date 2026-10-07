"use client";

// Resolve / Ignore a payroll exception — an explicit human action (never silent). Posts to
// /api/payroll/exception and refreshes.

import { useState } from "react";
import { useRouter } from "next/navigation";

export function ExceptionActions({ id }: { id: string }): React.JSX.Element {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function act(status: "RESOLVED" | "IGNORED"): Promise<void> {
    setBusy(true);
    try {
      const res = await fetch("/api/payroll/exception", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, status }),
      });
      if (res.ok) router.refresh();
    } catch {
      /* ignore — the row stays, user can retry */
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex shrink-0 items-center gap-1.5">
      <button onClick={() => act("RESOLVED")} disabled={busy} className="rounded border border-border px-2 py-0.5 text-[11px] text-secondary-text transition-colors hover:bg-[var(--row-hover)] hover:text-foreground disabled:opacity-50">Resolve</button>
      <button onClick={() => act("IGNORED")} disabled={busy} className="rounded border border-border px-2 py-0.5 text-[11px] text-meta transition-colors hover:bg-[var(--row-hover)] hover:text-foreground disabled:opacity-50">Ignore</button>
    </div>
  );
}
