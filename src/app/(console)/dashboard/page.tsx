// Zoe Operations Command Center — the owner's overview. The urgent decisions come FIRST (a prioritized
// attention queue high on the page), then a compact, scope-labelled business summary, then the business +
// operations cockpit (monthly revenue bars, the quote pipeline as readable date-bucket bars, explicit
// crew capacity), with AI activity and what's coming in a context rail. Everything reads existing
// services; nothing is fabricated — an unresolved value is "—", "live" means a real heartbeat, and every
// number states its time scope. Money is Owner/Admin only. Built on the shared Nocturne primitives.

import Link from "next/link";
import {
  AlertTriangle, ArrowRight, ShieldAlert, Truck,
  Gauge, Lightbulb, ListChecks, CalendarDays, Phone, Mail, Users, Megaphone, MapPin, CircleDot,
  Search, Bell, Plus, Bot,
} from "lucide-react";
import { AutoRefresh } from "@/components/AutoRefresh";
import { commandCenter } from "@/lib/command/service";
import {
  capacityLevel, type CapacityLevel, capacityCrewLabel, CAPACITY_LEVEL_LABEL, attentionTiming, ATTENTION_OWNER, type OutlookDay,
} from "@/lib/command/calc";
import { salesYearOverview } from "@/lib/sales/service";
import { salesCommandCenter } from "@/lib/salesos/commandCenter";
import { getPipelineBookingsInRange, getQuoteStageSnapshot, type BookingView } from "@/lib/db/repo";
import { aiControlOverview } from "@/lib/ai/control";
import { listRecentSessions } from "@/lib/ai/sessions";
import { formatYmdLong, shiftYmd } from "@/lib/dates";
import { viewerRole, currentActor } from "@/lib/auth/getSession";
import { canSeeFinancials } from "@/lib/auth/roles";
import type { Priority, AttentionItem } from "@/lib/ops/manager";
import type { Tone } from "@/lib/tone";
import { BladeMain } from "@/components/ui/layouts";
import { PageHeader } from "@/components/ui/page-header";
import { Metric } from "@/components/ui/metric";
import { StatusBadge } from "@/components/ui/status";
import { EmptyState } from "@/components/ui/states";
import { RevenueTrendChart, type MonthPoint } from "@/components/dashboard/RevenueTrendChart";
import { QuotePipeline, type PipelineBucket } from "@/components/dashboard/QuotePipeline";
import { AiActivity, type AiActivityItem } from "@/components/dashboard/AiActivity";
import { WIDGET_SCOPE } from "@/lib/command/widgetScope";
import { TodayMap } from "@/components/dashboard/TodayMap";

export const dynamic = "force-dynamic";

const money = (n: number | null | undefined): string => (n == null ? "—" : "$" + Math.round(n).toLocaleString("en-US"));
const moneyK = (n: number | null | undefined): string => {
  if (n == null) return "—";
  return Math.abs(n) >= 1000 ? "$" + (Math.round(n / 100) / 10).toLocaleString("en-US") + "K" : "$" + Math.round(n).toLocaleString("en-US");
};
const plural = (n: number, w: string): string => `${n} ${w}${n === 1 ? "" : "s"}`;
// Wall-clock read kept out of the render body (the purity lint flags a bare Date.now() there). One read
// per request; the page auto-refreshes, and AI-activity freshness is computed from this single stamp.
function nowMillis(): number { return Date.now(); }

// Vivid capacity data-viz palette (brighter than the recessive Nocturne tokens; scoped to the dashboard).
const CAP_HEX: Record<CapacityLevel, string> = { NORMAL: "#3ad492", TIGHT: "#f0c13a", CONSTRAINED: "#f06a5e", UNVERIFIED: "#3f424d" };
const NBA_LABEL: Record<string, string> = {
  CALL_NOW: "Call", SEND_SMS: "Text", FOLLOW_UP: "Follow up", ASK_DISCOVERY: "Discover", HANDLE_OBJECTION: "Respond",
  VERIFY_AVAILABILITY: "Verify", REVIEW_QUOTE: "Review", WAIT: "View",
};

