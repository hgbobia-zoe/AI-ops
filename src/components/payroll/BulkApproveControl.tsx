"use client";

// Approve ALL the REQUIRES_REVIEW workers into this period's run in one click — the human reviewed the whole
// section and accepts the lot. Loops the per-worker accept endpoint (/api/payroll/worker/accept), which is
// owner/admin-gated + audited there. Each promotion (REQUIRES_REVIEW -> READY) is handled by classifyReview.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { CheckCheck } from "lucide-react";

export interface BulkApproveControlProps {
  workers: { workerKey: string; name: string }[];
  periodStart: string;
  periodEnd: string;
}

export function BulkApproveControl({ workers, periodStart, periodEnd }: BulkApproveControlProps): React.JSX.Element {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function approveAll(): Promise<void> {
    if (!workers.length || busy) return;
    setBusy(true);
    setErr(null);
    let failed = 0;
    try {
      for (const w of workers) {
        try {
          const res = await fetch("/api/payroll/worker/accept", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ action: "accept", workerKey: w.workerKey, name: w.name, periodStart, periodEnd }),
          });
          if (!res.ok) failed++;
        } catch {
          failed++;
        }
      }
      if (failed) setErr(`${failed} of ${workers.length} could not be approved.`);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-0.5">
      <button
        onClick={approveAll}
        disabled={busy || workers.length === 0}
        className="inline-flex h-7 items-center gap-1.5 rounded border border-positive/40 px-2.5 text-[11.5px] font-medium text-positive transition-colors hover:bg-positive/10 disabled:opacity-40"
      >
        <CheckCheck className="size-3.5" /> {busy ? "Approving…" : `Approve all (${workers.length})`}
      </button>
      {err && <span className="text-[10.5px] text-critical">{err}</span>}
    </div>
  );
}
