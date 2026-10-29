// People Lifecycle secondary navigation — a SECOND vertical menu beside the global sidebar (the same
// pattern the HR / Payroll blade uses), replacing the blade's old horizontal tab row. Server component:
// the active section comes from the page, so no client hooks are needed. Deep links are preserved —
// each section is the existing `?tab=` destination. Desktop = a sticky vertical column; small screens =
// a horizontal scroller so it never eats vertical space.

import Link from "next/link";
import { Contact, UserPlus, LogOut, ShieldCheck, History, type LucideIcon } from "lucide-react";

export type PeopleTab = "onboarding" | "offboarding" | "policies" | "activity";

const SECTIONS: { tab: PeopleTab; label: string; icon: LucideIcon }[] = [
  { tab: "onboarding", label: "Onboarding", icon: UserPlus },
  { tab: "offboarding", label: "Offboarding", icon: LogOut },
  { tab: "policies", label: "Access Policies", icon: ShieldCheck },
  { tab: "activity", label: "Activity", icon: History },
];

export function PeopleSubnav({ activeTab }: { activeTab: PeopleTab }): React.JSX.Element {
  return (
    <aside className="shrink-0 border-b border-border bg-sidebar lg:w-[194px] lg:border-b-0 lg:border-r">
      <div className="lg:sticky lg:top-0 lg:max-h-dvh lg:overflow-y-auto">
        {/* Section header — desktop only (mobile shows the global top bar's page title) */}
        <div className="hidden items-center gap-2 px-4 py-4 lg:flex">
          <Contact className="size-4 shrink-0 text-[var(--gold)]" aria-hidden />
          <span className="text-[13px] font-semibold tracking-tight text-foreground">People Lifecycle</span>
        </div>
        <nav aria-label="People Lifecycle sections" className="flex gap-1 overflow-x-auto px-2 py-2 lg:flex-col lg:gap-0.5 lg:overflow-visible lg:py-1">
          {SECTIONS.map((s) => {
            const Icon = s.icon;
            const active = activeTab === s.tab;
            return (
              <Link
                key={s.tab}
                href={`/people?tab=${s.tab}`}
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
