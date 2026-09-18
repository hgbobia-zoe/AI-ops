"use client";

// The only chrome a Shift Pass holder sees: who they are and when access ends. The countdown is live,
// and when it reaches zero it sends them straight to the ended page (so a tab left open past the shift
// doesn't bounce through a login screen). Revocation is caught server-side on the next board refresh.

import { useEffect, useState } from "react";
import { Clock, ShieldCheck } from "lucide-react";

function fmtLeft(ms: number): string {
  if (ms <= 0) return "ending…";
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins}m left`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h < 24) return m ? `${h}h ${m}m left` : `${h}h left`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h left`;
}

export function GuestShellBar({ name, expiresAt }: { name: string; expiresAt: string }): React.JSX.Element {
  const end = Date.parse(expiresAt);
  const [now, setNow] = useState<number>(() => Date.now());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (now >= end) window.location.href = "/pass-expired";
  }, [now, end]);

  const left = end - now;
  const soon = left <= 30 * 60_000; // within 30 min

  return (
    <div className="flex items-center justify-between gap-3 border-b border-white/10 bg-white/[0.03] px-4 py-2 text-sm">
      <div className="flex min-w-0 items-center gap-2">
        <ShieldCheck className="size-4 shrink-0 text-muted-foreground" />
        <span className="truncate font-medium">{name}</span>
        <span className="hidden text-xs text-muted-foreground sm:inline">Shift Pass</span>
      </div>
      <div className={`flex shrink-0 items-center gap-1.5 tabular-nums ${soon ? "text-amber-400" : "text-muted-foreground"}`}>
        <Clock className="size-3.5" />
        {fmtLeft(left)}
      </div>
    </div>
  );
}
