"use client";

// The platform's navigation (Nocturne redesign, Goodshuffle-familiar). Two presentations from one source:
//   • Desktop (lg+): a persistent left sidebar.
//   • Mobile / tablet (< lg): a compact top bar with a hamburger that opens a slide-out drawer.
// Blades live under expandable section parents (Operations / Sales / Company / Admin) — each with an icon
// and a chevron, like Goodshuffle's sub-menus. Every blade carries an icon; the active blade is a solid
// filled row. "New Project" is the primary action, pinned at the bottom above the viewer.

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import {
  Menu, X, ChevronRight,
  LayoutGrid, Tag, Building2, Wrench,
  Gauge, ListChecks, Truck, AlertTriangle, Users, DollarSign,
  TrendingUp, Target, GraduationCap, Contact, Clock, Zap,
  RefreshCw, Plug, UsersRound, Settings, KeyRound, Calculator, Radar,
  type LucideIcon,
} from "lucide-react";
import { canSeeFinancials, canSeeCoaching, canManageSettings, canManageUsers, ROLE_LABEL, type Role } from "@/lib/auth/roles";

interface Blade {
  href: string;
  label: string;
  icon: LucideIcon;
  financial?: boolean; // only where role can see $
  coaching?: boolean; // only where role can see call transcripts
}
interface Group {
  label: string;
  icon: LucideIcon;
  blades: Blade[];
}

// Command Center is the main hub / 10k-ft view, so it sits on its own at the top of the nav, outside
// (and above) the expandable sections — not nested inside Operations.
const HUB: Blade = { href: "/dashboard", label: "Command Center", icon: Gauge };

// Opportunity Radar — the opportunity intelligence engine (events + procurement + facility/web signals
// feeding one layer). A first-class module in its own right (it detects future demand; Sales OS
// converts it), so it sits standalone at the top alongside Command Center.
const RADAR: Blade = { href: "/radar", label: "Opportunity Radar", icon: Radar };

const GROUPS: Group[] = [
  {
    label: "Operations",
    icon: LayoutGrid,
    blades: [
      { href: "/ops", label: "Ops Manager", icon: ListChecks },
      { href: "/dispatch", label: "Dispatch", icon: Truck },
      { href: "/risk", label: "Event Risk", icon: AlertTriangle },
      { href: "/staffing", label: "Staffing", icon: Users },
      { href: "/finance", label: "Financial", icon: DollarSign, financial: true },
    ],
  },
  {
    label: "Sales",
    icon: Tag,
    blades: [
      { href: "/sales", label: "Sales", icon: TrendingUp },
      { href: "/salesos", label: "Sales OS", icon: Target },
      { href: "/coaching", label: "Coaching", icon: GraduationCap, coaching: true },
      { href: "/customers", label: "Customers", icon: Contact },
      { href: "/pricing", label: "Delivery Pricing", icon: Calculator },
    ],
  },
  {
    label: "Company",
    icon: Building2,
    blades: [
      { href: "/history", label: "History", icon: Clock },
      { href: "/automation", label: "Automation", icon: Zap },
    ],
  },
];

