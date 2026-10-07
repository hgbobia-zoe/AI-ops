// Zoe Operations Command Center — the business operations control tower. A dense, gold-accented cockpit:
// KPI row with sparklines, revenue performance, quote status, operational capacity, today's operations,
// needs-attention, AI-recommended top opportunities, plus a right rail (live AI sessions that links out to
// the AI Command Center, upcoming events, next actions). Everything reads existing services; nothing is
// fabricated — an unresolved value is "—" and says so. Money is Owner/Admin only. Separate from the AI
// Command Center (/ai-command), which operates the AI; this is the business dashboard.

import Link from "next/link";
import {
  AlertTriangle, ArrowRight, DollarSign, FileText, CalendarCheck, ShieldAlert, Truck, TrendingUp,
  PieChart, Gauge, Radar, Lightbulb, ListChecks, Bot, CalendarDays, CircleDot, Phone, Mail, Users, Megaphone, MapPin,
  Search, Bell, ChevronDown, Plus,
} from "lucide-react";
import { AutoRefresh } from "@/components/AutoRefresh";
import { commandCenter } from "@/lib/command/service";
import { capacityLevel, type CapacityLevel } from "@/lib/command/calc";
import { salesYearOverview } from "@/lib/sales/service";
import { salesCommandCenter } from "@/lib/salesos/commandCenter";
import { getPipelineBookingsInRange, type BookingView } from "@/lib/db/repo";
import { aiControlOverview } from "@/lib/ai/control";
import { listRecentSessions } from "@/lib/ai/sessions";
import { STATUS_META } from "@/lib/ai/sessionDisplay";
import { formatYmdLong, shiftYmd } from "@/lib/dates";
import { viewerRole, currentActor } from "@/lib/auth/getSession";
import { canSeeFinancials } from "@/lib/auth/roles";
import type { Priority } from "@/lib/ops/manager";
import { RevenueTrendChart, type MonthPoint } from "@/components/dashboard/RevenueTrendChart";
import { TodayMap } from "@/components/dashboard/TodayMap";

export const dynamic = "force-dynamic";

const money = (n: number | null | undefined): string => (n == null ? "—" : "$" + Math.round(n).toLocaleString("en-US"));
const moneyK = (n: number | null | undefined): string => {
  if (n == null) return "—";
  return Math.abs(n) >= 1000 ? "$" + (Math.round(n / 100) / 10).toLocaleString("en-US") + "K" : "$" + Math.round(n).toLocaleString("en-US");
};
const plural = (n: number, w: string): string => `${n} ${w}${n === 1 ? "" : "s"}`;

const P_DOT: Record<Priority, string> = { critical: "bg-critical", high: "bg-attention", medium: "bg-attention/70", info: "bg-[var(--bar)]" };
const CAP_BAR: Record<CapacityLevel, string> = { NORMAL: "bg-positive/70", TIGHT: "bg-attention/80", CONSTRAINED: "bg-critical/80", UNVERIFIED: "bg-[var(--bar)]" };
const NBA_LABEL: Record<string, string> = {
  CALL_NOW: "Call", SEND_SMS: "Text", FOLLOW_UP: "Follow up", ASK_DISCOVERY: "Discover", HANDLE_OBJECTION: "Respond",
  VERIFY_AVAILABILITY: "Verify", REVIEW_QUOTE: "Review", WAIT: "View",
};

type RangeKey = "today" | "7d" | "30d" | "90d" | "year";
const RANGES: { key: RangeKey; label: string }[] = [
  { key: "today", label: "Today" }, { key: "7d", label: "7D" }, { key: "30d", label: "30D" }, { key: "90d", label: "90D" }, { key: "year", label: "2026" },
];
function rangeWindow(key: RangeKey, today: string, year: number): { start: string; end: string; label: string } {
  switch (key) {
    case "7d": return { start: today, end: shiftYmd(today, 6), label: "next 7 days" };
    case "30d": return { start: today, end: shiftYmd(today, 29), label: "next 30 days" };
    case "90d": return { start: today, end: shiftYmd(today, 89), label: "next 90 days" };
    case "year": return { start: `${year}-01-01`, end: `${year}-12-31`, label: String(year) };
    default: return { start: today, end: today, label: "today" };
  }
}

