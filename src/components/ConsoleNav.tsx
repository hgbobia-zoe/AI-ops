"use client";

// The platform's primary navigation (Nocturne redesign). Two presentations from ONE source of truth
// (@/lib/nav/config):
//   • Desktop (lg+): a persistent left sidebar, ~248px expanded, with a COLLAPSED icon-rail mode
//     (toggle persisted) that keeps every destination reachable.
//   • Mobile / tablet (< lg): a compact top bar (hamburger + page title + integration summary + theme
//     toggle) that opens a focus-trapped slide-out drawer.
//
// Blades live under expandable "big blade" groups. The group holding the current page auto-expands
// (active ancestor), while the viewer's manual expand/collapse of any group is remembered and never
// forces unrelated groups open. The active destination is a strong, filled row with a left accent and
// aria-current; group toggles carry aria-expanded. Full keyboard access throughout.

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { Menu, X, ChevronRight, Tent, Plus, PanelLeftClose, PanelLeftOpen, LogOut } from "lucide-react";
import { ROLE_LABEL, type Role } from "@/lib/auth/roles";
import {
  PRIMARY_ACTION, PAYROLL_HREF, visibleGroups, visibleHubs, showsPrimaryAction,
  isHrefActive, isBladeActive, groupIsActive, activeGroupLabel, activeBlade,
  type Blade, type SubBlade,
} from "@/lib/nav/config";
import { payrollSubHref, payrollSubActive, clampWeeksAgo } from "@/lib/payroll/nav";
import { IntegrationSummary } from "@/components/shell/IntegrationSummary";
import { ThemeToggle } from "@/components/theme/ThemeToggle";
import type { Connection } from "@/lib/health/connections";

const GROUPS_KEY = "zoe-nav-groups";
const COLLAPSED_KEY = "zoe-nav-collapsed";

const groupId = (label: string) => "nav-group-" + label.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
const subId = (href: string) => "nav-sub-" + href.replace(/[^a-z0-9]+/gi, "-").toLowerCase();

// The nested sub-section links for a blade with `children` (HR/Payroll). Third sidebar level: indented one
// step past a blade, the ACTIVE destination carries the fill + accent (the parent blade row stays merely
// identifiable). Pure/presentational so it can also serve as the Suspense fallback below.
function PayrollLinks({
  items, pathname, activeTab, weeksAgo, onNavigate,
}: {
  items: SubBlade[]; pathname: string; activeTab: string | null; weeksAgo: number; onNavigate: () => void;
}): React.JSX.Element {
  return (
    <>
      {items.map((c) => {
        const Icon = c.icon;
        const active = payrollSubActive(pathname, activeTab, PAYROLL_HREF, c.tab);
        return (
          <Link
            key={c.tab}
            href={payrollSubHref(PAYROLL_HREF, c.tab, weeksAgo)}
            onClick={onNavigate}
            aria-current={active ? "page" : undefined}
            className={`flex items-center gap-2.5 rounded border-l-2 py-[6px] pr-2.5 pl-[44px] text-[12.5px] transition-colors ${
              active
                ? "border-l-[var(--primary)] bg-foreground/[0.08] font-medium text-foreground"
                : "border-l-transparent text-muted-foreground hover:bg-[var(--row-hover)] hover:text-foreground"
            }`}
          >
            <Icon className={`size-[14px] shrink-0 ${active ? "text-foreground" : "text-meta"}`} aria-hidden />
            {c.label}
          </Link>
        );
      })}
    </>
  );
}

// Reads the live ?tab + ?weeksAgo so the active section highlights and the links carry the selected pay
// period. useSearchParams requires a Suspense boundary (supplied where this is rendered).
function PayrollLinksLive({ items, pathname, onNavigate }: { items: SubBlade[]; pathname: string; onNavigate: () => void }): React.JSX.Element {
  const sp = useSearchParams();
  return <PayrollLinks items={items} pathname={pathname} activeTab={sp.get("tab")} weeksAgo={clampWeeksAgo(sp.get("weeksAgo"))} onNavigate={onNavigate} />;
}