// Severity → shared status tone + label. Colour lives on the indicator; the label text carries the
// distinction (High vs Medium share the amber "attention" tone, so greyscale still reads the words).
const SEV: Record<Priority, { tone: Tone; label: string }> = {
  critical: { tone: "critical", label: "Critical" },
  high: { tone: "attention", label: "High" },
  medium: { tone: "attention", label: "Medium" },
  info: { tone: "neutral", label: "Low" },
};
const SEV_DOT: Record<Priority, string> = {
  critical: "bg-status-blocked", high: "bg-status-warning", medium: "bg-status-warning", info: "bg-status-neutral",
};
const SEV_EDGE: Record<Priority, string> = {
  critical: "border-l-status-blocked", high: "border-l-status-warning", medium: "border-l-status-warning", info: "border-l-status-neutral",
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
function dow(ymd: string): string { return new Date(`${ymd}T00:00:00Z`).toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" }); }
function dnum(ymd: string): string { return new Date(`${ymd}T00:00:00Z`).toLocaleDateString("en-US", { day: "numeric", timeZone: "UTC" }); }
function daysBetween(a: string, b: string): number { return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000); }
function titleCase(s: string): string { return s.charAt(0).toUpperCase() + s.slice(1); }
function mon(ymd: string): string { return new Date(`${ymd}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", timeZone: "UTC" }).toUpperCase(); }
function monTitle(ymd: string): string { const m = mon(ymd); return m.charAt(0) + m.slice(1).toLowerCase(); }

export default async function DashboardPage({ searchParams }: { searchParams: Promise<{ range?: string }> }): Promise<React.JSX.Element> {
  const role = await viewerRole();
  const showMoney = canSeeFinancials(role);
  const actor = await currentActor();
  const firstName = actor.label.split(/[\s(]/)[0] || "Zoe";
  const c = await commandCenter();
  const rev = c.revenue;
  const year = c.year;
  const today = c.today;
  const nowMs = nowMillis();

  const sp = await searchParams;
  const range: RangeKey = (RANGES.some((r) => r.key === sp.range) ? sp.range : "today") as RangeKey;
  const win = rangeWindow(range, today, year);

  // Extra reads (existing services only) — prior-year trend, sales queue, upcoming (range-scoped), AI.
  const prev = safe(() => salesYearOverview(year - 1), null);
  const salesQ = showMoney ? safe(() => salesCommandCenter(), null) : null;
  const upcoming = safe(() => getPipelineBookingsInRange(win.start, win.end), [] as BookingView[])
    .filter((b) => b.eventDate)
    .sort((a, b) => (a.eventDate! < b.eventDate! ? -1 : 1))
    .slice(0, 6);
  const upcomingTitle = `Upcoming events — ${titleCase(win.label)}`;
  const aiOverview = safe(() => aiControlOverview(), null);
  // AI activity reads the recent (non-archived) sessions and classifies freshness honestly in the UI —
  // NOT the raw status-only liveCount (which counted 14-day-stale sessions as "live").
  const aiSessionsRaw = aiOverview?.recent ?? safe(() => listRecentSessions(30), []);
  const aiItems: AiActivityItem[] = aiSessionsRaw.map((s) => ({ id: s.id, title: s.title, blade: s.blade, status: s.status, updatedAt: s.updatedAt }));

  // Monthly trend points (current + prior year).
  const curM = c.sales.months;
  const prevM = prev?.months ?? [];
  const months: MonthPoint[] = curM.map((m, i) => ({
    label: m.label,
    revenue: { cur: m.signedRevenue, prev: prevM[i]?.signedRevenue ?? null },
    quotes: { cur: m.count || null, prev: prevM[i]?.count || null },
    events: { cur: m.signedCount || null, prev: prevM[i]?.signedCount || null },
  }));

  const curMonthIdx = Number(today.slice(5, 7)) - 1;
  const monthName = rev.periodLabel; // "October" — the MTD revenue/booked month
  const signedThisMonth = curM[curMonthIdx]?.signedCount ?? 0;
  const bookedThisMonth = curM[curMonthIdx]?.count ?? 0;
  const aovOf = (m?: { signedRevenue: number | null; signedCount: number }): number | null =>
    m && m.signedRevenue != null && m.signedCount > 0 ? m.signedRevenue / m.signedCount : null;
  const curAov = aovOf(curM[curMonthIdx]);
  const ordersThisMonth = curM[curMonthIdx]?.signedCount ?? 0;

  // Attention — money-gated (members don't see finance signals), grouped by severity for the hero queue.
  const attention = showMoney ? c.attention : c.attention.filter((i) => i.source !== "finance");
  const bySeverity = groupBySeverity(attention);
  const crit = bySeverity.critical.length, high = bySeverity.high.length, med = bySeverity.medium.length, low = bySeverity.info.length;
  const riskTotal = crit + high + med + low;
  const riskSub = [crit && `${crit} critical`, high && `${high} high`, med && `${med} medium`, low && `${low} low`].filter(Boolean).join(" · ") || "all clear";
  const riskTone: Tone = crit > 0 ? "critical" : high + med > 0 ? "attention" : "positive";

  const nextActions = attention.filter((i) => i.priority !== "info").slice(0, 6).map((i) => ({
    key: i.key, href: i.href, priority: i.priority,
    text: i.detail?.split("→")[1]?.trim() && i.detail.split("→")[1].trim().length > 3 ? i.detail.split("→")[1].trim() : i.title,
  }));

  const util = c.today_ops.fleetSize > 0 ? Math.round((c.today_ops.trucksUsed / c.today_ops.fleetSize) * 100) : null;

  // QUOTE PIPELINE (current open, by EVENT date) — NOT range-scoped.
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
  const quoteStages = safe(() => getQuoteStageSnapshot(), null);

  // Next operational day — for the Today's Operations empty state.
  const futureOps = safe(() => getPipelineBookingsInRange(shiftYmd(today, 1), shiftYmd(today, 60)), [] as BookingView[]).filter((b) => b.eventDate);
  const nextOpDate = futureOps.length ? futureOps[0].eventDate! : null;
  const nextOpDay = nextOpDate ? { date: nextOpDate, count: futureOps.filter((b) => b.eventDate === nextOpDate).length } : null;
  const hasOpsToday = c.today_ops.stops > 0 || c.today_ops.activeRoutes > 0;

  const pendingApprovals = aiOverview?.pendingApprovals ?? 0;

  return (
    <BladeMain>
      <AutoRefresh seconds={120} />

      {/* Header — date scope, compact range control, search, location, notifications, and the primary action.
          Actions wrap, so the chrome always fits mobile (no fixed-width top bar). */}
      <PageHeader
        size="display"
        title="Command Center"
        subtitle={`${formatYmdLong(today)} · ${firstName}'s real-time view of the business, operations and AI`}
        actions={
          <>
            {/* Pre-existing search affordance (no global-search backend yet) — shown from sm up. */}
            <span className="hidden h-8 min-w-0 items-center gap-2 rounded-md border border-border bg-row px-3 text-[12.5px] text-meta sm:flex sm:w-[200px] lg:w-[240px]">
              <Search className="size-[15px] shrink-0" aria-hidden />
              <span className="truncate">Search…</span>
            </span>
            <nav aria-label="Date range" className="flex max-w-full items-center overflow-x-auto rounded-md border border-border">
              {RANGES.map((r) => (
                <Link key={r.key} href={r.key === "today" ? "/dashboard" : `/dashboard?range=${r.key}`} aria-current={range === r.key ? "page" : undefined}
                  className={`shrink-0 px-2.5 py-1.5 text-[12px] font-medium transition-colors ${range === r.key ? "bg-[var(--gold)]/15 text-[var(--gold)]" : "text-muted-foreground hover:bg-[var(--row-hover)] hover:text-foreground"}`}>
                  {r.label}
                </Link>
              ))}
            </nav>
            <span className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-border px-2.5 text-[12px] text-tertiary-text"><MapPin className="size-3.5 text-meta" aria-hidden /> All locations</span>
            <Link href="/ai-command" aria-label={`Notifications${pendingApprovals > 0 ? ` (${pendingApprovals} pending)` : ""}`} className="relative grid size-8 shrink-0 place-items-center rounded-md border border-border text-secondary-text transition-colors hover:border-[var(--bar)]">
              <Bell className="size-4" aria-hidden />
              {pendingApprovals > 0 && <span className="absolute right-[7px] top-[6px] size-1.5 rounded-full bg-status-blocked" aria-hidden />}
            </Link>
            <Link href="/intake" className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-[var(--gold)]/50 bg-[var(--gold)]/15 px-3 text-[12.5px] font-medium text-[var(--gold)] transition-colors hover:bg-[var(--gold)]/25">
              <Plus className="size-4" aria-hidden /> New quote
            </Link>
          </>
        }
      />

      {/* Compact, scope-labelled business summary. auto-fit so the final row's tiles stretch to fill —
          never an orphaned half-empty cell from a fixed desktop column count. */}
      <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(170px,1fr))]">
        {showMoney ? (
          <Metric label={`Revenue · ${monthName} MTD`} value={money(rev.committed)}
            tone={rev.status === "at-risk" ? "attention" : rev.status === "met" || rev.status === "likely" ? "positive" : undefined}
            sub={rev.target != null ? `${rev.pctOfTarget ?? 0}% of ${money(rev.target)} target` : "no target set"} />
        ) : (
          <Metric label="Events · today" value={String(c.today_ops.events)} sub="scheduled" />
        )}
        <Metric label="Open quotes · current" value={String(pipelineData.count)}
          sub={showMoney ? `${money(openValue)} open · ${signedThisMonth} signed ${monthName}` : `${signedThisMonth} signed ${monthName}`} />
        {showMoney ? (
          <Metric label={`Avg order · ${monthName}`} value={money(curAov)} sub={`${plural(ordersThisMonth, "order")} this month`} />
        ) : (
          <Metric label={`Booked · ${monthName}`} value={String(bookedThisMonth)} sub="this month" />
        )}
        <Link href="#attention" className="block rounded-md focus-visible:outline-2 focus-visible:outline-ring">
          <Metric label="Open risks · live" value={String(riskTotal)} sub={riskSub} tone={riskTone} />
        </Link>
        <Metric label="Fleet · today" value={`${c.today_ops.trucksUsed} of ${c.today_ops.fleetSize}`}
          sub={util != null ? `trucks active · ${util}% utilization` : "trucks active"} />
      </div>

      {/* Main cockpit + context rail. */}
      <div className="mt-4 grid grid-cols-1 gap-4 lg:[grid-template-columns:minmax(0,1fr)_340px]">
        <div className="min-w-0 space-y-4">
          {/* ── HERO: prioritized attention queue (the urgent decisions, first) ── */}
          <section id="attention" className="surface flex flex-col border p-3">
            <div className="mb-3 flex items-center gap-2">
              <h2 className="flex items-center gap-1.5 text-[11.5px] font-semibold uppercase tracking-[0.06em] text-tertiary-text"><AlertTriangle className="size-4 text-meta" aria-hidden /> Needs attention</h2>
              <span className="rounded bg-[var(--row-hover)] px-1.5 py-0.5 text-[9px] uppercase tracking-[0.08em] text-meta">Live</span>
              {riskTotal > 0 && <span className="rounded bg-critical/15 px-1.5 py-0.5 text-[10px] font-bold tabular-nums text-critical">{riskTotal}</span>}
              <Link href="/ops" className="ml-auto inline-flex items-center gap-0.5 text-[11px] text-meta transition-colors hover:text-foreground">Ops <ArrowRight className="size-3" /></Link>
            </div>
            {riskTotal === 0 ? (
              <EmptyState icon={<ShieldAlert className="size-5 text-positive" />} title="All operations are on track" body="No open risks, capacity constraints, or overdue follow-ups right now." />
            ) : (
              <AttentionQueue groups={bySeverity} />
            )}
          </section>

          {/* Business + quote pipeline. */}
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-5">
            <div className="min-w-0 xl:col-span-3">
              <RevenueTrendChart months={months} target={rev.target} curYear={year} prevYear={year - 1} showMoney={showMoney} currentMonthIdx={curMonthIdx} />
            </div>
            <div className="min-w-0 xl:col-span-2">
              <QuotePipeline pipeline={pipelineData} stages={quoteStages} showMoney={showMoney} />
            </div>
          </div>

          {/* Explicit crew capacity + today's operations. */}
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-5">
            <Panel className="xl:col-span-3" icon={<Gauge className="size-4" />} title="Crew capacity" scope={WIDGET_SCOPE.capacity.scope} href="/risk" hrefLabel="Event Risk">
              <CapacityStrip days={c.outlook} />
            </Panel>
            <Panel className="xl:col-span-2" icon={<Truck className="size-4" />} title="Today's operations" scope={WIDGET_SCOPE.todaysOps.scope} href="/dispatch" hrefLabel="Routes">
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

          {/* Secondary: AI-ranked opportunities + next actions. */}
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
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
                      <span className={`size-1.5 shrink-0 rounded-full ${SEV_DOT[a.priority]}`} aria-hidden />
                    </Link>
                  ))}
                </div>
              )}
            </Panel>
          </div>
        </div>

        {/* ── CONTEXT RAIL ── */}
        <aside className="min-w-0 space-y-4">
          <AiActivity items={aiItems} nowMs={nowMs} pendingApprovals={pendingApprovals} />

          <Panel icon={<CalendarDays className="size-4" />} title={upcomingTitle} scope={WIDGET_SCOPE.upcomingEvents.scope} href="/sales" hrefLabel="View all">
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
                    <span className="shrink-0">
                      <StatusBadge tone={b.signed ? "positive" : "attention"} size="sm">{b.signed ? "Signed" : "Open"}</StatusBadge>
                    </span>
                  </div>
                ))}
              </div>
            )}
          </Panel>
        </aside>
      </div>
    </BladeMain>
  );
}

