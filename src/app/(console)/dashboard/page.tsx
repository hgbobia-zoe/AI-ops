// Zoe Operations Command Center — the operational control tower. Reads one server aggregator
// (commandCenter()) and arranges it as a 12-column cockpit that answers, top to bottom: how are we doing
// (Business Pulse), what does today mean (Situation), where's the money (Revenue + Pipeline), can we
// execute (Capacity + Today's Ops), what's at risk and what to do (Attention + Action Queue). Nothing is
// fabricated: every number comes from commandCenter(); an unresolved value is "—"/UNVERIFIED and says so.
// Money is Owner/Admin only. Dispatch stays the operations workspace — this is the command layer above it.

import Link from "next/link";
import {
  AlertTriangle, ArrowRight, TrendingUp, Users, Radar, Truck, Boxes,
  Gauge, Clock, CircleCheck, CircleDot, Sparkles, ListChecks, Activity,
} from "lucide-react";
import { AutoRefresh } from "@/components/AutoRefresh";
import { commandCenter } from "@/lib/command/service";
import { type OpStatus, type RevenueStatus, situationHeadline, capacityLevel, pipelineCoverageMultiple, type CapacityLevel } from "@/lib/command/calc";
import { formatYmdLong } from "@/lib/dates";
import { viewerRole } from "@/lib/auth/getSession";
import { canSeeFinancials, canManageSettings } from "@/lib/auth/roles";
import type { Priority } from "@/lib/ops/manager";
import { BladeAgents } from "@/components/aiorg/BladeAgents";
import { computeConnections, type ConnStatus } from "@/lib/health/connections";

export const dynamic = "force-dynamic";

// Exact figures with thousands separators (whole dollars) — never abbreviated. Managers want the real
// number; abbreviation loses precision they use for decisions.
const money = (n: number | null | undefined): string => (n == null ? "—" : "$" + Math.round(n).toLocaleString("en-US"));
// Compact $ for tight cells (pulse / pipeline chips) where the full number won't fit cleanly.
const moneyK = (n: number | null | undefined): string => {
  if (n == null) return "—";
  const a = Math.abs(n);
  if (a >= 1000) return "$" + (Math.round(n / 100) / 10).toLocaleString("en-US") + "K";
  return "$" + Math.round(n).toLocaleString("en-US");
};
const plural = (n: number, w: string): string => `${n} ${w}${n === 1 ? "" : "s"}`;

const STATUS_META: Record<OpStatus, { label: string; cls: string; dot: string }> = {
  quiet: { label: "Quiet", cls: "text-meta", dot: "bg-[var(--bar)]" },
  normal: { label: "Normal", cls: "text-positive", dot: "bg-positive" },
  busy: { label: "Busy", cls: "text-tertiary-text", dot: "bg-[var(--bar-2)]" },
  "at-risk": { label: "At risk", cls: "text-critical", dot: "bg-critical" },
};

const P_ACCENT: Record<Priority, string> = { critical: "border-l-critical", high: "border-l-attention", medium: "border-l-attention/60", info: "border-l-border" };
const P_CHIP: Record<Priority, string> = { critical: "text-critical", high: "text-attention", medium: "text-attention", info: "text-meta" };
const P_DOT: Record<Priority, string> = { critical: "bg-critical", high: "bg-attention", medium: "bg-attention/70", info: "bg-[var(--bar)]" };
const P_LABEL: Record<Priority, string> = { critical: "Critical", high: "High", medium: "Medium", info: "Info" };

// Capacity display levels → restrained Nocturne tones (status only, not decoration).
const CAP_LEVEL: Record<CapacityLevel, { text: string; chip: string; bar: string; label: string }> = {
  NORMAL: { text: "text-meta", chip: "border-border text-meta", bar: "bg-[var(--bar)]", label: "Normal" },
  TIGHT: { text: "text-attention", chip: "border-attention/40 text-attention", bar: "bg-attention/70", label: "Tight" },
  CONSTRAINED: { text: "text-critical", chip: "border-critical/50 text-critical", bar: "bg-critical/80", label: "Constrained" },
  UNVERIFIED: { text: "text-meta", chip: "border-border text-meta", bar: "bg-[var(--bar)]/50", label: "Unverified" },
};

const REV_STATUS: Record<RevenueStatus, { label: string; pill: string; text: string }> = {
  met: { label: "Target met", pill: "border-positive/40 text-positive", text: "text-positive" },
  likely: { label: "On track", pill: "border-positive/40 text-positive", text: "text-positive" },
  "at-risk": { label: "At risk", pill: "border-critical/50 text-critical", text: "text-critical" },
  "no-target": { label: "No target", pill: "border-border text-meta", text: "text-meta" },
  "no-data": { label: "No data", pill: "border-border text-meta", text: "text-meta" },
};

