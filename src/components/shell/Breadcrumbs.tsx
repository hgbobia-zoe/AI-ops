"use client";

// One consistent breadcrumb pattern for the whole shell. The trail is resolved from the current path
// against the SAME nav model the sidebar renders (and against what THIS role can see), so labels always
// match the sidebar — e.g. /radar/outreach → "Opportunity Radar › Outreach". Pure resolution lives in
// @/lib/nav/config (breadcrumbTrail); this component just renders it off usePathname.

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronRight } from "lucide-react";
import { breadcrumbTrail } from "@/lib/nav/config";
import type { Role } from "@/lib/auth/roles";

export function Breadcrumbs({ role }: { role: Role }): React.JSX.Element {
  const pathname = usePathname();
  const trail = breadcrumbTrail(pathname, role);

  return (
    <nav aria-label="Breadcrumb" className="min-w-0">
      <ol className="flex min-w-0 items-center gap-1 text-[12.5px]">
        {trail.map((c, i) => {
          const last = i === trail.length - 1;
          return (
            <li key={`${c.label}-${i}`} className="flex min-w-0 items-center gap-1">
              {i > 0 && <ChevronRight className="size-3.5 shrink-0 text-meta" aria-hidden />}
              {c.href && !last ? (
                <Link href={c.href} className="truncate text-tertiary-text transition-colors hover:text-foreground">
                  {c.label}
                </Link>
              ) : (
                <span className={last ? "truncate font-medium text-foreground" : "truncate text-tertiary-text"} aria-current={last ? "page" : undefined}>
                  {c.label}
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
