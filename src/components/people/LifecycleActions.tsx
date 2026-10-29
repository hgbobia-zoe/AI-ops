"use client";

// Lifecycle transition controls on the employee detail page. The buttons shown are DERIVED from the
// current state (the machine's legal moves): HIRE→Start onboarding; ONBOARD→Advance to Ready (guarded) +
// Offboard; READY→Activate + Offboard; ACTIVE→Offboard; OFFBOARD→Mark offboarded. The server re-checks
// every guard — this only triggers the transition.
//
// Offboarding is destructive, so it opens an inline CONFIRMATION with the person's name, the effective
// date, and the honest reminder that manual revokes stay open afterwards — no private data is exposed.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { LogOut, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";

export function LifecycleActions({ id, state, name, openRevokes }: { id: string; state: string; name: string; openRevokes: number }): React.JSX.Element {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ text: string; tone: "ok" | "bad" } | null>(null);
  const [effectiveDate, setEffectiveDate] = useState("");
  const [confirmOff, setConfirmOff] = useState(false);

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
      else { setMsg({ text: data.message ?? "Done.", tone: "ok" }); setConfirmOff(false); router.refresh(); }
    } catch {
      setMsg({ text: "Network error.", tone: "bad" });
    } finally {
      setBusy(null);
    }
  }

  const canOffboard = state === "HIRE" || state === "ONBOARD" || state === "READY" || state === "ACTIVE";
  const disabled = busy !== null;

  return (
    <div className="flex flex-col items-stretch gap-2 sm:items-end">
      <div className="flex flex-wrap items-center justify-end gap-2">
        {state === "HIRE" && <Button size="lg" onClick={() => run("start_onboarding")} disabled={disabled}>Start onboarding</Button>}
        {state === "ONBOARD" && <Button size="lg" onClick={() => run("advance_ready")} disabled={disabled}>Advance to Ready</Button>}
        {state === "READY" && <Button size="lg" onClick={() => run("activate")} disabled={disabled}>Activate</Button>}
        {state === "OFFBOARD" && <Button variant="outline" size="lg" onClick={() => run("complete_offboarding")} disabled={disabled}>Mark offboarded</Button>}
        {canOffboard && !confirmOff && (
          <Button variant="destructive" size="lg" onClick={() => { setConfirmOff(true); setMsg(null); }} disabled={disabled}>
            <LogOut className="size-4" aria-hidden /> Offboard
          </Button>
        )}
      </div>

      {/* Offboarding confirmation — name + effective date + honest consequence, no private data */}
      {canOffboard && confirmOff && (
        <div className="w-full max-w-sm rounded-md border border-critical/40 bg-[var(--panel)] p-3 text-left">
          <div className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-status-blocked" aria-hidden />
            <div className="min-w-0 text-[12px] text-secondary-text">
              <p>Start offboarding for <span className="font-medium text-foreground">{name}</span>? This begins the HR process and generates the access-revoke checklist.</p>
              <p className="mt-1 text-meta">Access is not removed automatically — each manual revoke stays open until a human confirms it.{openRevokes > 0 ? ` ${openRevokes} revoke${openRevokes === 1 ? "" : "s"} already open.` : ""}</p>
            </div>
          </div>
          <label className="mt-2.5 flex items-center gap-2 text-[11.5px] text-meta">
            <span className="whitespace-nowrap">Effective date (optional)</span>
            <input type="date" value={effectiveDate} onChange={(e) => setEffectiveDate(e.target.value)} aria-label="Effective termination date"
              className="h-8 flex-1 rounded-md border border-input bg-[var(--panel)] px-2 text-[12px] text-foreground focus-visible:border-ring focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50" />
          </label>
          <div className="mt-3 flex items-center justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setConfirmOff(false)} disabled={disabled}>Cancel</Button>
            <Button variant="destructive" size="sm" onClick={() => run("start_offboarding", { effectiveDate: effectiveDate || null })} disabled={disabled}>
              {busy === "start_offboarding" ? "Offboarding…" : effectiveDate ? `Offboard on ${effectiveDate}` : "Offboard now"}
            </Button>
          </div>
        </div>
      )}

      {msg && <span className={`text-[12px] ${msg.tone === "ok" ? "text-positive" : "text-critical"}`} role={msg.tone === "bad" ? "alert" : undefined}>{msg.text}</span>}
    </div>
  );
}