const HEALTH_DOT: Record<ConnStatus, string> = { ok: "bg-positive", idle: "bg-[var(--bar)]", attention: "bg-attention", off: "bg-[var(--bar)]" };

/** Deterministic one-liner for the revenue status — prepended to the AI summary. Rules calculate. */
function revenueSentence(r: { periodLabel: string; status: RevenueStatus; committed: number | null; target: number | null; pipeline: number | null; remaining: number | null; gapAfterPipeline: number | null }): string {
  const m = (n: number | null | undefined) => (n == null ? "—" : "$" + Math.round(n).toLocaleString("en-US"));
  if (r.status === "no-target" || r.status === "no-data") return "";
  if (r.status === "met") return `${r.periodLabel} revenue has hit target (${m(r.committed)} of ${m(r.target)} committed).`;
  if (r.status === "likely") return `${r.periodLabel} revenue is on track — ${m(r.committed)} of ${m(r.target)} committed, with ${m(r.pipeline)} in open quotes to cover the ${m(r.remaining)} gap.`;
  return `${r.periodLabel} revenue is at risk — ${m(r.committed)} of ${m(r.target)} committed, still short ${m(r.gapAfterPipeline)} even if every open quote closes.`;
}

function dowShort(ymd: string): string {
  return new Date(`${ymd}T00:00:00Z`).toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" });
}
function dayNum(ymd: string): string {
  return new Date(`${ymd}T00:00:00Z`).toLocaleDateString("en-US", { day: "numeric", timeZone: "UTC" });
}

