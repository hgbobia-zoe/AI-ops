// HR / Payroll secondary navigation — a SECOND vertical menu that sits next to the global sidebar
// (Goodshuffle-style: primary nav + a contextual section menu), replacing the blade's old horizontal tab
// row. Server component: the active section + selected period come from the page, so no client hooks are
// needed. The selected pay period is preserved across sections (payrollSubHref). Desktop = a sticky vertical
// column; small screens = a horizontal scroller so it never eats vertical space.

import Link from "next/link";
import {
  Wallet, ClipboardCheck, RefreshCw, Users, Globe2, AlertTriangle, History, Settings,
  type LucideIcon,
} from "lucide-react";
import { payrollSubHref } from "@/lib/payroll/nav";

const SECTIONS: { tab: string; label: string; icon: LucideIcon }[] = [
  { tab: "overview", label: "Overview", icon: Wallet },
  { tab: "review", label: "Payroll Review", icon: ClipboardCheck },
  { tab: "sync", label: "Time Sync", icon: RefreshCw },
  { tab: "workers", label: "Workers", icon: Users },
  { tab: "contractors", label: "Contractors", icon: Globe2 },
  { tab: "exceptions", label: "Exceptions", icon: AlertTriangle },
  { tab: "history", label: "Payroll History", icon: History },
  { tab: "settings", label: "Settings", icon: Settings },
];

export function PayrollSubnav({ activeTab, weeksAgo }: { activeTab: string; weeksAgo: number }): React.JSX.Element {
  return (
    <aside className="shrink-0 border-b border-border bg-sidebar lg:w-[194px] lg:border-b-0 lg:border-r">
      <div className="lg:sticky lg:top-0 lg:max-h-dvh lg:overflow-y-auto">
        {/* Section header — desktop only (mobile shows the global top bar's page title) */}
        <div className="hidden items-center gap-2 px-4 py-4 lg:flex">
          <Wallet className="size-4 shrink-0 text-[var(--gold)]" aria-hidden />
          <span className="text-[13px] font-semibold tracking-tight text-foreground">HR / Payroll</span>
        </div>
        <nav aria-label="Payroll sections" className="flex gap-1 overflow-x-auto px-2 py-2 lg:flex-col lg:gap-0.5 lg:overflow-visible lg:py-1">
          {SECTIONS.map((s) => {
            const Icon = s.icon;
            const active = activeTab === s.tab;
            return (
              <Link
                key={s.tab}
                href={payrollSubHref("/payroll", s.tab, weeksAgo)}
                aria-current={active ? "page" : undefined}
                className={`flex shrink-0 items-center gap-2.5 whitespace-nowrap rounded px-2.5 py-[7px] text-[12.5px] transition-colors lg:shrink ${
                  active ? "bg-foreground/[0.08] font-medium text-foreground" : "text-muted-foreground hover:bg-[var(--row-hover)] hover:text-foreground"
                }`}
              >
                <Icon className={`size-[15px] shrink-0 ${active ? "text-foreground" : "text-meta"}`} aria-hidden />
                {s.label}
              </Link>
            );
          })}
        </nav>
      </div>
    </aside>
  );
}
