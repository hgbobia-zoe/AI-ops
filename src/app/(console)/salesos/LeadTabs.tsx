"use client";

// The lead's detail tabs, sitting directly under the conversation (Quo-style). Panels are rendered on
// the server and handed in as nodes; this only switches which one is visible (kept mounted with
// `hidden` so client panels like Outreach don't lose their state on tab change).

import { useState } from "react";
import { Sparkles, Headphones, MessageSquare, ListChecks } from "lucide-react";

type TabKey = "next" | "coaching" | "outreach" | "details";

export function LeadTabs({
  next,
  coaching,
  outreach,
  details,
  coachingCount,
}: {
  next: React.ReactNode;
  coaching: React.ReactNode;
  outreach: React.ReactNode;
  details: React.ReactNode;
  coachingCount: number;
}): React.JSX.Element {
  const [active, setActive] = useState<TabKey>("next");
  const tabs: { key: TabKey; label: string; icon: typeof Sparkles; count?: number }[] = [
    { key: "next", label: "Next step", icon: Sparkles },
    { key: "coaching", label: "Coaching", icon: Headphones, count: coachingCount || undefined },
    { key: "outreach", label: "Outreach", icon: MessageSquare },
    { key: "details", label: "Details", icon: ListChecks },
  ];

  return (
    <section className="surface overflow-hidden border border-white/5">
      <div className="flex gap-1 overflow-x-auto border-b border-white/10 px-2 pt-2">
        {tabs.map((t) => {
          const on = active === t.key;
          const Icon = t.icon;
          return (
            <button
              key={t.key}
              onClick={() => setActive(t.key)}
              className={`flex items-center gap-1.5 whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium transition-colors ${
                on ? "border-foreground text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
            >
              <Icon className="size-4" /> {t.label}
              {t.count != null && (
                <span className={`ml-0.5 rounded-full px-1.5 text-[10px] font-semibold tabular-nums ${on ? "bg-white/15" : "bg-white/[0.06]"}`}>{t.count}</span>
              )}
            </button>
          );
        })}
      </div>
      <div className="p-4 md:p-5">
        <div className={active === "next" ? "" : "hidden"}>{next}</div>
        <div className={active === "coaching" ? "" : "hidden"}>{coaching}</div>
        <div className={active === "outreach" ? "" : "hidden"}>{outreach}</div>
        <div className={active === "details" ? "" : "hidden"}>{details}</div>
      </div>
    </section>
  );
}
