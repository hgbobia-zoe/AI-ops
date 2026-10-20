"use client";

// Admin control: arm the one-shot "Force-archive deleted Goodshuffle projects on next pull". The daily
// bookings pull leaves deleted projects in place when a large number go missing at once (it assumes a
// truncated pull, not real deletions). When the office owner has DELIBERATELY deleted a batch in
// Goodshuffle, this arms a server-side one-shot flag (POST /api/admin/force-prune-bookings) that the NEXT
// complete pull consumes to archive every orphan, then disarms. It does not pull or archive here — the
// office browser extension pulls on its own cycle, so the sweep lands on that next complete pull.

import { useState } from "react";
import { Loader2, Check, AlertTriangle, Trash2 } from "lucide-react";

export function ForcePruneBookings({ pin }: { pin: string }): React.JSX.Element {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [armed, setArmed] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function arm(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch("/api/admin/force-prune-bookings", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-admin-pin": pin },
      });
      if (!r.ok) {
        setError(r.status === 401 ? "Wrong admin code — can't arm." : `Couldn't arm (${r.status}).`);
        return;
      }
      setArmed(true);
    } catch {
      setError("Couldn't arm — network error.");
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        The daily pull leaves deleted Goodshuffle projects in place when a large batch goes missing at once,
        in case the pull was cut short. If you deliberately deleted a batch of projects in Goodshuffle, arm
        this once and the next complete pull will archive every project Goodshuffle no longer returns.
      </p>

      {armed ? (
        <div className="flex items-start gap-2 rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm text-emerald-300">
          <Check className="mt-0.5 size-4 shrink-0" />
          <span>
            Armed. The next complete Goodshuffle pull will archive every deleted project, then this turns
            itself off. The office browser pulls on its usual cycle, so this takes effect on that next
            complete pull — nothing happens until then.
          </span>
        </div>
      ) : confirming ? (
        <div className="space-y-3 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3">
          <div className="flex items-start gap-2 text-sm text-amber-200">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            <span>
              On the next complete pull this will archive <span className="font-semibold">every</span> project
              Goodshuffle no longer returns. Only do this if you just deleted those projects in Goodshuffle on
              purpose. It is reversible — a later pull that includes a project restores it.
            </span>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              onClick={arm}
              disabled={busy}
              className="inline-flex items-center gap-2 rounded-xl bg-foreground px-4 py-2 text-sm font-medium text-background disabled:opacity-50"
            >
              {busy ? <Loader2 className="size-4 animate-spin" /> : null}
              Yes, arm force-archive
            </button>
            <button
              onClick={() => setConfirming(false)}
              disabled={busy}
              className="rounded-xl border border-white/15 px-4 py-2 text-sm text-muted-foreground hover:text-foreground disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setConfirming(true)}
          className="inline-flex items-center gap-2 rounded-xl border border-white/15 px-4 py-2.5 text-sm hover:bg-accent"
        >
          <Trash2 className="size-4" /> Force-archive deleted Goodshuffle projects on next pull
        </button>
      )}

      {error && <p className="text-sm text-red-400">{error}</p>}
    </div>
  );
}
