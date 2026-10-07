// Zoe Operations Command Center — the business operations control tower. A dense, gold-accented cockpit:
// KPI row with sparklines, revenue performance, quote status, operational capacity, today's operations,
// needs-attention, AI-recommended top opportunities, plus a right rail (live AI sessions that links out to
// the AI Command Center, upcoming events, next actions). Everything reads existing services; nothing is
// fabricated — an unresolved value is "—" and says so. Money is Owner/Admin only. Separate from the AI
// Command Center (/ai-command), which operates the AI; this is the business dashboard.

import Link from "next/link";
import {
  AlertTriangle, ArrowRight, DollarSign, FileText, CalendarCheck, ShieldAlert, Truck,
  Gauge, Radar, Lightbulb, ListChecks, Bot, CalendarDays, CircleDot, Phone, Mail, Users, Megaphone, MapPin,
  Search, Bell, ChevronDown, Plus, Tag,
} from "lucide-react";
import { AutoRefresh } from "@/components/AutoRefresh";
import { commandCenter } from "@/lib/command/service";
import { capacityLevel, type CapacityLevel } from "@/lib/command/calc";
import { salesYearOverview } from "@/lib/sales/service";
import { salesCommandCenter } from "@/lib/salesos/commandCenter";
import { getPipelineBookingsInRange, getQuoteActivityInRange, type BookingView } from "@/lib/db/repo";
import { aiControlOverview } from "@/lib/ai/control";
import { listRecentSessions } from "@/lib/ai/sessions";
import { STATUS_META } from "@/lib/ai/sessionDisplay";
import { formatYmdLong, shiftYmd } from "@/lib/dates";
import { viewerRole, currentActor } from "@/lib/auth/getSession";
import { canSeeFinancials } from "@/lib/auth/roles";
import type { Priority } from "@/lib/ops/manager";
import { RevenueTrendChart, type MonthPoint } from "@/components/dashboard/RevenueTrendChart";
import { QuotePipeline, type PipelineBucket } from "@/components/dashboard/QuotePipeline";
import { WIDGET_SCOPE } from "@/lib/command/widgetScope";
import { TodayMap } from "@/components/dashboard/TodayMap";

export const dynamic = "force-dynamic";

const money = (n: number | null | undefined): string => (n == null ? "—" : "$" + Math.round(n).toLocaleString("en-US"));
const moneyK = (n: number | null | undefined): string => {
  if (n == null) return "—";
  return Math.abs(n) >= 1000 ? "$" + (Math.round(n / 100) / 10).toLocaleString("en-US") + "K" : "$" + Math.round(n).toLocaleString("en-US");
};
const plural = (n: number, w: string): string => `${n} ${w}${n === 1 ? "" : "s"}`;

const P_DOT: Record<Priority, string> = { critical: "bg-critical", high: "bg-attention", medium: "bg-attention/70", info: "bg-[var(--bar)]" };
// Vivid dashboard data-viz palette (brighter than the recessive Nocturne tokens; scoped to the dashboard).
const CAP_HEX: Record<CapacityLevel, string> = { NORMAL: "#3ad492", TIGHT: "#f0c13a", CONSTRAINED: "#f06a5e", UNVERIFIED: "#3f424d" };
// KPI accent palette — green revenue/fleet, blue quotes, purple booked, amber/red risk.
const KPI_C = { green: "#3ad492", blue: "#5e9cf7", purple: "#8f74f2", purpleHi: "#b8a4ff", red: "#f06a5e", amber: "#f0c13a", track: "#262834" };
const NBA_LABEL: Record<string, string> = {
  CALL_NOW: "Call", SEND_SMS: "Text", FOLLOW_UP: "Follow up", ASK_DISCOVERY: "Discover", HANDLE_OBJECTION: "Respond",
  VERIFY_AVAILABILITY: "Verify", REVIEW_QUOTE: "Review", WAIT: "View",
};

type RangeKey = "today" | "tomorrow" | "7d" | "14d" | "30d" | "90d" | "year";
const RANGES: { key: RangeKey; label: string }[] = [
  { key: "today", label: "Today" }, { key: "tomorrow", label: "Tomorrow" }, { key: "7d", label: "7D" }, { key: "14d", label: "14D" }, { key: "30d", label: "30D" }, { key: "90d", label: "90D" }, { key: "year", label: "2026" },
];
// FUTURE window — for Upcoming Events (event dates ahead of today).
function rangeWindow(key: RangeKey, today: string, year: number): { start: string; end: string; label: string } {
  switch (key) {
    case "tomorrow": return { start: shiftYmd(today, 1), end: shiftYmd(today, 1), label: "tomorrow" };
    case "7d": return { start: today, end: shiftYmd(today, 6), label: "next 7 days" };
    case "14d": return { start: today, end: shiftYmd(today, 13), label: "next 14 days" };
    case "30d": return { start: today, end: shiftYmd(today, 29), label: "next 30 days" };
    case "90d": return { start: today, end: shiftYmd(today, 89), label: "next 90 days" };
    case "year": return { start: `${year}-01-01`, end: `${year}-12-31`, label: String(year) };
    default: return { start: today, end: today, label: "today" };
  }
}
// PAST window — for Quote Activity (quotes created up to today). Same selector, natural direction.
// "Tomorrow" has no created-quote history, so Activity falls back to today's created quotes.
function activityWindow(key: RangeKey, today: string, year: number): { start: string; end: string; label: string } {
  switch (key) {
    case "7d": return { start: shiftYmd(today, -6), end: today, label: "last 7 days" };
    case "14d": return { start: shiftYmd(today, -13), end: today, label: "last 14 days" };
    case "30d": return { start: shiftYmd(today, -29), end: today, label: "last 30 days" };
    case "90d": return { start: shiftYmd(today, -89), end: today, label: "last 90 days" };
    case "year": return { start: `${year}-01-01`, end: today, label: String(year) };
    default: return { start: today, end: today, label: "today" }; // today + tomorrow
  }
}

