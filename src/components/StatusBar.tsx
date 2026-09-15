"use client";

// Console status bar (Nocturne): 44px strip under the header row — live date/time on the left,
// integration freshness in the middle (6px dot + name + state), live counts on the right. Integration
// state is computed server-side and passed in; the clock ticks client-side.

import { useEffect, useState } from "react";

export interface StatusIntegration {
  name: string;
  tone: "ok" | "warn" | "down" | "idle";
  note?: string; // freshness / consequence, e.g. "stale · 2h ago" or "unavailable since 1:48 PM"
}
export interface StatusCount {
  label: string;
  value: string | number;
  tone?: "ok" | "warn" | "down";
}

const DOT: Record<string, string> = { ok: "bg-positive", warn: "bg-attention", down: "bg-critical", idle: "bg-[var(--bar)]" };
const TEXT: Record<string, string> = { ok: "text-meta", warn: "text-attention", down: "text-critical", idle: "text-meta" };

export function StatusBar({ integrations, counts }: { integrations: StatusIntegration[]; counts?: StatusCount[] }): React.JSX.Element {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    setNow(new Date());
    const id = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="flex h-11 shrink-0 items-center gap-5 border-b border-border bg-background px-6 text-[12px]">
      <span className="shrink-0 text-foreground tabular-nums">
        {now ? now.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" }) : ""}
        {now ? <span className="ml-2 text-meta">{now.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}</span> : ""}
      </span>

      <div className="flex min-w-0 flex-1 items-center gap-4 overflow-x-auto">
        {integrations.map((i) => (
          <span key={i.name} className="flex shrink-0 items-center gap-1.5">
            <span className={`size-1.5 rounded-full ${DOT[i.tone]}`} />
            <span className="text-tertiary-text">{i.name}</span>
            {i.note && <span className={TEXT[i.tone]}>· {i.note}</span>}
          </span>
        ))}
      </div>

      {counts && counts.length > 0 && (
        <div className="flex shrink-0 items-center gap-4">
          {counts.map((c) => (
            <span key={c.label} className="flex items-center gap-1.5">
              <span className="text-[10.5px] uppercase tracking-[0.1em] text-meta">{c.label}</span>
              <span className={`tabular-nums ${c.tone === "warn" ? "text-attention" : c.tone === "down" ? "text-critical" : "text-foreground"}`}>{c.value}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
