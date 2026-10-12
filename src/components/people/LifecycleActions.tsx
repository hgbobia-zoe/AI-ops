"use client";

// Lifecycle transition controls on the employee detail page. The buttons shown are DERIVED from the
// current state (the machine's legal moves): HIRE→Start onboarding; ONBOARD→Advance to Ready (guarded) +
// Offboard; READY→Activate + Offboard; ACTIVE→Offboard; OFFBOARD→Mark offboarded. The server re-checks
// every guard — this only triggers the transition.

import { useState } from "react";
import { useRouter } from "next/navigation";

export function LifecycleActions({ id, state }: { id: string; state: string }): React.JSX.Element {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ text: string; tone: "ok" | "bad" } | null>(null);
  const [effectiveDate, setEffectiveDate] = useState("");

  async function run(action: string, extra: Record<string, unknown> = {}): Promise<void> {
    setBusy(action);
    setMsg(null);
    try {
      const res = await fetch("/api/people/employee", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, id, ...extra }),
      });
      const data = (await res.json().catch(() => null)) as { ok?: boolean; message?: string; error?: string } | null;
      if (!res.ok || !data?.ok) setMsg({ text: data?.message ?? data?.error ?? "Failed.", tone: "bad" });
      else { setMsg({ text: data.message ?? "Done.", tone: "ok" }); router.refresh(); }
    } catch {
      setMsg({ text: "Network error.", tone: "bad" });
    } finally {
      setBusy(null);
    }
  }

  const primary = "inline-flex h-8 items-center rounded-md bg-foreground px-3 text-[12.5px] font-medium text-background transition-opacity hover:opacity-90 disabled:opacity-60";
  const secondary = "inline-flex h-8 items-center rounded-md border border-border px-3 text-[12.5px] font-medium text-secondary-text transition-colors hover:bg-[var(--row-hover)] hover:text-foreground disabled:opacity-60";
  const danger = "inline-flex h-8 items-center rounded-md border border-critical/40 px-3 text-[12.5px] font-medium text-critical transition-colors hover:bg-critical/10 disabled:opacity-60";

  const canOffboard = state === "HIRE" || state === "ONBOARD" || state === "READY" || state === "ACTIVE";

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        {state === "HIRE" && <button onClick={() => run("start_onboarding")} disabled={busy !== null} className={primary}>Start onboarding</button>}
        {state === "ONBOARD" && <button onClick={() => run("advance_ready")} disabled={busy !== null} className={primary}>Advance to Ready</button>}
        {state === "READY" && <button onClick={() => run("activate")} disabled={busy !== null} className={primary}>Activate</button>}
        {state === "OFFBOARD" && <button onClick={() => run("complete_offboarding")} disabled={busy !== null} className={secondary}>Mark offboarded</button>}
        {canOffboard && (
          <div className="flex items-center gap-1.5">
            <input type="date" value={effectiveDate} onChange={(e) => setEffectiveDate(e.target.value)} aria-label="Effective termination date"
              className="h-8 rounded-md border border-border bg-[var(--panel)] px-2 text-[12px] text-foreground" />
            <button onClick={() => run("start_offboarding", { effectiveDate: effectiveDate || null })} disabled={busy !== null} className={danger}>
              Offboard{effectiveDate ? ` (on ${effectiveDate})` : " now"}
            </button>
          </div>
        )}
      </div>
      {msg && <span className={`text-[12px] ${msg.tone === "ok" ? "text-positive" : "text-critical"}`}>{msg.text}</span>}
    </div>
  );
}