function dow(ymd: string): string { return new Date(`${ymd}T00:00:00Z`).toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" }); }
function dnum(ymd: string): string { return new Date(`${ymd}T00:00:00Z`).toLocaleDateString("en-US", { day: "numeric", timeZone: "UTC" }); }
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
  const upcoming = safe(() => getPipelineBookingsInRange(win.start, win.end), [] as BookingView[])
    .filter((b) => b.eventDate)
    .sort((a, b) => (a.eventDate! < b.eventDate! ? -1 : 1))
    .slice(0, 8);
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

  // KPI sparkline/delta helpers from current-year months.
  const curMonthIdx = Number(today.slice(5, 7)) - 1;
  const revSeries = curM.map((m) => m.signedRevenue);
  const quoteSeries = curM.map((m) => (m.actionNeededCount ? m.actionNeededCount : null));
  const eventBars = curM.map((m) => m.count);
  const revDelta = pctDelta(curM[curMonthIdx]?.signedRevenue ?? null, curM[curMonthIdx - 1]?.signedRevenue ?? null);
  const eventDelta = pctDelta(curM[curMonthIdx]?.count ?? null, curM[curMonthIdx - 1]?.count ?? null);

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
  const pipe = c.pipeline;

  return (
    <main className="mx-auto max-w-[1500px] p-4 pb-16 leading-[1.3] md:p-5">
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

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-12">
        {/* ── LEFT: business cockpit ── */}
        <div className="space-y-4 xl:col-span-9">
          {/* KPI row */}
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-5">
            {showMoney ? (
              <Kpi icon={<DollarSign className="size-3.5" />} label={`Revenue (${rev.periodLabel.slice(0, 3)})`} big={money(rev.committed)}
                sub={rev.target != null ? `Target ${money(rev.target)}` : "no target set"}
                barPct={rev.pctOfTarget} barLabel={rev.pctOfTarget != null ? `${rev.pctOfTarget}%` : undefined} delta={revDelta} spark={revSeries} />
            ) : (
              <Kpi icon={<CalendarCheck className="size-3.5" />} label="Events today" big={String(c.today_ops.events)} sub="scheduled" spark={null} />
            )}
            <Kpi icon={<FileText className="size-3.5" />} label="Quotes" big={String(pipe.quote.count)}
              sub={`${pipe.quote.count} open · ${pipe.signed.count} signed`} spark={quoteSeries} />
            <Kpi icon={<CalendarCheck className="size-3.5" />} label="Booked events" big={String(bookedThisMonth)}
              sub="This month" delta={eventDelta} bars={eventBars} />
            <Kpi icon={<ShieldAlert className="size-3.5" />} label="Operational risks" big={String(crit + high + med + low)}
              sub={riskSub} tone={crit ? "bad" : high || med ? "warn" : "good"} spark={null} href="#attention" />
            <Kpi icon={<Truck className="size-3.5" />} label="Fleet & crew" big={`${c.today_ops.trucksUsed} / ${c.today_ops.fleetSize}`}
              sub="Active today" barPct={util} barLabel={util != null ? `${util}% utilization` : undefined} spark={null} />
          </div>

          {/* Revenue performance + Quote status */}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
            <Panel className="lg:col-span-8" icon={<TrendingUp className="size-4" />} title="Revenue performance" href="/sales" hrefLabel="Sales">
              <RevenueTrendChart months={months} target={rev.target} curYear={year} prevYear={year - 1} showMoney={showMoney} />
            </Panel>
            <Panel className="lg:col-span-4" icon={<PieChart className="size-4" />} title="Quote status" href="/salesos" hrefLabel="Sales OS">
              <QuoteDonut signed={pipe.signed.count} open={pipe.quote.count} lost={pipe.lost.count} />
            </Panel>
          </div>

          {/* Operational capacity + Today's operations */}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
            <Panel className="lg:col-span-8" icon={<Gauge className="size-4" />} title="Operational capacity — next 7 days" href="/risk" hrefLabel="Event Risk">
              <div className="grid grid-cols-7 gap-1.5">
                {c.outlook.map((d) => {
                  const lvl = capacityLevel(d.verdict);
                  // Real crew ratio "X/Y" = drivers scheduled / needed (from the capacity scan). When no
                  // routes are needed that day, there's nothing to crew — show jobs instead of a fake ratio.
                  const hasRatio = d.driversNeeded != null && d.driversNeeded > 0 && d.driversScheduled != null;
                  const fill = hasRatio ? Math.min(100, Math.round((d.driversScheduled! / d.driversNeeded!) * 100)) : d.jobs ? 100 : 8;
                  return (
                    <div key={d.date} className={`flex flex-col items-center gap-1 rounded border p-2 ${d.isToday ? "border-[var(--gold)]/40 bg-[var(--gold)]/[0.04]" : "border-border"}`}>
                      <span className="text-[10px] uppercase tracking-wide text-meta">{dow(d.date)}</span>
                      <span className="text-[11px] tabular-nums text-tertiary-text">{mon(d.date)} {dnum(d.date)}</span>
                      <span className="text-[16px] font-semibold tabular-nums">{hasRatio ? `${d.driversScheduled}/${d.driversNeeded}` : d.jobs || "—"}</span>
                      <span className="text-[9px] uppercase tracking-wide text-meta">{hasRatio ? "crew" : d.jobs ? "jobs" : "open"}</span>
                      <span className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--row-hover)]" aria-hidden title={d.verdict ?? "available"}>
                        <span className={`block h-full rounded-full ${CAP_BAR[lvl]}`} style={{ width: `${fill}%` }} />
                      </span>
                    </div>
                  );
                })}
              </div>
            </Panel>
            <Panel className="lg:col-span-4" icon={<Truck className="size-4" />} title="Today's operations" href="/dispatch" hrefLabel="Routes">
              <div className="mb-3"><TodayMap /></div>
              <TodayOps ops={c.today_ops} showMoney={showMoney} />
            </Panel>
          </div>

          {/* Needs attention + Top opportunities */}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-12" id="attention">
            <Panel className="lg:col-span-5" icon={<Radar className="size-4" />} title="Needs attention" href="/ops" hrefLabel="Ops" badge={attention.length || undefined}>
              {attention.length === 0 ? (
                <p className="text-[12.5px] text-positive">All operations are on track.</p>
              ) : (
                <div className="space-y-1.5">
                  {attention.slice(0, 5).map((i) => (
                    <Link key={i.key} href={i.href} className="flex items-center gap-2.5 rounded px-1.5 py-2 transition-colors hover:bg-[var(--row-hover)]">
                      <span className={`size-2 shrink-0 rounded-full ${P_DOT[i.priority]}`} aria-hidden />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[12.5px] font-medium text-foreground">{i.title}</span>
                        {i.detail && <span className="block truncate text-[11px] text-muted-foreground">{i.detail.split("→")[0].trim()}</span>}
                      </span>
                      <ArrowRight className="size-3.5 shrink-0 text-meta" />
                    </Link>
                  ))}
                </div>
              )}
            </Panel>
            <Panel className="lg:col-span-7" icon={<Lightbulb className="size-4" />} title="Top opportunities" href="/salesos" hrefLabel="Sales OS"
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
          </div>
        </div>

        {/* ── RIGHT RAIL: AI sessions / upcoming events / next actions ── */}
        <div className="space-y-4 xl:col-span-3">
          {/* AI Sessions (LIVE) — a compact summary that links to the full AI Command Center */}
          <Panel icon={<Bot className="size-4" />} title="AI sessions" href="/ai-command" hrefLabel="View all"
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

          {/* Upcoming events — window follows the range tabs */}
          <Panel icon={<CalendarDays className="size-4" />} title="Upcoming events" href="/sales" hrefLabel="View all"
            chip={<span className="text-[10px] uppercase tracking-wide text-meta">{win.label}</span>}>
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

          {/* Next actions */}
          <Panel icon={<ListChecks className="size-4" />} title="Next actions" href="/ops" hrefLabel="View all">
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

