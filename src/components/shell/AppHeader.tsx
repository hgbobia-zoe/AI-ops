"use client";

// The shell's desktop header: one consistent bar across every blade. Left = breadcrumbs (resolved from
// the nav model); right = a live clock, the global integration summary, and the light/dark/system
// toggle. It replaces the old 44px status-bar PILL ROW — the per-integration chips are now folded into
// the summary's disclosure panel instead of spanning the bar on every page.
//
// Shown only at lg+ (desktop); the compact mobile header lives in ConsoleNav's top bar. The clock uses
// the mounted-clock pattern (empty until mounted) to avoid an SSR hydration mismatch.

import { Suspense, useEffect, useState } from "react";
import { Breadcrumbs } from "@/components/shell/Breadcrumbs";
import { ThemeToggle } from "@/components/theme/ThemeToggle";
import type { Role } from "@/lib/auth/roles";

function Clock(): React.JSX.Element {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- mounted-clock pattern (avoids SSR hydration mismatch)
    setNow(new Date());
    const id = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(id);
  }, []);
  return (
    <span className="hidden shrink-0 whitespace-nowrap text-[12px] tabular-nums text-tertiary-text xl:inline">
      {now ? now.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" }) : ""}
      {now ? <span className="ml-2 text-meta">{now.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}</span> : ""}
    </span>
  );
}

// The per-integration connector chips now live in the always-visible StatusBar strip below this header
// (restored after #162 folded them behind a click), so the header carries breadcrumbs, the clock and the
// theme toggle only.
export function AppHeader({ role }: { role: Role }): React.JSX.Element {
  return (
    <header className="hidden h-12 shrink-0 items-center gap-3 border-b border-border bg-background px-4 lg:flex">
      <div className="min-w-0 flex-1">
        {/* Breadcrumbs reads ?tab (useSearchParams) → needs a Suspense boundary so the rest of the header
            can still be prerendered. Fallback is an empty breadcrumb slot (it fills in on hydration). */}
        <Suspense fallback={<nav aria-label="Breadcrumb" className="min-w-0" />}>
          <Breadcrumbs role={role} />
        </Suspense>
      </div>
      <Clock />
      <ThemeToggle />
    </header>
  );
}
