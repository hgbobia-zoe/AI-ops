"use client";

// The platform's left-nav "blades". Each feature is a blade here — add a new one to
// BLADES and it appears in the rail. Active state follows the current path.

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  Radar,
  Truck,
  ShieldAlert,
  Users,
  DollarSign,
  TrendingUp,
  UserRound,
  History,
  Workflow,
  Download,
  Settings,
  UserCog,
  LogOut,
  Sparkles,
  type LucideIcon,
} from "lucide-react";
import { canSeeFinancials, canManageSettings, canManageUsers, ROLE_LABEL, type Role } from "@/lib/auth/roles";

interface Blade {
  href: string;
  label: string;
  icon: LucideIcon;
  /** Only show to roles that can see financials ($). */
  financial?: boolean;
}

// Add a feature → add a blade.
const BLADES: Blade[] = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/ops", label: "Ops Manager", icon: Radar },
  { href: "/dispatch", label: "Dispatch", icon: Truck },
  { href: "/risk", label: "Event Risk", icon: ShieldAlert },
  { href: "/staffing", label: "Staffing", icon: Users },
  { href: "/finance", label: "Financial", icon: DollarSign, financial: true },
  { href: "/sales", label: "Sales", icon: TrendingUp },
  { href: "/customers", label: "Customers", icon: UserRound },
  { href: "/history", label: "History", icon: History },
  { href: "/automation", label: "Automation", icon: Workflow },
];

export function ConsoleNav({ role }: { role: Role }) {
  const pathname = usePathname();
  const isActive = (href: string) => pathname === href || pathname.startsWith(href + "/");

  const blades = BLADES.filter((b) => !b.financial || canSeeFinancials(role));
  const bottom: Blade[] = [];
  if (canManageSettings(role)) bottom.push({ href: "/admin/pull", label: "Pull Routes", icon: Download });
  if (canManageUsers(role)) bottom.push({ href: "/admin/users", label: "Team", icon: UserCog });
  if (canManageSettings(role)) bottom.push({ href: "/admin", label: "Settings", icon: Settings });

  const logout = async () => {
    await fetch("/api/auth/login", { method: "DELETE" });
    window.location.href = "/login";
  };

  return (
    <aside className="flex shrink-0 flex-col border-b border-white/10 bg-background md:min-h-dvh md:w-60 md:border-b-0 md:border-r">
      {/* Brand */}
      <div className="flex items-center gap-2.5 px-4 py-4 md:px-5 md:py-5">
        <span className="btn-hero flex size-9 items-center justify-center rounded-xl">
          <Sparkles className="size-5" />
        </span>
        <div className="leading-tight">
          <div className="text-sm font-semibold">Zoe Ops</div>
          <div className="text-[11px] text-muted-foreground">{ROLE_LABEL[role]}</div>
        </div>
      </div>

      {/* Blades */}
      <nav className="flex gap-1 overflow-x-auto px-2 pb-2 md:flex-1 md:flex-col md:overflow-visible md:px-3">
        {blades.map((b) => (
          <BladeLink key={b.href} blade={b} active={isActive(b.href)} />
        ))}
      </nav>

      {/* Bottom */}
      <div className="flex gap-1 px-2 pb-2 md:flex-col md:px-3 md:pb-4">
        {bottom.map((b) => (
          <BladeLink key={b.href} blade={b} active={isActive(b.href)} />
        ))}
        <button
          onClick={logout}
          className="flex items-center gap-2.5 whitespace-nowrap border-l-2 border-transparent px-3 py-2.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-white/[0.04] hover:text-foreground"
        >
          <LogOut className="size-[18px] shrink-0" />
          <span>Sign out</span>
        </button>
      </div>
    </aside>
  );
}

function BladeLink({ blade, active }: { blade: Blade; active: boolean }) {
  const Icon = blade.icon;
  return (
    <Link
      href={blade.href}
      aria-current={active ? "page" : undefined}
      className={`flex items-center gap-2.5 whitespace-nowrap border-l-2 px-3 py-2.5 text-sm font-medium transition-colors ${
        active
          ? "border-foreground bg-white/[0.06] text-foreground"
          : "border-transparent text-muted-foreground hover:bg-white/[0.04] hover:text-foreground"
      }`}
    >
      <Icon className="size-[18px] shrink-0" />
      <span>{blade.label}</span>
    </Link>
  );
}