function Panel({ icon, title, href, hrefLabel, children, className, badge, chip }: { icon: React.ReactNode; title: string; href?: string; hrefLabel?: string; children: React.ReactNode; className?: string; badge?: number; chip?: React.ReactNode }): React.JSX.Element {
  return (
    <section className={`surface flex flex-col border p-3.5 ${className ?? ""}`}>
      <div className="mb-3 flex items-center gap-2">
        <h2 className="flex items-center gap-1.5 text-[11.5px] font-semibold uppercase tracking-[0.06em] text-tertiary-text">{icon} {title}</h2>
        {badge != null && <span className="rounded bg-critical/15 px-1.5 py-0.5 text-[10px] font-bold tabular-nums text-critical">{badge}</span>}
        {chip}
        {href && hrefLabel && <Link href={href} className="ml-auto inline-flex items-center gap-0.5 text-[11px] text-meta transition-colors hover:text-foreground">{hrefLabel} <ArrowRight className="size-3" /></Link>}
      </div>
      {children}
    </section>
  );
}

function Kpi({ icon, label, big, sub, barPct, barLabel, delta, spark, bars, tone, href }: {
  icon: React.ReactNode; label: string; big: string; sub?: string; barPct?: number | null; barLabel?: string;
  delta?: { pct: number; up: boolean } | null; spark?: (number | null)[] | null; bars?: (number | null)[]; tone?: "good" | "bad" | "warn"; href?: string;
}): React.JSX.Element {
  const bigTone = tone === "bad" ? "text-critical" : tone === "good" ? "text-positive" : "text-foreground";
  const body = (
    <>
      <div className="mb-1 flex items-center gap-1.5 text-[10px] uppercase tracking-[0.1em] text-meta">{icon} {label}</div>
      <div className="flex items-end justify-between gap-2">
        <div className={`text-[26px] font-semibold leading-none tabular-nums ${bigTone}`}>{big}</div>
        {spark && spark.some((v) => v != null) && <Spark data={spark} />}
        {bars && bars.some((v) => (v ?? 0) > 0) && <MiniBars data={bars} />}
      </div>
      {sub && <div className="mt-1.5 truncate text-[11px] text-meta">{sub}</div>}
      {barPct != null && (
        <div className="mt-2 flex items-center gap-2">
          <div className="h-1 flex-1 overflow-hidden rounded-full bg-[var(--row-hover)]">
            <div className="h-full bg-[var(--gold)]" style={{ width: `${Math.min(100, Math.max(0, barPct))}%` }} />
          </div>
          {barLabel && <span className="shrink-0 text-[10.5px] tabular-nums text-tertiary-text">{barLabel}</span>}
        </div>
      )}
      {delta && (
        <div className="mt-1.5 text-[11px]">
          <span className={`tabular-nums ${delta.up ? "text-positive" : "text-critical"}`}>{delta.up ? "▲" : "▼"} {delta.pct}% <span className="text-meta">vs last month</span></span>
        </div>
      )}
    </>
  );
  return href ? <Link href={href} className="surface block border p-3 transition-colors hover:border-foreground/20">{body}</Link> : <div className="surface border p-3">{body}</div>;
}

