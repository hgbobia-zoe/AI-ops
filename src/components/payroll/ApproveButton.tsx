"use client";

// Approve payroll — records the human approval of the READY records for the period. The decision + its
// snapshot live server-side; this is the trigger + confirmation. Approving is explicit and never automated.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2 } from "lucide-react";

export function ApproveButton({ which, readyCount }: { which: "current" | "previous"; readyCount: number }): React.JSX.Element {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; tone: "ok" | "bad" } | null>(null);
  const disabled = busy || readyCount === 0;

  async function run(): Promise<void> {
    if (!confirm(`Approve payroll for ${readyCount} ready worker${readyCount === 1 ? "" : "s"}? Workers with blockers or open review items are excluded.`)) return;
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/payroll/approve", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ which }),
      });
      const data = (await res.json().catch(() => null)) as { readyCount?: number; error?: string } | null;
      if (!res.ok) {
        setMsg({ text: data?.error ?? "Approval failed.", tone: "bad" });
      } else {
        setMsg({ text: `Approved ${data?.readyCount ?? readyCount} worker(s). Gusto push is pending connection.`, tone: "ok" });
        router.refresh();
      }
    } catch {
      setMsg({ text: "Approval failed — network error.", tone: "bad" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-1.5">
      <button
        onClick={run}
        disabled={disabled}
        className="inline-flex h-9 items-center justify-center gap-2 rounded-md bg-positive px-4 text-[13px] font-medium text-[#0b1f16] transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
      >
        <CheckCircle2 className="size-4" />
        {busy ? "Approving…" : `Approve ${readyCount} ready`}
      </button>
      {msg && <span className={`text-[11.5px] ${msg.tone === "ok" ? "text-positive" : "text-critical"}`}>{msg.text}</span>}
    </div>
  );
}