// Focus filters — clicking a chip narrows the cockpit to one lane. `null` = everything.
type Focus = "all" | "attention" | "today" | "people" | "revenue";
const FOCUS_GROUPS: Record<Focus, ReadonlySet<string> | null> = {
  all: null,
  attention: new Set(["attention"]),
  today: new Set(["brief", "attention", "todayOps", "capacity"]),
  people: new Set(["people", "capacity", "todayOps"]),
  revenue: new Set(["revenue", "salesPipeline"]),
};
const FOCUS_KEYS: Focus[] = ["all", "attention", "today", "people", "revenue"];

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ focus?: string }>;
}): Promise<React.JSX.Element> {
  const role = await viewerRole();
  const showMoney = canSeeFinancials(role);
  const c = await commandCenter();
  const s = STATUS_META[c.status];

  const sp = await searchParams;
  let focus: Focus = FOCUS_KEYS.includes(sp.focus as Focus) ? (sp.focus as Focus) : "all";
  if (focus === "revenue" && !showMoney) focus = "all"; // Members have no revenue lane
  const show = (k: string): boolean => focus === "all" || Boolean(FOCUS_GROUPS[focus]?.has(k));
  const chips: { key: Focus; label: string }[] = [
    { key: "all", label: "Everything" },
    { key: "attention", label: "Attention" },
    { key: "today", label: "Today" },
    { key: "people", label: "People" },
    ...(showMoney ? [{ key: "revenue" as Focus, label: "Revenue" }] : []),
  ];
  const focusHref = (k: Focus): string => (k === "all" ? "/dashboard" : `/dashboard?focus=${k}`);

  const rev = c.revenue;
  const attention = (showMoney ? c.attention : c.attention.filter((i) => i.source !== "finance"));
  const critical = attention.filter((i) => i.priority === "critical");
  const high = attention.filter((i) => i.priority === "high");
  const medium = attention.filter((i) => i.priority === "medium");
  const topIssue = critical[0] ?? high[0] ?? medium[0] ?? null;

  // Management "next actions" — the recommended step from each ranked exception (text after "→"), deduped.
  const nextActions = attention
    .filter((i) => i.priority !== "info")
    .map((i) => {
      const arrow = i.detail?.split("→")[1]?.trim();
      return { key: i.key, priority: i.priority, href: i.href, text: arrow && arrow.length > 3 ? arrow : i.title, daysUntil: i.daysUntil ?? null };
    })
    .slice(0, 5);

  const summary = [showMoney ? revenueSentence(rev) : "", c.brief].filter(Boolean).join(" ");
  const headline = situationHeadline({
    revStatus: rev.status,
    showMoney,
    criticalOrHigh: c.criticalOrHigh,
    capacityConstrainedSoon: c.capacity.some((d) => capacityLevel(d.verdict) === "CONSTRAINED"),
  });

  // The upcoming constraint for the pulse (first non-normal day in the outlook, else first capacity day).
  const nextConstraint =
    c.outlook.find((d) => capacityLevel(d.verdict) === "CONSTRAINED" || capacityLevel(d.verdict) === "TIGHT") ?? null;
  const capReasons = new Map(c.capacity.map((d) => [d.date, d.reasons]));
  const coverage = pipelineCoverageMultiple(c.pipeline.quote.value, rev.remaining);

  // Compact system-health strip (managers only — same signal as the top status bar, subordinate here).
  const canManage = canManageSettings(role);
  const conns = canManage ? computeConnections() : [];

  return (
    <main className="mx-auto max-w-[1400px] p-4 pb-16 md:p-6">
      <AutoRefresh seconds={120} />

      {/* Command header */}
      <header className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-[24px] font-semibold tracking-tight">Command Center</h1>
          <p className="text-[12.5px] text-meta">{formatYmdLong(c.today)}</p>
        </div>
        <span className={`inline-flex items-center gap-2 border px-3 py-1.5 text-[12px] font-semibold uppercase tracking-[0.1em] ${s.cls} ${c.status === "at-risk" ? "border-critical/40 bg-critical/[0.04]" : "border-border"}`}>
          <span className={`size-2 rounded-full ${s.dot}`} aria-hidden /> {s.label}
        </span>
      </header>

      <BladeAgents blade="command" className="mb-4" />

      {/* Focus filter */}
      <div className="mb-5 flex flex-wrap gap-5 border-b border-border pb-2">
        {chips.map((ch) => (
          <Link
            key={ch.key}
            href={focusHref(ch.key)}
            aria-current={focus === ch.key ? "page" : undefined}
            className={`text-[13.5px] transition-colors ${focus === ch.key ? "font-medium text-foreground" : "text-muted-foreground hover:text-foreground"}`}
          >
            {ch.label}
          </Link>
        ))}
      </div>

      {/* ── BUSINESS PULSE — one strip, divided cells (how are we doing?) ── */}
      <section className="mb-5 grid grid-cols-2 divide-border border border-border bg-panel sm:grid-cols-3 sm:divide-x lg:grid-cols-5 [&>*]:border-t [&>*]:border-border sm:[&>*]:border-t-0 sm:[&>*:nth-child(-n+3)]:border-t-0 lg:[&>*]:border-t-0">
        {showMoney ? (
          <>
            <PulseCell
              label={`${rev.periodLabel} revenue`}
              big={money(rev.committed)}
              sub={rev.pctOfTarget != null ? `${rev.pctOfTarget}% of target` : "no target set"}
              tone={rev.status === "met" || rev.status === "likely" ? "good" : rev.status === "at-risk" ? "bad" : undefined}
              href={focusHref("revenue")}
            />
            <PulseCell label="Target" big={money(rev.target)} sub={rev.remaining != null && rev.remaining > 0 ? `${money(rev.remaining)} remaining` : rev.target != null ? "target met" : "—"} href={focusHref("revenue")} />
            <PulseCell label="Open pipeline" big={moneyK(c.pipeline.quote.value)} sub={`${plural(c.pipeline.quote.count, "opportunity").replace("opportunitys", "opportunities")}`} tone="warnable" href={focusHref("revenue")} />
          </>
        ) : (
          <>
            <PulseCell label="Events today" big={String(c.today_ops.events)} sub={`${c.today_ops.activeRoutes} routes`} href={focusHref("today")} />
            <PulseCell label="Crew today" big={c.people.verified ? String(c.people.peopleCount) : "—"} sub={c.people.verified ? plural(c.people.drivers, "driver") : "not connected"} tone={c.people.verified ? undefined : "bad"} href={focusHref("people")} />
            <PulseCell label="Stops today" big={String(c.today_ops.stops)} sub={`${c.today_ops.completed} done`} href={focusHref("today")} />
          </>
        )}
        <PulseCell
          label="Operational risks"
          big={String(attention.filter((i) => i.priority !== "info").length)}
          sub={critical.length > 0 ? `${plural(critical.length, "critical")}` : high.length > 0 ? `${plural(high.length, "high")}` : "none critical"}
          tone={critical.length > 0 ? "bad" : high.length > 0 ? "warnable" : "good"}
          href={focusHref("attention")}
        />
        <PulseCell
          label="Capacity constraint"
          big={nextConstraint ? `${dowShort(nextConstraint.date)} ${dayNum(nextConstraint.date)}` : "Clear"}
          sub={nextConstraint ? (capReasons.get(nextConstraint.date)?.[0] ?? CAP_LEVEL[capacityLevel(nextConstraint.verdict)].label) : "7 days ahead"}
          tone={nextConstraint && capacityLevel(nextConstraint.verdict) === "CONSTRAINED" ? "bad" : nextConstraint ? "warnable" : "good"}
          href="/risk"
        />
      </section>

      {/* ── TODAY'S SITUATION — the AI brief, as a verdict + the single biggest issue ── */}
      {summary && show("brief") && (
        <section className={`mb-5 border border-l-[3px] border-border bg-panel ${c.status === "at-risk" ? "border-l-critical" : c.status === "normal" ? "border-l-positive" : "border-l-border"}`}>
          <div className="flex flex-col gap-3 p-4 lg:flex-row lg:items-start lg:gap-6">
            <div className="min-w-0 flex-1">
              <div className="mb-1.5 flex items-center gap-1.5 text-[10.5px] uppercase tracking-[0.12em] text-meta"><Sparkles className="size-3.5" /> Today&apos;s situation</div>
              <h2 className="text-[17px] font-semibold leading-snug text-foreground">{headline}</h2>
              <p className="mt-1.5 text-[13px] leading-relaxed text-secondary-text">{summary}</p>
            </div>
            {topIssue && (
              <Link href={topIssue.href} className="block shrink-0 border border-border bg-[var(--panel)] p-3 transition-colors hover:bg-[var(--row-hover)] lg:w-[320px]">
                <div className="flex items-center gap-2">
                  <span className={`size-1.5 rounded-full ${P_DOT[topIssue.priority]}`} aria-hidden />
                  <span className={`text-[10px] font-bold uppercase tracking-wide ${P_CHIP[topIssue.priority]}`}>{P_LABEL[topIssue.priority]}</span>
                  {topIssue.daysUntil != null && <span className="ml-auto text-[11px] text-meta">{topIssue.daysUntil <= 0 ? "today" : `in ${topIssue.daysUntil}d`}</span>}
                </div>
                <div className="mt-1 text-[13px] font-medium text-foreground">{topIssue.title}</div>
                {topIssue.detail && <div className="mt-0.5 line-clamp-2 text-[12px] text-muted-foreground">{topIssue.detail.split("→")[0].trim()}</div>}
                <div className="mt-2 inline-flex items-center gap-1 text-[11.5px] text-tertiary-text">Act on it <ArrowRight className="size-3" /></div>
              </Link>
            )}
          </div>
        </section>
      )}

      {/* ── WHERE'S THE MONEY — Revenue performance + Sales pipeline (money only) ── */}
      {showMoney && (show("revenue") || show("salesPipeline")) && (
        <div className="mb-5 grid grid-cols-1 gap-4 lg:grid-cols-12">
          {show("revenue") && (
            <section className="lg:col-span-7">
              <SectionHead icon={<TrendingUp className="size-4" />} title="Revenue performance" href="/sales" hrefLabel="Sales" />
              <div className="surface border p-4">
                <div className="flex flex-wrap items-end justify-between gap-3">
                  <div>
                    <div className="flex items-baseline gap-2">
                      <span className="text-[30px] font-semibold leading-none tabular-nums text-positive">{money(rev.committed)}</span>
                      <span className="text-[14px] text-meta">/ {money(rev.target)} {rev.periodLabel} target</span>
                    </div>
                    <div className="mt-1 text-[12px] text-meta">{rev.pctOfTarget ?? 0}% of target · {rev.pctElapsed}% of month elapsed</div>
                  </div>
                  <span className={`shrink-0 border px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide ${REV_STATUS[rev.status].pill}`}>{REV_STATUS[rev.status].label}</span>
                </div>

                {/* Larger year trend */}
                <div className="mt-5">
                  <div className="mb-1.5 flex items-center justify-between text-[10.5px] uppercase tracking-[0.1em] text-meta">
                    <span>{c.year} signed revenue by month</span>
                    {rev.target != null && <span className="normal-case tracking-normal text-meta/70">dashed = monthly target</span>}
                  </div>
                  <MonthTrend months={c.sales.months} targetLine={rev.target} />
                </div>

                {/* YTD facts */}
                <div className="mt-4 grid grid-cols-3 gap-3 border-t border-rule pt-3">
                  <MetricCol label="YTD revenue" value={money(c.sales.totalSignedRevenue)} tone="text-foreground" hint={`${c.year} signed`} />
                  <MetricCol label="Signed jobs" value={String(c.sales.totalSignedCount)} tone="text-foreground" hint="this year" />
                  <MetricCol label="To target" value={rev.remaining != null && rev.remaining > 0 ? money(rev.remaining) : "Met"} tone={rev.remaining && rev.remaining > 0 ? "text-attention" : "text-positive"} hint={rev.periodLabel} />
                </div>
              </div>
            </section>
          )}

          {show("salesPipeline") && (
            <section className="lg:col-span-5">
              <SectionHead icon={<Boxes className="size-4" />} title="Sales pipeline" href="/sales" hrefLabel="Sales" />
              <div className="surface flex h-[calc(100%-2rem)] flex-col border p-4">
                {/* Open is the hero — it's active, winnable revenue */}
                <div className="border border-attention/30 bg-attention/[0.03] p-3">
                  <div className="flex items-baseline justify-between">
                    <span className="text-[10.5px] uppercase tracking-[0.1em] text-attention">Open quotes</span>
                    <span className="text-[12px] text-meta">{c.pipeline.quote.count} open</span>
                  </div>
                  <div className="mt-0.5 text-[26px] font-semibold tabular-nums text-attention">{money(c.pipeline.quote.value)}</div>
                  <div className="text-[11.5px] text-meta">active, winnable revenue</div>
                </div>

                {/* Signed → Open → Lost proportion bar */}
                <FunnelBar signed={c.pipeline.signed} quote={c.pipeline.quote} lost={c.pipeline.lost} />

                <div className="mt-3 space-y-1.5">
                  <PipeRow label="Signed" count={c.pipeline.signed.count} value={money(c.pipeline.signed.value)} dot="bg-positive/70" />
                  <PipeRow label="Open" count={c.pipeline.quote.count} value={money(c.pipeline.quote.value)} dot="bg-attention/70" />
                  <PipeRow label="Lost / cancelled" count={c.pipeline.lost.count} value={money(c.pipeline.lost.value)} dot="bg-white/15" muted />
                </div>

                {coverage != null && (
                  <p className="mt-auto border-t border-rule pt-3 text-[12px] text-secondary-text">
                    Open pipeline is <span className="font-semibold text-foreground">{coverage}×</span> the remaining {rev.periodLabel} target gap.
                  </p>
                )}
              </div>
            </section>
          )}
        </div>
      )}

      {/* ── CAN WE EXECUTE — Operational capacity (7-day) + Today's operations ── */}
      {(show("capacity") || show("todayOps") || show("people")) && (
        <div className="mb-5 grid grid-cols-1 gap-4 lg:grid-cols-12">
          {show("capacity") && (
            <section className="lg:col-span-7">
              <SectionHead icon={<Gauge className="size-4" />} title="Operational capacity · 7-day" href="/risk" hrefLabel="Event Risk" />
              <div className="surface border p-3">
                <div className="grid grid-cols-7 gap-1.5">
                  {c.outlook.map((d) => {
                    const lvl = capacityLevel(d.verdict);
                    const meta = CAP_LEVEL[lvl];
                    const reason = capReasons.get(d.date)?.[0];
                    return (
                      <div key={d.date} title={capReasons.get(d.date)?.join(" · ") || meta.label} className={`flex flex-col items-center gap-1 border p-2 ${d.isToday ? "border-foreground/30 bg-[var(--row-hover)]" : "border-border"}`}>
                        <span className="text-[10px] uppercase tracking-wide text-meta">{d.dow}</span>
                        <span className="text-[13px] font-medium tabular-nums text-secondary-text">{dayNum(d.date)}</span>
                        <span className="text-[15px] font-semibold tabular-nums text-foreground">{d.jobs || "—"}</span>
                        <span className="text-[9px] uppercase tracking-wide text-meta">{d.jobs ? "jobs" : "open"}</span>
                        <span className={`h-1 w-full rounded-full ${meta.bar}`} aria-hidden />
                        <span className={`text-[9px] font-semibold uppercase tracking-wide ${meta.text}`}>{lvl === "NORMAL" ? "" : meta.label}</span>
                        {reason && lvl !== "NORMAL" && <span className="line-clamp-2 text-center text-[9.5px] leading-tight text-muted-foreground">{reason}</span>}
                      </div>
                    );
                  })}
                </div>
                <p className="mt-2 text-[11px] text-meta">Jobs booked per day with the capacity verdict. A glance shows which days are dangerous; open Event Risk for the full picture.</p>
              </div>
            </section>
          )}

          {(show("todayOps") || show("people")) && (
            <section className="lg:col-span-5">
              <SectionHead icon={<Truck className="size-4" />} title="Today's operations" href="/dispatch" hrefLabel="Dispatch" />
              <div className="surface border p-4">
                <div className="grid grid-cols-3 gap-2 text-center">
                  <Stat n={c.today_ops.events} label="events" />
                  <Stat n={c.people.verified ? c.people.peopleCount : null} label="crew" />
                  <StatMoney value={showMoney ? money(c.today_ops.scheduledRevenue) : null} label="revenue" />
                </div>

                {/* Route status — dispatched or not */}
                <div className="mt-4 border-t border-rule pt-3">
                  {c.today_ops.stops === 0 && c.today_ops.events > 0 ? (
                    <div className="flex items-center gap-2 text-[13px]">
                      <span className="inline-flex items-center gap-1.5 border border-attention/40 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-attention">
                        <AlertTriangle className="size-3" /> Not dispatched
                      </span>
                      <span className="text-muted-foreground">{plural(c.today_ops.events, "event")} booked, route not loaded.</span>
                    </div>
                  ) : c.today_ops.stops === 0 ? (
                    <p className="text-[13px] text-meta">No stops scheduled today.</p>
                  ) : (
                    <>
                      <ProgressRow done={c.today_ops.completed} total={c.today_ops.stops} inProgress={c.today_ops.inProgress} remaining={c.today_ops.remaining} />
                      <div className="mt-2 flex flex-wrap gap-x-3.5 gap-y-1 text-[11.5px] text-muted-foreground">
                        <span className="inline-flex items-center gap-1"><CircleCheck className="size-3.5 text-positive" /> {c.today_ops.completed} done</span>
                        <span className="inline-flex items-center gap-1"><CircleDot className="size-3.5 text-tertiary-text" /> {c.today_ops.inProgress} active</span>
                        <span className="inline-flex items-center gap-1"><Clock className="size-3.5" /> {c.today_ops.remaining} left</span>
                        <span className="inline-flex items-center gap-1"><Truck className="size-3.5" /> {c.today_ops.driversAssigned} drivers</span>
                        {c.today_ops.exceptions > 0 && <span className="inline-flex items-center gap-1 text-attention"><AlertTriangle className="size-3.5" /> {c.today_ops.exceptions} exc</span>}
                      </div>
                    </>
                  )}
                </div>

                {/* People list */}
                <div className="mt-3 border-t border-rule pt-3">
                  <div className="mb-1.5 flex items-center justify-between">
                    <span className="inline-flex items-center gap-1.5 text-[11px] uppercase tracking-[0.1em] text-meta"><Users className="size-3.5" /> On schedule</span>
                    <Link href="/staffing" className="text-[11px] text-meta hover:text-foreground">Staffing →</Link>
                  </div>
                  {!c.people.verified ? (
                    <p className="text-[12.5px] text-muted-foreground">Connecteam not connected. <Link href="/admin" className="underline">Connect →</Link></p>
                  ) : c.people.peopleCount === 0 ? (
                    <p className="text-[12.5px] text-muted-foreground">No one scheduled today.</p>
                  ) : (
                    <div className="max-h-40 space-y-1 overflow-y-auto">
                      {c.people.assignments.slice(0, 10).map((a, idx) => (
                        <div key={idx} className="flex items-center gap-2 text-[12.5px]">
                          <span className="w-14 shrink-0 tabular-nums text-meta">{a.start}</span>
                          <span className="min-w-0 flex-1 truncate text-secondary-text">{a.name}</span>
                          <span className="shrink-0 rounded bg-[var(--row-hover)] px-1.5 py-0.5 text-[9.5px] uppercase tracking-wide text-meta">{a.role}</span>
                        </div>
                      ))}
                      {c.people.openShifts > 0 && <p className="pt-1 text-[11px] text-attention">{plural(c.people.openShifts, "open shift")} unassigned</p>}
                    </div>
                  )}
                </div>
              </div>
            </section>
          )}
        </div>
      )}

      {/* ── WHAT'S AT RISK / WHAT TO DO — Attention (grouped) + Action queue ── */}
      {show("attention") && (
        <div className="mb-5 grid grid-cols-1 gap-4 lg:grid-cols-12">
          <section className="lg:col-span-7">
            <SectionHead icon={<Radar className="size-4" />} title="Attention required" href="/ops" hrefLabel="Ops Manager" />
            {attention.length === 0 ? (
              <div className="surface border p-4 text-[13px] text-positive">All operations are currently on track.</div>
            ) : (
              <div className="space-y-3">
                <SeverityGroup title="Critical" items={critical} />
                <SeverityGroup title="High" items={high} />
                <SeverityGroup title="Medium" items={medium.slice(0, 4)} />
              </div>
            )}
          </section>

          <section className="lg:col-span-5">
            <SectionHead icon={<ListChecks className="size-4" />} title="Next actions" href="/ops" hrefLabel="Ops Manager" />
            <div className="surface border p-2">
              {nextActions.length === 0 ? (
                <p className="p-2 text-[13px] text-positive">Nothing needs your attention right now.</p>
              ) : (
                nextActions.map((a, i) => (
                  <Link key={a.key} href={a.href} className="flex items-center gap-3 px-2 py-2.5 transition-colors hover:bg-[var(--row-hover)]">
                    <span className="flex size-6 shrink-0 items-center justify-center rounded-full border border-border text-[12px] font-semibold tabular-nums text-tertiary-text">{i + 1}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] font-medium text-foreground">{a.text}</span>
                      {a.daysUntil != null && <span className="text-[11px] text-meta">{a.daysUntil <= 0 ? "today" : `due in ${a.daysUntil}d`}</span>}
                    </span>
                    <span className={`size-1.5 shrink-0 rounded-full ${P_DOT[a.priority]}`} aria-hidden />
                    <ArrowRight className="size-3.5 shrink-0 text-muted-foreground" />
                  </Link>
                ))
              )}
            </div>
          </section>
        </div>
      )}

      {/* ── SYSTEM HEALTH — subordinate status strip (managers) ── */}
      {canManage && conns.length > 0 && focus === "all" && (
        <section>
          <div className="mb-2 flex items-center gap-1.5 text-[10.5px] uppercase tracking-[0.12em] text-meta"><Activity className="size-3.5" /> System health</div>
          <div className="flex flex-wrap gap-x-5 gap-y-2 border border-border bg-panel px-3 py-2.5">
            {conns.map((cn) => (
              <Link key={cn.key} href={cn.fixHref ?? "/admin/health"} className="inline-flex items-center gap-1.5 text-[12px] transition-colors hover:text-foreground" title={cn.detail}>
                <span className={`size-1.5 rounded-full ${HEALTH_DOT[cn.status]}`} aria-hidden />
                <span className="text-secondary-text">{cn.label}</span>
                <span className="text-meta">{cn.status === "ok" ? "" : cn.headline.toLowerCase()}</span>
              </Link>
            ))}
            <Link href="/admin/health" className="ml-auto inline-flex items-center gap-1 text-[11.5px] text-meta hover:text-foreground">Connections <ArrowRight className="size-3" /></Link>
          </div>
        </section>
      )}
    </main>
  );
}

