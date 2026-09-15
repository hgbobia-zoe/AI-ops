"use client";

// The platform's left-nav rail (Nocturne redesign). Text-only blades grouped Operations / Sales /
// Company; hierarchy is size + colour + a 3px active bar (no fill, no icons). Add a feature → add a
// blade to the right group. Active state follows the current path.

import Link from "next/link";
import { usePathname } from "next/navigation";
import { canSeeFinancials, canSeeCoaching, canManageSettings, canManageUsers, ROLE_LABEL, type Role } from "@/lib/auth/roles";

interface Blade {
  href: string;
  label: string;
  financial?: boolean; // only where role can see $
  coaching?: boolean; // only where role can see call transcripts
}

const GROUPS: { label: string; blades: Blade[] }[] = [
  {
    label: "Operations",
    blades: [
      { href: "/dashboard", label: "Command Center" },
      { href: "/ops", label: "Ops Manager" },
      { href: "/dispatch", label: "Dispatch" },
      { href: "/risk", label: "Event Risk" },
      { href: "/staffing", label: "Staffing" },
      { href: "/finance", label: "Financial", financial: true },
    ],
  },
  {
    label: "Sales",
    blades: [
      { href: "/sales", label: "Sales" },
      { href: "/salesos", label: "Sales OS" },
      { href: "/coaching", label: "Coaching", coaching: true },
      { href: "/customers", label: "Customers" },
    ],
  },
  {
    label: "Company",
    blades: [
      { href: "/history", label: "History" },
      { href: "/automation", label: "Automation" },
    ],
  },
];

export function ConsoleNav({ role, viewerName }: { role: Role; viewerName?: string }): React.JSX.Element {
  const pathname = usePathname();
  const isActive = (href: string) => pathname === href || pathname.startsWith(href + "/");
  const canSee = (b: Blade) => (!b.financial || canSeeFinancials(role)) && (!b.coaching || canSeeCoaching(role));

  const admin: Blade[] = [];
  if (canManageSettings(role)) admin.push({ href: "/admin/pull", label: "Pull Routes" });
  if (canManageSettings(role)) admin.push({ href: "/admin/health", label: "Connections" });
  if (canManageUsers(role)) admin.push({ href: "/admin/users", label: "Team" });
  if (canManageSettings(role)) admin.push({ href: "/admin", label: "Settings" });

  const logout = async () => {
    await fetch("/api/auth/login", { method: "DELETE" });
    window.location.href = "/login";
  };

  const name = viewerName?.trim() || "Zoe Operations";
  const initials = name.split(/\s+/).map((p) => p[0]).slice(0, 2).join("").toUpperCase() || "ZO";

  return (
    <aside className="flex shrink-0 flex-col border-b border-border bg-sidebar md:sticky md:top-0 md:h-dvh md:w-[212px] md:border-b-0 md:border-r">
      {/* Wordmark */}
      <div className="flex items-center gap-2.5 px-4 py-4 md:px-[18px]">
        <span className="flex size-7 items-center justify-center rounded border border-border text-[13px] font-medium text-foreground">Z</span>
        <span className="text-[13.5px] font-medium text-foreground">Zoe Operations</span>
      </div>

      {/* Blade groups */}
      <nav className="flex gap-1 overflow-x-auto px-2 pb-2 md:min-h-0 md:flex-1 md:flex-col md:gap-0 md:overflow-x-visible md:overflow-y-auto md:px-0 md:pb-2">
        {GROUPS.map((g) => {
          const items = g.blades.filter(canSee);
          if (items.length === 0) return null;
          return (
            <div key={g.label} className="contents md:mt-2 md:block">
              <div className="hidden px-[18px] pt-3 pb-1 text-[10.5px] font-medium uppercase tracking-[0.1em] text-meta md:block">{g.label}</div>
              {items.map((b) => (
                <NavItem key={b.href} blade={b} active={isActive(b.href)} />
              ))}
            </div>
          );
        })}
      </nav>

      {/* Admin links */}
      {admin.length > 0 && (
        <div className="flex gap-1 border-t border-border px-2 py-2 md:flex-col md:gap-0 md:px-0 md:py-2">
          {admin.map((b) => (
            <Link
              key={b.href}
              href={b.href}
              aria-current={isActive(b.href) ? "page" : undefined}
              className={`whitespace-nowrap border-l-[3px] px-[18px] py-[6px] text-[12.5px] transition-colors ${
                isActive(b.href) ? "border-foreground text-foreground" : "border-transparent text-meta hover:text-tertiary-text hover:bg-[var(--row-hover)]"
              }`}
            >
              {b.label}
            </Link>
          ))}
        </div>
      )}

      {/* Viewer */}
      <div className="flex items-center gap-2.5 border-t border-border px-[18px] py-3">
        <span className="flex size-7 shrink-0 items-center justify-center rounded border border-border text-[11px] font-medium text-tertiary-text">{initials}</span>
        <div className="min-w-0 flex-1 leading-tight">
          <div className="truncate text-[12.5px] font-medium text-foreground">{name}</div>
          <div className="text-[11px] text-meta">{ROLE_LABEL[role]}</div>
        </div>
        <button onClick={logout} className="text-[11.5px] font-medium uppercase tracking-[0.06em] text-meta transition-colors hover:text-foreground" title="Sign out">
          Sign out
        </button>
      </div>
    </aside>
  );
}

function NavItem({ blade, active }: { blade: Blade; active: boolean }): React.JSX.Element {
  return (
    <Link
      href={blade.href}
      aria-current={active ? "page" : undefined}
      className={`block whitespace-nowrap border-l-[3px] px-[18px] py-[7px] text-[13.5px] transition-colors ${
        active ? "border-foreground font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground hover:bg-[var(--row-hover)]"
      }`}
    >
      {blade.label}
    </Link>
  );
}
