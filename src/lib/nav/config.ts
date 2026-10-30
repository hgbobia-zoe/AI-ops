// The platform's navigation model — ONE source of truth consumed by the sidebar (ConsoleNav), the
// breadcrumbs, and the mobile top-bar title. Pure data + pure selectors (no "use client", no DOM), so
// the permission/active/ancestor/breadcrumb logic is unit-testable in the node test env while the
// rendering lives in the client components that import this.
//
// IA (preserved from the Nocturne redesign): two pinned top-level hubs (Command Center, AI Command
// Center) above a set of expandable "big blade" groups, with an Admin group assembled from what the
// role can manage. The scoped `marketing` role sees ONLY its demand-generation surface — that scoping
// is enforced here by `marketingCanReachPage` exactly as the proxy enforces it as the hard boundary.

import {
  LayoutGrid, Tag, Building2, Wrench,
  Gauge, ListChecks, Truck, AlertTriangle, DollarSign,
  TrendingUp, Target, GraduationCap, Contact, Clock, Zap,
  RefreshCw, Plug, UsersRound, Settings, KeyRound, Calculator, Radar, IdCard, History, Globe2,
  Megaphone, Send, Upload, CalendarDays, CalendarCheck, Star,
  HeartHandshake, Columns3, LifeBuoy, ClipboardCheck, ClipboardList,
  Aperture, Dna,
  Headset, PhoneCall, FlaskConical,
  Search, FileText, Rocket, Globe,
  BrainCircuit, Wallet, Boxes,
  type LucideIcon,
} from "lucide-react";
import {
  canSeeFinancials, canSeeCoaching, canManageSettings, canManageUsers, canUseSeo,
  marketingCanReachPage, type Role,
} from "@/lib/auth/roles";

export interface Blade {
  href: string;
  label: string;
  icon: LucideIcon;
  financial?: boolean; // only where the role can see $
  coaching?: boolean; // only where the role can see call transcripts
  manage?: boolean; // owner/admin only (e.g. Capability Profile)
  seo?: boolean; // owner/admin + the scoped marketing role (canUseSeo)
  exact?: boolean; // highlight only on an exact path match (section landing pages)
  badge?: boolean; // show a small "New" badge beside the label
  children?: SubBlade[]; // nested query-param sub-sections, rendered as a third sidebar level (see SubBlade)
}
export interface NavGroup {
  label: string;
  icon: LucideIcon;
  blades: Blade[];
}

// A nested sub-section of a blade that is a query-param destination on ONE page (e.g. HR/Payroll's eight
// `?tab=` views). These render as a third level in the sidebar (group › blade › sub-section) instead of a
// separate in-page nav rail, so the whole hierarchy lives in the one global sidebar. `tab` is the ?tab=
// value ("overview" = the bare blade path); the active/href logic lives in @/lib/payroll/nav (pure + tested).
export interface SubBlade {
  tab: string;
  label: string;
  icon: LucideIcon;
}

// HR/Payroll's eight sections, nested under People › Payroll. SINGLE source of truth for the sidebar
// sub-nav AND the breadcrumb leaf (the page's own tab titles read from the same order). "overview" is the
// bare /payroll path; the rest are ?tab=<tab>. The selected pay period (?weeksAgo) is carried across them.
export const PAYROLL_HREF = "/payroll";
export const PAYROLL_SUBNAV: SubBlade[] = [
  { tab: "overview", label: "Overview", icon: Gauge },
  { tab: "review", label: "Payroll Review", icon: ClipboardCheck },
  { tab: "sync", label: "Time Sync", icon: RefreshCw },
  { tab: "workers", label: "Workers", icon: UsersRound },
  { tab: "contractors", label: "Contractors", icon: Globe2 },
  { tab: "exceptions", label: "Exceptions", icon: AlertTriangle },
  { tab: "history", label: "History", icon: History },
  { tab: "settings", label: "Settings", icon: Settings },
];

// The two 10k-ft hubs sit on their own at the top, outside the expandable groups. Hidden for the scoped
// marketing role (confined to its demand-gen surface).
export const HUB: Blade = { href: "/dashboard", label: "Command Center", icon: Gauge };
export const AI_HUB: Blade = { href: "/ai-command", label: "AI Command Center", icon: BrainCircuit, badge: true };

// The primary action pinned at the bottom of the sidebar (guided intake). Hidden for marketing.
export const PRIMARY_ACTION: Blade = { href: "/intake", label: "New Project", icon: Target };

