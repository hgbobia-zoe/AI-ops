"use client";

// The platform's navigation (Nocturne redesign). Two presentations from one source of truth:
//   • Desktop (lg+): a persistent left sidebar of text-only blades.
//   • Mobile / tablet (< lg): a compact top bar with a hamburger that opens a slide-out drawer — the
//     familiar Goodshuffle Pro pattern, so the whole nav doesn't eat the top of a phone screen.
// Blades are grouped Operations / Sales / Company; hierarchy is size + colour + a 3px active bar (no
// fill, no icons). Add a feature → add a blade to the right group. "New Project" is the primary action.

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { Menu, X } from "lucide-react";
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
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false); // drawer closes on any nav tap (see the links below)

  // Lock background scroll while the drawer is open.
  useEffect(() => {
    if (typeof document === "undefined") return;
    document.body.style.overflow = open ? "hidden" : "";
    return () => { document.body.style.overflow = ""; };
  }, [open]);

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

  // The label of the current screen, for the mobile top bar (mirrors Goodshuffle showing the page title).
  const isNewProject = pathname === "/intake" || pathname.startsWith("/intake/");
  const activeLabel = isNewProject
    ? "New Project"
    : [...GROUPS.flatMap((g) => g.blades), ...admin].find((b) => isActive(b.href))?.label ?? "Zoe Operations";

  // The nav body — shared by the desktop sidebar and the mobile drawer. `withClose` adds the drawer's ✕.
  const panel = (withClose: boolean): React.JSX.Element => (
    <>
      {/* Wordmark */}
      <div className="flex items-center gap-2.5 px-4 py-4 lg:px-[18px]">
        <span className="flex size-7 items-center justify-center rounded border border-border text-[13px] font-medium text-foreground">Z</span>
        <span className="text-[13.5px] font-medium text-foreground">Zoe Operations</span>
        {withClose && (
          <button onClick={() => setOpen(false)} aria-label="Close navigation" className="ml-auto flex size-8 items-center justify-center rounded border border-border text-tertiary-text transition-colors hover:bg-[var(--row-hover)] hover:text-foreground">
            <X className="size-4" />
          </button>
        )}
      </div>

      {/* Primary action — start a new customer project (the guided intake). Mirrors Goodshuffle's
          "Create New Project" as the way a salesperson begins, in Zoe's own nav style. */}
      <div className="px-2 pb-1 lg:px-3 lg:pb-2">
        <Link
          href="/intake"
          onClick={close}
          aria-current={isActive("/intake") ? "page" : undefined}
          className={`flex items-center gap-2 whitespace-nowrap rounded border px-3 py-2 text-[13.5px] font-medium transition-colors ${
            isActive("/intake") ? "border-foreground bg-foreground/[0.07] text-foreground" : "border-border text-foreground hover:bg-[var(--row-hover)]"
          }`}
        >
          <span aria-hidden className="text-[15px] leading-none text-tertiary-text">+</span> New Project
        </Link>
      </div>

      {/* Blade groups */}
      <nav className="flex min-h-0 flex-1 flex-col overflow-y-auto pb-2">
        {GROUPS.map((g) => {
          const items = g.blades.filter(canSee);
          if (items.length === 0) return null;
          return (
            <div key={g.label} className="mt-2">
              <div className="px-[18px] pt-3 pb-1 text-[10.5px] font-medium uppercase tracking-[0.1em] text-meta">{g.label}</div>
              {items.map((b) => (
                <NavItem key={b.href} blade={b} active={isActive(b.href)} onNavigate={close} />
              ))}
            </div>
          );
        })}
      </nav>

      {/* Admin links */}
      {admin.length > 0 && (
        <div className="flex flex-col border-t border-border py-2">
          {admin.map((b) => (
            <Link
              key={b.href}
              href={b.href}
              onClick={close}
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
        <Link
          href="/intake"
          aria-label="New Project"
          className="ml-auto flex items-center gap-1.5 rounded border border-border px-3 py-1.5 text-[12.5px] font-medium text-foreground transition-colors hover:bg-[var(--row-hover)]"
        >
          <span aria-hidden className="text-[15px] leading-none text-tertiary-text">+</span> New
        </Link>
      </div>

      {/* Drawer backdrop */}
      <div
        aria-hidden
        onClick={() => setOpen(false)}
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

function NavItem({ blade, active, onNavigate }: { blade: Blade; active: boolean; onNavigate?: () => void }): React.JSX.Element {
  return (
    <Link
      href={blade.href}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      className={`block whitespace-nowrap border-l-[3px] px-[18px] py-[7px] text-[13.5px] transition-colors ${
        active ? "border-foreground font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground hover:bg-[var(--row-hover)]"
      }`}
    >
      {blade.label}
    </Link>
  );
}
