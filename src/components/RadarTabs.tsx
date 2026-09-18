"use client";

// Opportunity Radar — in-page tab bar across its views (kept to one nav blade). Dashboard / Companies /
// Campaigns / Analytics / Sources.

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS: { href: string; label: string }[] = [
  { href: "/radar", label: "Dashboard" },
  { href: "/radar/outreach", label: "Outreach" },
  { href: "/radar/companies", label: "Companies" },
  { href: "/radar/campaigns", label: "Campaigns" },
  { href: "/radar/analytics", label: "Analytics" },
  { href: "/radar/sources", label: "Sources" },
  { href: "/radar/import", label: "Import" },
];

export function RadarTabs(): React.JSX.Element {
  const pathname = usePathname();
  const isActive = (href: string) => (href === "/radar" ? pathname === "/radar" : pathname.startsWith(href));
  return (
    <div className="mb-5 flex flex-wrap items-center gap-1 border-b border-border">
      {TABS.map((t) => {
        const active = isActive(t.href);
        return (
          <Link
            key={t.href}
            href={t.href}
            className={`-mb-px border-b-2 px-3 py-2 text-[13px] font-medium transition-colors ${
              active ? "border-foreground text-foreground" : "border-transparent text-meta hover:text-foreground"
            }`}
          >
            {t.label}
          </Link>
        );
      })}
    </div>
  );
}