// ── Presentational bits ─────────────────────────────────────────────────────────

function PulseCell({ label, big, sub, href, tone }: { label: string; big: string; sub?: string; href: string; tone?: "good" | "bad" | "warnable" }): React.JSX.Element {
  const bigTone = tone === "good" ? "text-positive" : tone === "bad" ? "text-critical" : "text-foreground";
  const subTone = tone === "bad" ? "text-critical" : tone === "warnable" ? "text-attention" : "text-meta";
  return (
    <Link href={href} className="min-w-0 p-3.5 transition-colors hover:bg-[var(--row-hover)]">
      <div className="mb-1 truncate text-[10px] uppercase tracking-[0.1em] text-meta">{label}</div>
      <div className={`truncate text-[24px] font-semibold leading-none tabular-nums ${bigTone}`}>{big}</div>
      {sub && <div className={`mt-1 truncate text-[11.5px] ${subTone}`}>{sub}</div>}
    </Link>
  );
}

function SectionHead({ icon, title, href, hrefLabel }: { icon: React.ReactNode; title: string; href: string; hrefLabel: string }): React.JSX.Element {
  return (
    <div className="mb-2 flex items-center justify-between">
      <h2 className="flex items-center gap-2 text-[13px] font-semibold uppercase tracking-[0.06em] text-tertiary-text">{icon} {title}</h2>
      <Link href={href} className="text-[11.5px] text-meta hover:text-foreground">{hrefLabel} →</Link>
    </div>
  );
}