export const NAV_GROUPS: NavGroup[] = [
  {
    // AI Org — the control plane over Zoe's AI workforce (owner/admin only; every sub-blade `manage`).
    label: "AI Org",
    icon: BrainCircuit,
    blades: [
      { href: "/ai-org", label: "Overview", icon: Gauge, exact: true, manage: true },
      { href: "/ai-org/employees", label: "AI Employees", icon: UsersRound, manage: true },
      { href: "/ai-org/approvals", label: "Approvals", icon: ClipboardCheck, manage: true },
      { href: "/ai-org/runs", label: "Runs", icon: RefreshCw, manage: true },
      { href: "/ai-org/exceptions", label: "Exceptions", icon: AlertTriangle, manage: true },
    ],
  },
  {
    // Opportunity Radar — opportunity intelligence + bid pursuit. Capability Profile lives here (manage).
    label: "Opportunity Radar",
    icon: Radar,
    blades: [
      { href: "/radar", label: "Overview", icon: Gauge, exact: true },
      { href: "/radar/outreach", label: "Outreach", icon: Send },
      { href: "/radar/campaigns", label: "Campaigns", icon: Target },
      { href: "/radar/companies", label: "Companies", icon: Building2 },
      { href: "/radar/analytics", label: "Analytics", icon: TrendingUp },
      { href: "/radar/sources", label: "Sources", icon: Plug },
      { href: "/radar/capability", label: "Capability Profile", icon: IdCard, manage: true },
      { href: "/radar/import", label: "Import", icon: Upload },
    ],
  },
  {
    label: "Operations",
    icon: LayoutGrid,
    blades: [
      { href: "/ops", label: "Ops Manager", icon: ListChecks },
      { href: "/dispatch", label: "Dispatch", icon: Truck },
      { href: "/events", label: "Events", icon: CalendarCheck, manage: true },
      { href: "/risk", label: "Event Risk", icon: AlertTriangle },
      // "Inventory" opens the partner-catalog IMPORT tool (bulk-copy a vendor's Goodshuffle storefront
      // into Zoe's inventory), not a general inventory manager — the label now says what it does.
      { href: "/inventory", label: "Inventory Import", icon: Boxes, manage: true },
      { href: "/scheduling", label: "Scheduling", icon: CalendarDays },
      { href: "/admin/passes", label: "Shift Passes", icon: KeyRound, manage: true },
      { href: "/finance", label: "Financial", icon: DollarSign, financial: true },
    ],
  },
  {
    // People — HR / Payroll reconciliation + lifecycle. Pay + PII, so owner/admin only.
    label: "People",
    icon: UsersRound,
    blades: [
      { href: "/people", label: "People Lifecycle", icon: Contact, manage: true },
      // Payroll's eight sections are nested here (third sidebar level), not a separate in-page rail.
      { href: PAYROLL_HREF, label: "Payroll", icon: Wallet, financial: true, children: PAYROLL_SUBNAV },
    ],
  },
  {
    // Marketing — demand-generation OS (incl. the Creative Engine). Parent/child name clash resolved:
    // the landing blade is "Overview", not "Marketing".
    label: "Marketing",
    icon: Megaphone,
    blades: [
      { href: "/marketing", label: "Overview", icon: Gauge, exact: true },
      { href: "/marketing/outreach", label: "Outreach", icon: Send },
      { href: "/marketing/campaigns", label: "Campaigns", icon: Megaphone },
      { href: "/marketing/content", label: "Content", icon: CalendarDays },
      { href: "/marketing/reviews", label: "Reviews", icon: Star },
      { href: "/creative", label: "Creative Engine", icon: Aperture, exact: true },
      // "New Creative Job" is no longer a permanent sidebar row — the Creative Engine page carries its
      // own "New job" CTA, so the destination stays reachable without cluttering the nav with an action.
      { href: "/creative/benchmarks", label: "Provider Benchmarks", icon: FlaskConical },
      { href: "/creative/dna", label: "Visual DNA", icon: Dna, manage: true },
    ],
  },
  {
    // SEO & Website — the organic-demand engine + the website editor that feeds it.
    label: "SEO & Website",
    icon: Search,
    blades: [
      { href: "/seo", label: "Overview", icon: Gauge, exact: true, seo: true },
      { href: "/seo/opportunities", label: "Opportunities", icon: Search, seo: true },
      { href: "/seo/competitors", label: "Competitors", icon: Building2, seo: true },
      { href: "/seo/content", label: "Content Studio", icon: FileText, seo: true },
      { href: "/seo/queue", label: "Review Queue", icon: ClipboardCheck, seo: true },
      { href: "/seo/performance", label: "Performance", icon: Rocket, seo: true },
      { href: "/website-studio", label: "Website Studio", icon: Globe },
    ],
  },
  {
    // Communications / Voice Operations — the operating console over inbound/outbound calls + SMS.
    label: "Communications",
    icon: Headset,
    blades: [
      { href: "/communications", label: "Queue", icon: PhoneCall, exact: true },
      { href: "/communications/lab", label: "Voice Lab", icon: FlaskConical },
      { href: "/communications/tools", label: "Tool Registry", icon: Wrench },
      { href: "/communications/status", label: "Integrations", icon: Plug },
    ],
  },
  {
    label: "Sales",
    icon: Tag,
    blades: [
      // Sales / Sales OS disambiguated: "Sales Intelligence" is the full-year revenue analytics blade;
      // "Sales OS" is the Next-Best-Action worklist. Group label stays "Sales" (no parent/child clash now).
      { href: "/sales", label: "Sales Intelligence", icon: TrendingUp },
      { href: "/salesos", label: "Sales OS", icon: Target },
      { href: "/salesos/outreach", label: "Bulk Outreach", icon: Send, manage: true },
      { href: "/salesos/status", label: "Pipeline Status", icon: ClipboardList, financial: true },
      { href: "/coaching", label: "Coaching", icon: GraduationCap, coaching: true },
      { href: "/customers", label: "Customers", icon: Contact },
      { href: "/pricing", label: "Delivery Pricing", icon: Calculator },
    ],
  },
  {
    // Post-Event — human-first customer experience + service recovery + review workflow.
    label: "Post-Event",
    icon: HeartHandshake,
    blades: [
      { href: "/postevent", label: "Overview", icon: Gauge, exact: true },
      { href: "/postevent/kanban", label: "Kanban", icon: Columns3 },
      { href: "/postevent/issues", label: "Issues / Recovery", icon: LifeBuoy },
      { href: "/postevent/analytics", label: "Analytics", icon: TrendingUp },
      { href: "/postevent/closures", label: "Closure Reasons", icon: ClipboardCheck },
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

/** The Admin group, assembled from what the role may manage (empty → not shown). */
export function buildAdminGroup(role: Role): NavGroup | null {
  const blades: Blade[] = [];
  if (canManageSettings(role)) blades.push({ href: "/admin/pull", label: "Pull Routes", icon: RefreshCw });
  if (canManageSettings(role)) blades.push({ href: "/admin/health", label: "Connections", icon: Plug });
  if (canManageUsers(role)) blades.push({ href: "/admin/users", label: "Team", icon: UsersRound });
  if (canManageSettings(role)) blades.push({ href: "/admin/ai", label: "AI Configuration", icon: BrainCircuit });
  if (canManageSettings(role)) blades.push({ href: "/admin", label: "Settings", icon: Settings, exact: true });
  return blades.length ? { label: "Admin", icon: Wrench, blades } : null;
}

/** The scoped marketing role is confined to its demand-gen surface (same allow-list the proxy enforces).
 *  Within it there are no financial blades, so the deny-list flags (manage/seo/coaching) don't hide
 *  anything from it; financial is still honored defensively. Other roles keep the deny-list model. */
export function bladeVisible(b: Blade, role: Role): boolean {
  if (b.financial && !canSeeFinancials(role)) return false;
  if (role === "marketing") return marketingCanReachPage(b.href);
  if (b.coaching && !canSeeCoaching(role)) return false;
  if (b.seo && !canUseSeo(role)) return false;
  if (b.manage && !canManageSettings(role)) return false;
  return true;
}

/** The two top hubs this role sees (marketing sees neither). */
export function visibleHubs(role: Role): Blade[] {
  return role === "marketing" ? [] : [HUB, AI_HUB];
}

/** Whether the role can see the pinned primary action (New Project). */
export function showsPrimaryAction(role: Role): boolean {
  return role !== "marketing";
}

/** The groups this role sees, each already filtered to its visible blades (empty groups dropped), with
 *  the assembled Admin group appended. This is the model both the sidebar and breadcrumbs render from. */
export function visibleGroups(role: Role): NavGroup[] {
  const groups = NAV_GROUPS
    .map((g) => ({ ...g, blades: g.blades.filter((b) => bladeVisible(b, role)) }))
    .filter((g) => g.blades.length > 0);
  const admin = buildAdminGroup(role);
  return admin ? [...groups, admin] : groups;
}

/** Path-prefix match: a blade is active for its own path and any sub-path under it. */
export function isHrefActive(href: string, pathname: string): boolean {
  return pathname === href || pathname.startsWith(href + "/");
}

/** Whether a blade is the active destination (exact blades match only their own path). */
export function isBladeActive(b: Blade, pathname: string): boolean {
  return b.exact ? pathname === b.href : isHrefActive(b.href, pathname);
}

/** Whether any blade in the group is on the current path (ignores `exact` — an ancestor is active for a
 *  sub-path even when its landing blade is exact-only). */
export function groupIsActive(g: NavGroup, pathname: string): boolean {
  return g.blades.some((b) => isHrefActive(b.href, pathname));
}

/** The label of the group that contains the current page (for auto-expanding the active ancestor). */
export function activeGroupLabel(groups: NavGroup[], pathname: string): string | undefined {
  return groups.find((g) => groupIsActive(g, pathname))?.label;
}

/** The deepest-matching visible blade (longest href wins), used for the mobile top-bar title. */
export function activeBlade(groups: NavGroup[], pathname: string): Blade | undefined {
  return groups
    .flatMap((g) => g.blades)
    .filter((b) => isBladeActive(b, pathname))
    .sort((a, b) => b.href.length - a.href.length)[0];
}

export interface Crumb {
  label: string;
  href?: string; // omitted → not a link (the current page, or a non-navigable group label)
}

const INTAKE = { href: "/intake", label: "New Project" };

function titleize(segment: string): string {
  return segment
    .split("-")
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}

/** Breadcrumb trail for the current path, resolved against what THIS role can see. One consistent
 *  pattern: [group] › [blade] › [sub-view?]. Hubs and the primary action are single crumbs. `tab` (the
 *  ?tab= query) resolves the active sub-section for a blade with nested children (HR/Payroll), so the
 *  header breadcrumb reads e.g. People › Payroll › Payroll Review. */
export function breadcrumbTrail(pathname: string, role: Role, tab?: string | null): Crumb[] {
  for (const hub of visibleHubs(role)) {
    if (isHrefActive(hub.href, pathname)) return [{ label: hub.label, href: hub.href }];
  }
  if (isHrefActive(INTAKE.href, pathname)) return [{ label: INTAKE.label, href: INTAKE.href }];

  const groups = visibleGroups(role);
  for (const g of groups) {
    if (!groupIsActive(g, pathname)) continue;
    // Deepest matching blade in this group wins (longest href).
    const blade = g.blades
      .filter((b) => isHrefActive(b.href, pathname))
      .sort((a, b) => b.href.length - a.href.length)[0];
    if (!blade) break;
    // A blade with nested sub-sections (HR/Payroll): the active ?tab becomes the leaf crumb, and the blade
    // itself links to its overview when we're on a deeper section. Always exactly group › blade › section.
    if (blade.children?.length) {
      const activeTab = (tab && tab.trim()) || "overview";
      const sub = blade.children.find((c) => c.tab === activeTab) ?? blade.children[0];
      const onOverview = sub.tab === "overview";
      return [
        { label: g.label },
        { label: blade.label, href: onOverview ? undefined : blade.href },
        { label: sub.label },
      ];
    }
    // The group label links to its landing blade ONLY when the group has an explicit exact landing page
    // (e.g. /radar, /marketing) and we're deeper than it; otherwise the group label is inert (no link to
    // an arbitrary first blade).
    const landing = g.blades.find((b) => b.exact);
    const crumbs: Crumb[] = [];
    if (landing && landing.href !== blade.href) crumbs.push({ label: g.label, href: landing.href });
    else crumbs.push({ label: g.label });
    const onBlade = pathname === blade.href;
    crumbs.push({ label: blade.label, href: onBlade ? undefined : blade.href });
    // A deeper local view under the blade (e.g. /salesos/board) → one more inert crumb from the segment.
    if (!onBlade && pathname.startsWith(blade.href + "/")) {
      const rest = pathname.slice(blade.href.length + 1).split("/").filter(Boolean);
      if (rest.length) crumbs.push({ label: titleize(rest[0]) });
    }
    return crumbs;
  }

  // Unknown path (no visible blade owns it) → titleized segments, last one inert.
  const segs = pathname.split("/").filter(Boolean);
  if (!segs.length) return [{ label: "Home" }];
  return segs.map((s, i) => ({ label: titleize(s), href: i < segs.length - 1 ? "/" + segs.slice(0, i + 1).join("/") : undefined }));
}