function dow(ymd: string): string { return new Date(`${ymd}T00:00:00Z`).toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" }); }
function dnum(ymd: string): string { return new Date(`${ymd}T00:00:00Z`).toLocaleDateString("en-US", { day: "numeric", timeZone: "UTC" }); }
function daysBetween(a: string, b: string): number { return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000); }
function titleCase(s: string): string { return s.charAt(0).toUpperCase() + s.slice(1); }
function mon(ymd: string): string { return new Date(`${ymd}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", timeZone: "UTC" }).toUpperCase(); }
function ago(iso: string | null): string {
  if (!iso) return "—";
  const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (!Number.isFinite(m)) return "—";
  if (m < 1) return "now"; if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60); return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}

export default async function DashboardPage({ searchParams }: { searchParams: Promise<{ range?: string }> }): Promise<React.JSX.Element> {
  const role = await viewerRole();
  const showMoney = canSeeFinancials(role);
  const actor = await currentActor();
  const firstName = actor.label.split(/[\s(]/)[0] || "Zoe";
  const initials = actor.label.split(/\s+/).map((p) => p[0]).filter(Boolean).slice(0, 2).join("").toUpperCase() || "ZO";
  const c = await commandCenter();
  const rev = c.revenue;
  const year = c.year;
  const today = c.today;

  const sp = await searchParams;
  const range: RangeKey = (RANGES.some((r) => r.key === sp.range) ? sp.range : "today") as RangeKey;
  const win = rangeWindow(range, today, year);

  // Extra reads (existing services only) — prior-year trend, sales queue, upcoming (range-scoped), AI.
  const prev = safe(() => salesYearOverview(year - 1), null);
  const salesQ = showMoney ? safe(() => salesCommandCenter(), null) : null;
  // UPCOMING EVENTS — the one widget that follows the global selector. Earliest-first, capped to a short
  // dashboard preview (the Events blade holds the full list).
  const upcoming = safe(() => getPipelineBookingsInRange(win.start, win.end), [] as BookingView[])
    .filter((b) => b.eventDate)
    .sort((a, b) => (a.eventDate! < b.eventDate! ? -1 : 1))
    .slice(0, 6);
  const upcomingTitle = `Upcoming events — ${titleCase(win.label)}`;
  const aiOverview = safe(() => aiControlOverview(), null);
  const aiSessions = safe(() => listRecentSessions(6), []);

  // Monthly trend points (current + prior year).
  const curM = c.sales.months;
  const prevM = prev?.months ?? [];
  const months: MonthPoint[] = curM.map((m, i) => ({
    label: m.label,
    revenue: { cur: m.signedRevenue, prev: prevM[i]?.signedRevenue ?? null },
    quotes: { cur: m.count || null, prev: prevM[i]?.count || null },
    events: { cur: m.signedCount || null, prev: prevM[i]?.signedCount || null },
  }));

  // KPI delta/trend helpers from current-year months.
  const curMonthIdx = Number(today.slice(5, 7)) - 1;
  const eventBars = curM.map((m) => m.count);
  const revDelta = pctDelta(curM[curMonthIdx]?.signedRevenue ?? null, curM[curMonthIdx - 1]?.signedRevenue ?? null);
  const eventDelta = pctDelta(curM[curMonthIdx]?.count ?? null, curM[curMonthIdx - 1]?.count ?? null);

  // Average order value — signed revenue per signed order (a single high-ticket event can outweigh many
  // small ones, so this reads truer than raw event count). Monthly trend + current month + MoM delta.
  const aovOf = (m?: { signedRevenue: number | null; signedCount: number }): number | null =>
    m && m.signedRevenue != null && m.signedCount > 0 ? m.signedRevenue / m.signedCount : null;
  const aovBars = curM.map((m) => aovOf(m));
  const curAov = aovOf(curM[curMonthIdx]);
  const aovDelta = pctDelta(curAov, aovOf(curM[curMonthIdx - 1]));
  const ordersThisMonth = curM[curMonthIdx]?.signedCount ?? 0;

  const bookedThisMonth = curM[curMonthIdx]?.count ?? 0; // events booked this month (matches "This month")

  const attention = showMoney ? c.attention : c.attention.filter((i) => i.source !== "finance");
  const crit = attention.filter((i) => i.priority === "critical").length;
  const high = attention.filter((i) => i.priority === "high").length;
  const med = attention.filter((i) => i.priority === "medium").length;
  const low = attention.filter((i) => i.priority === "info").length;
  // Severity breakdown sub (e.g. "1 critical · 2 high · 1 medium"), matching the mockup's "1 medium · 1 low".
  const riskSub = [crit && `${crit} critical`, high && `${high} high`, med && `${med} medium`, low && `${low} low`].filter(Boolean).join(" · ") || "all clear";
  const nextActions = attention.filter((i) => i.priority !== "info").slice(0, 6).map((i) => ({
    key: i.key, href: i.href, priority: i.priority,
    text: i.detail?.split("→")[1]?.trim() && i.detail.split("→")[1].trim().length > 3 ? i.detail.split("→")[1].trim() : i.title,
  }));

  const util = c.today_ops.fleetSize > 0 ? Math.round((c.today_ops.trucksUsed / c.today_ops.fleetSize) * 100) : null;

  // ── Widget data scopes (contract in widgetScope.ts) ──────────────────────────
  const monthName = rev.periodLabel; // "October" — the MTD revenue/booked month
  const signedThisMonth = curM[curMonthIdx]?.signedCount ?? 0;

  // QUOTE PIPELINE (current open, by EVENT date) — NOT range-scoped. Open-quote revenue split into
  // event-date horizon buckets, because the urgent question is how much open revenue is approaching.
  const openQuotes = safe(() => getPipelineBookingsInRange(today, shiftYmd(today, 3650)), [] as BookingView[]).filter((b) => !b.signed && b.eventDate);
  const HORIZONS: { label: string; lo: number; hi: number }[] = [
    { label: "0–7 days", lo: 0, hi: 7 }, { label: "8–14 days", lo: 8, hi: 14 }, { label: "15–30 days", lo: 15, hi: 30 },
    { label: "31–60 days", lo: 31, hi: 60 }, { label: "60+ days", lo: 61, hi: Infinity },
  ];
  const pipelineBuckets: PipelineBucket[] = HORIZONS.map((h) => {
    const inB = openQuotes.filter((b) => { const d = daysBetween(today, b.eventDate!); return d >= h.lo && d <= h.hi; });
    const priced = inB.filter((b) => b.grandTotal != null);
    return { label: h.label, count: inB.length, value: priced.length ? priced.reduce((s, b) => s + (b.grandTotal ?? 0), 0) : null };
  });
  const openValue = openQuotes.some((b) => b.grandTotal != null) ? openQuotes.reduce((s, b) => s + (b.grandTotal ?? 0), 0) : null;
  const pipelineData = { count: openQuotes.length, value: openValue, buckets: pipelineBuckets };

  // QUOTE ACTIVITY (by CREATED date) — controlled by the global selector as a PAST window. Never mixes
  // with event-date pipeline.
  const actWin = activityWindow(range, today, year);
  const actRaw = showMoney ? safe(() => getQuoteActivityInRange(actWin.start, actWin.end), null) : null;
  const activity = actRaw ? {
    ...actRaw,
    winRate: actRaw.signed + actRaw.lost > 0 ? Math.round((actRaw.signed / (actRaw.signed + actRaw.lost)) * 100) : null,
    label: actWin.label,
  } : null;

  // Next operational day — for the Today's Operations empty state (don't show a giant empty map).
  const futureOps = safe(() => getPipelineBookingsInRange(shiftYmd(today, 1), shiftYmd(today, 60)), [] as BookingView[]).filter((b) => b.eventDate);
  const nextOpDate = futureOps.length ? futureOps[0].eventDate! : null;
  const nextOpDay = nextOpDate ? { date: nextOpDate, count: futureOps.filter((b) => b.eventDate === nextOpDate).length } : null;
  const hasOpsToday = c.today_ops.stops > 0 || c.today_ops.activeRoutes > 0;

  return (
    <main className="p-3 pb-8 leading-[1.3] md:px-4 md:pb-4">
      <AutoRefresh seconds={120} />

      {/* v3 top bar — search, quick actions, notifications, viewer (dashboard chrome) */}
      <div className="mb-2 flex h-[46px] items-center gap-2.5">
        <div className="flex h-8 min-w-0 flex-[0_1_460px] items-center gap-2 rounded-md border border-border bg-[#151722] px-3 text-[12.5px] text-meta">
          <Search className="size-[15px] shrink-0" />
          <span className="truncate">Search anything… (quotes, events, customers, routes, risks)</span>
          <span className="ml-auto shrink-0 rounded border border-[var(--bar)] px-1.5 text-[11px] text-[var(--bar-2)]">⌘K</span>
        </div>
        <div className="ml-auto flex items-center gap-2.5">
          <Link href="/intake" className="flex h-8 items-center gap-2 rounded-md border border-border bg-[#151722] px-3 text-[12.5px] text-secondary-text transition-colors hover:border-[var(--bar)]"><Plus className="size-3.5" /> Quick Actions</Link>
          <Link href="/ai-command" aria-label="Notifications" className="relative grid size-8 place-items-center rounded-md border border-border bg-[#151722] text-secondary-text transition-colors hover:border-[var(--bar)]">
            <Bell className="size-4" />
            {aiOverview && aiOverview.pendingApprovals > 0 && <span className="absolute right-[7px] top-[6px] size-1.5 rounded-full bg-critical" />}
          </Link>
          <div className="flex items-center gap-2 pl-1">
            <span className="grid size-7 place-items-center rounded-full bg-[#3d3a78] text-[11px] font-semibold text-foreground">{initials}</span>
            <span className="text-[12.5px] text-foreground">{firstName}</span>
            <ChevronDown className="size-3 text-meta" />
          </div>
        </div>
      </div>

      {/* Header + range tabs */}
      <header className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-[24px] font-semibold tracking-tight">Command Center</h1>
          <p className="text-[12.5px] text-meta">{formatYmdLong(today)} · real-time view of your business, operations and AI activity.</p>
        </div>
        <div className="flex items-center gap-2">
          <div className="inline-flex overflow-hidden rounded border border-border">
            {RANGES.map((r) => (
              <Link key={r.key} href={r.key === "today" ? "/dashboard" : `/dashboard?range=${r.key}`} aria-current={range === r.key ? "page" : undefined}
                className={`px-2.5 py-1 text-[12px] font-medium transition-colors ${range === r.key ? "bg-[var(--gold)]/15 text-[var(--gold)]" : "text-muted-foreground hover:bg-[var(--row-hover)] hover:text-foreground"}`}>
                {r.label}
              </Link>
            ))}
          </div>
          <span className="inline-flex items-center gap-1.5 rounded border border-border px-2.5 py-1 text-[12px] text-tertiary-text"><MapPin className="size-3.5 text-meta" /> All locations</span>
        </div>
      </header>

      <div className="grid grid-cols-1 gap-3 xl:[grid-template-columns:minmax(0,1fr)_486px]">
        {/* ── LEFT: business cockpit ── */}
        <div className="space-y-3 min-w-0">
          {/* KPI row */}
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-5">
            {showMoney ? (
              <Kpi icon={<DollarSign className="size-3.5" />} label={`Revenue — ${monthName}`} big={money(rev.committed)}
                sub={rev.target != null ? `Target ${money(rev.target)}` : "no target set"}
                visual={{ kind: "progress", pct: rev.pctOfTarget, color: KPI_C.green, inlineLabel: rev.pctOfTarget != null ? `${rev.pctOfTarget}%` : undefined }}
                footnote={revDelta ? { text: `${revDelta.up ? "▲" : "▼"} ${revDelta.pct}% vs last month`, tone: revDelta.up ? "good" : "bad" } : undefined} />
            ) : (
              <Kpi icon={<CalendarCheck className="size-3.5" />} label="Events today" big={String(c.today_ops.events)} sub="scheduled" />
            )}
            <Kpi icon={<FileText className="size-3.5" />} label="Open quotes" big={String(pipelineData.count)}
              sub={showMoney ? `${money(openValue)} pipeline` : "awaiting response"}
              footnote={{ text: `${signedThisMonth} signed this month`, tone: "meta" }} />
            {showMoney ? (
              <Kpi icon={<Tag className="size-3.5" />} label="Avg order value" big={money(curAov)}
                sub={`${ordersThisMonth} orders · ${monthName}`} visual={{ kind: "bars", data: aovBars, color: KPI_C.purple, recentColor: KPI_C.purpleHi }}
                footnote={aovDelta ? { text: `${aovDelta.up ? "▲" : "▼"} ${aovDelta.pct}% vs last month`, tone: aovDelta.up ? "good" : "bad" } : undefined} />
            ) : (
              <Kpi icon={<CalendarCheck className="size-3.5" />} label={`Booked events — ${monthName}`} big={String(bookedThisMonth)}
                sub="This month" visual={{ kind: "bars", data: eventBars, color: KPI_C.purple, recentColor: KPI_C.purpleHi }}
                footnote={eventDelta ? { text: `${eventDelta.up ? "▲" : "▼"} ${eventDelta.pct}% vs last month`, tone: eventDelta.up ? "good" : "bad" } : undefined} />
            )}
            <Kpi icon={<ShieldAlert className="size-3.5" />} label="Open operational risks" big={String(crit + high + med + low)}
              sub={riskSub} visual={{ kind: "severity", crit, high, med, low }} href="#attention" />
            <Kpi icon={<Truck className="size-3.5" />} label="Fleet &amp; crew — today" big={`${c.today_ops.trucksUsed} / ${c.today_ops.fleetSize}`}
              sub="Active today" visual={{ kind: "progress", pct: util, color: KPI_C.green }}
              footnote={util != null ? { text: `${util}% utilization`, tone: "good" } : undefined} />
          </div>

          {/* Revenue performance (cols 1–3, under Revenue/Quotes/AOV) + Quote Pipeline (cols 4–5, under
              Risks/Fleet) — same 5-col grid as the KPIs so the tiles line up; equal height via stretch. */}
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-5">
            <div className="min-w-0 lg:col-span-3">
              <RevenueTrendChart months={months} target={rev.target} curYear={year} prevYear={year - 1} showMoney={showMoney} currentMonthIdx={curMonthIdx} />
            </div>
            <div className="min-w-0 lg:col-span-2">
              <QuotePipeline pipeline={pipelineData} activity={activity} showMoney={showMoney} />
            </div>
          </div>

          {/* Operational capacity + Today's operations — same 5-col alignment as the row above. */}
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-5">
            <Panel className="lg:col-span-3" icon={<Gauge className="size-4" />} title="Operational capacity — next 7 days" href="/risk" hrefLabel="Event Risk">
              {/* One bordered box, 7 cells with dividers, today highlighted with a grey inset (matches v3). */}
              <div className="grid grid-cols-7 rounded border border-[var(--lifted)]">
                {c.outlook.map((d, i) => {
                  const lvl = capacityLevel(d.verdict);
                  // Real crew ratio "X / Y" = drivers scheduled / needed (from the capacity scan). When no
                  // routes are needed that day, there's nothing to crew — show jobs instead of a fake ratio.
                  const hasRatio = d.driversNeeded != null && d.driversNeeded > 0 && d.driversScheduled != null;
                  const fill = hasRatio ? Math.min(100, Math.round((d.driversScheduled! / d.driversNeeded!) * 100)) : d.jobs ? 100 : 8;
                  const value = hasRatio ? `${d.driversScheduled} / ${d.driversNeeded}` : d.jobs ? String(d.jobs) : "—";
                  const monTitle = mon(d.date).charAt(0) + mon(d.date).slice(1).toLowerCase();
                  return (
                    <div key={d.date} className={`py-2 text-center ${i < 6 ? "border-r border-[var(--lifted)]" : ""} ${d.isToday ? "rounded-l-[3px] bg-[var(--row)] shadow-[inset_0_0_0_1px_var(--bar)]" : ""}`}>
                      <div className="text-[12px] uppercase tracking-[0.06em] text-secondary-text">{dow(d.date)}</div>
                      <div className="mt-0.5 text-[12px] tabular-nums text-muted-foreground">{monTitle} {dnum(d.date)}</div>
                      <div className="mt-1.5 text-[13.5px] font-medium tabular-nums">{value}</div>
                      <div className="mx-2.5 mt-1.5 h-[5px] rounded-[3px] bg-[var(--border)]" title={d.verdict ?? "available"}>
                        <span className="block h-full rounded-[3px]" style={{ width: `${fill}%`, background: CAP_HEX[lvl] }} />
                      </div>
                    </div>
                  );
                })}
              </div>
              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 px-0.5 text-[11px] text-meta">
                <span>Crews booked / available</span>
                <span className="flex items-center gap-1.5"><span className="h-[3px] w-2" style={{ background: CAP_HEX.NORMAL }} /> open</span>
                <span className="flex items-center gap-1.5"><span className="h-[3px] w-2" style={{ background: CAP_HEX.TIGHT }} /> tight</span>
                <span className="flex items-center gap-1.5"><span className="h-[3px] w-2" style={{ background: CAP_HEX.CONSTRAINED }} /> at limit</span>
              </div>
            </Panel>
            <Panel className="lg:col-span-2" icon={<Truck className="size-4" />} title="Today's operations" scope={WIDGET_SCOPE.todaysOps.scope} href="/dispatch" hrefLabel="Routes">
              {hasOpsToday ? (
                <>
                  <div className="mb-3"><TodayMap /></div>
                  <TodayOps ops={c.today_ops} showMoney={showMoney} />
                </>
              ) : (
                <TodayOpsEmpty ops={c.today_ops} nextOpDay={nextOpDay} showMoney={showMoney} />
              )}
            </Panel>
          </div>

        </div>

        {/* ── RIGHT RAIL (486px): AI sessions / upcoming events ── */}
        <div className="space-y-3 min-w-0">
          {/* AI Sessions (LIVE) — a compact summary that links to the full AI Command Center */}
          <Panel icon={<Bot className="size-4" />} title="AI sessions" scope={WIDGET_SCOPE.aiSessions.scope} href="/ai-command" hrefLabel="View all"
            chip={aiOverview && aiOverview.liveCount > 0 ? <span className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-positive"><span className="size-1.5 rounded-full bg-positive" /> {aiOverview.liveCount} live</span> : undefined}>
            {aiSessions.length === 0 ? (
              <p className="text-[12px] text-meta">No AI sessions yet. <Link href="/ai-command" className="text-tertiary-text hover:text-foreground">Open the AI Command Center →</Link></p>
            ) : (
              <div className="space-y-0.5">
                {aiSessions.slice(0, 5).map((s) => {
                  const m = STATUS_META[s.status];
                  return (
                    <Link key={s.id} href={`/ai-command/${s.id}`} className="flex items-center gap-2 rounded px-1.5 py-2 transition-colors hover:bg-[var(--row-hover)]">
                      <span className={`size-2 shrink-0 rounded-full ${m.dot}`} aria-hidden />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[12px] font-medium text-foreground">{s.title}</span>
                        <span className="block truncate text-[10.5px] text-meta">{s.blade ?? "—"}</span>
                      </span>
                      <span className="shrink-0 text-right">
                        <span className={`block text-[10.5px] font-medium ${m.text}`}>{m.label}</span>
                        <span className="block text-[10px] text-meta">{ago(s.updatedAt)}</span>
                      </span>
                    </Link>
                  );
                })}
              </div>
            )}
          </Panel>

          {/* Upcoming events — the one widget that follows the global selector (event-date horizon). */}
          <Panel icon={<CalendarDays className="size-4" />} title={upcomingTitle} href="/sales" hrefLabel="View all">
            {upcoming.length === 0 ? (
              <p className="text-[12px] text-meta">No booked events {win.label === "today" ? "today" : `in the ${win.label}`}.</p>
            ) : (
              <div className="space-y-0.5">
                {upcoming.map((b) => (
                  <div key={b.bookingId} className="flex items-center gap-2.5 rounded px-1.5 py-1.5 hover:bg-[var(--row-hover)]">
                    <span className="flex w-11 shrink-0 flex-col items-center rounded border border-border py-0.5">
                      <span className="text-[9px] uppercase tracking-wide text-meta">{mon(b.eventDate!)}</span>
                      <span className="text-[14px] font-semibold tabular-nums leading-none">{dnum(b.eventDate!)}</span>
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[12px] font-medium text-foreground">{b.eventName || b.clientName}</span>
                      <span className="block truncate text-[10.5px] text-meta">{b.location || b.venue || b.clientName}</span>
                    </span>
                    <span className={`size-1.5 shrink-0 rounded-full ${b.signed ? "bg-positive" : "bg-attention"}`} aria-hidden title={b.signed ? "signed" : "open"} />
                  </div>
                ))}
              </div>
            )}
          </Panel>

        </div>
      </div>

      {/* Bottom row (full width, matches v3) — needs attention / top opportunities / next actions */}
      <div className="mt-3 grid grid-cols-1 gap-3 lg:[grid-template-columns:minmax(0,1fr)_minmax(0,1.15fr)_minmax(0,1fr)]" id="attention">
        <Panel icon={<Radar className="size-4" />} title="Needs attention" scope={WIDGET_SCOPE.needsAttention.scope} href="/ops" hrefLabel="Ops" badge={attention.length || undefined}>
          {attention.length === 0 ? (
            <p className="text-[12.5px] text-positive">All operations are on track.</p>
          ) : (
            <div className="space-y-1">
              {attention.slice(0, 5).map((i) => {
                const reason = i.detail?.split("→")[0].trim();
                const action = i.detail?.split("→")[1]?.trim();
                return (
                  <Link key={i.key} href={i.href} className="flex items-start gap-2.5 rounded px-1.5 py-2 transition-colors hover:bg-[var(--row-hover)]">
                    <span className={`mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide ${SEV_TAG[i.priority]}`}>{SEV_LABEL[i.priority]}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[12.5px] font-medium text-foreground">{i.title}</span>
                      {reason && <span className="block truncate text-[11px] text-muted-foreground">{reason}</span>}
                      {action && <span className="mt-0.5 inline-flex items-center gap-0.5 text-[11px] font-medium text-[#9fb6e6]">{action} <ArrowRight className="size-3" /></span>}
                    </span>
                  </Link>
                );
              })}
            </div>
          )}
        </Panel>
        <Panel icon={<Lightbulb className="size-4" />} title="Top opportunities" scope={WIDGET_SCOPE.topOpportunities.scope} href="/salesos" hrefLabel="Sales OS"
          chip={<span className="inline-flex items-center gap-1 rounded border border-[var(--gold)]/40 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-[var(--gold)]"><Bot className="size-3" /> AI recommends</span>}>
          {!salesQ || salesQ.items.length === 0 ? (
            <p className="text-[12.5px] text-meta">{showMoney ? "No open opportunities ranked right now." : "Hidden for your role."}</p>
          ) : (
            <div className="space-y-0.5">
              {salesQ.items.slice(0, 5).map((it, idx) => (
                <div key={it.id} className="flex items-center gap-2.5 rounded px-1.5 py-1.5 hover:bg-[var(--row-hover)]">
                  <span className="w-4 shrink-0 text-center text-[11px] tabular-nums text-meta">{idx + 1}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[12.5px] font-medium text-foreground">{it.eventName || it.clientName}</span>
                    <span className="block truncate text-[11px] text-muted-foreground">{it.stateLabel}{it.daysToEvent != null ? ` · in ${it.daysToEvent}d` : ""}</span>
                  </span>
                  <span className="shrink-0 text-[12px] font-semibold tabular-nums text-[var(--gold)]">{moneyK(it.value)}</span>
                  <Link href={`/salesos/${it.id}`} className="shrink-0 rounded border border-[var(--gold)]/50 px-2 py-0.5 text-[11px] font-medium text-[var(--gold)] transition-colors hover:bg-[var(--gold)]/10">
                    {NBA_LABEL[it.nba.action] ?? "Open"}
                  </Link>
                </div>
              ))}
            </div>
          )}
        </Panel>
        <Panel icon={<ListChecks className="size-4" />} title="Next actions" scope={WIDGET_SCOPE.nextActions.scope} href="/ops" hrefLabel="View all">
          {nextActions.length === 0 ? (
            <p className="text-[12px] text-positive">Nothing needs you right now.</p>
          ) : (
            <div className="space-y-0.5">
              {nextActions.map((a) => (
                <Link key={a.key} href={a.href} className="flex items-center gap-2.5 rounded px-1.5 py-2 transition-colors hover:bg-[var(--row-hover)]">
                  <ActionIcon text={a.text} />
                  <span className="min-w-0 flex-1 truncate text-[12px] text-foreground">{a.text}</span>
                  <span className={`size-1.5 shrink-0 rounded-full ${P_DOT[a.priority]}`} aria-hidden />
                </Link>
              ))}
            </div>
          )}
        </Panel>
      </div>
    </main>
  );
}

function safe<T>(fn: () => T, fallback: T): T {
  try { return fn(); } catch { return fallback; }
}
function pctDelta(cur: number | null, prevV: number | null): { pct: number; up: boolean } | null {
  if (cur == null || prevV == null || prevV <= 0) return null;
  const pct = Math.round(((cur - prevV) / prevV) * 100);
  return { pct: Math.abs(pct), up: pct >= 0 };
}

// ── Panels + KPI ─────────────────────────────────────────────────────────────

function Panel({ icon, title, scope, href, hrefLabel, children, className, badge, chip }: { icon: React.ReactNode; title: string; scope?: string; href?: string; hrefLabel?: string; children: React.ReactNode; className?: string; badge?: number; chip?: React.ReactNode }): React.JSX.Element {
  return (
    <section className={`surface flex flex-col border p-3 ${className ?? ""}`}>
      <div className="mb-3 flex items-center gap-2">
        <h2 className="flex items-center gap-1.5 text-[11.5px] font-semibold uppercase tracking-[0.06em] text-tertiary-text">{icon} {title}</h2>
        {badge != null && <span className="rounded bg-critical/15 px-1.5 py-0.5 text-[10px] font-bold tabular-nums text-critical">{badge}</span>}
        {/* Data-scope tag — every widget states its business time horizon (widgetScope.ts). */}
        {scope && <span className="rounded bg-[var(--row-hover)] px-1.5 py-0.5 text-[9px] uppercase tracking-[0.08em] text-meta">{scope}</span>}
        {chip}
        {href && hrefLabel && <Link href={href} className="ml-auto inline-flex items-center gap-0.5 text-[11px] text-meta transition-colors hover:text-foreground">{hrefLabel} <ArrowRight className="size-3" /></Link>}
      </div>
      {children}
    </section>
  );
}

// Needs-attention severity labels + tag colors (priority → user-facing severity).
const SEV_LABEL: Record<Priority, string> = { critical: "Critical", high: "High", medium: "Medium", info: "Low" };
const SEV_TAG: Record<Priority, string> = {
  critical: "bg-critical/15 text-critical",
  high: "bg-attention/15 text-attention",
  medium: "bg-attention/10 text-attention",
  info: "bg-[var(--row-hover)] text-meta",
};

type KpiVisual =
  | { kind: "progress"; pct: number | null; color: string; inlineLabel?: string }
  | { kind: "spark"; data: (number | null)[]; color: string }
  | { kind: "bars"; data: (number | null)[]; color: string; recentColor?: string }
  | { kind: "severity"; crit: number; high: number; med: number; low: number };

// KPI card (v3 handoff): label → big number → sub, with the visual (spark / bars / progress) full-width at
// the BOTTOM, then an optional footnote. The bottom group is pushed down so visuals align across the row.
function Kpi({ icon, label, big, sub, tone, visual, footnote, href }: {
  icon: React.ReactNode; label: string; big: string; sub?: string; tone?: "good" | "bad" | "warn";
  visual?: KpiVisual; footnote?: { text: string; tone?: "good" | "bad" | "meta" }; href?: string;
}): React.JSX.Element {
  const bigTone = tone === "bad" ? "text-critical" : tone === "good" ? "text-positive" : "text-foreground";
  const footTone = footnote?.tone === "bad" ? "text-critical" : footnote?.tone === "good" ? "text-positive" : "text-meta";
  const body = (
    <div className="flex h-full flex-col">
      <div className="mb-1.5 flex items-center gap-1.5 text-[10px] uppercase tracking-[0.1em] text-meta">{icon} {label}</div>
      <div className={`text-[26px] font-semibold leading-none tabular-nums ${bigTone}`}>{big}</div>
      {sub && <div className="mt-1.5 truncate text-[11.5px] text-meta">{sub}</div>}
      {(visual || footnote) && (
        <div className="mt-auto pt-3">
          {visual && renderKpiVisual(visual)}
          {footnote && <div className={`mt-2 text-[11.5px] tabular-nums ${footTone}`}>{footnote.text}</div>}
        </div>
      )}
    </div>
  );
  return href ? <Link href={href} className="surface block border p-3 transition-colors hover:border-foreground/20">{body}</Link> : <div className="surface border p-3">{body}</div>;
}

function renderKpiVisual(v: KpiVisual): React.JSX.Element {
  if (v.kind === "progress") {
    return (
      <div className="flex items-center gap-2">
        <div className="h-[7px] flex-1 rounded-[1px]" style={{ background: KPI_C.track }}>
          <div className="h-full rounded-[1px]" style={{ width: `${Math.min(100, Math.max(0, v.pct ?? 0))}%`, background: v.color }} />
        </div>
        {v.inlineLabel && <span className="shrink-0 text-[11.5px] tabular-nums text-secondary-text">{v.inlineLabel}</span>}
      </div>
    );
  }
  if (v.kind === "spark") return <KpiSpark data={v.data} color={v.color} />;
  if (v.kind === "bars") return <KpiBars data={v.data} color={v.color} recentColor={v.recentColor ?? v.color} />;
  // severity — a thin stacked bar from the real attention counts.
  const total = v.crit + v.high + v.med + v.low;
  const segs = [{ n: v.crit, c: KPI_C.red }, { n: v.high, c: KPI_C.amber }, { n: v.med, c: "#8f8a5e" }, { n: v.low, c: "#3f424d" }];
  return (
    <div className="flex h-[7px] w-full gap-[2px] overflow-hidden rounded-[1px]" style={{ background: KPI_C.track }}>
      {total > 0 && segs.filter((s) => s.n > 0).map((s, i) => <span key={i} className="h-full" style={{ width: `${(s.n / total) * 100}%`, background: s.c }} />)}
    </div>
  );
}

function KpiSpark({ data, color }: { data: (number | null)[]; color: string }): React.JSX.Element {
  const vals = data.map((v) => v ?? 0);
  const max = Math.max(...vals, 1);
  const n = vals.length;
  const pts = vals.map((v, i) => `${(i / Math.max(1, n - 1)) * 120},${(30 - (v / max) * 26 - 2).toFixed(1)}`);
  const id = `kg-${color.replace("#", "")}`;
  return (
    <svg viewBox="0 0 120 30" preserveAspectRatio="none" className="block h-[30px] w-full" aria-hidden>
      <defs><linearGradient id={id} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor={color} stopOpacity={0.28} /><stop offset="1" stopColor={color} stopOpacity={0} /></linearGradient></defs>
      <path d={`M0 30 ${pts.map((p) => "L" + p).join(" ")} L120 30 Z`} fill={`url(#${id})`} />
      <polyline points={pts.join(" ")} fill="none" stroke={color} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function KpiBars({ data, color, recentColor }: { data: (number | null)[]; color: string; recentColor: string }): React.JSX.Element {
  const vals = data.map((v) => v ?? 0);
  const max = Math.max(...vals, 1);
  const n = vals.length;
  return (
    <div className="flex h-[30px] items-end gap-[3px]">
      {vals.map((v, i) => (
        <span key={i} className="flex-1 rounded-t-[1px]" style={{ height: `${Math.max(2, (v / max) * 30).toFixed(1)}px`, background: i >= n - 3 ? recentColor : color }} />
      ))}
    </div>
  );
}

// Today's Operations EMPTY state — shown instead of a giant empty map when nothing is dispatched today.
// Compact counts + the next operational day, so the panel doesn't waste the space an active map would use.
function TodayOpsEmpty({ ops, nextOpDay, showMoney }: { ops: { events: number; activeRoutes: number; driversAssigned: number; scheduledRevenue: number | null }; nextOpDay: { date: string; count: number } | null; showMoney: boolean }): React.JSX.Element {
  const headline = ops.events > 0 ? `${plural(ops.events, "event")} booked — not dispatched.` : "No routes scheduled today.";
  const monTitle = nextOpDay ? mon(nextOpDay.date).charAt(0) + mon(nextOpDay.date).slice(1).toLowerCase() : "";
  return (
    <div className="space-y-3">
      <p className="text-[12.5px] text-meta">{headline}</p>
      <div className="grid grid-cols-2 gap-x-4 gap-y-2.5">
        <OpStat n={ops.events} label="Events" />
        <OpStat n={ops.activeRoutes} label="Routes" />
        <OpStat n={ops.driversAssigned} label="Drivers" />
        {showMoney && (
          <div className="flex items-baseline gap-2">
            <span className="text-[20px] font-semibold tabular-nums text-foreground">{money(ops.scheduledRevenue ?? 0)}</span>
            <span className="text-[11.5px] text-meta">Scheduled</span>
          </div>
        )}
      </div>
      {nextOpDay && (
        <div className="border-t border-rule pt-3">
          <div className="text-[10px] uppercase tracking-[0.08em] text-meta">Next operational day</div>
          <div className="mt-1 flex items-baseline gap-2">
            <span className="text-[14px] font-semibold tabular-nums text-foreground">{monTitle} {dnum(nextOpDay.date)}</span>
            <span className="text-[12px] text-meta">{plural(nextOpDay.count, "event")}</span>
          </div>
        </div>
      )}
    </div>
  );
}

function TodayOps({ ops, showMoney }: { ops: { events: number; activeRoutes: number; stops: number; completed: number; inProgress: number; remaining: number; driversAssigned: number; exceptions: number; scheduledRevenue: number | null }; showMoney: boolean }): React.JSX.Element {
  const onTime = Math.max(0, ops.completed + ops.inProgress - ops.exceptions);
  return (
    <div className="flex h-full flex-col justify-between gap-3">
      {ops.stops === 0 && ops.events > 0 ? (
        <div className="flex items-center gap-2 text-[12.5px]">
          <span className="inline-flex items-center gap-1.5 rounded border border-attention/40 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-attention"><AlertTriangle className="size-3" /> Not dispatched</span>
          <span className="text-muted-foreground">{plural(ops.events, "event")} booked.</span>
        </div>
      ) : ops.stops === 0 ? (
        <p className="text-[12.5px] text-meta">No stops scheduled today.</p>
      ) : (
        <div className="space-y-2">
          <div className="flex h-2 w-full overflow-hidden rounded-full bg-[var(--row-hover)]">
            <div className="bg-positive" style={{ width: `${(ops.completed / ops.stops) * 100}%` }} />
            <div className="bg-[var(--bar-2)]" style={{ width: `${(ops.inProgress / ops.stops) * 100}%` }} />
            <div className="bg-white/10" style={{ width: `${(ops.remaining / ops.stops) * 100}%` }} />
          </div>
          <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
            <span>{ops.completed} done</span><span>{ops.inProgress} active</span><span>{ops.remaining} left</span>
          </div>
        </div>
      )}
      <div className="grid grid-cols-2 gap-2 border-t border-rule pt-3">
        <OpStat n={ops.activeRoutes} label="Active routes" />
        <OpStat n={onTime} label="On time" tone="good" />
        <OpStat n={ops.driversAssigned} label="Drivers" />
        <OpStat n={ops.exceptions} label="At risk" tone={ops.exceptions > 0 ? "bad" : "default"} />
      </div>
      {showMoney && ops.scheduledRevenue != null && (
        <div className="flex items-center justify-between border-t border-rule pt-2 text-[12.5px]">
          <span className="text-meta">Scheduled revenue today</span>
          <span className="font-semibold tabular-nums text-positive">{money(ops.scheduledRevenue)}</span>
        </div>
      )}
    </div>
  );
}

function OpStat({ n, label, tone = "default" }: { n: number; label: string; tone?: "good" | "bad" | "default" }): React.JSX.Element {
  const t = tone === "good" ? "text-positive" : tone === "bad" ? "text-critical" : "text-foreground";
  return (
    <div className="flex items-baseline gap-2">
      <span className={`text-[20px] font-semibold tabular-nums ${t}`}>{n}</span>
      <span className="text-[11.5px] text-meta">{label}</span>
    </div>
  );
}

function ActionIcon({ text }: { text: string }): React.JSX.Element {
  const t = text.toLowerCase();
  const cls = "size-3.5 shrink-0 text-meta";
  if (t.includes("call")) return <Phone className={cls} />;
  if (t.includes("email") || t.includes("quote")) return <Mail className={cls} />;
  if (t.includes("staff") || t.includes("crew") || t.includes("driver")) return <Users className={cls} />;
  if (t.includes("route") || t.includes("truck") || t.includes("eta")) return <Truck className={cls} />;
  if (t.includes("marketing") || t.includes("post")) return <Megaphone className={cls} />;
  return <CircleDot className={cls} />;
}