function SeverityGroup({ title, items }: { title: string; items: { key: string; priority: Priority; title: string; detail: string; href: string; daysUntil?: number | null }[] }): React.JSX.Element | null {
  if (items.length === 0) return null;
  return (
    <div>
      <div className={`mb-1.5 text-[10.5px] font-bold uppercase tracking-[0.1em] ${P_CHIP[items[0].priority]}`}>{title}</div>
      <div className="space-y-1.5">
        {items.map((i) => {
          const action = i.detail?.split("→")[1]?.trim();
          return (
            <Link key={i.key} href={i.href} className={`flex items-center gap-3 border border-l-[3px] border-border bg-panel px-3 py-2.5 transition-colors hover:bg-[var(--row-hover)] ${P_ACCENT[i.priority]}`}>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-medium text-foreground">{i.title}</span>
                {i.detail && <span className="block truncate text-[11.5px] text-muted-foreground">{action ? `→ ${action}` : i.detail}</span>}
              </span>
              {i.daysUntil != null && <span className="shrink-0 text-[11px] text-meta">{i.daysUntil <= 0 ? "today" : `in ${i.daysUntil}d`}</span>}
              <ArrowRight className="size-3.5 shrink-0 text-muted-foreground" />
            </Link>
          );
        })}
      </div>
    </div>
  );
}