export function ConsoleNav({
  role,
  viewerName,
  connections = [],
}: {
  role: Role;
  viewerName?: string;
  connections?: Connection[];
}): React.JSX.Element {
  const pathname = usePathname();

  const hubs = visibleHubs(role);
  const groups = visibleGroups(role);
  const showPrimary = showsPrimaryAction(role);
  const activeGroup = activeGroupLabel(groups, pathname);

  // Drawer (mobile) + its focus management.
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeBtnRef = useRef<HTMLButtonElement>(null);
  const drawerRef = useRef<HTMLElement>(null);
  const closeDrawer = useCallback(() => {
    setOpen(false);
    triggerRef.current?.focus(); // return focus to the trigger
  }, []);
  // Move focus into the drawer when it opens.
  useEffect(() => {
    if (open) closeBtnRef.current?.focus();
  }, [open]);
  // Trap Tab within the open drawer; Escape closes it.
  const onDrawerKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      closeDrawer();
      return;
    }
    if (e.key !== "Tab" || !drawerRef.current) return;
    const nodes = drawerRef.current.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])',
    );
    if (nodes.length === 0) return;
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  // Desktop collapsed rail — preference persisted (minor expand→collapse settle on first paint only).
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    try {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time restore of the persisted rail preference
      if (localStorage.getItem(COLLAPSED_KEY) === "1") setCollapsed(true);
    } catch {
      /* storage blocked (private mode) — default expanded */
    }
  }, []);
  const toggleCollapsed = () =>
    setCollapsed((v) => {
      const nv = !v;
      try {
        localStorage.setItem(COLLAPSED_KEY, nv ? "1" : "0");
      } catch {
        /* ignore */
      }
      return nv;
    });

  // Expanded groups. Seeded deterministically from the active ancestor (matches SSR), then merged with
  // the viewer's saved manual preferences after mount.
  const [openGroups, setOpenGroups] = useState<Set<string>>(() => new Set(activeGroup ? [activeGroup] : []));
  useEffect(() => {
    try {
      const raw = localStorage.getItem(GROUPS_KEY);
      if (!raw) return;
      const arr = JSON.parse(raw) as unknown;
      if (Array.isArray(arr)) {
        const saved = arr.filter((x): x is string => typeof x === "string");
        // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time merge of saved expand/collapse prefs
        setOpenGroups((prev) => new Set([...prev, ...saved]));
      }
    } catch {
      /* ignore malformed storage */
    }
  }, []);
  // Auto-expand the active ancestor whenever navigation changes which group owns the page.
  useEffect(() => {
    if (!activeGroup) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- auto-expand the active ancestor on navigation
    setOpenGroups((prev) => (prev.has(activeGroup) ? prev : new Set(prev).add(activeGroup)));
  }, [activeGroup]);
  const toggleGroup = useCallback((label: string) => {
    setOpenGroups((prev) => {
      const n = new Set(prev);
      if (n.has(label)) n.delete(label);
      else n.add(label);
      try {
        localStorage.setItem(GROUPS_KEY, JSON.stringify([...n]));
      } catch {
        /* ignore */
      }
      return n;
    });
  }, []);

  // Nested sub-groups (a blade with children, e.g. HR/Payroll). The sub-group owning the current page
  // auto-expands — alongside its parent group — so landing on any payroll section opens People › Payroll.
  // The viewer can still collapse it; state is session-only (the auto-open keeps it correct on navigation).
  const activeSubHref = groups.flatMap((g) => g.blades).find((b) => b.children?.length && isHrefActive(b.href, pathname))?.href;
  const [openSubs, setOpenSubs] = useState<Set<string>>(() => new Set(activeSubHref ? [activeSubHref] : []));
  useEffect(() => {
    if (!activeSubHref) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- auto-expand the active nested sub-group on navigation
    setOpenSubs((prev) => (prev.has(activeSubHref) ? prev : new Set(prev).add(activeSubHref)));
  }, [activeSubHref]);
  const toggleSub = useCallback((href: string) => {
    setOpenSubs((prev) => {
      const n = new Set(prev);
      if (n.has(href)) n.delete(href);
      else n.add(href);
      return n;
    });
  }, []);

  const logout = async () => {
    await fetch("/api/auth/login", { method: "DELETE" });
    window.location.href = "/login";
  };

  const name = viewerName?.trim() || "Zoe Operations";
  const initials = name.split(/\s+/).map((p) => p[0]).slice(0, 2).join("").toUpperCase() || "ZO";

  // Title for the compact mobile top bar (mirrors the current screen).
  const isNewProject = isHrefActive(PRIMARY_ACTION.href, pathname);
  const activeLabel =
    isNewProject
      ? PRIMARY_ACTION.label
      : hubs.find((h) => isHrefActive(h.href, pathname))?.label ?? activeBlade(groups, pathname)?.label ?? "Zoe Operations";

  // ── A single hub/blade row (shared by drawer + expanded desktop) ──
  const hubRow = (hub: Blade) => {
    const active = isHrefActive(hub.href, pathname);
    const Icon = hub.icon;
    return (
      <Link
        key={hub.href}
        href={hub.href}
        onClick={() => setOpen(false)}
        aria-current={active ? "page" : undefined}
        className={`flex items-center gap-2.5 rounded border-l-2 px-2.5 py-2 text-[13px] font-medium transition-colors ${
          active
            ? "border-l-[var(--primary)] bg-foreground/[0.08] text-foreground"
            : "border-l-transparent text-tertiary-text hover:bg-[var(--row-hover)] hover:text-foreground"
        }`}
      >
        <Icon className={`size-[17px] shrink-0 ${active ? "text-foreground" : "text-meta"}`} aria-hidden />
        <span className="flex-1">{hub.label}</span>
        {hub.badge && (
          <span className="rounded border border-[var(--info)]/40 px-1 py-0.5 text-[8.5px] font-semibold uppercase tracking-[0.08em] text-[var(--info)]">New</span>
        )}
      </Link>
    );
  };

  // The expanded nav body — shared by the desktop sidebar (expanded) and the mobile drawer.
  const expandedPanel = (variant: "drawer" | "desktop"): React.JSX.Element => (
    <>
      {/* Wordmark + a trailing control (drawer: close ✕ · desktop: collapse) */}
      <div className="flex items-center gap-2.5 px-4 py-4 lg:px-[18px]">
        <Tent className="size-5 shrink-0 text-[var(--gold)]" aria-hidden />
        <span className="text-[14px] tracking-[0.04em]">
          <span className="font-semibold text-[var(--gold)]">ZOE</span> <span className="text-foreground">OPERATIONS</span>
        </span>
        {variant === "drawer" ? (
          <button
            ref={closeBtnRef}
            onClick={closeDrawer}
            aria-label="Close navigation"
            className="ml-auto flex size-8 items-center justify-center rounded border border-border text-tertiary-text transition-colors hover:bg-[var(--row-hover)] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <X className="size-4" aria-hidden />
          </button>
        ) : (
          <button
            onClick={toggleCollapsed}
            aria-label="Collapse navigation"
            aria-expanded
            className="ml-auto hidden size-8 items-center justify-center rounded border border-border text-tertiary-text transition-colors hover:bg-[var(--row-hover)] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring lg:flex"
          >
            <PanelLeftClose className="size-4" aria-hidden />
          </button>
        )}
      </div>

      <nav aria-label="Primary" className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-2 py-1">
        {hubs.map(hubRow)}

        {groups.map((g) => {
          const isOpen = openGroups.has(g.label);
          const GIcon = g.icon;
          const hasActive = groupIsActive(g, pathname);
          return (
            <div key={g.label}>
              <button
                onClick={() => toggleGroup(g.label)}
                aria-expanded={isOpen}
                aria-controls={groupId(g.label)}
                className={`flex w-full items-center gap-2.5 rounded px-2.5 py-2 text-[13px] font-medium transition-colors hover:bg-[var(--row-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                  hasActive ? "text-foreground" : "text-tertiary-text hover:text-foreground"
                }`}
              >
                <GIcon className="size-[17px] shrink-0 text-meta" aria-hidden />
                <span className="flex-1 text-left">{g.label}</span>
                <ChevronRight className={`size-4 shrink-0 text-meta transition-transform ${isOpen ? "rotate-90" : ""}`} aria-hidden />
              </button>
              <div id={groupId(g.label)} hidden={!isOpen} className="mt-0.5 mb-1 flex flex-col gap-0.5">
                {g.blades.map((b) => {
                  const BIcon = b.icon;
                  // A blade with nested sub-sections (HR/Payroll) → a third-level disclosure in the same
                  // sidebar. The parent row stays identifiable (foreground text, no fill); the active child
                  // below it carries the fill + accent, so only the true destination reads as selected.
                  if (b.children?.length) {
                    const subOpen = openSubs.has(b.href);
                    const onSub = isHrefActive(b.href, pathname);
                    return (
                      <div key={b.href}>
                        <button
                          onClick={() => toggleSub(b.href)}
                          aria-expanded={subOpen}
                          aria-controls={subId(b.href)}
                          className={`flex w-full items-center gap-2.5 rounded py-[7px] pr-2.5 pl-[32px] text-[13px] font-medium transition-colors hover:bg-[var(--row-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                            onSub ? "text-foreground" : "text-muted-foreground hover:text-foreground"
                          }`}
                        >
                          <BIcon className={`size-[15px] shrink-0 ${onSub ? "text-foreground" : "text-meta"}`} aria-hidden />
                          <span className="flex-1 text-left">{b.label}</span>
                          <ChevronRight className={`size-3.5 shrink-0 text-meta transition-transform ${subOpen ? "rotate-90" : ""}`} aria-hidden />
                        </button>
                        <div id={subId(b.href)} hidden={!subOpen} className="mt-0.5 flex flex-col gap-0.5">
                          <Suspense fallback={<PayrollLinks items={b.children} pathname={pathname} activeTab={null} weeksAgo={1} onNavigate={() => setOpen(false)} />}>
                            <PayrollLinksLive items={b.children} pathname={pathname} onNavigate={() => setOpen(false)} />
                          </Suspense>
                        </div>
                      </div>
                    );
                  }
                  const active = isBladeActive(b, pathname);
                  return (
                    <Link
                      key={b.href}
                      href={b.href}
                      onClick={() => setOpen(false)}
                      aria-current={active ? "page" : undefined}
                      className={`flex items-center gap-2.5 rounded border-l-2 py-[7px] pr-2.5 pl-[32px] text-[13px] transition-colors ${
                        active
                          ? "border-l-[var(--primary)] bg-foreground/[0.08] font-medium text-foreground"
                          : "border-l-transparent text-muted-foreground hover:bg-[var(--row-hover)] hover:text-foreground"
                      }`}
                    >
                      <BIcon className={`size-[15px] shrink-0 ${active ? "text-foreground" : "text-meta"}`} aria-hidden />
                      {b.label}
                    </Link>
                  );
                })}
              </div>
            </div>
          );
        })}
      </nav>

      {showPrimary && (
        <div className="border-t border-border px-2 py-2 lg:px-3">
          <Link
            href={PRIMARY_ACTION.href}
            onClick={() => setOpen(false)}
            aria-current={isHrefActive(PRIMARY_ACTION.href, pathname) ? "page" : undefined}
            className={`flex items-center justify-center gap-2 whitespace-nowrap rounded border px-3 py-2 text-[13.5px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
              isHrefActive(PRIMARY_ACTION.href, pathname) ? "border-foreground bg-foreground/[0.07] text-foreground" : "border-border text-foreground hover:bg-[var(--row-hover)]"
            }`}
          >
            <Plus className="size-4 shrink-0 text-tertiary-text" aria-hidden /> {PRIMARY_ACTION.label}
          </Link>
        </div>
      )}

      <div className="flex items-center gap-2.5 border-t border-border px-[18px] py-3">
        <span className="flex size-7 shrink-0 items-center justify-center rounded border border-border text-[11px] font-medium text-tertiary-text">{initials}</span>
        <div className="min-w-0 flex-1 leading-tight">
          <div className="truncate text-[12.5px] font-medium text-foreground">{name}</div>
          <div className="text-[11px] text-meta">{ROLE_LABEL[role]}</div>
        </div>
        <button onClick={logout} className="text-[11.5px] font-medium uppercase tracking-[0.06em] text-meta transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" title="Sign out">
          Sign out
        </button>
      </div>
    </>
  );

  // ── Collapsed desktop rail: icons only, every destination still reachable ──
  const railIconBtn =
    "flex size-9 items-center justify-center rounded border-l-2 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
  const expandAndOpen = (label: string) => {
    setCollapsed(false);
    try {
      localStorage.setItem(COLLAPSED_KEY, "0");
    } catch {
      /* ignore */
    }
    setOpenGroups((prev) => (prev.has(label) ? prev : new Set(prev).add(label)));
  };
  const rail = (
    <div className="flex h-full flex-col items-center gap-1 py-3">
      <Tent className="size-5 shrink-0 text-[var(--gold)]" aria-hidden />
      <button
        onClick={toggleCollapsed}
        aria-label="Expand navigation"
        aria-expanded={false}
        className="mt-1 flex size-9 items-center justify-center rounded border border-border text-tertiary-text transition-colors hover:bg-[var(--row-hover)] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <PanelLeftOpen className="size-4" aria-hidden />
      </button>

      <div className="mt-1 flex min-h-0 flex-1 flex-col items-center gap-1 overflow-y-auto">
        {hubs.map((hub) => {
          const active = isHrefActive(hub.href, pathname);
          const Icon = hub.icon;
          return (
            <Link
              key={hub.href}
              href={hub.href}
              aria-current={active ? "page" : undefined}
              aria-label={hub.label}
              title={hub.label}
              className={`${railIconBtn} ${active ? "border-l-[var(--primary)] bg-foreground/[0.08] text-foreground" : "border-l-transparent text-meta hover:bg-[var(--row-hover)] hover:text-foreground"}`}
            >
              <Icon className="size-[18px]" aria-hidden />
            </Link>
          );
        })}
        {groups.map((g) => {
          const GIcon = g.icon;
          const hasActive = groupIsActive(g, pathname);
          return (
            <button
              key={g.label}
              onClick={() => expandAndOpen(g.label)}
              aria-label={`${g.label} (expand to open)`}
              title={g.label}
              className={`${railIconBtn} ${hasActive ? "border-l-[var(--primary)] bg-foreground/[0.08] text-foreground" : "border-l-transparent text-meta hover:bg-[var(--row-hover)] hover:text-foreground"}`}
            >
              <GIcon className="size-[18px]" aria-hidden />
            </button>
          );
        })}
      </div>

      {showPrimary && (
        <Link
          href={PRIMARY_ACTION.href}
          aria-label={PRIMARY_ACTION.label}
          title={PRIMARY_ACTION.label}
          className="flex size-9 items-center justify-center rounded border border-border text-foreground transition-colors hover:bg-[var(--row-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Plus className="size-4" aria-hidden />
        </Link>
      )}
      <span className="flex size-7 shrink-0 items-center justify-center rounded border border-border text-[11px] font-medium text-tertiary-text" title={`${name} · ${ROLE_LABEL[role]}`}>{initials}</span>
      <button
        onClick={logout}
        aria-label="Sign out"
        title="Sign out"
        className="flex size-9 items-center justify-center rounded text-meta transition-colors hover:bg-[var(--row-hover)] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <LogOut className="size-4" aria-hidden />
      </button>
    </div>
  );

  return (
    <>
      {/* Mobile / tablet: compact top bar (hamburger · title · integration summary · theme) */}
      <div className="flex items-center gap-2 border-b border-border bg-sidebar px-3 py-2.5 lg:hidden">
        <button
          ref={triggerRef}
          onClick={() => setOpen(true)}
          aria-label="Open navigation"
          aria-expanded={open}
          className="flex size-9 shrink-0 items-center justify-center rounded border border-border text-foreground transition-colors hover:bg-[var(--row-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Menu className="size-5" aria-hidden />
        </button>
        <span className="min-w-0 flex-1 truncate text-[15px] font-medium text-foreground">{activeLabel}</span>
        <IntegrationSummary connections={connections} />
        <ThemeToggle />
      </div>

      {/* Drawer backdrop */}
      <div
        aria-hidden
        onClick={closeDrawer}
        className={`fixed inset-0 z-40 bg-black/60 transition-opacity duration-200 lg:hidden ${open ? "opacity-100" : "pointer-events-none opacity-0"}`}
      />

      {/* Drawer — focus-trapped while open; inert (out of tab order + a11y tree) while closed */}
      <aside
        ref={drawerRef}
        onKeyDown={onDrawerKeyDown}
        inert={!open}
        role="dialog"
        aria-modal="true"
        aria-label="Navigation"
        className={`fixed inset-y-0 left-0 z-50 flex w-[264px] max-w-[82vw] flex-col overflow-y-auto border-r border-border bg-sidebar transition-transform duration-200 lg:hidden ${
          open ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        {expandedPanel("drawer")}
      </aside>

      {/* Desktop: persistent left sidebar (expanded ~248px, or a collapsed icon rail) */}
      <aside
        className={`hidden shrink-0 lg:sticky lg:top-0 lg:flex lg:h-dvh lg:flex-col lg:border-r lg:border-border lg:bg-sidebar ${collapsed ? "lg:w-[60px]" : "lg:w-[248px]"}`}
      >
        {collapsed ? rail : expandedPanel("desktop")}
      </aside>
    </>
  );
}