export function ConsoleNav({ role, viewerName }: { role: Role; viewerName?: string }): React.JSX.Element {
  const pathname = usePathname();
  const [open, setOpen] = useState(false); // drawer (mobile)
  const close = () => setOpen(false); // drawer closes on any nav tap

  const isActive = (href: string) => pathname === href || pathname.startsWith(href + "/");
  const canSee = (b: Blade) => (!b.financial || canSeeFinancials(role)) && (!b.coaching || canSeeCoaching(role));

  // Admin is another expandable parent, built from what the role can manage.
  const adminBlades: Blade[] = [];
  if (canManageSettings(role)) adminBlades.push({ href: "/admin/pull", label: "Pull Routes", icon: RefreshCw });
  if (canManageSettings(role)) adminBlades.push({ href: "/admin/health", label: "Connections", icon: Plug });
  if (canManageUsers(role)) adminBlades.push({ href: "/admin/users", label: "Team", icon: UsersRound });
  if (canManageSettings(role)) adminBlades.push({ href: "/admin/passes", label: "Shift Passes", icon: KeyRound });
  if (canManageSettings(role)) adminBlades.push({ href: "/admin", label: "Settings", icon: Settings });

  const parents: Group[] = [
    ...GROUPS.map((g) => ({ ...g, blades: g.blades.filter(canSee) })).filter((g) => g.blades.length > 0),
    ...(adminBlades.length ? [{ label: "Admin", icon: Wrench, blades: adminBlades }] : []),
  ];

  // The section holding the current page starts expanded; the user can toggle any parent from there.
  const activeGroup = parents.find((g) => g.blades.some((b) => isActive(b.href)))?.label;
  const [openGroups, setOpenGroups] = useState<Set<string>>(() => new Set(activeGroup ? [activeGroup] : []));
  const toggleGroup = (label: string) =>
    setOpenGroups((prev) => {
      const n = new Set(prev);
      if (n.has(label)) n.delete(label);
      else n.add(label);
      return n;
    });

  const logout = async () => {
    await fetch("/api/auth/login", { method: "DELETE" });
    window.location.href = "/login";
  };

  const name = viewerName?.trim() || "Zoe Operations";
  const initials = name.split(/\s+/).map((p) => p[0]).slice(0, 2).join("").toUpperCase() || "ZO";

  // The label of the current screen, for the mobile top bar (mirrors Goodshuffle showing the page title).
  const isNewProject = pathname === "/intake" || pathname.startsWith("/intake/");
  const activeLabel = isNewProject
    ? "New Project"
    : isActive(HUB.href)
      ? HUB.label
      : isActive(RADAR.href)
        ? RADAR.label
        : parents.flatMap((g) => g.blades).find((b) => isActive(b.href))?.label ?? "Zoe Operations";

  const HubIcon = HUB.icon;
  const RadarIcon = RADAR.icon;

  // The nav body — shared by the desktop sidebar and the mobile drawer. `withClose` adds the drawer's ✕.
  const panel = (withClose: boolean): React.JSX.Element => (
    <>
      {/* Wordmark */}
      <div className="flex items-center gap-2.5 px-4 py-4 lg:px-[18px]">
        <span className="flex size-7 items-center justify-center rounded border border-border text-[13px] font-medium text-foreground">Z</span>
        <span className="text-[13.5px] font-medium text-foreground">Zoe Operations</span>
        {withClose && (
          <button onClick={close} aria-label="Close navigation" className="ml-auto flex size-8 items-center justify-center rounded border border-border text-tertiary-text transition-colors hover:bg-[var(--row-hover)] hover:text-foreground">
            <X className="size-4" />
          </button>
        )}
      </div>

      {/* Command Center — the hub / 10k-ft view, pinned at the top above the sections */}
      <nav className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-2 py-1">
        <Link
          href={HUB.href}
          onClick={close}
          aria-current={isActive(HUB.href) ? "page" : undefined}
          className={`flex items-center gap-2.5 rounded px-2.5 py-2 text-[13px] font-medium transition-colors ${
            isActive(HUB.href) ? "bg-foreground/[0.08] text-foreground" : "text-tertiary-text hover:bg-[var(--row-hover)] hover:text-foreground"
          }`}
        >
          <HubIcon className={`size-[17px] shrink-0 ${isActive(HUB.href) ? "text-foreground" : "text-meta"}`} />
          {HUB.label}
        </Link>

        {/* Event Radar — standalone first-class module, pinned at the top beside Command Center */}
        <Link
          href={RADAR.href}
          onClick={close}
          aria-current={isActive(RADAR.href) ? "page" : undefined}
          className={`flex items-center gap-2.5 rounded px-2.5 py-2 text-[13px] font-medium transition-colors ${
            isActive(RADAR.href) ? "bg-foreground/[0.08] text-foreground" : "text-tertiary-text hover:bg-[var(--row-hover)] hover:text-foreground"
          }`}
        >
          <RadarIcon className={`size-[17px] shrink-0 ${isActive(RADAR.href) ? "text-foreground" : "text-meta"}`} />
          {RADAR.label}
        </Link>

        {/* Expandable section parents → sub-blades */}
        {parents.map((g) => {
          const isOpen = openGroups.has(g.label);
          const GIcon = g.icon;
          const hasActive = g.blades.some((b) => isActive(b.href));
          return (
            <div key={g.label}>
              <button
                onClick={() => toggleGroup(g.label)}
                aria-expanded={isOpen}
                className={`flex w-full items-center gap-2.5 rounded px-2.5 py-2 text-[13px] font-medium transition-colors hover:bg-[var(--row-hover)] ${hasActive ? "text-foreground" : "text-tertiary-text hover:text-foreground"}`}
              >
                <GIcon className="size-[17px] shrink-0 text-meta" />
                <span className="flex-1 text-left">{g.label}</span>
                <ChevronRight className={`size-4 shrink-0 text-meta transition-transform ${isOpen ? "rotate-90" : ""}`} />
              </button>
              {isOpen && (
                <div className="mt-0.5 mb-1 flex flex-col gap-0.5">
                  {g.blades.map((b) => {
                    const BIcon = b.icon;
                    const active = isActive(b.href);
                    return (
                      <Link
                        key={b.href}
                        href={b.href}
                        onClick={close}
                        aria-current={active ? "page" : undefined}
                        className={`flex items-center gap-2.5 rounded py-[7px] pl-[34px] pr-2.5 text-[13px] transition-colors ${
                          active ? "bg-foreground/[0.08] font-medium text-foreground" : "text-muted-foreground hover:bg-[var(--row-hover)] hover:text-foreground"
                        }`}
                      >
                        <BIcon className={`size-[15px] shrink-0 ${active ? "text-foreground" : "text-meta"}`} />
                        {b.label}
                      </Link>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </nav>

      {/* Primary action — start a new customer project (the guided intake). Sits at the bottom, just
          above the viewer, mirroring Goodshuffle's "Create New Project" placement. */}
      <div className="border-t border-border px-2 py-2 lg:px-3">
        <Link
          href="/intake"
          onClick={close}
          aria-current={isActive("/intake") ? "page" : undefined}
          className={`flex items-center justify-center gap-2 whitespace-nowrap rounded border px-3 py-2 text-[13.5px] font-medium transition-colors ${
            isActive("/intake") ? "border-foreground bg-foreground/[0.07] text-foreground" : "border-border text-foreground hover:bg-[var(--row-hover)]"
          }`}
        >
          <span aria-hidden className="text-[15px] leading-none text-tertiary-text">+</span> New Project
        </Link>
      </div>

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
    </>
  );

  return (
    <>
      {/* Mobile / tablet: compact top bar with a hamburger (Goodshuffle-style) */}
      <div className="flex items-center gap-3 border-b border-border bg-sidebar px-3 py-2.5 lg:hidden">
        <button onClick={() => setOpen(true)} aria-label="Open navigation" aria-expanded={open} className="flex size-9 items-center justify-center rounded border border-border text-foreground transition-colors hover:bg-[var(--row-hover)]">
          <Menu className="size-5" />
        </button>
        <span className="truncate text-[15px] font-medium text-foreground">{activeLabel}</span>
      </div>

      {/* Drawer backdrop */}
      <div
        aria-hidden
        onClick={close}
        className={`fixed inset-0 z-40 bg-black/60 transition-opacity duration-200 lg:hidden ${open ? "opacity-100" : "pointer-events-none opacity-0"}`}
      />

      {/* Drawer */}
      <aside
        className={`fixed inset-y-0 left-0 z-50 flex w-[264px] max-w-[82vw] flex-col overflow-y-auto border-r border-border bg-sidebar transition-transform duration-200 lg:hidden ${
          open ? "translate-x-0" : "-translate-x-full"
        }`}
        aria-hidden={!open}
      >
        {panel(true)}
      </aside>

      {/* Desktop: persistent left sidebar */}
      <aside className="hidden shrink-0 lg:sticky lg:top-0 lg:flex lg:h-dvh lg:w-[212px] lg:flex-col lg:border-r lg:border-border lg:bg-sidebar">
        {panel(false)}
      </aside>
    </>
  );
}