function Stat({ n, label }: { n: number | null; label: string }): React.JSX.Element {
  return (
    <div>
      <div className="text-[22px] font-semibold tabular-nums">{n == null ? "—" : n}</div>
      <div className="text-[10px] uppercase tracking-wide text-meta">{label}</div>
    </div>
  );
}

function StatMoney({ value, label }: { value: string | null; label: string }): React.JSX.Element {
  return (
    <div>
      <div className={`text-[22px] font-semibold tabular-nums ${value && value !== "—" ? "text-positive" : ""}`}>{value ?? "—"}</div>
      <div className="text-[10px] uppercase tracking-wide text-meta">{label}</div>
    </div>
  );
}

function ProgressRow({ done, total, inProgress, remaining }: { done: number; total: number; inProgress: number; remaining: number }): React.JSX.Element {
  const pct = (n: number) => (total > 0 ? (n / total) * 100 : 0);
  return (
    <div className="flex h-2 w-full overflow-hidden rounded-full bg-[var(--row-hover)]">
      <div className="bg-positive" style={{ width: `${pct(done)}%` }} />
      <div className="bg-[var(--bar-2)]" style={{ width: `${pct(inProgress)}%` }} />
      <div className="bg-white/10" style={{ width: `${pct(remaining)}%` }} />
    </div>
  );
}