function safe<T>(fn: () => T, fallback: T): T {
  try { return fn(); } catch { return fallback; }
}

// ── Attention queue ────────────────────────────────────────────────────────────

type SeverityGroups = Record<Priority, AttentionItem[]>;
function groupBySeverity(items: AttentionItem[]): SeverityGroups {
  const g: SeverityGroups = { critical: [], high: [], medium: [], info: [] };
  for (const i of items) g[i.priority].push(i);
  return g;
}

// Prioritized, severity-grouped queue: each signal shows severity, affected day/event, the concise issue,
// the owning area, the next action, and the source — related signals grouped, none hidden. Drill-down
// preserved (each row links to its blade). Capped so the hero stays scannable; the rest is one click away.
function AttentionQueue({ groups }: { groups: SeverityGroups }): React.JSX.Element {
  const order: Priority[] = ["critical", "high", "medium", "info"];
  const MAX = 9;
  let shown = 0;
  const total = order.reduce((n, p) => n + groups[p].length, 0);

  return (
    <div className="space-y-3">
      {order.map((p) => {
        if (groups[p].length === 0 || shown >= MAX) return null;
        const take = groups[p].slice(0, Math.max(0, MAX - shown));
        shown += take.length;
        return (
          <div key={p}>
            <div className="mb-1 flex items-center gap-1.5 px-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-meta">
              <span className={`size-1.5 rounded-full ${SEV_DOT[p]}`} aria-hidden /> {SEV[p].label} <span className="tabular-nums">({groups[p].length})</span>
            </div>
            <ul className="space-y-1" role="list">
              {take.map((i) => {
                const reason = i.detail?.split("→")[0].trim();
                const action = i.detail?.split("→")[1]?.trim();
                const when = attentionTiming(i.daysUntil);
                return (
                  <li key={i.key}>
                    <Link href={i.href} className={`flex items-start gap-2.5 rounded border-l-2 ${SEV_EDGE[p]} bg-[var(--row)]/40 px-2.5 py-2 transition-colors hover:bg-[var(--row-hover)]`}>
                      <span className="min-w-0 flex-1">
                        <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                          <span className="truncate text-[12.5px] font-medium text-foreground">{i.title}</span>
                          {when && <span className="shrink-0 rounded bg-[var(--row-hover)] px-1.5 py-0.5 text-[9.5px] font-medium uppercase tracking-wide text-secondary-text">{when}</span>}
                        </span>
                        {reason && <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">{reason}</span>}
                        <span className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[10.5px] text-meta">
                          <span className="inline-flex items-center gap-1"><StatusBadge tone={SEV[p].tone} size="sm">{SEV[p].label}</StatusBadge></span>
                          <span aria-hidden>·</span>
                          <span>{ATTENTION_OWNER[i.source]}</span>
                        </span>
                      </span>
                      {action && <span className="mt-0.5 inline-flex shrink-0 items-center gap-0.5 text-[11px] font-medium text-[#9fb6e6]">{action} <ArrowRight className="size-3" /></span>}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
      {total > shown && (
        <Link href="/ops" className="inline-flex items-center gap-0.5 px-1 text-[11px] text-tertiary-text transition-colors hover:text-foreground">
          {total - shown} more in Ops <ArrowRight className="size-3" />
        </Link>
      )}
    </div>
  );
}

// ── Crew capacity strip ──────────────────────────────────────────────────────────

function CapacityStrip({ days }: { days: OutlookDay[] }): React.JSX.Element {
  return (
    <>
      {/* Bounded, scroll-local on narrow screens (the page never scrolls sideways); even 7-up at lg+. */}
      <div className="overflow-x-auto">
        <div className="grid min-w-[520px] grid-cols-7 rounded border border-[var(--lifted)] sm:min-w-0">
          {days.map((d, i) => {
            const lvl = capacityLevel(d.verdict);
            const crew = capacityCrewLabel({ driversScheduled: d.driversScheduled, driversNeeded: d.driversNeeded, jobs: d.jobs });
            return (
              <div key={d.date} className={`px-1.5 py-2 text-center ${i < 6 ? "border-r border-[var(--lifted)]" : ""} ${d.isToday ? "bg-[var(--row)] shadow-[inset_0_0_0_1px_var(--bar)]" : ""}`}>
                <div className="text-[11px] uppercase tracking-[0.06em] text-secondary-text">{dow(d.date)}</div>
                <div className="mt-0.5 text-[11px] tabular-nums text-muted-foreground">{monTitle(d.date)} {dnum(d.date)}</div>
                <div className="mt-1.5 flex items-center justify-center gap-1 text-[11px]">
                  <span className="size-1.5 shrink-0 rounded-full" style={{ background: CAP_HEX[lvl] }} aria-hidden />
                  <span className="font-medium text-foreground">{CAPACITY_LEVEL_LABEL[lvl]}</span>
                </div>
                <div className="mt-1 text-[10.5px] tabular-nums text-secondary-text">{crew.label}</div>
                <div className="mx-1.5 mt-1.5 h-[5px] rounded-[3px] bg-[var(--border)]" title={crew.sub ?? CAPACITY_LEVEL_LABEL[lvl]}>
                  <span className="block h-full rounded-[3px]" style={{ width: `${crew.fill}%`, background: CAP_HEX[lvl] }} />
                </div>
              </div>
            );
          })}
        </div>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 px-0.5 text-[11px] text-meta">
        <span>Crew = drivers available vs required</span>
        <span className="flex items-center gap-1.5"><span className="size-1.5 rounded-full" style={{ background: CAP_HEX.NORMAL }} /> Open</span>
        <span className="flex items-center gap-1.5"><span className="size-1.5 rounded-full" style={{ background: CAP_HEX.TIGHT }} /> Tight</span>
        <span className="flex items-center gap-1.5"><span className="size-1.5 rounded-full" style={{ background: CAP_HEX.CONSTRAINED }} /> At limit</span>
      </div>
    </>
  );
}

// ── Panels ─────────────────────────────────────────────────────────────────────

function Panel({ icon, title, scope, href, hrefLabel, children, className, badge, chip }: { icon: React.ReactNode; title: string; scope?: string; href?: string; hrefLabel?: string; children: React.ReactNode; className?: string; badge?: number; chip?: React.ReactNode }): React.JSX.Element {
  return (
    <section className={`surface flex flex-col border p-3 ${className ?? ""}`}>
      <div className="mb-3 flex items-center gap-2">
        <h2 className="flex min-w-0 items-center gap-1.5 text-[11.5px] font-semibold uppercase tracking-[0.06em] text-tertiary-text">{icon} <span className="truncate">{title}</span></h2>
        {badge != null && <span className="rounded bg-critical/15 px-1.5 py-0.5 text-[10px] font-bold tabular-nums text-critical">{badge}</span>}
        {scope && <span className="shrink-0 rounded bg-[var(--row-hover)] px-1.5 py-0.5 text-[9px] uppercase tracking-[0.08em] text-meta">{scope}</span>}
        {chip}
        {href && hrefLabel && <Link href={href} className="ml-auto inline-flex shrink-0 items-center gap-0.5 text-[11px] text-meta transition-colors hover:text-foreground">{hrefLabel} <ArrowRight className="size-3" /></Link>}
      </div>
      {children}
    </section>
  );
}

// Today's Operations EMPTY state — shown instead of a giant empty map when nothing is dispatched today.
function TodayOpsEmpty({ ops, nextOpDay, showMoney }: { ops: { events: number; activeRoutes: number; driversAssigned: number; scheduledRevenue: number | null }; nextOpDay: { date: string; count: number } | null; showMoney: boolean }): React.JSX.Element {
  const headline = ops.events > 0 ? `${plural(ops.events, "event")} booked — not dispatched.` : "No routes scheduled today.";
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
            <span className="text-[14px] font-semibold tabular-nums text-foreground">{monTitle(nextOpDay.date)} {dnum(nextOpDay.date)}</span>
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