function Spark({ data }: { data: (number | null)[] }): React.JSX.Element {
  const vals = data.map((v) => v ?? 0);
  const max = Math.max(...vals, 1);
  const W = 64, H = 26;
  const step = W / Math.max(1, data.length - 1);
  const pts = vals.map((v, i) => `${i * step},${H - (v / max) * (H - 3) - 1}`);
  const lastIdx = vals.length - 1;
  const lx = lastIdx * step, ly = H - (vals[lastIdx] / max) * (H - 3) - 1;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} className="shrink-0" aria-hidden>
      <polyline points={`0,${H} ${pts.join(" ")} ${W},${H}`} fill="var(--gold)" fillOpacity={0.1} stroke="none" />
      <polyline points={pts.join(" ")} fill="none" stroke="var(--gold)" strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={lx} cy={ly} r={2} fill="var(--gold)" />
    </svg>
  );
}

function MiniBars({ data }: { data: (number | null)[] }): React.JSX.Element {
  const vals = data.map((v) => v ?? 0);
  const max = Math.max(...vals, 1);
  const W = 64, H = 26, n = vals.length, bw = (W / n) * 0.7;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} className="shrink-0" aria-hidden>
      {vals.map((v, i) => {
        const h = (v / max) * (H - 2);
        return <rect key={i} x={i * (W / n) + (W / n - bw) / 2} y={H - h} width={bw} height={Math.max(1, h)} rx={1} fill="var(--gold)" fillOpacity={0.8} />;
      })}
    </svg>
  );
}

function QuoteDonut({ signed, open, lost }: { signed: number; open: number; lost: number }): React.JSX.Element {
  const total = signed + open + lost;
  const segs = [
    { label: "Signed", n: signed, color: "var(--positive)" },
    { label: "Open", n: open, color: "var(--gold)" },
    { label: "Lost", n: lost, color: "var(--critical)" },
  ];
  const r = 52, cx = 60, cy = 60, C = 2 * Math.PI * r;
  let offset = 0;
  return (
    <div className="flex items-center gap-4">
      <svg viewBox="0 0 120 120" width={120} height={120} className="shrink-0 -rotate-90">
        <circle cx={cx} cy={cy} r={r} fill="none" stroke="var(--row-hover)" strokeWidth={14} />
        {total > 0 && segs.map((s) => {
          const frac = s.n / total;
          const len = frac * C;
          const el = <circle key={s.label} cx={cx} cy={cy} r={r} fill="none" stroke={s.color} strokeWidth={14} strokeDasharray={`${len} ${C - len}`} strokeDashoffset={-offset} />;
          offset += len;
          return el;
        })}
        <text x={cx} y={cy - 2} textAnchor="middle" className="rotate-90 fill-[var(--foreground)] text-[20px] font-semibold tabular-nums" transform="rotate(90 60 60)">{total}</text>
        <text x={cx} y={cy + 14} textAnchor="middle" className="fill-[var(--text-meta)] text-[8px] uppercase tracking-wide" transform="rotate(90 60 60)">Total</text>
      </svg>
      <div className="min-w-0 flex-1 space-y-2">
        {segs.map((s) => (
          <div key={s.label} className="flex items-center gap-2 text-[12.5px]">
            <span className="size-2.5 shrink-0 rounded-sm" style={{ background: s.color }} aria-hidden />
            <span className="flex-1 text-secondary-text">{s.label}</span>
            <span className="tabular-nums text-foreground">{s.n}</span>
            <span className="w-12 text-right tabular-nums text-meta">({total > 0 ? Math.round((s.n / total) * 100) : 0}%)</span>
          </div>
        ))}
      </div>
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