function MetricCol({ label, value, tone, hint }: { label: string; value: string; tone: string; hint?: string }): React.JSX.Element {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-meta">{label}</div>
      <div className={`text-[18px] font-semibold tabular-nums ${tone}`}>{value}</div>
      {hint && <div className="text-[10.5px] text-meta">{hint}</div>}
    </div>
  );
}

function MonthTrend({ months, targetLine }: { months: { label: string; signedRevenue: number | null }[]; targetLine?: number | null }): React.JSX.Element {
  const max = Math.max(months.reduce((m, x) => Math.max(m, x.signedRevenue ?? 0), 0), targetLine ?? 0, 1);
  const tPct = targetLine != null && targetLine > 0 ? Math.min(100, (targetLine / max) * 100) : null;
  return (
    <div>
      <div className="relative flex h-32 items-end gap-1.5">
        {months.map((m) => {
          const h = ((m.signedRevenue ?? 0) / max) * 100;
          return (
            <div
              key={m.label}
              className="flex-1 rounded-sm bg-positive/70 transition-colors hover:bg-positive"
              style={{ height: `${Math.max(h, m.signedRevenue ? 3 : 0)}%` }}
              title={`${m.label}: ${m.signedRevenue == null ? "—" : "$" + Math.round(m.signedRevenue).toLocaleString()}`}
            />
          );
        })}
        {tPct != null && (
          <div className="pointer-events-none absolute inset-x-0 border-t border-dashed border-amber-400/60" style={{ bottom: `${tPct}%` }} />
        )}
      </div>
      <div className="mt-1 flex gap-1.5">
        {months.map((m) => (
          <div key={m.label} className="flex-1 text-center text-[9px] text-meta">{m.label[0]}</div>
        ))}
      </div>
    </div>
  );
}

function FunnelBar({ signed, quote, lost }: { signed: { value: number | null }; quote: { value: number | null }; lost: { value: number | null } }): React.JSX.Element {
  const sv = signed.value ?? 0;
  const qv = quote.value ?? 0;
  const lv = lost.value ?? 0;
  const tot = sv + qv + lv;
  const pct = (n: number) => (tot > 0 ? (n / tot) * 100 : 0);
  return (
    <div className="mt-3">
      <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-[var(--row-hover)]">
        <div className="bg-positive/70" style={{ width: `${pct(sv)}%` }} title={`Signed ${sv ? "$" + Math.round(sv).toLocaleString() : "—"}`} />
        <div className="bg-attention/70" style={{ width: `${pct(qv)}%` }} title={`Open ${qv ? "$" + Math.round(qv).toLocaleString() : "—"}`} />
        <div className="bg-white/15" style={{ width: `${pct(lv)}%` }} title={`Lost ${lv ? "$" + Math.round(lv).toLocaleString() : "—"}`} />
      </div>
      <div className="mt-1.5 flex items-center justify-between text-[10px] uppercase tracking-wide text-meta">
        <span className="inline-flex items-center gap-1"><span className="size-1.5 rounded-full bg-positive/70" /> Signed</span>
        <span className="inline-flex items-center gap-1"><span className="size-1.5 rounded-full bg-attention/70" /> Open</span>
        <span className="inline-flex items-center gap-1"><span className="size-1.5 rounded-full bg-white/15" /> Lost</span>
      </div>
    </div>
  );
}

function PipeRow({ label, count, value, dot, muted }: { label: string; count: number; value: string; dot: string; muted?: boolean }): React.JSX.Element {
  return (
    <div className={`flex items-center gap-2.5 ${muted ? "opacity-70" : ""}`}>
      <span className={`size-2 shrink-0 rounded-sm ${dot}`} />
      <span className="min-w-0 flex-1 truncate text-[12.5px] text-secondary-text">{label}</span>
      <span className="shrink-0 text-[12px] tabular-nums text-meta">{count}</span>
      <span className="w-20 shrink-0 text-right text-[12.5px] font-semibold tabular-nums">{value}</span>
    </div>
  );
}
